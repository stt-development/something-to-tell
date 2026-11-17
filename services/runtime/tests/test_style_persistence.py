import json
from datetime import UTC, datetime, timedelta
from pathlib import Path

import pytest
from sqlalchemy import create_engine
from sqlalchemy.orm import Session

from services.runtime.stt_runtime.db.base import Base, import_model_metadata
from services.runtime.stt_runtime.domain.entities import NodeEntity, ProjectEntity
from services.runtime.stt_runtime.repositories.sqlite import SqlAlchemyUnitOfWork
from services.runtime.stt_runtime.project_session.service import ProjectSessionRegistry
from services.runtime.stt_runtime.schemas.project_document import create_project_document
from services.runtime.stt_runtime.style_system.interchange import (
    StyleInterchangeError,
    export_style_profile,
    import_style_profile,
)
from services.runtime.stt_runtime.style_system.service import (
    StylePersistenceError,
    StylePersistenceService,
)
from services.runtime.stt_runtime.schemas.style_system import SceneStyleAssignmentV1

NOW = datetime(2026, 9, 4, 12, 0, tzinfo=UTC)
PROJECT_ID = "project-style-test"


def _factory(path: Path):
    import_model_metadata()
    engine = create_engine(f"sqlite:///{path}")
    Base.metadata.create_all(engine)
    return (lambda: Session(engine)), engine


def _seed(factory) -> None:
    with SqlAlchemyUnitOfWork(factory) as uow:
        uow.projects.add(
            ProjectEntity(
                id=PROJECT_ID,
                name="Style test",
                path="/tmp/StyleTest.narrative",
                format_version=2,
            )
        )
        uow.nodes.add(
            NodeEntity(
                id="scene-opening",
                project_id=PROJECT_ID,
                type="Scene",
                title="Opening",
            )
        )
        uow.nodes.add(
            NodeEntity(
                id="event-arrival",
                project_id=PROJECT_ID,
                type="Event",
                title="Arrival",
            )
        )
        uow.commit()


def test_profile_crud_duplicate_and_scene_assignment_survive_restart(tmp_path: Path) -> None:
    factory, engine = _factory(tmp_path / "styles.sqlite")
    _seed(factory)
    service = StylePersistenceService()
    profile = service.new_profile(
        profile_id="style-default",
        project_id=PROJECT_ID,
        name="Default style",
        guidance="Use precise and restrained prose.",
        traits={"traits_version": 1, "tone": ["restrained"]},
        now=NOW,
    )
    with SqlAlchemyUnitOfWork(factory) as uow:
        created = service.create_profile(uow, profile)
        duplicate = service.duplicate_profile(
            uow,
            project_id=PROJECT_ID,
            source_profile_id=created.id,
            profile_id="style-scene",
            name="Scene style",
            now=NOW + timedelta(minutes=1),
        )
        assignment = service.upsert_scene_assignment(
            uow,
            SceneStyleAssignmentV1(
                id="assignment-opening",
                project_id=PROJECT_ID,
                scene_node_id="scene-opening",
                style_profile_id=duplicate.id,
                created_at=NOW,
                updated_at=NOW,
            ),
        )
        updated = service.update_profile(
            uow,
            created.model_copy(
                update={
                    "description": "Updated description",
                    "updated_at": NOW + timedelta(minutes=2),
                }
            ),
        )

    engine.dispose()
    restarted_factory, restarted_engine = _factory(tmp_path / "styles.sqlite")
    with SqlAlchemyUnitOfWork(restarted_factory) as uow:
        catalog = service.catalog(
            uow,
            PROJECT_ID,
            default_style_profile_id="style-default",
        )
    restarted_engine.dispose()

    assert updated.id == created.id
    assert updated.created_at == created.created_at
    assert assignment.id == "assignment-opening"
    assert [item.id for item in catalog.profiles] == ["style-default", "style-scene"]
    assert catalog.scene_assignments[0].style_profile_id == "style-scene"


