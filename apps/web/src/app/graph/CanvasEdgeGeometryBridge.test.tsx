import { Position, useStore, type Edge, type EdgeProps } from "@xyflow/react";
import { act, cleanup, render } from "@testing-library/react";
import { StrictMode, useState, type ReactNode } from "react";
import { createPortal } from "react-dom";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import type { NarrativeEdgeData } from "../../types";
import { CanvasEdgeGeometryBridge, EDGE_GEOMETRY_OBSERVATION_ENABLED, type CanvasEdgeGeometryInputs } from "./CanvasEdgeGeometryBridge";
import { RelationshipEdge, StoryFlowEdge } from "./GraphCanvasParts";
import * as query from "./viewportEdgeEligibility";

const flow = vi.hoisted(() => ({ state: { domNode: null as HTMLElement | null, transform: [0, 0, 1], width: 1440, height: 900 }, portal: null as HTMLElement | null }));
// Real BaseEdge and route helpers; isolate camera notifications/portal hosting, not SVG construction.
vi.mock("@xyflow/react", async (original) => ({ ...await original<typeof import("@xyflow/react")>(),
  useStore: vi.fn((selector: (state: typeof flow.state) => unknown) => selector(flow.state)),
  ViewportPortal: ({ children }: { children: ReactNode }) => createPortal(children, flow.portal!),
  EdgeLabelRenderer: ({ children }: { children: ReactNode }) => createPortal(children, flow.portal!)
}));
const scope = { projectId: "project", workspaceMode: "relationships" as const, flowId: null, focusedFrameId: null };
let callbacks = new Map<number, FrameRequestCallback>(), sequence = 0;
beforeEach(() => {
  callbacks = new Map(); sequence = 0;
  vi.stubGlobal("MutationObserver", undefined); vi.stubGlobal("ResizeObserver", undefined);
  vi.spyOn(window, "requestAnimationFrame").mockImplementation((callback) => { callbacks.set(++sequence, callback); return sequence; });
  // Retain cancelled callbacks to prove guards, not just host cancellation.
  vi.spyOn(window, "cancelAnimationFrame").mockImplementation(() => {});
  vi.mocked(useStore).mockClear();
  flow.state = { domNode: null, transform: [0, 0, 1], width: 1440, height: 900 };
});
afterEach(() => { cleanup(); document.body.replaceChildren(); vi.restoreAllMocks(); vi.unstubAllGlobals(); });
const flush = () => act(() => { const pending = [...callbacks.values()]; callbacks.clear(); pending.forEach((callback) => callback(0)); });
const props = (id = "edge"): EdgeProps<Edge<NarrativeEdgeData>> => ({
  id, source: "original-source", target: "original-target", sourceX: 10, sourceY: 20, targetX: 600, targetY: 220,
  sourcePosition: Position.Right, targetPosition: Position.Left, selected: false, selectable: true, deletable: true,
  animated: false, markerEnd: "url(#original-arrow)", data: { label: "Actual label" }
});
function fixture() {
  const root = document.createElement("div"), mount = document.createElement("div"), portal = document.createElement("div");
  root.append(mount, portal); document.body.append(root); flow.state.domNode = root; flow.portal = portal;
  return { root, mount };
}
function layout(root: HTMLElement, x = 100) {
  for (const path of root.querySelectorAll("path[data-narrative-edge-route]")) {
    Object.defineProperty(path, "getScreenCTM", { configurable: true, value: () => ({ a: 1, b: 0, c: 0, d: 1, e: 0, f: 0 }) });
  }
  for (const label of root.querySelectorAll("[data-narrative-edge-label]")) {
    Object.defineProperty(label, "getClientRects", { configurable: true, value: () => [{}] });
    Object.defineProperty(label, "getBoundingClientRect", { configurable: true, value: () => ({ left: x, top: 40, width: 120, height: 24 }) });
  }
}

it("defaults off without any camera selector or frame work, independently of existing card presentation", () => {
  expect(EDGE_GEOMETRY_OBSERVATION_ENABLED).toBe(false);
  render(<CanvasEdgeGeometryBridge edges={[{ id: "edge" }]} scope={scope} resetKey="document" />);
  expect(useStore).not.toHaveBeenCalled(); expect(requestAnimationFrame).not.toHaveBeenCalled();
  expect(document.querySelector("[data-edge-world-anchor]")).toBeNull();
});

it("reads real Relationship, smooth and return-arc renderers by original ids without changing their paths, labels or markers", () => {
  const { root, mount } = fixture(), onMeasured = vi.fn();
  const ids = ['edge"[#]', "smooth", "arc"];
  const view = (summary = "Actual label", sourceX = 10) => <>
    <svg><RelationshipEdge {...props(ids[0])} sourceX={sourceX} label={summary} />
      <StoryFlowEdge {...props("smooth")} /><StoryFlowEdge {...props("arc")} data={{ label: "Return label", flowRouteArc: true }} /></svg>
    <CanvasEdgeGeometryBridge enabled edges={ids.map((id) => ({ id }))} scope={scope} resetKey="document" onMeasured={onMeasured} />
  </>;
  const rendered = render(view(), { container: mount }); layout(root);
  const routes = () => [...root.querySelectorAll("path[data-narrative-edge-route]")];
  const first = routes().map((path) => path.getAttribute("d"));
  flush();
  expect(root.querySelectorAll("[data-edge-world-anchor] g")).toHaveLength(1);
  const snapshot = onMeasured.mock.lastCall![0]!;
  expect(snapshot.labelBoxes.map((label: { id: string }) => label.id)).toEqual(ids);
  expect(snapshot.labelBoxes[0]!.bounds).toEqual({ x: 100, y: 40, width: 120, height: 24 });
  expect([...snapshot.eligibility.eligibleIds]).toEqual(ids);
  expect(snapshot.footprints.edges.every((edge: { routeBounds: unknown }) => edge.routeBounds === null)).toBe(true);
  expect(routes().map((path) => path.getAttribute("d"))).toEqual(first);
  expect(routes().map((path) => path.id)).toEqual(ids);
  expect(routes().every((path) => path.getAttribute("marker-end") === "url(#original-arrow)")).toBe(true);
  expect(root.querySelectorAll(".react-flow__edge-interaction")).toHaveLength(3);
  rendered.rerender(view("Renamed label", 70)); layout(root, 500);
  expect(onMeasured.mock.lastCall![0]).toBeNull(); flush();
  expect(onMeasured.mock.lastCall![0]!.labelBoxes[0]!.bounds!.x).toBe(500);
  expect(routes()[0]!.getAttribute("d")).not.toBe(first[0]);
  expect(root.textContent).toContain("Renamed label");
  expect(snapshot.labelBoxes[0]!.bounds!.x).toBe(100);
});

