from __future__ import annotations

from copy import deepcopy

import pytest

from services.runtime.stt_runtime.canon.diagnostics import normalize_integrity_fact
from services.runtime.stt_runtime.schemas.canon_check import (
    CanonEvidenceRef,
    CanonFact,
    CanonOwnerRef,
    canon_issue_fingerprint,
)


def _fact(
    domain: str,
    code: str,
    *,
    parameters: dict[str, object] | None = None,
    excerpt: str = "Legacy domain exception text",
) -> CanonFact:
    owner = CanonOwnerRef(owner_type=f"{domain}_record", owner_id="record-1")
    return CanonFact(
        code=code,
        domain=domain,
        level="error",
        scope=owner,
        owners=(owner,),
        evidence=(
            CanonEvidenceRef(
                owner=owner,
                field_path="target_id",
                message_key="legacy.integrity.message",
                message_parameters={},
                excerpt=excerpt,
            ),
        ),
        parameters=parameters or {},
        source_revision=1,
    )


@pytest.mark.parametrize(
    ("domain", "code", "recommendation", "field_path"),
    [
        ("graph", "graph.dangling_relationship_endpoint", "graph", "source_node_id/target_node_id"),
        ("composition", "composition.dangling_placement", "composition", "canonical_node_id/container_node_id"),
        ("flow", "flow.dangling_transition_endpoint", "flow", "source_node_id/target_node_id"),
        ("dialogue", "dialogue.broken_reference", "dialogue", "next_element_id/participant_id"),
        ("quest", "quest.broken_branch_target", "quest", "target_stage_id"),
        ("temporal", "temporal.narrative_state_unbound_effect", "temporal", "effect_id"),
        ("playback", "playback.missing_member", "playback", "node_id"),
    ],
)
def test_known_domain_diagnostics_have_specific_localization_and_exact_owners(
    domain: str,
    code: str,
    recommendation: str,
    field_path: str,
) -> None:
    diagnostic, message_key, parameters, recommendation_key, _ = (
        normalize_integrity_fact(_fact(domain, code))
    )

    assert diagnostic.fact_code == code
    assert diagnostic.domain == domain
    assert diagnostic.targets == (
        CanonOwnerRef(owner_type=f"{domain}_record", owner_id="record-1"),
    )
    assert message_key == "canon.issue.integrity.known.message"
    assert parameters["problem_key"] == f"canon.fact.{code}"
    assert parameters["field_path"] == field_path
    assert recommendation_key == f"canon.issue.integrity.recommendation.{recommendation}"


def test_unknown_diagnostic_keeps_stable_identity_but_drops_arbitrary_prose() -> None:
    fact = _fact(
        "dialogue",
        "dialogue.future_failure",
        parameters={"future_payload": {"raw": "unsafe"}, "exception": "trace"},
        excerpt="Traceback: private implementation detail",
    )

    diagnostic, message_key, parameters, recommendation_key, _ = (
        normalize_integrity_fact(fact)
    )

    assert message_key == "canon.issue.integrity.unknown.message"
    assert recommendation_key == "canon.issue.integrity.recommendation.unknown"
    assert parameters["fact_code"] == "dialogue.future_failure"
    assert parameters["owner_id"] == "record-1"
    assert diagnostic.parameters == {}
    assert diagnostic.identity_parameters == {}
    assert diagnostic.evidence[0].excerpt is None
    assert diagnostic.evidence[0].message_key == "canon.evidence.integrity-fact"


def test_known_diagnostic_preserves_only_bounded_parameterized_identity() -> None:
    source = {
        "reference_id": "missing-line",
        "reason": "missing_target",
        "api_key": "must-not-cross-boundary",
        "holder_node_id": "Bearer hidden-value",
        "operation": ["nested", "payload"],
    }
    before = deepcopy(source)

    diagnostic, _, parameters, _, recommendation_parameters = (
        normalize_integrity_fact(
            _fact("dialogue", "dialogue.broken_reference", parameters=source)
        )
    )

    assert source == before
    assert diagnostic.parameters == {
        "reason": "missing_target",
        "reference_id": "missing-line",
    }
    assert diagnostic.identity_parameters == diagnostic.parameters
    assert "must-not-cross-boundary" not in repr(parameters)
    assert "hidden-value" not in repr(recommendation_parameters)


def test_diagnostic_drops_free_form_reason_even_for_a_known_fact() -> None:
    diagnostic, *_ = normalize_integrity_fact(
        _fact(
            "playback",
            "playback.invalid_definition",
            parameters={"reason": "Traceback from provider request"},
        )
    )

    assert diagnostic.parameters == {}


def test_diagnostic_identity_changes_fingerprint_without_using_display_prose() -> None:
    first, *_ = normalize_integrity_fact(
        _fact("dialogue", "dialogue.broken_reference", parameters={"reference_id": "a"})
    )
    second, *_ = normalize_integrity_fact(
        _fact("dialogue", "dialogue.broken_reference", parameters={"reference_id": "b"})
    )
    owner = CanonOwnerRef(owner_type="dialogue_element", owner_id="line-1")

    first_fingerprint = canon_issue_fingerprint(
        rule_id="integrity.error-fact",
        rule_version=1,
        scope=owner,
        targets=(owner,),
        diagnostic=first,
    )
    second_fingerprint = canon_issue_fingerprint(
        rule_id="integrity.error-fact",
        rule_version=1,
        scope=owner,
        targets=(owner,),
        diagnostic=second,
    )

    assert first_fingerprint != second_fingerprint
    assert len(first_fingerprint) == len(second_fingerprint) == 64
