import { ReactFlow, ReactFlowProvider, type Node, type ReactFlowInstance } from "@xyflow/react";
import { act, cleanup, fireEvent, render, waitFor, within } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import { CanvasNodePresentation, CanvasNodePresentationBridge, NODE_DETAIL_PRESENTATION_ENABLED } from "./CanvasNodePresentation";
import { NARRATIVE_NODE_TYPES } from "./GraphCanvasParts";
import { setGraphCardExperimentEnabled, setNodeDetailExperimentEnabled, NODE_DETAIL_EXPERIMENT_KEY } from "./canvasRenderingExperiment";
import { CanvasRenderingExperimentControl } from "../settings/CanvasRenderingExperimentControl";
import { applyProjectLocale, tr } from "../../localization/i18n";
import type { NarrativeNodeRenderData } from "../workspaceShared";

afterEach(async () => {
  cleanup(); act(() => { setGraphCardExperimentEnabled(false); setNodeDetailExperimentEnabled(false); });
  await applyProjectLocale("en"); vi.restoreAllMocks();
});
const scope = { projectId: "project", workspaceMode: "relationships" as const, flowId: null, focusedFrameId: null };
function fixture(spatialEnabled = false) {
  const focus = vi.fn();
  const nodes: Node<NarrativeNodeRenderData>[] = Array.from({ length: 4 }, (_, index) => ({
    id: `visual-${index}`, type: "narrative", parentId: index ? `visual-${index - 1}` : undefined,
    position: { x: index ? 20 : 0, y: index ? 70 : 0 }, width: 900 - index * 180, height: 650 - index * 140,
    data: { kind: index === 3 ? "Lore" : "Location", isFrame: index < 3, title: `Title ${index}`, label: `Title ${index}`,
      summary: `Text ${index}`, tags: ["tag"], issueCount: index === 1 ? 2 : 0, isLinkedInstance: index === 3, onFocusFrame: index < 3 ? focus : undefined }
  }));
  let api!: ReactFlowInstance<Node<NarrativeNodeRenderData>>;
  const view = (detailEnabled = true, mode: "relationships" | "flow" = "relationships", protectedOwnerIds: string[] = []) => <ReactFlowProvider initialWidth={1440} initialHeight={900}>
    <CanvasNodePresentation enabled={spatialEnabled} detailEnabled={detailEnabled} workspaceMode={mode}>
      <ReactFlow width={1440} height={900} nodes={nodes} nodeTypes={NARRATIVE_NODE_TYPES} onInit={(value) => { api = value; }}>
        <CanvasNodePresentationBridge nodes={nodes} scope={{ ...scope, workspaceMode: mode }} resetKey="document" protectedOwnerIds={protectedOwnerIds} />
      </ReactFlow>
    </CanvasNodePresentation>
  </ReactFlowProvider>;
  const rendered = render(view());
  return { nodes, focus, rendered, view, api: () => api, card: (index: number) => rendered.container.querySelector(`[data-id="visual-${index}"] article`)! };
}

it("keeps original wrappers/ports and reveals folded leaf controls without authoring or selecting", async () => {
  const f = fixture(), before = JSON.stringify(f.nodes);
  await waitFor(() => expect(f.card(3)).toHaveAttribute("data-node-presentation", "folded"));
  expect(f.rendered.container.querySelectorAll(".react-flow__node")).toHaveLength(4);
  expect(f.rendered.container.querySelectorAll(".narrative-handle")).toHaveLength(16);
  expect(f.card(0).querySelector(".frame-content-count")).toHaveAccessibleName(tr("canvasDetail.foldedCount", { count: 1, direct: 0 }));
  expect(f.card(3)).toHaveTextContent("Text 3");
  fireEvent.click(within(f.card(3) as HTMLElement).getByRole("button", { name: tr("canvasDetail.revealNamed", { name: "Title 3" }) }));
  await waitFor(() => expect(f.card(3)).toHaveAttribute("data-node-presentation", "full"));
  expect(f.card(3)).toHaveTextContent("Text 3"); expect(f.focus).not.toHaveBeenCalled();
  expect(JSON.stringify(f.nodes)).toBe(before); expect(f.api().getNodes().every((node) => !node.selected)).toBe(true);
  expect(f.rendered.container.querySelectorAll(".narrative-handle")).toHaveLength(16);
});

