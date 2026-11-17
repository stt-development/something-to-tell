import type { ReactFlowProps } from "@xyflow/react";
import { fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { App } from "./App";
import * as workspaceView from "./app/shell/AppWorkspaceView";
import type { AppWorkspaceViewProps } from "./app/shell/AppWorkspaceView";
import { applyProjectLocale } from "./localization/i18n";
import { useGraphStore } from "./state/graphStore";
import { createProjectFixtureRuntimeFetch, loadProjectFixturesForTests } from "./testFixtures/projectFixtures";

const boundary = vi.hoisted(() => ({ flow: [] as ReactFlowProps[] }));

// Observe references while delegating to the real React Flow and workspace view.
vi.mock("@xyflow/react", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@xyflow/react")>();
  return { ...actual, ReactFlow: (props: ReactFlowProps) => {
    boundary.flow.push(props);
    return <actual.ReactFlow {...props} />;
  } };
});

const workspace: AppWorkspaceViewProps[] = [];
beforeEach(async () => {
  window.localStorage.clear();
  await applyProjectLocale("en");
  useGraphStore.setState(useGraphStore.getInitialState(), true);
  loadProjectFixturesForTests();
  vi.stubGlobal("fetch", createProjectFixtureRuntimeFetch());
  boundary.flow.length = 0;
  workspace.length = 0;
  const ActualView = workspaceView.AppWorkspaceView;
  vi.spyOn(workspaceView, "AppWorkspaceView").mockImplementation((props) => {
    workspace.push(props);
    return <ActualView {...props} />;
  });
});
afterEach(() => { vi.restoreAllMocks(); vi.unstubAllGlobals(); });

const sample = () => ({ flow: boundary.flow.at(-1)!, workspace: workspace.at(-1)! });

/** Scalar reference characterization, not a renderer-commit or latency budget. */
function changes(before: ReturnType<typeof sample>, after: ReturnType<typeof sample>) {
  const stages = ["startFrameDraw", "continueFrameDraw", "finishFrameDraw"] as const;
  const previous = new Map(before.flow.nodes?.map((node) => [node.id, node]));
  const resizePairs = (after.flow.nodes ?? []).flatMap((node) => {
    const prior = previous.get(node.id);
    return prior && typeof prior.data.onResizeStart === "function" && typeof prior.data.onResizeEnd === "function"
      && typeof node.data.onResizeStart === "function" && typeof node.data.onResizeEnd === "function"
      ? [{ prior, node }] : [];
  });
  return {
    replacedDropCallbacks: (["onDragOver", "onDrop"] as const).filter((key) => before.flow[key] !== after.flow[key]).length,
    replacedFrameCallbacks: stages.filter((key) => before.workspace[key] !== after.workspace[key]).length,
    resizeNodes: resizePairs.length,
    replacedResizeActions: resizePairs.reduce((count, { prior, node }) => count
      + Number(prior.data.onResizeStart !== node.data.onResizeStart)
      + Number(prior.data.onResizeEnd !== node.data.onResizeEnd), 0)
  };
}

it("retains drop identity and unchanged frame-controller/resize inputs during view-only refreshes", () => {
  render(<App />);
  const hero = screen.getByTestId("rf__node-node-hero");
  fireEvent.click(hero);
  const graph = useGraphStore.getState().getActiveGraph();
  const initial = sample();
  const samples = [initial];
  fireEvent.click(screen.getByTitle("Projects")); samples.push(sample());
  fireEvent.click(screen.getByTitle("Projects")); samples.push(sample());
  fireEvent.doubleClick(hero); samples.push(sample());
  fireEvent.click(screen.getByRole("button", { name: "Close dialog" })); samples.push(sample());
  expect(changes(initial, samples.at(-1)!)).toEqual({
    replacedDropCallbacks: 0, replacedFrameCallbacks: 0, resizeNodes: 18, replacedResizeActions: 0
  });
  for (const key of ["onDragOver", "onDrop"] as const) expect(new Set(samples.map(({ flow }) => flow[key])).size).toBe(1);
  for (const key of ["startFrameDraw", "continueFrameDraw", "finishFrameDraw"] as const) expect(new Set(samples.map(({ workspace }) => workspace[key])).size).toBe(1);
  expect(useGraphStore.getState().getActiveGraph()).toBe(graph);
  expect(screen.getByTestId("rf__node-node-hero")).toBe(hero);
});

it("distinguishes real selection invalidation from view-only callbacks", () => {
  render(<App />);
  const initial = sample();
  const hero = screen.getByTestId("rf__node-node-hero");
  fireEvent.click(hero);
  expect(changes(initial, sample())).toEqual({
    replacedDropCallbacks: 0, replacedFrameCallbacks: 0, resizeNodes: 18, replacedResizeActions: 0
  });
  expect(sample().workspace.startFrameDraw).toBe(initial.workspace.startFrameDraw);
  expect(sample().workspace.continueFrameDraw).toBe(initial.workspace.continueFrameDraw);
  expect(sample().workspace.finishFrameDraw).toBe(initial.workspace.finishFrameDraw);
  const previousHero = initial.flow.nodes!.find((node) => node.id === "node-hero")!;
  const currentHero = sample().flow.nodes!.find((node) => node.id === "node-hero")!;
  expect(currentHero.selected).toBe(true);
  expect(currentHero).not.toBe(previousHero);
  expect(currentHero.data).toBe(previousHero.data);
  // Selection lives on the current wrapper; equal data and resize actions stay stable.
  for (const key of ["onResizeStart", "onResizeEnd"] as const) {
    expect(new Set(sample().flow.nodes!.map((node) => node.data[key])).size).toBe(1);
    expect(currentHero.data[key]).toBe(previousHero.data[key]);
  }
  expect(hero).toHaveClass("selected");
});

it("distinguishes tool-mode frame inputs from unchanged resize action data", () => {
  render(<App />);
  const initial = sample();
  fireEvent.click(screen.getByRole("button", { name: "Pan canvas" }));
  expect(changes(initial, sample())).toEqual({
    replacedDropCallbacks: 0, replacedFrameCallbacks: 0, resizeNodes: 18, replacedResizeActions: 0
  });
  expect(sample().workspace.startFrameDraw).toBe(initial.workspace.startFrameDraw);
  expect(sample().workspace.continueFrameDraw).toBe(initial.workspace.continueFrameDraw);
  expect(sample().workspace.finishFrameDraw).toBe(initial.workspace.finishFrameDraw);
  // The approved stable-flags default admits Hand through capture handlers,
  // not by fanning a global draggable flag through every node wrapper.
  expect(sample().flow.nodesDraggable).toBe(initial.flow.nodesDraggable);
  expect(sample().flow.nodesDraggable).toBe(true);
  expect(sample().flow.panOnDrag).toBe(true);
  expect(sample().flow.elementsSelectable).toBe(initial.flow.elementsSelectable);
  expect(sample().flow.selectionOnDrag).toBe(false);
  expect(sample().flow.onKeyDownCapture).toEqual(expect.any(Function));
  fireEvent.pointerDown(screen.getByTestId("rf__node-node-hero"), { button: 0 });
  expect(sample().flow.nodes!.find((node) => node.id === "node-hero")!.selectable).toBe(false);
});
