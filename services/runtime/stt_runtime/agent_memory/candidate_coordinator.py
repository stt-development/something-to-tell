"""Cancellable process-local lifecycle for reviewed Agent Memory candidates."""

from __future__ import annotations

from concurrent.futures import Executor, Future, ThreadPoolExecutor
from datetime import UTC, datetime
from hashlib import sha256
import json
from threading import Event, RLock
from typing import Callable
from uuid import uuid4

from pydantic import ValidationError

from ..canon.agent_profiles import (
    CanonProviderProfile,
    CanonProviderProfileError,
    CanonProviderProfileRegistry,
)
from ..project_history.service import ProjectHistoryError
from ..project_session.service import ProjectSessionError, ProjectSessionRegistry
from ..schemas.agent_memory import (
    AgentMemoryCandidateAcceptanceV1,
    AgentMemoryCandidateV1,
    AgentMemoryEntryV1,
)
from ..schemas.agent_memory_candidate import (
    AgentMemoryCandidateContextV1,
    AgentMemoryCandidateProviderDisclosureV1,
    AgentMemoryCandidateRequestV1,
    AgentMemoryCandidateRetryV1,
    AgentMemoryCandidateReviewV1,
    AgentMemoryCandidateRunStatus,
    AgentMemoryCandidateRunV1,
)
from ..schemas.project_history import ProjectHistoryMutationResponse
from .candidate_agent import (
    AgentMemoryCandidateAgentError,
    AgentMemoryCandidateAgentResponse,
    AgentMemoryCandidateAgentService,
)
from .candidate_context import (
    AgentMemoryCandidateContextBuilder,
    AgentMemoryCandidateContextError,
)

MAX_RETAINED_AGENT_MEMORY_CANDIDATE_RUNS = 64


class AgentMemoryCandidateCoordinatorError(ValueError):
    """Stable lifecycle error that never carries provider or authored prose."""

    def __init__(self, code: str, **parameters: object) -> None:
        super().__init__(code)
        self.code = code
        self.parameters = parameters


