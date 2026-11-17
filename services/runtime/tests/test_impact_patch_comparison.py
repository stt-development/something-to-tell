from copy import deepcopy
from pathlib import Path
from typing import Callable

import pytest

from services.runtime.stt_runtime.impact import (
    ImpactDependencyChange,
    ImpactPatchComparator,
    ImpactPatchComparisonError,
    ImpactSelectionInspector,
    ProjectDependencyProjector,
)
from services.runtime.stt_runtime.project_document.patch import derive_project_patch
from services.runtime.stt_runtime.project_fixture import _fixture_document, load_project_fixture
from services.runtime.stt_runtime.schemas.project_document import (
    ProjectDocument,
    create_project_document,
)
from services.runtime.stt_runtime.schemas.impact_analysis import (
    ImpactSeed,
    SelectionImpactScenario,
)
from services.runtime.stt_runtime.schemas.canon_check import CanonOwnerRef
from services.runtime.stt_runtime.schemas.project_patch import ProjectPatch

FIXTURE = Path(__file__).parents[3] / "fixtures/projects/project-aurora.v1.json"
Mutation = Callable[[dict[str, object]], None]


@pytest.fixture(scope="module")
def aurora() -> ProjectDocument:
    return _fixture_document(load_project_fixture(FIXTURE))


def test_graph_patch_identifies_dependency_changes_and_affected_existing_issue(
    aurora: ProjectDocument,
) -> None:
    def change_graph(payload: dict[str, object]) -> None:
        edge = _record(payload, "edges", "edge-opening-embargo")
        edge["target_node_id"] = "node-route-consequence"

    result = _compare(aurora, change_graph)

    assert {change.change for change in result.dependency_changes if change.dependency.domain == "graph"} == {
        "added",
        "removed",
    }
    assert {seed.resource.owner_id for seed in result.seeds} >= {"edge-opening-embargo"}
    assert [item.owner_id for item in result.affected_existing_issues] == [
        "issue-opening-embargo-link"
    ]


@pytest.mark.parametrize(
    ("domain", "mutation", "expected_kind"),
    (
        (
            "flow",
            lambda payload: _record(
                payload,
                "flow_transitions",
                "flow-transition-opening-dialogue",
            ).update(target_node_id="node-inspection"),
            "flow.transition-reachability",
        ),
        (
            "dialogue",
            lambda payload: _dialogue_element(
                payload,
                "line-dockmaster-warning",
            ).update(next_element_id="choice-mara-response"),
            "dialogue.next-element",
        ),
        (
            "quest",
            lambda payload: _quest_branch(
                payload,
                "branch-present-ledger",
            ).update(target_stage_id=None),
            "quest.branch-reachability",
        ),
    ),
)
def test_executable_editor_patches_report_reachability_changes(
    aurora: ProjectDocument,
    domain: str,
    mutation: Mutation,
    expected_kind: str,
) -> None:
    result = _compare(aurora, mutation)

    assert any(
        change.dependency.domain == domain and change.dependency.kind == expected_kind
        for change in result.reachability_changes
    )


def test_temporal_patch_reports_exact_state_path_changes(
    aurora: ProjectDocument,
) -> None:
    def change_condition(payload: dict[str, object]) -> None:
        transition = _record(
            payload,
            "flow_transitions",
            "flow-transition-dialogue-inspection",
        )
        transition["condition"] = 'flags.unmapped_route == true'

    result = _compare(aurora, change_condition)

    changed_paths = {
        change.dependency.message_parameters.get("path")
        for change in result.state_path_changes
    }
    assert "items.node-sealed-ledger.holder.node_id" in changed_paths
    assert "flags.unmapped_route" in changed_paths


def test_patch_reports_introduced_and_resolved_deterministic_integrity_candidates(
    aurora: ProjectDocument,
) -> None:
    baseline = ImpactPatchComparator().compare(aurora, derive_project_patch(aurora, aurora))

    def remove_return_binding(payload: dict[str, object]) -> None:
        bindings = payload["flow_exit_bindings"]
        assert isinstance(bindings, list)
        payload["flow_exit_bindings"] = [
            item
            for item in bindings
            if item["id"] != "flow-binding-blockade-completed-main"
        ]

    introduced = _compare(aurora, remove_return_binding)
    target = _target(aurora, remove_return_binding)
    restored = ImpactPatchComparator().compare(
        target,
        derive_project_patch(target, aurora),
    )

    assert baseline.integrity_changes == ()
    assert any(
        change.change == "introduced"
        and change.candidate.rule_id == "flow.return-mapping"
        for change in introduced.integrity_changes
    )
    assert any(
        change.change == "resolved"
        and change.candidate.rule_id == "flow.return-mapping"
        for change in restored.integrity_changes
    )


