"""Snapshot-bound process-local Impact Analysis run API."""

from typing import Annotated

from fastapi import APIRouter, Depends, HTTPException, status

from ...impact.coordinator import ImpactRunCoordinator, ImpactRunCoordinatorError
from ...impact.resolution_coordinator import (
    ImpactResolutionCoordinator,
    ImpactResolutionCoordinatorError,
)
from ...project_session.service import ProjectSessionError
from ...schemas.impact_analysis import ImpactAnalysisRequest, ImpactAnalysisResponse
from ...schemas.impact_resolution import (
    ImpactResolutionContextPackage,
    ImpactResolutionDecisionResponse,
    ImpactResolutionDraftEdit,
    ImpactResolutionRequest,
    ImpactResolutionResponse,
    ImpactResolutionReviewCommand,
)
from ..dependencies import get_impact_resolution_runs, get_impact_runs

router = APIRouter(
    prefix="/project-sessions/{session_id}/impact-analysis",
    tags=["impact-analysis"],
)
ImpactRunsDep = Annotated[ImpactRunCoordinator, Depends(get_impact_runs)]
ImpactResolutionRunsDep = Annotated[
    ImpactResolutionCoordinator,
    Depends(get_impact_resolution_runs),
]


@router.post(
    "/runs",
    response_model=ImpactAnalysisResponse,
    status_code=status.HTTP_201_CREATED,
)
def start_impact_run(
    session_id: str,
    payload: ImpactAnalysisRequest,
    runs: ImpactRunsDep,
) -> ImpactAnalysisResponse:
    try:
        return ImpactAnalysisResponse(run=runs.start(session_id, payload))
    except (ImpactRunCoordinatorError, ProjectSessionError) as error:
        raise _impact_api_error(error) from error


@router.get("/runs/{run_id}", response_model=ImpactAnalysisResponse)
def inspect_impact_run(
    session_id: str,
    run_id: str,
    runs: ImpactRunsDep,
) -> ImpactAnalysisResponse:
    try:
        return ImpactAnalysisResponse(run=runs.inspect(session_id, run_id))
    except ImpactRunCoordinatorError as error:
        raise _impact_api_error(error) from error


@router.post("/runs/{run_id}/cancel", response_model=ImpactAnalysisResponse)
def cancel_impact_run(
    session_id: str,
    run_id: str,
    runs: ImpactRunsDep,
) -> ImpactAnalysisResponse:
    try:
        return ImpactAnalysisResponse(run=runs.cancel(session_id, run_id))
    except ImpactRunCoordinatorError as error:
        raise _impact_api_error(error) from error


@router.post(
    "/runs/{run_id}/resolution-context",
    response_model=ImpactResolutionContextPackage,
)
def build_impact_resolution_context(
    session_id: str,
    run_id: str,
    payload: ImpactResolutionRequest,
    runs: ImpactRunsDep,
) -> ImpactResolutionContextPackage:
    """Expose the inspectable payload that a later provider run will receive."""

    if payload.impact_run_id != run_id:
        raise _impact_api_error(
            ImpactRunCoordinatorError(
                "impact_resolution_finding_invalid", reason="run_path_mismatch"
            )
        )
    try:
        return runs.build_resolution_context(session_id, payload)
    except ImpactRunCoordinatorError as error:
        raise _impact_api_error(error) from error


@router.post(
    "/resolution-runs",
    response_model=ImpactResolutionResponse,
    status_code=status.HTTP_201_CREATED,
)
def start_impact_resolution_run(
    session_id: str,
    payload: ImpactResolutionRequest,
    runs: ImpactResolutionRunsDep,
) -> ImpactResolutionResponse:
    try:
        return ImpactResolutionResponse(run=runs.start(session_id, payload))
    except ImpactResolutionCoordinatorError as error:
        raise _impact_api_error(error) from error


