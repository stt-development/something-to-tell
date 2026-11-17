"""Transactional project-owned StyleProfile and Scene assignment operations."""

from dataclasses import replace
from datetime import UTC, datetime
from typing import Any
from uuid import uuid4

from ..domain.entities import SceneStyleAssignmentEntity, StyleProfileEntity
from ..repositories.interfaces import UnitOfWork
from ..schemas.project_document import ProjectDocument, create_project_document
from ..schemas.style_system import (
    SceneStyleAssignmentV1,
    StyleCatalogV1,
    StyleProfileDeletionImpactV1,
    StyleProfileV1,
)


class StylePersistenceError(ValueError):
    """Stable error carrying only safe identifiers and deletion impact."""

    def __init__(self, code: str, **parameters: Any) -> None:
        super().__init__(code)
        self.code = code
        self.parameters = parameters


class StylePersistenceService:
    """Own profile identity and references without depending on one SQL backend."""

    def catalog(
        self,
        uow: UnitOfWork,
        project_id: str,
        *,
        default_style_profile_id: str | None,
    ) -> StyleCatalogV1:
        self._require_project(uow, project_id)
        return StyleCatalogV1(
            project_id=project_id,
            default_style_profile_id=default_style_profile_id,
            profiles=tuple(
                self._profile(item)
                for item in sorted(
                    uow.style_profiles.list(project_id=project_id), key=lambda item: item.id
                )
            ),
            scene_assignments=tuple(
                self._assignment(item)
                for item in sorted(
                    uow.scene_style_assignments.list(project_id=project_id),
                    key=lambda item: item.id,
                )
            ),
        )

    def create_profile(self, uow: UnitOfWork, profile: StyleProfileV1) -> StyleProfileV1:
        self._require_project(uow, profile.project_id)
        if uow.style_profiles.get(profile.id) is not None:
            raise StylePersistenceError("style_profile_duplicate", profile_id=profile.id)
        created = uow.style_profiles.add(self._profile_entity(profile))
        uow.commit()
        return self._profile(created)

    def update_profile(self, uow: UnitOfWork, profile: StyleProfileV1) -> StyleProfileV1:
        existing = self._owned_profile(uow, profile.project_id, profile.id)
        validated = StyleProfileV1.model_validate(
            {
                **profile.model_dump(mode="python"),
                "created_at": existing.created_at,
            }
        )
        updated = uow.style_profiles.update(
            self._profile_entity(validated)
        )
        uow.commit()
        return self._profile(updated)

    def duplicate_profile(
        self,
        uow: UnitOfWork,
        *,
        project_id: str,
        source_profile_id: str,
        profile_id: str,
        name: str,
        now: datetime | None = None,
    ) -> StyleProfileV1:
        source = self._profile(self._owned_profile(uow, project_id, source_profile_id))
        timestamp = now or datetime.now(UTC)
        duplicate = source.model_copy(
            update={
                "id": profile_id,
                "name": name,
                "created_at": timestamp,
                "updated_at": timestamp,
            }
        )
        # model_copy deliberately skips validation, so reconstruct before persistence.
        return self.create_profile(
            uow, StyleProfileV1.model_validate(duplicate.model_dump(mode="python"))
        )

    def upsert_scene_assignment(
        self,
        uow: UnitOfWork,
        assignment: SceneStyleAssignmentV1,
    ) -> SceneStyleAssignmentV1:
        self._require_scene(uow, assignment.project_id, assignment.scene_node_id)
        self._owned_profile(uow, assignment.project_id, assignment.style_profile_id)
        existing = next(
            (
                item
                for item in uow.scene_style_assignments.list(
                    project_id=assignment.project_id
                )
                if item.scene_node_id == assignment.scene_node_id
            ),
            None,
        )
        if existing is None:
            if uow.scene_style_assignments.get(assignment.id) is not None:
                raise StylePersistenceError(
                    "style_scene_assignment_duplicate", assignment_id=assignment.id
                )
            stored = uow.scene_style_assignments.add(self._assignment_entity(assignment))
        else:
            validated = SceneStyleAssignmentV1.model_validate(
                {
                    **assignment.model_dump(mode="python"),
                    "id": existing.id,
                    "created_at": existing.created_at,
                }
            )
            stored = uow.scene_style_assignments.update(
                replace(
                    existing,
                    style_profile_id=validated.style_profile_id,
                    updated_at=validated.updated_at,
                )
            )
        uow.commit()
        return self._assignment(stored)

    def clear_scene_assignment(
        self, uow: UnitOfWork, *, project_id: str, scene_node_id: str
    ) -> None:
        assignment = next(
            (
                item
                for item in uow.scene_style_assignments.list(project_id=project_id)
                if item.scene_node_id == scene_node_id
            ),
            None,
        )
        if assignment is not None:
            uow.scene_style_assignments.delete(assignment.id)
            uow.commit()

    def deletion_impact(
        self,
        uow: UnitOfWork,
        *,
        project_id: str,
        profile_id: str,
        default_style_profile_id: str | None,
    ) -> StyleProfileDeletionImpactV1:
        self._owned_profile(uow, project_id, profile_id)
        scene_ids = tuple(
            sorted(
                item.scene_node_id
                for item in uow.scene_style_assignments.list(project_id=project_id)
                if item.style_profile_id == profile_id
            )
        )
        return StyleProfileDeletionImpactV1(
            profile_id=profile_id,
            uses_project_default=default_style_profile_id == profile_id,
            scene_node_ids=scene_ids,
        )

    def delete_profile(
        self,
        uow: UnitOfWork,
        *,
        project_id: str,
        profile_id: str,
        default_style_profile_id: str | None,
    ) -> None:
        impact = self.deletion_impact(
            uow,
            project_id=project_id,
            profile_id=profile_id,
            default_style_profile_id=default_style_profile_id,
        )
        if impact.in_use:
            raise StylePersistenceError(
                "style_profile_in_use",
                profile_id=profile_id,
                uses_project_default=impact.uses_project_default,
                scene_node_ids=list(impact.scene_node_ids),
            )
        uow.style_profiles.delete(profile_id)
        uow.commit()

    def delete_profile_after_review(
        self,
        uow: UnitOfWork,
        *,
        project_id: str,
        profile_id: str,
        default_style_profile_id: str | None,
        replacement_profile_id: str | None,
        impact_reviewed: bool,
        now: datetime | None = None,
    ) -> StyleProfileDeletionImpactV1:
        """Delete one profile and resolve Scene references after explicit review.

        The project default lives in the portable manifest, outside this repository
        transaction. Callers must change that reference first; Scene assignments can
        be cleared or replaced atomically with the profile deletion here.
        """

        impact = self.deletion_impact(
            uow,
            project_id=project_id,
            profile_id=profile_id,
            default_style_profile_id=default_style_profile_id,
        )
        if impact.uses_project_default:
            raise StylePersistenceError(
                "style_profile_in_use",
                profile_id=profile_id,
                uses_project_default=True,
                scene_node_ids=list(impact.scene_node_ids),
            )
        if impact.scene_node_ids and not impact_reviewed:
            raise StylePersistenceError(
                "style_profile_in_use",
                profile_id=profile_id,
                uses_project_default=False,
                scene_node_ids=list(impact.scene_node_ids),
            )
        if replacement_profile_id == profile_id:
            raise StylePersistenceError("style_profile_invalid", profile_id=profile_id)
        if replacement_profile_id is not None:
            self._owned_profile(uow, project_id, replacement_profile_id)

        timestamp = now or datetime.now(UTC)
        assignments = uow.scene_style_assignments.list(project_id=project_id)
        for assignment in assignments:
            if assignment.style_profile_id != profile_id:
                continue
            if replacement_profile_id is None:
                uow.scene_style_assignments.delete(assignment.id)
            else:
                uow.scene_style_assignments.update(
                    replace(
                        assignment,
                        style_profile_id=replacement_profile_id,
                        updated_at=timestamp,
                    )
                )
        uow.style_profiles.delete(profile_id)
        uow.commit()
        return impact

    def prepare_profile_deletion(
        self,
        document: ProjectDocument,
        *,
        profile_id: str,
        replacement_profile_id: str | None,
        impact_reviewed: bool,
        now: datetime,
    ) -> ProjectDocument:
        """Build one atomic document change after explicit reference review."""

        profiles = {profile.id: profile for profile in document.style_profiles}
        if profile_id not in profiles:
            raise StylePersistenceError("style_profile_not_found", profile_id=profile_id)
        if replacement_profile_id == profile_id:
            raise StylePersistenceError("style_profile_invalid", profile_id=profile_id)
        if replacement_profile_id is not None and replacement_profile_id not in profiles:
            raise StylePersistenceError(
                "style_profile_not_found", profile_id=replacement_profile_id
            )

        default_profile_id = (
            document.manifest.settings.style_system.default_style_profile_id
        )
        affected_assignments = tuple(
            assignment
            for assignment in document.scene_style_assignments
            if assignment.style_profile_id == profile_id
        )
        impact = StyleProfileDeletionImpactV1(
            profile_id=profile_id,
            uses_project_default=default_profile_id == profile_id,
            scene_node_ids=tuple(
                sorted(assignment.scene_node_id for assignment in affected_assignments)
            ),
        )
        if impact.in_use and not impact_reviewed:
            raise StylePersistenceError(
                "style_profile_in_use",
                profile_id=profile_id,
                uses_project_default=impact.uses_project_default,
                scene_node_ids=list(impact.scene_node_ids),
            )

        assignments = [
            assignment
            for assignment in document.scene_style_assignments
            if assignment.style_profile_id != profile_id
        ]
        if replacement_profile_id is not None:
            assignments.extend(
                SceneStyleAssignmentV1.model_validate(
                    {
                        **assignment.model_dump(mode="python"),
                        "style_profile_id": replacement_profile_id,
                        "updated_at": now,
                    }
                )
                for assignment in affected_assignments
            )
        assignments.sort(key=lambda assignment: assignment.id)

        replacement_default = (
            replacement_profile_id if default_profile_id == profile_id else default_profile_id
        )
        settings = document.manifest.settings.model_copy(
            update={
                "style_system": document.manifest.settings.style_system.model_copy(
                    update={"default_style_profile_id": replacement_default}
                )
            }
        )
        manifest = document.manifest.model_copy(update={"settings": settings})
        payload = document.model_dump(mode="python")
        payload.update(
            {
                "manifest": manifest,
                "style_profiles": sorted(
                    (profile for key, profile in profiles.items() if key != profile_id),
                    key=lambda profile: profile.id,
                ),
                "scene_style_assignments": assignments,
            }
        )
        return create_project_document(**payload)

    @staticmethod
    def new_profile(
        *,
        project_id: str,
        name: str,
        guidance: str,
        description: str = "",
        traits: dict[str, Any] | None = None,
        positive_examples: list[str] | None = None,
        profile_id: str | None = None,
        now: datetime | None = None,
    ) -> StyleProfileV1:
        timestamp = now or datetime.now(UTC)
        return StyleProfileV1(
            id=profile_id or str(uuid4()),
            project_id=project_id,
            name=name,
            description=description,
            guidance=guidance,
            traits=traits or {"traits_version": 1},
            positive_examples=positive_examples or [],
            created_at=timestamp,
            updated_at=timestamp,
        )

    @staticmethod
    def _require_project(uow: UnitOfWork, project_id: str) -> None:
        if uow.projects.get(project_id) is None:
            raise StylePersistenceError("style_project_not_found", project_id=project_id)

    @staticmethod
    def _require_scene(uow: UnitOfWork, project_id: str, scene_node_id: str) -> None:
        node = uow.nodes.get(scene_node_id)
        if node is None or node.project_id != project_id or node.type != "Scene":
            raise StylePersistenceError("style_scene_invalid", scene_node_id=scene_node_id)

    @staticmethod
    def _owned_profile(
        uow: UnitOfWork, project_id: str, profile_id: str
    ) -> StyleProfileEntity:
        profile = uow.style_profiles.get(profile_id)
        if profile is None or profile.project_id != project_id:
            raise StylePersistenceError("style_profile_not_found", profile_id=profile_id)
        return profile

    @staticmethod
    def _profile(entity: StyleProfileEntity) -> StyleProfileV1:
        return StyleProfileV1.model_validate(entity, from_attributes=True)

    @staticmethod
    def _assignment(entity: SceneStyleAssignmentEntity) -> SceneStyleAssignmentV1:
        return SceneStyleAssignmentV1.model_validate(entity, from_attributes=True)

    @staticmethod
    def _profile_entity(profile: StyleProfileV1) -> StyleProfileEntity:
        payload = profile.model_dump(mode="python")
        payload["traits"] = profile.traits.model_dump(mode="json")
        payload["positive_examples"] = list(profile.positive_examples)
        return StyleProfileEntity(**payload)

    @staticmethod
    def _assignment_entity(
        assignment: SceneStyleAssignmentV1,
    ) -> SceneStyleAssignmentEntity:
        return SceneStyleAssignmentEntity(**assignment.model_dump(mode="python"))
