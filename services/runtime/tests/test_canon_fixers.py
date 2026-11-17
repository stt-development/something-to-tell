"""P5.6 deterministic fixer allowlist and ProjectPatch preservation tests."""

from copy import deepcopy
from datetime import UTC, datetime
from pathlib import Path

from services.runtime.stt_runtime.canon.engine import CanonRuleEngine
from services.runtime.stt_runtime.canon.fixers import CanonFixerRegistry
from services.runtime.stt_runtime.canon.projection import CanonFactProjector
from services.runtime.stt_runtime.project_document.patch import (
    apply_project_patch,
    derive_project_patch,
)
from services.runtime.stt_runtime.project_fixture import import_project_fixture
from services.runtime.stt_runtime.project_session.service import ProjectSessionRegistry
from services.runtime.stt_runtime.schemas.canon_check import (
    CanonIssueMetadataV1,
    CanonIssueMetadataV2,
)
from services.runtime.stt_runtime.schemas.project_document import (
    ProjectDocument,
    create_project_document,
)

FIXTURE = Path(__file__).parents[3] / "fixtures" / "projects" / "project-aurora.v1.json"


def test_condition_fixer_preserves_quest_stage_and_branch_identity(tmp_path: Path) -> None:
    registry, session_id, document = _open_document(tmp_path, "QuestFix")
    try:
        check_input = registry.capture_canon_input(session_id)
        candidate = next(
            item
            for item in CanonRuleEngine().evaluate(check_input)
            if item.rule_id == "condition.unresolved-path"
            and item.scope.owner_type == "quest_branch"
            and item.message_parameters["condition"] == "ledger_acquired"
        )
        patch = CanonFixerRegistry().propose(_metadata(candidate, document), document)

        assert patch is not None
        assert [(item.collection, item.record_id) for item in patch.operations] == [
            ("quests", "node-smuggler-route")
        ]
        fixed = apply_project_patch(document, patch)
        before = document.quests[0].document
        after = fixed.quests[0].document
        assert [stage.id for stage in after.stages] == [stage.id for stage in before.stages]
        assert [branch.id for stage in after.stages for branch in stage.branches] == [
            branch.id for stage in before.stages for branch in stage.branches
        ]
        assert after.stages[0].branches[0].condition == "flags.ledger_acquired == true"

        changed_payload = document.model_dump(mode="python", exclude={"checksum"})
        changed_payload["quests"][0]["document"]["stages"][0]["branches"][0][
            "condition"
        ] = "flags.author_override == true"
        changed = create_project_document(**changed_payload)
        assert CanonFixerRegistry().propose(_metadata(candidate, document), changed) is None
    finally:
        registry.close(session_id)


def test_compound_specialized_patch_preserves_ids_and_order(tmp_path: Path) -> None:
    registry, session_id, source = _open_document(tmp_path, "CompoundFix")
    try:
        payload = source.model_dump(mode="python", exclude={"checksum"})
        payload["dialogues"][0]["document"]["elements"][0]["text"] += " Reviewed."
        payload["quests"][0]["document"]["stages"][0]["branches"][0]["condition"] = "flags.ledger_acquired == true"
        payload["flow_initial_states"][0]["flags"]["ledger_acquired"] = False
        target = create_project_document(**payload)

        patch = derive_project_patch(source, target)
        assert [item.collection for item in patch.operations] == [
            "dialogues",
            "quests",
            "flow_initial_states",
        ]
        applied = apply_project_patch(source, patch)
        assert applied == target
        assert [item.node_id for item in applied.dialogues] == [item.node_id for item in source.dialogues]
        assert [item.node_id for item in applied.quests] == [item.node_id for item in source.quests]
        assert [item.id for item in applied.flow_initial_states] == [item.id for item in source.flow_initial_states]
    finally:
        registry.close(session_id)