def test_profile_deletion_reports_all_references_before_mutation(tmp_path: Path) -> None:
    factory, engine = _factory(tmp_path / "impact.sqlite")
    _seed(factory)
    service = StylePersistenceService()
    profile = service.new_profile(
        profile_id="style-in-use",
        project_id=PROJECT_ID,
        name="In use",
        guidance="Keep this style referenced.",
        now=NOW,
    )
    with SqlAlchemyUnitOfWork(factory) as uow:
        service.create_profile(uow, profile)
        service.upsert_scene_assignment(
            uow,
            SceneStyleAssignmentV1(
                id="assignment-opening",
                project_id=PROJECT_ID,
                scene_node_id="scene-opening",
                style_profile_id=profile.id,
                created_at=NOW,
                updated_at=NOW,
            ),
        )
        impact = service.deletion_impact(
            uow,
            project_id=PROJECT_ID,
            profile_id=profile.id,
            default_style_profile_id=profile.id,
        )
        with pytest.raises(StylePersistenceError, match="style_profile_in_use"):
            service.delete_profile(
                uow,
                project_id=PROJECT_ID,
                profile_id=profile.id,
                default_style_profile_id=profile.id,
            )
        assert uow.style_profiles.get(profile.id) is not None

        service.clear_scene_assignment(
            uow, project_id=PROJECT_ID, scene_node_id="scene-opening"
        )
        service.delete_profile(
            uow,
            project_id=PROJECT_ID,
            profile_id=profile.id,
            default_style_profile_id=None,
        )
        assert uow.style_profiles.get(profile.id) is None
    engine.dispose()

    assert impact.uses_project_default is True
    assert impact.scene_node_ids == ("scene-opening",)


def test_reviewed_profile_deletion_reassigns_scene_references_atomically(tmp_path: Path) -> None:
    """The UI deletion decision must never leave a Scene with a dangling profile id."""

    factory, engine = _factory(tmp_path / "reviewed-delete.sqlite")
    _seed(factory)
    service = StylePersistenceService()
    source = service.new_profile(
        profile_id="style-source",
        project_id=PROJECT_ID,
        name="Source",
        guidance="Replace this profile.",
        now=NOW,
    )
    replacement = service.new_profile(
        profile_id="style-replacement",
        project_id=PROJECT_ID,
        name="Replacement",
        guidance="Use this profile.",
        now=NOW,
    )
    with SqlAlchemyUnitOfWork(factory) as uow:
        service.create_profile(uow, source)
        service.create_profile(uow, replacement)
        service.upsert_scene_assignment(
            uow,
            SceneStyleAssignmentV1(
                id="assignment-opening",
                project_id=PROJECT_ID,
                scene_node_id="scene-opening",
                style_profile_id=source.id,
                created_at=NOW,
                updated_at=NOW,
            ),
        )
        with pytest.raises(StylePersistenceError, match="style_profile_in_use"):
            service.delete_profile_after_review(
                uow,
                project_id=PROJECT_ID,
                profile_id=source.id,
                default_style_profile_id=None,
                replacement_profile_id=replacement.id,
                impact_reviewed=False,
            )
        impact = service.delete_profile_after_review(
            uow,
            project_id=PROJECT_ID,
            profile_id=source.id,
            default_style_profile_id=None,
            replacement_profile_id=replacement.id,
            impact_reviewed=True,
            now=NOW + timedelta(minutes=1),
        )
        assert impact.scene_node_ids == ("scene-opening",)
        assert uow.style_profiles.get(source.id) is None
        assert uow.scene_style_assignments.get("assignment-opening").style_profile_id == replacement.id
    engine.dispose()


