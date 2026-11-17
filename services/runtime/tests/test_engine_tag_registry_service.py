"""Unit tests for the checksum-bound deterministic engine-tag registry."""

from datetime import UTC, datetime

import pytest

from services.runtime.stt_runtime.engine_tags.ownership import (
    owner_removed_with_node,
    owner_removed_with_relationships,
)
from services.runtime.stt_runtime.engine_tags.service import (
    EngineTagRegistryError,
    EngineTagRegistryService,
)
from services.runtime.stt_runtime.project_format.manifest import ProjectManifestV2
from services.runtime.stt_runtime.schemas.engine_tags import (
    EngineTagMutationCommandV1,
    EngineTagOwnerV1,
    EngineTagTargetAliasV1,
    LegacyEngineTagRecordV1,
)
from services.runtime.stt_runtime.schemas.project_document import (
    ProjectNodeRecord,
    create_project_document,
)


def _document():
    now = datetime(2026, 1, 1, tzinfo=UTC)
    manifest = ProjectManifestV2(
        project_id="project", name="Project", created_at=now, updated_at=now,
    )
    node = ProjectNodeRecord(
        id="node-1", project_id="project", type="Character", title="Ilya",
        created_at=now, updated_at=now, status="active",
    )
    return create_project_document(manifest=manifest, nodes=[node])


def _command(document, action, **kwargs):
    return EngineTagMutationCommandV1(
        command_id=f"command-{action}", action=action,
        expected_source_checksum=document.checksum, expected_history_revision=0, **kwargs,
    )


def test_registry_create_and_bind_are_deterministic_and_checksum_bound() -> None:
    service = EngineTagRegistryService(clock=lambda: datetime(2026, 1, 2, tzinfo=UTC))
    document = _document()
    created, _ = service.apply(document, _command(document, "create_definition", key="Story.Main"))
    definition = created.engine_tag_definitions[0]
    assert {alias.target: alias.external_identifier for alias in definition.aliases} == {
        "ink": "story_main", "yarn_spinner": "story_main",
    }
    owner = EngineTagOwnerV1(kind="node", project_id="project", node_id="node-1")
    bound, _ = service.apply(
        created,
        _command(created, "bind", definition_id=definition.id, owner=owner, value="main"),
    )
    assert bound.engine_tag_bindings[0].definition_id == definition.id
    assert bound.checksum != document.checksum
    with pytest.raises(EngineTagRegistryError, match="engine_tag_identity_stale"):
        service.apply(
            document,
            _command(document, "bind", definition_id=definition.id, owner=owner),
        )


def test_create_and_bind_is_atomic_and_one_owner_accepts_multiple_definitions() -> None:
    service = EngineTagRegistryService(clock=lambda: datetime(2026, 1, 2, tzinfo=UTC))
    document = _document()
    owner = EngineTagOwnerV1(kind="node", project_id="project", node_id="node-1")
    first, _ = service.apply(
        document,
        _command(document, "create_and_bind", key="Character.Ilya", owner=owner),
    )
    second, _ = service.apply(
        first,
        _command(first, "create_and_bind", key="Faction.Citadel", owner=owner),
    )

    assert len(second.engine_tag_definitions) == 2
    assert len(second.engine_tag_bindings) == 2
    assert {binding.definition_id for binding in second.engine_tag_bindings} == {
        definition.id for definition in second.engine_tag_definitions
    }


def test_batch_unbind_removes_only_the_selected_definition() -> None:
    service = EngineTagRegistryService(clock=lambda: datetime(2026, 1, 2, tzinfo=UTC))
    document = _document()
    owner = EngineTagOwnerV1(kind="node", project_id="project", node_id="node-1")
    first, _ = service.apply(
        document,
        _command(document, "create_and_bind", key="Character.Ilya", owner=owner),
    )
    second, _ = service.apply(
        first,
        _command(first, "create_and_bind", key="Faction.Citadel", owner=owner),
    )
    removed_id = next(item.id for item in second.engine_tag_definitions if item.key == "Character.Ilya")
    remaining_id = next(item.id for item in second.engine_tag_definitions if item.key == "Faction.Citadel")
    unbound, _ = service.apply(
        second,
        _command(second, "batch_unbind", definition_id=removed_id, owners=[owner]),
    )

    assert [binding.definition_id for binding in unbound.engine_tag_bindings] == [remaining_id]


