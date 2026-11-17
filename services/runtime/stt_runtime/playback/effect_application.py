from collections.abc import Mapping, Sequence
from typing import Any

from pydantic import TypeAdapter, ValidationError

from ..schemas.dialogue import DialogueChoiceElement
from ..schemas.playback import (
    AddInventoryPlaybackEffect,
    ClearFlagPlaybackEffect,
    PlaybackDefinition,
    PlaybackEffectApplication,
    PlaybackFact,
    PlaybackState,
    PlaybackStateChange,
    PlaybackTypedEffect,
    RecordDialogueChoicePlaybackEffect,
    RemoveInventoryPlaybackEffect,
    SetFlagPlaybackEffect,
    SetQuestStatusPlaybackEffect,
    TransferItemPlaybackEffect,
)
from ..schemas.narrative_state import StateHolderRef

_EFFECT_ADAPTER = TypeAdapter(PlaybackTypedEffect)
EffectReference = str | PlaybackTypedEffect | Mapping[str, Any]


def apply_playback_effects(
    definition: PlaybackDefinition,
    state: PlaybackState,
    effect_references: Sequence[EffectReference],
) -> PlaybackEffectApplication:
    """Validate and atomically apply one ordered choice-owned effect batch."""

    state_before = state.model_copy(deep=True)
    resolved, facts = _resolve_reviewed_effects(definition, effect_references)
    facts.extend(_validate_repeat_policy(resolved, state))
    facts.extend(_validate_targets(definition, resolved))
    facts.extend(_validate_conflicts(resolved))
    facts.extend(_validate_transfer_preconditions(definition, resolved, state))
    if facts:
        return _failed(state_before, facts)

    state_after = state.model_copy(deep=True)
    changes: list[PlaybackStateChange] = []
    for effect in resolved:
        changes.append(_apply_effect(state_after, effect))
        if effect.id not in state_after.applied_effect_ids:
            state_after.applied_effect_ids.append(effect.id)
    return PlaybackEffectApplication(
        success=True,
        state_before=state_before,
        state_after=state_after,
        applied_effect_ids=[effect.id for effect in resolved],
        changes=changes,
    )


def _resolve_reviewed_effects(
    definition: PlaybackDefinition,
    references: Sequence[EffectReference],
) -> tuple[list[PlaybackTypedEffect], list[PlaybackFact]]:
    accepted_by_id = {
        effect.id: effect
        for effect in definition.typed_effect_definitions
    }
    resolved: list[PlaybackTypedEffect] = []
    facts: list[PlaybackFact] = []
    seen: set[str] = set()
    for reference in references:
        effect, fact = _resolve_reviewed_effect(definition, accepted_by_id, reference)
        if fact is not None:
            facts.append(fact)
            continue
        if effect.id in seen:
            facts.append(
                _fact(
                    definition,
                    "conflicting_effects",
                    f"Effect '{effect.id}' appears more than once in one choice.",
                    "Keep each effect id once in the choice.",
                    effect,
                )
            )
            continue
        seen.add(effect.id)
        resolved.append(effect)
    return resolved, facts


def _resolve_reviewed_effect(
    definition: PlaybackDefinition,
    accepted_by_id: Mapping[str, PlaybackTypedEffect],
    reference: EffectReference,
) -> tuple[PlaybackTypedEffect | None, PlaybackFact | None]:
    if isinstance(reference, str):
        accepted = accepted_by_id.get(reference)
        if accepted is None:
            return None, _fact(
                definition,
                "malformed_effect",
                f"Effect '{reference}' is not a reviewed definition effect.",
                "Remove the reference or review a typed effect with this id.",
                effect_id=reference,
            )
        return accepted, None

    raw = reference.model_dump(mode="python") if hasattr(reference, "model_dump") else reference
    effect_id = raw.get("id") if isinstance(raw, Mapping) else None
    try:
        parsed = _EFFECT_ADAPTER.validate_python(raw)
    except ValidationError:
        return None, _fact(
            definition,
            "malformed_effect",
            f"Effect '{effect_id or '<unknown>'}' has a malformed typed payload.",
            "Repair and re-review the typed effect.",
            effect_id=effect_id if isinstance(effect_id, str) else None,
        )
    accepted = accepted_by_id.get(parsed.id)
    if accepted is None or accepted != parsed:
        return None, _fact(
            definition,
            "malformed_effect",
            f"Effect '{parsed.id}' does not match its reviewed definition.",
            "Use the immutable reviewed effect from this Playback definition.",
            parsed,
        )
    return accepted, None


