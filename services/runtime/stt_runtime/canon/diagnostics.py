"""Safe presentation registry for concrete domain integrity facts (ADR 0018)."""

from __future__ import annotations

from dataclasses import dataclass
import re

from ..schemas.canon_check import (
    CanonDiagnosticV1,
    CanonEvidenceRef,
    CanonFact,
    CanonOwnerRef,
)

_SECRET_KEY = re.compile(
    r"(?:api[_-]?key|authorization|bearer|credential|password|secret|token)",
    re.IGNORECASE,
)
_SECRET_VALUE = re.compile(
    r"(?:sk-(?:ant-)?[A-Za-z0-9_-]{12,}|Bearer\s+\S+|postgres(?:ql)?://[^\s]+)",
    re.IGNORECASE,
)
_SAFE_ENUM_VALUE = re.compile(r"^[a-z][a-z0-9]*(?:[._-][a-z0-9]+)*$")
_ENUM_PARAMETER_KEYS = frozenset({
    "holder_kind",
    "node_type",
    "operation",
    "reason",
    "relationship_type",
    "repeat_policy",
})
_SAFE_PARAMETER_KEYS = frozenset({
    "reference_id",
    "root_flow_id",
    "scene_node_id",
    "item_node_id",
    "holder_kind",
    "holder_node_id",
    "reason",
    "relationship_type",
    "node_type",
    "operation",
    "repeat_policy",
})


@dataclass(frozen=True, slots=True)
class CanonDiagnosticPresentation:
    """Stable localization and safe-parameter policy for one known fact code."""

    problem_key: str
    recommendation_key: str
    field_path: str
    parameter_keys: frozenset[str] = _SAFE_PARAMETER_KEYS
    identity_parameter_keys: frozenset[str] = _SAFE_PARAMETER_KEYS


def _presentation(
    code: str,
    recommendation: str,
    field_path: str,
) -> CanonDiagnosticPresentation:
    return CanonDiagnosticPresentation(
        problem_key=f"canon.fact.{code}",
        recommendation_key=f"canon.issue.integrity.recommendation.{recommendation}",
        field_path=field_path,
    )