class AgentMemoryCandidateCoordinator:
    """Own candidate generation while delegating the only write to project history."""

    def __init__(
        self,
        sessions: ProjectSessionRegistry,
        provider_profiles: CanonProviderProfileRegistry,
        *,
        agent: AgentMemoryCandidateAgentService | None = None,
        executor: Executor | None = None,
        clock: Callable[[], datetime] = lambda: datetime.now(UTC),
        run_id_factory: Callable[[], str] = lambda: str(uuid4()),
        memory_id_factory: Callable[[], str] = lambda: str(uuid4()),
        max_retained_runs: int = MAX_RETAINED_AGENT_MEMORY_CANDIDATE_RUNS,
    ) -> None:
        if max_retained_runs < 1:
            raise ValueError("candidate coordinator requires a positive run limit")
        self._sessions = sessions
        self._provider_profiles = provider_profiles
        self._agent = agent or AgentMemoryCandidateAgentService()
        self._executor = executor or ThreadPoolExecutor(
            max_workers=2,
            thread_name_prefix="stt-agent-memory",
        )
        self._owns_executor = executor is None
        self._clock = clock
        self._run_id_factory = run_id_factory
        self._memory_id_factory = memory_id_factory
        self._max_retained_runs = max_retained_runs
        self._runs: dict[str, AgentMemoryCandidateRunV1] = {}
        self._contexts: dict[str, AgentMemoryCandidateContextV1] = {}
        self._profiles: dict[str, CanonProviderProfile] = {}
        self._models: dict[str, str] = {}
        self._run_sessions: dict[str, str] = {}
        self._cancellations: dict[str, Event] = {}
        self._futures: dict[str, Future[None]] = {}
        self._guard = RLock()

    def start(
        self,
        request: AgentMemoryCandidateRequestV1,
        *,
        predecessor_run_id: str | None = None,
    ) -> AgentMemoryCandidateRunV1:
        """Capture exact target and machine provider before asynchronous dispatch."""

        try:
            current = self._sessions.inspect(request.session_id)
            history = self._sessions.inspect_history(request.session_id)
        except ProjectSessionError as error:
            raise AgentMemoryCandidateCoordinatorError(
                error.code, **error.parameters
            ) from error
        if (
            current.session.project_id != request.project_id
            or current.document.checksum != request.observed_source_checksum
            or history.history_revision != request.expected_history_revision
        ):
            raise AgentMemoryCandidateCoordinatorError(
                "agent_memory_candidate_stale",
                project_id=current.session.project_id,
                source_checksum=current.document.checksum,
                history_revision=history.history_revision,
            )
        try:
            context = AgentMemoryCandidateContextBuilder().build(
                current.document,
                request,
            )
            profile, model_id = self._configuration(current.document, request.agent_id)
        except AgentMemoryCandidateContextError as error:
            raise AgentMemoryCandidateCoordinatorError(
                error.code, **error.parameters
            ) from error
        except CanonProviderProfileError as error:
            raise AgentMemoryCandidateCoordinatorError(
                "agent_memory_candidate_provider_unavailable",
                profile_id=error.profile_id,
            ) from error
        run = AgentMemoryCandidateRunV1(
            id=self._run_id_factory(),
            project_id=request.project_id,
            request=request,
            source_checksum=request.observed_source_checksum,
            history_revision=request.expected_history_revision,
            status="queued",
            progress=0,
            predecessor_run_id=predecessor_run_id,
            provider_disclosure=AgentMemoryCandidateProviderDisclosureV1(
                provider=profile.provider,
                provider_profile_id=profile.profile_id,
                model_id=model_id,
            ),
            started_at=self._clock(),
        )
        with self._guard:
            self._evict_terminal_runs()
            if len(self._runs) >= self._max_retained_runs:
                raise AgentMemoryCandidateCoordinatorError(
                    "agent_memory_candidate_run_capacity_reached"
                )
            if run.id in self._runs:
                raise AgentMemoryCandidateCoordinatorError(
                    "agent_memory_candidate_run_failed"
                )
            self._runs[run.id] = run
            self._contexts[run.id] = context
            self._profiles[run.id] = profile
            self._models[run.id] = model_id
            self._run_sessions[run.id] = request.session_id
            self._cancellations[run.id] = Event()
            try:
                future = self._executor.submit(self._execute, run.id)
            except Exception as error:
                self._remove(run.id)
                raise AgentMemoryCandidateCoordinatorError(
                    "agent_memory_candidate_run_failed"
                ) from error
            self._futures[run.id] = future
            future.add_done_callback(lambda _: self._forget_future(run.id))
        return run

    def inspect(self, session_id: str, run_id: str) -> AgentMemoryCandidateRunV1:
        with self._guard:
            return self._require_owned(session_id, run_id)

    def cancel(self, session_id: str, run_id: str) -> AgentMemoryCandidateRunV1:
        with self._guard:
            run = self._require_owned(session_id, run_id)
            if run.status in {"queued", "running"}:
                self._cancellations[run_id].set()
            return run

    def retry(
        self,
        session_id: str,
        run_id: str,
        retry: AgentMemoryCandidateRetryV1,
    ) -> AgentMemoryCandidateRunV1:
        with self._guard:
            predecessor = self._require_owned(session_id, run_id)
            if predecessor.status in {"queued", "running"}:
                raise AgentMemoryCandidateCoordinatorError(
                    "agent_memory_candidate_run_active", run_id=run_id
                )
        request = predecessor.request.model_copy(update={
            "observed_source_checksum": retry.observed_source_checksum,
            "expected_history_revision": retry.expected_history_revision,
            "guidance_request": retry.guidance_request,
            "content_consent": retry.content_consent,
        })
        return self.start(request, predecessor_run_id=run_id)

    def reject(
        self,
        session_id: str,
        run_id: str,
        review: AgentMemoryCandidateReviewV1,
    ) -> AgentMemoryCandidateRunV1:
        """Consume a reviewed candidate without touching project or history state."""

        with self._guard:
            run = self._require_reviewable(session_id, run_id)
            assert run.candidate is not None
            if (
                review.candidate_id != run.candidate.id
                or review.semantic_fingerprint != run.candidate.semantic_fingerprint
            ):
                raise AgentMemoryCandidateCoordinatorError(
                    "agent_memory_candidate_invalid"
                )
            rejected = run.model_copy(update={
                "status": "rejected",
                "progress": 100,
                "completed_at": self._clock(),
            })
            self._runs[run_id] = rejected
            return rejected

    def accept(
        self,
        session_id: str,
        run_id: str,
        acceptance: AgentMemoryCandidateAcceptanceV1,
    ) -> tuple[ProjectHistoryMutationResponse, AgentMemoryCandidateRunV1]:
        """Revalidate every visible identity before creating one durable entry."""

        with self._guard:
            run = self._require_reviewable(session_id, run_id)
            candidate = run.candidate
        assert candidate is not None
        if (
            acceptance.candidate_id != candidate.id
            or acceptance.project_id != candidate.project_id
            or acceptance.agent_id != candidate.agent_id
            or acceptance.namespace != candidate.namespace
            or acceptance.scope != candidate.scope
            or acceptance.content_locale != candidate.content_locale
            or acceptance.source_checksum != candidate.source_checksum
            or acceptance.expected_history_revision != candidate.history_revision
            or acceptance.semantic_fingerprint != candidate.semantic_fingerprint
        ):
            raise AgentMemoryCandidateCoordinatorError("agent_memory_candidate_invalid")
        now = self._clock()
        entry = AgentMemoryEntryV1(
            id=self._memory_id_factory(),
            project_id=candidate.project_id,
            agent_id=candidate.agent_id,
            namespace=candidate.namespace,
            # Re-enter the strict wire boundary instead of leaking a model instance.
            scope=candidate.scope.model_dump(mode="json"),
            content_locale=candidate.content_locale,
            title=candidate.title,
            instruction=candidate.instruction,
            rationale=candidate.rationale,
            status="active",
            supersedes_id=acceptance.supersedes_id,
            created_at=now,
            updated_at=now,
        )
        try:
            result = self._sessions.accept_agent_memory_candidate(
                session_id,
                entry=entry,
                source_checksum=candidate.source_checksum,
                expected_history_revision=candidate.history_revision,
            )
        except (ProjectSessionError, ProjectHistoryError, ValidationError) as error:
            code = getattr(error, "code", "agent_memory_candidate_invalid")
            parameters = getattr(error, "parameters", {})
            raise AgentMemoryCandidateCoordinatorError(code, **parameters) from error
        with self._guard:
            consumed = run.model_copy(update={
                "status": "accepted",
                "progress": 100,
                "completed_at": now,
            })
            self._runs[run_id] = consumed
            return result, consumed

    def invalidate_project(self, project_id: str) -> None:
        """Cancel or stale every unconsumed candidate bound to the old document."""

        with self._guard:
            for run_id, run in tuple(self._runs.items()):
                if run.project_id != project_id or run.status in {
                    "failed", "cancelled", "stale", "rejected", "accepted"
                }:
                    continue
                self._cancellations[run_id].set()
                self._runs[run_id] = self._terminal(
                    run,
                    "stale",
                    error_code="agent_memory_candidate_stale",
                )

    def clear_session(self, session_id: str, project_id: str | None = None) -> None:
        """Erase candidates on close so no provider output survives the process session."""

        with self._guard:
            for run_id, owner in tuple(self._run_sessions.items()):
                run = self._runs.get(run_id)
                if owner == session_id or (
                    project_id is not None and run is not None and run.project_id == project_id
                ):
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
                if not all((run, context, profile, model_id, cancellation, session_id)):
                    return
                assert run is not None and context is not None
                assert profile is not None and model_id is not None
                assert cancellation is not None and session_id is not None
                if cancellation.is_set():
                    self._publish(
                        run_id,
                        "cancelled",
                        error_code="agent_memory_candidate_run_cancelled",
                    )
                    return
                self._runs[run_id] = run.model_copy(
                    update={"status": "running", "progress": 30}
                )
            response = self._agent.run(profile, model_id, context)
            if cancellation.is_set():
                self._publish(
                    run_id,
                    "cancelled",
                    error_code="agent_memory_candidate_run_cancelled",
                )
                return
            current = self._sessions.inspect(session_id)
            history = self._sessions.inspect_history(session_id)
            if (
                current.document.checksum != run.source_checksum
                or history.history_revision != run.history_revision
            ):
                self._publish(
                    run_id,
                    "stale",
                    error_code="agent_memory_candidate_stale",
                )
                return
            candidate = self._candidate(run, response)
            self._publish(run_id, "completed", candidate=candidate)
        except AgentMemoryCandidateAgentError as error:
            self._publish(run_id, "failed", error_code=error.code)
        except ValidationError as error:
            code = str(error.errors()[0]["type"])
            self._publish(run_id, "failed", error_code=code)
        except (ProjectSessionError, ProjectHistoryError, AgentMemoryCandidateContextError):
            self._publish(
                run_id,
                "stale",
                error_code="agent_memory_candidate_stale",
            )
        except Exception:
            self._publish(
                run_id,
                "failed",
                error_code="agent_memory_candidate_run_failed",
            )

    def _candidate(
        self,
        run: AgentMemoryCandidateRunV1,
        response: AgentMemoryCandidateAgentResponse,
    ) -> AgentMemoryCandidateV1:
        payload = {
            "project_id": run.project_id,
            "agent_id": run.request.agent_id,
            "namespace": run.request.namespace,
            "scope": run.request.scope.model_dump(mode="json"),
            "content_locale": run.request.content_locale,
            "title": response.title,
            "instruction": response.instruction,
            "rationale": response.rationale,
            "source_checksum": run.source_checksum,
            "history_revision": run.history_revision,
        }
        fingerprint = sha256(
            json.dumps(
                payload,
                ensure_ascii=False,
                sort_keys=True,
                separators=(",", ":"),
            ).encode("utf-8")
        ).hexdigest()
        return AgentMemoryCandidateV1(
            id=f"candidate-{run.id}",
            semantic_fingerprint=fingerprint,
            created_at=self._clock(),
            **payload,
        )

    def _configuration(
        self,
        document,
        agent_id: str,
    ) -> tuple[CanonProviderProfile, str]:
        """Resolve shared default or per-agent override without persisting secrets."""

        settings = document.manifest.settings.agent_providers
        assignment = getattr(settings.agents, agent_id)
        profile_id = (
            settings.default_provider_profile_id
            if assignment.provider_source == "project_default"
            else assignment.provider_profile_override_id
        )
        if profile_id is None or assignment.model_id is None:
            raise AgentMemoryCandidateCoordinatorError(
                "agent_memory_candidate_provider_invalid"
            )
        return self._provider_profiles.resolve(profile_id), assignment.model_id

    def _publish(
        self,
        run_id: str,
        status: AgentMemoryCandidateRunStatus,
        *,
        candidate: AgentMemoryCandidateV1 | None = None,
        error_code: str | None = None,
    ) -> None:
        with self._guard:
            run = self._runs.get(run_id)
            if run is None or run.status in {
                "cancelled", "stale", "rejected", "accepted"
            }:
                return
            self._runs[run_id] = self._terminal(
                run,
                status,
                candidate=candidate,
                error_code=error_code,
            )

    def _terminal(
        self,
        run: AgentMemoryCandidateRunV1,
        status: AgentMemoryCandidateRunStatus,
        *,
        candidate: AgentMemoryCandidateV1 | None = None,
        error_code: str | None = None,
    ) -> AgentMemoryCandidateRunV1:
        return run.model_copy(update={
            "status": status,
            "progress": 100,
            "candidate": candidate if candidate is not None else run.candidate,
            "error_code": error_code,
            "completed_at": self._clock(),
        })

    def _require_owned(
        self,
        session_id: str,
        run_id: str,
    ) -> AgentMemoryCandidateRunV1:
        run = self._runs.get(run_id)
        if run is None or self._run_sessions.get(run_id) != session_id:
            raise AgentMemoryCandidateCoordinatorError(
                "agent_memory_candidate_run_not_found", run_id=run_id
            )
        return run

    def _require_reviewable(
        self,
        session_id: str,
        run_id: str,
    ) -> AgentMemoryCandidateRunV1:
        run = self._require_owned(session_id, run_id)
        if run.status != "completed" or run.candidate is None:
            raise AgentMemoryCandidateCoordinatorError(
                "agent_memory_candidate_invalid"
            )
        return run

    def _evict_terminal_runs(self) -> None:
        terminal = [
            run
            for run in self._runs.values()
            if run.status not in {"queued", "running"}
        ]
        while len(self._runs) >= self._max_retained_runs and terminal:
            oldest = min(terminal, key=lambda item: (item.started_at, item.id))
            self._remove(oldest.id)
            terminal.remove(oldest)

    def _remove(self, run_id: str) -> None:
        self._runs.pop(run_id, None)
        self._contexts.pop(run_id, None)
        self._profiles.pop(run_id, None)
        self._models.pop(run_id, None)
        self._run_sessions.pop(run_id, None)
        self._cancellations.pop(run_id, None)
        self._futures.pop(run_id, None)

    def _forget_future(self, run_id: str) -> None:
        with self._guard:
            self._futures.pop(run_id, None)
