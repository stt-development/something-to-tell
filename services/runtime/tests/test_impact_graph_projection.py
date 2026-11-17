from copy import deepcopy
from datetime import UTC, datetime
from pathlib import Path

import pytest

from services.runtime.stt_runtime.canon.projection import CanonFactProjector
from services.runtime.stt_runtime.impact import GraphCompositionCanonDependencyProjector
from services.runtime.stt_runtime.project_fixture import import_project_fixture
from services.runtime.stt_runtime.schemas.canon_check import (
    CanonEvidenceRef,
    CanonIssueMetadataV1,
    CanonOwnerRef,
    canon_issue_fingerprint,
)
from services.runtime.stt_runtime.schemas.impact_analysis import ImpactDependency
from services.runtime.stt_runtime.schemas.project_document import (
    ProjectDocument,
    ProjectEdgeRecord,
    ProjectIssueRecord,
    ProjectPlacementRecord,
    create_project_document,
)

FIXTURE = Path(__file__).parents[3] / "fixtures" / "projects" / "project-aurora.v1.json"
NOW = datetime(2026, 8, 25, 12, 0, tzinfo=UTC)


@pytest.fixture(scope="module")
def aurora(tmp_path_factory: pytest.TempPathFactory) -> ProjectDocument:
    project_path = tmp_path_factory.mktemp("impact-aurora") / "ProjectAurora.narrative"
    return import_project_fixture(FIXTURE, project_path).document


def _ref(owner_type: str, owner_id: str) -> CanonOwnerRef:
    return CanonOwnerRef(owner_type=owner_type, owner_id=owner_id)


def _matching(
    dependencies: tuple[ImpactDependency, ...],
    *,
    kind: str,
    source_id: str | None = None,
    target_id: str | None = None,
) -> list[ImpactDependency]:
    return [
        item
        for item in dependencies
        if item.kind == kind
        and (source_id is None or item.source.owner_id == source_id)
        and (target_id is None or item.target.owner_id == target_id)
    ]


def _rebuild(document: ProjectDocument, **updates: object) -> ProjectDocument:
    payload = document.model_dump(mode="python", exclude={"checksum"})
    payload.update(updates)
    return create_project_document(**payload)


def test_aurora_projection_is_complete_deterministic_and_input_immutable(
    aurora: ProjectDocument,
) -> None:
    before = deepcopy(aurora.model_dump(mode="json"))
    projector = GraphCompositionCanonDependencyProjector()

    first = projector.project(aurora)
    repeated = projector.project(aurora)

    assert first.project_id == "project-aurora"
    assert first.source_checksum == aurora.checksum
    assert [item.model_dump(mode="json") for item in first.dependencies] == [
        item.model_dump(mode="json") for item in repeated.dependencies
    ]
    assert [item.model_dump(mode="json") for item in first.resources] == [
        item.model_dump(mode="json") for item in repeated.resources
    ]
    assert {item.domain for item in first.dependencies} == {
        "graph",
        "composition",
        "flow",
        "dialogue",
        "quest",
        "temporal",
        "playback",
        "canon",
    }
    assert {item.owner_type for item in first.resources} == {
        "dialogue_element",
        "dialogue_option",
        "dialogue_participant",
        "condition",
        "node",
        "edge",
        "effect",
        "effect_binding",
        "flow",
        "flow_entry",
        "flow_exit",
        "flow_exit_binding",
        "flow_invocation",
        "flow_member",
        "flow_terminal",
        "flow_transition",
        "placement",
        "issue",
        "initial_state",
        "initial_state_value",
        "playback_definition",
        "playback_fact",
        "quest_branch",
        "quest_giver",
        "quest_outcome",
        "quest_requirement",
        "quest_reward",
        "quest_stage",
        "scene_boundary",
        "state_read",
        "state_write",
    }
    assert aurora.model_dump(mode="json") == before


def test_graph_relationships_require_endpoints_but_add_only_contextual_node_meaning(
    aurora: ProjectDocument,
) -> None:
    index = GraphCompositionCanonDependencyProjector().project(aurora)

    endpoint = _matching(
        index.dependencies,
        kind="graph.edge-source",
        source_id="node-trade-guild",
        target_id="edge-guild-ledger",
    )
    target_context = _matching(
        index.dependencies,
        kind="graph.semantic-target-context",
        source_id="edge-guild-ledger",
        target_id="node-sealed-ledger",
    )

    assert [item.propagation for item in endpoint] == ["required"]
    assert [item.propagation for item in target_context] == ["contextual"]
    assert {
        item.source.owner_id
        for item in index.incoming(_ref("edge", "edge-guild-ledger"))
        if item.domain == "graph"
    } == {"node-trade-guild", "node-sealed-ledger"}
    assert not any(
        item.target.owner_type == "node"
        and item.propagation in {"required", "conditional"}
        for item in index.outgoing(_ref("edge", "edge-guild-ledger"))
    )


