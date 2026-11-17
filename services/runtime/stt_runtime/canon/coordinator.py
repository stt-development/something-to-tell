"""Process-local canon run lifecycle and review commands for the Phase 4 API."""

from __future__ import annotations

from collections.abc import Callable
from dataclasses import replace
from datetime import UTC, datetime
from threading import RLock
from typing import Protocol
from uuid import uuid4

from pydantic import ValidationError

from ..agent_memory.resolver import AgentMemoryResolutionError
from ..project_format.manifest import CanonCheckSettings
from .agent import (
    CanonAgentError,
    CanonAgentService,
    build_evidence_only_payload,
    enrich_candidates,
    rebase_agent_patch,
    resolve_canon_memory,
    validate_agent_patches,
    validate_agent_response,
)
from .agent_profiles import CanonProviderProfileError, CanonProviderProfileRegistry
from .capabilities import project_repair_capability
from ..domain.entities import SuggestionEntity
from ..project_history.service import ProjectHistoryError
from ..project_session.service import ProjectSessionError, ProjectSessionRegistry
from ..schemas.canon_check import (
    CanonCheckInput,
    CanonCheckRun,
    CanonFixSuggestion,
    CanonFixSuggestionDecision,
    CanonFixSuggestionDecisionResponse,
    CanonIssueCandidate,
    CanonIssueCounts,
    CanonIssueListResponse,
    CanonIssueImpactRequest,
    CanonIssueProjection,
    CanonIssueStatusChange,
    CanonIssueSuggestionResponse,
    CanonRunDiagnostic,
    CanonRunStart,
    CanonRunSummary,
    parse_canon_issue_metadata,
)
from ..schemas.impact_analysis import (
    ImpactAnalysisRequest,
    ImpactSeed,
    SelectionImpactScenario,
)
from ..schemas.canon_agent import CanonAgentResponse
from ..schemas.project_document import ProjectDocument
from .fixers import CanonFixerRegistry
from .engine import CANON_RULE_PACK_VERSION, CanonRuleEngine, CanonRuleEngineError
from .reconciliation import CanonIssueReconciliationError
from .registry import CanonRuleRegistryError


class _RuleEngine(Protocol):
    """Small injectable boundary used to prove cancellation and stale completion."""

    rule_pack: object
    registry: object

    def evaluate(
        self,
        check_input: CanonCheckInput,
        *,
        settings: CanonCheckSettings | None = None,
    ) -> tuple[CanonIssueCandidate, ...]: ...


class CanonRunCoordinatorError(ValueError):
    """Stable localization-ready failure emitted before a run can be recorded."""

    def __init__(self, code: str, **parameters: object) -> None:
        super().__init__(code)
        self.code = code
        self.parameters = parameters


