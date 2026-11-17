from typing import Annotated

from fastapi import APIRouter, Depends, Response, status

from ...playback.traversal_service import (
    PlaybackSessionService,
    PlaybackSessionServiceError,
)
from ...schemas.playback import PlaybackPreparation, PlaybackSession
from ...schemas.playback_api import (
    PlaybackChooseCommand,
    PlaybackPrepareCommand,
    PlaybackRestartCommand,
    PlaybackRevisionCommand,
    PlaybackStartCommand,
)
from ..crud import api_error
from ..dependencies import get_playback_sessions

router = APIRouter(prefix="/playback", tags=["playback"])
PlaybackDep = Annotated[PlaybackSessionService, Depends(get_playback_sessions)]


@router.post("/prepare", response_model=PlaybackPreparation)
def prepare_playback(
    payload: PlaybackPrepareCommand,
    sessions: PlaybackDep,
) -> PlaybackPreparation:
    return sessions.prepare(payload)


@router.post(
    "/sessions",
    response_model=PlaybackSession,
    status_code=status.HTTP_201_CREATED,
)
def start_playback(
    payload: PlaybackStartCommand,
    sessions: PlaybackDep,
) -> PlaybackSession:
    try:
        return sessions.start(
            payload.definition,
            initial_state=payload.initial_state,
            visit_threshold=payload.visit_threshold,
        )
    except PlaybackSessionServiceError as error:
        raise _playback_api_error(error) from error


@router.get("/sessions/{session_id}", response_model=PlaybackSession)
def inspect_playback(
    session_id: str,
    source_revision: str,
    sessions: PlaybackDep,
) -> PlaybackSession:
    try:
        return sessions.inspect(session_id, source_revision)
    except PlaybackSessionServiceError as error:
        raise _playback_api_error(error) from error


@router.post("/sessions/{session_id}/choices", response_model=PlaybackSession)
def choose_playback_transition(
    session_id: str,
    payload: PlaybackChooseCommand,
    sessions: PlaybackDep,
) -> PlaybackSession:
    try:
        return sessions.choose(
            session_id,
            payload.transition_id,
            dialogue_option_id=payload.dialogue_option_id,
            source_revision=payload.source_revision,
            allow_visit_threshold=payload.allow_visit_threshold,
        )
    except PlaybackSessionServiceError as error:
        raise _playback_api_error(error) from error


@router.post("/sessions/{session_id}/back", response_model=PlaybackSession)
def back_playback(
    session_id: str,
    payload: PlaybackRevisionCommand,
    sessions: PlaybackDep,
) -> PlaybackSession:
    try:
        return sessions.back(
            session_id,
            source_revision=payload.source_revision,
        )
    except PlaybackSessionServiceError as error:
        raise _playback_api_error(error) from error


@router.post("/sessions/{session_id}/restart", response_model=PlaybackSession)
def restart_playback(
    session_id: str,
    payload: PlaybackRestartCommand,
    sessions: PlaybackDep,
) -> PlaybackSession:
    try:
        return sessions.restart(
            session_id,
            payload.definition,
            initial_state=payload.initial_state,
            visit_threshold=payload.visit_threshold,
        )
    except PlaybackSessionServiceError as error:
        raise _playback_api_error(error) from error


@router.delete(
    "/sessions/{session_id}",
    status_code=status.HTTP_204_NO_CONTENT,
)
def close_playback(
    session_id: str,
    sessions: PlaybackDep,
) -> Response:
    try:
        sessions.close(session_id)
        return Response(status_code=status.HTTP_204_NO_CONTENT)
    except PlaybackSessionServiceError as error:
        raise _playback_api_error(error) from error


def _playback_api_error(error: PlaybackSessionServiceError):
    status_code = (
        status.HTTP_404_NOT_FOUND
        if error.code == "playback_session_not_found"
        else status.HTTP_409_CONFLICT
    )
    return api_error(status_code, error.code, str(error))
