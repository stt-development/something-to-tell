"""Process-local candidate runs with one explicit history-owned acceptance route."""

from collections.abc import Callable
from typing import Annotated, TypeVar

from fastapi import APIRouter, Depends, Header, HTTPException, status
from pydantic import ValidationError

from ...agent_memory.resolver import (
    AgentMemoryResolutionError,
    AgentMemoryResolver,
    AgentMemorySnapshot,
)
from ...agent_memory.service import AgentMemoryPersistenceError, AgentMemoryService
from ...agent_memory.candidate_coordinator import (
    AgentMemoryCandidateCoordinator,
    AgentMemoryCandidateCoordinatorError,
)
from ...project_history.service import ProjectHistoryError
from ...project_session.service import ProjectSessionError, ProjectSessionRegistry
from ...schemas.agent_memory import (
    AgentMemoryCandidateAcceptanceV1,
    AgentMemoryDeletionImpactV1,
    AgentMemoryListResponseV1,
    AgentMemoryMutationCommandV1,
    AgentMemoryMutationResponseV1,
    AgentMemoryResolutionRequestV1,
    AgentMemoryResolutionV1,
)
from ...schemas.agent_memory_candidate import (
    AgentMemoryCandidateAcceptanceResponseV1,
    AgentMemoryCandidateRequestV1,
    AgentMemoryCandidateRetryV1,
    AgentMemoryCandidateReviewV1,
    AgentMemoryCandidateRunResponseV1,
)
from ...schemas.engine_tags import EngineTagIntegrityReportV1, EngineTagMutationCommandV1, EngineTagMutationResponseV1
from ...schemas.engine_tags import EngineTagProjectionRequestV1, EngineTagProjectionV1
from ...engine_tags.projection import EngineTagProjectionService
from ..dependencies import get_agent_memory_candidate_runs
from .project_sessions import get_project_session_registry

router = APIRouter(prefix="/agent-memory", tags=["agent-memory"])
engine_tag_router = APIRouter(prefix="/engine-tags/registry", tags=["engine-tags"])
RunsDep = Annotated[
    AgentMemoryCandidateCoordinator,
    Depends(get_agent_memory_candidate_runs),
]
ResultT = TypeVar("ResultT")
RegistryDep = Annotated[ProjectSessionRegistry, Depends(get_project_session_registry)]


@engine_tag_router.get("", response_model=EngineTagMutationResponseV1)
def inspect_engine_tag_registry(
    session_id: str,
    registry: RegistryDep,
) -> EngineTagMutationResponseV1:
    """Expose the current registry checkpoint without mutating the session."""

    current = registry.inspect(session_id)
    history = registry.inspect_history(session_id)
    from ...engine_tags.service import EngineTagRegistryService

    return EngineTagMutationResponseV1(
        catalog=EngineTagRegistryService().catalog(current.document),
        source_checksum=current.document.checksum,
        history_revision=history.history_revision,
    )


@engine_tag_router.post("/commands", response_model=EngineTagMutationResponseV1)
def apply_engine_tag_registry_command(
    payload: EngineTagMutationCommandV1,
    registry: RegistryDep,
    project_session_id: str = Header(alias="X-Project-Session-Id"),
) -> EngineTagMutationResponseV1:
    """Apply one checksum/history-bound registry command."""

    try:
        return registry.apply_engine_tag_command(project_session_id, payload)
    except (ProjectSessionError, ProjectHistoryError, ValueError, ValidationError) as error:
        raise _management_http_error(error) from error


@engine_tag_router.post("/preview", response_model=EngineTagProjectionV1)
def preview_engine_tag_registry(
    payload: EngineTagProjectionRequestV1,
    session_id: str,
    registry: RegistryDep,
) -> EngineTagProjectionV1:
    """Return a bounded compatibility projection without dirtying the session."""

    current = registry.inspect(session_id)
    return EngineTagProjectionService().project(current.document, payload.target)


@engine_tag_router.get("/integrity", response_model=EngineTagIntegrityReportV1)
def inspect_engine_tag_integrity(
    session_id: str,
    registry: RegistryDep,
) -> EngineTagIntegrityReportV1:
    """Return registry-only diagnostics without creating Canon Issues or dirtying the session."""

    from ...engine_tags.service import EngineTagRegistryService

    current = registry.inspect(session_id)
    return EngineTagRegistryService().integrity(current.document)


@router.get("", response_model=AgentMemoryListResponseV1)
def list_agent_memory(
    session_id: str,
    registry: RegistryDep,
) -> AgentMemoryListResponseV1:
    """Read current durable memory with the checksum/history needed for commands."""

    try:
        current = registry.inspect(session_id)
        history = registry.inspect_history(session_id)
        return AgentMemoryListResponseV1(
            catalog=AgentMemoryService().catalog(current.document),
            source_checksum=current.document.checksum,
            history_revision=history.history_revision,
        )
    except ProjectSessionError as error:
        raise _management_http_error(error) from error


@router.get(
    "/{memory_id}/deletion-impact",
    response_model=AgentMemoryDeletionImpactV1,
)
def inspect_agent_memory_deletion_impact(
    memory_id: str,
    session_id: str,
    registry: RegistryDep,
) -> AgentMemoryDeletionImpactV1:
    """Require a fresh deterministic review before destructive deletion."""

    try:
        current = registry.inspect(session_id)
        return AgentMemoryService().deletion_impact(current.document, memory_id)
    except (ProjectSessionError, AgentMemoryPersistenceError) as error:
        raise _management_http_error(error) from error


