import type { Node, ReactFlowProps } from "@xyflow/react";
import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { App } from "./App";
import * as workspaceView from "./app/shell/AppWorkspaceView";
import type { AppWorkspaceViewProps } from "./app/shell/AppWorkspaceView";
import type { NarrativeNodeRenderData } from "./app/workspaceShared";
import { applyProjectLocale } from "./localization/i18n";
import { useGraphStore } from "./state/graphStore";
import { createProjectFixtureRuntimeFetch, loadProjectFixturesForTests } from "./testFixtures/projectFixtures";

const boundary = vi.hoisted(() => ({ samples: [] as ReactFlowProps[] }));
// Observe actual view inputs; do not replace React Flow or its renderers.
vi.mock("@xyflow/react", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@xyflow/react")>();
  return { ...actual, ReactFlow: (props: ReactFlowProps) => {
    boundary.samples.push(props);
    return <actual.ReactFlow {...props} />;
  } };
});
let workspace: AppWorkspaceViewProps;
beforeEach(async () => {
  window.localStorage.clear();
  await applyProjectLocale("en");
  useGraphStore.setState(useGraphStore.getInitialState(), true);
  loadProjectFixturesForTests();
  vi.stubGlobal("fetch", createProjectFixtureRuntimeFetch());
  boundary.samples.length = 0;
  const ActualView = workspaceView.AppWorkspaceView;
  vi.spyOn(workspaceView, "AppWorkspaceView").mockImplementation((props) => {
    workspace = props;
    return <ActualView {...props} />;
  });
});
afterEach(() => { vi.restoreAllMocks(); vi.unstubAllGlobals(); });

const latest = () => boundary.samples.at(-1)!.nodes as Node<NarrativeNodeRenderData>[];
const node = (id: string) => latest().find((item) => item.id === id)!;
const flowKeys = ["onAddToFlow", "onContinueFlow", "onCallFlow", "onCreateFlowExit", "onConfigureSceneBoundary", "onSetFlowEntry"] as const;
const frameKeys = ["onAddLinked", "onFitContent", "onFocusFrame", "onToggleCollapse"] as const;
const commonKeys = ["onOpenAnalysis", "onResizeStart", "onResizeEnd"] as const;
const metricKeys = ["presentationMetrics", "dialogueMetrics", "questMetrics", "factionMembers", "outcomeTargets", "frameContentCounts", "sceneBoundarySummary"] as const;

/** Count retained action slots separately from eligibility and nested call actions. */
function actions(before: Node<NarrativeNodeRenderData>[], keys: readonly (keyof NarrativeNodeRenderData)[]) {
  const previous = new Map(before.map((item) => [item.id, item]));
  const slots = latest().flatMap((item) => keys.map((key) => [previous.get(item.id)?.data[key], item.data[key]]));
  return {
    present: slots.filter(([, next]) => typeof next === "function").length,
    replaced: slots.filter(([old, next]) => typeof old === "function" && typeof next === "function" && old !== next).length,
    added: slots.filter(([old, next]) => typeof old !== "function" && typeof next === "function").length,
    removed: slots.filter(([old, next]) => typeof old === "function" && typeof next !== "function").length
  };
}

/** This is a reference inventory, not a React commit, work or latency measurement. */
function inventory(before: Node<NarrativeNodeRenderData>[]) {
  const previous = new Map(before.map((item) => [item.id, item]));
  const metrics = latest().flatMap((item) => metricKeys.flatMap((key) => {
    const old = previous.get(item.id)?.data[key];
    const next = item.data[key];
    return old !== undefined && next !== undefined ? [{ old, next }] : [];
  }));
  const calls = latest().flatMap((item) => (item.data.flowCalls ?? []).flatMap((call) => {
    const old = previous.get(item.id)?.data.flowCalls?.find((candidate) => candidate.id === call.id);
    return old ? [{ old, call }] : [];
  }));
  return { flow: actions(before, flowKeys), frame: actions(before, frameKeys), common: actions(before, commonKeys),
    nestedCalls: { present: calls.length, replaced: calls.filter(({ old, call }) => old.onOpen !== call.onOpen).length },
    metrics: { present: metrics.length, replaced: metrics.filter(({ old, next }) => old !== next).length,
      valueChanged: metrics.filter(({ old, next }) => JSON.stringify(old) !== JSON.stringify(next)).length } };
}

