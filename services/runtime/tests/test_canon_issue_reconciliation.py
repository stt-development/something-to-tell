from dataclasses import replace
from datetime import UTC, datetime, timedelta
from pathlib import Path

import pytest

from services.runtime.stt_runtime.canon.engine import (
    CanonRuleEngine,
    initial_canon_rule_pack,
)
from services.runtime.stt_runtime.canon.reconciliation import (
    CanonIssueReconciler,
    CanonIssueReconciliationError,
)
from services.runtime.stt_runtime.project_fixture import import_project_fixture
from services.runtime.stt_runtime.project_history.service import ProjectHistoryError
from services.runtime.stt_runtime.project_session.service import ProjectSessionRegistry
from services.runtime.stt_runtime.schemas.canon_check import (
    CanonIssueMetadataV1,
    parse_canon_issue_metadata,
)
from services.runtime.stt_runtime.schemas.project_document import (
    ProjectDocument,
    ProjectIssueRecord,
)

FIXTURE = Path(__file__).parents[3] / "fixtures" / "projects" / "project-aurora.v1.json"
OBSERVED = datetime(2026, 8, 20, 14, 0, tzinfo=UTC)


def _open_aurora(
    tmp_path: Path,
) -> tuple[ProjectSessionRegistry, str]:
    project_path = tmp_path / "ProjectAurora.narrative"
    import_project_fixture(FIXTURE, project_path)
    registry = ProjectSessionRegistry()
    opened = registry.open(project_path)
    return registry, opened.session.session_id


def _rule_ids() -> tuple[str, ...]:
    return tuple(rule.descriptor.id for rule in initial_canon_rule_pack().rules)


def _discard_and_close(registry: ProjectSessionRegistry, session_id: str) -> None:
    """Leave no dirty fixture lock behind after an integration assertion."""

    if registry.inspect(session_id).session.save_status != "clean":
        registry.discard(session_id)
    registry.close(session_id)


def _generated(
    document: ProjectDocument,
) -> dict[str, tuple[ProjectIssueRecord, CanonIssueMetadataV1]]:
    result: dict[str, tuple[ProjectIssueRecord, CanonIssueMetadataV1]] = {}
    for issue in document.issues:
        metadata = parse_canon_issue_metadata(issue.metadata)
        if metadata is not None and metadata.origin == "canon_rule":
            result[metadata.fingerprint] = (issue, metadata)
    return result


def test_reconcile_opens_generated_issues_without_touching_manual_records(
    tmp_path: Path,
) -> None:
    registry, session_id = _open_aurora(tmp_path)
    try:
        check_input = registry.capture_canon_input(session_id)
        candidates = CanonRuleEngine().evaluate(check_input)
        manual_before = tuple(
            issue.model_dump(mode="json")
            for issue in check_input.document.issues
            if parse_canon_issue_metadata(issue.metadata) is None
        )
        seeded_issue = next(
            issue
            for issue in check_input.document.issues
            if issue.id == "issue-embargo-detail"
        )

        result = registry.reconcile_canon_issues(
            session_id,
            check_input,
            candidates,
            checked_rule_ids=_rule_ids(),
            observed_at=OBSERVED,
            expected_history_revision=0,
        )
        inspected = registry.inspect(session_id)
        history = registry.inspect_history(session_id)
    finally:
        _discard_and_close(registry, session_id)

    manual_after = tuple(
        issue.model_dump(mode="json")
        for issue in inspected.document.issues
        if parse_canon_issue_metadata(issue.metadata) is None
    )
    generated = _generated(inspected.document)
    integrity_metadata = [
        metadata
        for _issue, metadata in generated.values()
        if metadata.rule_id == "integrity.error-fact"
    ]
    assert manual_after == manual_before
    assert len(generated) == len(candidates) + 1 == 7
    assert integrity_metadata
    assert all(metadata.issue_version == 2 for metadata in integrity_metadata)
    assert all(metadata.diagnostic.fact_code for metadata in integrity_metadata)
    assert all(
        evidence.excerpt is None
        for metadata in integrity_metadata
        for evidence in metadata.diagnostic.evidence
    )
    assert set(result.opened_ids) == {
        issue.id
        for issue, metadata in generated.values()
        if metadata.fingerprint != seeded_issue.metadata["fingerprint"]
    }
    assert result.retained_ids == ()
    assert result.resolved_ids == (seeded_issue.id,)
    seeded_after = generated[seeded_issue.metadata["fingerprint"]]
    assert seeded_after[0].status == "resolved"
    assert seeded_after[1].resolution_reason == "candidate_absent"
    assert inspected.session.save_status == "dirty"
    assert history.next_undo.label_key == (
        "history.command.reconcileCanonIssues"
    )


