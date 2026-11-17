import type {
  ImpactVisualChange,
  ImpactVisualDiffProjection,
  ImpactVisualMode
} from "@something-to-tell/contracts/impact-resolution";
import type { Viewport } from "@xyflow/react";

export type ImpactVisualCue = "added" | "removed" | "modified" | "moved" | "unchanged";

export interface ImpactVisualPresentation {
  change: ImpactVisualChange;
  cue: ImpactVisualCue;
  faded: boolean;
  ghosted: boolean;
  previewOnly: boolean;
}

export interface ImpactVisualReviewState {
  mode: ImpactVisualMode;
  selectedOwnerKey: string | null;
  viewport: Viewport;
}

/** Projects one review mode while retaining authored viewport state outside the project store. */
export function presentImpactVisualChanges(
  projection: ImpactVisualDiffProjection,
  mode: ImpactVisualMode
): ImpactVisualPresentation[] {
  return projection.changes
    .filter((change) => mode === "changes"
      || (mode === "before" ? change.before_resource !== null : change.after_resource !== null))
    .map((change) => {
      const placement = mode === "before" || (mode === "changes" && change.kind === "remove")
        ? change.before_placement
        : change.after_placement;
      return {
        change,
        cue: ({ add: "added", remove: "removed", modify: "modified", move: "moved", unchanged: "unchanged" } as const)[change.kind],
        faded: change.kind === "remove",
        ghosted: change.kind === "add",
        previewOnly: placement?.preview_only ?? false
      };
    });
}

/** Changes only transient review state and keeps selection when its owner survives the target mode. */
export function switchImpactVisualMode(
  state: ImpactVisualReviewState,
  mode: ImpactVisualMode,
  projection: ImpactVisualDiffProjection,
  survivingOwnerKeys: ReadonlySet<string> = new Set()
): ImpactVisualReviewState {
  const visibleOwners = new Set(
    presentImpactVisualChanges(projection, mode).flatMap(({ change }) => [
      change.before_resource ? impactVisualOwnerKey(change.before_resource) : null,
      change.after_resource ? impactVisualOwnerKey(change.after_resource) : null
    ].filter((key): key is string => key !== null))
  );
  const selectedOwnerKey = state.selectedOwnerKey
    && (visibleOwners.has(state.selectedOwnerKey) || survivingOwnerKeys.has(state.selectedOwnerKey))
    ? state.selectedOwnerKey
    : null;
  return { ...state, mode, selectedOwnerKey, viewport: { ...state.viewport } };
}

/** Canonical owner keys let Graph and specialized editors share one selection identity. */
export function impactVisualOwnerKey(owner: NonNullable<ImpactVisualChange["before_resource"]>): string {
  return [owner.owner_type, owner.owner_id, owner.context_type ?? "", owner.context_id ?? ""].join("\u0000");
}
