"""Checksum-bound preview and atomic write routes for pipeline exports."""

from __future__ import annotations

from collections.abc import Callable
from typing import Annotated, TypeVar

from fastapi import APIRouter, Depends, HTTPException, Request, status

from ...export.coordinator import ExportCoordinator
from ...export.errors import ExportOperationError
from ...project_session.service import ProjectSessionError
from ...schemas.export import (
    ExportPlanRequestV1,
    ExportPlanV1,
    ExportWriteRequestV1,
    ExportWriteResultV1,
)

router = APIRouter(prefix="/exports", tags=["exports"])
ResponseT = TypeVar("ResponseT")


def get_export_coordinator(request: Request) -> ExportCoordinator:
    return request.app.state.exports


ExportCoordinatorDep = Annotated[ExportCoordinator, Depends(get_export_coordinator)]


@router.post("/{session_id}/plans", response_model=ExportPlanV1)
def create_export_plan(
    session_id: str,
    payload: ExportPlanRequestV1,
    coordinator: ExportCoordinatorDep,
) -> ExportPlanV1:
    return _call(lambda: coordinator.plan(session_id, payload))


@router.post("/{session_id}/writes", response_model=ExportWriteResultV1)
def write_export_artifact(
    session_id: str,
    payload: ExportWriteRequestV1,
    coordinator: ExportCoordinatorDep,
) -> ExportWriteResultV1:
    return _call(lambda: coordinator.write(session_id, payload))


def _call(operation: Callable[[], ResponseT]) -> ResponseT:
    try:
        return operation()
    except ExportOperationError as error:
        raise HTTPException(
            status_code=_status_code(error.code),
            detail={
                "code": error.code,
                "message_key": error.message_key,
                "parameters": error.parameters,
            },
        ) from error
    except ProjectSessionError as error:
        missing = error.code == "project_session_not_found"
        stale = error.code in {"remote_revision_stale", "remote_generation_mismatch"}
        code = "export_plan_stale" if missing else "export_source_stale" if stale else "export_write_failed"
        raise HTTPException(
            status_code=(
                status.HTTP_404_NOT_FOUND
                if missing
                else status.HTTP_409_CONFLICT if stale
                else status.HTTP_400_BAD_REQUEST
            ),
            detail={
                "code": code,
                "message_key": f"export.error.{code}",
                "parameters": error.parameters,
            },
        ) from error


def _status_code(code: str) -> int:
    if code == "export_permission_denied":
        return status.HTTP_403_FORBIDDEN
    if code in {"export_source_stale", "export_plan_stale", "export_destination_conflict"}:
        return status.HTTP_409_CONFLICT
    if code == "export_write_failed":
        return status.HTTP_500_INTERNAL_SERVER_ERROR
    return status.HTTP_400_BAD_REQUEST