class CanonRunCoordinator:
    """Coordinates runs without persisting operational state in project storage."""

    def __init__(
        self,
        project_sessions: ProjectSessionRegistry,
        *,
        engine_factory: Callable[[], _RuleEngine] = CanonRuleEngine,
        clock: Callable[[], datetime] = lambda: datetime.now(UTC),
        run_id_factory: Callable[[], str] = lambda: str(uuid4()),
        suggestion_id_factory: Callable[[], str] = lambda: str(uuid4()),
        provider_profiles: CanonProviderProfileRegistry | None = None,
        agent: CanonAgentService | None = None,
    ) -> None:
        self._project_sessions = project_sessions
        self._engine_factory = engine_factory
        self._clock = clock
        self._run_id_factory = run_id_factory
        self._suggestion_id_factory = suggestion_id_factory
        self._provider_profiles = provider_profiles
        self._agent = agent
        self._runs: dict[str, CanonCheckRun] = {}
        self._run_sessions: dict[str, str] = {}
        self._cancelled: set[str] = set()
        self._suggestions: dict[str, CanonFixSuggestion] = {}
        self._suggestion_sessions: dict[str, str] = {}
        self._suggestion_sources: dict[str, ProjectDocument] = {}
        self._suggestion_history_revisions: dict[str, int] = {}
        self._agent_suggestion_by_issue: dict[str, str] = {}
        self._guard = RLock()

    def start(self, command: CanonRunStart) -> CanonCheckRun:
        """Run deterministic work outside the session lock, then reconcile atomically."""

        check_input = self._project_sessions.capture_canon_input(
            command.session_id,
            rule_pack_version=CANON_RULE_PACK_VERSION,
        )
        if command.observed_saved_revision != check_input.saved_revision:
            raise CanonRunCoordinatorError(
                "canon_revision_stale",
                expected_revision=command.observed_saved_revision,
                saved_revision=check_input.saved_revision,
            )

        engine = self._engine_factory()
        now = self._clock()
        run = CanonCheckRun(
            id=self._run_id_factory(),
            project_id=check_input.project_id,
            saved_revision=check_input.saved_revision,
            source_checksum=check_input.source_checksum,
            rule_pack_version=CANON_RULE_PACK_VERSION,
            mode=command.mode,
            scope=command.scope,
            status="queued",
            started_at=now,
        )
        with self._guard:
            if run.id in self._runs:
                raise CanonRunCoordinatorError("canon_run_id_duplicate", run_id=run.id)
            self._runs[run.id] = run
            self._run_sessions[run.id] = command.session_id
        self._transition(run.id, status="running")

        try:
            settings = self._settings(check_input, command)
            candidates = engine.evaluate(check_input, settings=settings)
            candidates = self._filter_scope(candidates, command)
            provider_diagnostic: CanonRunDiagnostic | None = None
            agent_response = None
            if command.mode == "configured_agent":
                try:
                    if not command.remote_consent:
                        raise CanonAgentError("canon_provider_consent_required")
                    if settings.agent_mode != "configured":
                        raise CanonAgentError("canon_provider_disabled")
                    if self._provider_profiles is None or self._agent is None:
                        raise CanonAgentError("canon_provider_unavailable")
                    assert settings.provider_profile_id is not None
                    assert settings.model_preference is not None
                    profile = self._provider_profiles.resolve(settings.provider_profile_id)
                    evidence_payload = build_evidence_only_payload(
                        check_input,
                        candidates,
                        resolve_canon_memory(
                            check_input,
                            history_revision=command.expected_history_revision,
                        ),
                    )
                    agent_response = self._agent.run(
                        profile,
                        settings.model_preference,
                        evidence_payload,
                        check_input.document.manifest.settings.content_locale,
                    )
                    # Revalidate at the trust boundary even for alternate adapters.
                    validate_agent_response(evidence_payload, agent_response)
                    validate_agent_patches(check_input.document, agent_response)
                    candidates = enrich_candidates(candidates, agent_response)
                except CanonProviderProfileError as error:
                    provider_diagnostic = CanonRunDiagnostic(
                        code=error.code,
                        message_key=f"canon.error.{error.code}",
                        parameters={"profile_id": error.profile_id},
                    )
                except CanonAgentError as error:
                    provider_diagnostic = CanonRunDiagnostic(
                        code=error.code,
                        message_key=f"canon.error.{error.code}",
                        parameters=error.parameters,
                    )
                except AgentMemoryResolutionError as error:
                    # Memory can block only optional enrichment; deterministic
                    # candidates still reconcile through the ordinary Canon path.
                    provider_diagnostic = CanonRunDiagnostic(
                        code=error.code,
                        message_key=f"agentMemory.error.{error.code}",
                        parameters=error.parameters,
                    )
            if self._is_cancelled(run.id):
                return self._terminal(run.id, "cancelled", "canon_run_cancelled")

            self._transition(run.id, status="reconciling")
            descriptors = tuple(engine.registry.descriptors)  # type: ignore[attr-defined]
            checked_rule_ids = tuple(item.id for item in descriptors)
            disabled_rule_ids = tuple(
                item.id
                for item in descriptors
                if settings.enabled_rules.get(item.id, True) is False
            )
            result = self._project_sessions.reconcile_canon_issues(
                command.session_id,
                check_input,
                candidates,
                checked_rule_ids=checked_rule_ids,
                disabled_rule_ids=disabled_rule_ids,
                observed_at=self._clock(),
                expected_history_revision=command.expected_history_revision,
                require_current_checkpoint=True,
                scope=command.scope,
            )
            summary = CanonRunSummary(
                fact_count=len(check_input.facts),
                candidate_count=len(candidates),
                opened_count=len(result.opened_ids),
                retained_count=len(result.retained_ids),
                resolved_count=len(result.resolved_ids),
                severity=self._severity_counts(candidates),
            )
            if agent_response is not None:
                self._retain_agent_proposals(
                    command.session_id,
                    check_input,
                    agent_response,
                )
            completed = self._terminal(run.id, "completed", summary=summary)
            if provider_diagnostic is not None:
                completed = self._transition(
                    run.id,
                    diagnostics=(provider_diagnostic,),
                )
            return completed
        except ProjectSessionError as error:
            status = "stale" if error.code == "canon_run_stale" else "failed"
            return self._terminal(run.id, status, error.code, error.parameters)
        except ProjectHistoryError as error:
            return self._terminal(run.id, "stale", error.code, error.parameters)
        except CanonRuleRegistryError as error:
            return self._terminal(
                run.id,
                "failed",
                error.code,
                {"rule_id": error.rule_id},
            )
        except (CanonRuleEngineError, CanonIssueReconciliationError) as error:
            return self._terminal(
                run.id,
                "failed",
                error.code,
                getattr(error, "parameters", {}),
            )
        except Exception:
            return self._terminal(run.id, "failed", "canon_reconciliation_failed")

    def inspect(self, run_id: str) -> CanonCheckRun:
        with self._guard:
            run = self._runs.get(run_id)
            if run is None:
                raise CanonRunCoordinatorError("canon_run_not_found", run_id=run_id)
            return run

    def cancel(self, run_id: str) -> CanonCheckRun:
        """Request cancellation before reconciliation reaches its atomic boundary."""

        with self._guard:
            run = self._runs.get(run_id)
            if run is None:
                raise CanonRunCoordinatorError("canon_run_not_found", run_id=run_id)
            if run.status == "reconciling":
                raise CanonRunCoordinatorError("canon_run_in_progress", run_id=run_id)
            if run.status in {"queued", "running"}:
                self._cancelled.add(run_id)
            return run

    def list_issues(self, project_id: str) -> CanonIssueListResponse:
        session_id = self._project_sessions.session_id_for_project(project_id)
        snapshot = self._project_sessions.inspect(session_id)
        projections: list[CanonIssueProjection] = []
        with self._project_sessions.unit_of_work(session_id) as uow:
            for issue in sorted(uow.issues.list(project_id=project_id), key=lambda item: item.id):
                metadata = self._parse_metadata(issue.id, issue.metadata)
                if metadata is None:
                    continue
                projections.append(
                    CanonIssueProjection(
                        id=issue.id,
                        project_id=issue.project_id,
                        title=issue.title,
                        description=issue.description,
                        severity=issue.severity,
                        status=issue.status,
                        metadata=metadata,
                        repair=project_repair_capability(
                            metadata,
                            snapshot.document,
                            active=issue.status in {"open", "review"},
                        ),
                    )
                )
        active = tuple(item for item in projections if item.status in {"open", "review"})
        return CanonIssueListResponse(
            project_id=project_id,
            issues=tuple(projections),
            active_count=len(active),
            severity=CanonIssueCounts(
                info=sum(item.severity == "info" for item in active),
                warning=sum(item.severity == "warning" for item in active),
                critical=sum(item.severity == "critical" for item in active),
            ),
        )

    def change_issue_status(
        self,
        issue_id: str,
        command: CanonIssueStatusChange,
    ) -> CanonIssueProjection:
        """Persist a human review state as one reversible authoring command."""

        projection: CanonIssueProjection | None = None
        with self._project_sessions.authoring_unit_of_work(
            command.session_id,
            command_kind="update_canon_issue_status",
            label_key="history.command.updateCanonIssueStatus",
            expected_history_revision=command.expected_history_revision,
        ) as uow:
            issue = uow.issues.get(issue_id)
            if issue is None:
                raise CanonRunCoordinatorError("canon_issue_not_found", issue_id=issue_id)
            metadata = self._parse_metadata(issue.id, issue.metadata)
            if metadata is None:
                raise CanonRunCoordinatorError("canon_issue_not_found", issue_id=issue_id)
            if command.status in {"open", "review"} and metadata.resolved_at is not None:
                metadata = metadata.model_copy(
                    update={"resolved_at": None, "resolution_reason": None}
                )
            updated = uow.issues.update(
                replace(
                    issue,
                    status=command.status,
                    metadata=metadata.model_dump(mode="json"),
                    updated_at=self._clock(),
                )
            )
            uow.commit()
            document = self._project_sessions.inspect(command.session_id).document
            projection = CanonIssueProjection(
                id=updated.id,
                project_id=updated.project_id,
                title=updated.title,
                description=updated.description,
                severity=updated.severity,
                status=updated.status,
                metadata=metadata,
                repair=project_repair_capability(
                    metadata,
                    document,
                    active=updated.status in {"open", "review"},
                ),
            )
        assert projection is not None
        return projection

    def prepare_issue_impact_request(
        self,
        issue_id: str,
        command: CanonIssueImpactRequest,
    ) -> ImpactAnalysisRequest:
        """Translate one current agent-review Issue into exact Impact seeds."""

        snapshot = self._project_sessions.inspect(command.session_id)
        if command.source_checksum != snapshot.document.checksum:
            raise CanonRunCoordinatorError(
                "canon_repair_capability_stale",
                expected_checksum=command.source_checksum,
                active_checksum=snapshot.document.checksum,
            )
        history = self._project_sessions.inspect_history(command.session_id)
        if command.expected_history_revision != history.history_revision:
            raise ProjectHistoryError(
                "history_revision_stale",
                expected_revision=command.expected_history_revision,
                history_revision=history.history_revision,
            )
        with self._project_sessions.unit_of_work(command.session_id) as uow:
            issue = uow.issues.get(issue_id)
            metadata = None if issue is None else self._parse_metadata(issue_id, issue.metadata)
            if (
                issue is None
                or metadata is None
                or issue.project_id != snapshot.session.project_id
            ):
                raise CanonRunCoordinatorError("canon_issue_not_found", issue_id=issue_id)

        capability = project_repair_capability(
            metadata,
            snapshot.document,
            active=issue.status in {"open", "review"},
        )
        if not capability.available or capability.action != "explore_solutions":
            raise CanonRunCoordinatorError(
                "canon_repair_capability_unavailable",
                issue_id=issue_id,
                reason=(
                    capability.unavailable_reason
                    or "canon.repair.unavailable.action_mismatch"
                ),
            )

        # Evidence owners are first-class seeds so the browser never has to infer
        # affected resources from localized text or opaque diagnostic payloads.
        owners = (*metadata.targets, *(item.owner for item in metadata.evidence))
        unique = {owner.stable_key(): owner for owner in owners}
        seeds = tuple(
            ImpactSeed(resource=unique[key])
            for key in sorted(unique)
        )
        return ImpactAnalysisRequest(
            observed_saved_revision=snapshot.session.saved_revision,
            expected_history_revision=history.history_revision,
            source_checksum=snapshot.document.checksum,
            scenario=SelectionImpactScenario(intent="modify", seeds=seeds),
            direction="both",
        )

    def request_suggestion(
        self,
        issue_id: str,
        session_id: str,
        source_checksum: str,
    ) -> CanonIssueSuggestionResponse:
        """Create an immutable proposal without mutating project repositories."""

        snapshot = self._project_sessions.inspect(session_id)
        if source_checksum != snapshot.document.checksum:
            raise CanonRunCoordinatorError(
                "canon_repair_capability_stale",
                expected_checksum=source_checksum,
                active_checksum=snapshot.document.checksum,
            )
        with self._project_sessions.unit_of_work(session_id) as uow:
            issue = uow.issues.get(issue_id)
            metadata = None if issue is None else self._parse_metadata(issue_id, issue.metadata)
            if issue is None or metadata is None:
                raise CanonRunCoordinatorError("canon_issue_not_found", issue_id=issue_id)
            if issue.project_id != snapshot.session.project_id:
                raise CanonRunCoordinatorError("canon_issue_not_found", issue_id=issue_id)
        capability = project_repair_capability(
            metadata,
            snapshot.document,
            active=issue.status in {"open", "review"},
        )
        if not capability.available or capability.action != "request_fix":
            return CanonIssueSuggestionResponse(
                issue_id=issue_id,
                status="unavailable",
                message_key=(
                    capability.unavailable_reason
                    or "canon.repair.unavailable.action_mismatch"
                ),
            )
        with self._guard:
            agent_suggestion_id = self._agent_suggestion_by_issue.get(issue_id)
            agent_suggestion = (
                self._suggestions.get(agent_suggestion_id)
                if agent_suggestion_id is not None
                else None
            )
        if agent_suggestion is not None and agent_suggestion.status == "pending":
            return CanonIssueSuggestionResponse(
                issue_id=issue_id,
                status="created",
                suggestion_id=agent_suggestion.id,
                message_key="canon.suggestion.created",
                suggestion=agent_suggestion,
            )
        patch = CanonFixerRegistry().propose(metadata, snapshot.document)
        if patch is None:
            return CanonIssueSuggestionResponse(
                issue_id=issue_id,
                status="unavailable",
                message_key="canon.suggestion.unavailable",
            )
        suggestion = CanonFixSuggestion(
            id=self._suggestion_id_factory(),
            issue_id=issue_id,
            project_id=issue.project_id,
            patch=patch,
        )
        with self._guard:
            if suggestion.id in self._suggestions:
                raise CanonRunCoordinatorError(
                    "canon_suggestion_id_duplicate", suggestion_id=suggestion.id
                )
            self._suggestions[suggestion.id] = suggestion
            self._suggestion_sessions[suggestion.id] = session_id
            self._suggestion_sources[suggestion.id] = snapshot.document
            self._suggestion_history_revisions[suggestion.id] = (
                self._project_sessions.inspect_history(session_id).history_revision
            )
        return CanonIssueSuggestionResponse(
            issue_id=issue_id,
            status="created",
            suggestion_id=suggestion.id,
            message_key="canon.suggestion.created",
            suggestion=suggestion,
        )

    def decide_suggestion(
        self,
        suggestion_id: str,
        command: CanonFixSuggestionDecision,
        *,
        approved: bool,
    ) -> CanonFixSuggestionDecisionResponse:
        """Persist one reviewed proposal and apply its patch only on approval."""

        with self._guard:
            suggestion = self._suggestions.get(suggestion_id)
            owner_session = self._suggestion_sessions.get(suggestion_id)
            source = self._suggestion_sources.get(suggestion_id)
            suggestion_history_revision = self._suggestion_history_revisions.get(suggestion_id)
        if suggestion is None or owner_session != command.session_id:
            raise CanonRunCoordinatorError(
                "canon_suggestion_not_found", suggestion_id=suggestion_id
            )
        if suggestion.status != "pending":
            raise CanonRunCoordinatorError(
                "canon_suggestion_already_decided", suggestion_id=suggestion_id
            )
        reviewed_patch = suggestion.patch
        current = self._project_sessions.inspect(command.session_id).document
        if approved and reviewed_patch.source_checksum != current.checksum:
            current_history_revision = self._project_sessions.inspect_history(
                command.session_id
            ).history_revision
            if (
                source is None
                or suggestion_history_revision != current_history_revision
            ):
                raise CanonRunCoordinatorError(
                    "canon_suggestion_stale",
                    expected_checksum=reviewed_patch.source_checksum,
                )
            try:
                reviewed_patch = rebase_agent_patch(source, current, reviewed_patch)
            except (ProjectSessionError, ValueError) as error:
                raise CanonRunCoordinatorError(
                    "canon_suggestion_stale",
                    expected_checksum=reviewed_patch.source_checksum,
                ) from error
        status = "approved" if approved else "rejected"
        now = self._clock()
        audit = SuggestionEntity(
            id=suggestion.id,
            project_id=suggestion.project_id,
            title="Canon fix suggestion",
            description=f"{status} fix for {suggestion.issue_id}",
            status=status,
            patch=reviewed_patch.model_dump(mode="json"),
            created_by="canon-rule",
            metadata={
                "canon_suggestion_version": suggestion.suggestion_version,
                "issue_id": suggestion.issue_id,
                "source_checksum": suggestion.patch.source_checksum,
                "why": suggestion.why,
                "how": suggestion.how,
            },
            created_at=now,
            updated_at=now,
        )
        reviewed = self._project_sessions.review_canon_fix(
            command.session_id,
            patch=reviewed_patch if approved else None,
            audit=audit,
            expected_history_revision=command.expected_history_revision,
            approved=approved,
        )
        decided = suggestion.model_copy(update={"status": status})
        with self._guard:
            self._suggestions[suggestion_id] = decided
        return CanonFixSuggestionDecisionResponse(
            suggestion=decided,
            project=reviewed.project,
            history=reviewed.history,
        )

    def clear_session(self, session_id: str, project_id: str) -> None:
        """Erase operational runs when their owning project session closes."""

        with self._guard:
            run_ids = tuple(
                run_id
                for run_id, run in self._runs.items()
                if self._run_sessions.get(run_id) == session_id or run.project_id == project_id
            )
            for run_id in run_ids:
                self._runs.pop(run_id, None)
                self._run_sessions.pop(run_id, None)
                self._cancelled.discard(run_id)
            suggestion_ids = tuple(
                suggestion_id
                for suggestion_id, owner in self._suggestion_sessions.items()
                if owner == session_id
            )
            for suggestion_id in suggestion_ids:
                self._suggestions.pop(suggestion_id, None)
                self._suggestion_sessions.pop(suggestion_id, None)
                self._suggestion_sources.pop(suggestion_id, None)
                self._suggestion_history_revisions.pop(suggestion_id, None)
            self._agent_suggestion_by_issue = {
                issue_id: suggestion_id
                for issue_id, suggestion_id in self._agent_suggestion_by_issue.items()
                if suggestion_id not in suggestion_ids
            }

    def clear_all(self) -> None:
        with self._guard:
            self._runs.clear()
            self._run_sessions.clear()
            self._cancelled.clear()
            self._suggestions.clear()
            self._suggestion_sessions.clear()
            self._suggestion_sources.clear()
            self._suggestion_history_revisions.clear()
            self._agent_suggestion_by_issue.clear()

    def _retain_agent_proposals(
        self,
        session_id: str,
        check_input: CanonCheckInput,
        response: CanonAgentResponse,
    ) -> None:
        """Bind validated provider patches to durable issue ids after reconciliation."""

        if not response.proposals:
            return
        project_id = check_input.project_id
        current = self._project_sessions.inspect(session_id).document
        issue_by_fingerprint = {
            issue.metadata.fingerprint: issue
            for issue in self.list_issues(project_id).issues
        }
        explanation_by_fingerprint = {
            explanation.fingerprint: explanation
            for explanation in response.explanations
        }
        history_revision = self._project_sessions.inspect_history(
            session_id
        ).history_revision
        with self._guard:
            for proposal in response.proposals:
                issue = issue_by_fingerprint.get(proposal.fingerprint)
                if issue is None:
                    continue
                explanation = explanation_by_fingerprint.get(proposal.fingerprint)
                suggestion = CanonFixSuggestion(
                    id=self._suggestion_id_factory(),
                    issue_id=issue.id,
                    project_id=project_id,
                    why=explanation.explanation if explanation is not None else None,
                    how=explanation.recommendation if explanation is not None else None,
                    patch=rebase_agent_patch(
                        check_input.document,
                        current,
                        proposal.patch,
                    ),
                )
                self._suggestions[suggestion.id] = suggestion
                self._suggestion_sessions[suggestion.id] = session_id
                self._suggestion_sources[suggestion.id] = current
                self._suggestion_history_revisions[suggestion.id] = history_revision
                self._agent_suggestion_by_issue[issue.id] = suggestion.id

    def _transition(self, run_id: str, **changes: object) -> CanonCheckRun:
        with self._guard:
            current = self._runs[run_id]
            updated = CanonCheckRun.model_validate(
                {**current.model_dump(mode="json"), **changes}
            )
            self._runs[run_id] = updated
            return updated

    def _terminal(
        self,
        run_id: str,
        status: str,
        code: str | None = None,
        parameters: dict[str, object] | None = None,
        *,
        summary: CanonRunSummary | None = None,
    ) -> CanonCheckRun:
        diagnostics = (
            ()
            if code is None
            else (
                CanonRunDiagnostic(
                    code=code,
                    message_key=f"canon.error.{code}",
                    parameters=parameters or {},
                ),
            )
        )
        return self._transition(
            run_id,
            status=status,
            completed_at=self._clock(),
            summary=summary or CanonRunSummary(),
            diagnostics=diagnostics,
        )

    def _is_cancelled(self, run_id: str) -> bool:
        with self._guard:
            return run_id in self._cancelled

    @staticmethod
    def _settings(check_input: CanonCheckInput, command: CanonRunStart) -> CanonCheckSettings:
        base = check_input.document.manifest.settings.canon_check
        return CanonCheckSettings.model_validate(
            {
                **base.model_dump(),
                "enabled_rules": {
                    **base.enabled_rules,
                    **command.enabled_rule_overrides,
                },
                "severity_overrides": {
                    **base.severity_overrides,
                    **command.severity_overrides,
                },
            }
        )

    @staticmethod
    def _filter_scope(
        candidates: tuple[CanonIssueCandidate, ...],
        command: CanonRunStart,
    ) -> tuple[CanonIssueCandidate, ...]:
        if not command.scope:
            return candidates
        requested = {owner.stable_key() for owner in command.scope}
        return tuple(
            candidate
            for candidate in candidates
            if candidate.scope.stable_key() in requested
            or any(target.stable_key() in requested for target in candidate.targets)
        )

    @staticmethod
    def _severity_counts(
        candidates: tuple[CanonIssueCandidate, ...],
    ) -> CanonIssueCounts:
        return CanonIssueCounts(
            info=sum(item.severity == "info" for item in candidates),
            warning=sum(item.severity == "warning" for item in candidates),
            critical=sum(item.severity == "critical" for item in candidates),
        )

    @staticmethod
    def _parse_metadata(issue_id: str, payload: dict[str, object]):
        try:
            return parse_canon_issue_metadata(payload)
        except ValidationError as error:
            raise CanonRunCoordinatorError(
                "canon_issue_metadata_invalid",
                issue_id=issue_id,
            ) from error
