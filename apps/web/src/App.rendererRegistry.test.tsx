import type { ReactFlowProps } from "@xyflow/react";
import type { ReactNode } from "react";
import { act, fireEvent, render, screen, within } from "@testing-library/react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { App } from "./App";
import { NarrativeNodeRenderer, STORY_FLOW_EDGE_TYPES } from "./app/graph/GraphCanvasParts";
import type { CanonIssueActionController } from "./canon/CanonIssueActions";
import { applyProjectLocale } from "./localization/i18n";
import { useGraphStore } from "./state/graphStore";
import { createProjectFixtureRuntimeFetch, loadProjectFixturesForTests } from "./testFixtures/projectFixtures";

const boundary = vi.hoisted(() => ({
  props: [] as ReactFlowProps[],
  canon: [] as CanonIssueActionController[]
}));

// Observe App's public props before target-local capture composition. The real
// selectable adapter, React Flow, providers and renderers still run below it.
vi.mock("./app/graph/CanvasSelectableReactFlow", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./app/graph/CanvasSelectableReactFlow")>();
  return { ...actual, CanvasSelectableReactFlow: (props: ReactFlowProps) => {
    boundary.props.push(props);
    return <actual.CanvasSelectableReactFlow {...props} />;
  } };
});

vi.mock("./canon/CanonIssueActions", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./canon/CanonIssueActions")>();
  return { ...actual, CanonIssueActionProvider: (props: { children: ReactNode; value: CanonIssueActionController }) => {
    boundary.canon.push(props.value);
    return <actual.CanonIssueActionProvider {...props} />;
  } };
});

beforeEach(async () => {
  window.localStorage.clear();
  await applyProjectLocale("en");
  useGraphStore.setState(useGraphStore.getInitialState(), true);
  loadProjectFixturesForTests();
  vi.stubGlobal("fetch", createProjectFixtureRuntimeFetch());
  boundary.props.length = 0;
  boundary.canon.length = 0;
});
afterEach(() => { vi.unstubAllGlobals(); });

const latest = () => boundary.props.at(-1)!;
const sample = () => ({ flow: latest(), canon: boundary.canon.at(-1)! });

/** Scalar characterization only: reference churn is not a render/latency budget.
 * Planned optimizations must deliberately update this baseline, not preserve waste.
 */
function changes(before: ReturnType<typeof sample>, after: ReturnType<typeof sample>) {
  const eventKeys = ["onNodeClick", "onEdgeClick", "onPaneClick", "onNodesChange", "onReconnect", "onConnectStart"] as const;
  const previousNodes = new Map(before.flow.nodes?.map((node) => [node.id, node]));
  const pairs = (after.flow.nodes ?? []).flatMap((node) => {
    const previous = previousNodes.get(node.id);
    return previous ? [{ previous, node }] : [];
  });
  const functions = pairs.flatMap(({ previous, node }) => Object.entries(node.data)
    .filter(([key, value]) => typeof value === "function" && typeof previous.data[key] === "function")
    .map(([key, value]) => previous.data[key] === value));
  return {
    sampledCanvasCallbacks: eventKeys.length,
    replacedCanvasCallbacks: eventKeys.filter((key) => before.flow[key] !== after.flow[key]).length,
    nodesArrayReused: before.flow.nodes === after.flow.nodes,
    edgesArrayReused: before.flow.edges === after.flow.edges,
    sharedNodes: pairs.length,
    replacedNodeObjects: pairs.filter(({ previous, node }) => previous !== node).length,
    replacedNodeData: pairs.filter(({ previous, node }) => previous.data !== node.data).length,
    sharedNodeFunctions: functions.length,
    replacedNodeFunctions: functions.filter((equal) => !equal).length,
    canon: {
      valueReused: before.canon === after.canon,
      busyReused: before.canon.busy === after.canon.busy,
      errorReused: before.canon.error === after.canon.error,
      issuesReused: before.canon.issues === after.canon.issues,
      noticeReused: before.canon.notice === after.canon.notice,
      navigateReused: before.canon.onNavigate === after.canon.onNavigate,
      repairReused: before.canon.onRepair === after.canon.onRepair,
      reviewReused: before.canon.onReview === after.canon.onReview
    }
  };
}

