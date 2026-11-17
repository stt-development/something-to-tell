"""Process-local API for bounded Style Rewriter recommendation runs."""

from collections.abc import Callable
from typing import Annotated, TypeVar

from fastapi import APIRouter, Depends, HTTPException, status

from ...schemas.style_rewrite import (
    StyleRewriteApprovalResponseV1,
    StyleRewriteApprovalV1,
    StyleRewriteRequestV1,
    StyleRewriteResponseV1,
    StyleRewriteRetryV1,
)
from ...style_system.rewrite_coordinator import StyleRewriteCoordinator, StyleRewriteCoordinatorError
from ..dependencies import get_style_rewrite_runs

router = APIRouter(prefix="/style-rewrites/runs", tags=["style-rewrites"])
RunsDep = Annotated[StyleRewriteCoordinator, Depends(get_style_rewrite_runs)]
ResultT = TypeVar("ResultT")


@router.post("", response_model=StyleRewriteResponseV1, status_code=status.HTTP_201_CREATED)
def start_style_rewrite_run(payload: StyleRewriteRequestV1, runs: RunsDep) -> StyleRewriteResponseV1:
    return _call(lambda: StyleRewriteResponseV1(run=runs.start(payload)))


@router.get("/{run_id}", response_model=StyleRewriteResponseV1)
def inspect_style_rewrite_run(run_id: str, session_id: str, runs: RunsDep) -> StyleRewriteResponseV1:
    return _call(lambda: StyleRewriteResponseV1(run=runs.inspect(session_id, run_id)))


@router.post("/{run_id}/cancel", response_model=StyleRewriteResponseV1)
def cancel_style_rewrite_run(run_id: str, session_id: str, runs: RunsDep) -> StyleRewriteResponseV1:
    return _call(lambda: StyleRewriteResponseV1(run=runs.cancel(session_id, run_id)))


@router.post("/{run_id}/retry", response_model=StyleRewriteResponseV1, status_code=status.HTTP_201_CREATED)
def retry_style_rewrite_run(run_id: str, session_id: str, payload: StyleRewriteRetryV1, runs: RunsDep) -> StyleRewriteResponseV1:
    return _call(lambda: StyleRewriteResponseV1(run=runs.retry(session_id, run_id, payload)))


@router.post("/{run_id}/approve", response_model=StyleRewriteApprovalResponseV1)
def approve_style_rewrite_recommendation(
    run_id: str,
    session_id: str,
    payload: StyleRewriteApprovalV1,
    runs: RunsDep,
) -> StyleRewriteApprovalResponseV1:
    """Apply only the exact runtime-validated patch; Canon remains opt-in."""

    def operation() -> StyleRewriteApprovalResponseV1:
        result, run = runs.approve(session_id, run_id, payload)
        return StyleRewriteApprovalResponseV1(result=result, run=run)

    return _call(operation)


def _call(operation: Callable[[], ResultT]) -> ResultT:
    """Map only redacted lifecycle failures to stable HTTP details."""

    try:
        return operation()
    except StyleRewriteCoordinatorError as error:
        if error.code == "style_rewrite_run_not_found":
            status_code = status.HTTP_404_NOT_FOUND
        elif error.code == "style_rewrite_run_capacity_reached":
            status_code = status.HTTP_429_TOO_MANY_REQUESTS
        elif error.code.endswith("stale"):
            status_code = status.HTTP_409_CONFLICT
        else:
            status_code = status.HTTP_400_BAD_REQUEST
        raise HTTPException(status_code=status_code, detail={
            "code": error.code,
            "message_key": f"style.error.{error.code}",
            "parameters": error.parameters,
        }) from error
