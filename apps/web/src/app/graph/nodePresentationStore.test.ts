import { expect, it, vi } from "vitest";
import { createNodePresentationStore } from "./nodePresentationStore";
import { projectViewportPlacements, protectedViewportPlacements } from "./nodePresentationGeometry";
import { queryViewportEligibility } from "./viewportEligibility";
import type { CommittedEligibilityInputs } from "./viewportEligibilityScheduler";
import type { Node } from "@xyflow/react";
import type { NarrativeNodeRenderData } from "../workspaceShared";

const node = (id: string, x = 0, extra: Partial<Node<NarrativeNodeRenderData>> = {}): Node<NarrativeNodeRenderData> => ({
  id, position: { x, y: 0 }, width: 260, height: 156,
  data: { kind: "Character", title: id, label: id, summary: "Text", tags: [] }, ...extra
});
const inputs = (nodes = [node("near"), node("far", 10000)], extra: Partial<CommittedEligibilityInputs> = {}): CommittedEligibilityInputs => ({
  placements: projectViewportPlacements(nodes), scope: { projectId: "A", workspaceMode: "relationships", flowId: null, focusedFrameId: null },
  resetKey: "document", viewport: { x: 0, y: 0, width: 1440, height: 900, zoom: 1 }, protectedIds: new Set(), ...extra
});

it("defaults to full and notifies only the id whose boolean changed", () => {
  const store = createNodePresentationStore();
  const near = vi.fn(), far = vi.fn();
  const stopNear = store.reader.subscribe("near", near), stopFar = store.reader.subscribe("far", far);
  expect(store.reader.isFull("unknown")).toBe(true);
  const current = inputs(); store.commit(current); store.publish(queryViewportEligibility(current));
  expect(near).not.toHaveBeenCalled(); expect(far).toHaveBeenCalledTimes(1);
  store.publish(queryViewportEligibility(current));
  expect(far).toHaveBeenCalledTimes(1);
  store.commit({ ...current, protectedIds: new Set(["far"]) });
  expect(far).toHaveBeenCalledTimes(2); expect(near).not.toHaveBeenCalled();
  stopNear(); stopFar(); store.commit(null);
  expect(far).toHaveBeenCalledTimes(2);
});

it("keeps changed/new geometry full until that geometry has actually been evaluated", () => {
  const store = createNodePresentationStore();
  const old = inputs(); store.commit(old); store.publish(queryViewportEligibility(old));
  expect(store.reader.isFull("far")).toBe(false);
  const moved = inputs([node("near"), node("far", 20000), node("new", 30000)]);
  store.commit(moved);
  expect(store.reader.isFull("far")).toBe(true); expect(store.reader.isFull("new")).toBe(true);
  store.publish(queryViewportEligibility(moved));
  expect(store.reader.isFull("far")).toBe(false); expect(store.reader.isFull("new")).toBe(false);
  const resized = inputs([node("far", 20000, { width: 400 })]); store.commit(resized);
  expect(store.reader.isFull("far")).toBe(true);
  expect(store.reader.isFull("near")).toBe(true); // Removed/unknown ids never inherit an old absence.
});

it("retires old scope/document masks and ignores another scope's output", () => {
  const store = createNodePresentationStore();
  const old = inputs(); store.commit(old); store.publish(queryViewportEligibility(old));
  const replacement = { ...old, scope: { ...old.scope, projectId: "B" } };
  store.commit(replacement); expect(store.reader.isFull("far")).toBe(true);
  store.publish(queryViewportEligibility(old)); expect(store.reader.isFull("far")).toBe(true);
  store.publish(queryViewportEligibility(replacement)); expect(store.reader.isFull("far")).toBe(false);
  store.commit({ ...replacement, resetKey: {} }); expect(store.reader.isFull("far")).toBe(true);
  store.commit(null); store.publish(queryViewportEligibility(replacement));
  expect(store.reader.isFull("far")).toBe(true);
});

it("camera-only commits preserve subscription booleans until the next frame", () => {
  const store = createNodePresentationStore(), current = inputs(), far = vi.fn();
  store.commit(current); store.publish(queryViewportEligibility(current));
  store.reader.subscribe("far", far);
  const panned = { ...current, viewport: { ...current.viewport, x: -10000 } };
  store.commit(panned); expect(far).not.toHaveBeenCalled();
  store.publish(queryViewportEligibility(panned)); expect(far).toHaveBeenCalledTimes(1);
  expect(store.reader.isFull("far")).toBe(true);
});

