import type {
  NarrativeEffectBinding,
  NarrativeEffectDefinition,
  NarrativeEffectOwnerRef,
  StateHolderRef
} from "@something-to-tell/contracts/narrative-state";

export type DomainEffectAction =
  | "give_item"
  | "take_item"
  | "move_item"
  | "set_flag"
  | "clear_flag"
  | "update_quest"
  | "record_choice";

export interface DomainEffectDraft {
  action: DomainEffectAction;
  itemNodeId: string;
  fromHolder: StateHolderRef;
  toHolder: StateHolderRef;
  flag: string;
  questNodeId: string;
  questStatus: "inactive" | "active" | "completed" | "failed";
  dialogueNodeId: string;
  choiceId: string;
  repeatPolicy: "once" | "per_visit";
  explanation: string;
}

/** Stable owner comparison avoids depending on object identity or key ordering. */
export function narrativeOwnerKey(owner: NarrativeEffectOwnerRef): string {
  return `${owner.owner_kind}:${owner.context_node_id ?? ""}:${owner.owner_id}`;
}

/** Returns deterministic owner-local effects in authored application order. */
export function effectsForOwner(
  owner: NarrativeEffectOwnerRef,
  bindings: NarrativeEffectBinding[],
  effects: NarrativeEffectDefinition[]
): Array<{ binding: NarrativeEffectBinding; effect: NarrativeEffectDefinition }> {
  const effectsById = new Map(effects.map((effect) => [effect.id, effect]));
  return bindings
    .filter((binding) => narrativeOwnerKey(binding.owner) === narrativeOwnerKey(owner))
    .sort((left, right) => left.application_order - right.application_order || left.id.localeCompare(right.id))
    .flatMap((binding) => {
      const effect = effectsById.get(binding.effect_id);
      return effect ? [{ binding, effect }] : [];
    });
}

/** Maps author-facing verbs to the runtime's small typed operation vocabulary. */
export function effectFromDomainDraft(
  draft: DomainEffectDraft,
  projectId: string,
  effectId: string
): NarrativeEffectDefinition {
  const common = {
    effect_version: 1 as const,
    id: effectId,
    project_id: projectId,
    repeat_policy: draft.repeatPolicy,
    explanation: draft.explanation.trim()
  };
  if (draft.action === "give_item" || draft.action === "take_item" || draft.action === "move_item") {
    return {
      ...common,
      operation: "transfer_item",
      payload: {
        item_node_id: draft.itemNodeId,
        from_holder: draft.fromHolder,
        to_holder: draft.toHolder
      }
    };
  }
  if (draft.action === "set_flag" || draft.action === "clear_flag") {
    return {
      ...common,
      operation: draft.action,
      payload: { flag: draft.flag.trim() }
    };
  }
  if (draft.action === "update_quest") {
    return {
      ...common,
      operation: "set_quest_status",
      payload: { quest_node_id: draft.questNodeId, status: draft.questStatus }
    };
  }
  return {
    ...common,
    operation: "record_dialogue_choice",
    payload: { dialogue_node_id: draft.dialogueNodeId, choice_id: draft.choiceId.trim() }
  };
}

/** Rehydrates a reusable effect into the editor without exposing raw JSON payloads. */
export function domainDraftFromEffect(effect: NarrativeEffectDefinition): DomainEffectDraft {
  const base: DomainEffectDraft = {
    action: "move_item",
    itemNodeId: "",
    fromHolder: { holder_version: 1, kind: "unowned" },
    toHolder: { holder_version: 1, kind: "player" },
    flag: "",
    questNodeId: "",
    questStatus: "inactive",
    dialogueNodeId: "",
    choiceId: "",
    repeatPolicy: effect.repeat_policy,
    explanation: effect.explanation
  };
  switch (effect.operation) {
    case "transfer_item":
      return { ...base, itemNodeId: effect.payload.item_node_id, fromHolder: effect.payload.from_holder, toHolder: effect.payload.to_holder };
    case "set_flag":
      return { ...base, action: "set_flag", flag: effect.payload.flag };
    case "clear_flag":
      return { ...base, action: "clear_flag", flag: effect.payload.flag };
    case "set_quest_status":
      return { ...base, action: "update_quest", questNodeId: effect.payload.quest_node_id, questStatus: effect.payload.status };
    case "record_dialogue_choice":
      return { ...base, action: "record_choice", dialogueNodeId: effect.payload.dialogue_node_id, choiceId: effect.payload.choice_id };
  }
}

/** Produces the complete contiguous reorder payload expected by the runtime. */
export function moveEffectBinding(
  bindings: NarrativeEffectBinding[],
  bindingId: string,
  direction: -1 | 1
): Array<{ binding_id: string; application_order: number }> {
  const ordered = [...bindings].sort((left, right) => left.application_order - right.application_order);
  const index = ordered.findIndex((binding) => binding.id === bindingId);
  const target = index + direction;
  if (index < 0 || target < 0 || target >= ordered.length) {
    return ordered.map((binding, application_order) => ({ binding_id: binding.id, application_order }));
  }
  [ordered[index], ordered[target]] = [ordered[target]!, ordered[index]!];
  return ordered.map((binding, application_order) => ({ binding_id: binding.id, application_order }));
}