def _validate_repeat_policy(
    effects: Sequence[PlaybackTypedEffect],
    state: PlaybackState,
) -> list[PlaybackFact]:
    facts: list[PlaybackFact] = []
    applied = set(state.applied_effect_ids)
    for effect in effects:
        if effect.id in applied and not effect.repeatable:
            facts.append(_fact(
                None,
                "repeated_effect",
                f"Non-repeatable effect '{effect.id}' was already applied.",
                "Choose another transition or restart Playback.",
                effect,
            ))
    return facts


def _validate_targets(
    definition: PlaybackDefinition,
    effects: Sequence[PlaybackTypedEffect],
) -> list[PlaybackFact]:
    nodes = {node.id: node for node in definition.canonical_nodes}
    facts: list[PlaybackFact] = []
    for effect in effects:
        target_error: str | None = None
        if isinstance(effect, AddInventoryPlaybackEffect | RemoveInventoryPlaybackEffect | TransferItemPlaybackEffect):
            item_node_id = effect.payload.item_node_id if isinstance(effect, TransferItemPlaybackEffect) else effect.payload.node_id
            target = nodes.get(item_node_id)
            if target is None or target.type != "Item":
                target_error = f"Inventory target '{item_node_id}' is not an Item flow member."
            elif isinstance(effect, TransferItemPlaybackEffect):
                for holder in (effect.payload.from_holder, effect.payload.to_holder):
                    expected_kind = {"character": "Character", "location": "Location", "faction": "Faction"}.get(holder.kind)
                    if expected_kind is not None and (nodes.get(holder.node_id or "") is None or nodes[holder.node_id or ""].type != expected_kind):
                        target_error = f"Custody holder '{holder.node_id}' is not a playable {expected_kind}."
                        break
        elif isinstance(effect, SetQuestStatusPlaybackEffect):
            target = nodes.get(effect.payload.quest_node_id)
            if (
                target is None
                or target.type != "Quest"
                or effect.payload.quest_node_id not in definition.quest_documents
            ):
                target_error = f"Quest target '{effect.payload.quest_node_id}' is not playable."
        elif isinstance(effect, RecordDialogueChoicePlaybackEffect):
            target = nodes.get(effect.payload.dialogue_node_id)
            document = definition.dialogue_documents.get(effect.payload.dialogue_node_id)
            choice_ids = {
                option.id
                for element in document.elements
                if isinstance(element, DialogueChoiceElement)
                for option in element.options
            } if document is not None else set()
            if target is None or target.type != "Dialogue" or document is None:
                target_error = f"Dialogue target '{effect.payload.dialogue_node_id}' is not playable."
            elif effect.payload.choice_id not in choice_ids:
                target_error = (
                    f"Dialogue choice '{effect.payload.choice_id}' does not exist in "
                    f"'{effect.payload.dialogue_node_id}'."
                )
        if target_error is not None:
            facts.append(
                _fact(
                    definition,
                    "malformed_effect",
                    target_error,
                    "Repair and re-review the typed effect target.",
                    effect,
                )
            )
    return facts


