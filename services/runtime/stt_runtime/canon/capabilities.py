"""Checksum-bound Canon repair capability projection defined by ADR 0018."""

from __future__ import annotations

from ..schemas.canon_check import (
    CanonIssueMetadataV1,
    CanonIssueMetadataV2,
    CanonRepairCapability,
)
from ..schemas.project_document import ProjectDocument
from .diagnostics import KNOWN_DIAGNOSTICS
from .fixers import CanonFixerRegistry

_AGENT_REVIEW_RULES = frozenset({
    "condition.unresolved-path",
    "flow.return-mapping",
    "outcome.required-reachability",
    "outcome.specialized-ownership",
    "ownership.custody-disagreement",
    "relationship.exclusive-conflict",
})


def project_repair_capability(
    metadata: CanonIssueMetadataV1,
    document: ProjectDocument,
    *,
    active: bool,
) -> CanonRepairCapability:
    """Recalculate one capability from current owners, fixers, and checksum."""

    checksum = document.checksum
    if not active:
        return _unavailable("none", checksum, "canon.repair.unavailable.issue_inactive")
    if CanonFixerRegistry().propose(metadata, document) is not None:
        return CanonRepairCapability(
            kind="deterministic_patch",
            action="request_fix",
            available=True,
            source_checksum=checksum,
        )
    if _agent_review_eligible(metadata):
        return CanonRepairCapability(
            kind="agent_review",
            action="explore_solutions",
            available=True,
            source_checksum=checksum,
        )
    if any(_owner_exists(document, target.owner_type, target.owner_id) for target in metadata.targets):
        return CanonRepairCapability(
            kind="navigate_only",
            action="open_source",
            available=True,
            source_checksum=checksum,
        )
    return _unavailable("none", checksum, "canon.repair.unavailable.owner_missing")


def _agent_review_eligible(metadata: CanonIssueMetadataV1) -> bool:
    if metadata.rule_id in _AGENT_REVIEW_RULES:
        return True
    return (
        isinstance(metadata, CanonIssueMetadataV2)
        and metadata.rule_id == "integrity.error-fact"
        and metadata.diagnostic.fact_code in KNOWN_DIAGNOSTICS
    )


def _unavailable(kind: str, checksum: str, reason: str) -> CanonRepairCapability:
    actions = {
        "agent_review": "explore_solutions",
        "none": "none",
    }
    return CanonRepairCapability(
        kind=kind,
        action=actions[kind],
        available=False,
        unavailable_reason=reason,
        source_checksum=checksum,
    )


def _owner_exists(document: ProjectDocument, owner_type: str, owner_id: str) -> bool:
    """Resolve stable owner ids without relying on browser projection state."""

    direct = {
        "project": {document.manifest.project_id},
        "node": {item.id for item in document.nodes},
        "edge": {item.id for item in document.edges},
        "placement": {item.id for item in document.placements},
        "flow": {item.id for item in document.story_flows},
        "flow_transition": {item.id for item in document.flow_transitions},
        "flow_invocation": {item.id for item in document.flow_invocations},
        "flow_exit": {item.id for item in document.flow_exits},
        "flow_exit_binding": {item.id for item in document.flow_exit_bindings},
        "scene_boundary": {item.id for item in document.scene_flow_boundaries},
        "initial_state": {item.id for item in document.flow_initial_states},
        "effect": {item.id for item in document.narrative_effects},
        "effect_binding": {item.id for item in document.narrative_effect_bindings},
    }
    if owner_type in direct:
        return owner_id in direct[owner_type]
    if owner_type == "dialogue_element":
        return any(owner_id == item.id for owned in document.dialogues for item in owned.document.elements)
    if owner_type == "dialogue_option":
        return any(
            owner_id == option.id
            for owned in document.dialogues
            for element in owned.document.elements
            for option in getattr(element, "options", ())
        )
    if owner_type == "quest_stage":
        return any(owner_id == stage.id for owned in document.quests for stage in owned.document.stages)
    # Quest outcomes use their owning branch id throughout state and playback contracts.
    if owner_type in {"quest_branch", "quest_outcome"}:
        return any(
            owner_id == branch.id
            for owned in document.quests
            for stage in owned.document.stages
            for branch in stage.branches
        )
    return False
