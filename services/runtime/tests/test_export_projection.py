"""Pure scope and allowlist projection tests for Phase 8 exports."""

from copy import deepcopy
from pathlib import Path

from services.runtime.stt_runtime.export.projection import ExportProjectionService
from services.runtime.stt_runtime.engine_tags.projection import EngineTagProjectionService
from services.runtime.stt_runtime.project_fixture import load_project_fixture
from services.runtime.stt_runtime.schemas.export import ExportOptionsV1
from services.runtime.stt_runtime.schemas.project_document import (
    ProjectDocument,
    create_project_document,
)

FIXTURES = Path(__file__).parents[3] / "fixtures" / "projects"


def _document(name: str = "project-aurora.v1.json") -> ProjectDocument:
    fixture = load_project_fixture(FIXTURES / name)
    payload = fixture.model_dump(
        mode="python",
        exclude={"fixture_version", "slug", "playback_effects", "expected_validation"},
    )
    return create_project_document(**payload)


def _options(
    *,
    scope: str = "whole_project",
    flow_ids: list[str] | None = None,
    target: str = "generic",
) -> ExportOptionsV1:
    return ExportOptionsV1(
        format="json",
        scope=scope,
        story_flow_ids=flow_ids or [],
        engine_tag_target=target,
    )


def _changed(document: ProjectDocument, **changes: object) -> ProjectDocument:
    """Recompute the checksum after deliberately changing a test document."""

    return create_project_document(**{
        **document.model_dump(mode="python", exclude={"checksum"}),
        **changes,
    })


def test_whole_project_maps_every_allowlisted_record_without_mutation() -> None:
    document = _document()
    before = deepcopy(document.model_dump(mode="json"))

    result = ExportProjectionService().build(document, _options())
    projection = result.projection

    assert result.inventory.node_count == len(document.nodes) == 16
    assert result.inventory.relationship_count == len(document.edges)
    assert result.inventory.dialogue_count == len(document.dialogues) == 1
    assert result.inventory.quest_count == len(document.quests) == 1
    assert result.inventory.story_flow_count == len(document.story_flows) == 3
    assert result.inventory.flow_invocation_count == len(document.flow_invocations) == 2
    assert result.inventory.initial_state_count == len(document.flow_initial_states) == 2
    assert result.inventory.narrative_effect_count == len(document.narrative_effects) == 4
    assert projection.manifest.source.source_checksum == document.checksum
    assert projection.manifest.story_flow_ids == []

    mara = next(item for item in projection.nodes if item.id == "node-hero")
    assert mara.attributes.character_role == "Protagonist and smuggler captain"
    condition = next(item for item in projection.nodes if item.id == "node-ledger-condition")
    assert condition.attributes.requirement is not None
    assert condition.attributes.requirement.expression == "inventory.has('sealed-ledger')"
    consequence = next(item for item in projection.nodes if item.id == "node-route-consequence")
    assert consequence.attributes.outcome is not None
    assert consequence.attributes.outcome.target_node_ids == ["node-harbor", "node-smuggler-route"]
    assert next(item for item in projection.nodes if item.id == "node-harbor").container_node_ids == [
        "node-opening"
    ]

    # The observational service must not alter checksums, ordering, metadata, or history-owned data.
    assert document.model_dump(mode="json") == before
    assert ExportProjectionService().build(document, _options()) == result


def test_projection_excludes_internal_and_machine_owned_sections() -> None:
    projection = ExportProjectionService().build(_document(), _options()).projection
    payload = projection.model_dump(mode="json")

    assert set(payload) == {
        "projection_version", "manifest", "project", "nodes", "relationships",
        "dialogues", "quests", "story_flows", "narrative_state", "engine_tags",
        "diagnostics",
    }
    serialized = projection.model_dump_json()
    for forbidden in (
        '"placements"', '"issues"', '"suggestions"', '"style_profiles"',
        '"scene_style_assignments"', '"agent_memories"', '"storage"',
        '"provider_profile_id"', '"saved_revision"', '"project_path"',
    ):
        assert forbidden not in serialized


def test_selected_flow_resolves_recursive_calls_aggregates_state_and_effects() -> None:
    document = _document()
    result = ExportProjectionService().build(
        document,
        _options(scope="story_flows", flow_ids=["flow-main-story"]),
    )
    projection = result.projection

    assert result.inventory.resolved_story_flow_ids == [
        "flow-main-story", "flow-smuggler-route", "flow-z-blockade-outcome"
    ]
    assert {item.node_id for item in projection.dialogues} == {"node-dock-dialogue"}
    assert {item.node_id for item in projection.quests} == {"node-smuggler-route"}
    assert {item.id for item in projection.narrative_state.initial_states} == {
        "state-main-ledger", "state-side-ledger"
    }
    assert {item.id for item in projection.narrative_state.effects} == {
        "effect-01-ledger-ilya-to-mara", "effect-02-quest-route-completed",
        "effect-03-quest-reward-to-party", "effect-04-exit-ledger-to-player",
    }
    assert {item.id for item in projection.story_flows.invocations} == {
        "flow-invocation-dialogue-smuggler-route",
        "flow-invocation-inspection-smuggler-route",
    }
    assert result.inventory.engine_tag_count == len(projection.engine_tags.entries)


