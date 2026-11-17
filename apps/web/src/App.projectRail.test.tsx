import { act, fireEvent, render, screen, within } from "@testing-library/react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { App } from "./App";
import * as workspaceState from "./app/shell/useWorkspaceState";
import { applyProjectLocale, tr } from "./localization/i18n";
import { useGraphStore } from "./state/graphStore";
import { createProjectFixtureRuntimeFetch, loadProjectFixturesForTests } from "./testFixtures/projectFixtures";

beforeEach(async () => {
  window.localStorage.clear();
  await applyProjectLocale("en");
  useGraphStore.setState(useGraphStore.getInitialState(), true);
  loadProjectFixturesForTests();
  vi.stubGlobal("fetch", createProjectFixtureRuntimeFetch());
});
afterEach(() => { vi.restoreAllMocks(); vi.unstubAllGlobals(); });

it.each(["en", "ru"] as const)("opens Engine Tags from the header independently of the project rail (%s)", async (locale) => {
  useGraphStore.setState(useGraphStore.getInitialState(), true);
  render(<App />);
  fireEvent.click(screen.getByRole("button", { name: "Open" }));
  fireEvent.click(await screen.findByRole("button", { name: /Project Aurora/ }));
  await screen.findByRole("banner");
  await act(async () => { await applyProjectLocale(locale); });
  const header = screen.getByRole("banner");
  const launcher = within(header).getByRole("button", { name: tr("engineTags.workspace") });
  expect(screen.getAllByRole("button", { name: tr("engineTags.workspace") })).toHaveLength(1);
  expect(launcher).toHaveClass("icon-button");
  expect(launcher.querySelector("svg")).toHaveClass("lucide-tags");
  expect(launcher.closest(".tooltip-wrapper")).toHaveAttribute("data-tooltip", tr("engineTags.workspace"));
  fireEvent.click(screen.getByTitle(tr("workspace.projects")));
  expect(document.querySelector("aside.absolute")).not.toBeInTheDocument();
  expect(launcher).toBeEnabled();
  fireEvent.click(launcher);
  expect(await screen.findByRole("heading", { name: tr("engineTags.workspace") })).toBeInTheDocument();
});

it("updates rail geometry without rerunning workspace graph computations or replacing node DOM", () => {
  render(<App />);
  const node = screen.getByTestId("rf__node-node-hero");
  const graph = useGraphStore.getState().getActiveGraph();
  const workspaceRender = vi.spyOn(workspaceState, "useWorkspaceState");
  const toggle = screen.getByTitle("Projects");
  toggle.focus();
  fireEvent.click(toggle);
  expect(document.querySelector("aside.absolute")).not.toBeInTheDocument();
  expect(document.querySelector(".react-flow")).not.toHaveClass("project-rail-open");
  expect(screen.getByRole("button", { name: "Pan canvas" }).closest("nav")).toHaveStyle({ left: "12px" });
  expect(workspaceRender).not.toHaveBeenCalled();
  fireEvent.click(toggle);
  expect(document.querySelector("aside.absolute")).toBeInTheDocument();
  expect(document.querySelector(".react-flow")).toHaveClass("project-rail-open");
  expect(screen.getByRole("button", { name: "Pan canvas" }).closest("nav")).toHaveStyle({ left: "276px" });
  expect(toggle).toHaveFocus();
  expect(workspaceRender).not.toHaveBeenCalled();
  expect(screen.getByTestId("rf__node-node-hero")).toBe(node);
  expect(useGraphStore.getState().getActiveGraph()).toBe(graph);
});

it("keeps rail-dependent filter and Story offsets live across modes and locale changes", async () => {
  render(<App />);
  fireEvent.click(screen.getByRole("button", { name: "Show graph filters" }));
  const filter = () => screen.getByLabelText("Search graph").closest("section");
  expect(filter()).toHaveStyle({ left: "344px" });
  fireEvent.click(screen.getByTitle("Projects"));
  expect(filter()).toHaveStyle({ left: "80px" });
  fireEvent.click(screen.getByRole("button", { name: "Flow" }));
  expect(document.querySelector(".flow-canvas")).not.toHaveClass("project-rail-open");
  fireEvent.click(screen.getByRole("button", { name: "Story" }));
  expect(document.querySelector(".story-document-workspace")).toHaveStyle({ left: "0px" });
  fireEvent.click(screen.getByTitle("Projects"));
  expect(document.querySelector(".story-document-workspace")).toHaveStyle({ left: "256px" });
  await act(async () => { await applyProjectLocale("ru"); });
  expect(screen.getByTitle(tr("workspace.projects"))).toBeInTheDocument();
  fireEvent.click(screen.getByTitle(tr("workspace.projects")));
  expect(document.querySelector(".story-document-workspace")).toHaveStyle({ left: "0px" });
  fireEvent.click(screen.getByRole("button", { name: tr("workspace.graph") }));
  expect(document.querySelector(".react-flow")).not.toHaveClass("project-rail-open");
});