def _validate_conflicts(
    effects: Sequence[PlaybackTypedEffect],
) -> list[PlaybackFact]:
    writes: dict[str, tuple[Any, PlaybackTypedEffect]] = {}
    facts: list[PlaybackFact] = []
    for effect in effects:
        intent = _scalar_write_intent(effect)
        if intent is None:
            continue
        path, value = intent
        existing = writes.get(path)
        if existing is not None and existing[0] != value:
            facts.append(_fact(
                None,
                "conflicting_effects",
                (
                    f"Effects '{existing[1].id}' and '{effect.id}' write "
                    f"different values to '{path}'."
                ),
                "Keep one deterministic write for this state path.",
                effect,
            ))
        else:
            writes[path] = (value, effect)
    return facts


def _validate_transfer_preconditions(
    definition: PlaybackDefinition,
    effects: Sequence[PlaybackTypedEffect],
    state: PlaybackState,
) -> list[PlaybackFact]:
    """Simulate ordered custody writes before mutating the caller-owned state."""

    holders = {item_id: holder.model_copy(deep=True) for item_id, holder in state.item_holders.items()}
    for item_id in state.inventory_node_ids:
        holders.setdefault(item_id, StateHolderRef(kind="player"))
    for effect in effects:
        if not isinstance(effect, TransferItemPlaybackEffect):
            continue
        item_id = effect.payload.item_node_id
        actual = holders.get(item_id, StateHolderRef(kind="unowned"))
        if actual != effect.payload.from_holder:
            return [_fact(
                None,
                "stale_item_holder",
                (
                    f"Effect '{effect.id}' expected '{item_id}' at "
                    f"'{_holder_label(effect.payload.from_holder)}' but found '{_holder_label(actual)}'."
                ),
                "Update the transfer source holder or choose a route with matching custody.",
                effect,
                item_node_id=item_id,
                holder=actual,
            )]
        holders[item_id] = effect.payload.to_holder.model_copy(deep=True)
    return []


def _scalar_write_intent(effect: PlaybackTypedEffect) -> tuple[str, Any] | None:
    if isinstance(effect, SetFlagPlaybackEffect):
        return f"flags.{effect.payload.flag}", True
    if isinstance(effect, ClearFlagPlaybackEffect):
        return f"flags.{effect.payload.flag}", None
    if isinstance(effect, AddInventoryPlaybackEffect):
        return f"inventory.{effect.payload.node_id}", True
    if isinstance(effect, RemoveInventoryPlaybackEffect):
        return f"inventory.{effect.payload.node_id}", False
    if isinstance(effect, SetQuestStatusPlaybackEffect):
        return f"quests.{effect.payload.quest_node_id}.status", effect.payload.status
    return None


def _apply_effect(
    state: PlaybackState,
    effect: PlaybackTypedEffect,
) -> PlaybackStateChange:
    if isinstance(effect, SetFlagPlaybackEffect):
        path = f"flags.{effect.payload.flag}"
        before = state.flags.get(effect.payload.flag)
        state.flags[effect.payload.flag] = True
        after: bool | str | list[str] | None = True
    elif isinstance(effect, ClearFlagPlaybackEffect):
        path = f"flags.{effect.payload.flag}"
        before = state.flags.get(effect.payload.flag)
        state.flags.pop(effect.payload.flag, None)
        after = None
    elif isinstance(effect, AddInventoryPlaybackEffect):
        path = f"inventory.{effect.payload.node_id}"
        before = effect.payload.node_id in state.inventory_node_ids
        if not before:
            state.inventory_node_ids.append(effect.payload.node_id)
        state.item_holders[effect.payload.node_id] = StateHolderRef(kind="player")
        after = True
    elif isinstance(effect, RemoveInventoryPlaybackEffect):
        path = f"inventory.{effect.payload.node_id}"
        before = effect.payload.node_id in state.inventory_node_ids
        if before:
            state.inventory_node_ids.remove(effect.payload.node_id)
        state.item_holders[effect.payload.node_id] = StateHolderRef(kind="unowned")
        after = False
    elif isinstance(effect, TransferItemPlaybackEffect):
        path = f"items.{effect.payload.item_node_id}.holder"
        before = _current_holder(state, effect.payload.item_node_id)
        after = effect.payload.to_holder.model_copy(deep=True)
        state.item_holders[effect.payload.item_node_id] = after
        _sync_inventory(state, effect.payload.item_node_id, after)
    elif isinstance(effect, SetQuestStatusPlaybackEffect):
        path = f"quests.{effect.payload.quest_node_id}.status"
        before = state.quest_states.get(effect.payload.quest_node_id)
        state.quest_states[effect.payload.quest_node_id] = effect.payload.status
        after = effect.payload.status
    elif isinstance(effect, RecordDialogueChoicePlaybackEffect):
        path = f"dialogue.{effect.payload.dialogue_node_id}.choices"
        choices = state.dialogue_choice_ids.setdefault(effect.payload.dialogue_node_id, [])
        before = list(choices)
        if effect.payload.choice_id not in choices:
            choices.append(effect.payload.choice_id)
        after = list(choices)
    else:
        raise TypeError("unsupported validated playback effect")
    return PlaybackStateChange(
        effect_id=effect.id,
        authored_effect_id=effect.authored_effect_id,
        operation=effect.operation,
        path=path,
        before=before,
        after=after,
        explanation=effect.explanation,
    )