it("reuses one node/edge registry through four rail and editor refreshes", () => {
  render(<App />);
  const hero = screen.getByTestId("rf__node-node-hero");
  fireEvent.click(hero);
  const graph = useGraphStore.getState().getActiveGraph();
  const samples = [latest()];
  fireEvent.click(screen.getByTitle("Projects"));
  samples.push(latest());
  fireEvent.click(screen.getByTitle("Projects"));
  samples.push(latest());
  fireEvent.doubleClick(hero);
  samples.push(latest());
  fireEvent.click(screen.getByRole("button", { name: "Close dialog" }));
  samples.push(latest());
  expect(new Set(samples.map((props) => props.nodeTypes)).size).toBe(1);
  expect(new Set(samples.map((props) => props.edgeTypes)).size).toBe(1);
  for (const key of ["onNodeClick", "onEdgeClick", "onPaneClick", "onNodeDoubleClick", "onEdgeDoubleClick", "onNodeContextMenu", "onEdgeContextMenu", "onPaneContextMenu", "onNodesChange", "onEdgesChange", "onConnect", "onConnectStart", "onConnectEnd", "onReconnect", "onReconnectStart", "onReconnectEnd", "onNodeMouseEnter", "onNodeMouseLeave", "onPointerDownCapture", "onPointerUpCapture", "onMoveStart", "onNodeDragStart", "onNodeDrag", "onNodeDragStop"] as const) {
    expect(new Set(samples.map((props) => props[key])).size).toBe(1);
  }
  expect(latest().nodeTypes).toEqual({ narrative: NarrativeNodeRenderer });
  expect(latest().edgeTypes).toBe(STORY_FLOW_EDGE_TYPES);
  expect(screen.getByTestId("rf__node-node-hero")).toBe(hero);
  expect(useGraphStore.getState().getActiveGraph()).toBe(graph);
});

it("retains registry identity across Select/Pan, projection switches and workspace remount", () => {
  const view = render(<App />);
  const registry = latest().nodeTypes;
  const adapters = latest();
  for (const name of ["Pan canvas", "Select", "Flow", "Story", "Graph"]) {
    fireEvent.click(screen.getByRole("button", { name }));
    if (name !== "Story") {
      expect(latest().nodeTypes).toBe(registry);
      expect(latest().onNodesChange).toBe(adapters.onNodesChange);
      expect(latest().onEdgesChange).toBe(adapters.onEdgesChange);
      expect(latest().onConnect).toBe(adapters.onConnect);
      expect(latest().onConnectStart).toBe(adapters.onConnectStart);
      expect(latest().onConnectEnd).toBe(adapters.onConnectEnd);
      expect(latest().onReconnect).toBe(adapters.onReconnect);
      expect(latest().onReconnectStart).toBe(adapters.onReconnectStart);
      expect(latest().onReconnectEnd).toBe(adapters.onReconnectEnd);
      expect(latest().onNodeMouseEnter).toBe(adapters.onNodeMouseEnter);
      expect(latest().onNodeMouseLeave).toBe(adapters.onNodeMouseLeave);
      expect(latest().onPointerDownCapture).toBe(adapters.onPointerDownCapture);
      expect(latest().onPointerUpCapture).toBe(adapters.onPointerUpCapture);
      expect(latest().onMoveStart).toBe(adapters.onMoveStart);
      expect(latest().onNodeDragStart).toBe(adapters.onNodeDragStart);
      expect(latest().onNodeDrag).toBe(adapters.onNodeDrag);
      expect(latest().onNodeDragStop).toBe(adapters.onNodeDragStop);
      expect(latest().onDragOver).toBe(adapters.onDragOver);
      expect(latest().onDrop).toBe(adapters.onDrop);
    }
  }
  view.unmount();
  render(<App />);
  expect(latest().nodeTypes).toBe(registry);
  expect(latest().edgeTypes).toBe(STORY_FLOW_EDGE_TYPES);
});

it("renders changed authored Text with the same renderer and existing node DOM", () => {
  render(<App />);
  const hero = screen.getByTestId("rf__node-node-hero");
  const registry = latest().nodeTypes;
  act(() => useGraphStore.getState().updateNode("node-hero", {
    kind: "Character", title: "Updated actor", summary: "Changed authored Text", tags: []
  }));
  expect(within(hero).getByText("Character: Updated actor")).toBeInTheDocument();
  expect(hero).toHaveTextContent("Changed authored Text");
  expect(latest().nodeTypes).toBe(registry);
  expect(screen.getByTestId("rf__node-node-hero")).toBe(hero);
});

it("separates view-only canvas callbacks and Canon context from retained node data", () => {
  render(<App />);
  const hero = screen.getByTestId("rf__node-node-hero");
  fireEvent.click(hero);
  const beforeRail = sample();
  fireEvent.click(screen.getByTitle("Projects"));
  expect(changes(beforeRail, sample())).toMatchInlineSnapshot(`
    {
      "canon": {
        "busyReused": true,
        "errorReused": true,
        "issuesReused": true,
        "navigateReused": true,
        "noticeReused": true,
        "repairReused": true,
        "reviewReused": true,
        "valueReused": true,
      },
      "edgesArrayReused": true,
      "nodesArrayReused": true,
      "replacedCanvasCallbacks": 0,
      "replacedNodeData": 0,
      "replacedNodeFunctions": 0,
      "replacedNodeObjects": 0,
      "sampledCanvasCallbacks": 6,
      "sharedNodeFunctions": 103,
      "sharedNodes": 18,
    }
  `);
  const beforeDialog = sample();
  fireEvent.doubleClick(hero);
  expect(changes(beforeDialog, sample())).toMatchInlineSnapshot(`
    {
      "canon": {
        "busyReused": true,
        "errorReused": true,
        "issuesReused": true,
        "navigateReused": true,
        "noticeReused": true,
        "repairReused": true,
        "reviewReused": true,
        "valueReused": true,
      },
      "edgesArrayReused": true,
      "nodesArrayReused": true,
      "replacedCanvasCallbacks": 0,
      "replacedNodeData": 0,
      "replacedNodeFunctions": 0,
      "replacedNodeObjects": 0,
      "sampledCanvasCallbacks": 6,
      "sharedNodeFunctions": 103,
      "sharedNodes": 18,
    }
  `);
  expect(screen.getByLabelText("Text")).toBeInTheDocument();
});

