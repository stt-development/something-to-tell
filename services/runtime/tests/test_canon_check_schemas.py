from copy import deepcopy
from datetime import UTC, datetime, timedelta
from pathlib import Path

import pytest
from pydantic import ValidationError

from services.runtime.stt_runtime.schemas.canon_check import (
    CanonCheckRun,
    CanonDiagnosticV1,
    CanonEvidenceRef,
    CanonFact,
    CanonIssueCandidate,
    CanonIssueMetadataV1,
    CanonIssueMetadataV2,
    CanonOwnerRef,
    CanonRunStart,
    CanonRunSummary,
    canon_issue_fingerprint,
    parse_canon_issue_metadata,
)
from services.runtime.stt_runtime.schemas.project_document import ProjectIssueRecord
from services.runtime.stt_runtime.project_fixture import load_project_fixture

NOW = datetime(2026, 8, 20, 10, 0, tzinfo=UTC)
CHECKSUM = "a" * 64


def _owner(owner_type: str, owner_id: str) -> CanonOwnerRef:
    return CanonOwnerRef(owner_type=owner_type, owner_id=owner_id)


def _evidence(owner: CanonOwnerRef, key: str = "canon.evidence") -> CanonEvidenceRef:
    return CanonEvidenceRef(owner=owner, message_key=key)


def test_fact_normalizes_owner_and_evidence_order_without_mutating_input() -> None:
    node_b = _owner("node", "b")
    node_a = _owner("node", "a")
    owners = [node_b, node_a, node_b]
    evidence = [_evidence(node_b, "z"), _evidence(node_a, "a")]
    before_owners = list(owners)
    before_evidence = list(evidence)

    fact = CanonFact(
        code="flow.unresolved-condition",
        domain="flow",
        level="error",
        scope=_owner("flow", "main"),
        owners=owners,
        evidence=evidence,
        parameters={"flag": "route.open"},
        source_revision=7,
    )

    assert [owner.owner_id for owner in fact.owners] == ["a", "b"]
    assert [item.owner.owner_id for item in fact.evidence] == ["a", "b"]
    assert owners == before_owners
    assert evidence == before_evidence
    with pytest.raises(ValidationError):
        fact.source_revision = 8


def test_run_start_normalizes_scope_and_rejects_invalid_rule_ids() -> None:
    command = CanonRunStart(
        session_id="session",
        observed_saved_revision=3,
        expected_history_revision=1,
        scope=[_owner("node", "b"), _owner("node", "a"), _owner("node", "b")],
        enabled_rule_overrides={"flow.rule": False},
    )

    assert [owner.owner_id for owner in command.scope] == ["a", "b"]
    with pytest.raises(ValidationError, match="invalid canon rule id"):
        CanonRunStart(
            session_id="session",
            observed_saved_revision=3,
            expected_history_revision=1,
            enabled_rule_overrides={"Not A Rule": True},
        )


def test_fingerprint_is_ordered_localization_independent_and_input_immutable() -> None:
    targets = [_owner("node", "target-b"), _owner("node", "target-a")]
    before = deepcopy(targets)

    first = canon_issue_fingerprint(
        rule_id="flow.unresolved-condition",
        rule_version=1,
        scope=_owner("flow", "main"),
        targets=targets,
    )
    second = canon_issue_fingerprint(
        rule_id="flow.unresolved-condition",
        rule_version=1,
        scope=_owner("flow", "main"),
        targets=list(reversed(targets)),
    )

    assert first == second
    assert targets == before
    assert len(first) == 64

    common = {
        "rule_id": "flow.unresolved-condition",
        "rule_version": 1,
        "category": "continuity",
        "scope": _owner("flow", "main"),
        "targets": targets,
        "fingerprint": first,
    }
    english = CanonIssueCandidate(
        **common,
        severity="warning",
        message_key="canon.rule.english",
        evidence=[_evidence(targets[0], "canon.evidence.english")],
    )
    russian = CanonIssueCandidate(
        **common,
        severity="critical",
        message_key="canon.rule.russian",
        evidence=[_evidence(targets[1], "canon.evidence.russian")],
    )
    assert english.fingerprint == russian.fingerprint == first


def test_candidate_rejects_mismatched_fingerprint_and_missing_evidence() -> None:
    target = _owner("node", "target")
    with pytest.raises(ValidationError, match="fingerprint does not match"):
        CanonIssueCandidate(
            rule_id="flow.rule",
            rule_version=1,
            category="continuity",
            severity="warning",
            scope=_owner("flow", "main"),
            message_key="canon.rule",
            targets=[target],
            evidence=[_evidence(target)],
            fingerprint="0" * 64,
        )


