from typing import Annotated

from fastapi import APIRouter, Depends, status

from ..crud import api_error
from ..dependencies import get_uow
from ...repositories.interfaces import UnitOfWork
from ...schemas.progression_migration import (
    ProgressionDecision,
    ProgressionMigrationAccept,
    ProgressionMigrationAcceptResponse,
    ProgressionMigrationReject,
    ProgressionMigrationReview,
)
from ...story_flow.progression_migration import ProgressionMigrationService
from ...story_flow.service import StoryFlowServiceError

router = APIRouter(prefix="/progression-migrations", tags=["progression-migrations"])
UowDep = Annotated[UnitOfWork, Depends(get_uow, scope="function")]


@router.get("", response_model=ProgressionMigrationReview)
def review_progression_migrations(project_id: str, uow: UowDep) -> ProgressionMigrationReview:
    return _call(uow, lambda: ProgressionMigrationService().review(uow, project_id))


@router.post("/{fingerprint}/reject", response_model=ProgressionDecision)
def reject_progression_migration(
    fingerprint: str,
    payload: ProgressionMigrationReject,
    uow: UowDep,
) -> ProgressionDecision:
    return _call(uow, lambda: ProgressionMigrationService().reject(uow, payload.project_id, fingerprint))


@router.post("/{fingerprint}/accept", response_model=ProgressionMigrationAcceptResponse)
def accept_progression_migration(
    fingerprint: str,
    payload: ProgressionMigrationAccept,
    uow: UowDep,
) -> ProgressionMigrationAcceptResponse:
    return _call(uow, lambda: ProgressionMigrationService().accept(uow, fingerprint, payload))


def _call(uow: UnitOfWork, operation):
    try:
        return operation()
    except StoryFlowServiceError as error:
        uow.rollback()
        not_found = error.code in {"project_not_found", "story_flow_not_found", "progression_candidate_not_found"}
        raise api_error(
            status.HTTP_404_NOT_FOUND if not_found else status.HTTP_409_CONFLICT,
            error.code,
            str(error),
        ) from error
