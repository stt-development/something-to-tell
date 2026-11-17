import { ReactFlow, ReactFlowProvider, type ReactFlowInstance } from "@xyflow/react";
import type { Node } from "@xyflow/react";
import { act, fireEvent, render, waitFor } from "@testing-library/react";
import { StrictMode } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { NarrativeNodeRenderData } from "../workspaceShared";
import { CanvasNodePresentation, CanvasNodePresentationBridge, VIEWPORT_CARD_PRESENTATION_ENABLED } from "./CanvasNodePresentation";
import { NARRATIVE_NODE_TYPES } from "./GraphCanvasParts";
import * as frameScheduling from "./viewportEligibilityScheduler";
import { setGraphCardExperimentEnabled } from "./canvasRenderingExperiment";
import { CanvasRenderingExperimentControl } from "../settings/CanvasRenderingExperimentControl";
import { applyProjectLocale, tr } from "../../localization/i18n";

// Most tests exercise explicit opt-in/rollback; actual default inheritance has its own suite.
beforeEach(() => { act(() => setGraphCardExperimentEnabled(false)); });
afterEach(() => { act(() => setGraphCardExperimentEnabled(false)); vi.restoreAllMocks(); });

const node = (id: string, x = 0, extra: Partial<Node<NarrativeNodeRenderData>> = {}): Node<NarrativeNodeRenderData> => ({
  id, type: "narrative", position: { x, y: 0 }, width: 260, height: 156,
  data: { kind: "Character", title: id, label: id, summary: `${id} description`, tags: ["actor"] }, ...extra
});
const scope = { projectId: "project", workspaceMode: "relationships" as const, flowId: null, focusedFrameId: null };
type CameraApi = Pick<ReactFlowInstance<Node<NarrativeNodeRenderData>>, "setViewport" | "getNodes" | "getEdges">;