# This allowlist is runtime-owned. A code absent here receives the safe unknown
# fallback and no arbitrary domain parameters cross the Issue boundary.
KNOWN_DIAGNOSTICS: dict[str, CanonDiagnosticPresentation] = {
    "graph.dangling_relationship_endpoint": _presentation("graph.dangling_relationship_endpoint", "graph", "source_node_id/target_node_id"),
    "composition.dangling_placement": _presentation("composition.dangling_placement", "composition", "canonical_node_id/container_node_id"),
    "composition.missing_canonical_node": _presentation("composition.missing_canonical_node", "composition", "canonical_node_id"),
    "composition.invalid_child_kind": _presentation("composition.invalid_child_kind", "composition", "container_node_id"),
    "composition.duplicate_placement": _presentation("composition.duplicate_placement", "composition", "scope_key"),
    "composition.containment_cycle": _presentation("composition.containment_cycle", "composition", "container_node_id"),
    "composition.stale_membership": _presentation("composition.stale_membership", "composition", "container_node_id"),
    "flow.missing_entry": _presentation("flow.missing_entry", "flow", "entry_node_id"),
    "flow.invalid_entry": _presentation("flow.invalid_entry", "flow", "entry_node_id"),
    "flow.unreachable_member": _presentation("flow.unreachable_member", "flow", "node_id"),
    "flow.dangling_transition_endpoint": _presentation("flow.dangling_transition_endpoint", "flow", "source_node_id/target_node_id"),
    "flow.duplicate_membership": _presentation("flow.duplicate_membership", "flow", "node_id"),
    "flow.duplicate_transition_priority": _presentation("flow.duplicate_transition_priority", "flow", "priority"),
    "flow.multiple_default_branches": _presentation("flow.multiple_default_branches", "flow", "is_default"),
    "flow.conditioned_default_branch": _presentation("flow.conditioned_default_branch", "flow", "condition"),
    "flow.branch_without_condition": _presentation("flow.branch_without_condition", "flow", "condition"),
    "flow.invalid_scene_boundary": _presentation("flow.invalid_scene_boundary", "flow", "scene_node_id"),
    "flow.cycle": _presentation("flow.cycle", "flow", "source_node_id/target_node_id"),
    "flow.no_ending": _presentation("flow.no_ending", "flow", "transitions"),
    "flow.cross_project_reference": _presentation("flow.cross_project_reference", "flow", "project_id"),
    "flow.composable_flow_deleted_reference": _presentation("flow.composable_flow_deleted_reference", "flow", "referenced_id"),
    "flow.composable_flow_missing_entry": _presentation("flow.composable_flow_missing_entry", "flow", "entry_node_id"),
    "flow.composable_flow_unbound_exit": _presentation("flow.composable_flow_unbound_exit", "flow", "exit_id"),
    "flow.composable_flow_unreachable_exit": _presentation("flow.composable_flow_unreachable_exit", "flow", "source_node_id"),
    "flow.composable_flow_ambiguous_routes": _presentation("flow.composable_flow_ambiguous_routes", "flow", "priority"),
    "flow.composable_flow_call_cycle": _presentation("flow.composable_flow_call_cycle", "flow", "target_flow_id"),
    "flow.composable_flow_called_without_reachable_exit": _presentation("flow.composable_flow_called_without_reachable_exit", "flow", "exits"),
    "dialogue.missing_participant": _presentation("dialogue.missing_participant", "dialogue", "participants"),
    "dialogue.broken_reference": _presentation("dialogue.broken_reference", "dialogue", "next_element_id/participant_id"),
    "dialogue.unreachable_element": _presentation("dialogue.unreachable_element", "dialogue", "entry_element_id"),
    "dialogue.dead_end": _presentation("dialogue.dead_end", "dialogue", "next_element_id"),
    "dialogue.stale_external_transition_origin": _presentation("dialogue.stale_external_transition_origin", "dialogue", "source_element_id"),
    "quest.broken_branch_target": _presentation("quest.broken_branch_target", "quest", "target_stage_id"),
    "temporal.narrative_state_unbound_effect": _presentation("temporal.narrative_state_unbound_effect", "temporal", "effect_id"),
    "temporal.narrative_state_transfer_item_uninitialized": _presentation("temporal.narrative_state_transfer_item_uninitialized", "temporal", "item_node_id"),
    "playback.invalid-definition": _presentation("playback.invalid-definition", "playback", "definition"),
    "playback.empty_flow": _presentation("playback.empty_flow", "playback", "members"),
    "playback.invalid_definition": _presentation("playback.invalid_definition", "playback", "definition"),
    "playback.missing_entry": _presentation("playback.missing_entry", "playback", "entry_node_id"),
    "playback.invalid_entry": _presentation("playback.invalid_entry", "playback", "entry_node_id"),
    "playback.missing_member": _presentation("playback.missing_member", "playback", "node_id"),
    "playback.dangling_source": _presentation("playback.dangling_source", "playback", "source_node_id"),
    "playback.stale_ownership": _presentation("playback.stale_ownership", "playback", "project_id"),
    "playback.duplicate_effect_id": _presentation("playback.duplicate_effect_id", "playback", "effect_id"),
    "playback.unsupported_version": _presentation("playback.unsupported_version", "playback", "version"),
    "playback.malformed_condition": _presentation("playback.malformed_condition", "playback", "condition"),
    "playback.unknown_condition_path": _presentation("playback.unknown_condition_path", "playback", "condition"),
    "playback.no_eligible_transition": _presentation("playback.no_eligible_transition", "playback", "transitions"),
    "playback.multiple_unconditional_transitions": _presentation("playback.multiple_unconditional_transitions", "playback", "condition"),
    "playback.missing_default_branch": _presentation("playback.missing_default_branch", "playback", "is_default"),
    "playback.malformed_effect": _presentation("playback.malformed_effect", "playback", "payload"),
    "playback.conflicting_effects": _presentation("playback.conflicting_effects", "playback", "payload"),
    "playback.repeated_effect": _presentation("playback.repeated_effect", "playback", "repeat_policy"),
    "playback.stale_item_holder": _presentation("playback.stale_item_holder", "playback", "holder_node_id"),
    "playback.stale_source_revision": _presentation("playback.stale_source_revision", "playback", "source_revision"),
    "playback.missing_exit_binding": _presentation("playback.missing_exit_binding", "playback", "exit_id"),
}


