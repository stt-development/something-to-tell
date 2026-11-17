"""Project-owned Style profile and Scene assignment authoring API."""

from typing import Annotated

from fastapi import APIRouter, Depends, Header, HTTPException, Response, status
from pydantic import BaseModel, ConfigDict

from ...repositories.interfaces import UnitOfWork
from ...project_history.service import ProjectHistoryError
from ...project_session.service import ProjectSessionError, ProjectSessionRegistry
from ...schemas.project_history import ProjectHistoryMutationResponse
from ...schemas.style_system import (
    SceneStyleAssignmentV1,
    StyleProfileDeletionImpactV1,
    StyleProfileV1,
)
from ...style_system.service import StylePersistenceError, StylePersistenceService
from ..dependencies import get_uow
from .project_sessions import get_project_session_registry

router = APIRouter(prefix="/styles", tags=["styles"])
UowDep = Annotated[UnitOfWork, Depends(get_uow, scope="function")]
RegistryDep = Annotated[ProjectSessionRegistry, Depends(get_project_session_registry)]


class StyleProfileDeleteRequest(BaseModel):
    """Require the UI to submit the reference decision it presented to the author."""

    model_config = ConfigDict(extra="forbid")

    project_id: str
    default_style_profile_id: str | None = None
    replacement_profile_id: str | None = None
    impact_reviewed: bool = False
    expected_history_revision: int | None = None


@router.post(
    "/profiles",
    response_model=StyleProfileV1,
    status_code=status.HTTP_201_CREATED,
)
def create_style_profile(payload: StyleProfileV1, uow: UowDep) -> StyleProfileV1:
    return _call(lambda: StylePersistenceService().create_profile(uow, payload))


@router.put("/profiles/{profile_id}", response_model=StyleProfileV1)
def update_style_profile(
    profile_id: str,
    payload: StyleProfileV1,
    uow: UowDep,
) -> StyleProfileV1:
    if profile_id != payload.id:
        raise _http_error(StylePersistenceError("style_profile_invalid", profile_id=profile_id))
    return _call(lambda: StylePersistenceService().update_profile(uow, payload))


@router.get(
    "/profiles/{profile_id}/deletion-impact",
    response_model=StyleProfileDeletionImpactV1,
)
def inspect_style_profile_deletion_impact(
    profile_id: str,
    project_id: str,
    uow: UowDep,
    default_style_profile_id: str | None = None,
) -> StyleProfileDeletionImpactV1:
    return _call(
        lambda: StylePersistenceService().deletion_impact(
            uow,
            project_id=project_id,
            profile_id=profile_id,
            default_style_profile_id=default_style_profile_id,
        )
    )


@router.delete("/profiles/{profile_id}", response_model=ProjectHistoryMutationResponse)
def delete_style_profile(
    profile_id: str,
    payload: StyleProfileDeleteRequest,
    registry: RegistryDep,
    project_session_id: str = Header(alias="X-Project-Session-Id"),
) -> ProjectHistoryMutationResponse:
    try:
        project = registry.inspect(project_session_id)
        if project.session.project_id != payload.project_id:
            raise StylePersistenceError("style_project_not_found", project_id=payload.project_id)
        return registry.delete_style_profile(
            project_session_id,
            profile_id=profile_id,
            replacement_profile_id=payload.replacement_profile_id,
            impact_reviewed=payload.impact_reviewed,
            expected_history_revision=payload.expected_history_revision,
        )
    except StylePersistenceError as error:
        raise _http_error(error) from error
    except (ProjectHistoryError, ProjectSessionError) as error:
        raise HTTPException(
            status_code=status.HTTP_409_CONFLICT,
            detail={
                "code": error.code,
                "message_key": f"history.error.{error.code}",
                "parameters": error.parameters,
            },
        ) from error


@router.put(
    "/scene-assignments/{scene_node_id}",
    response_model=SceneStyleAssignmentV1,
)
def upsert_scene_style_assignment(
    scene_node_id: str,
    payload: SceneStyleAssignmentV1,
    uow: UowDep,
) -> SceneStyleAssignmentV1:
    if scene_node_id != payload.scene_node_id:
        raise _http_error(
            StylePersistenceError("style_scene_invalid", scene_node_id=scene_node_id)
        )
    return _call(lambda: StylePersistenceService().upsert_scene_assignment(uow, payload))


@router.delete(
    "/scene-assignments/{scene_node_id}",
    status_code=status.HTTP_204_NO_CONTENT,
)
def clear_scene_style_assignment(
    scene_node_id: str,
    project_id: str,
    uow: UowDep,
) -> Response:
    _call(
        lambda: StylePersistenceService().clear_scene_assignment(
            uow,
            project_id=project_id,
            scene_node_id=scene_node_id,
        )
    )
    return Response(status_code=status.HTTP_204_NO_CONTENT)


def _call(operation):
    """Map domain failures without leaking profile text into HTTP details."""

    try:
        return operation()
    except StylePersistenceError as error:
        raise _http_error(error) from error


def _http_error(error: StylePersistenceError) -> HTTPException:
    code = status.HTTP_404_NOT_FOUND if error.code.endswith("not_found") else status.HTTP_409_CONFLICT
    return HTTPException(
        status_code=code,
        detail={
            "code": error.code,
            "message_key": f"style.error.{error.code}",
            "parameters": error.parameters,
        },
    )