it("distinguishes renderer-declared absence from unmeasured present labels, and handles camera invalidation read-only", () => {
  const { root, mount } = fixture(), onMeasured = vi.fn();
  const view = (label?: string) => <>
    <svg><RelationshipEdge {...props()} data={{ label: label ?? "" }} /></svg>
    <CanvasEdgeGeometryBridge enabled edges={[{ id: "edge" }]} scope={scope} resetKey="document" onMeasured={onMeasured} />
  </>;
  const rendered = render(view(), { container: mount }); flush();
  expect(onMeasured.mock.lastCall![0]!.footprints.edges[0]!.label.kind).toBe("none");
  flow.state.transform = [500, 300, 10]; rendered.rerender(view("Now present")); layout(root); flush();
  expect(onMeasured.mock.lastCall![0]!.footprints.edges[0]!.label.kind).toBe("unknown");
  expect([...onMeasured.mock.lastCall![0]!.eligibility.eligibleIds]).toEqual(["edge"]);
  flow.state.width = 0; rendered.rerender(view("Now present")); flush();
  expect(onMeasured.mock.lastCall![0]!.eligibility.fallback).toBe("viewport");
});

it.each(["project", "workspace", "flow", "frame", "document"])("retires pending callbacks before %s replacement and keeps enabled rollback independent", (change) => {
  const { root, mount } = fixture(), onMeasured = vi.fn();
  const bridge: CanvasEdgeGeometryInputs = { enabled: true, edges: [{ id: "edge" }], scope, resetKey: { document: 1 }, onMeasured };
  const view = (value = bridge) => <><svg><RelationshipEdge {...props()} /></svg><CanvasEdgeGeometryBridge {...value} /></>;
  const rendered = render(view(), { container: mount }); layout(root);
  const late = [...callbacks.values()][0]!;
  const next: CanvasEdgeGeometryInputs = { ...bridge,
    scope: { projectId: change === "project" ? "other" : scope.projectId,
      workspaceMode: change === "workspace" ? "flow" : scope.workspaceMode,
      flowId: change === "flow" ? "other" : null, focusedFrameId: change === "frame" ? "other" : null },
    resetKey: change === "document" ? { document: 2 } : bridge.resetKey };
  rendered.rerender(view(next)); act(() => late(0));
  expect(onMeasured.mock.calls.every(([snapshot]) => snapshot === null)).toBe(true);
  flush(); expect(onMeasured.mock.lastCall![0]!.footprints.scope).toEqual(next.scope);
  rendered.rerender(view({ ...next, enabled: false }));
  expect(onMeasured.mock.lastCall![0]).toBeNull();
  expect(root.querySelectorAll("path[data-narrative-edge-route]")).toHaveLength(1);
  const count = onMeasured.mock.calls.length; flush(); expect(onMeasured).toHaveBeenCalledTimes(count);
});

it("survives StrictMode cleanup/replay and cannot publish after unmount", () => {
  const { root, mount } = fixture(), onMeasured = vi.fn();
  const rendered = render(<StrictMode><svg><RelationshipEdge {...props()} /></svg>
    <CanvasEdgeGeometryBridge enabled edges={[{ id: "edge" }]} scope={scope} resetKey="document" onMeasured={onMeasured} /></StrictMode>, { container: mount });
  layout(root); flush(); expect(onMeasured.mock.lastCall![0]!.footprints.edges[0]!.id).toBe("edge");
  rendered.unmount(); const count = onMeasured.mock.calls.length; flush(); expect(onMeasured).toHaveBeenCalledTimes(count);
});

it("passes current selected and edited edge protection to the existing pure query", () => {
  const { mount } = fixture(), evaluate = vi.spyOn(query, "queryViewportEdgeEligibility");
  render(<CanvasEdgeGeometryBridge enabled edges={[{ id: "selected", selected: true }, { id: "edited" }, { id: "other" }]}
    protectedEdgeIds={["edited"]} scope={scope} resetKey="document" />, { container: mount });
  flush(); expect([...evaluate.mock.lastCall![0].protectedIds!]).toEqual(["edited", "selected"]);
});

it("does not schedule a feedback loop when a report rerenders its parent with equivalent protection", () => {
  const { mount } = fixture(), edges = [{ id: "edge" }], report = vi.fn();
  function Parent() {
    const [, setCount] = useState(0);
    return <CanvasEdgeGeometryBridge enabled edges={edges} protectedEdgeIds={["edge"]} scope={scope} resetKey="document"
      onMeasured={(value) => { if (value) { report(value); setCount((count) => count + 1); } }} />;
  }
  render(<Parent />, { container: mount }); flush(); flush();
  expect(report).toHaveBeenCalledOnce(); expect(requestAnimationFrame).toHaveBeenCalledOnce();
});
