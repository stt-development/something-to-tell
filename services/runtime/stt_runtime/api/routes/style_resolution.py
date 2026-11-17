"""Read-only effective Style resolution for open project sessions."""

from typing import Annotated, Callable, TypeVar

from fastapi import APIRouter, Depends, HTTPException, Request, status

from ...project_session.service import ProjectSessionError, ProjectSessionRegistry
from ...schemas.style_resolution import (
    EffectiveStyleResolutionV1,
    StyleResolutionRequestV1,
)
from ...style_system.resolver import (
    EffectiveStyleResolver,
    StyleResolutionError,
    StyleResolutionSnapshot,
)

router = APIRouter(prefix="/style-resolution", tags=["style-resolution"])
ResultT = TypeVar("ResultT")


def _sessions(request: Request) -> ProjectSessionRegistry:
    """Resolve the process-owned project authority without exposing repositories."""

    return request.app.state.project_sessions


SessionsDep = Annotated[ProjectSessionRegistry, Depends(_sessions)]


@router.post("/resolve", response_model=EffectiveStyleResolutionV1)
def resolve_effective_style(
    payload: StyleResolutionRequestV1,
    sessions: SessionsDep,
) -> EffectiveStyleResolutionV1:
    """Resolve context and precedence from one immutable session snapshot."""

    def operation() -> EffectiveStyleResolutionV1:
        project = sessions.inspect(payload.session_id)
        return EffectiveStyleResolver().resolve(
            StyleResolutionSnapshot.from_document(project.document),
            target_node_id=payload.target_node_id,
            context=payload.context,
        )

    return _call(operation)


def _call(operation: Callable[[], ResultT]) -> ResultT:
    """Map stable resolver/session failures without leaking authored content."""

    try:
        return operation()
    except ProjectSessionError as error:
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND,
            detail={
                "code": error.code,
                "message_key": f"project_session.{error.code}",
                "parameters": error.parameters,
            },
        ) from error
    except StyleResolutionError as error:
        missing = error.code in {
            "style_target_not_found",
            "style_placement_not_found",
            "style_context_scene_invalid",
        }
        raise HTTPException(
            status_code=(
                status.HTTP_404_NOT_FOUND if missing else status.HTTP_409_CONFLICT
            ),
            detail={
                "code": error.code,
                "message_key": f"style.error.{error.code}",
                "parameters": error.parameters,
            },
        ) from error
