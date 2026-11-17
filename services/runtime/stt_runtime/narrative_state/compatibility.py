from pydantic import BaseModel, ConfigDict

from ..schemas.narrative_state import (
    NarrativeEffectBinding,
    NarrativeEffectDefinition,
    NarrativeEffectOwnerRef,
    StateHolderRef,
    TransferItemEffect,
    TransferItemPayload,
)
from ..schemas.playback import AddInventoryPlaybackEffect, RemoveInventoryPlaybackEffect


class LegacyInventoryEffectAdaptation(BaseModel):
    """Explicit non-persisting projection of one accepted Playback v1 inventory effect."""

    model_config = ConfigDict(extra="forbid")

    flow_id: str
    definition: NarrativeEffectDefinition
    binding: NarrativeEffectBinding


def adapt_v1_inventory_effect(
    effect: AddInventoryPlaybackEffect | RemoveInventoryPlaybackEffect,
) -> LegacyInventoryEffectAdaptation:
    """Preserve a v1 effect id and behavior without inferring a canonical holder."""

    if effect.owner_node_id is not None:
        owner = NarrativeEffectOwnerRef(
            owner_kind="node_entry",
            owner_id=effect.owner_node_id,
        )
    else:
        owner = NarrativeEffectOwnerRef(
            owner_kind="flow_transition",
            owner_id=effect.owner_transition_id or "",
        )
    if isinstance(effect, AddInventoryPlaybackEffect):
        source = StateHolderRef(kind="unowned")
        destination = StateHolderRef(kind="player")
    else:
        source = StateHolderRef(kind="player")
        destination = StateHolderRef(kind="unowned")

    definition = TransferItemEffect(
        id=effect.id,
        project_id=effect.project_id,
        operation="transfer_item",
        payload=TransferItemPayload(
            item_node_id=effect.payload.node_id,
            from_holder=source,
            to_holder=destination,
        ),
        repeat_policy="per_visit" if effect.repeatable else "once",
        explanation=effect.explanation,
    )
    return LegacyInventoryEffectAdaptation(
        flow_id=effect.flow_id,
        definition=definition,
        binding=NarrativeEffectBinding(
            id=effect.id,
            project_id=effect.project_id,
            effect_id=effect.id,
            owner=owner,
            application_order=0,
        ),
    )