def test_registry_rename_rejects_normalized_collisions_and_delete_requires_review() -> None:
    service = EngineTagRegistryService(clock=lambda: datetime(2026, 1, 2, tzinfo=UTC))
    document = _document()
    first, _ = service.apply(document, _command(document, "create_definition", key="Story.Main"))
    second, _ = service.apply(first, _command(first, "create_definition", key="Story.Other"))
    first_id = next(item.id for item in second.engine_tag_definitions if item.normalized_key == "story.main")
    with pytest.raises(EngineTagRegistryError, match="engine_tag_key_collision"):
        service.apply(second, _command(second, "rename_definition", definition_id=first_id, key="story.other"))
    impact = service.impact_fingerprint(second, first_id)
    deleted, _ = service.apply(
        second,
        _command(second, "delete_definition", definition_id=first_id, reviewed_impact_fingerprint=impact),
    )
    assert first_id not in {item.id for item in deleted.engine_tag_definitions}


def test_batch_bind_deduplicates_atomically_before_replacing_the_document() -> None:
    service = EngineTagRegistryService(clock=lambda: datetime(2026, 1, 2, tzinfo=UTC))
    document = _document()
    created, _ = service.apply(document, _command(document, "create_definition", key="Story.Main"))
    definition = created.engine_tag_definitions[0]
    owner = EngineTagOwnerV1(kind="node", project_id="project", node_id="node-1")
    with pytest.raises(EngineTagRegistryError, match="engine_tag_key_collision"):
        service.apply(
            created,
            _command(created, "batch_bind", definition_id=definition.id, owners=[owner, owner]),
        )
    assert created.engine_tag_bindings == []


def test_integrity_reports_unreviewed_legacy_and_missing_target_aliases_without_mutation() -> None:
    service = EngineTagRegistryService()
    document = _document()
    created, _ = service.apply(document, _command(document, "create_definition", key="Story.Main"))
    # Imported older definitions may predate initial source-target aliases.
    created = create_project_document(**{
        **created.model_dump(mode="python", exclude={"checksum"}),
        "engine_tag_definitions": [item.model_copy(update={"aliases": []}) for item in created.engine_tag_definitions],
    })
    report = service.integrity(created)
    assert report.project_id == "project"
    assert report.error_count == 0
    assert report.warning_count == 0
    assert report.info_count == 2
    assert {finding.details["target"] for finding in report.findings} == {"ink", "yarn_spinner"}
    assert {finding.code for finding in report.findings} == {"target_incompatibility"}
    assert report.source_checksum == created.checksum


def test_nested_owner_requires_every_identity_in_the_project_document() -> None:
    document = _document()
    missing_line = EngineTagOwnerV1(
        kind="dialogue_line", project_id="project",
        dialogue_node_id="node-1", line_id="missing-line",
    )
    assert EngineTagRegistryService._owner_exists(document, missing_line) is False


def test_owner_cleanup_matches_only_deleted_aggregates_and_relationships() -> None:
    dialogue_line = {
        "kind": "dialogue_line",
        "project_id": "project",
        "dialogue_node_id": "dialogue-1",
        "line_id": "line-1",
    }
    relationship = {
        "kind": "relationship",
        "project_id": "project",
        "edge_id": "edge-1",
    }

    assert owner_removed_with_node(dialogue_line, "dialogue-1") is True
    assert owner_removed_with_node(dialogue_line, "other-node") is False
    assert owner_removed_with_relationships(relationship, {"edge-1"}) is True
    assert owner_removed_with_relationships(relationship, {"edge-2"}) is False
    assert owner_removed_with_relationships(dialogue_line, {"edge-1"}) is False


