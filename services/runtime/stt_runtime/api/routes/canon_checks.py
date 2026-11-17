"""Explicit saved-revision canon run and review API."""

from typing import Annotated

from fastapi import APIRouter, Depends, HTTPException, status

from ...canon.coordinator import CanonRunCoordinator, CanonRunCoordinatorError
from ...impact.coordinator import ImpactRunCoordinator, ImpactRunCoordinatorError
from ...project_history.service import ProjectHistoryError
from ...project_session.service import ProjectSessionError
from ...schemas.canon_check import (
    CanonCheckRun,
    CanonFixSuggestionDecision,
    CanonFixSuggestionDecisionResponse,
    CanonIssueListResponse,
    CanonIssueImpactRequest,
    CanonIssueProjection,
    CanonIssueStatusChange,
    CanonIssueSuggestionRequest,
    CanonIssueSuggestionResponse,
    CanonRunStart,
)
from ...schemas.impact_analysis import ImpactAnalysisResponse
from ..dependencies import get_canon_runs, get_impact_runs

router = APIRouter(prefix="/canon-checks", tags=["canon-checks"])
CanonRunsDep = Annotated[CanonRunCoordinator, Depends(get_canon_runs)]
ImpactRunsDep = Annotated[ImpactRunCoordinator, Depends(get_impact_runs)]


@router.post(
    "/runs",
    response_model=CanonCheckRun,
    status_code=status.HTTP_201_CREATED,
)
def start_canon_run(payload: CanonRunStart, runs: CanonRunsDep) -> CanonCheckRun:
    try:
        return runs.start(payload)
    except (CanonRunCoordinatorError, ProjectSessionError, ProjectHistoryError) as error:
        raise _canon_api_error(error) from error


@router.get("/runs/{run_id}", response_model=CanonCheckRun)
def inspect_canon_run(run_id: str, runs: CanonRunsDep) -> CanonCheckRun:
    try:
        return runs.inspect(run_id)
    except CanonRunCoordinatorError as error:
        raise _canon_api_error(error) from error


@router.post("/runs/{run_id}/cancel", response_model=CanonCheckRun)
def cancel_canon_run(run_id: str, runs: CanonRunsDep) -> CanonCheckRun:
    try:
        return runs.cancel(run_id)
    except CanonRunCoordinatorError as error:
        raise _canon_api_error(error) from error


@router.get(
    "/projects/{project_id}/issues",
    response_model=CanonIssueListResponse,
)
def list_canon_issues(project_id: str, runs: CanonRunsDep) -> CanonIssueListResponse:
    try:
        return runs.list_issues(project_id)
    except (CanonRunCoordinatorError, ProjectSessionError) as error:
        raise _canon_api_error(error) from error


@router.post("/issues/{issue_id}/status", response_model=CanonIssueProjection)
def change_canon_issue_status(
    issue_id: str,
    payload: CanonIssueStatusChange,
    runs: CanonRunsDep,
) -> CanonIssueProjection:
    try:
        return runs.change_issue_status(issue_id, payload)
    except (CanonRunCoordinatorError, ProjectSessionError, ProjectHistoryError) as error:
        raise _canon_api_error(error) from error


@router.post(
    "/issues/{issue_id}/suggest",
    response_model=CanonIssueSuggestionResponse,
)
def request_canon_issue_suggestion(
    issue_id: str,
    payload: CanonIssueSuggestionRequest,
    runs: CanonRunsDep,
) -> CanonIssueSuggestionResponse:
    try:
        return runs.request_suggestion(
            issue_id,
            payload.session_id,
            payload.source_checksum,
        )
    except (CanonRunCoordinatorError, ProjectSessionError) as error:
        raise _canon_api_error(error) from error


@router.post(
    "/issues/{issue_id}/impact-analysis",
    response_model=ImpactAnalysisResponse,
    status_code=status.HTTP_201_CREATED,
)
def start_canon_issue_impact_analysis(
    issue_id: str,
    payload: CanonIssueImpactRequest,
    canon_runs: CanonRunsDep,
    impact_runs: ImpactRunsDep,
) -> ImpactAnalysisResponse:
    """Seed ordinary Impact Analysis from server-owned Issue evidence."""

    try:
        request = canon_runs.prepare_issue_impact_request(issue_id, payload)
        return ImpactAnalysisResponse(run=impact_runs.start(payload.session_id, request))
    except (
        CanonRunCoordinatorError,
        ImpactRunCoordinatorError,
        ProjectSessionError,
        ProjectHistoryError,
    ) as error:
        raise _canon_api_error(error) from error


@router.post(
    "/suggestions/{suggestion_id}/approve",
    response_model=CanonFixSuggestionDecisionResponse,
)
def approve_canon_fix_suggestion(
    suggestion_id: str,
    payload: CanonFixSuggestionDecision,
    runs: CanonRunsDep,
) -> CanonFixSuggestionDecisionResponse:
    try:
        return runs.decide_suggestion(suggestion_id, payload, approved=True)
    except (CanonRunCoordinatorError, ProjectSessionError, ProjectHistoryError) as error:
        raise _canon_api_error(error) from error


@router.post(
    "/suggestions/{suggestion_id}/reject",
    response_model=CanonFixSuggestionDecisionResponse,
)
def reject_canon_fix_suggestion(
    suggestion_id: str,
    payload: CanonFixSuggestionDecision,
    runs: CanonRunsDep,
) -> CanonFixSuggestionDecisionResponse:
    try:
        return runs.decide_suggestion(suggestion_id, payload, approved=False)
    except (CanonRunCoordinatorError, ProjectSessionError, ProjectHistoryError) as error:
        raise _canon_api_error(error) from error


def _canon_api_error(error: object) -> HTTPException:
    code = str(getattr(error, "code", "canon_run_failed"))
    parameters = getattr(error, "parameters", {})
    if code in {
        "canon_run_not_found",
        "canon_issue_not_found",
        "canon_project_not_open",
        "canon_suggestion_not_found",
    }:
        status_code = status.HTTP_404_NOT_FOUND
    elif code in {
        "canon_project_dirty",
        "canon_revision_stale",
        "canon_run_stale",
        "canon_run_in_progress",
        "history_revision_stale",
        "canon_suggestion_stale",
        "canon_suggestion_already_decided",
        "canon_repair_capability_stale",
    }:
        status_code = status.HTTP_409_CONFLICT
    else:
        status_code = status.HTTP_400_BAD_REQUEST
    return HTTPException(
        status_code=status_code,
        detail={
            "code": code,
            "message_key": f"canon.error.{code}",
            "parameters": parameters,
        },
    )
