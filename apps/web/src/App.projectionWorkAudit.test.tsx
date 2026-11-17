import type { Node, ReactFlowProps } from "@xyflow/react";
import { act, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { App } from "./App";
import * as graph from "./app/graph/graphProjection";
import * as presentationGeometry from "./app/graph/nodePresentationGeometry";
import * as topologyBatch from "./app/graph/nodeTopologyMetrics";
import * as view from "./app/shell/AppWorkspaceView";
import type { AppWorkspaceViewProps } from "./app/shell/AppWorkspaceView";
import type { NarrativeNodeRenderData } from "./app/workspaceShared";
import * as canon from "./canon/navigation";
import * as layout from "./composition/layout";
import * as frameBounds from "./composition/frameBounds";
import * as impact from "./impact/navigation";
import { applyProjectLocale, tr } from "./localization/i18n";
import { useGraphStore } from "./state/graphStore";
import * as flow from "./story-flow/workspace";
import { createProjectFixtureRuntimeFetch, loadProjectFixturesForTests } from "./testFixtures/projectFixtures";

const boundary = vi.hoisted(() => ({ latest: null as ReactFlowProps | null }));
// Observe actual inputs without replacing production projections, renderers or commands.
vi.mock("@xyflow/react", async (original) => {
  const actual = await original<typeof import("@xyflow/react")>();
  return { ...actual, ReactFlow: (props: ReactFlowProps) => {
    boundary.latest = props;
    return <actual.ReactFlow {...props} />;
  } };
});
let workspace: AppWorkspaceViewProps;
const latest = () => boundary.latest!.nodes as Node<NarrativeNodeRenderData>[];
beforeEach(async () => {
  window.localStorage.clear();
  await applyProjectLocale("en");
  useGraphStore.setState(useGraphStore.getInitialState(), true);
  loadProjectFixturesForTests();
  vi.stubGlobal("fetch", createProjectFixtureRuntimeFetch());
  const ActualView = view.AppWorkspaceView;
  vi.spyOn(view, "AppWorkspaceView").mockImplementation((props) => {
    workspace = props;
    return <ActualView {...props} />;
  });
});
afterEach(() => { vi.restoreAllMocks(); vi.unstubAllGlobals(); });

// Counts distinguish independent owners, not cumulative CPU or all internal iterations.
// Column order: workspace, filter, frame, issues, canon, impact, clamp,
// projection-only position resolver builds, topology batches. The independently
// enabled viewport descriptor owner is counted and bounded separately below.
it.each([
  { action: "rail", calls: [0, 0, 0, 0, 0, 0, 0, 0, 0] },
  { action: "selection", calls: [1, 1, 1, 1, 1, 1, 1, 0, 1] },
  { action: "Text", calls: [1, 1, 1, 1, 1, 1, 0, 0, 1] },
  { action: "Flow", calls: [1, 1, 1, 1, 1, 1, 0, 0, 0] },
  { action: "focus", calls: [0, 0, 1, 1, 1, 1, 0, 0, 0] },
  { action: "filter", calls: [0, 1, 1, 1, 1, 1, 0, 1, 0] },
  { action: "diagnostics", calls: [0, 0, 0, 1, 1, 1, 0, 0, 0] },
  { action: "locale", calls: [0, 0, 0, 0, 0, 0, 0, 0, 0] }
])("inventories current projection inputs and helper calls after $action", async ({ action, calls }) => {
  const metrics = vi.spyOn(topologyBatch, "buildNodeTopologyMetrics");
  const singleOwner = vi.spyOn(graph, "nodePresentationMetrics");
  const legacyPosition = vi.spyOn(layout, "absoluteNodePosition");
  const frameBatch = vi.spyOn(frameBounds, "buildFrameChildBounds");
  const resolvePosition = layout.createAbsoluteNodePositionResolver;
  const projectPlacements = presentationGeometry.projectViewportPlacements;
  let insideViewport = false, viewportResolvers = 0, projectionResolvers = 0;
  const resolver = vi.spyOn(layout, "createAbsoluteNodePositionResolver").mockImplementation((nodes) => {
    if (insideViewport) viewportResolvers++; else projectionResolvers++;
    return resolvePosition(nodes);
  });
  const viewport = vi.spyOn(presentationGeometry, "projectViewportPlacements").mockImplementation((nodes) => {
    insideViewport = true;
    try { return projectPlacements(nodes); } finally { insideViewport = false; }
  });
  const probes = [
    vi.spyOn(flow, "projectGraphForWorkspace"), vi.spyOn(graph, "filterGraphForView"),
    vi.spyOn(graph, "projectFrameWorkspace"), vi.spyOn(graph, "applyIssueOverlays"),
    vi.spyOn(canon, "highlightCanonTargets"), vi.spyOn(impact, "projectImpactHighlights"),
    vi.spyOn(layout, "enforceFrameMinimums"), resolver,
    metrics
  ];
  render(<App />);
  const raw = workspace.nodes;
  const final = boundary.latest!.nodes;
  legacyPosition.mockClear();
  singleOwner.mockClear();
  frameBatch.mockClear();
  for (const probe of probes) probe.mockClear();
  viewport.mockClear(); viewportResolvers = 0; projectionResolvers = 0;
  if (action === "rail") fireEvent.click(screen.getByTitle("Projects"));
  if (action === "selection") fireEvent.click(screen.getByTestId("rf__node-node-hero"));
  if (action === "Text") act(() => {
    const state = useGraphStore.getState();
    const hero = state.getActiveGraph().nodes.find((item) => item.id === "node-hero")!;
    state.updateNode(hero.id, { ...hero.data, summary: "Current projection audit Text" });
  });
  if (action === "Flow") fireEvent.click(screen.getByRole("button", { name: "Flow" }));
  if (action === "focus") act(() => latest().find((item) => item.id === "node-opening")!.data.onFocusFrame!());
  if (action === "filter") act(() => workspace.setGraphFilter({ ...workspace.graphFilter, kinds: ["Character"] }));
  if (action === "diagnostics") act(() => {
    const state = useGraphStore.getState();
    const current = state.getActiveGraph();
    useGraphStore.setState({ graphs: { ...state.graphs, [state.activeProjectId]: { ...current,
      issues: current.issues.map((issue, index) => index === 0 ? { ...issue, title: "Current diagnostic audit" } : issue)
    } } });
  });
  if (action === "locale") await act(async () => { await applyProjectLocale("ru"); });
  expect(probes.map((probe, index) => index === 7 ? projectionResolvers : probe.mock.calls.length)).toEqual(calls);
  expect(viewportResolvers).toBe(viewport.mock.calls.length);
  expect(viewport.mock.calls.length).toBeLessThanOrEqual(2);
  expect(resolver.mock.calls.length).toBe(projectionResolvers + viewportResolvers);
  expect(legacyPosition).not.toHaveBeenCalled();
  expect(singleOwner).not.toHaveBeenCalled();
  expect(frameBatch.mock.calls.length).toBe(action === "selection" ? 1 : 0);
  if (action === "selection") expect(frameBatch.mock.calls[0]![0]).toHaveLength(18);
  if (action === "selection" || action === "Text") {
    expect(metrics.mock.calls.every(([nodes, edges]) => nodes.length === 18 && edges.length === 11)).toBe(true);
  }
  const viewSize = action === "Flow" ? 7 : action === "focus" ? 8 : action === "filter" ? 3 : 18;
  for (const index of [1, 2, 3, 4, 5]) {
    const args = probes[index]!.mock.calls.at(-1);
    if (!args) continue;
    // Filtering/focus consume upstream inputs, overlays consume the visible projection.
    const expected = index === 1 ? (action === "Flow" ? 7 : 18)
      : index === 2 ? (action === "filter" ? 3 : action === "Flow" ? 7 : 18) : viewSize;
    expect(args[0]).toHaveLength(expected);
  }
  expect(workspace.nodes !== raw).toBe(action === "selection" || action === "Text");
  expect(boundary.latest!.nodes === final).toBe(action === "rail" || action === "locale");
  if (action === "selection") expect(screen.getByTestId("rf__node-node-hero")).toHaveClass("selected");
  if (action === "Text") expect(screen.getByTestId("rf__node-node-hero")).toHaveTextContent("Current projection audit Text");
  if (action === "Flow") expect(boundary.latest!.nodes!.every((item) => item.data.workspaceMode === "flow")).toBe(true);
  if (action === "focus") expect(screen.getByLabelText("Focused frame workspace")).toBeInTheDocument();
  if (action === "filter") expect(boundary.latest!.nodes!.every((item) => item.data.kind === "Character")).toBe(true);
  if (action === "diagnostics") expect(boundary.latest!.nodes!.some((item) => String(item.data.issuePreview).includes("Current diagnostic audit"))).toBe(true);
  if (action === "locale") {
    expect(tr("node.character")).not.toBe("Character");
    expect(screen.getByTestId("rf__node-node-hero")).toHaveTextContent(tr("node.character"));
  }
});
