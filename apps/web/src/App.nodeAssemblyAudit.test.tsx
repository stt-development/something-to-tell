import type { Node, ReactFlowProps } from "@xyflow/react";
import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { App } from "./App";
import * as workspaceView from "./app/shell/AppWorkspaceView";
import type { AppWorkspaceViewProps } from "./app/shell/AppWorkspaceView";
import type { NarrativeNodeRenderData } from "./app/workspaceShared";
import { applyProjectLocale, tr } from "./localization/i18n";
import { useGraphStore } from "./state/graphStore";
import { createProjectFixtureRuntimeFetch, loadProjectFixturesForTests } from "./testFixtures/projectFixtures";

const boundary = vi.hoisted(() => ({ samples: [] as ReactFlowProps[] }));
// Observe real App/view/React Flow inputs without replacing renderers or graph behavior.
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
const sample = () => ({ raw: workspace.nodes, projected: workspace.graphWithImpactHighlights.nodes, assembled: latest() });
const node = (id: string) => latest().find((item) => item.id === id)!;

/** Test-only own-property reference inventory, not a production graph/node comparator. */
function changedKeys(before: object, after: object, omitData = false) {
  const previous = before as Record<string, unknown>;
  const next = after as Record<string, unknown>;
  const owns = (value: object, key: string) => Object.prototype.hasOwnProperty.call(value, key);
  return [...new Set([...Object.keys(previous), ...Object.keys(next)])].filter((key) => (!omitData || key !== "data")
    && (owns(previous, key) !== owns(next, key) || !Object.is(previous[key], next[key]))).sort();
}
function countKeys(keys: string[][]) {
  const counts: Record<string, number> = {};
  for (const list of keys) for (const key of list) counts[key] = (counts[key] ?? 0) + 1;
  return counts;
}
/** Complete wrapper references, including data, not deep geometry/style equality. */
function wrapperChanges(before: Node<NarrativeNodeRenderData>[]) {
  const after = latest();
  const previous = new Map(before.map((item) => [item.id, item]));
  const nextIds = new Set(after.map((item) => item.id));
  const pairs = after.flatMap((item) => previous.has(item.id) ? [{ before: previous.get(item.id)!, after: item }] : []);
  const equal = pairs.filter((pair) => changedKeys(pair.before, pair.after).length === 0);
  return {
    arrayReused: before === after,
    sameOrder: before.length === after.length && before.every((item, index) => item.id === after[index]!.id),
    added: after.length - pairs.length,
    removed: before.filter((item) => !nextIds.has(item.id)).length,
    shared: pairs.length,
    replacedWrappers: pairs.filter((pair) => pair.before !== pair.after).length,
    equalWrappers: equal.length,
    replacedEqualWrappers: equal.filter((pair) => pair.before !== pair.after).length,
    changedData: pairs.filter((pair) => pair.before.data !== pair.after.data).length,
    outerFields: countKeys(pairs.map((pair) => changedKeys(pair.before, pair.after, true)))
  };
}
/** Latest-boundary characterization only; scoped optimizations must update these counts deliberately. */
function changes(before: ReturnType<typeof sample>) {
  const after = sample();
  const stageChanges = (stage: keyof typeof after) => {
    const previous = new Map(before[stage].map((item) => [item.id, item]));
    const pairs = after[stage].flatMap((item) => previous.has(item.id) ? [{ before: previous.get(item.id)!, after: item }] : []);
    const dataKeys = pairs.map((pair) => changedKeys(pair.before.data, pair.after.data));
    return { arrayReused: before[stage] === after[stage], shared: pairs.length,
      replacedNodes: pairs.filter((pair) => pair.before !== pair.after).length,
      replacedData: pairs.filter((pair) => pair.before.data !== pair.after.data).length,
      equalDataFields: dataKeys.filter((keys) => keys.length === 0).length,
      dataKeys: countKeys(dataKeys), nodeKeys: countKeys(pairs.map((pair) => changedKeys(pair.before, pair.after, true))) };
  };
  return { raw: stageChanges("raw"), projected: stageChanges("projected"), assembled: stageChanges("assembled") };
}

