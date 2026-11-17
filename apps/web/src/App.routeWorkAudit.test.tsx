import type { Node, ReactFlowProps } from "@xyflow/react";
import { act, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { App } from "./App";
import * as view from "./app/shell/AppWorkspaceView";
import type { AppWorkspaceViewProps } from "./app/shell/AppWorkspaceView";
import { applyProjectLocale } from "./localization/i18n";
import { useGraphStore } from "./state/graphStore";
import * as flow from "./story-flow/workspace";
import { createProjectFixtureRuntimeFetch, loadProjectFixturesForTests } from "./testFixtures/projectFixtures";
import type { NarrativeNodeData } from "./types";

const boundary = vi.hoisted(() => ({ latest: null as ReactFlowProps | null }));
// Real App/React Flow and production projections; no route/path result is substituted.
vi.mock("@xyflow/react", async (original) => {
  const actual = await original<typeof import("@xyflow/react")>();
  return { ...actual, ReactFlow: (props: ReactFlowProps) => {
    boundary.latest = props;
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
  const ActualView = view.AppWorkspaceView;
  vi.spyOn(view, "AppWorkspaceView").mockImplementation((props) => { workspace = props; return <ActualView {...props} />; });
});
afterEach(() => { vi.restoreAllMocks(); vi.unstubAllGlobals(); });
const latestNodes = () => boundary.latest!.nodes as Node<NarrativeNodeData>[];

for (const mode of ["relationships", "flow"] as const) {
  it.each(["selection", "Text", "move", "resize"])(`observes ${mode} route projection inputs after %s without equating them to SVG work`, (action) => {
    const project = vi.spyOn(flow, "projectGraphForWorkspace");
    render(<App />);
    if (mode === "flow") fireEvent.click(screen.getByRole("button", { name: "Flow" }));
    const before = project.mock.results.at(-1)!.value as ReturnType<typeof flow.projectGraphForWorkspace>;
    const positions = latestNodes().map((item) => [item.id, item.position]);
    const distant = latestNodes().find((item) => item.id === "node-route-consequence")!;
    project.mockClear();
    const source = useGraphStore.getState().getActiveGraph().nodes.find((item) => item.id === "node-dock-dialogue")!;
    if (action === "selection") fireEvent.click(screen.getByTestId(`rf__node-${source.id}`));
    if (action === "Text") act(() => useGraphStore.getState().updateNode(source.id, { ...source.data, summary: "Current route audit Text" }));
    if (action === "move") act(() => useGraphStore.getState().onNodesChange([{ id: source.id, type: "position",
      position: { x: source.position.x + 20, y: source.position.y + 10 } }]));
    if (action === "resize") act(() => useGraphStore.getState().onNodesChange([{ id: source.id, type: "dimensions",
      dimensions: { width: 360, height: 240 }, setAttributes: true, resizing: true }]));
    expect(project).toHaveBeenCalledOnce();
    expect(project.mock.calls[0]![0]).toHaveLength(18);
    expect(project.mock.calls[0]![1]).toHaveLength(10);
    const after = project.mock.results[0]!.value as typeof before;
    expect(after.edges).toEqual(before.edges);
    const routes = after.edges.filter((edge) => edge.type === "storyFlow");
    const previous = new Map(before.edges.map((edge) => [edge.id, edge]));
    expect(routes.length).toBeGreaterThan(0);
    expect(routes.every((edge) => edge !== previous.get(edge.id) && edge.data !== previous.get(edge.id)?.data)).toBe(true);
    if (action === "selection") expect(screen.getByTestId(`rf__node-${source.id}`)).toHaveClass("selected");
    if (action === "Text") expect(screen.getByTestId(`rf__node-${source.id}`)).toHaveTextContent("Current route audit Text");
    if (mode === "flow") expect(latestNodes().map((item) => [item.id, item.position])).toEqual(positions);
    if (mode === "relationships" && action === "move") expect(latestNodes().find((item) => item.id === source.id)!.position)
      .toEqual({ x: source.position.x + 20, y: source.position.y + 10 });
    expect(latestNodes().find((item) => item.id === distant.id)!.position).toEqual(distant.position);
  });
}

it.each(["reconnect", "filter", "Flow", "rail"])("distinguishes route projection invalidation after %s", (action) => {
  const project = vi.spyOn(flow, "projectGraphForWorkspace");
  render(<App />);
  const before = boundary.latest!.edges!;
  project.mockClear();
  if (action === "reconnect") act(() => useGraphStore.getState().reconnectEdge("edge-harbor-dialogue", {
    source: "node-dockmaster", target: "node-dock-dialogue", sourceHandle: "bottom", targetHandle: "left"
  }));
  if (action === "filter") act(() => workspace.setGraphFilter({ ...workspace.graphFilter, kinds: ["Character"] }));
  if (action === "Flow") fireEvent.click(screen.getByRole("button", { name: "Flow" }));
  if (action === "rail") fireEvent.click(screen.getByTitle("Projects"));
  expect(project).toHaveBeenCalledTimes(action === "reconnect" || action === "Flow" ? 1 : 0);
  if (action === "reconnect") expect(boundary.latest!.edges!.find((edge) => edge.id === "edge-harbor-dialogue"))
    .toMatchObject({ source: "node-dockmaster", sourceHandle: "bottom", targetHandle: "left" });
  if (action === "filter") expect(boundary.latest!.edges!.length).toBeLessThan(before.length);
  if (action === "Flow") expect(latestNodes()).toHaveLength(7);
  if (action === "rail") expect(boundary.latest!.edges).toBe(before);
});
