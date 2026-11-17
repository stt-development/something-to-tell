import { act, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { App } from "./App";
import * as workspaceView from "./app/shell/AppWorkspaceView";
import * as workspaceState from "./app/shell/useWorkspaceState";
import { applyProjectLocale, tr } from "./localization/i18n";
import { useGraphStore } from "./state/graphStore";
import { createProjectFixtureRuntimeFetch, loadProjectFixturesForTests } from "./testFixtures/projectFixtures";

beforeEach(async () => {
  window.localStorage.clear();
  await applyProjectLocale("en");
  useGraphStore.setState(useGraphStore.getInitialState(), true);
  loadProjectFixturesForTests();
  vi.stubGlobal("fetch", createProjectFixtureRuntimeFetch());
});
afterEach(() => { vi.restoreAllMocks(); vi.unstubAllGlobals(); });

/** Characterizes real changes and guards equal-selection regressions, not latency.
 * The graph-store record also carries React Flow selection flags; identity is
 * not evidence of an authored edit, a remount or recomputation of every memo.
 */
function observeWorkspace() {
  const root = vi.spyOn(workspaceState, "useWorkspaceState");
  const view = vi.spyOn(workspaceView, "AppWorkspaceView");
  render(<App />);
  const props = () => view.mock.calls.at(-1)![0];
  function measure(action: () => void) {
    const before = props();
    const graph = useGraphStore.getState().getActiveGraph();
    const rootCount = root.mock.calls.length;
    const viewCount = view.mock.calls.length;
    act(action);
    const after = props();
    return {
      workspaceRenders: root.mock.calls.length - rootCount,
      viewRenders: view.mock.calls.length - viewCount,
      graphStoreRecordReused: graph === useGraphStore.getState().getActiveGraph(),
      filteredGraphReused: before.filteredGraph === after.filteredGraph,
      renderedNodesReused: before.visibleNodes === after.visibleNodes,
      renderedEdgesReused: before.graphWithNavigationOverlays === after.graphWithNavigationOverlays
    };
  }
  return { props, measure };
}

it("separates editor visibility invalidation from local unsaved text edits", () => {
  const { props, measure } = observeWorkspace();
  const hero = screen.getByTestId("rf__node-node-hero");
  fireEvent.click(hero);
  const selectedNode = props().selectedNode;
  // Preselect to isolate dialog opening from a genuine selection change.
  expect(measure(() => fireEvent.doubleClick(hero))).toEqual({
    graphStoreRecordReused: true,
    filteredGraphReused: true,
    renderedEdgesReused: true,
    renderedNodesReused: true,
    viewRenders: 1,
    workspaceRenders: 0
  });
  expect(screen.getByLabelText("Text")).toBeInTheDocument();
  expect(measure(() => fireEvent.change(screen.getByLabelText("Text"), {
    target: { value: "Uncommitted characterization draft" }
  }))).toEqual({
    graphStoreRecordReused: true,
    filteredGraphReused: true,
    renderedEdgesReused: true,
    renderedNodesReused: true,
    viewRenders: 0,
    workspaceRenders: 0
  });
  expect(props().selectedNode).toBe(selectedNode);
  expect(selectedNode?.data.summary).not.toBe("Uncommitted characterization draft");
  expect(measure(() => fireEvent.click(screen.getByRole("button", { name: "Close dialog" })))).toEqual({
    graphStoreRecordReused: true,
    filteredGraphReused: true,
    renderedEdgesReused: true,
    renderedNodesReused: true,
    viewRenders: 1,
    workspaceRenders: 0
  });
  expect(screen.queryByLabelText("Text")).not.toBeInTheDocument();
  expect(screen.getByTestId("rf__node-node-hero")).toBe(hero);
});

it("skips repeated node selection without confusing it with a changed selection", () => {
  const { props, measure } = observeWorkspace();
  const hero = screen.getByTestId("rf__node-node-hero");
  fireEvent.click(hero);
  expect(measure(() => fireEvent.click(hero))).toEqual({
    graphStoreRecordReused: true,
    filteredGraphReused: true,
    renderedEdgesReused: true,
    renderedNodesReused: true,
    viewRenders: 0,
    workspaceRenders: 0
  });
  expect(props().canvasSelection).toEqual({ nodeIds: ["node-hero"], edgeIds: [] });
  expect(useGraphStore.getState().selection).toEqual({ type: "node", id: "node-hero" });
  expect(hero).toHaveClass("selected");
  expect(measure(() => fireEvent.contextMenu(hero, { clientX: 400, clientY: 200 }))).toMatchObject({
    workspaceRenders: 0, viewRenders: 0, renderedNodesReused: true, renderedEdgesReused: true
  });
  expect(screen.getByRole("menu")).toBeInTheDocument();
});

it("skips repeated empty-pane clearing after selection is already empty", () => {
  const { props, measure } = observeWorkspace();
  const pane = document.querySelector(".react-flow__pane")!;
  // Select mode routes a stationary primary pointer gesture through pointer-up,
  // not DOM click. MouseEvent supplies coordinates/button in JSDOM's pointer gap.
  function clickPane() {
    const down = new MouseEvent("pointerdown", { bubbles: true, button: 0, clientX: 400, clientY: 300 });
    Object.defineProperty(down, "isPrimary", { value: true });
    fireEvent(pane, down);
    fireEvent(pane, new MouseEvent("pointerup", { bubbles: true, button: 0, clientX: 400, clientY: 300 }));
  }
  clickPane();
  expect(useGraphStore.getState().selection).toBeNull();
  expect(measure(clickPane)).toEqual({
    graphStoreRecordReused: true,
    filteredGraphReused: true,
    renderedEdgesReused: true,
    renderedNodesReused: true,
    viewRenders: 0,
    workspaceRenders: 0
  });
  expect(props().canvasSelection).toEqual({ nodeIds: [], edgeIds: [] });
  expect(useGraphStore.getState().selection).toBeNull();
  expect(measure(() => fireEvent.keyDown(window, { key: "Escape" }))).toMatchObject({
    workspaceRenders: 0, viewRenders: 0
  });
});

it("retains necessary group-selection projection updates and additive removal", () => {
  const { props, measure } = observeWorkspace();
  const hero = screen.getByTestId("rf__node-node-hero");
  const faction = screen.getByTestId("rf__node-node-trade-guild");
  fireEvent.click(hero);
  fireEvent.keyDown(window, { key: "Shift", code: "ShiftLeft" });
  expect(measure(() => fireEvent.click(faction, { shiftKey: true }))).toEqual({
    graphStoreRecordReused: false,
    filteredGraphReused: false,
    renderedEdgesReused: false,
    renderedNodesReused: false,
    viewRenders: 1,
    workspaceRenders: 2
  });
  expect(props().canvasSelection.nodeIds).toEqual(["node-hero", "node-trade-guild"]);
  expect(hero).toHaveClass("selected");
  expect(faction).toHaveClass("selected");
  expect(measure(() => fireEvent.click(faction, { shiftKey: true }))).toEqual({
    // Real Shift also updates React Flow's stored selected flag on removal.
    graphStoreRecordReused: false,
    filteredGraphReused: false,
    renderedEdgesReused: false,
    renderedNodesReused: false,
    viewRenders: 1,
    workspaceRenders: 2
  });
  expect(props().canvasSelection.nodeIds).toEqual(["node-hero"]);
  expect(faction).not.toHaveClass("selected");
  fireEvent.keyUp(window, { key: "Shift", code: "ShiftLeft" });
});

it("retains relationship inspection and navigation highlights when edge selection changes", () => {
  const { props, measure } = observeWorkspace();
  expect(measure(() => props().selectCanvasElement("edge", "edge-guild-ledger", false))).toEqual({
    graphStoreRecordReused: true,
    filteredGraphReused: true,
    renderedEdgesReused: false,
    // 002e's ordered node assembly now preserves this unaffected array.
    renderedNodesReused: true,
    viewRenders: 1,
    workspaceRenders: 2
  });
  expect(props().canvasSelection).toEqual({ nodeIds: [], edgeIds: ["edge-guild-ledger"] });
  expect(props().selectedEdge?.id).toBe("edge-guild-ledger");
  expect(props().relationshipInspection).not.toBeNull();
  expect(props().graphWithNavigationOverlays.find((edge) => edge.id === "edge-guild-ledger")?.selected).toBe(true);
  expect(measure(() => props().selectCanvasElement("edge", "edge-guild-ledger", false))).toEqual({
    graphStoreRecordReused: true,
    filteredGraphReused: true,
    renderedEdgesReused: true,
    renderedNodesReused: true,
    viewRenders: 0,
    workspaceRenders: 0
  });
});

it.each([
  ["Dialogue", "node-dock-dialogue", "dialogue.editNamed"],
  ["Quest", "node-smuggler-route", "quest.editNamed"]
] as const)("separates %s fallback editor opening from local unsaved node-text edits", (kind, nodeId, titleKey) => {
  const { props, measure } = observeWorkspace();
  const node = screen.getByTestId(`rf__node-${nodeId}`);
  expect(measure(() => fireEvent.doubleClick(node))).toEqual({
    workspaceRenders: 2, viewRenders: 2,
    graphStoreRecordReused: true, filteredGraphReused: true,
    renderedNodesReused: false, renderedEdgesReused: false
  });
  expect(screen.getByRole("heading", { name: tr(titleKey, { name: props().selectedNode?.data.title }) })).toBeInTheDocument();
  expect(props().selectedNode?.id).toBe(nodeId);
  const selectedNode = props().selectedNode;
  expect(measure(() => fireEvent.change(screen.getByLabelText(kind === "Dialogue" ? tr("style.dialogueNodeText") : tr("common.text")), {
    target: { value: "Uncommitted specialized draft" }
  }))).toEqual({
    workspaceRenders: 0, viewRenders: 0,
    graphStoreRecordReused: true, filteredGraphReused: true,
    renderedNodesReused: true, renderedEdgesReused: true
  });
  expect(props().selectedNode).toBe(selectedNode);
  expect(selectedNode?.data.summary).not.toBe("Uncommitted specialized draft");
});