def test_narrow_scope_adds_containment_context_and_reports_cross_scope_edges() -> None:
    result = ExportProjectionService().build(
        _document(),
        _options(scope="story_flows", flow_ids=["flow-z-blockade-outcome"]),
    )
    node_ids = {item.id for item in result.projection.nodes}

    # The member Event is nested in Opening Dock. The Scene and its composed
    # authored contents survive, while unrelated root Quest/state records do not.
    assert {"node-mara-runs-blockade", "node-opening", "node-harbor", "node-customs-office"} <= node_ids
    assert "node-smuggler-route" not in node_ids
    assert result.projection.quests == []
    assert result.projection.narrative_state.initial_states == []
    assert all(
        entry.owner.quest_node_id != "node-smuggler-route"
        and entry.owner.flow_id in {None, "flow-z-blockade-outcome"}
        for entry in result.projection.engine_tags.entries
    )
    assert any(
        item.code == "export.scope.relationship-omitted"
        for item in result.projection.diagnostics
    )
    assert all(
        edge.source_node_id in node_ids and edge.target_node_id in node_ids
        for edge in result.projection.relationships
    )

    targeted = ExportProjectionService().build(
        _document(),
        _options(
            scope="story_flows",
            flow_ids=["flow-z-blockade-outcome"],
            target="unreal",
        ),
    ).projection.engine_tags
    out_of_scope = {
        item.definition_id for item in targeted.omitted if item.code == "out_of_scope"
    }
    missing_alias = {
        item.definition_id for item in targeted.omitted if item.code == "missing_target_alias"
    }
    assert out_of_scope
    assert out_of_scope.isdisjoint(missing_alias)


def test_empty_and_missing_flow_selections_return_stable_blocking_diagnostics() -> None:
    service = ExportProjectionService()
    document = _document()

    empty = service.build(document, _options(scope="story_flows"))
    missing = service.build(
        document,
        _options(scope="story_flows", flow_ids=["flow-missing"]),
    )

    assert empty.inventory.record_count == empty.inventory.engine_tag_count
    assert "export.scope.empty-selection" in {
        item.code for item in empty.projection.diagnostics
    }
    assert "export.scope.missing-flow" in {
        item.code for item in missing.projection.diagnostics
    }
    assert next(
        item for item in empty.projection.diagnostics
        if item.code == "export.scope.empty-selection"
    ).severity == "error"
    assert all(
        item.severity == "warning"
        for item in empty.projection.diagnostics
        if item.code == "export.engine-tags.out-of-scope"
    )


def test_corrupt_bypassed_references_and_recursion_are_diagnosed_without_crashing() -> None:
    document = _document()
    invocation = document.flow_invocations[0]
    membership = document.story_flow_nodes[0]
    broken = document.model_copy(update={
        "flow_invocations": [
            invocation.model_copy(update={"target_flow_id": "flow-missing"}),
            *document.flow_invocations[1:],
        ],
        "story_flow_nodes": [
            membership.model_copy(update={"node_id": "node-missing"}),
            *document.story_flow_nodes[1:],
        ],
    })
    broken_result = ExportProjectionService().build(
        broken,
        _options(scope="story_flows", flow_ids=["flow-main-story"]),
    )
    assert {item.code for item in broken_result.projection.diagnostics} >= {
        "export.scope.missing-flow", "export.scope.missing-invoked-flow",
        "export.scope.missing-node",
    }

    recursive = document.model_copy(update={
        "flow_invocations": [
            invocation.model_copy(update={"target_flow_id": "flow-main-story"}),
            *document.flow_invocations[1:],
        ]
    })
    recursive_result = ExportProjectionService().build(
        recursive,
        _options(scope="story_flows", flow_ids=["flow-main-story"]),
    )
    assert "export.scope.recursion" in {
        item.code for item in recursive_result.projection.diagnostics
    }


def test_unsupported_records_and_unsafe_extensions_are_explicit() -> None:
    document = _document()
    first = document.nodes[0]
    unsupported = first.model_copy(update={
        "type": "UnknownType",
        "metadata": {**first.metadata, "x-private": {"storage": "postgresql"}},
    })
    changed = document.model_copy(update={"nodes": [unsupported, *document.nodes[1:]]})

    result = ExportProjectionService().build(changed, _options())
    codes = {item.code for item in result.projection.diagnostics}
    projected = next(item for item in result.projection.nodes if item.id == unsupported.id)

    assert codes >= {
        "export.record.unsupported-node-type", "export.record.unsafe-extension"
    }
    assert projected.extensions.values == {}


def test_empty_project_and_serialized_storage_documents_have_identical_results() -> None:
    empty = _document("citadel-branch.v1.json")
    empty_result = ExportProjectionService().build(empty, _options())
    assert empty_result.inventory.record_count == 0
    assert empty_result.projection.nodes == []
    assert empty_result.projection.diagnostics == []

    sqlite_document = _document()
    postgresql_document = ProjectDocument.model_validate_json(
        sqlite_document.model_dump_json()
    )
    assert ExportProjectionService().build(sqlite_document, _options()) == (
        ExportProjectionService().build(postgresql_document, _options())
    )


