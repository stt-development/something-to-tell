"""Pure effective-style resolution over canonical composition records."""

from __future__ import annotations

from dataclasses import dataclass
from typing import Any

from ..schemas.project_document import (
    ProjectDocument,
    ProjectNodeRecord,
    ProjectPlacementRecord,
)
from ..schemas.style_resolution import (
    EffectiveStyleProfileV1,
    EffectiveStyleResolutionV1,
    StyleContextRefV1,
    StyleResolutionSource,
    StyleSceneContextV1,
)
from ..schemas.style_system import SceneStyleAssignmentV1, StyleProfileV1


class StyleResolutionError(ValueError):
    """Stable invalid-target or invalid-context failure with safe identifiers."""

    def __init__(self, code: str, **parameters: Any) -> None:
        super().__init__(code)
        self.code = code
        self.parameters = parameters


@dataclass(frozen=True)
class StyleResolutionSnapshot:
    """Minimal immutable projection needed for style and Scene resolution."""

    project_id: str
    default_style_profile_id: str | None
    nodes: tuple[ProjectNodeRecord, ...]
    placements: tuple[ProjectPlacementRecord, ...]
    profiles: tuple[StyleProfileV1, ...]
    scene_assignments: tuple[SceneStyleAssignmentV1, ...]

    @classmethod
    def from_document(cls, document: ProjectDocument) -> "StyleResolutionSnapshot":
        """Capture only authored records; Issue and Story data cannot affect style."""

        return cls(
            project_id=document.manifest.project_id,
            default_style_profile_id=(
                document.manifest.settings.style_system.default_style_profile_id
            ),
            nodes=tuple(document.nodes),
            placements=tuple(document.placements),
            profiles=tuple(document.style_profiles),
            scene_assignments=tuple(document.scene_style_assignments),
        )


