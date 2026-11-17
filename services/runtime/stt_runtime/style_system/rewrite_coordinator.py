"""Cancellable process-local lifecycle for bounded Style recommendations."""

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
from ..project_history.service import ProjectHistoryError
from ..project_session.service import ProjectSessionError, ProjectSessionRegistry
from ..schemas.style_rewrite import (
    StyleProviderDisclosureV1,
    StyleRecommendationV1,
    StyleRewriteRequestV1,
    StyleRewriteApprovalV1,
    StyleRewriteRetryV1,
    StyleRewriteRunStatus,
    StyleRewriteRunV1,
    StyleRewriteContextPackageV1,
)
from ..schemas.project_document import ProjectDocument
from ..schemas.project_history import ProjectHistoryMutationResponse
from .rewrite_agent import StyleRewriteAgentError, StyleRewriteAgentService
from .rewrite_context import StyleRewriteContextBuilder, StyleRewriteContextError
from .rewrite_validation import StyleRewriteValidator

MAX_RETAINED_STYLE_RUNS = 64


class StyleRewriteCoordinatorError(ValueError):
    """Redacted API failure raised before or while locating a run."""

    def __init__(self, code: str, **parameters: object) -> None:
        super().__init__(code)
        self.code = code
        self.parameters = parameters


class StyleRewriteCoordinator:
    """Own asynchronous recommendations without mutating project persistence."""

    def __init__(
        self,
        sessions: ProjectSessionRegistry,
        provider_profiles: CanonProviderProfileRegistry,
        *,
        agent: StyleRewriteAgentService | None = None,
        executor: Executor | None = None,
        clock: Callable[[], datetime] = lambda: datetime.now(UTC),
        run_id_factory: Callable[[], str] = lambda: str(uuid4()),
        max_retained_runs: int = MAX_RETAINED_STYLE_RUNS,
        validator: StyleRewriteValidator | None = None,
    ) -> None:
        if max_retained_runs < 1:
            raise ValueError("style rewrite coordinator requires a positive run limit")
        self._sessions = sessions
        self._provider_profiles = provider_profiles
        self._agent = agent or StyleRewriteAgentService()
        self._validator = validator or StyleRewriteValidator()
        self._executor = executor or ThreadPoolExecutor(max_workers=2, thread_name_prefix="stt-style")
        self._owns_executor = executor is None
        self._clock = clock
        self._run_id_factory = run_id_factory
        self._max_retained_runs = max_retained_runs
        self._runs: dict[str, StyleRewriteRunV1] = {}
        self._contexts: dict[str, StyleRewriteContextPackageV1] = {}
        self._profiles: dict[str, CanonProviderProfile] = {}
        self._models: dict[str, str] = {}
        self._run_sessions: dict[str, str] = {}
        self._cancellations: dict[str, Event] = {}
        self._futures: dict[str, Future[None]] = {}
        self._guard = RLock()

    def start(
        self,
        request: StyleRewriteRequestV1,
        *,
        predecessor_run_id: str | None = None,
    ) -> StyleRewriteRunV1:
        """Capture exact text, history, style, and provider settings before dispatch."""

        try:
            current = self._sessions.inspect(request.session_id)
            history = self._sessions.inspect_history(request.session_id)
        except ProjectSessionError as error:
            raise StyleRewriteCoordinatorError(error.code, **error.parameters) from error
        if history.history_revision != request.expected_history_revision:
            raise StyleRewriteCoordinatorError(
                "style_rewrite_run_stale",
                expected_history_revision=request.expected_history_revision,
                history_revision=history.history_revision,
            )
        try:
            context = StyleRewriteContextBuilder().build(
                current.document, history.history_revision, request
            )
        except StyleRewriteContextError as error:
            raise StyleRewriteCoordinatorError(error.code, **error.parameters) from error
        try:
            profile, model_id = self._configuration(current.document)
        except StyleRewriteAgentError as error:
            raise StyleRewriteCoordinatorError(error.code, **error.parameters) from error
        except CanonProviderProfileError as error:
            raise StyleRewriteCoordinatorError(
                "style_rewrite_provider_unavailable", profile_id=error.profile_id
            ) from error
        run = StyleRewriteRunV1(
            id=self._run_id_factory(),
            project_id=current.session.project_id,
            request=request,
            style_profile_id=context.style_profile_id,
            style_profile_name=context.style_profile_name,
            source_checksum=context.document_checksum,
            source_text_checksum=context.source_text_checksum,
            history_revision=context.history_revision,
            predecessor_run_id=predecessor_run_id,
            status="queued",
            progress=0,
            started_at=self._clock(),
        )
        with self._guard:
            self._evict_terminal_runs()
            if len(self._runs) >= self._max_retained_runs:
                raise StyleRewriteCoordinatorError("style_rewrite_run_capacity_reached")
            self._runs[run.id] = run
            self._contexts[run.id] = context
            self._profiles[run.id] = profile
            self._models[run.id] = model_id
            self._run_sessions[run.id] = request.session_id
            self._cancellations[run.id] = Event()
            try:
                self._futures[run.id] = self._executor.submit(self._execute, run.id)
            except Exception as error:
                self._remove(run.id)
                raise StyleRewriteCoordinatorError("style_rewrite_run_failed") from error
        return run

    def inspect(self, session_id: str, run_id: str) -> StyleRewriteRunV1:
        with self._guard:
            return self._require_owned(session_id, run_id)

    def cancel(self, session_id: str, run_id: str) -> StyleRewriteRunV1:
        with self._guard:
            run = self._require_owned(session_id, run_id)
            if run.status in {"queued", "running"}:
                self._cancellations[run_id].set()
            return run

    def retry(
        self,
        session_id: str,
        run_id: str,
        retry: StyleRewriteRetryV1,
    ) -> StyleRewriteRunV1:
        with self._guard:
            predecessor = self._require_owned(session_id, run_id)
            if predecessor.status in {"queued", "running"}:
                raise StyleRewriteCoordinatorError("style_rewrite_run_active", run_id=run_id)
        request = predecessor.request.model_copy(update={
            "observed_source_checksum": retry.observed_source_checksum,
            "expected_history_revision": retry.expected_history_revision,
            "additional_instructions": retry.additional_instructions,
            "content_consent": retry.content_consent,
        })
        return self.start(request, predecessor_run_id=run_id)

    def approve(
        self,
        session_id: str,
        run_id: str,
        command: StyleRewriteApprovalV1,
    ) -> tuple[ProjectHistoryMutationResponse, StyleRewriteRunV1]:
        """Revalidate recommendation identity before one history-owned mutation."""

        with self._guard:
            run = self._require_owned(session_id, run_id)
            recommendation = run.recommendation
        if (
            run.status != "completed"
            or recommendation is None
            or recommendation.validation_status != "valid"
            or recommendation.patch is None
            or recommendation.id != command.recommendation_id
            or run.source_checksum != command.source_checksum
        ):
            raise StyleRewriteCoordinatorError("style_rewrite_patch_invalid")
        try:
            result = self._sessions.approve_style_rewrite(
                session_id,
                patch=recommendation.patch,
                expected_history_revision=command.expected_history_revision,
                recommendation_id=recommendation.id,
            )
        except (ProjectSessionError, ProjectHistoryError) as error:
            raise StyleRewriteCoordinatorError(error.code, **error.parameters) from error
        # The session callback intentionally marks the source-bound run stale;
        # retaining its validated preview allows the approval response to explain it.
        with self._guard:
            return result, self._require_owned(session_id, run_id)

    def invalidate_project(self, project_id: str) -> None:
        """Preserve visibility while making every old snapshot explicitly stale."""

        with self._guard:
            for run_id, run in tuple(self._runs.items()):
                if run.project_id != project_id or run.status in {"failed", "cancelled", "stale"}:
                    continue
                self._cancellations[run_id].set()
                self._runs[run_id] = self._terminal(run, "stale", error_code="style_rewrite_run_stale")

    def clear_session(self, session_id: str, project_id: str | None = None) -> None:
        with self._guard:
            for run_id, owner in tuple(self._run_sessions.items()):
                run = self._runs.get(run_id)
                if owner == session_id or (project_id is not None and run and run.project_id == project_id):
                    self._cancellations[run_id].set()
                    self._remove(run_id)

    def clear_all(self) -> None:
        with self._guard:
            for cancellation in self._cancellations.values():
                cancellation.set()
            futures = tuple(self._futures.values())
            self._runs.clear()
            self._contexts.clear()
            self._profiles.clear()
            self._models.clear()
            self._run_sessions.clear()
            self._cancellations.clear()
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
                profile = self._profiles.get(run_id)
                model_id = self._models.get(run_id)
                cancellation = self._cancellations.get(run_id)
                session_id = self._run_sessions.get(run_id)
                if (
                    run is None
                    or context is None
                    or profile is None
                    or model_id is None
                    or cancellation is None
                    or session_id is None
                ):
                    return
                if cancellation.is_set():
                    self._publish(run_id, "cancelled", error_code="style_rewrite_run_cancelled")
                    return
                self._runs[run_id] = run.model_copy(update={"status": "running", "progress": 25})
            response = self._agent.run(profile, model_id, context)
            if cancellation.is_set():
                self._publish(run_id, "cancelled", error_code="style_rewrite_run_cancelled")
                return
            current = self._sessions.inspect(session_id)
            history = self._sessions.inspect_history(session_id)
            if current.document.checksum != run.source_checksum or history.history_revision != run.history_revision:
                self._publish(run_id, "stale", error_code="style_rewrite_run_stale")
                return
            recommendation = self._validator.validate(
                current.document,
                context,
                response,
                StyleProviderDisclosureV1(
                    provider=profile.provider,
                    provider_profile_id=profile.profile_id,
                    model_id=model_id,
                    content_locale=context.content_locale,
                ),
                f"style-recommendation-{run.id}",
            )
            self._publish(run_id, "completed", recommendation=recommendation)
        except (ProjectSessionError, ProjectHistoryError, StyleRewriteContextError):
            self._publish(run_id, "stale", error_code="style_rewrite_run_stale")
        except CanonProviderProfileError:
            self._publish(run_id, "failed", error_code="style_rewrite_provider_unavailable")
        except StyleRewriteAgentError as error:
            self._publish(run_id, "failed", error_code=error.code)
        except Exception:
            self._publish(run_id, "failed", error_code="style_rewrite_run_failed")

    def _configuration(self, document: ProjectDocument) -> tuple[CanonProviderProfile, str]:
        """Capture one effective machine profile and model before dispatch."""

        settings = document.manifest.settings
        assignment = settings.agent_providers.agents.style_rewriter
        policy = settings.style_system
        profile_id = (
            settings.agent_providers.default_provider_profile_id
            if assignment.provider_source == "project_default"
            else assignment.provider_profile_override_id
        )
        if policy.agent_mode != "configured" or policy.content_policy != "explicit_consent" or profile_id is None or assignment.model_id is None:
            raise StyleRewriteAgentError("style_rewrite_provider_invalid")
        return self._provider_profiles.resolve(profile_id), assignment.model_id

    def _publish(
        self,
        run_id: str,
        status: StyleRewriteRunStatus,
        *,
        recommendation: StyleRecommendationV1 | None = None,
        error_code: str | None = None,
    ) -> None:
        with self._guard:
            run = self._runs.get(run_id)
            if run is None or run.status in {"cancelled", "stale"}:
                return
            self._runs[run_id] = self._terminal(
                run, status, recommendation=recommendation, error_code=error_code
            )

    def _terminal(self, run: StyleRewriteRunV1, status: StyleRewriteRunStatus, **changes: object) -> StyleRewriteRunV1:
        return run.model_copy(update={
            "status": status,
            "progress": 100,
            "completed_at": self._clock(),
            **changes,
        })

    def _require_owned(self, session_id: str, run_id: str) -> StyleRewriteRunV1:
        run = self._runs.get(run_id)
        if run is None or self._run_sessions.get(run_id) != session_id:
            raise StyleRewriteCoordinatorError("style_rewrite_run_not_found", run_id=run_id)
        return run

    def _evict_terminal_runs(self) -> None:
        while len(self._runs) >= self._max_retained_runs:
            run_id = next((key for key, value in self._runs.items() if value.status not in {"queued", "running"}), None)
            if run_id is None:
                return
            self._remove(run_id)

    def _remove(self, run_id: str) -> None:
        self._runs.pop(run_id, None)
        self._contexts.pop(run_id, None)
        self._profiles.pop(run_id, None)
        self._models.pop(run_id, None)
        self._run_sessions.pop(run_id, None)
        self._cancellations.pop(run_id, None)
        self._futures.pop(run_id, None)