def test_aurora_target_views_preserve_canonical_identity_without_mutation() -> None:
    document = _document()
    before = deepcopy(document.model_dump(mode="json"))
    projections = {
        target: ExportProjectionService().build(
            document, _options(target=target)
        ).projection.engine_tags
        for target in ("generic", "unreal", "unity", "ink", "yarn_spinner")
    }

    canonical = "tagdef-aurora-character-mara"
    entries = {
        target: next(item for item in projection.entries if item.definition_id == canonical)
        for target, projection in projections.items()
    }
    assert {item.normalized_key for item in entries.values()} == {"character.maravale"}
    assert {item.owner for item in entries.values()} == {entries["generic"].owner}
    assert entries["generic"].identifier == "character.maravale"
    assert entries["unreal"].identifier == "Character.MaraVale"
    assert entries["ink"].identifier == "character_mara_vale"
    assert all(item.source_checksum == document.checksum for item in projections.values())
    assert document.model_dump(mode="json") == before


def test_engine_tag_readiness_maps_omissions_and_collisions_to_severity() -> None:
    document = _document()
    unreal = ExportProjectionService().build(document, _options(target="unreal")).projection
    assert any(
        item.code == "export.engine-tags.missing-target-alias" and item.severity == "error"
        for item in unreal.diagnostics
    )

    definitions = list(document.engine_tag_definitions)
    mara_alias = next(
        alias for alias in definitions[0].aliases if alias.target == "unreal"
    )
    relationship = definitions[7].model_copy(update={"aliases": [mara_alias]})
    collided = _changed(
        document,
        engine_tag_definitions=[*definitions[:7], relationship, *definitions[8:]],
    )
    collision = ExportProjectionService().build(
        collided, _options(target="unreal")
    ).projection
    assert any(
        item.code == "export.engine-tags.target-collision" and item.severity == "error"
        for item in collision.diagnostics
    )


def test_engine_tag_readiness_reports_archived_invalid_missing_owner_and_legacy() -> None:
    document = _document()
    definitions = list(document.engine_tag_definitions)
    bindings = list(document.engine_tag_bindings)
    alias = next(item for item in definitions[0].aliases if item.target == "unreal")
    definitions[0] = definitions[0].model_copy(update={"status": "archived"})
    definitions[1] = definitions[1].model_copy(update={
        "aliases": [alias.model_copy(update={"external_identifier": "invalid alias"})]
    })
    definitions[2] = definitions[2].model_copy(update={
        "aliases": [alias.model_copy(update={"external_identifier": "State.TransferLedger"})]
    })
    bindings[2] = bindings[2].model_copy(update={
        "owner": bindings[2].owner.model_copy(update={"effect_id": "effect-missing"})
    })
    legacy = [{
        "id": "legacy-export-row",
        "project_id": document.manifest.project_id,
        "created_at": "2026-01-02T00:00:00+00:00",
        "updated_at": "2026-01-02T00:00:00+00:00",
        "target_type": "node",
        "target_id": "node-hero",
        "engine": "unreal",
        "key": "legacy.hero",
        "value": "",
        "metadata": {},
    }]
    changed = _changed(
        document,
        engine_tag_definitions=definitions,
        engine_tag_bindings=bindings,
        legacy_engine_tags=legacy,
    )

    diagnostics = ExportProjectionService().build(
        changed, _options(target="unreal")
    ).projection.diagnostics
    severity = {item.code: item.severity for item in diagnostics}
    assert severity["export.engine-tags.archived-definition"] == "warning"
    assert severity["export.engine-tags.target-identifier-invalid"] == "error"
    assert severity["export.engine-tags.missing-owner"] == "error"
    assert severity["export.engine-tags.legacy-quarantine"] == "warning"


def test_stale_engine_tag_projection_is_rejected_and_citadel_is_valid_for_every_target() -> None:
    class StaleProjector(EngineTagProjectionService):
        def project(self, document, target, *, owner_filter=None):
            current = super().project(document, target, owner_filter=owner_filter)
            return current.model_copy(update={"source_checksum": "f" * 64})

    document = _document()
    result = ExportProjectionService(StaleProjector()).build(document, _options())
    assert result.projection.engine_tags.entries == []
    assert result.projection.engine_tags.source_checksum == document.checksum
    assert any(
        item.code == "export.engine-tags.source-stale" and item.severity == "error"
        for item in result.projection.diagnostics
    )

    citadel = _document("citadel-branch.v1.json")
    for target in ("generic", "unreal", "unity", "ink", "yarn_spinner"):
        projection = ExportProjectionService().build(
            citadel, _options(target=target)
        ).projection
        assert projection.engine_tags.entries == []
        assert projection.engine_tags.omitted == []
        assert projection.engine_tags.diagnostics == []
        assert projection.diagnostics == []