def test_linked_placements_containment_and_membership_remain_composition_only(
    aurora: ProjectDocument,
) -> None:
    index = GraphCompositionCanonDependencyProjector().project(aurora)

    ilya_placements = _matching(
        index.dependencies,
        kind="composition.canonical-placement",
        source_id="node-dockmaster",
    )
    placement_container = _matching(
        index.dependencies,
        kind="composition.placement-container-context",
        source_id="seed-ilya-opening",
        target_id="node-opening",
    )
    contained_child = _matching(
        index.dependencies,
        kind="composition.contained-child-context",
        source_id="node-opening",
        target_id="node-dockmaster",
    )
    membership = index.outgoing(_ref("edge", "edge-mara-trade-guild-membership"))

    assert {item.target.owner_id for item in ilya_placements} == {
        "fixture-placement-node-dockmaster",
        "seed-ilya-opening",
    }
    assert all(item.propagation == "required" for item in ilya_placements)
    assert [item.propagation for item in placement_container] == ["contextual"]
    assert [item.propagation for item in contained_child] == ["contextual"]
    assert contained_child[0].message_parameters == {"role": "child"}
    assert not any(
        item.target.owner_id == "node-dockmaster"
        for item in index.outgoing(_ref("placement", "seed-ilya-opening"))
    )
    assert {
        (item.kind, item.target.owner_id, item.propagation)
        for item in membership
        if item.domain == "composition"
    } == {
        ("composition.membership-character-context", "node-hero", "contextual"),
        ("composition.membership-faction-context", "node-trade-guild", "contextual"),
    }

    # Endpoint -> edge -> endpoint is an intentional semantic reference cycle;
    # P5-005 owns bounded cycle termination rather than deleting this evidence.
    hero_edges = index.outgoing(_ref("node", "node-hero"), domains=frozenset({"graph"}))
    assert any(item.target.owner_id == "edge-mara-trade-guild-membership" for item in hero_edges)
    assert any(item.target.owner_id == "node-hero" for item in membership)


def test_managed_contains_records_preserve_location_cycles_for_bounded_traversal(
    aurora: ProjectDocument,
) -> None:
    # ProjectDocument can represent imported legacy composition before the
    # authoring service repairs it. Projection must remain finite and preserve
    # both sides as evidence; P5-005 traversal owns cycle termination.
    cycle_placement = ProjectPlacementRecord(
        id="cycle-placement-harbor-in-customs",
        project_id=aurora.manifest.project_id,
        canonical_node_id="node-harbor",
        container_node_id="node-customs-office",
        scope_key="node-customs-office:node-harbor",
        x=20,
        y=20,
        width=300,
        height=180,
        is_primary=False,
        presentation_state="expanded",
        created_at=NOW,
        updated_at=NOW,
    )
    contains_edges = [
        ProjectEdgeRecord(
            id="edge-contains-customs-harbor",
            project_id=aurora.manifest.project_id,
            source_node_id="node-customs-office",
            target_node_id="node-harbor",
            type="contains",
            metadata={"semantic_scope": "composition", "canvas_visibility": "hidden"},
            created_at=NOW,
            updated_at=NOW,
        ),
        ProjectEdgeRecord(
            id="edge-contains-harbor-customs",
            project_id=aurora.manifest.project_id,
            source_node_id="node-harbor",
            target_node_id="node-customs-office",
            type="contains",
            metadata={"semantic_scope": "composition", "canvas_visibility": "hidden"},
            created_at=NOW,
            updated_at=NOW,
        ),
        ProjectEdgeRecord(
            id="edge-contains-harbor-customs-copy",
            project_id=aurora.manifest.project_id,
            source_node_id="node-harbor",
            target_node_id="node-customs-office",
            type="contains",
            metadata={"semantic_scope": "composition", "canvas_visibility": "hidden"},
            created_at=NOW,
            updated_at=NOW,
        ),
    ]
    document = _rebuild(
        aurora,
        edges=sorted([*aurora.edges, *contains_edges], key=lambda item: item.id),
        placements=sorted([*aurora.placements, cycle_placement], key=lambda item: item.id),
    )
    index = GraphCompositionCanonDependencyProjector().project(document)

    assert _matching(
        index.dependencies,
        kind="composition.placement-relationship",
        source_id="fixture-placement-node-customs-office",
        target_id="edge-contains-harbor-customs",
    )
    assert _matching(
        index.dependencies,
        kind="composition.placement-relationship",
        source_id="fixture-placement-node-customs-office",
        target_id="edge-contains-harbor-customs-copy",
    )
    assert _matching(
        index.dependencies,
        kind="composition.placement-relationship",
        source_id="cycle-placement-harbor-in-customs",
        target_id="edge-contains-customs-harbor",
    )
    assert _matching(
        index.dependencies,
        kind="composition.contained-child-context",
        source_id="node-harbor",
        target_id="node-customs-office",
    )
    assert _matching(
        index.dependencies,
        kind="composition.contained-child-context",
        source_id="node-customs-office",
        target_id="node-harbor",
    )