def test_generated_issue_metadata_is_typed_while_manual_issues_remain_valid() -> None:
    manual = ProjectIssueRecord(
        id="manual-issue",
        project_id="project",
        title="Writer note",
        severity="warning",
        status="open",
        metadata={"source": "manual"},
        created_at=NOW,
        updated_at=NOW,
    )
    target = _owner("node", "target")
    fingerprint = canon_issue_fingerprint(
        rule_id="graph.exclusive-owner",
        rule_version=1,
        scope=_owner("project", "project"),
        targets=[target],
    )
    metadata = CanonIssueMetadataV1(
        origin="canon_rule",
        rule_id="graph.exclusive-owner",
        rule_version=1,
        fingerprint=fingerprint,
        category="ownership",
        message_key="canon.rule.exclusiveOwner",
        targets=[target],
        evidence=[_evidence(target)],
        saved_revision=4,
        source_checksum=CHECKSUM,
        first_seen_at=NOW,
        last_seen_at=NOW,
    )

    assert parse_canon_issue_metadata(manual.metadata) is None
    assert parse_canon_issue_metadata(metadata.model_dump(mode="json")) == metadata


def test_v2_issue_metadata_requires_and_round_trips_concrete_diagnostic() -> None:
    target = _owner("dialogue_element", "line-1")
    diagnostic = CanonDiagnosticV1(
        fact_code="dialogue.dead_end",
        domain="dialogue",
        parameters={"reference_id": "line-2"},
        identity_parameters={"reference_id": "line-2"},
        targets=[target],
        evidence=[_evidence(target, "canon.evidence.integrity-fact")],
    )
    fingerprint = canon_issue_fingerprint(
        rule_id="integrity.error-fact",
        rule_version=1,
        scope=target,
        targets=[target],
        diagnostic=diagnostic,
    )
    metadata = CanonIssueMetadataV2(
        origin="canon_rule",
        rule_id="integrity.error-fact",
        rule_version=1,
        fingerprint=fingerprint,
        category="integrity",
        scope=target,
        message_key="canon.issue.integrity.known.message",
        targets=[target],
        evidence=diagnostic.evidence,
        diagnostic=diagnostic,
        saved_revision=4,
        source_checksum=CHECKSUM,
        first_seen_at=NOW,
        last_seen_at=NOW,
    )

    parsed = parse_canon_issue_metadata(metadata.model_dump(mode="json"))

    assert parsed == metadata
    assert isinstance(parsed, CanonIssueMetadataV2)
    with pytest.raises(ValidationError):
        CanonIssueMetadataV2.model_validate({
            **metadata.model_dump(mode="json", exclude={"diagnostic"}),
        })


def test_project_aurora_separates_manual_and_generated_fixture_issues() -> None:
    fixture = load_project_fixture(
        Path(__file__).parents[3]
        / "fixtures"
        / "projects"
        / "project-aurora.v1.json"
    )

    assert len(fixture.issues) == 3
    assert {issue.status for issue in fixture.issues} == {"open", "review"}
    parsed = [parse_canon_issue_metadata(issue.metadata) for issue in fixture.issues]
    assert sum(metadata is None for metadata in parsed) == 2
    generated = next(metadata for metadata in parsed if metadata is not None)
    assert isinstance(generated, CanonIssueMetadataV2)
    assert generated.diagnostic.fact_code == "graph.trade-law-source"
    assert generated.agent_explanation is None
    assert generated.agent_recommendation is None


def test_issue_metadata_and_run_require_consistent_utc_lifecycle() -> None:
    target = _owner("node", "target")
    fingerprint = canon_issue_fingerprint(
        rule_id="graph.rule",
        rule_version=1,
        scope=_owner("project", "project"),
        targets=[target],
    )
    with pytest.raises(ValidationError, match="last_seen_at"):
        CanonIssueMetadataV1(
            origin="canon_rule",
            rule_id="graph.rule",
            rule_version=1,
            fingerprint=fingerprint,
            category="continuity",
            message_key="canon.rule",
            targets=[target],
            evidence=[_evidence(target)],
            saved_revision=1,
            source_checksum=CHECKSUM,
            first_seen_at=NOW,
            last_seen_at=NOW - timedelta(seconds=1),
        )

    running = CanonCheckRun(
        id="run-1",
        project_id="project",
        saved_revision=4,
        source_checksum=CHECKSUM,
        rule_pack_version=1,
        mode="deterministic",
        status="running",
        started_at=NOW,
        summary=CanonRunSummary(fact_count=3),
    )
    assert running.completed_at is None
    with pytest.raises(ValidationError, match="terminal run states"):
        CanonCheckRun(**{
            **running.model_dump(),
            "status": "completed",
        })


@pytest.mark.parametrize(
    ("field", "value"),
    [
        ("run_version", 2),
        ("rule_pack_version", 0),
        ("source_checksum", "not-a-checksum"),
        ("started_at", "2026-08-20T10:00:00"),
    ],
)
def test_run_rejects_invalid_versions_checksums_and_timestamps(
    field: str,
    value: object,
) -> None:
    payload = {
        "id": "run-1",
        "project_id": "project",
        "saved_revision": 4,
        "source_checksum": CHECKSUM,
        "rule_pack_version": 1,
        "mode": "deterministic",
        "status": "running",
        "started_at": NOW,
        field: value,
    }
    with pytest.raises(ValidationError):
        CanonCheckRun.model_validate(payload)