it("characterizes genuine selection changes while retaining their visual effects", () => {
  render(<App />);
  const before = sample();
  const hero = screen.getByTestId("rf__node-node-hero");
  fireEvent.click(hero);
  expect(changes(before, sample())).toMatchInlineSnapshot(`
    {
      "canon": {
        "busyReused": true,
        "errorReused": true,
        "issuesReused": false,
        "navigateReused": false,
        "noticeReused": true,
        "repairReused": false,
        "reviewReused": false,
        "valueReused": false,
      },
      "edgesArrayReused": false,
      "nodesArrayReused": false,
      "replacedCanvasCallbacks": 0,
      "replacedNodeData": 0,
      "replacedNodeFunctions": 0,
      "replacedNodeObjects": 1,
      "sampledCanvasCallbacks": 6,
      "sharedNodeFunctions": 103,
      "sharedNodes": 18,
    }
  `);
  expect(hero).toHaveClass("selected");
  expect(useGraphStore.getState().selection).toEqual({ type: "node", id: "node-hero" });
});

it("distinguishes one authored Text change from wider rendered data replacement", () => {
  render(<App />);
  const before = sample();
  const source = useGraphStore.getState().getActiveGraph().nodes.find((node) => node.id === "node-hero")!.data;
  const faction = screen.getByTestId("rf__node-node-trade-guild");
  const factionTitle = faction.querySelector(".narrative-node-title")!.textContent;
  act(() => useGraphStore.getState().updateNode("node-hero", {
    ...source, summary: "Changed authored Text"
  }));
  expect(changes(before, sample())).toMatchInlineSnapshot(`
    {
      "canon": {
        "busyReused": true,
        "errorReused": true,
        "issuesReused": false,
        "navigateReused": false,
        "noticeReused": true,
        "repairReused": false,
        "reviewReused": false,
        "valueReused": false,
      },
      "edgesArrayReused": false,
      "nodesArrayReused": false,
      "replacedCanvasCallbacks": 0,
      "replacedNodeData": 1,
      "replacedNodeFunctions": 0,
      "replacedNodeObjects": 1,
      "sampledCanvasCallbacks": 6,
      "sharedNodeFunctions": 103,
      "sharedNodes": 18,
    }
  `);
  expect(faction.querySelector(".narrative-node-title")).toHaveTextContent(factionTitle!);
  expect(screen.getByTestId("rf__node-node-hero")).toHaveTextContent("Changed authored Text");
});

it("keeps hover local and current tool-mode callbacks responsive", () => {
  render(<App />);
  const hero = screen.getByTestId("rf__node-node-hero");
  const beforeHover = sample();
  const canvasInvocations = boundary.props.length;
  const contextInvocations = boundary.canon.length;
  fireEvent.mouseEnter(hero);
  fireEvent.mouseLeave(hero);
  expect(sample().flow).toBe(beforeHover.flow);
  expect(sample().canon).toBe(beforeHover.canon);
  expect(boundary.props).toHaveLength(canvasInvocations);
  expect(boundary.canon).toHaveLength(contextInvocations);
  const beforePan = sample();
  fireEvent.click(screen.getByRole("button", { name: "Pan canvas" }));
  expect(changes(beforePan, sample())).toMatchInlineSnapshot(`
    {
      "canon": {
        "busyReused": true,
        "errorReused": true,
        "issuesReused": false,
        "navigateReused": false,
        "noticeReused": true,
        "repairReused": false,
        "reviewReused": false,
        "valueReused": false,
      },
      "edgesArrayReused": false,
      "nodesArrayReused": true,
      "replacedCanvasCallbacks": 0,
      "replacedNodeData": 0,
      "replacedNodeFunctions": 0,
      "replacedNodeObjects": 0,
      "sampledCanvasCallbacks": 6,
      "sharedNodeFunctions": 103,
      "sharedNodes": 18,
    }
  `);
  fireEvent.click(hero);
  expect(hero).not.toHaveClass("selected");
  fireEvent.click(screen.getByRole("button", { name: "Select" }));
  fireEvent.click(hero);
  expect(hero).toHaveClass("selected");
});
