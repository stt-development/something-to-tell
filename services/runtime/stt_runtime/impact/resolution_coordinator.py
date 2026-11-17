"""Cancellable process-local lifecycle for optional Impact explanations."""

from __future__ import annotations

from concurrent.futures import Executor, Future, ThreadPoolExecutor
from datetime import UTC, datetime
from threading import Event, RLock
from typing import Callable
from uuid import uuid4

from ..canon.agent_profiles import (
    CanonProviderProfile,
    CanonProviderProfileError,
    CanonProviderProfileRegistry,
)
from ..project_session.service import ProjectSessionError, ProjectSessionRegistry
from ..project_history.service import ProjectHistoryError
from ..schemas.impact_resolution import (
    ImpactResolutionContextPackage,
    ImpactResolutionDiagnostic,
    ImpactResolutionDecision,
    ImpactResolutionDraftEdit,
    ImpactResolutionExplanation,
    ImpactResolutionErrorCode,
    ImpactResolutionRequest,
    ImpactResolutionReviewCommand,
    ImpactResolutionRun,
    ImpactResolutionRunStatus,
    ImpactSolutionAlternative,
    ImpactVisualDiffProjection,
)
from .coordinator import (
    ImpactResolutionValidationInput,
    ImpactRunCoordinator,
    ImpactRunCoordinatorError,
)
from .resolution_agent import (
    ImpactResolutionAgentError,
    ImpactResolutionAgentResponse,
    ImpactResolutionAgentService,
    validate_explanation_citations,
)
from .solution_validation import (
    ImpactSolutionValidationCancelled,
    ImpactSolutionValidator,
)

MAX_RETAINED_RESOLUTION_RUNS = 64


class ImpactResolutionCoordinatorError(ValueError):
    """Stable API failure raised before a resolution run can be recorded."""

    def __init__(self, code: str, **parameters: object) -> None:
        super().__init__(code)
        self.code = code
        self.parameters = parameters


