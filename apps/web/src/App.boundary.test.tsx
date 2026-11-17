import { fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { App } from "./App";
import type { ReactFlowProps } from "@xyflow/react";
import { applyProjectLocale } from "./localization/i18n";
import { useGraphStore } from "./state/graphStore";
import { createProjectFixtureRuntimeFetch, loadProjectFixturesForTests } from "./testFixtures/projectFixtures";

const canvas = vi.hoisted(() => ({ latest: null as ReactFlowProps | null }));
// Observe final App props without replacing the production projection or renderer.
vi.mock("@xyflow/react", async (original) => {
  const actual = await original<typeof import("@xyflow/react")>();
  return { ...actual, ReactFlow: (props: ReactFlowProps) => {
    canvas.latest = props;
    return <actual.ReactFlow {...props} />;
  } };
});
const boundaries = () => canvas.latest!.edges!.filter((edge) => edge.id.startsWith("story-boundary:"));

beforeEach(async () => {
  window.localStorage.clear();
  await applyProjectLocale("en");
  useGraphStore.setState(useGraphStore.getInitialState(), true);
  const fixture = loadProjectFixturesForTests();
  // A linked child is a canonical Scene member too; retain the ordinary Dialogue route.
  const main = fixture.storyFlows.find((snapshot) => snapshot.flow.kind === "main")!;
  main.scene_boundaries[0]!.entry_node_id = "node-sealed-ledger";
  main.scene_children["node-opening"]!.push("node-sealed-ledger");
  useGraphStore.setState({ storyFlowsByProject: { "project-aurora": fixture.storyFlows } });
  vi.stubGlobal("fetch", createProjectFixtureRuntimeFetch());
});
afterEach(() => { vi.unstubAllGlobals(); });

it("passes a standalone Scene boundary to the renderer and restores it after scope replacement", () => {
  render(<App />);
  const graphBoundaries = boundaries();
  fireEvent.click(screen.getByRole("button", { name: "Flow" }));
  expect(boundaries()).toHaveLength(1);
  const original = boundaries()[0]!;
  expect(original).toMatchObject({ id: "story-boundary:flow-main-story:boundary:node-opening", source: "node-opening",
    target: "node-sealed-ledger", label: "Scene entry", sourceHandle: "right", targetHandle: "left", reconnectable: false });
  expect(original.markerEnd).toMatchObject({ type: "arrowclosed" });
  fireEvent.click(screen.getByRole("button", { name: "Open Story Flow Smuggler Route" }));
  expect(boundaries()).toHaveLength(0);
  fireEvent.click(screen.getByRole("button", { name: "Open Story Flow Main Story" }));
  expect(boundaries()).toEqual([original]);
  fireEvent.click(screen.getByRole("button", { name: "Graph" }));
  // Graph keeps its existing placement/filter policy; switching modes cannot change it.
  expect(boundaries()).toEqual(graphBoundaries);
  fireEvent.click(screen.getByRole("button", { name: "Flow" }));
  expect(boundaries()).toEqual([original]);
});