it("keeps unknown/invalid geometry and zero-size viewport conservative", () => {
  const store = createNodePresentationStore();
  for (const current of [inputs([node("far", 10000, { width: undefined })]), inputs(undefined, { viewport: { x: 0, y: 0, zoom: 1, width: 0, height: 0 } })]) {
    store.commit(current); store.publish(queryViewportEligibility(current));
    expect(store.reader.isFull("far")).toBe(true);
  }
});

it("projects current relative geometry, linked ids and unplaced fallback nodes without changing the graph", () => {
  const nodes = [node("frame", 10000), node("linked", 20, { parentId: "frame", data: { ...node("linked").data, canonicalNodeId: "canonical" } }), node("unplaced", 20000)];
  const before = structuredClone(nodes);
  expect(projectViewportPlacements(nodes)[1]).toEqual({ id: "linked", parentId: "frame", worldBounds: { x: 10020, y: 0, width: 260, height: 156 } });
  expect(protectedViewportPlacements(nodes, ["canonical"])).toEqual(new Set(["linked", "frame"]));
  expect(projectViewportPlacements(nodes)[2]?.id).toBe("unplaced");
  expect(nodes).toEqual(before);
});

it("protects every selected/dragged/connection/drop placement and its ancestry without a cap", () => {
  const nodes = [node("parent"), ...Array.from({ length: 1000 }, (_, index) => node(`selected-${index}`, 10000, { selected: true, parentId: "parent" })),
    node("drag", 10000, { dragging: true }), node("source", 10000, { data: { ...node("source").data, isConnectionSource: true } }),
    node("target", 10000, { data: { ...node("target").data, isConnectionTarget: true } }),
    node("drop", 10000, { data: { ...node("drop").data, compositionDropState: { valid: true, message: "Drop" } } })];
  expect(protectedViewportPlacements(nodes, [null, "retired"]).size).toBe(1005);
  expect(protectedViewportPlacements(nodes.map((item) => ({ ...item, selected: false, dragging: false, data: { ...item.data,
    isConnectionSource: false, isConnectionTarget: false, compositionDropState: undefined } })), []).size).toBe(0);
});

it("terminates malformed ancestor cycles without inventing missing parents", () => {
  const nodes = [node("a", 10000, { parentId: "b", selected: true }), node("b", 10000, { parentId: "a" }), node("orphan", 10000, { parentId: "missing", selected: true })];
  expect(protectedViewportPlacements(nodes, [])).toEqual(new Set(["a", "b", "orphan"]));
  const current = inputs(nodes), store = createNodePresentationStore(); store.commit(current); store.publish(queryViewportEligibility(current));
  expect(store.reader.isFull("b")).toBe(true);
});

it("protects active diagnostic targets and ancestors, then releases them when the review clears", () => {
  const base = [node("frame", 10000), node("analysis", 10, { parentId: "frame" }), node("canon", 20000), node("impact", 30000), node("ordinary-issue", 40000)];
  const nodes = base.map((item) => ({ ...item, data: { ...item.data,
    analysisPreview: item.id === "analysis" ? "Review proposed edge" : undefined,
    canonTarget: item.id === "canon" || undefined,
    impactHighlight: item.id === "impact" ? { findingId: "finding", preview: "Review impact", propagation: null, role: "direct" as const } : undefined,
    issueCount: item.id === "ordinary-issue" ? 5 : undefined
  } }));
  expect(protectedViewportPlacements(nodes, [])).toEqual(new Set(["analysis", "canon", "impact", "frame"]));
  expect(protectedViewportPlacements(base, [])).toEqual(new Set());
});

it("protects every selected edge's original endpoints with one pass through edges", () => {
  const nodes = [node("a", 10000), node("b", 20000), node("unselected", 30000)];
  let reads = 0;
  const edges = Array.from({ length: 1000 }, (_, index) => ({ get id() { reads++; return `edge-${index}`; }, source: "a", target: "b" }));
  const ids = edges.map((edge) => edge.id); reads = 0;
  expect(protectedViewportPlacements(nodes, [], edges, ids)).toEqual(new Set(["a", "b"]));
  expect(reads).toBe(1000);
  expect(protectedViewportPlacements(nodes, [], [{ id: "marked", source: "a", target: "b", selected: true }])).toEqual(new Set(["a", "b"]));
});