it.each(["selection", "authored Text"])("locates raw/projection/assembly reference changes after %s", (change) => {
  render(<App />);
  const before = sample();
  if (change === "selection") fireEvent.click(screen.getByTestId("rf__node-node-hero"));
  else act(() => {
    const source = useGraphStore.getState().getActiveGraph().nodes.find((item) => item.id === "node-hero")!;
    useGraphStore.getState().updateNode(source.id, { ...source.data, summary: "Assembly audit Text" });
  });
  expect(changes(before)).toEqual(change === "selection" ? {
    raw: { arrayReused: false, shared: 18, replacedNodes: 4, replacedData: 0, equalDataFields: 18, dataKeys: {}, nodeKeys: { selected: 1 } },
    projected: { arrayReused: false, shared: 18, replacedNodes: 18, replacedData: 18, equalDataFields: 18, dataKeys: {}, nodeKeys: { selected: 1 } },
    assembled: { arrayReused: false, shared: 18, replacedNodes: 1, replacedData: 0, equalDataFields: 18, dataKeys: {}, nodeKeys: { selected: 1 } }
  } : {
    raw: { arrayReused: false, shared: 18, replacedNodes: 1, replacedData: 1, equalDataFields: 17, dataKeys: { summary: 1 }, nodeKeys: {} },
    projected: { arrayReused: false, shared: 18, replacedNodes: 18, replacedData: 18, equalDataFields: 17, dataKeys: { summary: 1 }, nodeKeys: {} },
    assembled: { arrayReused: false, shared: 18, replacedNodes: 1, replacedData: 1, equalDataFields: 17, dataKeys: { summary: 1 }, nodeKeys: { selected: 1 } }
  });
  expect(wrapperChanges(before.assembled)).toEqual({ arrayReused: false, sameOrder: true, added: 0, removed: 0, shared: 18,
    replacedWrappers: 1, equalWrappers: 17, replacedEqualWrappers: 0,
    changedData: change === "selection" ? 0 : 1, outerFields: { selected: 1 } });
});

it("separates current connection/drop feedback from unchanged raw and projected data", () => {
  render(<App />);
  const before = sample();
  act(() => {
    workspace.setConnectionSourceId("node-hero");
    workspace.setConnectionTargetId("node-dockmaster");
    workspace.setCompositionDrop({ frameId: "node-opening", valid: true, message: "Current drop feedback" });
  });
  expect(sample().raw).toBe(before.raw);
  expect(sample().projected).toBe(before.projected);
  expect(node("node-hero").data.isConnectionSource).toBe(true);
  expect(node("node-dockmaster").data.isConnectionTarget).toBe(true);
  expect(node("node-opening").data.compositionDropState?.message).toBe("Current drop feedback");
  expect(changes(before).assembled).toEqual({ arrayReused: false, shared: 18, replacedNodes: 3, replacedData: 3,
    equalDataFields: 15, dataKeys: { compositionDropState: 1, isConnectionSource: 1, isConnectionTarget: 1 }, nodeKeys: {} });
  expect(wrapperChanges(before.assembled)).toMatchObject({ equalWrappers: 15, replacedEqualWrappers: 0, outerFields: {} });
});

it("keeps geometry live independently from equal data fields", () => {
  render(<App />);
  const before = sample();
  const position = { x: node("node-hero").position.x + 50, y: node("node-hero").position.y + 30 };
  act(() => useGraphStore.getState().onNodesChange([{ id: "node-hero", type: "position", position }]));
  expect(node("node-hero").position).toEqual(position);
  expect(changes(before).assembled).toEqual({ arrayReused: false, shared: 18, replacedNodes: 1, replacedData: 0,
    equalDataFields: 18, dataKeys: {}, nodeKeys: { position: 1 } });
  expect(wrapperChanges(before.assembled)).toMatchObject({ equalWrappers: 17, replacedEqualWrappers: 0 });
});

it("keeps issue previews live when raw author data is unchanged", () => {
  render(<App />);
  const before = sample();
  act(() => {
    const state = useGraphStore.getState();
    const graph = state.getActiveGraph();
    useGraphStore.setState({ graphs: { ...state.graphs, [state.activeProjectId]: { ...graph,
      issues: graph.issues.map((issue, index) => index === 0 ? { ...issue, nodeId: "node-hero", title: "Assembly finding", description: "Current issue details" } : issue)
    } } });
  });
  expect(sample().raw).toBe(before.raw);
  expect(node("node-hero").data.issuePreview).toContain("Assembly finding: Current issue details");
  expect(changes(before).assembled.dataKeys).toHaveProperty("issuePreview");
  expect(changes(before).assembled.equalDataFields).toBeGreaterThan(0);
  expect(wrapperChanges(before.assembled)).toMatchInlineSnapshot(`
    {
      "added": 0,
      "arrayReused": false,
      "changedData": 2,
      "equalWrappers": 16,
      "outerFields": {},
      "removed": 0,
      "replacedEqualWrappers": 0,
      "replacedWrappers": 2,
      "sameOrder": true,
      "shared": 18,
    }
  `);
});

