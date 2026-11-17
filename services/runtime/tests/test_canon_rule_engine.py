from copy import deepcopy
from pathlib import Path
from time import perf_counter

import pytest

from services.runtime.stt_runtime.canon.engine import (
    CanonRuleEngine,
    CanonRuleEngineError,
)
from services.runtime.stt_runtime.canon.projection import CanonFactProjector
from services.runtime.stt_runtime.project_fixture import import_project_fixture
from services.runtime.stt_runtime.project_format.manifest import CanonCheckSettings
from services.runtime.stt_runtime.project_session.service import ProjectSessionRegistry
from services.runtime.stt_runtime.schemas.canon_check import CanonCheckInput, CanonFact
from services.runtime.stt_runtime.schemas.project_document import (
    ProjectDocument,
    project_document_checksum,
)

FIXTURE = Path(__file__).parents[3] / "fixtures" / "projects" / "project-aurora.v1.json"


@pytest.fixture
def aurora_input(tmp_path: Path) -> CanonCheckInput:
    """Capture the real saved fixture so rule tests use the production boundary."""

    project_path = tmp_path / "ProjectAurora.narrative"
    import_project_fixture(FIXTURE, project_path)
    registry = ProjectSessionRegistry()
    opened = registry.open(project_path)
    try:
        return registry.capture_canon_input(opened.session.session_id)
    finally:
        registry.close(opened.session.session_id)


def test_initial_pack_is_ordered_deterministic_and_actionable(
    aurora_input: CanonCheckInput,
) -> None:
    engine = CanonRuleEngine()

    first = engine.evaluate(aurora_input)
    second = engine.evaluate(aurora_input)

    assert first == second
    assert [candidate.rule_id for candidate in first] == sorted(
        candidate.rule_id for candidate in first
    )
    assert {candidate.rule_id for candidate in first} == {
        "condition.unresolved-path",
        "integrity.error-fact",
        "outcome.required-reachability",
        "ownership.custody-disagreement",
    }
    assert all(
        candidate.targets
        and candidate.evidence
        and candidate.recommendation_key
        and candidate.message_key
        for candidate in first
    )


def test_rule_enablement_and_severity_do_not_change_fingerprints(
    aurora_input: CanonCheckInput,
) -> None:
    engine = CanonRuleEngine()
    baseline = engine.evaluate(aurora_input)
    changed = engine.evaluate(
        aurora_input,
        settings=CanonCheckSettings(
            enabled_rules={"condition.unresolved-path": False},
            severity_overrides={"integrity.error-fact": "warning"},
        ),
    )

    assert not any(item.rule_id == "condition.unresolved-path" for item in changed)
    baseline_error = next(item for item in baseline if item.rule_id == "integrity.error-fact")
    changed_error = next(item for item in changed if item.rule_id == "integrity.error-fact")
    assert baseline_error.severity == "critical"
    assert changed_error.severity == "warning"
    assert baseline_error.fingerprint == changed_error.fingerprint
    assert CanonRuleEngine().evaluate(
        aurora_input,
        settings=CanonCheckSettings(deterministic_enabled=False),
    ) == ()


def test_relationship_rule_finds_incompatible_pairs_and_exclusive_owners(
    aurora_input: CanonCheckInput,
) -> None:
    payload = aurora_input.document.model_dump(mode="json")
    template = deepcopy(payload["edges"][0])
    payload["edges"].extend(
        [
            {
                **template,
                "id": "edge-aa-allied",
                "source_node_id": "node-hero",
                "target_node_id": "node-dockmaster",
                "type": "allied_with",
                "label": "allied",
            },
            {
                **template,
                "id": "edge-ab-opposes",
                "source_node_id": "node-dockmaster",
                "target_node_id": "node-hero",
                "type": "opposes",
                "label": "opposes",
            },
            {
                **template,
                "id": "edge-ac-hero-ledger",
                "source_node_id": "node-hero",
                "target_node_id": "node-sealed-ledger",
                "type": "owns",
                "label": "owns",
            },
        ]
    )
    check_input = _reproject(aurora_input, payload)

    conflicts = [
        item
        for item in CanonRuleEngine().evaluate(check_input)
        if item.rule_id == "relationship.exclusive-conflict"
    ]

    assert {item.message_parameters["reason"] for item in conflicts} == {
        "incompatible_pair",
        "multiple_semantic_owners",
    }
    assert all(len(item.evidence) >= 2 for item in conflicts)


