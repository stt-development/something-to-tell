import { fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { App } from "./App";
import { applyProjectLocale } from "./localization/i18n";
import { useGraphStore } from "./state/graphStore";
import { createProjectFixtureRuntimeFetch, loadProjectFixturesForTests } from "./testFixtures/projectFixtures";

beforeEach(async () => {
  window.localStorage.clear();
  await applyProjectLocale("en");
  useGraphStore.setState(useGraphStore.getInitialState(), true);
  loadProjectFixturesForTests();
  vi.stubGlobal("fetch", createProjectFixtureRuntimeFetch());
});
afterEach(() => { vi.unstubAllGlobals(); });

/** Exercise unchanged window/tool cancellation against the actual drawing stage. */
function start() {
  const view = render(<App />);
  const pane = view.container.querySelector(".react-flow__pane")!;
  fireEvent.click(screen.getByRole("button", { name: "Location Frame" }));
  fireEvent.mouseDown(pane, { button: 0, clientX: 400, clientY: 260 });
  fireEvent.mouseMove(pane, { buttons: 1, clientX: 450, clientY: 300 });
  expect(view.container.querySelector(".frame-draw-preview")).toBeInTheDocument();
  return { ...view, pane, initialCount: useGraphStore.getState().getActiveGraph().nodes.length };
}

it("cancels with Escape and never creates the cancelled frame on mouseup", () => {
  const view = start();
  fireEvent.keyDown(window, { key: "Escape" });
  fireEvent.mouseUp(view.pane);
  expect(view.container.querySelector(".frame-draw-preview")).not.toBeInTheDocument();
  expect(useGraphStore.getState().getActiveGraph().nodes).toHaveLength(view.initialCount);
});

it("cancels on a tool change and does not revive on later move/up", () => {
  const view = start();
  fireEvent.click(screen.getByRole("button", { name: "Select" }));
  fireEvent.mouseMove(view.pane, { buttons: 1, clientX: 650, clientY: 500 });
  fireEvent.mouseUp(view.pane);
  expect(view.container.querySelector(".frame-draw-preview")).not.toBeInTheDocument();
  expect(useGraphStore.getState().getActiveGraph().nodes).toHaveLength(view.initialCount);
});

it.each(["input", "textarea", "contenteditable"])("keeps the existing Escape editable-target guard for %s", (kind) => {
  const view = start();
  render(kind === "input" ? <input data-testid="editing" /> : kind === "textarea" ? <textarea data-testid="editing" /> : <div data-testid="editing" contentEditable />);
  fireEvent.keyDown(screen.getByTestId("editing"), { key: "Escape" });
  expect(view.container.querySelector(".frame-draw-preview")).toBeInTheDocument();
  fireEvent.mouseUp(view.pane);
  expect(useGraphStore.getState().getActiveGraph().nodes).toHaveLength(view.initialCount + 1);
});

it("preserves blur behavior: clearing Space Pan does not cancel an active frame", () => {
  const view = start();
  fireEvent.keyDown(window, { code: "Space" });
  fireEvent.blur(window);
  expect(view.container.querySelector(".frame-draw-preview")).toBeInTheDocument();
  fireEvent.mouseUp(view.pane);
  expect(useGraphStore.getState().getActiveGraph().nodes).toHaveLength(view.initialCount + 1);
});