it("keeps temporal style independent from otherwise equal data fields", async () => {
  useGraphStore.setState({ runtimeStatus: "ready" });
  render(<App />);
  await waitFor(() => expect(workspace.temporalStateProjection.effects).not.toHaveLength(0));
  const before = sample();
  const shadow = node("node-hero").style?.boxShadow;
  act(() => workspace.setSelectedTemporalOwner({ owner_version: 1, owner_kind: "dialogue_element", owner_id: "line-ilya-concedes", context_node_id: "node-dock-dialogue" }));
  expect(node("node-hero").style?.boxShadow).toBe("0 0 0 4px rgb(13 148 136 / 32%)");
  expect(sample().raw).toBe(before.raw);
  expect(sample().projected).toBe(before.projected);
  expect(changes(before).assembled).toEqual({ arrayReused: false, shared: 18, replacedNodes: 5, replacedData: 0,
    equalDataFields: 18, dataKeys: {}, nodeKeys: { style: 5 } });
  expect(wrapperChanges(before.assembled)).toMatchObject({ equalWrappers: 13, replacedEqualWrappers: 0, changedData: 0 });
  act(() => workspace.setSelectedTemporalOwner(null));
  expect(node("node-hero").style?.boxShadow).toBe(shadow);
});

it("keeps locale-dependent renderers live rather than treating equal data as translated output", async () => {
  render(<App />);
  const before = sample();
  await act(async () => { await applyProjectLocale("ru"); });
  expect(tr("node.character")).not.toBe("Character");
  expect(screen.getByTestId("rf__node-node-hero")).toHaveTextContent(`${tr("node.character")}: Mara Vale`);
  expect(changes(before).assembled).toEqual({ arrayReused: true, shared: 18, replacedNodes: 0, replacedData: 0,
    equalDataFields: 18, dataKeys: {}, nodeKeys: {} });
  expect(wrapperChanges(before.assembled)).toMatchObject({ arrayReused: true, equalWrappers: 18, replacedWrappers: 0 });
});

it("preserves current Flow projection fields and geometry after a workspace switch", () => {
  render(<App />);
  const before = sample();
  fireEvent.click(screen.getByRole("button", { name: "Flow" }));
  expect(latest().length).toBeLessThan(before.assembled.length);
  for (const item of latest()) expect(item.data.workspaceMode).toBe("flow");
  expect(changes(before).assembled.dataKeys).toHaveProperty("workspaceMode");
  expect(changes(before).assembled.nodeKeys).toHaveProperty("position");
  expect(wrapperChanges(before.assembled)).toMatchInlineSnapshot(`
    {
      "added": 0,
      "arrayReused": false,
      "changedData": 7,
      "equalWrappers": 0,
      "outerFields": {
        "height": 1,
        "parentId": 7,
        "position": 7,
        "width": 7,
      },
      "removed": 11,
      "replacedEqualWrappers": 0,
      "replacedWrappers": 7,
      "sameOrder": false,
      "shared": 7,
    }
  `);
});

it("retains the final array through an equal source refresh", () => {
  render(<App />);
  const before = sample();
  act(() => {
    const state = useGraphStore.getState();
    const graph = state.getActiveGraph();
    useGraphStore.setState({ graphs: { ...state.graphs, [state.activeProjectId]: { ...graph, nodes: [...graph.nodes] } } });
  });
  expect(wrapperChanges(before.assembled)).toMatchInlineSnapshot(`
    {
      "added": 0,
      "arrayReused": true,
      "changedData": 0,
      "equalWrappers": 18,
      "outerFields": {},
      "removed": 0,
      "replacedEqualWrappers": 0,
      "replacedWrappers": 0,
      "sameOrder": true,
      "shared": 18,
    }
  `);
});

it("records source ordering even when every complete wrapper has equal fields", () => {
  render(<App />);
  const before = sample();
  act(() => {
    const state = useGraphStore.getState();
    const graph = state.getActiveGraph();
    // Reorder only root leaves; keep every frame before its children for React Flow.
    const leaves = graph.nodes.filter((item) => !item.parentId && !item.data.isFrame).reverse();
    const reordered = graph.nodes.map((item) => !item.parentId && !item.data.isFrame ? leaves.shift()! : item);
    useGraphStore.setState({ graphs: { ...state.graphs, [state.activeProjectId]: { ...graph, nodes: reordered } } });
  });
  expect(wrapperChanges(before.assembled)).toMatchInlineSnapshot(`
    {
      "added": 0,
      "arrayReused": false,
      "changedData": 0,
      "equalWrappers": 18,
      "outerFields": {},
      "removed": 0,
      "replacedEqualWrappers": 0,
      "replacedWrappers": 0,
      "sameOrder": false,
      "shared": 18,
    }
  `);
});

