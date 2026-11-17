from datetime import UTC, datetime
from pathlib import Path

import pytest
from pydantic import ValidationError

from services.runtime.stt_runtime.canon.capabilities import project_repair_capability
from services.runtime.stt_runtime.canon.engine import CanonRuleEngine
from services.runtime.stt_runtime.canon.projection import CanonFactProjector
from services.runtime.stt_runtime.project_fixture import import_project_fixture
from services.runtime.stt_runtime.schemas.canon_check import (
    CanonDiagnosticV1,
    CanonEvidenceRef,
    CanonIssueCandidate,
    CanonIssueMetadataV1,
    CanonIssueMetadataV2,
    CanonOwnerRef,
    CanonRepairCapability,
)

FIXTURE = Path(__file__).parents[3] / "fixtures" / "projects" / "project-aurora.v1.json"
NOW = datetime(2026, 9, 2, tzinfo=UTC)


def _metadata(candidate: CanonIssueCandidate, checksum: str) -> CanonIssueMetadataV1:
    return CanonIssueMetadataV1(
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
        saved_revision=1,
        source_checksum=checksum,
        first_seen_at=NOW,
        last_seen_at=NOW,
    )


def test_projects_available_deterministic_fixer_from_current_document(tmp_path: Path) -> None:
    document = import_project_fixture(FIXTURE, tmp_path / "Fixable.narrative").document
    candidates = CanonRuleEngine().evaluate(CanonFactProjector().project(document))
    candidate = next(
        item
        for item in candidates
        if item.rule_id == "condition.unresolved-path"
        and isinstance(item.message_parameters.get("condition"), str)
    )

    capability = project_repair_capability(
        _metadata(candidate, document.checksum),
        document,
        active=True,
    )

    assert capability.kind == "deterministic_patch"
    assert capability.action == "request_fix"
    assert capability.available is True
    assert capability.source_checksum == document.checksum


def test_projects_pending_agent_navigation_and_missing_owner_states(tmp_path: Path) -> None:
    document = import_project_fixture(FIXTURE, tmp_path / "Capabilities.narrative").document
    owner = CanonOwnerRef(owner_type="node", owner_id=document.nodes[0].id)
    evidence = CanonEvidenceRef(owner=owner, message_key="canon.evidence.integrity-fact")
    base = CanonIssueMetadataV1(
        origin="canon_rule",
        rule_id="ownership.custody-disagreement",
        rule_version=1,
        fingerprint="a" * 64,
        category="continuity",
        scope=owner,
        message_key="canon.issue.ownership.custody-disagreement.message",
        targets=[owner],
        evidence=[evidence],
        saved_revision=1,
        source_checksum=document.checksum,
        first_seen_at=NOW,
        last_seen_at=NOW,
    )
    agent = project_repair_capability(base, document, active=True)
    inactive = project_repair_capability(base, document, active=False)
    diagnostic = CanonDiagnosticV1(
        fact_code="graph.future_fact",
        domain="graph",
        targets=[owner],
        evidence=[evidence],
    )
    unknown = CanonIssueMetadataV2.model_validate({
        **base.model_dump(mode="json"),
        "issue_version": 2,
        "rule_id": "integrity.error-fact",
        "diagnostic": diagnostic,
    })
    navigation = project_repair_capability(unknown, document, active=True)
    missing_owner = owner.model_copy(update={"owner_id": "deleted-node"})
    missing = CanonIssueMetadataV2.model_validate({
        **unknown.model_dump(mode="json"),
        "scope": missing_owner,
        "targets": [missing_owner],
        "evidence": [evidence.model_copy(update={"owner": missing_owner})],
        "diagnostic": diagnostic.model_copy(update={
            "targets": (missing_owner,),
            "evidence": (evidence.model_copy(update={"owner": missing_owner}),),
        }),
    })
    none = project_repair_capability(missing, document, active=True)

    assert (agent.kind, agent.action, agent.available) == (
        "agent_review",
        "explore_solutions",
        True,
    )
    assert agent.unavailable_reason is None
    assert (inactive.kind, inactive.action, inactive.available) == ("none", "none", False)
    assert inactive.unavailable_reason == "canon.repair.unavailable.issue_inactive"
    assert (navigation.kind, navigation.action, navigation.available) == (
        "navigate_only",
        "open_source",
        True,
    )
    assert (none.kind, none.action, none.available) == ("none", "none", False)
    assert none.unavailable_reason == "canon.repair.unavailable.owner_missing"


@pytest.mark.parametrize("owner_type", ["initial_state", "scene_boundary", "quest_outcome"])
def test_projects_navigation_for_specialized_exact_owners(
    tmp_path: Path,
    owner_type: str,
) -> None:
    """Specialized editor owners remain navigable through the public capability contract."""

    document = import_project_fixture(FIXTURE, tmp_path / f"{owner_type}.narrative").document
    owner_ids = {
        "initial_state": document.flow_initial_states[0].id,
        "scene_boundary": document.scene_flow_boundaries[0].id,
        "quest_outcome": document.quests[0].document.stages[0].branches[0].id,
    }
    owner = CanonOwnerRef(owner_type=owner_type, owner_id=owner_ids[owner_type])
    evidence = CanonEvidenceRef(owner=owner, message_key="canon.evidence.integrity-fact")
    metadata = CanonIssueMetadataV2(
        origin="canon_rule",
        rule_id="integrity.error-fact",
        rule_version=1,
        fingerprint="b" * 64,
        category="continuity",
        scope=owner,
        message_key="canon.issue.integrity.error-fact.message",
        targets=[owner],
        evidence=[evidence],
        diagnostic=CanonDiagnosticV1(
            fact_code="graph.future_fact",
            domain="graph",
            targets=[owner],
            evidence=[evidence],
        ),
        saved_revision=1,
        source_checksum=document.checksum,
        first_seen_at=NOW,
        last_seen_at=NOW,
    )

    capability = project_repair_capability(metadata, document, active=True)

    assert (capability.kind, capability.action, capability.available) == (
        "navigate_only",
        "open_source",
        True,
    )


def test_capability_contract_rejects_optimistic_or_mismatched_actions() -> None:
    with pytest.raises(ValidationError, match="kind and action disagree"):
        CanonRepairCapability(
            kind="navigate_only",
            action="request_fix",
            available=True,
            source_checksum="a" * 64,
        )
    with pytest.raises(ValidationError, match="requires one reason"):
        CanonRepairCapability(
            kind="agent_review",
            action="explore_solutions",
            available=False,
            source_checksum="a" * 64,
        )