def normalize_integrity_fact(
    fact: CanonFact,
) -> tuple[CanonDiagnosticV1, str, dict[str, object], str, dict[str, object]]:
    """Return a concrete diagnostic and localization data without domain prose."""

    targets = fact.owners or (fact.scope,)
    evidence = tuple(_safe_evidence(item) for item in fact.evidence)
    presentation = KNOWN_DIAGNOSTICS.get(fact.code)
    safe = _safe_parameters(
        fact.parameters,
        presentation.parameter_keys if presentation else frozenset(),
    )
    identity = {
        key: value
        for key, value in safe.items()
        if presentation and key in presentation.identity_parameter_keys
    }
    owner = _smallest_owner(targets)
    field_path = (
        presentation.field_path
        if presentation
        else next((item.field_path for item in evidence if item.field_path), "record")
    )
    common: dict[str, object] = {
        "fact_code": fact.code,
        "domain": fact.domain,
        "owner_type": owner.owner_type,
        "owner_id": owner.owner_id,
        "field_path": field_path,
        **safe,
    }
    if presentation is None:
        message_key = "canon.issue.integrity.unknown.message"
        recommendation_key = "canon.issue.integrity.recommendation.unknown"
    else:
        message_key = "canon.issue.integrity.known.message"
        recommendation_key = presentation.recommendation_key
        common["problem_key"] = presentation.problem_key
    diagnostic = CanonDiagnosticV1(
        fact_code=fact.code,
        domain=fact.domain,
        parameters=safe,
        identity_parameters=identity,
        targets=targets,
        evidence=evidence,
    )
    return diagnostic, message_key, common, recommendation_key, common


def _safe_parameters(
    parameters: dict[str, object],
    allowed: frozenset[str],
) -> dict[str, str | int | float | bool]:
    safe: dict[str, str | int | float | bool] = {}
    for key in sorted(set(parameters) & allowed):
        value = parameters[key]
        if _SECRET_KEY.search(key) or isinstance(value, (list, dict, tuple, set)):
            continue
        if isinstance(value, str):
            if len(value) > 512 or _SECRET_VALUE.search(value):
                continue
            if key in _ENUM_PARAMETER_KEYS and _SAFE_ENUM_VALUE.fullmatch(value) is None:
                continue
            safe[key] = value
        elif isinstance(value, bool | int | float):
            safe[key] = value
    return safe


def _safe_evidence(evidence: CanonEvidenceRef) -> CanonEvidenceRef:
    """Keep the exact pointer while dropping legacy free-form report messages."""

    return CanonEvidenceRef(
        owner=evidence.owner,
        field_path=evidence.field_path,
        message_key="canon.evidence.integrity-fact",
        message_parameters={},
        excerpt=None,
    )


def _smallest_owner(owners: tuple[CanonOwnerRef, ...]) -> CanonOwnerRef:
    priority = {
        "dialogue_option": 0,
        "dialogue_element": 1,
        "quest_branch": 2,
        "quest_stage": 3,
        "flow_transition": 4,
        "flow_exit_binding": 5,
        "flow_exit": 6,
        "flow_invocation": 7,
        "effect_binding": 8,
        "effect": 9,
        "placement": 10,
        "edge": 11,
        "node": 12,
        "flow": 13,
        "project": 14,
    }
    return min(owners, key=lambda owner: (priority.get(owner.owner_type, 50), owner.stable_key()))