def test_manual_and_generated_canon_issue_targets_keep_distinct_strength(
    aurora: ProjectDocument,
) -> None:
    target = _ref("node", "node-hero")
    scope = _ref("node", "node-opening")
    evidence_owner = _ref("edge", "edge-guild-ledger")
    fingerprint = canon_issue_fingerprint(
        rule_id="graph.test-impact",
        rule_version=1,
        scope=scope,
        targets=[target],
    )
    metadata = CanonIssueMetadataV1(
        origin="canon_rule",
        rule_id="graph.test-impact",
        rule_version=1,
        fingerprint=fingerprint,
        category="continuity",
        scope=scope,
        message_key="canon.rule.testImpact",
        targets=[target],
        evidence=[
            CanonEvidenceRef(
                owner=evidence_owner,
                field_path="type",
                message_key="canon.evidence.testImpact",
            )
        ],
        saved_revision=aurora.manifest.saved_revision,
        source_checksum=aurora.checksum,
        first_seen_at=NOW,
        last_seen_at=NOW,
    )
    generated = ProjectIssueRecord(
        id="issue-generated-impact",
        project_id=aurora.manifest.project_id,
        title="Generated impact fixture",
        node_id="node-hero",
        severity="warning",
        status="open",
        metadata=metadata.model_dump(mode="json"),
        created_at=NOW,
        updated_at=NOW,
    )
    document = _rebuild(
        aurora,
        issues=sorted([*aurora.issues, generated], key=lambda item: item.id),
    )
    index = GraphCompositionCanonDependencyProjector().project(document)

    assert [
        item.propagation
        for item in _matching(
            index.dependencies,
            kind="canon.issue-target",
            source_id="node-hero",
            target_id="issue-generated-impact",
        )
    ] == ["required"]
    assert {
        item.source.owner_id
        for item in _matching(
            index.dependencies,
            kind="canon.issue-evidence",
            target_id="issue-generated-impact",
        )
    } == {"edge-guild-ledger", "node-opening"}
    assert all(
        item.propagation == "contextual"
        for item in _matching(
            index.dependencies,
            kind="canon.issue-evidence",
            target_id="issue-generated-impact",
        )
    )
    assert _matching(
        index.dependencies,
        kind="canon.issue-target",
        source_id="node-embargo",
        target_id="issue-embargo-detail",
    )
    assert _matching(
        index.dependencies,
        kind="canon.issue-target",
        source_id="edge-opening-embargo",
        target_id="issue-opening-embargo-link",
    )


def test_geometry_only_changes_do_not_change_dependency_identity_or_evidence(
    aurora: ProjectDocument,
) -> None:
    moved_placements = [
        placement.model_copy(
            update={"x": placement.x + 100, "y": placement.y - 50}
        )
        for placement in aurora.placements
    ]
    moved = _rebuild(aurora, placements=moved_placements)
    projector = GraphCompositionCanonDependencyProjector()

    baseline = projector.project(aurora)
    changed = projector.project(moved)

    assert baseline.source_checksum != changed.source_checksum
    assert [item.model_dump(mode="json") for item in baseline.dependencies] == [
        item.model_dump(mode="json") for item in changed.dependencies
    ]
    assert all(
        evidence.field_path not in {"x", "y", "width", "height"}
        for dependency in baseline.dependencies
        for evidence in dependency.evidence
    )


def test_projection_does_not_reclassify_graph_semantics_as_canon_or_flow(
    aurora: ProjectDocument,
) -> None:
    index = GraphCompositionCanonDependencyProjector().project(aurora)
    canon_facts = CanonFactProjector().project(aurora).facts

    assert not any(
        item.domain in {"flow", "playback"}
        for item in index.dependencies
        if item.kind.startswith("graph.semantic-")
    )
    assert all(
        item.propagation == "contextual"
        for item in index.dependencies
        if item.kind.startswith("graph.semantic-")
    )
    assert any(item.code == "graph.relationship" for item in canon_facts)
