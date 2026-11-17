from collections.abc import Callable
from typing import Annotated, TypeVar

from fastapi import APIRouter, Depends, Header, HTTPException, Request, Response, status

from ..dependencies import PROJECT_SESSION_HEADER, get_uow
from ...narrative_state.service import (
    NarrativeStateAuthoringService,
    NarrativeStateServiceError,
)
from ...repositories.interfaces import UnitOfWork
from ...schemas.narrative_state import NarrativeEffectDefinition
from ...schemas.narrative_state_api import (
    FlowInitialStateResponse,
    FlowInitialStateWrite,
    NarrativeEffectBindingBatch,
    NarrativeEffectBindingResponse,
    NarrativeEffectBindingWrite,
    NarrativeEffectWrite,
    NarrativeStateDeleteCommand,
    NarrativeStateDeletionImpact,
    NarrativeStateIntegrityReport,
    NarrativeStateOwnerImpactRequest,
    NarrativeStateSnapshot,
    RelationshipInitialStateApply,
    RelationshipInitialStateApplyResponse,
    RelationshipInitialStatePreview,
    RelationshipInitialStatePreviewRequest,
)


router = APIRouter(prefix="/narrative-state", tags=["narrative-state"])
UowDep = Annotated[UnitOfWork, Depends(get_uow, scope="function")]
ResponseT = TypeVar("ResponseT")


@router.get("/projects/{project_id}", response_model=NarrativeStateSnapshot)
def get_snapshot(project_id: str, uow: UowDep) -> NarrativeStateSnapshot:
    """Load all explicit state authoring records without deriving semantic facts."""

    return _call(uow, lambda: NarrativeStateAuthoringService().snapshot(uow, project_id))


@router.get(
    "/projects/{project_id}/integrity", response_model=NarrativeStateIntegrityReport
)
def get_integrity(project_id: str, uow: UowDep) -> NarrativeStateIntegrityReport:
    """Return localization-ready draft facts for the project state model."""

    return _call(uow, lambda: NarrativeStateAuthoringService().integrity(uow, project_id))


@router.put("/initial-states", response_model=FlowInitialStateResponse)
def upsert_initial_state(
    payload: FlowInitialStateWrite,
    request: Request,
    uow: UowDep,
    session_id: str | None = Header(default=None, alias=PROJECT_SESSION_HEADER),
) -> FlowInitialStateResponse:
    """Create or replace the sole initial state for one root Story Flow."""

    _require_revision(request, session_id, payload.expected_revision)
    return _call(
        uow, lambda: NarrativeStateAuthoringService().upsert_initial_state(uow, payload)
    )


@router.delete("/initial-states/{state_id}", status_code=status.HTTP_204_NO_CONTENT)
def delete_initial_state(
    state_id: str,
    payload: NarrativeStateDeleteCommand,
    request: Request,
    uow: UowDep,
    session_id: str | None = Header(default=None, alias=PROJECT_SESSION_HEADER),
) -> Response:
    """Delete one explicit root state; semantic relationships remain untouched."""

    _require_revision(request, session_id, payload.expected_revision)
    _call(
        uow,
        lambda: NarrativeStateAuthoringService().delete_initial_state(
            uow, state_id, payload.project_id
        ),
    )
    return Response(status_code=status.HTTP_204_NO_CONTENT)


@router.post("/effects", response_model=NarrativeEffectDefinition, status_code=201)
def create_effect(
    payload: NarrativeEffectWrite,
    request: Request,
    uow: UowDep,
    session_id: str | None = Header(default=None, alias=PROJECT_SESSION_HEADER),
) -> NarrativeEffectDefinition:
    """Persist one fully typed effect after canonical-reference validation."""

    _require_revision(request, session_id, payload.expected_revision)
    return _call(uow, lambda: NarrativeStateAuthoringService().create_effect(uow, payload))


@router.put("/effects/{effect_id}", response_model=NarrativeEffectDefinition)
def update_effect(
    effect_id: str,
    payload: NarrativeEffectWrite,
    request: Request,
    uow: UowDep,
    session_id: str | None = Header(default=None, alias=PROJECT_SESSION_HEADER),
) -> NarrativeEffectDefinition:
    """Replace one effect while preserving its identity and existing bindings."""

    _require_revision(request, session_id, payload.expected_revision)
    return _call(
        uow,
        lambda: NarrativeStateAuthoringService().update_effect(uow, effect_id, payload),
    )


@router.get("/effects/{effect_id}/impact", response_model=NarrativeStateDeletionImpact)
def get_effect_impact(effect_id: str, uow: UowDep) -> NarrativeStateDeletionImpact:
    """Preview every binding removed by effect deletion."""

    return _call(uow, lambda: NarrativeStateAuthoringService().effect_impact(uow, effect_id))


@router.delete("/effects/{effect_id}", status_code=status.HTTP_204_NO_CONTENT)
def delete_effect(
    effect_id: str,
    payload: NarrativeStateDeleteCommand,
    request: Request,
    uow: UowDep,
    session_id: str | None = Header(default=None, alias=PROJECT_SESSION_HEADER),
) -> Response:
    """Atomically delete an effect and reviewed dependent bindings."""

    _require_revision(request, session_id, payload.expected_revision)
    _call(
        uow,
        lambda: NarrativeStateAuthoringService().delete_effect(
            uow,
            effect_id,
            payload.project_id,
            impact_reviewed=payload.impact_reviewed,
        ),
    )
    return Response(status_code=status.HTTP_204_NO_CONTENT)