it("retains action groups and metrics through rail and editor opening", () => {
  render(<App />);
  fireEvent.click(screen.getByTestId("rf__node-node-hero"));
  const before = latest();
  fireEvent.click(screen.getByTitle("Projects"));
  expect(latest() === before, "rail refresh").toBe(true);
  fireEvent.doubleClick(screen.getByTestId("rf__node-node-hero"));
  expect(latest() === before, "editor open").toBe(true);
});

it("distinguishes pure Pan refresh from Pan clearing an existing selection", () => {
  render(<App />);
  const beforePan = latest();
  fireEvent.click(screen.getByRole("button", { name: "Pan canvas" }));
  expect(latest() === beforePan, "Pan refresh").toBe(true);
  fireEvent.click(screen.getByRole("button", { name: "Select" }));
  fireEvent.click(screen.getByTestId("rf__node-node-hero"));
  const selected = latest();
  expect(node("node-hero").selected).toBe(true);
  fireEvent.click(screen.getByRole("button", { name: "Pan canvas" }));
  expect(node("node-hero").selected).toBe(false);
  expect(inventory(selected).flow.replaced).toBe(0);
  expect(inventory(selected).frame.replaced).toBe(0);
  expect(inventory(selected).metrics.valueChanged).toBe(0);
});

it.each(["selection", "authored Text"])("classifies action and equal-valued metric churn after %s", (change) => {
  render(<App />);
  const before = latest();
  if (change === "selection") fireEvent.click(screen.getByTestId("rf__node-node-hero"));
  else act(() => {
    const source = useGraphStore.getState().getActiveGraph().nodes.find((item) => item.id === "node-hero")!;
    useGraphStore.getState().updateNode(source.id, { ...source.data, summary: "New audit Text" });
  });
  expect(inventory(before)).toEqual({
    flow: { present: 37, replaced: 0, added: 0, removed: 0 },
    frame: { present: 12, replaced: 0, added: 0, removed: 0 },
    common: { present: 54, replaced: 0, added: 0, removed: 0 },
    nestedCalls: { present: 2, replaced: 0 },
    metrics: { present: 28, replaced: 0, valueChanged: 0 }
  });
  for (const previous of before.filter((item) => item.data.isFrame)) {
    for (const key of ["onAddLinked", "onFitContent", "onToggleCollapse"] as const) {
      expect(node(previous.id).data[key]).toBe(previous.data[key]);
    }
    expect(node(previous.id).data.onFocusFrame).toBe(previous.data.onFocusFrame);
  }
  for (const previous of before) {
    expect(node(previous.id).data.onAddToFlow).toBe(previous.data.onAddToFlow);
    expect(node(previous.id).data.onContinueFlow).toBe(previous.data.onContinueFlow);
    expect(node(previous.id).data.onCallFlow).toBe(previous.data.onCallFlow);
    expect(node(previous.id).data.onCreateFlowExit).toBe(previous.data.onCreateFlowExit);
    expect(node(previous.id).data.onSetFlowEntry).toBe(previous.data.onSetFlowEntry);
    expect(node(previous.id).data.onConfigureSceneBoundary).toBe(previous.data.onConfigureSceneBoundary);
  }
  expect(screen.getByTestId("rf__node-node-hero")).toHaveTextContent(change === "selection" ? "Mara Vale" : "New audit Text");
});