it("renders compact/overview summaries with explicit frame focus, counts and stable geometry", async () => {
  const f = fixture(); await waitFor(() => expect(f.api()).toBeDefined());
  await act(async () => { await f.api().setViewport({ x: 0, y: 0, zoom: 0.3 }); });
  await waitFor(() => expect(f.card(1)).toHaveAttribute("data-node-presentation", "compact"));
  expect(f.card(1)).toHaveTextContent("Title 1"); expect(f.card(1)).toHaveTextContent("Text 1");
  expect(within(f.card(1) as HTMLElement).getByLabelText(tr("authoring.issueCount", { count: 2 }))).toHaveTextContent("2");
  const focusButton = within(f.card(1) as HTMLElement).getByRole("button", { name: tr("authoring.focusNamed", { name: "Title 1" }) });
  act(() => focusButton.focus()); await waitFor(() => expect(f.card(1)).toHaveAttribute("data-node-presentation", "full"));
  const fullFocus = within(f.card(1) as HTMLElement).getByRole("button", { name: tr("authoring.focusNamed", { name: "Title 1" }) });
  expect(fullFocus).toHaveFocus(); fireEvent.click(fullFocus); expect(f.focus).toHaveBeenCalledOnce();
  await act(async () => { await f.api().setViewport({ x: 0, y: 0, zoom: 0.1 }); });
  await waitFor(() => expect(f.card(2)).toHaveAttribute("data-node-presentation", "overview"));
  expect(f.card(2)).toHaveAccessibleName("Title 2");
  expect(f.card(2).querySelector(".node-detail-title")).toBeVisible(); expect(f.card(2)).toHaveTextContent("Text 2");
  expect(f.api().getNodes().map(({ id, width, height, position, parentId }) => ({ id, width, height, position, parentId })))
    .toEqual(f.nodes.map(({ id, width, height, position, parentId }) => ({ id, width, height, position, parentId })));
});

it("preserves active protected controls and explicit rollback independent of spatial preferences", async () => {
  const f = fixture(); await waitFor(() => expect(f.card(3)).toHaveAttribute("data-node-presentation", "folded"));
  f.rendered.rerender(f.view(true, "relationships", ["visual-3"]));
  await waitFor(() => expect(f.card(3)).toHaveAttribute("data-node-presentation", "full"));
  f.rendered.rerender(f.view(false)); expect(f.card(3)).toHaveAttribute("data-node-presentation", "full");
  f.rendered.rerender(f.view(true)); await waitFor(() => expect(f.card(3)).toHaveAttribute("data-node-presentation", "folded"));
});

it("transfers reduced linked-marker focus to full controls and releases spatial protection after blur", async () => {
  const f = fixture(true); await waitFor(() => expect(f.card(3)).toHaveAttribute("data-node-presentation", "folded"));
  const reduced = within(f.card(3) as HTMLElement).getByLabelText(tr("authoring.linkedInstance"));
  act(() => reduced.focus()); await waitFor(() => expect(f.card(3)).toHaveAttribute("data-node-presentation", "full"));
  const full = within(f.card(3) as HTMLElement).getByLabelText(tr("authoring.linkedInstance")); expect(full).toHaveFocus();
  await act(async () => { await f.api().setViewport({ x: -100000, y: 0, zoom: 1 }); });
  expect(f.card(3)).toHaveAttribute("data-node-presentation", "full"); expect(full).toHaveFocus();
  const elsewhere = document.createElement("button"); f.rendered.container.append(elsewhere);
  act(() => elsewhere.focus()); await waitFor(() => expect(f.card(3)).toHaveAttribute("data-node-presentation", "shell"));
});

it("inherits approved detail On but localizes and preserves independent explicit Off in both languages", async () => {
  expect(NODE_DETAIL_PRESENTATION_ENABLED).toBe(true);
  act(() => { setNodeDetailExperimentEnabled(false); setGraphCardExperimentEnabled(false); });
  const rendered = render(<CanvasRenderingExperimentControl />);
  for (const locale of ["en", "ru"] as const) {
    await act(async () => { await applyProjectLocale(locale); });
    const detail = rendered.getByRole("checkbox", { name: tr("canvasExperiment.nodeDetail") });
    expect(detail).not.toBeChecked(); fireEvent.click(detail); expect(detail).toBeChecked();
    expect(rendered.getByRole("checkbox", { name: tr("canvasExperiment.graphCards") })).not.toBeChecked();
    expect(localStorage.getItem(NODE_DETAIL_EXPERIMENT_KEY)).toBe("true"); fireEvent.click(detail);
    expect(tr("canvasDetail.revealNamed", { name: "A" })).not.toContain("canvasDetail.");
    expect(tr("canvasDetail.foldedCount", { count: 2, direct: 1 })).not.toContain("{{");
  }
});