class ImpactResolutionCoordinator:
    """Run provider prose off-lock without touching project persistence or Issues."""

    def __init__(
        self,
        project_sessions: ProjectSessionRegistry,
        impact_runs: ImpactRunCoordinator,
        provider_profiles: CanonProviderProfileRegistry,
        *,
        agent: ImpactResolutionAgentService | None = None,
        solution_validator: ImpactSolutionValidator | None = None,
        executor: Executor | None = None,
        clock: Callable[[], datetime] = lambda: datetime.now(UTC),
        run_id_factory: Callable[[], str] = lambda: str(uuid4()),
        max_retained_runs: int = MAX_RETAINED_RESOLUTION_RUNS,
    ) -> None:
        if max_retained_runs < 1:
            raise ValueError("resolution coordinator requires a positive run limit")
        self._project_sessions = project_sessions
        self._impact_runs = impact_runs
        self._provider_profiles = provider_profiles
        self._agent = agent or ImpactResolutionAgentService()
        self._solution_validator = solution_validator or ImpactSolutionValidator()
        self._executor = executor or ThreadPoolExecutor(
            max_workers=2,
            thread_name_prefix="stt-impact-resolution",
        )
        self._owns_executor = executor is None
        self._clock = clock
        self._run_id_factory = run_id_factory
        self._max_retained_runs = max_retained_runs
        self._runs: dict[str, ImpactResolutionRun] = {}
        self._contexts: dict[str, ImpactResolutionContextPackage] = {}
        self._validation_inputs: dict[str, ImpactResolutionValidationInput] = {}
        self._run_sessions: dict[str, str] = {}
        self._cancellations: dict[str, Event] = {}
        self._futures: dict[str, Future[None]] = {}
        self._guard = RLock()

    def start(
        self,
        session_id: str,
        request: ImpactResolutionRequest,
    ) -> ImpactResolutionRun:
        """Capture a bounded context before any provider thread is submitted."""

        try:
            context, validation_input = self._impact_runs.prepare_resolution(
                session_id, request
            )
        except ImpactRunCoordinatorError as error:
            raise ImpactResolutionCoordinatorError(error.code, **error.parameters) from error
        run = ImpactResolutionRun(
            id=self._run_id_factory(),
            project_id=context.project_id,
            saved_revision=context.saved_revision,
            history_revision=context.history_revision,
            source_checksum=context.source_checksum,
            request=request,
            status="queued",
            started_at=self._clock(),
        )
        with self._guard:
            self._evict_terminal_runs()
            if len(self._runs) >= self._max_retained_runs:
                raise ImpactResolutionCoordinatorError(
                    "impact_resolution_run_capacity_reached",
                    max_retained_runs=self._max_retained_runs,
                )
            if run.id in self._runs:
                raise ImpactResolutionCoordinatorError(
                    "impact_resolution_run_failed", reason="run_id_duplicate"
                )
            self._runs[run.id] = run
            self._contexts[run.id] = context
            self._validation_inputs[run.id] = validation_input
            self._run_sessions[run.id] = session_id
            self._cancellations[run.id] = Event()
            try:
                future = self._executor.submit(self._execute, run.id)
            except Exception as error:
                self._remove(run.id)
                raise ImpactResolutionCoordinatorError(
                    "impact_resolution_run_failed"
                ) from error
            self._futures[run.id] = future
            future.add_done_callback(lambda _: self._forget_future(run.id))
        return run

    def inspect(self, session_id: str, run_id: str) -> ImpactResolutionRun:
        with self._guard:
            return self._require_owned_run(session_id, run_id)

    def cancel(self, session_id: str, run_id: str) -> ImpactResolutionRun:
        """Request cancellation; provider output is discarded after acknowledgement."""

        with self._guard:
            run = self._require_owned_run(session_id, run_id)
            if run.status in {"queued", "running"}:
                self._cancellations[run_id].set()
            return run

    def edit(
        self,
        session_id: str,
        run_id: str,
        command: ImpactResolutionDraftEdit,
    ) -> ImpactResolutionRun:
        """Replace one alternative with a locally edited, freshly validated patch."""

        with self._guard:
            run = self._require_owned_run(session_id, run_id)
            context = self._contexts.get(run_id)
            validation_input = self._validation_inputs.get(run_id)
        if (
            run.status != "completed"
            or run.explanation is None
            or context is None
            or validation_input is None
        ):
            raise ImpactResolutionCoordinatorError("impact_resolution_run_stale")
        base = next(
            (item for item in run.alternatives if item.id == command.alternative_id),
            None,
        )
        if base is None:
            raise ImpactResolutionCoordinatorError(
                "impact_resolution_patch_invalid", reason="alternative_missing"
            )
        response = ImpactResolutionAgentResponse(
            explanation=run.explanation,
            alternatives=({
                "id": f"local-edit-{command.patch.target_checksum[:24]}",
                "finding_ids": list(base.finding_ids),
                "title": base.title,
                "rationale": base.rationale,
                "tradeoffs": list(base.tradeoffs),
                "expected_outcomes": list(base.expected_outcomes),
                "patch": command.patch.model_dump(mode="json"),
            },),
        )
        validated = self._solution_validator.validate(response, context, validation_input)
        if len(validated.alternatives) != 1:
            raise ImpactResolutionCoordinatorError(
                "impact_resolution_patch_invalid", reason="draft_validation"
            )
        edited = validated.alternatives[0]
        if edited.semantic_fingerprint == base.semantic_fingerprint:
            raise ImpactResolutionCoordinatorError(
                "impact_resolution_patch_invalid", reason="draft_unchanged"
            )
        alternatives = tuple(
            edited if item.id == base.id else item for item in run.alternatives
        )
        projections = tuple(
            item for item in run.visual_projections
            if item.alternative_fingerprint != base.semantic_fingerprint
        ) + validated.visual_projections
        updated = run.model_copy(update={
            "alternatives": alternatives,
            "visual_projections": projections,
            "diagnostics": (*run.diagnostics, *validated.diagnostics),
        })
        with self._guard:
            current = self._require_owned_run(session_id, run_id)
            if current.source_checksum != run.source_checksum or current.status != "completed":
                raise ImpactResolutionCoordinatorError("impact_resolution_run_stale")
            self._runs[run_id] = updated
        return updated

    def review(
        self,
        session_id: str,
        run_id: str,
        command: ImpactResolutionReviewCommand,
        *,
        approved: bool,
    ) -> tuple[ImpactResolutionDecision, ImpactResolutionRun]:
        """Approve or reject one exact validated alternative by stable identity."""

        with self._guard:
            run = self._require_owned_run(session_id, run_id)
        if run.status != "completed" or run.source_checksum != command.source_checksum:
            raise ImpactResolutionCoordinatorError("impact_resolution_run_stale")
        alternative = next(
            (item for item in run.alternatives if item.id == command.alternative_id),
            None,
        )
        if (
            alternative is None
            or alternative.semantic_fingerprint != command.proposal_semantic_fingerprint
            or alternative.validation.status != "valid"
            or alternative.patch is None
        ):
            raise ImpactResolutionCoordinatorError("impact_resolution_patch_invalid")
        decision = ImpactResolutionDecision(
            finding_fingerprints=alternative.finding_ids,
            proposal_semantic_fingerprint=command.proposal_semantic_fingerprint,
            source_checksum=command.source_checksum,
            decision="approved" if approved else "rejected",
            decided_at=self._clock(),
        )
        try:
            self._project_sessions.review_impact_resolution(
                session_id,
                patch=alternative.patch if approved else None,
                decision=decision,
                expected_history_revision=command.expected_history_revision,
            )
        except (ProjectSessionError, ProjectHistoryError) as error:
            raise ImpactResolutionCoordinatorError(error.code, **error.parameters) from error
        with self._guard:
            current = self._require_owned_run(session_id, run_id)
            if not approved and current.status == "completed":
                self._runs[run_id] = current.model_copy(update={
                    "alternatives": tuple(
                        item for item in current.alternatives if item.id != alternative.id
                    ),
                    "visual_projections": tuple(
                        item for item in current.visual_projections
                        if item.alternative_fingerprint != alternative.semantic_fingerprint
                    ),
                })
            return decision, self._runs[run_id]

    def invalidate_project(self, project_id: str) -> None:
        """Mark readable output stale and prevent in-flight publication after edits."""

        with self._guard:
            for run_id, run in tuple(self._runs.items()):
                if run.project_id != project_id:
                    continue
                self._cancellations[run_id].set()
                if run.status in {"queued", "running"}:
                    self._runs[run_id] = self._terminal(
                        run,
                        "stale",
                        diagnostic=_diagnostic("impact_resolution_run_stale"),
                    )
                elif run.status == "completed":
                    self._runs[run_id] = self._terminal(
                        run,
                        "stale",
                        explanation=run.explanation,
                        alternatives=run.alternatives,
                        visual_projections=run.visual_projections,
                        diagnostic=_diagnostic("impact_resolution_run_stale"),
                    )

    def clear_session(self, session_id: str, project_id: str | None = None) -> None:
        with self._guard:
            for run_id, owned_session in tuple(self._run_sessions.items()):
                run = self._runs.get(run_id)
                if owned_session != session_id and (
                    project_id is None or run is None or run.project_id != project_id
                ):
                    continue
                self._cancellations[run_id].set()
                self._remove(run_id)

    def clear_all(self) -> None:
        with self._guard:
            for cancellation in self._cancellations.values():
                cancellation.set()
            self._runs.clear()
            self._contexts.clear()
            self._validation_inputs.clear()
            self._run_sessions.clear()
            self._cancellations.clear()
            futures = tuple(self._futures.values())
            self._futures.clear()
        for future in futures:
            future.cancel()
        if self._owns_executor:
            self._executor.shutdown(wait=False, cancel_futures=True)

    def _execute(self, run_id: str) -> None:
        try:
            with self._guard:
                run = self._runs.get(run_id)
                context = self._contexts.get(run_id)
                validation_input = self._validation_inputs.get(run_id)
                cancellation = self._cancellations.get(run_id)
                session_id = self._run_sessions.get(run_id)
                if (
                    run is None
                    or context is None
                    or validation_input is None
                    or cancellation is None
                    or session_id is None
                ):
                    return
                if cancellation.is_set():
                    self._publish_terminal(
                        run_id,
                        "cancelled",
                        diagnostic=_diagnostic("impact_resolution_run_cancelled"),
                    )
                    return
                self._runs[run_id] = run.model_copy(update={"status": "running"})

            profile, locale = self._resolve_configuration(session_id, run.request, context)
            response = self._agent.run(
                profile,
                run.request.model_id,
                context,
                locale,
            )
            # Revalidate alternate adapters at the coordinator trust boundary.
            validate_explanation_citations(context, response.explanation)
            validated = self._solution_validator.validate(
                response,
                context,
                validation_input,
                is_cancelled=cancellation.is_set,
            )
            alternatives = validated.alternatives
            visual_projections = validated.visual_projections
            if not run.request.include_rejected:
                rejected = {
                    (item.source_checksum, item.proposal_semantic_fingerprint)
                    for item in self._project_sessions.list_impact_resolution_decisions(session_id)
                    if item.decision == "rejected"
                }
                suppressed = {
                    item.semantic_fingerprint
                    for item in alternatives
                    if item.semantic_fingerprint is not None
                    and (run.source_checksum, item.semantic_fingerprint) in rejected
                }
                alternatives = tuple(
                    item for item in alternatives
                    if item.semantic_fingerprint not in suppressed
                )
                visual_projections = tuple(
                    item for item in visual_projections
                    if item.alternative_fingerprint not in suppressed
                )
            if cancellation.is_set():
                self._publish_terminal(
                    run_id,
                    "cancelled",
                    diagnostic=_diagnostic("impact_resolution_run_cancelled"),
                )
                return
            self._impact_runs.assert_resolution_current(
                session_id,
                run.request.impact_run_id,
            )
            self._publish_terminal(
                run_id,
                "completed",
                explanation=response.explanation,
                alternatives=alternatives,
                visual_projections=visual_projections,
                diagnostics=validated.diagnostics,
            )
        except ImpactSolutionValidationCancelled:
            self._publish_terminal(
                run_id,
                "cancelled",
                diagnostic=_diagnostic("impact_resolution_run_cancelled"),
            )
        except ImpactResolutionAgentError as error:
            self._publish_terminal(
                run_id,
                "failed",
                diagnostic=_diagnostic(error.code, error.parameters),
            )
        except CanonProviderProfileError as error:
            self._publish_terminal(
                run_id,
                "failed",
                diagnostic=_diagnostic(
                    "impact_resolution_provider_unavailable",
                    {"profile_id": error.profile_id},
                ),
            )
        except (ImpactRunCoordinatorError, ProjectSessionError):
            self._publish_terminal(
                run_id,
                "stale",
                diagnostic=_diagnostic("impact_resolution_run_stale"),
            )
        except Exception:
            self._publish_terminal(
                run_id,
                "failed",
                diagnostic=_diagnostic("impact_resolution_run_failed"),
            )

    def _resolve_configuration(
        self,
        session_id: str,
        request: ImpactResolutionRequest,
        context: ImpactResolutionContextPackage,
    ) -> tuple[CanonProviderProfile, str]:
        current = self._project_sessions.inspect(session_id)
        if current.document.checksum != context.source_checksum:
            raise ProjectSessionError("impact_run_stale")
        settings = current.document.manifest.settings
        policy = settings.impact_resolver
        assignment = settings.agent_providers.agents.impact_resolver
        if policy.agent_mode != "configured" or policy.content_policy != "bounded_evidence":
            raise ImpactResolutionAgentError("impact_resolution_provider_invalid")
        profile_id = (
            settings.agent_providers.default_provider_profile_id
            if assignment.provider_source == "project_default"
            else assignment.provider_profile_override_id
        )
        if (
            profile_id is None
            or request.provider_source != assignment.provider_source
            or request.provider_profile_id != assignment.provider_profile_override_id
            or request.model_id != assignment.model_id
        ):
            raise ImpactResolutionAgentError("impact_resolution_provider_invalid")
        return self._provider_profiles.resolve(profile_id), settings.content_locale

    def _publish_terminal(
        self,
        run_id: str,
        status: ImpactResolutionRunStatus,
        *,
        explanation: ImpactResolutionExplanation | None = None,
        alternatives: tuple[ImpactSolutionAlternative, ...] = (),
        visual_projections: tuple[ImpactVisualDiffProjection, ...] = (),
        diagnostics: tuple[ImpactResolutionDiagnostic, ...] = (),
        diagnostic: ImpactResolutionDiagnostic | None = None,
    ) -> None:
        with self._guard:
            run = self._runs.get(run_id)
            if run is None or run.status in {"cancelled", "stale"}:
                return
            self._runs[run_id] = self._terminal(
                run,
                status,
                explanation=explanation,
                alternatives=alternatives,
                visual_projections=visual_projections,
                diagnostics=diagnostics,
                diagnostic=diagnostic,
            )

    def _terminal(
        self,
        run: ImpactResolutionRun,
        status: ImpactResolutionRunStatus,
        *,
        explanation: ImpactResolutionExplanation | None = None,
        alternatives: tuple[ImpactSolutionAlternative, ...] = (),
        visual_projections: tuple[ImpactVisualDiffProjection, ...] = (),
        diagnostics: tuple[ImpactResolutionDiagnostic, ...] = (),
        diagnostic: ImpactResolutionDiagnostic | None = None,
    ) -> ImpactResolutionRun:
        payload = run.model_dump(mode="python")
        payload.update({
                "status": status,
                "explanation": explanation,
                "alternatives": alternatives,
                "visual_projections": visual_projections,
                "diagnostics": diagnostics or ((diagnostic,) if diagnostic else ()),
                "completed_at": self._clock(),
        })
        return ImpactResolutionRun.model_validate(payload)

    def _require_owned_run(self, session_id: str, run_id: str) -> ImpactResolutionRun:
        run = self._runs.get(run_id)
        if run is None or self._run_sessions.get(run_id) != session_id:
            raise ImpactResolutionCoordinatorError(
                "impact_resolution_run_not_found", run_id=run_id
            )
        return run

    def _evict_terminal_runs(self) -> None:
        while len(self._runs) >= self._max_retained_runs:
            evictable = next(
                (
                    run_id
                    for run_id, run in self._runs.items()
                    if run.status in {"completed", "failed", "cancelled", "stale"}
                ),
                None,
            )
            if evictable is None:
                return
            self._remove(evictable)

    def _remove(self, run_id: str) -> None:
        self._runs.pop(run_id, None)
        self._contexts.pop(run_id, None)
        self._validation_inputs.pop(run_id, None)
        self._run_sessions.pop(run_id, None)
        self._cancellations.pop(run_id, None)
        self._futures.pop(run_id, None)

    def _forget_future(self, run_id: str) -> None:
        with self._guard:
            self._futures.pop(run_id, None)


def _diagnostic(
    code: ImpactResolutionErrorCode,
    parameters: dict[str, object] | None = None,
) -> ImpactResolutionDiagnostic:
    return ImpactResolutionDiagnostic(
        code=code,
        message_key=f"impactResolution.error.{code}",
        parameters=parameters or {},
    )
