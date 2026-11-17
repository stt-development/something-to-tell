"""Process-local lifecycle for bounded snapshot-bound Impact Analysis runs."""

from __future__ import annotations

from concurrent.futures import Executor, Future, ThreadPoolExecutor
from dataclasses import dataclass
from datetime import UTC, datetime
from threading import Event, RLock
from typing import Callable
from uuid import uuid4

from ..project_document.patch import ProjectPatchError, apply_project_patch
from ..project_session.service import ProjectSessionError, ProjectSessionRegistry
from ..schemas.impact_analysis import (
    ImpactAnalysisInput,
    ImpactAnalysisRequest,
    ImpactAnalysisRun,
    ImpactDependency,
    ImpactDiagnostic,
    ImpactFinding,
    ImpactRunStatus,
    ImpactSummary,
    PatchImpactScenario,
    SelectionImpactScenario,
)
from ..schemas.impact_resolution import (
    ImpactResolutionContextPackage,
    ImpactResolutionRequest,
)
from ..schemas.project_document import ProjectDocument
from .comparison import (
    ImpactIntegrityChange,
    ImpactPatchComparator,
    ImpactPatchComparisonError,
)
from .context import ImpactContextBuilderError, ImpactResolutionContextBuilder
from .index import ImpactDependencyIndex
from .projection import ProjectDependencyProjector
from .traversal import ImpactDependencyTraversal, ImpactTraversalResult

MAX_RETAINED_IMPACT_RUNS = 64


@dataclass(frozen=True)
class ImpactResolutionValidationInput:
    """Immutable deterministic source retained for alternative validation."""

    document: ProjectDocument
    analysis_request: ImpactAnalysisRequest
    impact_before: ImpactSummary


class ImpactRunCoordinatorError(ValueError):
    """Stable API failure raised before a run result can be returned."""

    def __init__(self, code: str, **parameters: object) -> None:
        super().__init__(code)
        self.code = code
        self.parameters = parameters