it("retains nested actions while fallback Flow names and explicit call labels update", async () => {
  const state = useGraphStore.getState();
  const flows = state.storyFlowsByProject[state.activeProjectId]!;
  const main = flows.find((snapshot) => snapshot.flow.id === "flow-main-story")!;
  const invocation = main.invocations!.find((call) => call.source_node_id === "node-inspection")!;
  const unlabelled = { ...main, invocations: main.invocations!.map((call) => call.id === invocation.id ? { ...call, label: "" } : call) };
  const initial = flows.map((snapshot) => snapshot === main ? unlabelled : snapshot);
  useGraphStore.setState({ storyFlowsByProject: { ...state.storyFlowsByProject, [state.activeProjectId]: initial } });
  render(<App />);
  const before = node("node-inspection").data.flowCalls!.find((call) => call.id === invocation.id)!;
  // Offscreen shells intentionally omit action text; select the placement before
  // auditing visible call controls, while retaining the same canonical source.
  fireEvent.click(screen.getByTestId("rf__node-node-inspection"));
  expect(before.label).toBe("Smuggler Route");
  const renamed = initial.map((snapshot) => snapshot.flow.id === invocation.target_flow_id
    ? { ...snapshot, flow: { ...snapshot.flow, name: "Renamed Route" } } : snapshot);
  act(() => useGraphStore.setState({ storyFlowsByProject: { ...state.storyFlowsByProject, [state.activeProjectId]: renamed } }));
  await waitFor(() => expect(node("node-inspection").data.flowCalls!.find((call) => call.id === invocation.id)!.label).toBe("Renamed Route"));
  expect(node("node-inspection").data.flowCalls!.find((call) => call.id === invocation.id)).not.toBe(before);
  expect(before.label).toBe("Smuggler Route");
  expect(screen.getByTestId("rf__node-node-inspection")).toHaveTextContent("Renamed Route");
  expect(node("node-inspection").data.flowCalls!.find((call) => call.id === invocation.id)!.onOpen).toBe(before.onOpen);
  act(() => before.onOpen());
  expect(screen.getByRole("heading", { name: "Returns from Renamed Route" })).toBeInTheDocument();
  fireEvent.click(screen.getByRole("button", { name: "Close dialog" }));
  const labelled = renamed.map((snapshot) => snapshot.flow.id === main.flow.id
    ? { ...snapshot, invocations: snapshot.invocations!.map((call) => call.id === invocation.id ? { ...call, label: "Explicit call" } : call) } : snapshot);
  act(() => useGraphStore.setState({ storyFlowsByProject: { ...state.storyFlowsByProject, [state.activeProjectId]: labelled } }));
  await waitFor(() => expect(node("node-inspection").data.flowCalls!.find((call) => call.id === invocation.id)!.label).toBe("Explicit call"));
  expect(screen.getByTestId("rf__node-node-inspection")).toHaveTextContent("Explicit call");
  expect(node("node-inspection").data.flowCalls!.find((call) => call.id === invocation.id)!.onOpen).toBe(before.onOpen);
});

it("keeps placement-specific counts and canonical instance metrics live after adding a linked node", () => {
  render(<App />);
  const frame = node("node-customs-office");
  const hero = node("node-hero");
  act(() => { expect(useGraphStore.getState().addLinkedInstance("node-hero", frame.id).valid).toBe(true); });
  const linked = latest().find((item) => item.data.isLinkedInstance && item.data.canonicalNodeId === "node-hero" && item.parentId === frame.id)!;
  expect(linked).toBeDefined();
  expect(node(frame.id).data.frameContentCounts!.total).toBe(frame.data.frameContentCounts!.total + 1);
  expect(node(hero.id).data.presentationMetrics!.instances).toBe(hero.data.presentationMetrics!.instances + 1);
  expect(linked.data.presentationMetrics).toBe(node(hero.id).data.presentationMetrics);
  expect(linked.data.onResizeStart).toBe(node(hero.id).data.onResizeStart);
  expect(linked.data.onAddToFlow).toBe(node(hero.id).data.onAddToFlow);
  expect(linked.data.onAddToFlow).toBeTypeOf("function");
});

it("uses retained focus with a renamed and newly collapsed Scene, expanding before entering it", () => {
  render(<App />);
  const scene = node("node-opening");
  const focus = scene.data.onFocusFrame!;
  act(() => {
    const canonical = useGraphStore.getState().getActiveGraph().nodes.find((item) => item.id === scene.id)!;
    useGraphStore.getState().updateNode(scene.id, { ...canonical.data, title: "Updated Dock" });
    useGraphStore.getState().toggleFrameCollapse(scene.id);
  });
  expect(node(scene.id).data.presentationState).toBe("collapsed");
  expect(node(scene.id).data.onFocusFrame).toBe(focus);
  expect(screen.queryByTestId("rf__node-node-dock-dialogue")).not.toBeInTheDocument();
  act(() => focus());
  expect(node(scene.id).data.presentationState).toBe("expanded");
  expect(screen.getByLabelText("Focused frame workspace")).toHaveTextContent("Updated Dock");
  expect(screen.getByTestId("rf__node-node-dock-dialogue")).toBeInTheDocument();
  expect(screen.queryByTestId("rf__node-node-hero")).not.toBeInTheDocument();
  expect(useGraphStore.getState().selection).toEqual({ type: "node", id: scene.id });
});

