import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { App } from "./App";
import { applyProjectLocale } from "./localization/i18n";
import { useGraphStore } from "./state/graphStore";
import { createProjectFixtureRuntimeFetch, loadProjectFixturesForTests } from "./testFixtures/projectFixtures";

beforeEach(async () => {
  localStorage.clear(); await applyProjectLocale("en");
  useGraphStore.setState(useGraphStore.getInitialState(), true);
  vi.stubGlobal("fetch", vi.fn(createProjectFixtureRuntimeFetch()));
});
afterEach(() => { vi.restoreAllMocks(); vi.unstubAllGlobals(); });

it("opens categorized help without a project, keeps article identity across locale and restores focus", async () => {
  render(<App />);
  const start = screen.getByTestId("empty-project-start");
  const launcher = within(start).getByRole("button", { name: "Open user guides" });
  const state = useGraphStore.getState();
  fireEvent.click(launcher);
  const dialog = await screen.findByRole("dialog", { name: "User guides" });
  expect(screen.getByRole("button", { name: "Close user guides" })).toHaveFocus();
  expect(start.closest("main")!.closest("[inert]")).not.toBeNull();
  fireEvent.click(await within(dialog).findByRole("button", { name: /^Your first story/ }));
  await within(dialog).findByRole("heading", { name: "Your first story" });
  expect(within(dialog).getByRole("navigation", { name: "On this page" })).toBeInTheDocument();
  await act(async () => { await applyProjectLocale("ru"); });
  await screen.findByRole("heading", { name: "Первая история" });
  expect(screen.getByRole("dialog", { name: "Руководства пользователя" })).toBe(dialog);
  fireEvent.keyDown(dialog, { key: "Escape" });
  expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
  expect(launcher).toHaveFocus();
  expect(document.querySelector("[inert]")).toBeNull();
  expect(useGraphStore.getState()).toBe(state);
});

it("keeps graph/history unchanged and blocks background edit shortcuts while searching help", async () => {
  loadProjectFixturesForTests();
  render(<App />);
  const graph = useGraphStore.getState().getActiveGraph();
  const selection = useGraphStore.getState().selection;
  const launcher = screen.getByRole("button", { name: "Open user guides" });
  expect(launcher.closest("header")).not.toBeNull();
  expect(launcher.closest(".tooltip-wrapper")).toHaveAttribute("data-tooltip", "Open user guides");
  fireEvent.click(launcher);
  const dialog = await screen.findByRole("dialog", { name: "User guides" });
  const search = await within(dialog).findByRole("textbox", { name: "Search guides" });
  fireEvent.change(search, { target: { value: "guard agrees" } });
  await within(dialog).findByRole("button", { name: /^Conditions and effects/ });
  expect(within(dialog).queryByRole("button", { name: /^Projects and saving/ })).not.toBeInTheDocument();
  fireEvent.keyDown(search, { key: "Delete" });
  fireEvent.keyDown(search, { key: "z", ctrlKey: true });
  fireEvent.keyDown(document.body, { key: "Delete" });
  expect(useGraphStore.getState().getActiveGraph()).toBe(graph);
  expect(useGraphStore.getState().selection).toBe(selection);
  expect(vi.mocked(fetch).mock.calls.some(([input]) => /\/(save|undo|redo)$/.test(String(input)))).toBe(false);
  fireEvent.change(search, { target: { value: "no-such-topic-zz" } });
  await within(dialog).findByText("No guides match your search.");
  fireEvent.click(within(dialog).getByRole("button", { name: "Close user guides" }));
  await waitFor(() => expect(launcher).toHaveFocus());
});