class ImpactRunCoordinator:
    """Run bounded analysis off-lock and publish only against its exact snapshot."""

    def __init__(
        self,
        project_sessions: ProjectSessionRegistry,
        *,
        executor: Executor | None = None,
        traversal_factory: Callable[[], ImpactDependencyTraversal] = ImpactDependencyTraversal,
        comparator_factory: Callable[[], ImpactPatchComparator] = ImpactPatchComparator,
        clock: Callable[[], datetime] = lambda: datetime.now(UTC),
        run_id_factory: Callable[[], str] = lambda: str(uuid4()),
        max_retained_runs: int = MAX_RETAINED_IMPACT_RUNS,
    ) -> None:
        if max_retained_runs < 1:
            raise ValueError("impact coordinator requires a positive run limit")
        self._project_sessions = project_sessions
        self._executor = executor or ThreadPoolExecutor(
            max_workers=2,
            thread_name_prefix="stt-impact",
        )
        self._owns_executor = executor is None
        self._traversal_factory = traversal_factory
        self._comparator_factory = comparator_factory
        self._clock = clock
        self._run_id_factory = run_id_factory
        self._max_retained_runs = max_retained_runs
        self._runs: dict[str, ImpactAnalysisRun] = {}
        self._run_sessions: dict[str, str] = {}
        self._inputs: dict[str, ImpactAnalysisInput] = {}
        self._cancellations: dict[str, Event] = {}
        self._futures: dict[str, Future[None]] = {}
        self._guard = RLock()

    def start(
        self,
        session_id: str,
        request: ImpactAnalysisRequest,
    ) -> ImpactAnalysisRun:
        captured = self._project_sessions.capture_impact_input(session_id, request)
        run = ImpactAnalysisRun(
            id=self._run_id_factory(),
            project_id=captured.project_id,
            saved_revision=captured.saved_revision,
            history_revision=captured.history_revision,
            source_checksum=captured.source_checksum,
            status="queued",
            request=request,
            started_at=self._clock(),
        )
        with self._guard:
            self._evict_terminal_runs()
            if len(self._runs) >= self._max_retained_runs:
                raise ImpactRunCoordinatorError(
                    "impact_run_capacity_reached",
                    max_retained_runs=self._max_retained_runs,
                )
            if run.id in self._runs:
                raise ImpactRunCoordinatorError("impact_run_id_duplicate", run_id=run.id)
            cancellation = Event()
            self._runs[run.id] = run
            self._run_sessions[run.id] = session_id
            self._inputs[run.id] = captured
            self._cancellations[run.id] = cancellation
            try:
                future = self._executor.submit(self._execute, run.id)
            except Exception as error:
                self._remove(run.id)
                raise ImpactRunCoordinatorError("impact_run_failed") from error
            self._futures[run.id] = future
            future.add_done_callback(lambda _: self._forget_future(run.id))
        return run

    def inspect(self, session_id: str, run_id: str) -> ImpactAnalysisRun:
        with self._guard:
            return self._require_owned_run(session_id, run_id)

    def cancel(self, session_id: str, run_id: str) -> ImpactAnalysisRun:
        """Request cooperative cancellation and retain the run until it acknowledges."""

        with self._guard:
            run = self._require_owned_run(session_id, run_id)
            if run.status in {"queued", "running"}:
                self._cancellations[run_id].set()
            return run

    def build_resolution_context(
        self,
        session_id: str,
        request: ImpactResolutionRequest,
    ) -> ImpactResolutionContextPackage:
        """Project a provider-safe package from the exact retained Impact snapshot."""

        context, _ = self.prepare_resolution(session_id, request)
        return context

    def prepare_resolution(
        self,
        session_id: str,
        request: ImpactResolutionRequest,
    ) -> tuple[ImpactResolutionContextPackage, ImpactResolutionValidationInput]:
        """Capture provider context and validation source under one publication guard."""

        with self._guard:
            run = self._require_owned_run(session_id, request.impact_run_id)
            captured = self._inputs.get(run.id)
            if captured is None:
                raise ImpactRunCoordinatorError(
                    "impact_resolution_finding_invalid", reason="snapshot_missing"
                )
        try:
            with self._project_sessions.impact_publication_guard(session_id, captured):
                context = ImpactResolutionContextBuilder().build(captured, run, request)
                validation = ImpactResolutionValidationInput(
                    document=ProjectDocument.model_validate(
                        captured.document.model_dump(mode="json")
                    ),
                    analysis_request=captured.request,
                    impact_before=run.summary,
                )
                return context, validation
        except ImpactContextBuilderError as error:
            raise ImpactRunCoordinatorError(error.code, **error.parameters) from error
        except ProjectSessionError as error:
            raise ImpactRunCoordinatorError("impact_resolution_run_stale") from error

    def assert_resolution_current(self, session_id: str, run_id: str) -> None:
        """Guard provider publication against edits after context assembly."""

        with self._guard:
            run = self._require_owned_run(session_id, run_id)
            captured = self._inputs.get(run.id)
            if captured is None or run.status != "completed":
                raise ImpactRunCoordinatorError("impact_resolution_run_stale")
        try:
            with self._project_sessions.impact_publication_guard(session_id, captured):
                return
        except ProjectSessionError as error:
            raise ImpactRunCoordinatorError("impact_resolution_run_stale") from error

    def invalidate_project(self, project_id: str) -> None:
        """Make completed highlights non-authoritative after an authoring commit."""

        with self._guard:
            for run_id, run in tuple(self._runs.items()):
                if run.project_id != project_id:
                    continue
                self._cancellations[run_id].set()
                if run.status in {"queued", "running", "completed"}:
                    self._runs[run_id] = self._terminal_run(
                        run,
                        "stale",
                        diagnostic=_diagnostic("impact_run_stale"),
                    )

    def clear_session(self, session_id: str, project_id: str | None = None) -> None:
        """Evict all operational state when the owning project session closes."""

        with self._guard:
            for run_id, owned_session in tuple(self._run_sessions.items()):
                run = self._runs.get(run_id)
                if owned_session != session_id and (
                    project_id is None or run is None or run.project_id != project_id
                ):
                    continue
                cancellation = self._cancellations.get(run_id)
                if cancellation is not None:
                    cancellation.set()
                self._remove(run_id)

    def clear_all(self) -> None:
        with self._guard:
            for cancellation in self._cancellations.values():
                cancellation.set()
            self._runs.clear()
            self._run_sessions.clear()
            self._inputs.clear()
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
                captured = self._inputs.get(run_id)
                cancellation = self._cancellations.get(run_id)
                if run is None or captured is None or cancellation is None:
                    return
                if cancellation.is_set():
                    self._publish_cancelled(run_id)
                    return
                self._runs[run_id] = run.model_copy(update={"status": "running"})

            result = self._analyze(captured, cancellation)
            if result.cancelled or cancellation.is_set():
                self._publish_cancelled(run_id)
                return
            if any(item.code == "impact_seed_not_found" for item in result.diagnostics):
                self._publish_terminal(
                    run_id,
                    "failed",
                    diagnostics=result.diagnostics,
                )
                return
            with self._project_sessions.impact_publication_guard(
                self._run_sessions[run_id],
                captured,
            ):
                self._publish_terminal(
                    run_id,
                    "completed",
                    findings=result.findings,
                    summary=result.summary,
                    diagnostics=result.diagnostics,
                )
        except ImpactPatchComparisonError as error:
            self._publish_terminal(
                run_id,
                "failed",
                diagnostics=(_diagnostic(error.code, error.parameters),),
            )
        except (ProjectSessionError, KeyError):
            self._publish_terminal(
                run_id,
                "stale",
                diagnostics=(_diagnostic("impact_run_stale"),),
            )
        except ProjectPatchError as error:
            self._publish_terminal(
                run_id,
                "failed",
                diagnostics=(_diagnostic("impact_patch_invalid", {"reason": str(error)}),),
            )
        except Exception:
            self._publish_terminal(
                run_id,
                "failed",
                diagnostics=(_diagnostic("impact_run_failed"),),
            )

    def _analyze(
        self,
        captured: ImpactAnalysisInput,
        cancellation: Event,
    ) -> ImpactTraversalResult:
        request = captured.request
        projector = ProjectDependencyProjector()
        source_index = projector.project(captured.document)
        if isinstance(request.scenario, SelectionImpactScenario):
            index = source_index
            seeds = request.scenario.seeds
        else:
            assert isinstance(request.scenario, PatchImpactScenario)
            comparison = self._comparator_factory().compare(
                captured.document,
                request.scenario.patch,
            )
            if cancellation.is_set():
                return _cancelled_traversal()
            candidate = apply_project_patch(captured.document, request.scenario.patch)
            candidate_index = projector.project(candidate)
            index = _comparison_index(source_index, candidate_index, comparison.integrity_changes)
            seeds = comparison.seeds
        return self._traversal_factory().traverse(
            index,
            seeds=seeds,
            direction=request.direction,
            domains=request.domains,
            limits=request.limits,
            is_cancelled=cancellation.is_set,
        )

    def _publish_cancelled(self, run_id: str) -> None:
        self._publish_terminal(
            run_id,
            "cancelled",
            diagnostics=(_diagnostic("impact_run_cancelled"),),
        )

    def _publish_terminal(
        self,
        run_id: str,
        status: ImpactRunStatus,
        *,
        findings: tuple[ImpactFinding, ...] = (),
        summary: ImpactSummary | None = None,
        diagnostics: tuple[ImpactDiagnostic, ...] = (),
    ) -> None:
        with self._guard:
            run = self._runs.get(run_id)
            if run is None or run.status in {"cancelled", "stale"}:
                return
            self._runs[run_id] = self._terminal_run(
                run,
                status,
                findings=findings,
                summary=summary,
                diagnostics=diagnostics,
            )

    def _terminal_run(
        self,
        run: ImpactAnalysisRun,
        status: ImpactRunStatus,
        *,
        findings: tuple[ImpactFinding, ...] = (),
        summary: ImpactSummary | None = None,
        diagnostics: tuple[ImpactDiagnostic, ...] = (),
        diagnostic: ImpactDiagnostic | None = None,
    ) -> ImpactAnalysisRun:
        selected_diagnostics = diagnostics or ((diagnostic,) if diagnostic else ())
        payload = run.model_dump(mode="python")
        payload.update(
            {
                "status": status,
                "findings": findings if status == "completed" else (),
                "summary": summary if status == "completed" and summary else ImpactSummary(),
                "diagnostics": selected_diagnostics,
                "completed_at": self._clock(),
            }
        )
        return ImpactAnalysisRun.model_validate(payload)

    def _require_owned_run(self, session_id: str, run_id: str) -> ImpactAnalysisRun:
        run = self._runs.get(run_id)
        if run is None or self._run_sessions.get(run_id) != session_id:
            raise ImpactRunCoordinatorError("impact_run_not_found", run_id=run_id)
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
        self._run_sessions.pop(run_id, None)
        self._inputs.pop(run_id, None)
        self._cancellations.pop(run_id, None)
        self._futures.pop(run_id, None)

    def _forget_future(self, run_id: str) -> None:
        with self._guard:
            self._futures.pop(run_id, None)