it("changes action eligibility with Flow projection and new membership, not selection alone", async () => {
  render(<App />);
  const graphNodes = latest();
  expect(node("node-hero").data.onAddToFlow).toBeTypeOf("function");
  fireEvent.click(screen.getByRole("button", { name: "Flow" }));
  expect(latest().length).toBeLessThan(graphNodes.length);
  expect(latest().every((item) => !item.data.onAddToFlow)).toBe(true);
  expect(latest().some((item) => item.data.flowMembership)).toBe(true);
  const portals = latest().filter((item) => item.data.callContext);
  expect(portals.length).toBeGreaterThan(0);
  expect(portals.every((item) => !item.data.flowMembership && !item.data.onContinueFlow)).toBe(true);
  for (const item of latest()) {
    expect(typeof item.data.onContinueFlow === "function").toBe(item.data.flowMembership);
    expect(typeof item.data.onConfigureSceneBoundary === "function").toBe(item.data.kind === "Scene" && item.data.flowMembership);
  }
  fireEvent.click(screen.getByRole("button", { name: "Graph" }));
  fireEvent.click(screen.getByRole("button", { name: "Add Mara Vale to Main Story" }));
  await waitFor(() => expect(node("node-hero").data.flowMembership).toBe(true));
  expect(node("node-hero").data.onAddToFlow).toBeUndefined();
  for (const key of ["onContinueFlow", "onCallFlow", "onCreateFlowExit", "onSetFlowEntry"] as const) expect(node("node-hero").data[key]).toBeTypeOf("function");
  act(() => { expect(useGraphStore.getState().addLinkedInstance("node-hero", "node-customs-office").valid).toBe(true); });
  const linked = latest().find((item) => item.data.isLinkedInstance && item.data.canonicalNodeId === "node-hero" && item.parentId === "node-customs-office")!;
  expect(linked).toBeDefined();
  expect(linked.data.onCallFlow).toBe(node("node-hero").data.onCallFlow);
  expect(linked.data.onCreateFlowExit).toBe(node("node-hero").data.onCreateFlowExit);
});

it("updates diagnostics and temporal styles without treating them as immutable node metadata", async () => {
  useGraphStore.setState({ runtimeStatus: "ready" });
  render(<App />);
  await waitFor(() => expect(workspace.temporalStateProjection.effects).not.toHaveLength(0));
  const before = node("node-hero");
  act(() => workspace.setSelectedTemporalOwner({ owner_version: 1, owner_kind: "dialogue_element", owner_id: "line-ilya-concedes", context_node_id: "node-dock-dialogue" }));
  expect(node("node-hero").style?.boxShadow).toBe("0 0 0 4px rgb(13 148 136 / 32%)");
  expect(node("node-hero").data.onResizeStart).toBe(before.data.onResizeStart);
  act(() => {
    const state = useGraphStore.getState();
    const graph = state.getActiveGraph();
    useGraphStore.setState({ graphs: { ...state.graphs, [state.activeProjectId]: { ...graph,
      issues: graph.issues.map((issue, index) => index === 0 ? { ...issue, nodeId: "node-hero", title: "Audit finding", description: "Audit details" } : issue)
    } } });
  });
  expect(node("node-hero").data.issuePreview).toContain("Audit finding: Audit details");
  expect(screen.getByTestId("rf__node-node-hero").querySelector(".issue-badge")).toHaveAttribute("data-preview", expect.stringContaining("Audit finding: Audit details"));
  act(() => workspace.setSelectedTemporalOwner(null));
  expect(node("node-hero").style?.boxShadow).toBe(before.style?.boxShadow);
});