def test_profile_deletion_replaces_all_references_in_one_document_change(
    tmp_path: Path,
) -> None:
    registry = ProjectSessionRegistry()
    opened = registry.create(tmp_path / "DeleteStyle.narrative", "Delete style")
    service = StylePersistenceService()
    source = service.new_profile(
        profile_id="style-source",
        project_id=opened.session.project_id,
        name="Source",
        guidance="Replace this profile.",
        now=NOW,
    )
    replacement = service.new_profile(
        profile_id="style-replacement",
        project_id=opened.session.project_id,
        name="Replacement",
        guidance="Use this profile instead.",
        now=NOW,
    )
    with registry.authoring_unit_of_work(
        opened.session.session_id,
        command_kind="seed_styles",
        label_key="history.command.seedStyles",
    ) as uow:
        uow.nodes.add(
            NodeEntity(
                id="scene-opening",
                project_id=opened.session.project_id,
                type="Scene",
                title="Opening",
            )
        )
        service.create_profile(uow, source)
        service.create_profile(uow, replacement)
        service.upsert_scene_assignment(
            uow,
            SceneStyleAssignmentV1(
                id="assignment-opening",
                project_id=opened.session.project_id,
                scene_node_id="scene-opening",
                style_profile_id=source.id,
                created_at=NOW,
                updated_at=NOW,
            ),
        )

    document = registry.inspect(opened.session.session_id).document
    configured_settings = document.manifest.settings.model_copy(
        update={
            "style_system": document.manifest.settings.style_system.model_copy(
                update={"default_style_profile_id": source.id}
            )
        }
    )
    document = create_project_document(
        **{
            **document.model_dump(mode="python"),
            "manifest": document.manifest.model_copy(
                update={"settings": configured_settings}
            ),
        }
    )

    with pytest.raises(StylePersistenceError, match="style_profile_in_use"):
        service.prepare_profile_deletion(
            document,
            profile_id=source.id,
            replacement_profile_id=replacement.id,
            impact_reviewed=False,
            now=NOW + timedelta(minutes=1),
        )
    changed = service.prepare_profile_deletion(
        document,
        profile_id=source.id,
        replacement_profile_id=replacement.id,
        impact_reviewed=True,
        now=NOW + timedelta(minutes=1),
    )
    cleared = service.prepare_profile_deletion(
        document,
        profile_id=source.id,
        replacement_profile_id=None,
        impact_reviewed=True,
        now=NOW + timedelta(minutes=1),
    )

    assert [profile.id for profile in changed.style_profiles] == [replacement.id]
    assert changed.manifest.settings.style_system.default_style_profile_id == replacement.id
    assert changed.scene_style_assignments[0].style_profile_id == replacement.id
    assert cleared.manifest.settings.style_system.default_style_profile_id is None
    assert cleared.scene_style_assignments == []
    assert document.scene_style_assignments[0].style_profile_id == source.id
    registry.discard(opened.session.session_id)
    registry.close(opened.session.session_id)


def test_updates_validate_timestamps_before_committing(tmp_path: Path) -> None:
    factory, engine = _factory(tmp_path / "timestamps.sqlite")
    _seed(factory)
    service = StylePersistenceService()
    profile = service.new_profile(
        profile_id="style-default",
        project_id=PROJECT_ID,
        name="Default",
        guidance="Use default prose.",
        now=NOW,
    )
    with SqlAlchemyUnitOfWork(factory) as uow:
        service.create_profile(uow, profile)
        assignment = SceneStyleAssignmentV1(
            id="assignment-opening",
            project_id=PROJECT_ID,
            scene_node_id="scene-opening",
            style_profile_id=profile.id,
            created_at=NOW,
            updated_at=NOW,
        )
        service.upsert_scene_assignment(uow, assignment)
        with pytest.raises(ValueError):
            service.update_profile(
                uow,
                profile.model_copy(update={"updated_at": NOW - timedelta(minutes=1)}),
            )
        with pytest.raises(ValueError):
            service.upsert_scene_assignment(
                uow,
                assignment.model_copy(
                    update={"updated_at": NOW - timedelta(minutes=1)}
                ),
            )
        assert service.catalog(
            uow, PROJECT_ID, default_style_profile_id=None
        ).profiles[0].updated_at == NOW
        assert service.catalog(
            uow, PROJECT_ID, default_style_profile_id=None
        ).scene_assignments[0].updated_at == NOW
    engine.dispose()


def test_scene_assignment_rejects_non_scene_owner(tmp_path: Path) -> None:
    factory, engine = _factory(tmp_path / "scene.sqlite")
    _seed(factory)
    service = StylePersistenceService()
    profile = service.new_profile(
        profile_id="style-default",
        project_id=PROJECT_ID,
        name="Default",
        guidance="Use default prose.",
        now=NOW,
    )
    with SqlAlchemyUnitOfWork(factory) as uow:
        service.create_profile(uow, profile)
        with pytest.raises(StylePersistenceError, match="style_scene_invalid"):
            service.upsert_scene_assignment(
                uow,
                SceneStyleAssignmentV1(
                    id="assignment-event",
                    project_id=PROJECT_ID,
                    scene_node_id="event-arrival",
                    style_profile_id=profile.id,
                    created_at=NOW,
                    updated_at=NOW,
                ),
            )
    engine.dispose()