def _comparison_index(
    before: ImpactDependencyIndex,
    after: ImpactDependencyIndex,
    integrity_changes: tuple[ImpactIntegrityChange, ...],
) -> ImpactDependencyIndex:
    resources = [*before.resources, *after.resources]
    dependencies = [*before.dependencies, *after.dependencies]
    for change in integrity_changes:
        candidate = change.candidate
        candidate_ref = candidate.scope.model_copy(
            update={
                "owner_type": "canon_candidate",
                "owner_id": candidate.fingerprint,
                "context_type": candidate.scope.owner_type,
                "context_id": candidate.scope.owner_id,
            }
        )
        resources.append(candidate_ref)
        for target in candidate.targets:
            dependencies.append(
                ImpactDependency(
                    source=target,
                    target=candidate_ref,
                    domain="canon",
                    kind=f"canon.patch-integrity-{change.change}",
                    propagation="required",
                    message_key=f"impact.comparison.integrity.{change.change}",
                    message_parameters={
                        "rule_id": candidate.rule_id,
                        "fingerprint": candidate.fingerprint,
                    },
                    evidence=candidate.evidence,
                )
            )
    return ImpactDependencyIndex.build(
        project_id=before.project_id,
        source_checksum=before.source_checksum,
        resources=resources,
        dependencies=dependencies,
    )


def _diagnostic(code: str, parameters: dict[str, object] | None = None) -> ImpactDiagnostic:
    return ImpactDiagnostic(
        code=code,
        message_key=f"impact.error.{code}",
        parameters=parameters or {},
    )


def _cancelled_traversal() -> ImpactTraversalResult:
    return ImpactTraversalResult(
        findings=(),
        summary=ImpactSummary(),
        diagnostics=(_diagnostic("impact_run_cancelled"),),
        cancelled=True,
    )
