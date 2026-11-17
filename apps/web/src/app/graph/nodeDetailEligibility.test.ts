import { expect, it } from "vitest";
import { queryNodeDetailEligibility as query, type NodeDetailEligibility, type NodeDetailEligibilityInputs } from "./nodeDetailEligibility";
import policy from "../../../performance/rendering-policy.v1.json";

const scope = { projectId: "project", workspaceMode: "relationships" as const, flowId: null, focusedFrameId: null };
const chain = (size: number) => Array.from({ length: size }, (_, index) => ({ id: `visual-${index}`, parentId: index ? `visual-${index - 1}` : undefined }));
const input = (zoom = 1, extra: Partial<NodeDetailEligibilityInputs> = {}): NodeDetailEligibilityInputs => ({ scope, zoom, placements: chain(5), ...extra });
const mode = (result: NodeDetailEligibility, index: number) => result.details.get(`visual-${index}`)!.mode;

it.each([[0.01, "overview", 3], [0.19999, "overview", 3], [0.2, "compact", 3], [0.64999, "compact", 3],
  [0.65, "full", 3], [1.24999, "full", 3], [1.25, "full", 4], [2.5, "full", 5], [5, "full", 6], [10, "full", 7]] as const)(
  "applies frozen nominal policy at %s", (zoom, band, visibleLevels) => {
    const result = query(input(zoom)); expect(result).toMatchObject({ band, visibleLevels, fallback: "none" });
    expect(mode(result, 0)).toBe(band); expect(mode(result, 2)).toBe(band);
    expect(mode(result, 3)).toBe(visibleLevels === 3 ? "folded" : band);
  }
);

it("counts direct/transitive folded visual rows and does not mutate or retain authored records", () => {
  const value = input(), before = JSON.stringify(value), result = query(value);
  expect(JSON.stringify(value)).toBe(before);
  expect(result.details.get("visual-2")).toEqual({ mode: "full", depth: 2, foldedDirect: 1, foldedDescendants: 2 });
  expect(result.details.get("visual-0")).toEqual({ mode: "full", depth: 0, foldedDirect: 0, foldedDescendants: 2 });
  expect(Object.isFrozen(result)).toBe(true); expect(Object.isFrozen(result.scope)).toBe(true); expect(Object.isFrozen(result.details.get("visual-2"))).toBe(true);
  (value.placements[2] as { parentId: string }).parentId = "changed";
  expect(result.details.get("visual-2")!.depth).toBe(2); expect(before).not.toBe(JSON.stringify(value));
});

it("applies 15% band hysteresis, including jumps across both bands", () => {
  const overview = query(input(0.1)), compact = query(input(0.3)), full = query(input(1));
  expect(query(input(0.22, { previous: overview })).band).toBe("overview");
  expect(query(input(0.231, { previous: overview })).band).toBe("compact");
  expect(query(input(0.171, { previous: compact })).band).toBe("compact");
  expect(query(input(0.169, { previous: compact })).band).toBe("overview");
  expect(query(input(0.74, { previous: compact })).band).toBe("compact");
  expect(query(input(0.75, { previous: compact })).band).toBe("full");
  expect(query(input(0.56, { previous: full })).band).toBe("full");
  expect(query(input(0.55, { previous: full })).band).toBe("compact");
  expect(query(input(10, { previous: overview })).band).toBe("full");
  expect(query(input(0.01, { previous: full })).band).toBe("overview");
});

it("enriches/retains containment levels with deadbands and reaches the last level at maximum zoom", () => {
  const base = query(input(1)), four = query(input(1.5));
  expect(query(input(1.4, { previous: base })).visibleLevels).toBe(3);
  expect(query(input(1.4375, { previous: base })).visibleLevels).toBe(4);
  expect(query(input(1.1, { previous: four })).visibleLevels).toBe(4);
  expect(query(input(1.05, { previous: four })).visibleLevels).toBe(3);
  const six = query(input(6));
  expect(query(input(9.99, { previous: six })).visibleLevels).toBe(6);
  expect(query(input(10, { previous: six })).visibleLevels).toBe(7);
  expect(query(input(0.01, { previous: six })).visibleLevels).toBe(3);
});