describe("React Flow card-body presentation adapter", () => {
  it.each([
    ["Scene analysis", { analysisPreview: "Review this suggestion", analysisOperationIndexes: [0] }, ".analysis-badge"],
    ["Canon", { canonTarget: true, canonIssuePreview: "Review Canon target" }, ".canon-node-target-indicator"],
    ["Impact", { impactHighlight: { findingId: "finding", preview: "Review impact", propagation: null, role: "direct" } }, ".impact-node-target-indicator"]
  ] satisfies [string, Partial<NarrativeNodeRenderData>, string][])("retains %s controls outside the viewport and releases review protection", async (_label, diagnostic, selector) => {
    const onOpenAnalysis = vi.fn();
    const baseline = [node("parent", 10000), node("review", 20, { parentId: "parent" })];
    const view = (active: boolean) => {
      const nodes = baseline.map((item) => item.id === "review" && active
        ? { ...item, data: { ...item.data, ...diagnostic, onOpenAnalysis } } : item);
      return <ReactFlowProvider initialWidth={1440} initialHeight={900}><CanvasNodePresentation enabled detailEnabled>
        <ReactFlow width={1440} height={900} nodes={nodes} nodeTypes={NARRATIVE_NODE_TYPES}>
          <CanvasNodePresentationBridge nodes={nodes} scope={scope} resetKey="document" protectedOwnerIds={[]} />
        </ReactFlow>
      </CanvasNodePresentation></ReactFlowProvider>;
    };
    const rendered = render(view(false));
    const card = (id: string) => rendered.container.querySelector(`[data-id="${id}"] article`)!;
    await waitFor(() => expect(card("review")).toHaveAttribute("data-node-presentation", "shell"));
    rendered.rerender(view(true));
    expect(card("review")).toHaveAttribute("data-node-presentation", "full");
    expect(card("parent")).toHaveAttribute("data-node-presentation", "full");
    expect(card("review").querySelector(selector)).not.toBeNull();
    if (selector === ".analysis-badge") {
      fireEvent.click(card("review").querySelector(selector)!);
      expect(onOpenAnalysis).toHaveBeenCalledWith(0);
    }
    expect(rendered.container.querySelectorAll(".react-flow__handle")).toHaveLength(8);
    rendered.rerender(view(false));
    await waitFor(() => expect(card("review")).toHaveAttribute("data-node-presentation", "shell"));
    expect(card("parent")).toHaveAttribute("data-node-presentation", "shell");
  });

  it("localizes the experimental control without resetting its live value", async () => {
    render(<CanvasRenderingExperimentControl />);
    fireEvent.click(document.querySelector('input[type="checkbox"]')!);
    try {
      await act(async () => { await applyProjectLocale("ru"); });
      expect(document.querySelector('input[type="checkbox"]')).toHaveAccessibleName(tr("canvasExperiment.graphCards"));
      expect(document.querySelector('input[type="checkbox"]')).toBeChecked();
    } finally {
      await act(async () => { await applyProjectLocale("en"); });
    }
  });

  it("switches current Graph cards on/off/on without broadcasting to workspace siblings, and falls back in Flow", async () => {
    const nodes = [node("near"), node("far", 10000)];
    const workspace = vi.fn();
    let api!: CameraApi;
    function Sibling() { workspace(); return null; }
    const view = (mode: "relationships" | "flow", current = nodes) => <ReactFlowProvider initialWidth={1440} initialHeight={900}>
      <CanvasRenderingExperimentControl /><Sibling />
      <CanvasNodePresentation workspaceMode={mode}>
        <ReactFlow width={1440} height={900} nodes={current} nodeTypes={NARRATIVE_NODE_TYPES} onInit={(instance) => { api = instance; }}>
          <CanvasNodePresentationBridge nodes={current} scope={{ ...scope, workspaceMode: mode }} resetKey="document" protectedOwnerIds={[]} />
        </ReactFlow>
      </CanvasNodePresentation>
    </ReactFlowProvider>;
    const rendered = render(view("relationships"));
    const checkbox = rendered.getByRole("checkbox", { name: tr("canvasExperiment.graphCards") });
    const card = (id: string) => rendered.container.querySelector(`[data-id="${id}"] article`)!;
    expect(card("far")).toHaveAttribute("data-node-presentation", "full");
    fireEvent.click(checkbox);
    await waitFor(() => expect(card("far")).toHaveAttribute("data-node-presentation", "shell"));
    fireEvent.click(checkbox);
    expect(card("far")).toHaveAttribute("data-node-presentation", "full");
    expect(workspace).toHaveBeenCalledOnce();
    const moved = [node("near", 10000), node("far", 0)];
    rendered.rerender(view("relationships", moved));
    fireEvent.click(checkbox);
    await waitFor(() => expect(card("near")).toHaveAttribute("data-node-presentation", "shell"));
    expect(card("far")).toHaveAttribute("data-node-presentation", "full");
    expect(api.getNodes().map(({ id, position }) => ({ id, position }))).toEqual(moved.map(({ id, position }) => ({ id, position })));
    expect(rendered.container.querySelectorAll(".react-flow__handle")).toHaveLength(8);
    rendered.rerender(view("flow", moved));
    expect(card("near")).toHaveAttribute("data-node-presentation", "full");
    expect(checkbox).toBeChecked();
    rendered.rerender(view("relationships", moved));
    await waitFor(() => expect(card("near")).toHaveAttribute("data-node-presentation", "shell"));
  });

  it("respects an explicit disabled boundary even with the device experiment enabled", () => {
    setGraphCardExperimentEnabled(true);
    const nodes = [node("far", 10000)];
    const { container } = render(<ReactFlowProvider><CanvasNodePresentation enabled={false}>
      <ReactFlow nodes={nodes} nodeTypes={NARRATIVE_NODE_TYPES}>
        <CanvasNodePresentationBridge nodes={nodes} scope={scope} resetKey="document" protectedOwnerIds={[]} />
      </ReactFlow>
    </CanvasNodePresentation></ReactFlowProvider>);
    expect(container.querySelector("article")).toHaveAttribute("data-node-presentation", "full");
  });

  it("keeps nested role names accessible when their chrome uses compact icons", () => {
    const nodes = [node("frame", 0, { width: 600, height: 400, data: { ...node("frame").data, kind: "Scene", isFrame: true } }),
      node("child", 24, { parentId: "frame", data: { ...node("child").data,
        flowRole: { entry: false, branch: false, ending: true, unreachable: true } } })];
    const { container } = render(<ReactFlowProvider><ReactFlow nodes={nodes} nodeTypes={NARRATIVE_NODE_TYPES} /></ReactFlowProvider>);
    const child = container.querySelector('[data-id="child"] article')!;
    expect(child).toHaveAttribute("data-node-nested", "true");
    for (const name of ["Ending", "Unreachable"]) {
      expect(child.querySelector(`[aria-label="${name}"]`)).toHaveAttribute("data-tooltip", name);
      expect(child.querySelector(`[aria-label="${name}"]`)).toHaveAttribute("tabindex", "0");
    }
    expect(container.querySelector('[data-id="frame"] article')).not.toHaveAttribute("data-node-nested");
  });

  it.each([[1440, 900], [1024, 768]])("retains real wrappers, four Handles and all edges at %sx%s while camera changes detail", async (width, height) => {
    const nodes = [node("near"), node("far", 10000)];
    let api!: CameraApi;
    const { container } = render(<ReactFlowProvider initialWidth={width} initialHeight={height}>
      <CanvasNodePresentation enabled>
        <ReactFlow width={width} height={height} nodes={nodes} edges={[{ id: "edge", source: "near", target: "far", sourceHandle: "right", targetHandle: "left" }]}
          nodeTypes={NARRATIVE_NODE_TYPES} onInit={(instance) => { api = instance; }}>
          <CanvasNodePresentationBridge nodes={nodes} scope={scope} resetKey="document" protectedOwnerIds={[]} />
        </ReactFlow>
      </CanvasNodePresentation>
    </ReactFlowProvider>);
    const card = (id: string) => container.querySelector(`[data-id="${id}"] article`)!;
    await waitFor(() => expect(card("far")).toHaveAttribute("data-node-presentation", "shell"));
    expect(card("near")).toHaveAttribute("data-node-presentation", "full");
    expect(container.querySelectorAll(".react-flow__node")).toHaveLength(2);
    expect(container.querySelectorAll(".react-flow__handle")).toHaveLength(8);
    expect(api.getNodes()).toHaveLength(2); expect(api.getEdges()).toHaveLength(1);
    expect(card("far")).toHaveAttribute("aria-label", "far");
    expect(card("far").querySelector(".narrative-node-content")).toBeNull();
    await act(async () => { await api.setViewport({ x: -10000, y: 0, zoom: 1 }); });
    await waitFor(() => expect(card("far")).toHaveAttribute("data-node-presentation", "full"));
    await waitFor(() => expect(card("near")).toHaveAttribute("data-node-presentation", "shell"));
    expect(container.querySelectorAll(".react-flow__handle")).toHaveLength(8);
    expect(api.getNodes().map((item) => ({ id: item.id, position: item.position, width: item.width, height: item.height })))
      .toEqual(nodes.map((item) => ({ id: item.id, position: item.position, width: item.width, height: item.height })));
    expect(api.getNodes().map((item) => item.data)).toEqual(nodes.map((item) => item.data));
    expect(api.getEdges()[0]).toMatchObject({ id: "edge", source: "near", target: "far", sourceHandle: "right", targetHandle: "left" });
  });

  it("keeps focused controls mounted on pan and releases them after blur", async () => {
    const action = vi.fn();
    const nodes = [node("near", 0, { data: { ...node("near").data, onContinueFlow: action } }), node("far", 10000)];
    let api!: CameraApi;
    const { container } = render(<ReactFlowProvider initialWidth={1440} initialHeight={900}><CanvasNodePresentation enabled>
      <ReactFlow width={1440} height={900} nodes={nodes} nodeTypes={NARRATIVE_NODE_TYPES} onInit={(instance) => { api = instance; }}>
        <CanvasNodePresentationBridge nodes={nodes} scope={scope} resetKey="document" protectedOwnerIds={[]} />
      </ReactFlow>
    </CanvasNodePresentation></ReactFlowProvider>);
    await waitFor(() => expect(api).toBeDefined());
    const card = container.querySelector('[data-id="near"] article')!;
    const control = card.querySelector("button")!;
    fireEvent.focus(control);
    await act(async () => { await api.setViewport({ x: -10000, y: 0, zoom: 1 }); });
    await waitFor(() => expect(container.querySelector('[data-id="far"] article')).toHaveAttribute("data-node-presentation", "full"));
    expect(card).toHaveAttribute("data-node-presentation", "full");
    fireEvent.click(control); expect(action).toHaveBeenCalledTimes(1);
    fireEvent.blur(control, { relatedTarget: document.body });
    await waitFor(() => expect(card).toHaveAttribute("data-node-presentation", "shell"));
  });

  it("keeps explicit device Off fully rendered despite the approved production default", async () => {
    expect(VIEWPORT_CARD_PRESENTATION_ENABLED).toBe(true);
    const nodes = [node("far", 10000)];
    const { container } = render(<StrictMode><ReactFlowProvider initialWidth={1440} initialHeight={900}><CanvasNodePresentation>
      <ReactFlow width={1440} height={900} nodes={nodes} nodeTypes={NARRATIVE_NODE_TYPES}>
        <CanvasNodePresentationBridge nodes={nodes} scope={scope} resetKey="document" protectedOwnerIds={[]} />
      </ReactFlow>
    </CanvasNodePresentation></ReactFlowProvider></StrictMode>);
    await waitFor(() => expect(container.querySelector("article")).toHaveAttribute("data-node-presentation", "full"));
    expect(container.querySelector(".narrative-node-content")).not.toBeNull();
  });

  it("protects selection/editor/navigation owners and their nested ancestors across scope changes", async () => {
    const nodes = [node("frame", 10000, { width: 600, height: 400,
      data: { ...node("frame").data, kind: "Location", isFrame: true } }), node("linked", 20, { parentId: "frame",
      data: { ...node("linked").data, canonicalNodeId: "canonical" } })];
    const view = (projectId: string, ids: string[]) => <ReactFlowProvider initialWidth={1440} initialHeight={900}><CanvasNodePresentation enabled>
      <ReactFlow width={1440} height={900} nodes={nodes} nodeTypes={NARRATIVE_NODE_TYPES}>
        <CanvasNodePresentationBridge nodes={nodes} scope={{ ...scope, projectId }} resetKey="document" protectedOwnerIds={ids} />
      </ReactFlow>
    </CanvasNodePresentation></ReactFlowProvider>;
    const { container, rerender } = render(view("A", []));
    const card = (id: string) => container.querySelector(`[data-id="${id}"] article`)!;
    await waitFor(() => expect(card("linked")).toHaveAttribute("data-node-presentation", "shell"));
    rerender(view("A", ["canonical"]));
    expect(card("linked")).toHaveAttribute("data-node-presentation", "full");
    expect(card("frame")).toHaveAttribute("data-node-presentation", "full");
    rerender(view("B", []));
    await waitFor(() => expect(card("linked")).toHaveAttribute("data-node-presentation", "shell"));
    expect(card("frame")).toHaveAttribute("data-node-presentation", "shell");
    expect(container.querySelectorAll(".react-flow__handle")).toHaveLength(8);
  });

  it("retains full data through zoom extremes and handles an explicitly selected offscreen node", async () => {
    const nodes = [node("near"), node("far", 10000), node("selected", 20000, { selected: true })];
    let api!: CameraApi;
    const { container } = render(<ReactFlowProvider initialWidth={1440} initialHeight={900} initialMinZoom={0.01} initialMaxZoom={10}>
      <CanvasNodePresentation enabled><ReactFlow width={1440} height={900} minZoom={0.01} maxZoom={10}
        nodes={nodes} nodeTypes={NARRATIVE_NODE_TYPES} onInit={(instance) => { api = instance; }}>
        <CanvasNodePresentationBridge nodes={nodes} scope={scope} resetKey="document" protectedOwnerIds={[]} />
      </ReactFlow></CanvasNodePresentation>
    </ReactFlowProvider>);
    const card = (id: string) => container.querySelector(`[data-id="${id}"] article`)!;
    await waitFor(() => expect(card("far")).toHaveAttribute("data-node-presentation", "shell"));
    expect(card("selected")).toHaveAttribute("data-node-presentation", "full");
    await act(async () => { await api.setViewport({ x: 0, y: 0, zoom: 0.01 }); });
    // Spatial inclusion now composes with the independently approved detail default.
    await waitFor(() => expect(card("far")).toHaveAttribute("data-node-presentation", "overview"));
    await act(async () => { await api.setViewport({ x: 0, y: 0, zoom: 10 }); });
    await waitFor(() => expect(card("far")).toHaveAttribute("data-node-presentation", "shell"));
    expect(card("selected")).toHaveAttribute("data-node-presentation", "full");
    expect(api.getNodes()).toHaveLength(3);
    expect(api.getNodes().map((node) => node.data.summary)).toEqual(nodes.map((node) => node.data.summary));
    expect(container.querySelectorAll(".react-flow__handle")).toHaveLength(12);
  });

  it("recreates the scheduler after StrictMode effect replay and disposes each lifetime", async () => {
    const original = frameScheduling.createViewportEligibilityScheduler;
    const dispose = vi.fn();
    const factory = vi.spyOn(frameScheduling, "createViewportEligibilityScheduler").mockImplementation((...args) => {
      const controller = original(...args);
      return { ...controller, dispose: () => { dispose(); controller.dispose(); } };
    });
    const nodes = [node("far", 10000)];
    const { container, unmount } = render(<StrictMode><ReactFlowProvider initialWidth={1440} initialHeight={900}>
      <CanvasNodePresentation enabled><ReactFlow width={1440} height={900} nodes={nodes} nodeTypes={NARRATIVE_NODE_TYPES}>
        <CanvasNodePresentationBridge nodes={nodes} scope={scope} resetKey="document" protectedOwnerIds={[]} />
      </ReactFlow></CanvasNodePresentation>
    </ReactFlowProvider></StrictMode>);
    await waitFor(() => expect(container.querySelector("article")).toHaveAttribute("data-node-presentation", "shell"));
    expect(factory).toHaveBeenCalledTimes(2); expect(dispose).toHaveBeenCalledTimes(1);
    unmount(); expect(dispose).toHaveBeenCalledTimes(2);
  });
});