def test_alias_uniqueness_is_case_insensitive_per_target() -> None:
    service = EngineTagRegistryService(clock=lambda: datetime(2026, 1, 2, tzinfo=UTC))
    document = _document()
    first, _ = service.apply(document, _command(document, "create_definition", key="Story.Main"))
    second, _ = service.apply(first, _command(first, "create_definition", key="Story.Other"))
    first_id, second_id = [item.id for item in second.engine_tag_definitions]
    aliased, _ = service.apply(second, _command(
        second, "set_alias", definition_id=first_id,
        alias=EngineTagTargetAliasV1(target="unreal", external_identifier="STT_Main"),
    ))

    with pytest.raises(EngineTagRegistryError, match="engine_tag_key_collision"):
        service.apply(aliased, _command(
            aliased, "set_alias", definition_id=second_id,
            alias=EngineTagTargetAliasV1(target="unreal", external_identifier="stt_main"),
        ))


def test_merge_revalidates_reviewed_impact_and_moves_bindings() -> None:
    service = EngineTagRegistryService(clock=lambda: datetime(2026, 1, 2, tzinfo=UTC))
    document = _document()
    owner = EngineTagOwnerV1(kind="node", project_id="project", node_id="node-1")
    source, _ = service.apply(
        document, _command(document, "create_and_bind", key="Character.Ilya", owner=owner),
    )
    target, _ = service.apply(
        source, _command(source, "create_definition", key="Character.Hero"),
    )
    source_id = next(item.id for item in target.engine_tag_definitions if item.key == "Character.Ilya")
    target_id = next(item.id for item in target.engine_tag_definitions if item.key == "Character.Hero")
    reviewed = service.impact_fingerprint(target, source_id)

    with pytest.raises(EngineTagRegistryError, match="engine_tag_identity_stale"):
        service.apply(target, _command(
            target, "merge", definition_id=source_id, target_definition_id=target_id,
            reviewed_impact_fingerprint="0" * 64,
        ))
    merged, impact = service.apply(target, _command(
        target, "merge", definition_id=source_id, target_definition_id=target_id,
        reviewed_impact_fingerprint=reviewed,
    ))

    assert impact == reviewed
    assert [item.id for item in merged.engine_tag_definitions] == [target_id]
    assert [item.definition_id for item in merged.engine_tag_bindings] == [target_id]


def test_reviewed_legacy_conversion_preserves_quarantine_row() -> None:
    service = EngineTagRegistryService(clock=lambda: datetime(2026, 1, 2, tzinfo=UTC))
    legacy = LegacyEngineTagRecordV1(
        id="legacy-1", project_id="project", target_type="node", target_id="node-1",
        engine="unreal", key="Character.LegacyIlya", value="LegacyIlya",
        metadata={"unknown": {"kept": True}},
        created_at="2026-01-01T00:00:00Z", updated_at="2026-01-01T00:00:00Z",
    )
    base = _document()
    payload = base.model_dump(mode="python", exclude={"checksum"})
    document = create_project_document(**{**payload, "legacy_engine_tags": [legacy]})
    owner = EngineTagOwnerV1(kind="node", project_id="project", node_id="node-1")

    converted, _ = service.apply(document, _command(
        document, "convert_legacy", legacy_id=legacy.id,
        key="Character.LegacyIlya", owner=owner,
    ))

    assert converted.legacy_engine_tags == [legacy]
    assert [item.key for item in converted.engine_tag_definitions] == ["Character.LegacyIlya"]
    assert converted.engine_tag_bindings[0].value == "LegacyIlya"
    assert {alias.target for alias in converted.engine_tag_definitions[0].aliases} == {"ink", "yarn_spinner"}