def test_required_outcome_fixer_adds_a_reviewable_temporary_flow_route(tmp_path: Path) -> None:
    """A uniquely owned outcome gets a minimal route with its authored condition."""

    registry, session_id, document = _open_document(tmp_path, "OutcomeFix")
    try:
        check_input = registry.capture_canon_input(session_id)
        candidate = next(
            item
            for item in CanonRuleEngine().evaluate(check_input)
            if item.rule_id == "outcome.required-reachability"
            and item.message_parameters["edge_id"] == "edge-quest-legal-route"
        )

        patch = CanonFixerRegistry().propose(_metadata(candidate, document), document)

        assert patch is not None
        assert [(item.collection, item.record_id) for item in patch.operations] == [
            ("flow_transitions", "canon-outcome-route-edge-quest-legal-route")
        ]
        fixed = apply_project_patch(document, patch)
        route = next(
            item
            for item in fixed.flow_transitions
            if item.id == "canon-outcome-route-edge-quest-legal-route"
        )
        assert route.flow_id == "flow-smuggler-route"
        assert route.source_node_id == "node-smuggler-route"
        assert route.target_node_id == "node-route-consequence"
        assert route.condition == "ledger_verified"
        assert route.metadata == {
            "semantic_edge_id": "edge-quest-legal-route",
            "quest_stage_id": "stage-choose-route",
            "quest_branch_id": "branch-legal-route",
            "canon_temporary": True,
        }
        assert CanonFixerRegistry().propose(_metadata(candidate, document), fixed) is None
        remaining = _candidates(fixed)
        assert not any(
            item.rule_id == "outcome.required-reachability"
            and item.message_parameters.get("edge_id") == "edge-quest-legal-route"
            for item in remaining
        )
    finally:
        registry.close(session_id)


def test_single_member_flow_entry_fixer_is_bounded_and_resolves_integrity(
    tmp_path: Path,
) -> None:
    """All allowlisted entry facts produce the same one-record structural patch."""

    registry, session_id, document = _open_document(tmp_path, "EntryFix")
    try:
        source = _with_single_member_flow_without_entry(document)
        candidate = next(
            item
            for item in _candidates(source)
            if item.diagnostic is not None
            and item.diagnostic.fact_code == "flow.missing_entry"
        )
        metadata = _metadata(candidate, source)
        assert isinstance(metadata, CanonIssueMetadataV2)

        for fact_code in (
            "flow.missing_entry",
            "flow.composable_flow_missing_entry",
            "playback.missing_entry",
        ):
            allowed = metadata.model_copy(update={
                "diagnostic": metadata.diagnostic.model_copy(update={"fact_code": fact_code})
            })
            patch = CanonFixerRegistry().propose(allowed, source)
            assert patch is not None
            assert [(item.collection, item.record_id) for item in patch.operations] == [
                ("story_flows", "flow-canon-entry")
            ]

        patch = CanonFixerRegistry().propose(metadata, source)
        assert patch is not None
        fixed = apply_project_patch(source, patch)
        repaired = next(item for item in fixed.story_flows if item.id == "flow-canon-entry")
        assert repaired.entry_node_id == "node-mara-runs-blockade"
        assert CanonFixerRegistry().propose(metadata, fixed) is None
        assert fixed.nodes == source.nodes
        assert fixed.story_flow_nodes == source.story_flow_nodes
        assert fixed.flow_transitions == source.flow_transitions

        remaining = _candidates(fixed)
        assert not any(
            item.diagnostic is not None
            and item.diagnostic.fact_code == "flow.missing_entry"
            for item in remaining
        )
    finally:
        registry.close(session_id)


def test_flow_entry_fixer_rejects_an_authorial_choice(tmp_path: Path) -> None:
    """A multi-member Flow must not receive an arbitrary deterministic entry."""

    registry, session_id, document = _open_document(tmp_path, "EntryChoice")
    try:
        source = _without_flow_entry(document, "flow-main-story")
        candidate = next(
            item
            for item in _candidates(source)
            if item.diagnostic is not None
            and item.diagnostic.fact_code == "flow.missing_entry"
            and item.scope.owner_id == "flow-main-story"
        )

        assert CanonFixerRegistry().propose(_metadata(candidate, source), source) is None
    finally:
        registry.close(session_id)


