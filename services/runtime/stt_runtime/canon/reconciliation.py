"""Atomic persistence of complete deterministic canon Issue results."""

from __future__ import annotations

from dataclasses import dataclass, replace
from datetime import datetime
from typing import Iterable
from uuid import uuid4

from pydantic import ValidationError

from ..domain.entities import IssueEntity
from ..repositories.interfaces import UnitOfWork
from ..schemas.canon_check import (
    CanonCheckInput,
    CanonIssueCandidate,
    CanonIssueMetadataV1,
    CanonIssueMetadataV2,
    CanonIssueResolutionReason,
    CanonIssueStatus,
    CanonOwnerRef,
    parse_canon_issue_metadata,
)


class CanonIssueReconciliationError(ValueError):
    """Stable all-or-nothing reconciliation failure for run coordination."""

    def __init__(self, code: str, **parameters: object) -> None:
        super().__init__(code)
        self.code = code
        self.parameters = parameters


@dataclass(frozen=True, slots=True)
class CanonIssueReconciliationResult:
    """Internal mutation summary; API run summaries are assembled in P4-006."""

    project_id: str
    opened_ids: tuple[str, ...]
    retained_ids: tuple[str, ...]
    resolved_ids: tuple[str, ...]
    generated_issue_ids: tuple[str, ...]