it("preserves the existing protected path while counting other folded descendants", () => {
  const protectedIds = new Set(["visual-0", "visual-1", "visual-2", "visual-3"]);
  const result = query(input(0.01, { protectedIds }));
  expect([0, 1, 2, 3].map((index) => mode(result, index))).toEqual(["full", "full", "full", "full"]);
  expect(mode(result, 4)).toBe("folded"); expect(result.details.get("visual-2")!.foldedDescendants).toBe(1);
  expect([...protectedIds]).toHaveLength(4); expect(query(input(0.01)).details.get("visual-0")!.mode).toBe("overview");
});

it("uses focused projection roots and distinct linked visual ids without canonical deduplication", () => {
  const placements = [{ id: "frame" }, { id: "primary", parentId: "frame" }, { id: "linked", parentId: "frame" }];
  const result = query(input(1, { placements })); expect(result.details.size).toBe(3);
  expect(result.details.get("primary")!.depth).toBe(1); expect(result.details.get("linked")!.depth).toBe(1);
  const focused = query(input(1, { placements: [{ id: "linked" }], scope: { ...scope, focusedFrameId: "frame" }, previous: result }));
  expect(focused.details.get("linked")!.depth).toBe(0); expect(focused.details.size).toBe(1);
});

it.each(["project", "workspace", "flow", "frame"])("does not reuse %s hysteresis from another scope", (change) => {
  const previous = query(input(1));
  const nextScope = { ...scope, projectId: change === "project" ? "other" : scope.projectId,
    workspaceMode: change === "workspace" ? "flow" as const : scope.workspaceMode,
    flowId: change === "flow" ? "flow" : null, focusedFrameId: change === "frame" ? "frame" : null };
  expect(query(input(0.6, { scope: nextScope, previous })).band).toBe("compact");
});

it.each([NaN, Infinity, -1, 0, 0.009, 10.01])("keeps every visual control full for invalid zoom %s", (zoom) => {
  const result = query(input(zoom)); expect(result.fallback).toBe("zoom");
  expect([...result.details.values()].every((row) => row.mode === "full" && row.depth === null && row.foldedDescendants === 0)).toBe(true);
  expect(query(input(0.6, { previous: result })).band).toBe("compact");
});

it.each([
  [{ id: "" }], [{ id: "duplicate" }, { id: "duplicate" }], [{ id: "orphan", parentId: "missing" }],
  [{ id: "cycle", parentId: "cycle" }], [{ id: "a", parentId: "b" }, { id: "b", parentId: "a" }]
].map((placements) => ({ placements })))("retains all ambiguous or invalid ancestry without throwing", ({ placements }) => {
  const result = query(input(0.01, { placements })); expect(result.fallback).not.toBe("none");
  expect([...result.details.values()].every((row) => row.mode === "full" && row.depth === null)).toBe(true);
});

it("does not accept malformed previous depth budgets and handles an empty view", () => {
  const previous = query(input(1));
  for (const visibleLevels of [NaN, -1, 3.5, 1000]) expect(query(input(0.6, { previous: { ...previous, visibleLevels } })).band).toBe("compact");
  expect(query(input(1, { placements: [] })).details.size).toBe(0);
  expect(policy.base_visible_levels).toBe(3); expect(policy.zoom_hysteresis_ratio).toBe(0.15);
});

it("counts independently branched folded detail in any input order and forgets removed visual rows", () => {
  const placements = [{ id: "root" }, ...["a", "b"].flatMap((branch) => [
    { id: `${branch}1`, parentId: "root" }, { id: `${branch}2`, parentId: `${branch}1` }, { id: `${branch}3`, parentId: `${branch}2` }
  ])].reverse();
  const first = query(input(1, { placements })); expect(first.details.get("root")!.foldedDescendants).toBe(2);
  expect(first.details.get("a2")!.foldedDirect).toBe(1); expect(first.details.get("b2")!.foldedDirect).toBe(1);
  const next = query(input(1, { placements: [{ id: "root" }], previous: first }));
  expect([...next.details.keys()]).toEqual(["root"]); expect(next.details.get("root")!.foldedDescendants).toBe(0);
});

it("handles 10,000 reversed deep placements iteratively with bounded input reads and exact counts", () => {
  let reads = 0;
  const placements = chain(10000).reverse().map((row) => ({ get id() { reads++; return row.id; }, get parentId() { reads++; return row.parentId; } }));
  const result = query(input(1, { placements }));
  expect(result.details.size).toBe(10000); expect(result.details.get("visual-9999")!.depth).toBe(9999);
  expect(result.details.get("visual-0")!.foldedDescendants).toBe(9997); expect(reads).toBe(30000);
});