def _current_holder(state: PlaybackState, item_node_id: str) -> StateHolderRef:
    holder = state.item_holders.get(item_node_id)
    if holder is not None:
        return holder.model_copy(deep=True)
    return StateHolderRef(kind="player" if item_node_id in state.inventory_node_ids else "unowned")


def _sync_inventory(state: PlaybackState, item_node_id: str, holder: StateHolderRef) -> None:
    """Keep the v1 inventory projection compatible with authoritative custody."""

    carried = holder.kind in {"player", "party"}
    present = item_node_id in state.inventory_node_ids
    if carried and not present:
        state.inventory_node_ids.append(item_node_id)
    elif not carried and present:
        state.inventory_node_ids.remove(item_node_id)


def _holder_label(holder: StateHolderRef) -> str:
    return f"{holder.kind}:{holder.node_id}" if holder.node_id else holder.kind


def _fact(
    definition: PlaybackDefinition | None,
    code: str,
    message: str,
    action: str,
    effect: PlaybackTypedEffect | None = None,
    *,
    effect_id: str | None = None,
    item_node_id: str | None = None,
    holder: StateHolderRef | None = None,
) -> PlaybackFact:
    owner_kind = effect.owner_kind if effect is not None else None
    owner_id = effect.owner_id if effect is not None else None
    return PlaybackFact(
        code=code,
        level="error",
        message=message,
        action=action,
        flow_id=effect.flow_id if effect is not None else (definition.flow_snapshot.flow.id if definition is not None else None),
        node_id=owner_id if owner_kind == "node_entry" else (effect.owner_node_id if effect is not None else None),
        transition_id=owner_id if owner_kind == "flow_transition" else None,
        invocation_id=owner_id if owner_kind == "flow_invocation" else None,
        exit_id=owner_id if owner_kind == "flow_exit" else None,
        effect_id=(effect.authored_effect_id or effect.id) if effect is not None else effect_id,
        item_node_id=item_node_id,
        holder_kind=holder.kind if holder is not None else None,
        holder_node_id=holder.node_id if holder is not None else None,
    )


def _failed(
    state_before: PlaybackState,
    facts: Sequence[PlaybackFact],
) -> PlaybackEffectApplication:
    return PlaybackEffectApplication(
        success=False,
        state_before=state_before,
        state_after=state_before.model_copy(deep=True),
        facts=_sorted_facts(facts),
    )


def _sorted_facts(facts: Sequence[PlaybackFact]) -> list[PlaybackFact]:
    return sorted(
        facts,
        key=lambda fact: (
            fact.code,
            fact.effect_id or "",
            fact.node_id or "",
            fact.transition_id or "",
            fact.message,
        ),
    )
