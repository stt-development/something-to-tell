import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { App } from "./App";
import { applyProjectLocale } from "./localization/i18n";
import { useGraphStore } from "./state/graphStore";
import { createProjectFixtureRuntimeFetch, loadProjectFixturesForTests } from "./testFixtures/projectFixtures";
import { TARGET_SELECTABLE_EXPERIMENT_ENABLED } from "./app/graph/CanvasSelectableReactFlow";
import { STABLE_TOOL_INTERACTION_EXPERIMENT_ENABLED } from "./app/graph/canvasToolInteraction";

// Exercise ordinary release defaults without mocking either interaction gate.
beforeEach(async () => {
  localStorage.clear(); await applyProjectLocale("en");
  useGraphStore.setState(useGraphStore.getInitialState(), true); loadProjectFixturesForTests();
  vi.stubGlobal("fetch", createProjectFixtureRuntimeFetch());
});
afterEach(() => vi.unstubAllGlobals());

it("retains real Enter/Space/Arrow/creation semantics and immediate Escape/Enter restoration", async () => {
  expect(STABLE_TOOL_INTERACTION_EXPERIMENT_ENABLED).toBe(true);
  expect(TARGET_SELECTABLE_EXPERIMENT_ENABLED).toBe(true);
  render(<App />); await act(async () => {});
  const hero = screen.getByTestId("rf__node-node-hero");
  fireEvent.keyDown(hero, { key: "Enter" }); fireEvent.keyUp(hero, { key: "Enter" });
  expect(hero).toHaveClass("selected");
  fireEvent.click(screen.getByRole("button", { name: "Pan canvas" }));
  const before = useGraphStore.getState().getActiveGraph().nodes;
  for (const key of ["Enter", " ", "ArrowRight", "ArrowDown", "Delete", "Backspace"]) {
    fireEvent.keyDown(hero, { key, code: key === " " ? "Space" : key });
    fireEvent.keyUp(hero, { key, code: key === " " ? "Space" : key });
    expect(hero).not.toHaveClass("selected");
  }
  expect(useGraphStore.getState().getActiveGraph().nodes).toBe(before);
  fireEvent.keyDown(hero, { key: "Escape" }); fireEvent.keyUp(hero, { key: "Escape" });
  fireEvent.keyDown(hero, { key: "Enter" });
  await waitFor(() => expect(hero).toHaveClass("selected"));
  fireEvent.keyDown(hero, { key: "Escape" });
  fireEvent.click(screen.getByRole("button", { name: "Lore" }));
  fireEvent.keyDown(hero, { key: "Enter" });
  expect(hero).not.toHaveClass("selected");
  fireEvent.keyDown(hero, { key: "Escape" });
  fireEvent.keyDown(hero, { key: "Enter" });
  await waitFor(() => expect(hero).toHaveClass("selected"));
});

it("preserves native Controls lock reset with stable global selectable", async () => {
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