@router.get(
    "/resolution-runs/{resolution_run_id}",
    response_model=ImpactResolutionResponse,
)
def inspect_impact_resolution_run(
    session_id: str,
    resolution_run_id: str,
    runs: ImpactResolutionRunsDep,
) -> ImpactResolutionResponse:
    try:
        return ImpactResolutionResponse(run=runs.inspect(session_id, resolution_run_id))
    except ImpactResolutionCoordinatorError as error:
        raise _impact_api_error(error) from error


@router.post(
    "/resolution-runs/{resolution_run_id}/cancel",
    response_model=ImpactResolutionResponse,
)
def cancel_impact_resolution_run(
    session_id: str,
    resolution_run_id: str,
    runs: ImpactResolutionRunsDep,
) -> ImpactResolutionResponse:
    try:
        return ImpactResolutionResponse(run=runs.cancel(session_id, resolution_run_id))
    except ImpactResolutionCoordinatorError as error:
        raise _impact_api_error(error) from error


@router.post(
    "/resolution-runs/{resolution_run_id}/edit",
    response_model=ImpactResolutionResponse,
)
def edit_impact_resolution_alternative(
    session_id: str,
    resolution_run_id: str,
    payload: ImpactResolutionDraftEdit,
    runs: ImpactResolutionRunsDep,
) -> ImpactResolutionResponse:
    try:
        return ImpactResolutionResponse(run=runs.edit(session_id, resolution_run_id, payload))
    except ImpactResolutionCoordinatorError as error:
        raise _impact_api_error(error) from error


@router.post(
    "/resolution-runs/{resolution_run_id}/approve",
    response_model=ImpactResolutionDecisionResponse,
)
def approve_impact_resolution_alternative(
    session_id: str,
    resolution_run_id: str,
    payload: ImpactResolutionReviewCommand,
    runs: ImpactResolutionRunsDep,
) -> ImpactResolutionDecisionResponse:
    try:
        decision, run = runs.review(
            session_id, resolution_run_id, payload, approved=True
        )
        return ImpactResolutionDecisionResponse(decision=decision, run=run)
    except ImpactResolutionCoordinatorError as error:
        raise _impact_api_error(error) from error


@router.post(
    "/resolution-runs/{resolution_run_id}/reject",
    response_model=ImpactResolutionDecisionResponse,
)
def reject_impact_resolution_alternative(
    session_id: str,
    resolution_run_id: str,
    payload: ImpactResolutionReviewCommand,
    runs: ImpactResolutionRunsDep,
) -> ImpactResolutionDecisionResponse:
    try:
        decision, run = runs.review(
            session_id, resolution_run_id, payload, approved=False
        )
        return ImpactResolutionDecisionResponse(decision=decision, run=run)
    except ImpactResolutionCoordinatorError as error:
        raise _impact_api_error(error) from error


def _impact_api_error(error: object) -> HTTPException:
    code = str(getattr(error, "code", "impact_run_failed"))
    parameters = getattr(error, "parameters", {})
    if code in {
        "impact_run_not_found",
        "impact_resolution_run_not_found",
        "project_session_not_found",
    }:
        status_code = status.HTTP_404_NOT_FOUND
    elif code in {
        "impact_run_stale",
        "impact_run_id_duplicate",
        "impact_resolution_run_stale",
        "impact_resolution_patch_stale",
        "history_revision_stale",
    }:
        status_code = status.HTTP_409_CONFLICT
    elif code in {
        "impact_run_capacity_reached",
        "impact_resolution_run_capacity_reached",
    }:
        status_code = status.HTTP_429_TOO_MANY_REQUESTS
    else:
        status_code = status.HTTP_400_BAD_REQUEST
    return HTTPException(
        status_code=status_code,
        detail={
            "code": code,
            "message_key": (
                f"history.error.{code}"
                if code.startswith("history_")
                else (
                    f"impactResolution.error.{code}"
                    if code.startswith("impact_resolution_")
                    else f"impact.error.{code}"
                )
            ),
            "parameters": parameters,
        },
    )