@router.post("/commands", response_model=AgentMemoryMutationResponseV1)
def apply_agent_memory_command(
    payload: AgentMemoryMutationCommandV1,
    registry: RegistryDep,
    project_session_id: str = Header(alias="X-Project-Session-Id"),
) -> AgentMemoryMutationResponseV1:
    """Apply one optimistic manual action and no implicit Save."""

    try:
        return registry.apply_agent_memory_command(project_session_id, payload)
    except (
        AgentMemoryPersistenceError,
        ProjectHistoryError,
        ProjectSessionError,
        ValidationError,
        ValueError,
    ) as error:
        raise _management_http_error(error) from error


@router.post("/resolve", response_model=AgentMemoryResolutionV1)
def resolve_agent_memory(
    payload: AgentMemoryResolutionRequestV1,
    registry: RegistryDep,
    project_session_id: str = Header(alias="X-Project-Session-Id"),
) -> AgentMemoryResolutionV1:
    """Resolve the exact disclosure against current session truth without writes."""

    try:
        current = registry.inspect(project_session_id)
        history = registry.inspect_history(project_session_id)
        snapshot = AgentMemorySnapshot.from_document(
            current.document,
            history_revision=history.history_revision,
        )
        return AgentMemoryResolver().resolve(snapshot, payload)
    except (ProjectSessionError, AgentMemoryResolutionError, ValueError) as error:
        raise _management_http_error(error) from error


@router.post(
    "/candidate-runs",
    response_model=AgentMemoryCandidateRunResponseV1,
    status_code=status.HTTP_201_CREATED,
)
def start_agent_memory_candidate_run(
    payload: AgentMemoryCandidateRequestV1,
    runs: RunsDep,
) -> AgentMemoryCandidateRunResponseV1:
    return _call(lambda: AgentMemoryCandidateRunResponseV1(run=runs.start(payload)))


@router.get("/candidate-runs/{run_id}", response_model=AgentMemoryCandidateRunResponseV1)
def inspect_agent_memory_candidate_run(
    run_id: str,
    session_id: str,
    runs: RunsDep,
) -> AgentMemoryCandidateRunResponseV1:
    return _call(
        lambda: AgentMemoryCandidateRunResponseV1(run=runs.inspect(session_id, run_id))
    )


@router.post("/candidate-runs/{run_id}/cancel", response_model=AgentMemoryCandidateRunResponseV1)
def cancel_agent_memory_candidate_run(
    run_id: str,
    session_id: str,
    runs: RunsDep,
) -> AgentMemoryCandidateRunResponseV1:
    return _call(
        lambda: AgentMemoryCandidateRunResponseV1(run=runs.cancel(session_id, run_id))
    )


@router.post(
    "/candidate-runs/{run_id}/retry",
    response_model=AgentMemoryCandidateRunResponseV1,
    status_code=status.HTTP_201_CREATED,
)
def retry_agent_memory_candidate_run(
    run_id: str,
    session_id: str,
    payload: AgentMemoryCandidateRetryV1,
    runs: RunsDep,
) -> AgentMemoryCandidateRunResponseV1:
    return _call(
        lambda: AgentMemoryCandidateRunResponseV1(
            run=runs.retry(session_id, run_id, payload)
        )
    )


@router.post("/candidate-runs/{run_id}/reject", response_model=AgentMemoryCandidateRunResponseV1)
def reject_agent_memory_candidate_run(
    run_id: str,
    session_id: str,
    payload: AgentMemoryCandidateReviewV1,
    runs: RunsDep,
) -> AgentMemoryCandidateRunResponseV1:
    return _call(
        lambda: AgentMemoryCandidateRunResponseV1(
            run=runs.reject(session_id, run_id, payload)
        )
    )


@router.post(
    "/candidate-runs/{run_id}/accept",
    response_model=AgentMemoryCandidateAcceptanceResponseV1,
)
def accept_agent_memory_candidate(
    run_id: str,
    session_id: str,
    payload: AgentMemoryCandidateAcceptanceV1,
    runs: RunsDep,
) -> AgentMemoryCandidateAcceptanceResponseV1:
    """Persist only the exact reviewed candidate through project history."""

    def operation() -> AgentMemoryCandidateAcceptanceResponseV1:
        result, run = runs.accept(session_id, run_id, payload)
        return AgentMemoryCandidateAcceptanceResponseV1(result=result, run=run)

    return _call(operation)


def _call(operation: Callable[[], ResultT]) -> ResultT:
    """Map redacted lifecycle errors without returning provider payloads."""

    try:
        return operation()
    except AgentMemoryCandidateCoordinatorError as error:
        if error.code == "agent_memory_candidate_run_not_found":
            status_code = status.HTTP_404_NOT_FOUND
        elif error.code == "agent_memory_candidate_run_capacity_reached":
            status_code = status.HTTP_429_TOO_MANY_REQUESTS
        elif error.code.endswith("stale"):
            status_code = status.HTTP_409_CONFLICT
        else:
            status_code = status.HTTP_400_BAD_REQUEST
        raise HTTPException(
            status_code=status_code,
            detail={
                "code": error.code,
                "message_key": f"agentMemory.error.{error.code}",
                "parameters": error.parameters,
            },
        ) from error


def _management_http_error(error: Exception) -> HTTPException:
    """Map manual authoring failures without exposing rejected entry content."""

    code = getattr(error, "code", "agent_memory_invalid")
    parameters = getattr(error, "parameters", {})
    if code == "agent_memory_not_found" or code == "project_session_not_found":
        status_code = status.HTTP_404_NOT_FOUND
    elif code.endswith("stale") or code in {
        "agent_memory_duplicate",
        "agent_memory_delete_review_required",
    }:
        status_code = status.HTTP_409_CONFLICT
    else:
        status_code = status.HTTP_400_BAD_REQUEST
    return HTTPException(
        status_code=status_code,
        detail={
            "code": code,
            "message_key": f"agentMemory.error.{code}",
            "parameters": parameters,
        },
    )
