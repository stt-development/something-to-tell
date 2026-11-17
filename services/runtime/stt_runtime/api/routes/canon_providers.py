"""Secret-safe provider profile and model discovery routes."""

from typing import Annotated

from fastapi import APIRouter, Depends, HTTPException, Query, Request, status

from ...canon.agent import CanonAgentError, CanonAgentService
from ...canon.agent_profiles import (
    CanonProviderProfile,
    CanonProviderProfileError,
    CanonProviderProfileRegistry,
)
from ...project_session.service import ProjectSessionError, ProjectSessionRegistry
from ...schemas.canon_agent import (
    CanonProviderModelsResponse,
    CanonProviderProfileCreate,
    CanonProviderProfileDeleteResponse,
    CanonProviderProfileUpdate,
    CanonProviderProfilesResponse,
)

router = APIRouter(prefix="/canon-provider-profiles", tags=["canon-providers"])


def _profiles(request: Request) -> CanonProviderProfileRegistry:
    return request.app.state.canon_provider_profiles


def _agent(request: Request) -> CanonAgentService:
    return request.app.state.canon_agent


def _sessions(request: Request) -> ProjectSessionRegistry:
    return request.app.state.project_sessions


ProfilesDep = Annotated[CanonProviderProfileRegistry, Depends(_profiles)]
AgentDep = Annotated[CanonAgentService, Depends(_agent)]
SessionsDep = Annotated[ProjectSessionRegistry, Depends(_sessions)]


@router.get("", response_model=CanonProviderProfilesResponse)
def list_canon_provider_profiles(
    registry: ProfilesDep,
    sessions: SessionsDep,
    session_id: str | None = Query(default=None, min_length=1),
) -> CanonProviderProfilesResponse:
    """List secret-free machine profiles, optionally validating project context."""

    _require_optional_session(sessions, session_id)
    try:
        return CanonProviderProfilesResponse(profiles=registry.summaries())
    except CanonProviderProfileError as error:
        raise _profile_http_error(error) from error


@router.post("", response_model=CanonProviderModelsResponse, status_code=status.HTTP_201_CREATED)
def create_canon_provider_profile(
    payload: CanonProviderProfileCreate,
    registry: ProfilesDep,
    agent: AgentDep,
    sessions: SessionsDep,
) -> CanonProviderModelsResponse:
    """Verify the credential by loading its provider-owned model catalog."""

    _require_optional_session(sessions, payload.session_id)
    if len(payload.api_key.strip()) < 8:
        raise _provider_http_error(CanonAgentError("canon_provider_credentials_invalid"))
    try:
        profile = registry.add(
            label=payload.label,
            provider=payload.provider,
            api_key=payload.api_key,
        )
    except CanonProviderProfileError as error:
        raise _profile_http_error(error) from error
    try:
        return agent.list_models(profile)
    except CanonAgentError as error:
        # A failed credential must not leave an unusable encrypted profile.
        try:
            registry.remove(profile.profile_id)
        except CanonProviderProfileError:
            # Preserve the provider failure code; storage failures remain secret-free.
            pass
        raise _provider_http_error(error) from error


@router.get("/{profile_id}/models", response_model=CanonProviderModelsResponse)
def list_canon_provider_models(
    profile_id: str,
    registry: ProfilesDep,
    agent: AgentDep,
    sessions: SessionsDep,
    session_id: str | None = Query(default=None, min_length=1),
) -> CanonProviderModelsResponse:
    """Resolve the encrypted key server-side and return its live model catalog."""

    _require_optional_session(sessions, session_id)
    try:
        return agent.list_models(registry.resolve(profile_id))
    except CanonProviderProfileError as error:
        raise _profile_http_error(error) from error
    except CanonAgentError as error:
        raise _provider_http_error(error) from error


@router.put("/{profile_id}", response_model=CanonProviderModelsResponse)
def update_canon_provider_profile(
    profile_id: str,
    payload: CanonProviderProfileUpdate,
    registry: ProfilesDep,
    agent: AgentDep,
    sessions: SessionsDep,
) -> CanonProviderModelsResponse:
    """Verify changed credentials before replacing their encrypted profile."""

    _require_optional_session(sessions, payload.session_id)
    try:
        current = registry.resolve(profile_id)
        supplied_key = payload.api_key.strip() if payload.api_key is not None else ""
        if payload.provider != current.provider and len(supplied_key) < 8:
            raise CanonAgentError("canon_provider_credentials_required")
        if supplied_key and len(supplied_key) < 8:
            raise CanonAgentError("canon_provider_credentials_invalid")
        candidate = CanonProviderProfile(
            profile_id=profile_id,
            label=payload.label,
            provider=payload.provider,
            api_key=supplied_key or current.api_key,
        )
        models = agent.list_models(candidate)
        registry.replace(candidate)
        return models
    except CanonProviderProfileError as error:
        raise _profile_http_error(error) from error
    except CanonAgentError as error:
        raise _provider_http_error(error) from error


@router.delete("/{profile_id}", response_model=CanonProviderProfileDeleteResponse)
def delete_canon_provider_profile(
    profile_id: str,
    registry: ProfilesDep,
    sessions: SessionsDep,
    session_id: str | None = Query(default=None, min_length=1),
) -> CanonProviderProfileDeleteResponse:
    """Delete only the machine-local secret profile, never project settings."""

    _require_optional_session(sessions, session_id)
    try:
        registry.remove(profile_id)
    except CanonProviderProfileError as error:
        raise _profile_http_error(error) from error
    return CanonProviderProfileDeleteResponse(deleted_profile_id=profile_id)


def _require_optional_session(
    sessions: ProjectSessionRegistry,
    session_id: str | None,
) -> None:
    """Validate an owning project when supplied without blocking startup setup."""

    if session_id is None:
        return
    try:
        sessions.inspect(session_id)
    except ProjectSessionError as error:
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND,
            detail={
                "code": error.code,
                "message_key": f"project_session.{error.code}",
                "parameters": error.parameters,
            },
        ) from error


def _profile_http_error(error: CanonProviderProfileError) -> HTTPException:
    return HTTPException(
        status_code=(
            status.HTTP_404_NOT_FOUND
            if error.code == "canon_provider_profile_unavailable"
            else status.HTTP_500_INTERNAL_SERVER_ERROR
        ),
        detail={
            "code": error.code,
            "message_key": f"canon.error.{error.code}",
            "parameters": {"profile_id": error.profile_id},
        },
    )


def _provider_http_error(error: CanonAgentError) -> HTTPException:
    return HTTPException(
        status_code=(
            status.HTTP_401_UNAUTHORIZED
            if error.code == "canon_provider_credentials_invalid"
            else status.HTTP_400_BAD_REQUEST
            if error.code == "canon_provider_credentials_required"
            else status.HTTP_502_BAD_GATEWAY
        ),
        detail={
            "code": error.code,
            "message_key": f"canon.error.{error.code}",
            "parameters": error.parameters,
        },
    )