def test_compound_patch_coalesces_changed_seeds_without_exposing_candidate_document(
    aurora: ProjectDocument,
) -> None:
    def change_multiple_domains(payload: dict[str, object]) -> None:
        _record(payload, "edges", "edge-opening-embargo")["label"] = "Reframes the embargo"
        _dialogue_element(payload, "line-dockmaster-warning")[
            "next_element_id"
        ] = "choice-mara-response"
        _quest_branch(payload, "branch-present-ledger")["target_stage_id"] = None

    source_payload = aurora.model_dump(mode="json")
    result = _compare(aurora, change_multiple_domains)

    assert {change.dependency.domain for change in result.dependency_changes} >= {
        "graph",
        "dialogue",
        "quest",
    }
    assert {seed.resource.owner_id for seed in result.seeds} >= {
        "edge-opening-embargo",
        "node-dock-dialogue",
        "node-smuggler-route",
    }
    assert not hasattr(result, "document")
    assert aurora.model_dump(mode="json") == source_payload
    assert aurora.checksum == result.source_checksum


def test_noop_patch_is_empty_stable_and_input_immutable(aurora: ProjectDocument) -> None:
    source_payload = aurora.model_dump(mode="json")
    patch = derive_project_patch(aurora, aurora)
    comparator = ImpactPatchComparator()

    first = comparator.compare(aurora, patch)
    repeated = comparator.compare(aurora, patch)

    assert first == repeated
    assert first.no_op is True
    assert first.source_checksum == first.target_checksum == aurora.checksum
    assert aurora.model_dump(mode="json") == source_payload


def test_selection_modify_invents_no_field_delta_while_delete_checks_absence(
    aurora: ProjectDocument,
) -> None:
    index = ProjectDependencyProjector().project(aurora)
    seed = ImpactSeed(resource=CanonOwnerRef(owner_type="node", owner_id="node-hero"))
    inspector = ImpactSelectionInspector()

    modify = inspector.inspect(
        index,
        SelectionImpactScenario(intent="modify", seeds=(seed,)),
        domains=("graph", "composition", "flow"),
    )
    delete = inspector.inspect(
        index,
        SelectionImpactScenario(intent="delete", seeds=(seed,)),
        domains=("graph", "composition", "flow"),
    )

    assert modify.field_level_change_known is False
    assert modify.structural_absences == ()
    assert delete.field_level_change_known is False
    assert delete.structural_absences
    assert all(item.source == seed.resource for item in delete.structural_absences)
    assert all(item.propagation == "required" for item in delete.structural_absences)


def test_delta_models_reject_inconsistent_before_after_boundaries(
    aurora: ProjectDocument,
) -> None:
    dependency = ProjectDependencyProjector().project(aurora).dependencies[0]

    with pytest.raises(ValueError, match="inconsistent boundaries"):
        ImpactDependencyChange("added", before=dependency)


def test_stale_and_invalid_patches_return_typed_errors_without_mutation(
    aurora: ProjectDocument,
) -> None:
    source_payload = aurora.model_dump(mode="json")
    valid = derive_project_patch(
        aurora,
        _target(aurora, lambda payload: _record(payload, "nodes", "node-hero").update(title="Mara")),
    )
    stale = valid.model_copy(update={"source_checksum": "f" * 64})
    invalid = ProjectPatch.model_validate(
        {
            "patch_id": "project-patch-invalid-impact",
            "project_id": aurora.manifest.project_id,
            "source_checksum": aurora.checksum,
            "target_checksum": "e" * 64,
            "operations": [
                {
                    "op": "remove_record",
                    "collection": "nodes",
                    "record_id": "missing-node",
                }
            ],
        }
    )

    with pytest.raises(ImpactPatchComparisonError) as stale_error:
        ImpactPatchComparator().compare(aurora, stale)
    with pytest.raises(ImpactPatchComparisonError) as invalid_error:
        ImpactPatchComparator().compare(aurora, invalid)

    assert stale_error.value.code == "impact_patch_stale"
    assert invalid_error.value.code == "impact_patch_invalid"
    assert aurora.model_dump(mode="json") == source_payload
    assert aurora.checksum == source_payload["checksum"]


def _compare(document: ProjectDocument, mutation: Mutation):
    target = _target(document, mutation)
    patch = derive_project_patch(document, target)
    result = ImpactPatchComparator().compare(document, patch)
    assert result.target_checksum == target.checksum
    return result


def _target(document: ProjectDocument, mutation: Mutation) -> ProjectDocument:
    payload = deepcopy(document.model_dump(mode="python", exclude={"checksum"}))
    mutation(payload)
    return create_project_document(**payload)


def _record(payload: dict[str, object], collection: str, record_id: str) -> dict[str, object]:
    records = payload[collection]
    assert isinstance(records, list)
    key = "node_id" if collection in {"dialogues", "quests"} else "id"
    return next(item for item in records if item[key] == record_id)


def _dialogue_element(payload: dict[str, object], element_id: str) -> dict[str, object]:
    dialogue = _record(payload, "dialogues", "node-dock-dialogue")
    return next(item for item in dialogue["document"]["elements"] if item["id"] == element_id)


def _quest_branch(payload: dict[str, object], branch_id: str) -> dict[str, object]:
    quest = _record(payload, "quests", "node-smuggler-route")
    return next(
        branch
        for stage in quest["document"]["stages"]
        for branch in stage["branches"]
        if branch["id"] == branch_id
    )