it("does not mistake a fresh equal-valued position for a retained geometry reference", () => {
  render(<App />);
  const before = sample();
  const position = { ...node("node-hero").position };
  act(() => useGraphStore.getState().onNodesChange([{ id: "node-hero", type: "position", position }]));
  expect(node("node-hero").position).toEqual(before.assembled.find((item) => item.id === "node-hero")!.position);
  expect(node("node-hero").position).not.toBe(before.assembled.find((item) => item.id === "node-hero")!.position);
  expect(wrapperChanges(before.assembled)).toMatchInlineSnapshot(`
    {
      "added": 0,
      "arrayReused": false,
      "changedData": 0,
      "equalWrappers": 17,
      "outerFields": {
        "position": 1,
      },
      "removed": 0,
      "replacedEqualWrappers": 0,
      "replacedWrappers": 1,
      "sameOrder": true,
      "shared": 18,
    }
  `);
});

it("counts unknown outer own-field presence even when its value is undefined", () => {
  render(<App />);
  const initial = latest();
  const update = (add: boolean) => act(() => {
    const state = useGraphStore.getState();
    const graph = state.getActiveGraph();
    const nodes = graph.nodes.map((item) => {
      if (item.id !== "node-hero") return item;
      const extended = { ...item, auditOuterOptional: undefined };
      const { auditOuterOptional: _omitted, ...withoutOptional } = extended;
      return add ? extended : withoutOptional;
    });
    useGraphStore.setState({ graphs: { ...state.graphs, [state.activeProjectId]: { ...graph, nodes } } });
  });
  update(true);
  expect(wrapperChanges(initial)).toMatchObject({ changedData: 0, equalWrappers: 17, outerFields: { auditOuterOptional: 1 } });
  const added = latest();
  update(false);
  expect(wrapperChanges(added)).toMatchObject({ changedData: 0, equalWrappers: 17, outerFields: { auditOuterOptional: 1 } });
});

it("separates measured dimensions and resize flags from retained authored data", () => {
  render(<App />);
  const before = sample();
  act(() => useGraphStore.getState().onNodesChange([{ id: "node-hero", type: "dimensions",
    dimensions: { width: 360, height: 240 }, resizing: true, setAttributes: true }]));
  expect(node("node-hero")).toMatchObject({ width: 360, height: 240, measured: { width: 360, height: 240 }, resizing: true });
  expect(node("node-hero").data).toBe(before.assembled.find((item) => item.id === "node-hero")!.data);
  expect(wrapperChanges(before.assembled)).toMatchInlineSnapshot(`
    {
      "added": 0,
      "arrayReused": false,
      "changedData": 0,
      "equalWrappers": 17,
      "outerFields": {
        "height": 1,
        "measured": 1,
        "resizing": 1,
        "width": 1,
      },
      "removed": 0,
      "replacedEqualWrappers": 0,
      "replacedWrappers": 1,
      "sameOrder": true,
      "shared": 18,
    }
  `);
});

it("moves only the linked placement geometry, not its canonical sibling", () => {
  render(<App />);
  act(() => { expect(useGraphStore.getState().addLinkedInstance("node-hero", "node-customs-office").valid).toBe(true); });
  const linked = latest().find((item) => item.data.isLinkedInstance && item.data.canonicalNodeId === "node-hero" && item.parentId === "node-customs-office")!;
  const before = sample();
  const position = { x: linked.position.x + 20, y: linked.position.y + 30 };
  act(() => useGraphStore.getState().onNodesChange([{ id: linked.id, type: "position", position }]));
  expect(node(linked.id).position).toEqual(position);
  expect(node("node-hero").position).toBe(before.assembled.find((item) => item.id === "node-hero")!.position);
  expect(node(linked.id).data).toBe(linked.data);
  expect(wrapperChanges(before.assembled)).toMatchInlineSnapshot(`
    {
      "added": 0,
      "arrayReused": false,
      "changedData": 0,
      "equalWrappers": 16,
      "outerFields": {
        "height": 2,
        "position": 1,
      },
      "removed": 0,
      "replacedEqualWrappers": 0,
      "replacedWrappers": 3,
      "sameOrder": true,
      "shared": 19,
    }
  `);
});

