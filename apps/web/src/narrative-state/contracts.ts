import type {
  FlowInitialState,
  NarrativeEffectBinding,
  NarrativeEffectDefinition,
  NarrativeEffectOwnerRef
} from "@something-to-tell/contracts/narrative-state";

/** Runtime projection adds persistence timestamps to the shared authored state. */
export interface FlowInitialStateRecord extends FlowInitialState {
  id: string;
  created_at: string;
  updated_at: string;
}

/** Runtime projection adds persistence timestamps to the shared effect binding. */
export interface NarrativeEffectBindingRecord extends NarrativeEffectBinding {
  created_at: string;
  updated_at: string;
}

export interface NarrativeStateIntegrityFact {
  code: "narrative_state_unbound_effect" | "narrative_state_transfer_item_uninitialized";
  level: "info" | "warning";
  effect_id: string | null;
  node_id: string | null;
  parameters: Record<string, string | number>;
}

/** Complete project-scoped authoring snapshot consumed by domain editors. */
export interface NarrativeStateSnapshot {
  project_id: string;
  initial_states: FlowInitialStateRecord[];
  effects: NarrativeEffectDefinition[];
  bindings: NarrativeEffectBindingRecord[];
  integrity: {
    project_id: string;
    facts: NarrativeStateIntegrityFact[];
  };
}

export interface NarrativeStateDeletionImpact {
  subject_kind: "initial_state" | "effect" | "owner" | "node";
  subject_id: string;
  initial_state_ids: string[];
  effect_ids: string[];
  binding_ids: string[];
}

export interface RelationshipInitialStatePreview {
  project_id: string;
  edge_id: string;
  flow_id: string;
  custody: FlowInitialState["item_custody"][number];
  already_applied: boolean;
  conflict_holder: Record<string, unknown> | null;
}

export interface RelationshipInitialStateApplyResponse {
  changed: boolean;
  initial_state: FlowInitialStateRecord;
}

/** Mutation boundary shared by every node, route, Dialogue, Quest, call, and exit editor. */
export interface RuntimeNarrativeStatePersistence {
  getNarrativeStateSnapshot(projectId: string): Promise<NarrativeStateSnapshot>;
  createNarrativeEffect(projectId: string, effect: NarrativeEffectDefinition): Promise<NarrativeEffectDefinition>;
  updateNarrativeEffect(projectId: string, effect: NarrativeEffectDefinition): Promise<NarrativeEffectDefinition>;
  getNarrativeEffectImpact(effectId: string): Promise<NarrativeStateDeletionImpact>;
  deleteNarrativeEffect(projectId: string, effectId: string, impactReviewed: boolean): Promise<void>;
  createNarrativeEffectBinding(projectId: string, effectId: string, owner: NarrativeEffectOwnerRef, applicationOrder: number): Promise<NarrativeEffectBindingRecord>;
  deleteNarrativeEffectBinding(projectId: string, bindingId: string): Promise<void>;
  reorderNarrativeEffectBindings(projectId: string, owner: NarrativeEffectOwnerRef, bindings: Array<{ binding_id: string; application_order: number }>): Promise<NarrativeEffectBindingRecord[]>;
  previewRelationshipInitialState(projectId: string, edgeId: string, flowId: string): Promise<RelationshipInitialStatePreview>;
  applyRelationshipInitialState(projectId: string, edgeId: string, flowId: string): Promise<RelationshipInitialStateApplyResponse>;
}