class EffectiveStyleResolver:
    """Resolve Scene context and profile precedence without storage or UI state."""

    def resolve(
        self,
        snapshot: StyleResolutionSnapshot,
        *,
        target_node_id: str,
        context: StyleContextRefV1 | None = None,
    ) -> EffectiveStyleResolutionV1:
        nodes = {
            node.id: node
            for node in snapshot.nodes
            if node.project_id == snapshot.project_id
        }
        target = nodes.get(target_node_id)
        if target is None:
            raise StyleResolutionError(
                "style_target_not_found", target_node_id=target_node_id
            )
        placements = tuple(
            placement
            for placement in snapshot.placements
            if placement.project_id == snapshot.project_id
        )
        placements_by_id = {placement.id: placement for placement in placements}
        placements_by_node: dict[str, list[ProjectPlacementRecord]] = {}
        for placement in placements:
            placements_by_node.setdefault(placement.canonical_node_id, []).append(placement)
        for values in placements_by_node.values():
            values.sort(key=lambda placement: placement.id)

        scene_ids = self._candidate_scene_ids(
            target_node_id,
            target.type,
            nodes,
            placements_by_node,
        )
        candidates = self._contexts(scene_ids, nodes)
        selected_scene_id: str | None = None
        if context is not None:
            self._validate_context(
                context,
                target_node_id=target_node_id,
                target_kind=target.type,
                nodes=nodes,
                placements_by_id=placements_by_id,
                placements_by_node=placements_by_node,
            )
            selected_scene_id = context.scene_node_id
        elif target.type == "Scene":
            selected_scene_id = target_node_id
        elif len(candidates) == 1:
            selected_scene_id = candidates[0].scene_node_id
        elif len(candidates) > 1:
            return EffectiveStyleResolutionV1(
                target_node_id=target_node_id,
                status="context_required",
                source=None,
                candidate_contexts=candidates,
            )

        selected_context = next(
            (
                candidate
                for candidate in candidates
                if candidate.scene_node_id == selected_scene_id
            ),
            self._context(selected_scene_id, nodes) if selected_scene_id else None,
        )
        assignment = next(
            (
                item
                for item in sorted(
                    snapshot.scene_assignments,
                    key=lambda value: (value.scene_node_id, value.id),
                )
                if item.project_id == snapshot.project_id
                and item.scene_node_id == selected_scene_id
            ),
            None,
        )
        if assignment is not None:
            return self._profile_resolution(
                snapshot,
                target_node_id=target_node_id,
                source="scene_override",
                profile_id=assignment.style_profile_id,
                scene_context=selected_context,
                candidates=candidates,
            )
        if snapshot.default_style_profile_id is not None:
            return self._profile_resolution(
                snapshot,
                target_node_id=target_node_id,
                source="project_default",
                profile_id=snapshot.default_style_profile_id,
                scene_context=selected_context,
                candidates=candidates,
            )
        return EffectiveStyleResolutionV1(
            target_node_id=target_node_id,
            status="unconfigured",
            source="unconfigured",
            scene_context=selected_context,
            candidate_contexts=candidates,
        )

    def _validate_context(
        self,
        context: StyleContextRefV1,
        *,
        target_node_id: str,
        target_kind: str,
        nodes: dict[str, ProjectNodeRecord],
        placements_by_id: dict[str, ProjectPlacementRecord],
        placements_by_node: dict[str, list[ProjectPlacementRecord]],
    ) -> None:
        scene = nodes.get(context.scene_node_id)
        if scene is None or scene.type != "Scene":
            raise StyleResolutionError(
                "style_context_scene_invalid", scene_node_id=context.scene_node_id
            )
        if context.placement_id is not None:
            placement = placements_by_id.get(context.placement_id)
            if placement is None:
                raise StyleResolutionError(
                    "style_placement_not_found", placement_id=context.placement_id
                )
            if placement.canonical_node_id != target_node_id:
                raise StyleResolutionError(
                    "style_placement_target_mismatch",
                    placement_id=context.placement_id,
                    target_node_id=target_node_id,
                )
            reachable = self._scenes_for_placement(
                placement,
                nodes,
                placements_by_node,
                visited=set(),
            )
            if target_kind == "Scene":
                reachable.add(target_node_id)
        else:
            reachable = self._candidate_scene_ids(
                target_node_id,
                target_kind,
                nodes,
                placements_by_node,
            )
        if context.scene_node_id not in reachable:
            raise StyleResolutionError(
                "style_context_unreachable",
                scene_node_id=context.scene_node_id,
                target_node_id=target_node_id,
            )

    def _candidate_scene_ids(
        self,
        target_node_id: str,
        target_kind: str,
        nodes: dict[str, ProjectNodeRecord],
        placements_by_node: dict[str, list[ProjectPlacementRecord]],
    ) -> set[str]:
        if target_kind == "Scene":
            return {target_node_id}
        result: set[str] = set()
        for placement in placements_by_node.get(target_node_id, []):
            result.update(
                self._scenes_for_placement(
                    placement,
                    nodes,
                    placements_by_node,
                    visited=set(),
                )
            )
        return result

    def _scenes_for_placement(
        self,
        placement: ProjectPlacementRecord,
        nodes: dict[str, ProjectNodeRecord],
        placements_by_node: dict[str, list[ProjectPlacementRecord]],
        *,
        visited: set[str],
    ) -> set[str]:
        if placement.id in visited:
            return set()
        next_visited = {*visited, placement.id}
        container_id = placement.container_node_id
        if container_id is None:
            return set()
        container = nodes.get(container_id)
        if container is None:
            return set()
        if container.type == "Scene":
            return {container.id}
        if container.type != "Location":
            return set()
        result: set[str] = set()
        for parent in placements_by_node.get(container.id, []):
            result.update(
                self._scenes_for_placement(
                    parent,
                    nodes,
                    placements_by_node,
                    visited=next_visited,
                )
            )
        return result

    @staticmethod
    def _contexts(
        scene_ids: set[str],
        nodes: dict[str, ProjectNodeRecord],
    ) -> tuple[StyleSceneContextV1, ...]:
        contexts = [
            EffectiveStyleResolver._context(scene_id, nodes)
            for scene_id in scene_ids
        ]
        return tuple(sorted(contexts, key=lambda item: (item.scene_title.casefold(), item.scene_node_id)))

    @staticmethod
    def _context(
        scene_id: str,
        nodes: dict[str, ProjectNodeRecord],
    ) -> StyleSceneContextV1:
        scene = nodes.get(scene_id)
        if scene is None or scene.type != "Scene":
            raise StyleResolutionError(
                "style_context_scene_invalid", scene_node_id=scene_id
            )
        return StyleSceneContextV1(scene_node_id=scene.id, scene_title=scene.title)

    @staticmethod
    def _profile_resolution(
        snapshot: StyleResolutionSnapshot,
        *,
        target_node_id: str,
        source: StyleResolutionSource,
        profile_id: str,
        scene_context: StyleSceneContextV1 | None,
        candidates: tuple[StyleSceneContextV1, ...],
    ) -> EffectiveStyleResolutionV1:
        profile = next(
            (
                item
                for item in snapshot.profiles
                if item.project_id == snapshot.project_id and item.id == profile_id
            ),
            None,
        )
        if profile is None:
            return EffectiveStyleResolutionV1(
                target_node_id=target_node_id,
                status="unavailable",
                source=source,
                scene_context=scene_context,
                candidate_contexts=candidates,
                style_profile_id=profile_id,
                unavailable_reason="style_profile_missing",
            )
        return EffectiveStyleResolutionV1(
            target_node_id=target_node_id,
            status="resolved",
            source=source,
            scene_context=scene_context,
            candidate_contexts=candidates,
            style_profile_id=profile.id,
            profile=EffectiveStyleProfileV1(
                id=profile.id,
                name=profile.name,
                description=profile.description,
            ),
        )