it("records containment parentage independently from the complete data payload", () => {
  render(<App />);
  const before = sample();
  act(() => {
    const state = useGraphStore.getState();
    expect(state.completeNodeDrop("node-hero", "node-customs-office", state.getActiveGraph().nodes).valid).toBe(true);
  });
  expect(node("node-hero").parentId).toBe("node-customs-office");
  expect(wrapperChanges(before.assembled)).toMatchInlineSnapshot(`
    {
      "added": 0,
      "arrayReused": false,
      "changedData": 2,
      "equalWrappers": 16,
      "outerFields": {
        "height": 1,
        "parentId": 1,
        "position": 2,
        "width": 1,
      },
      "removed": 0,
      "replacedEqualWrappers": 0,
      "replacedWrappers": 2,
      "sameOrder": false,
      "shared": 18,
    }
  `);
});

it("inventories removals and restored children when a container collapses and expands", () => {
  render(<App />);
  const before = sample();
  act(() => useGraphStore.getState().toggleFrameCollapse("node-opening"));
  expect(node("node-opening").data.presentationState).toBe("collapsed");
  expect(latest().some((item) => item.id === "node-dock-dialogue")).toBe(false);
  const collapsed = latest();
  const collapseChanges = wrapperChanges(before.assembled);
  act(() => useGraphStore.getState().toggleFrameCollapse("node-opening"));
  expect(node("node-opening").data.presentationState).toBe("expanded");
  expect(node("node-dock-dialogue")).toBeDefined();
  expect({ collapse: collapseChanges, expand: wrapperChanges(collapsed) }).toMatchInlineSnapshot(`
    {
      "collapse": {
        "added": 0,
        "arrayReused": false,
        "changedData": 1,
        "equalWrappers": 10,
        "outerFields": {
          "height": 1,
          "selected": 1,
          "width": 1,
        },
        "removed": 7,
        "replacedEqualWrappers": 0,
        "replacedWrappers": 1,
        "sameOrder": false,
        "shared": 11,
      },
      "expand": {
        "added": 7,
        "arrayReused": false,
        "changedData": 1,
        "equalWrappers": 10,
        "outerFields": {
          "height": 1,
          "width": 1,
        },
        "removed": 0,
        "replacedEqualWrappers": 0,
        "replacedWrappers": 1,
        "sameOrder": false,
        "shared": 11,
      },
    }
  `);
});

it("inventories focused-container geometry and restores the full workspace membership", () => {
  render(<App />);
  const before = sample();
  act(() => node("node-opening").data.onFocusFrame!());
  expect(screen.getByLabelText("Focused frame workspace")).toBeInTheDocument();
  const focused = latest();
  const focusChanges = wrapperChanges(before.assembled);
  expect(node("node-opening").position).toEqual({ x: 0, y: 0 });
  fireEvent.click(screen.getByRole("button", { name: "Exit focused frame workspace" }));
  expect(latest().map((item) => item.id)).toEqual(before.assembled.map((item) => item.id));
  expect({ focus: focusChanges, exit: wrapperChanges(focused) }).toMatchInlineSnapshot(`
    {
      "exit": {
        "added": 10,
        "arrayReused": false,
        "changedData": 0,
        "equalWrappers": 7,
        "outerFields": {
          "position": 1,
        },
        "removed": 0,
        "replacedEqualWrappers": 0,
        "replacedWrappers": 1,
        "sameOrder": false,
        "shared": 8,
      },
      "focus": {
        "added": 0,
        "arrayReused": false,
        "changedData": 0,
        "equalWrappers": 7,
        "outerFields": {
          "position": 1,
          "selected": 1,
        },
        "removed": 10,
        "replacedEqualWrappers": 0,
        "replacedWrappers": 1,
        "sameOrder": false,
        "shared": 8,
      },
    }
  `);
});

it("observes optional field presence separately from an equal undefined value", () => {
  render(<App />);
  const before = sample();
  const original = node("node-hero").data;
  const setOptional = (add: boolean) => act(() => {
    const state = useGraphStore.getState();
    const graph = state.getActiveGraph();
    const data = { ...graph.nodes.find((item) => item.id === "node-hero")!.data, auditOptional: undefined };
    // Optional own fields are part of the candidate payload, even when undefined.
    const { auditOptional: _omitted, ...withoutOptional } = data;
    useGraphStore.setState({ graphs: { ...state.graphs, [state.activeProjectId]: { ...graph,
      nodes: graph.nodes.map((item) => item.id === "node-hero" ? { ...item, data: add ? data : withoutOptional } : item)
    } } });
  });
  expect(Object.prototype.hasOwnProperty.call(original, "auditOptional")).toBe(false);
  setOptional(true);
  expect(changes(before).assembled.dataKeys).toEqual({ auditOptional: 1 });
  const added = sample();
  setOptional(false);
  expect(changes(added).assembled.dataKeys).toEqual({ auditOptional: 1 });
});