def test_profile_file_export_is_deterministic_and_import_is_explicit(tmp_path: Path) -> None:
    service = StylePersistenceService()
    profile = service.new_profile(
        profile_id="style-portable",
        project_id=PROJECT_ID,
        name="Portable",
        description="Project-neutral profile.",
        guidance="Use direct prose.",
        positive_examples=["The bell stopped."],
        now=NOW,
    )
    styles = tmp_path / "styles"

    exported = export_style_profile(styles, profile)
    first = exported.read_text(encoding="utf-8")
    export_style_profile(styles, profile)
    payload = json.loads(first)

    assert exported.name == "style-portable.style.json"
    assert exported.read_text(encoding="utf-8") == first
    assert "project_id" not in payload
    assert "provider" not in first.casefold()
    imported = import_style_profile(
        exported,
        project_id="destination-project",
        existing_profile_ids=set(),
        replace_existing=False,
        now=NOW,
    )
    assert imported.project_id == "destination-project"
    assert imported.id == profile.id

    with pytest.raises(StyleInterchangeError, match="style_profile_import_collision"):
        import_style_profile(
            exported,
            project_id="destination-project",
            existing_profile_ids={profile.id},
            replace_existing=False,
            now=NOW,
        )


@pytest.mark.parametrize(
    "payload",
    [
        "not json",
        '{"file_version": 1}',
        json.dumps({
            "file_version": 1,
            "id": "style-bad",
            "name": "Bad",
            "guidance": "Use sk-proj-abcdefghijklmnopqrstuv",
            "traits": {"traits_version": 1},
            "positive_examples": [],
        }),
    ],
)
def test_profile_file_import_rejects_malformed_or_secret_content(
    tmp_path: Path, payload: str
) -> None:
    source = tmp_path / "bad.style.json"
    source.write_text(payload, encoding="utf-8")

    with pytest.raises(StyleInterchangeError, match="style_profile_import_invalid"):
        import_style_profile(
            source,
            project_id=PROJECT_ID,
            existing_profile_ids=set(),
            replace_existing=False,
            now=NOW,
        )


def test_save_as_and_discard_preserve_profiles_assignments_and_default(tmp_path: Path) -> None:
    registry = ProjectSessionRegistry()
    source_path = tmp_path / "Styled.narrative"
    opened = registry.create(source_path, "Styled")
    session_id = opened.session.session_id
    service = StylePersistenceService()
    profile = service.new_profile(
        profile_id="style-default",
        project_id=opened.session.project_id,
        name="Default",
        guidance="Use restrained prose.",
        now=NOW,
    )
    with registry.authoring_unit_of_work(
        session_id,
        command_kind="create_style_profile",
        label_key="history.command.createStyleProfile",
    ) as uow:
        uow.nodes.add(
            NodeEntity(
                id="scene-opening",
                project_id=opened.session.project_id,
                type="Scene",
                title="Opening",
            )
        )
        service.create_profile(uow, profile)
        service.upsert_scene_assignment(
            uow,
            SceneStyleAssignmentV1(
                id="assignment-opening",
                project_id=opened.session.project_id,
                scene_node_id="scene-opening",
                style_profile_id=profile.id,
                created_at=NOW,
                updated_at=NOW,
            ),
        )

    current = registry.inspect(session_id)
    settings = current.document.manifest.settings.model_copy(
        update={
            "style_system": current.document.manifest.settings.style_system.model_copy(
                update={"default_style_profile_id": profile.id}
            )
        }
    )
    configured = registry.update_settings(
        session_id,
        name="Styled",
        description="",
        settings=settings,
        expected_history_revision=1,
    )
    saved = registry.save(
        session_id,
        expected_revision=configured.session.saved_revision,
        reason="manual",
    )

    changed = profile.model_copy(
        update={"guidance": "Unsaved changed prose.", "updated_at": NOW + timedelta(hours=1)}
    )
    with registry.authoring_unit_of_work(
        session_id,
        command_kind="update_style_profile",
        label_key="history.command.updateStyleProfile",
    ) as uow:
        service.update_profile(uow, changed)
    assert registry.inspect(session_id).session.save_status == "dirty"
    recovered = registry.discard(session_id)
    assert recovered.document.style_profiles[0].guidance == "Use restrained prose."

    destination = tmp_path / "StyledCopy.narrative"
    registry.save_as(
        session_id,
        destination=destination,
        expected_revision=saved.session.saved_revision,
        identity="regenerate",
        replace_existing=False,
    )
    registry.close(session_id)

    copied = registry.open(destination)
    try:
        assert copied.document.manifest.settings.style_system.default_style_profile_id == profile.id
        assert copied.document.style_profiles[0].project_id == copied.session.project_id
        assert copied.document.scene_style_assignments[0].project_id == copied.session.project_id
        assert copied.document.scene_style_assignments[0].style_profile_id == profile.id
    finally:
        registry.close(copied.session.session_id)