def test_registry_denies_ambiguous_domain_repairs(tmp_path: Path) -> None:
    """Known diagnostics still require review when a repair would invent intent."""

    registry, session_id, document = _open_document(tmp_path, "DeniedFacts")
    try:
        source = _with_single_member_flow_without_entry(document)
        candidate = next(
            item
            for item in _candidates(source)
            if item.diagnostic is not None
            and item.diagnostic.fact_code == "flow.missing_entry"
        )
        metadata = _metadata(candidate, source)
        assert isinstance(metadata, CanonIssueMetadataV2)

        for fact_code in (
            "composition.duplicate_placement",
            "dialogue.dead_end",
            "flow.multiple_default_branches",
        ):
            denied = metadata.model_copy(update={
                "diagnostic": metadata.diagnostic.model_copy(update={"fact_code": fact_code})
            })
            assert CanonFixerRegistry().propose(denied, source) is None
    finally:
        registry.close(session_id)


def _open_document(tmp_path: Path, name: str):
    project_path = tmp_path / f"{name}.narrative"
    import_project_fixture(FIXTURE, project_path)
    registry = ProjectSessionRegistry()
    opened = registry.open(project_path)
    return registry, opened.session.session_id, opened.document


def _metadata(candidate, document) -> CanonIssueMetadataV1:
    observed_at = datetime(2026, 8, 21, tzinfo=UTC)
    values = dict(
        origin="canon_rule",
        rule_id=candidate.rule_id,
        rule_version=candidate.rule_version,
        fingerprint=candidate.fingerprint,
        category=candidate.category,
        scope=candidate.scope,
        message_key=candidate.message_key,
        message_parameters=candidate.message_parameters,
        recommendation_key=candidate.recommendation_key,
        recommendation_parameters=candidate.recommendation_parameters,
        targets=candidate.targets,
        evidence=candidate.evidence,
        saved_revision=document.manifest.saved_revision,
        source_checksum=document.checksum,
        first_seen_at=observed_at,
        last_seen_at=observed_at,
    )
    if candidate.diagnostic is not None:
        return CanonIssueMetadataV2(
            **values,
            issue_version=2,
            diagnostic=candidate.diagnostic,
        )
    return CanonIssueMetadataV1(**values)


def _without_flow_entry(document: ProjectDocument, flow_id: str) -> ProjectDocument:
    """Build a valid immutable document whose selected Flow requires entry repair."""

    payload = document.model_dump(mode="python", exclude={"checksum"})
    flow = next(item for item in payload["story_flows"] if item["id"] == flow_id)
    flow["entry_node_id"] = None
    return create_project_document(**payload)


def _with_single_member_flow_without_entry(document: ProjectDocument) -> ProjectDocument:
    """Add an isolated draft Flow that has one unambiguous entry candidate."""

    payload = document.model_dump(mode="python", exclude={"checksum"})
    flow = deepcopy(payload["story_flows"][0])
    flow.update({
        "id": "flow-canon-entry",
        "name": "Canon Entry Example",
        "normalized_name": "canon entry example",
        "description": "Single-member draft used to verify deterministic entry repair.",
        "kind": "standalone",
        "status": "draft",
        "entry_node_id": None,
        "metadata": {"test": "canon-entry-fixer"},
    })
    membership = deepcopy(payload["story_flow_nodes"][0])
    membership.update({
        "id": "flow-canon-entry:member:node-mara-runs-blockade",
        "flow_id": "flow-canon-entry",
        "node_id": "node-mara-runs-blockade",
        "presentation_order": 0,
        "metadata": {"test": "canon-entry-fixer"},
    })
    payload["story_flows"].append(flow)
    payload["story_flow_nodes"].append(membership)
    payload["story_flows"].sort(key=lambda item: item["id"])
    payload["story_flow_nodes"].sort(key=lambda item: item["id"])
    return create_project_document(**payload)


def _candidates(document: ProjectDocument):
    """Reproject facts for the supplied immutable document before evaluating rules."""

    return CanonRuleEngine().evaluate(CanonFactProjector().project(document))
