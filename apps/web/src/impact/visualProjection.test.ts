import { describe, expect, it } from "vitest";
import type { ImpactVisualChange, ImpactVisualDiffProjection } from "@something-to-tell/contracts/impact-resolution";
import { impactVisualOwnerKey, presentImpactVisualChanges, switchImpactVisualMode } from "./visualProjection";

const addedNode = { owner_type: "node", owner_id: "node-added", context_type: null, context_id: null };
const removedNode = { owner_type: "node", owner_id: "node-removed", context_type: null, context_id: null };
const added = change("add", null, addedNode, true);
const removed = change("remove", removedNode, null, false);
const projection: ImpactVisualDiffProjection = {
  projection_version: 1,
  alternative_fingerprint: "a".repeat(64),
  source_checksum: "b".repeat(64),
  target_checksum: "c".repeat(64),
  changes: [added, removed]
};

describe("Impact visual projection state", () => {
  it("provides textual/icon cue identities in addition to color-independent chrome flags", () => {
    const changes = presentImpactVisualChanges(projection, "changes");

    expect(changes.map((item) => item.cue)).toEqual(["added", "removed"]);
    expect(changes[0]).toMatchObject({ ghosted: true, faded: false, previewOnly: true });
    expect(changes[1]).toMatchObject({ ghosted: false, faded: true, previewOnly: false });
    expect(presentImpactVisualChanges(projection, "before")).toHaveLength(1);
    expect(presentImpactVisualChanges(projection, "after")).toHaveLength(1);
  });

  it("preserves viewport and only surviving selection while switching modes", () => {
    const selectedOwnerKey = impactVisualOwnerKey(removedNode);
    const state = { mode: "changes" as const, selectedOwnerKey, viewport: { x: 41, y: -12, zoom: 1.4 } };

    const before = switchImpactVisualMode(state, "before", projection);
    const after = switchImpactVisualMode(state, "after", projection);
    const stableOwnerKey = "node\u0000stable\u0000\u0000";
    const stable = switchImpactVisualMode(
      { ...state, selectedOwnerKey: stableOwnerKey },
      "after",
      projection,
      new Set([stableOwnerKey])
    );

    expect(before).toMatchObject({ selectedOwnerKey, viewport: state.viewport });
    expect(after).toMatchObject({ selectedOwnerKey: null, viewport: state.viewport });
    expect(stable).toMatchObject({ selectedOwnerKey: stableOwnerKey, viewport: state.viewport });
    expect(stable.viewport).not.toBe(state.viewport);
  });
});

function change(
  kind: ImpactVisualChange["kind"],
  before_resource: ImpactVisualChange["before_resource"],
  after_resource: ImpactVisualChange["after_resource"],
  previewOnly: boolean
): ImpactVisualChange {
  return {
    visual_change_version: 1,
    id: kind.padEnd(64, "0"),
    kind,
    surface: "graph",
    before_resource,
    after_resource,
    field_changes: [],
    before_placement: before_resource ? { x: 0, y: 0, width: 200, height: 120, preview_only: previewOnly } : null,
    after_placement: after_resource ? { x: 0, y: 0, width: 200, height: 120, preview_only: previewOnly } : null
  };
}
