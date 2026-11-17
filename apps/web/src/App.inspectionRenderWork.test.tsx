import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { App } from "./App";
import { applyProjectLocale } from "./localization/i18n";
import { useGraphStore } from "./state/graphStore";
import { createProjectFixtureRuntimeFetch, loadProjectFixturesForTests } from "./testFixtures/projectFixtures";

const work = vi.hoisted(() => ({ nodeRenders: 0 }));
// Count real card invocations under the real React Flow wrapper, without replacing
// selection, node props, render output or commands with a synthetic implementation.
vi.mock("./app/graph/NarrativeNode", async (original) => {
  const actual = await original<typeof import("./app/graph/NarrativeNode")>();
  return { ...actual, NarrativeNode: (props: Parameters<typeof actual.NarrativeNode>[0]) => {
    work.nodeRenders++;
    return <actual.NarrativeNode {...props} />;
  } };
});
beforeEach(async () => {
  localStorage.clear(); await applyProjectLocale("en");
  useGraphStore.setState(useGraphStore.getInitialState(), true); loadProjectFixturesForTests();
  vi.stubGlobal("fetch", createProjectFixtureRuntimeFetch());
});
afterEach(() => vi.unstubAllGlobals());

it("does not reinvoke every unchanged card merely to toggle the project rail", async () => {
  render(<App />);
  await act(async () => {});
  const nodes = useGraphStore.getState().getActiveGraph().nodes;
  const wrappers = [...document.querySelectorAll(".react-flow__node")];
  expect(wrappers).toHaveLength(18);
  work.nodeRenders = 0;
  fireEvent.click(screen.getByTitle("Projects"));
  fireEvent.click(screen.getByTitle("Projects"));
  expect(work.nodeRenders).toBe(0);
  expect(useGraphStore.getState().getActiveGraph().nodes).toBe(nodes);
  expect([...document.querySelectorAll(".react-flow__node")]).toEqual(wrappers);
});

it("does not reinvoke an unchanged unselected graph merely to switch Select and Hand", async () => {
  render(<App />);
  await act(async () => {});
  const before = useGraphStore.getState().getActiveGraph().nodes;
  const wrappers = [...document.querySelectorAll(".react-flow__node")];
  work.nodeRenders = 0;
  fireEvent.click(screen.getByRole("button", { name: "Pan canvas" }));
  expect(document.querySelector(".react-flow")).toHaveClass("pan-canvas");
  fireEvent.click(screen.getByRole("button", { name: "Select" }));
  expect(work.nodeRenders).toBe(0);
  expect(useGraphStore.getState().getActiveGraph().nodes).toBe(before);
  expect([...document.querySelectorAll(".react-flow__node")]).toEqual(wrappers);
});

it("keeps actual React Flow keyboard selection disabled in Hand and restores it with Escape", async () => {
  render(<App />);
  await act(async () => {});
  const hero = screen.getByTestId("rf__node-node-hero");
  fireEvent.keyDown(hero, { key: "Enter" });
  fireEvent.keyUp(hero, { key: "Enter" });
  expect(hero).toHaveClass("selected");
  fireEvent.click(screen.getByRole("button", { name: "Pan canvas" }));
  const before = useGraphStore.getState().getActiveGraph().nodes;
  for (const key of ["Enter", " ", "ArrowRight", "ArrowDown", "Delete", "Backspace"]) {
    fireEvent.keyDown(hero, { key });
    fireEvent.keyUp(hero, { key });
    expect(hero).not.toHaveClass("selected");
  }
  expect(useGraphStore.getState().getActiveGraph().nodes).toBe(before);
  fireEvent.keyDown(hero, { key: "Escape" });
  fireEvent.keyUp(hero, { key: "Escape" });
  await act(async () => {});
  expect(document.querySelector(".react-flow")).not.toHaveClass("pan-canvas");
  expect(hero).toBeInTheDocument();
  fireEvent.keyDown(hero, { key: "Enter" });
  await waitFor(() => expect(hero).toHaveClass("selected"));
});