class CanonIssueReconciler:
    """Reconcile one complete rule result in exactly one Unit of Work."""

    def reconcile(
        self,
        uow: UnitOfWork,
        check_input: CanonCheckInput,
        candidates: Iterable[CanonIssueCandidate],
        *,
        checked_rule_ids: Iterable[str],
        disabled_rule_ids: Iterable[str] = (),
        observed_at: datetime,
        scope: Iterable[CanonOwnerRef] = (),
    ) -> CanonIssueReconciliationResult:
        if observed_at.tzinfo is None or observed_at.utcoffset() is None:
            raise CanonIssueReconciliationError("canon_reconcile_timestamp_invalid")
        checked = frozenset(checked_rule_ids)
        disabled = frozenset(disabled_rule_ids)
        requested_scope = frozenset(owner.stable_key() for owner in scope)
        if disabled - checked:
            raise CanonIssueReconciliationError("canon_reconcile_rule_set_invalid")

        ordered_candidates = tuple(sorted(candidates, key=lambda item: item.fingerprint))
        duplicate_candidate = _first_duplicate(
            candidate.fingerprint for candidate in ordered_candidates
        )
        if duplicate_candidate is not None:
            raise CanonIssueReconciliationError(
                "canon_candidate_duplicate",
                fingerprint=duplicate_candidate,
            )
        unknown_rule = next(
            (
                candidate.rule_id
                for candidate in ordered_candidates
                if candidate.rule_id not in checked
            ),
            None,
        )
        if unknown_rule is not None:
            raise CanonIssueReconciliationError(
                "canon_candidate_rule_unchecked",
                rule_id=unknown_rule,
            )
        if uow.projects.get(check_input.project_id) is None:
            raise CanonIssueReconciliationError(
                "canon_project_not_found",
                project_id=check_input.project_id,
            )

        existing = tuple(
            sorted(
                uow.issues.list(project_id=check_input.project_id),
                key=lambda issue: issue.id,
            )
        )
        generated = self._generated_rule_issues(existing)
        by_fingerprint = {metadata.fingerprint: (issue, metadata) for issue, metadata in generated}
        candidate_fingerprints = {candidate.fingerprint for candidate in ordered_candidates}
        planned_adds: list[IssueEntity] = []
        planned_updates: list[IssueEntity] = []
        opened_ids: list[str] = []
        retained_ids: list[str] = []
        resolved_ids: list[str] = []

        for candidate in ordered_candidates:
            current = by_fingerprint.get(candidate.fingerprint)
            if current is None:
                issue = self._new_issue(check_input, candidate, observed_at)
                planned_adds.append(issue)
                opened_ids.append(issue.id)
                continue
            issue, metadata = current
            status = self._active_status(issue.status)
            if issue.status == "resolved":
                opened_ids.append(issue.id)
            else:
                retained_ids.append(issue.id)
            planned_updates.append(
                self._refresh_issue(
                    issue,
                    metadata,
                    check_input,
                    candidate,
                    status,
                    observed_at,
                )
            )

        for issue, metadata in generated:
            if metadata.fingerprint in candidate_fingerprints or metadata.rule_id not in checked:
                continue
            if requested_scope and not any(
                target.stable_key() in requested_scope for target in metadata.targets
            ) and (
                metadata.scope is None
                or metadata.scope.stable_key() not in requested_scope
            ):
                continue
            resolution_reason = (
                "rule_disabled" if metadata.rule_id in disabled else "candidate_absent"
            )
            resolved = self._resolve_issue(
                issue,
                metadata,
                check_input,
                resolution_reason,
                observed_at,
            )
            if resolved != issue:
                planned_updates.append(resolved)
                if metadata.resolved_at is None:
                    resolved_ids.append(issue.id)

        try:
            persisted = [uow.issues.add(issue) for issue in planned_adds]
            persisted.extend(uow.issues.update(issue) for issue in planned_updates)
            uow.commit()
        except Exception:
            uow.rollback()
            raise

        all_generated_ids = {
            issue.id for issue, _metadata in generated
        } | {issue.id for issue in persisted}
        return CanonIssueReconciliationResult(
            project_id=check_input.project_id,
            opened_ids=tuple(sorted(opened_ids)),
            retained_ids=tuple(sorted(retained_ids)),
            resolved_ids=tuple(sorted(resolved_ids)),
            generated_issue_ids=tuple(sorted(all_generated_ids)),
        )

    @staticmethod
    def _generated_rule_issues(
        issues: tuple[IssueEntity, ...],
    ) -> tuple[tuple[IssueEntity, CanonIssueMetadataV1], ...]:
        generated: list[tuple[IssueEntity, CanonIssueMetadataV1]] = []
        for issue in issues:
            try:
                metadata = parse_canon_issue_metadata(issue.metadata)
            except ValidationError as error:
                raise CanonIssueReconciliationError(
                    "canon_issue_metadata_invalid",
                    issue_id=issue.id,
                ) from error
            if metadata is None or metadata.origin != "canon_rule":
                continue
            if issue.status not in {"open", "review", "ignored", "resolved"}:
                raise CanonIssueReconciliationError(
                    "canon_issue_status_invalid",
                    issue_id=issue.id,
                )
            generated.append((issue, metadata))
        duplicate = _first_duplicate(metadata.fingerprint for _issue, metadata in generated)
        if duplicate is not None:
            raise CanonIssueReconciliationError(
                "canon_issue_fingerprint_duplicate",
                fingerprint=duplicate,
            )
        return tuple(generated)

    @staticmethod
    def _new_issue(
        check_input: CanonCheckInput,
        candidate: CanonIssueCandidate,
        observed_at: datetime,
    ) -> IssueEntity:
        node_id, edge_id = _legacy_target_refs(candidate)
        metadata = _candidate_metadata(check_input, candidate, observed_at)
        return IssueEntity(
            id=str(uuid4()),
            project_id=check_input.project_id,
            node_id=node_id,
            edge_id=edge_id,
            title=candidate.message_key,
            description=candidate.recommendation_key or "",
            severity=candidate.severity,
            status="open",
            metadata=metadata.model_dump(mode="json"),
            created_at=observed_at,
            updated_at=observed_at,
        )

    @staticmethod
    def _refresh_issue(
        issue: IssueEntity,
        metadata: CanonIssueMetadataV1,
        check_input: CanonCheckInput,
        candidate: CanonIssueCandidate,
        status: CanonIssueStatus,
        observed_at: datetime,
    ) -> IssueEntity:
        node_id, edge_id = _legacy_target_refs(candidate)
        metadata_model = CanonIssueMetadataV2 if candidate.diagnostic else CanonIssueMetadataV1
        refreshed = metadata_model.model_validate(
            {
                **metadata.model_dump(mode="json"),
                "issue_version": 2 if candidate.diagnostic else 1,
                "rule_id": candidate.rule_id,
                "rule_version": candidate.rule_version,
                "category": candidate.category,
                "scope": candidate.scope,
                "message_key": candidate.message_key,
                "message_parameters": candidate.message_parameters,
                "recommendation_key": candidate.recommendation_key,
                "recommendation_parameters": candidate.recommendation_parameters,
                "targets": candidate.targets,
                "evidence": candidate.evidence,
                "agent_explanation": candidate.agent_explanation,
                "agent_recommendation": candidate.agent_recommendation,
                "saved_revision": check_input.saved_revision,
                "source_checksum": check_input.source_checksum,
                "last_seen_at": observed_at,
                "resolved_at": None,
                "resolution_reason": None,
                **({"diagnostic": candidate.diagnostic} if candidate.diagnostic else {}),
            }
        )
        return replace(
            issue,
            node_id=node_id,
            edge_id=edge_id,
            title=candidate.message_key,
            description=candidate.recommendation_key or "",
            severity=candidate.severity,
            status=status,
            metadata=refreshed.model_dump(mode="json"),
            updated_at=observed_at,
        )

    @staticmethod
    def _resolve_issue(
        issue: IssueEntity,
        metadata: CanonIssueMetadataV1,
        check_input: CanonCheckInput,
        resolution_reason: CanonIssueResolutionReason,
        observed_at: datetime,
    ) -> IssueEntity:
        status = "ignored" if issue.status == "ignored" else "resolved"
        resolved_at = metadata.resolved_at or observed_at
        resolved = type(metadata).model_validate(
            {
                **metadata.model_dump(mode="json"),
                "saved_revision": check_input.saved_revision,
                "source_checksum": check_input.source_checksum,
                "resolved_at": resolved_at,
                "resolution_reason": resolution_reason,
            }
        )
        changed = resolved.model_dump() != metadata.model_dump() or status != issue.status
        candidate = replace(
            issue,
            status=status,
            metadata=resolved.model_dump(mode="json"),
            updated_at=observed_at if changed else issue.updated_at,
        )
        return candidate

    @staticmethod
    def _active_status(status: str) -> CanonIssueStatus:
        if status in {"review", "ignored"}:
            return status
        return "open"


def _candidate_metadata(
    check_input: CanonCheckInput,
    candidate: CanonIssueCandidate,
    observed_at: datetime,
) -> CanonIssueMetadataV1:
    metadata_model = CanonIssueMetadataV2 if candidate.diagnostic else CanonIssueMetadataV1
    return metadata_model(
        issue_version=2 if candidate.diagnostic else 1,
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
        agent_explanation=candidate.agent_explanation,
        agent_recommendation=candidate.agent_recommendation,
        saved_revision=check_input.saved_revision,
        source_checksum=check_input.source_checksum,
        first_seen_at=observed_at,
        last_seen_at=observed_at,
        **({"diagnostic": candidate.diagnostic} if candidate.diagnostic else {}),
    )


def _legacy_target_refs(candidate: CanonIssueCandidate) -> tuple[str | None, str | None]:
    refs = (candidate.scope, *candidate.targets)
    node_id = next((ref.owner_id for ref in refs if ref.owner_type == "node"), None)
    edge_id = next((ref.owner_id for ref in refs if ref.owner_type == "edge"), None)
    return node_id, edge_id


def _first_duplicate(values: Iterable[str]) -> str | None:
    seen: set[str] = set()
    for value in values:
        if value in seen:
            return value
        seen.add(value)
    return None