def test_reconcile_retains_review_and_ignored_then_resolves_and_reopens(
    tmp_path: Path,
) -> None:
    registry, session_id = _open_aurora(tmp_path)
    try:
        check_input = registry.capture_canon_input(session_id)
        candidates = CanonRuleEngine().evaluate(check_input)
        registry.reconcile_canon_issues(
            session_id,
            check_input,
            candidates,
            checked_rule_ids=_rule_ids(),
            observed_at=OBSERVED,
            expected_history_revision=0,
        )
        first = _generated(registry.inspect(session_id).document)
        review_fingerprint = next(
            item.fingerprint
            for item in candidates
            if item.rule_id == "condition.unresolved-path"
        )
        ignored_fingerprint = next(
            item.fingerprint
            for item in candidates
            if item.rule_id == "ownership.custody-disagreement"
        )
        review_issue = first[review_fingerprint][0]
        ignored_issue = first[ignored_fingerprint][0]
        with registry.authoring_unit_of_work(
            session_id,
            command_kind="review_canon_issues",
            label_key="history.command.updateIssue",
            expected_history_revision=1,
        ) as uow:
            review_entity = uow.issues.get(review_issue.id)
            ignored_entity = uow.issues.get(ignored_issue.id)
            assert review_entity is not None and ignored_entity is not None
            uow.issues.update(replace(review_entity, status="review"))
            uow.issues.update(replace(ignored_entity, status="ignored"))
            uow.commit()

        reduced = tuple(
            item
            for item in candidates
            if item.fingerprint not in {review_fingerprint, ignored_fingerprint}
        )
        missing = registry.reconcile_canon_issues(
            session_id,
            check_input,
            reduced,
            checked_rule_ids=_rule_ids(),
            observed_at=OBSERVED + timedelta(minutes=1),
            expected_history_revision=2,
        )
        absent = _generated(registry.inspect(session_id).document)
        assert absent[review_fingerprint][0].status == "resolved"
        assert absent[ignored_fingerprint][0].status == "ignored"
        assert absent[review_fingerprint][1].resolution_reason == "candidate_absent"
        assert absent[ignored_fingerprint][1].resolved_at == OBSERVED + timedelta(minutes=1)
        assert {review_issue.id, ignored_issue.id}.issubset(missing.resolved_ids)

        recurring = registry.reconcile_canon_issues(
            session_id,
            check_input,
            candidates,
            checked_rule_ids=_rule_ids(),
            observed_at=OBSERVED + timedelta(minutes=2),
            expected_history_revision=3,
        )
        reopened = _generated(registry.inspect(session_id).document)
    finally:
        _discard_and_close(registry, session_id)

    assert reopened[review_fingerprint][0].id == review_issue.id
    assert reopened[review_fingerprint][0].status == "open"
    assert reopened[ignored_fingerprint][0].id == ignored_issue.id
    assert reopened[ignored_fingerprint][0].status == "ignored"
    assert reopened[review_fingerprint][1].resolved_at is None
    assert review_issue.id in recurring.opened_ids
    assert ignored_issue.id in recurring.retained_ids


def test_disabled_rule_resolution_records_an_explicit_reason(tmp_path: Path) -> None:
    registry, session_id = _open_aurora(tmp_path)
    try:
        check_input = registry.capture_canon_input(session_id)
        candidates = CanonRuleEngine().evaluate(check_input)
        registry.reconcile_canon_issues(
            session_id,
            check_input,
            candidates,
            checked_rule_ids=_rule_ids(),
            observed_at=OBSERVED,
        )
        integrity = next(item for item in candidates if item.rule_id == "integrity.error-fact")
        registry.reconcile_canon_issues(
            session_id,
            check_input,
            tuple(item for item in candidates if item.rule_id != "integrity.error-fact"),
            checked_rule_ids=_rule_ids(),
            disabled_rule_ids=("integrity.error-fact",),
            observed_at=OBSERVED + timedelta(minutes=1),
            expected_history_revision=1,
        )
        generated = _generated(registry.inspect(session_id).document)
    finally:
        _discard_and_close(registry, session_id)

    assert generated[integrity.fingerprint][0].status == "resolved"
    assert generated[integrity.fingerprint][1].resolution_reason == "rule_disabled"


def test_scoped_reconciliation_leaves_out_of_scope_issues_untouched(tmp_path: Path) -> None:
    registry, session_id = _open_aurora(tmp_path)
    try:
        check_input = registry.capture_canon_input(session_id)
        candidates = CanonRuleEngine().evaluate(check_input)
        registry.reconcile_canon_issues(
            session_id,
            check_input,
            candidates,
            checked_rule_ids=_rule_ids(),
            observed_at=OBSERVED,
        )
        selected = candidates[0]
        outside = next(
            candidate
            for candidate in candidates
            if candidate.scope.stable_key() != selected.scope.stable_key()
            and selected.scope not in candidate.targets
        )

        registry.reconcile_canon_issues(
            session_id,
            check_input,
            (),
            checked_rule_ids=_rule_ids(),
            observed_at=OBSERVED + timedelta(minutes=1),
            expected_history_revision=1,
            scope=(selected.scope,),
        )
        generated = _generated(registry.inspect(session_id).document)
    finally:
        _discard_and_close(registry, session_id)

    assert generated[selected.fingerprint][0].status == "resolved"
    assert generated[outside.fingerprint][0].status == "open"