def test_specialized_outcomes_and_return_mappings_have_exact_owners(
    aurora_input: CanonCheckInput,
) -> None:
    baseline = CanonRuleEngine().evaluate(aurora_input)
    missing_route = next(
        item for item in baseline if item.rule_id == "outcome.required-reachability"
    )
    assert missing_route.scope.owner_type == "quest_branch"
    assert missing_route.scope.owner_id == "branch-legal-route"
    assert missing_route.message_parameters["edge_id"] == "edge-quest-legal-route"

    payload = aurora_input.document.model_dump(mode="json")
    pointer_edge = next(
        edge for edge in payload["edges"] if edge["id"] == "edge-dialogue-blockade"
    )
    pointer_edge["metadata"]["outcome_flow_composition"]["invocation_id"] = "missing-call"
    direct_route = next(
        route
        for route in payload["flow_transitions"]
        if route["id"] == "flow-transition-quest-blockade"
    )
    direct_route["metadata"]["quest_branch_id"] = "stale-branch"
    payload["flow_exit_bindings"] = [
        binding
        for binding in payload["flow_exit_bindings"]
        if binding["id"] != "flow-binding-blockade-completed-main"
    ]
    candidates = CanonRuleEngine().evaluate(_reproject(aurora_input, payload))

    stale = {
        item.scope.owner_id: item
        for item in candidates
        if item.rule_id == "outcome.specialized-ownership"
    }
    missing_return = next(item for item in candidates if item.rule_id == "flow.return-mapping")
    assert stale["edge-dialogue-blockade"].message_parameters["reason"] == (
        "stale_composition_pointer"
    )
    assert stale["edge-quest-blockade-route"].message_parameters["reason"] == (
        "stale_direct_route_owner"
    )
    assert missing_return.message_parameters == {
        "invocation_id": "flow-invocation-dialogue-smuggler-route",
        "exit_id": "flow-exit-blockade-completed",
    }


def test_conditions_use_declared_state_without_rejecting_valid_false_paths(
    aurora_input: CanonCheckInput,
) -> None:
    candidates = CanonRuleEngine().evaluate(aurora_input)
    unresolved = {
        (item.scope.owner_type, item.scope.owner_id): item.message_parameters
        for item in candidates
        if item.rule_id == "condition.unresolved-path"
    }

    assert unresolved == {
        ("quest_branch", "branch-legal-route"): {
            "condition": "ledger_verified",
            "diagnostic_code": "malformed_condition",
        },
        ("quest_branch", "branch-present-ledger"): {
            "condition": "ledger_acquired",
            "diagnostic_code": "malformed_condition",
        },
    }
    # This authored path resolves against initial custody even when its value is false.
    assert ("flow_transition", "flow-transition-dialogue-inspection") not in unresolved
    assert ("dialogue_option", "answer-show-ledger") not in unresolved


def test_valid_cycles_and_separate_semantic_temporal_records_are_not_generic_errors(
    aurora_input: CanonCheckInput,
) -> None:
    candidates = CanonRuleEngine().evaluate(aurora_input)

    assert not any(
        item.message_parameters.get("fact_code") in {"flow.cycle", "dialogue.valid-cycle"}
        for item in candidates
    )
    custody = [
        item
        for item in candidates
        if item.rule_id == "ownership.custody-disagreement"
    ]
    assert len(custody) == 2
    assert all(item.severity == "warning" for item in custody)
    assert all("semantic_holder_node_id" in item.message_parameters for item in custody)


def test_engine_rejects_an_unknown_pack_version(aurora_input: CanonCheckInput) -> None:
    incompatible = aurora_input.model_copy(update={"rule_pack_version": 99})

    with pytest.raises(CanonRuleEngineError) as caught:
        CanonRuleEngine().evaluate(incompatible)

    assert caught.value.code == "canon_rule_pack_version_unsupported"


def test_error_fact_rule_scales_linearly_for_large_saved_inputs(
    aurora_input: CanonCheckInput,
) -> None:
    template = next(fact for fact in aurora_input.facts if fact.level == "error")
    generated = tuple(
        CanonFact.model_validate(
            {
                **template.model_dump(mode="json"),
                "scope": {"owner_type": "node", "owner_id": f"bulk-{index}"},
                "owners": [{"owner_type": "node", "owner_id": f"bulk-{index}"}],
                "evidence": [
                    {
                        **template.evidence[0].model_dump(mode="json"),
                        "owner": {"owner_type": "node", "owner_id": f"bulk-{index}"},
                    }
                ],
            }
        )
        for index in range(1_000)
    )
    check_input = CanonCheckInput.model_validate(
        {
            **aurora_input.model_dump(mode="json"),
            "facts": [*(fact.model_dump(mode="json") for fact in aurora_input.facts),
                      *(fact.model_dump(mode="json") for fact in generated)],
        }
    )

    started = perf_counter()
    candidates = CanonRuleEngine().evaluate(check_input)
    duration = perf_counter() - started

    assert sum(item.rule_id == "integrity.error-fact" for item in candidates) == 1_001
    assert duration < 2.0


def _reproject(
    original: CanonCheckInput,
    payload: dict[str, object],
) -> CanonCheckInput:
    """Recompute the complete document checksum after a focused authored mutation."""

    payload["edges"] = sorted(payload["edges"], key=lambda item: item["id"])
    payload["flow_exit_bindings"] = sorted(
        payload["flow_exit_bindings"], key=lambda item: item["id"]
    )
    payload["checksum"] = "0" * 64
    unchecked = ProjectDocument.model_validate(payload, context={"skip_checksum": True})
    payload["checksum"] = project_document_checksum(unchecked)
    document = ProjectDocument.model_validate(payload)
    return CanonFactProjector().project(
        document,
        rule_pack_version=original.rule_pack_version,
    )
