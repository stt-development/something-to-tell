import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { App } from "./App";
import { applyProjectLocale } from "./localization/i18n";
import { useGraphStore } from "./state/graphStore";
import { createProjectFixtureRuntimeFetch, loadProjectFixturesForTests } from "./testFixtures/projectFixtures";

// This file exercises the approved gate against the actual React Flow keyboard handler.
// Keep the earlier stable-only cohort distinct from the combined release default.
vi.mock("./app/graph/CanvasSelectableReactFlow", async original => ({
  ...await original<typeof import("./app/graph/CanvasSelectableReactFlow")>(),
  TARGET_SELECTABLE_EXPERIMENT_ENABLED: false
}));
vi.mock("./app/graph/canvasToolInteraction", async original => ({
  ...await original<typeof import("./app/graph/canvasToolInteraction")>(),
  STABLE_TOOL_INTERACTION_EXPERIMENT_ENABLED: true
}));
beforeEach(async () => {
  localStorage.clear(); await applyProjectLocale("en");
  useGraphStore.setState(useGraphStore.getInitialState(), true); loadProjectFixturesForTests();
  vi.stubGlobal("fetch", createProjectFixtureRuntimeFetch());
});
afterEach(() => vi.unstubAllGlobals());

it("keeps Hand keyboard selection disabled and restores Escape/Enter without stale engine flags", async () => {
  render(<App />); await act(async () => {});
  const hero = screen.getByTestId("rf__node-node-hero");
  fireEvent.keyDown(hero, { key: "Enter" }); fireEvent.keyUp(hero, { key: "Enter" });
  expect(hero).toHaveClass("selected");
  fireEvent.click(screen.getByRole("button", { name: "Pan canvas" }));
  const before = useGraphStore.getState().getActiveGraph().nodes;
  expect(hero).toHaveClass("draggable");
  expect(hero).not.toHaveClass("selectable");
  for (const key of ["Enter", " ", "ArrowRight", "ArrowDown", "Delete", "Backspace"]) {
    fireEvent.keyDown(hero, { key, code: key === " " ? "Space" : key });
    fireEvent.keyUp(hero, { key, code: key === " " ? "Space" : key });
    expect(hero).not.toHaveClass("selected");
  }
  expect(useGraphStore.getState().getActiveGraph().nodes).toBe(before);
  fireEvent.keyDown(hero, { key: "Escape" }); fireEvent.keyUp(hero, { key: "Escape" });
  await act(async () => {});
  expect(document.querySelector(".react-flow")).not.toHaveClass("pan-canvas");
  fireEvent.keyDown(hero, { key: "Enter" });
  await waitFor(() => expect(hero).toHaveClass("selected"));
});

it("retains native wrappers and restores Select after repeated Hand round trips", async () => {
  render(<App />); await act(async () => {});
  const wrappers = [...document.querySelectorAll(".react-flow__node")];
  const nodes = useGraphStore.getState().getActiveGraph().nodes;
  for (let index = 0; index < 3; index++) {
    fireEvent.click(screen.getByRole("button", { name: "Pan canvas" }));
    expect(screen.getByTestId("rf__node-node-hero")).not.toHaveClass("selectable");
    fireEvent.click(screen.getByRole("button", { name: "Select" }));
    expect(screen.getByTestId("rf__node-node-hero")).toHaveClass("selectable");
  }
  expect([...document.querySelectorAll(".react-flow__node")]).toEqual(wrappers);
  expect(useGraphStore.getState().getActiveGraph().nodes).toBe(nodes);
});

it("preserves native interactivity-lock reset when returning from Hand to Select", async () => {
  render(<App />); await act(async () => {});
  const hero = screen.getByTestId("rf__node-node-hero");
  fireEvent.click(document.querySelector(".react-flow__controls-interactive")!);
  expect(hero).not.toHaveClass("draggable");
  fireEvent.click(screen.getByRole("button", { name: "Pan canvas" }));
  fireEvent.click(screen.getByRole("button", { name: "Select" }));
  await waitFor(() => expect(hero).toHaveClass("draggable"));
  fireEvent.keyDown(hero, { key: "Enter" });
  await waitFor(() => expect(hero).toHaveClass("selected"));
});