def test_reconciliation_is_one_exact_undo_redo_checksum_boundary(tmp_path: Path) -> None:
    registry, session_id = _open_aurora(tmp_path)
    try:
        check_input = registry.capture_canon_input(session_id)
        candidates = CanonRuleEngine().evaluate(check_input)
        source_checksum = registry.inspect(session_id).document.checksum
        registry.reconcile_canon_issues(
            session_id,
            check_input,
            candidates,
            checked_rule_ids=_rule_ids(),
            observed_at=OBSERVED,
            expected_history_revision=0,
        )
        target = registry.inspect(session_id).document
        target_issue_payload = [issue.model_dump(mode="json") for issue in target.issues]

        undone = registry.undo_history(session_id, expected_history_revision=1)
        redone = registry.redo_history(session_id, expected_history_revision=2)
    finally:
        _discard_and_close(registry, session_id)

    assert undone.project.document.checksum == source_checksum
    assert redone.project.document.checksum == target.checksum
    assert [issue.model_dump(mode="json") for issue in redone.project.document.issues] == (
        target_issue_payload
    )
    assert redone.history.undo_depth == 1


def test_reconciliation_failure_rolls_back_all_issues_and_history(tmp_path: Path) -> None:
    registry, session_id = _open_aurora(tmp_path)
    try:
        check_input = registry.capture_canon_input(session_id)
        candidates = CanonRuleEngine().evaluate(check_input)
        before = registry.inspect(session_id)

        with pytest.raises(CanonIssueReconciliationError) as caught:
            registry.reconcile_canon_issues(
                session_id,
                check_input,
                (*candidates, candidates[0]),
                checked_rule_ids=_rule_ids(),
                observed_at=OBSERVED,
                expected_history_revision=0,
            )
        after = registry.inspect(session_id)
        history = registry.inspect_history(session_id)
    finally:
        _discard_and_close(registry, session_id)

    assert caught.value.code == "canon_candidate_duplicate"
    assert after.document.checksum == before.document.checksum
    assert after.session.save_status == "clean"
    assert history.history_revision == history.undo_depth == 0


def test_repository_failure_after_a_partial_flush_writes_nothing(tmp_path: Path) -> None:
    registry, session_id = _open_aurora(tmp_path)
    try:
        check_input = registry.capture_canon_input(session_id)
        candidates = CanonRuleEngine().evaluate(check_input)
        before = registry.inspect(session_id).document.checksum
        with registry.unit_of_work(session_id) as uow:
            repository = uow.issues
            original_add = repository.add
            add_count = 0

            def fail_second_add(issue: object) -> object:
                nonlocal add_count
                add_count += 1
                if add_count == 2:
                    raise RuntimeError("injected issue write failure")
                return original_add(issue)

            repository.add = fail_second_add  # type: ignore[method-assign]
            with pytest.raises(RuntimeError, match="injected issue write failure"):
                CanonIssueReconciler().reconcile(
                    uow,
                    check_input,
                    candidates,
                    checked_rule_ids=_rule_ids(),
                    observed_at=OBSERVED,
                )
        after = registry.inspect(session_id)
    finally:
        _discard_and_close(registry, session_id)

    assert after.document.checksum == before
    assert after.document.issues == check_input.document.issues
    assert after.session.save_status == "clean"


def test_history_failure_restores_the_pre_reconciliation_document(tmp_path: Path) -> None:
    registry, session_id = _open_aurora(tmp_path)
    active = registry._require_session(session_id)
    original_record = active.history.record

    def fail_history_record(*args: object, **kwargs: object) -> object:
        raise RuntimeError("injected history failure")

    try:
        check_input = registry.capture_canon_input(session_id)
        candidates = CanonRuleEngine().evaluate(check_input)
        before = registry.inspect(session_id)
        active.history.record = fail_history_record  # type: ignore[method-assign]

        with pytest.raises(ProjectHistoryError) as caught:
            registry.reconcile_canon_issues(
                session_id,
                check_input,
                candidates,
                checked_rule_ids=_rule_ids(),
                observed_at=OBSERVED,
                expected_history_revision=0,
            )
        after = registry.inspect(session_id)
    finally:
        active.history.record = original_record  # type: ignore[method-assign]
        _discard_and_close(registry, session_id)

    assert caught.value.code == "history_record_invalid"
    assert after.document.checksum == before.document.checksum
    assert after.document.issues == before.document.issues
    assert after.session.save_status == "clean"