@router.post(
    "/bindings",
    response_model=NarrativeEffectBindingResponse,
    status_code=201,
    name="create_effect_binding",
)
def create_binding(
    payload: NarrativeEffectBindingWrite,
    request: Request,
    uow: UowDep,
    session_id: str | None = Header(default=None, alias=PROJECT_SESSION_HEADER),
) -> NarrativeEffectBindingResponse:
    """Attach one effect to an existing temporal owner at a unique order."""

    _require_revision(request, session_id, payload.expected_revision)
    return _call(uow, lambda: NarrativeStateAuthoringService().create_binding(uow, payload))


@router.put("/bindings/reorder", response_model=list[NarrativeEffectBindingResponse])
def reorder_bindings(
    payload: NarrativeEffectBindingBatch,
    request: Request,
    uow: UowDep,
    session_id: str | None = Header(default=None, alias=PROJECT_SESSION_HEADER),
) -> list[NarrativeEffectBindingResponse]:
    """Commit one complete owner sequence as a single transaction."""

    _require_revision(request, session_id, payload.expected_revision)
    return _call(
        uow, lambda: NarrativeStateAuthoringService().reorder_bindings(uow, payload)
    )


@router.put(
    "/bindings/{binding_id}",
    response_model=NarrativeEffectBindingResponse,
    name="update_effect_binding",
)
def update_binding(
    binding_id: str,
    payload: NarrativeEffectBindingWrite,
    request: Request,
    uow: UowDep,
    session_id: str | None = Header(default=None, alias=PROJECT_SESSION_HEADER),
) -> NarrativeEffectBindingResponse:
    """Move or retarget one binding after complete-contract validation."""

    _require_revision(request, session_id, payload.expected_revision)
    return _call(
        uow,
        lambda: NarrativeStateAuthoringService().update_binding(uow, binding_id, payload),
    )


@router.delete(
    "/bindings/{binding_id}",
    status_code=status.HTTP_204_NO_CONTENT,
    name="delete_effect_binding",
)
def delete_binding(
    binding_id: str,
    payload: NarrativeStateDeleteCommand,
    request: Request,
    uow: UowDep,
    session_id: str | None = Header(default=None, alias=PROJECT_SESSION_HEADER),
) -> Response:
    """Remove one ordered association without deleting its reusable effect."""

    _require_revision(request, session_id, payload.expected_revision)
    _call(
        uow,
        lambda: NarrativeStateAuthoringService().delete_binding(
            uow, binding_id, payload.project_id
        ),
    )
    return Response(status_code=status.HTTP_204_NO_CONTENT)


@router.post("/owners/impact", response_model=NarrativeStateDeletionImpact)
def get_owner_impact(
    payload: NarrativeStateOwnerImpactRequest, uow: UowDep
) -> NarrativeStateDeletionImpact:
    """Preview bindings that must be handled before a temporal owner is removed."""

    return _call(
        uow,
        lambda: NarrativeStateAuthoringService().owner_impact(
            uow, payload.project_id, payload.owner
        ),
    )


@router.post(
    "/relationship-imports/preview", response_model=RelationshipInitialStatePreview
)
def preview_relationship_import(
    payload: RelationshipInitialStatePreviewRequest, uow: UowDep
) -> RelationshipInitialStatePreview:
    """Describe an owns-to-custody conversion without persisting inferred state."""

    return _call(
        uow,
        lambda: NarrativeStateAuthoringService().relationship_preview(uow, payload),
    )


@router.post(
    "/relationship-imports", response_model=RelationshipInitialStateApplyResponse
)
def apply_relationship_import(
    payload: RelationshipInitialStateApply,
    request: Request,
    uow: UowDep,
    session_id: str | None = Header(default=None, alias=PROJECT_SESSION_HEADER),
) -> RelationshipInitialStateApplyResponse:
    """Apply one reviewed conversion idempotently while retaining the owns edge."""

    _require_revision(request, session_id, payload.expected_revision)
    return _call(
        uow, lambda: NarrativeStateAuthoringService().apply_relationship(uow, payload)
    )


def _require_revision(
    request: Request, session_id: str | None, expected_revision: int
) -> None:
    """Reject commands based on a checkpoint older than the active project session."""

    if session_id is None:
        return
    current = request.app.state.project_sessions.inspect(session_id).session.saved_revision
    if expected_revision != current:
        raise HTTPException(
            status_code=status.HTTP_409_CONFLICT,
            detail={
                "code": "narrative_state_revision_stale",
                "message_key": "narrativeState.error.narrative_state_revision_stale",
                "parameters": {
                    "expected_revision": expected_revision,
                    "saved_revision": current,
                },
            },
        )


def _call(uow: UnitOfWork, operation: Callable[[], ResponseT]) -> ResponseT:
    """Translate service errors while guaranteeing rollback on rejected commands."""

    try:
        return operation()
    except NarrativeStateServiceError as error:
        uow.rollback()
        missing = {
            "narrative_state_project_not_found",
            "narrative_state_record_not_found",
        }
        raise HTTPException(
            status_code=(
                status.HTTP_404_NOT_FOUND
                if error.code in missing
                else status.HTTP_409_CONFLICT
            ),
            detail={
                "code": error.code,
                "message_key": f"narrativeState.error.{error.code}",
                "parameters": error.parameters,
            },
        ) from error
