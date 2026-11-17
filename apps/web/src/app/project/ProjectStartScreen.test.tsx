import { Profiler } from "react";
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { applyProjectLocale } from "../../localization/i18n";
import { createRuntimeApiClient, projectSessionToGraphSnapshot } from "../../runtime/apiClient";
import { useGraphStore } from "../../state/graphStore";
import { createProjectFixtureRuntimeFetch, projectFixture } from "../../testFixtures/projectFixtures";
import { ProjectStartScreen } from "./ProjectStartScreen";

/** Counts actual startup subtree commits, without mocking its store subscription. */
function renderStartup() {
  const onRender = vi.fn();
  render(<Profiler id="startup" onRender={onRender}><ProjectStartScreen /></Profiler>);
  return onRender;
}

describe("startup action subscriptions", () => {
  beforeEach(async () => {
    window.localStorage.clear();
    await applyProjectLocale("en");
    useGraphStore.setState(useGraphStore.getInitialState(), true);
    vi.stubGlobal("fetch", createProjectFixtureRuntimeFetch());
  });

  afterEach(() => {
    cleanup();
    useGraphStore.setState(useGraphStore.getInitialState(), true);
    vi.unstubAllGlobals();
  });

  it("ignores graph, transport, session, selection and diagnostic publications", async () => {
    const commits = renderStartup();
    fireEvent.click(screen.getByRole("button", { name: "Open" }));
    await waitFor(() => expect(screen.getByLabelText("Projects directory"))
      .toHaveValue("/home/author/.narrative"));
    const initialCommits = commits.mock.calls.length;
    const { response } = projectFixture("aurora");
    const graph = projectSessionToGraphSnapshot(response);

    // Separate updates would each notify a whole-store subscriber.
    act(() => useGraphStore.getState().setRuntimePersistence(createRuntimeApiClient()));
    act(() => useGraphStore.getState().setRuntimePersistence(null));
    act(() => useGraphStore.setState({ graphs: {
      [response.session.project_id]: { nodes: graph.nodes, edges: graph.edges, issues: graph.issues }
    } }));
    act(() => useGraphStore.getState().setProjectSessionState(response.session));
    act(() => useGraphStore.getState().selectItem({ type: "node", id: graph.nodes[0]!.id }));
    act(() => useGraphStore.setState({ runtimeStatus: "fallback", runtimeError: "offline" }));

    expect(commits.mock.calls.length).toBe(initialCommits);
    expect(screen.getByRole("heading", { name: "Open project" })).toBeInTheDocument();
    expect(screen.getByLabelText("Projects directory")).toHaveValue("/home/author/.narrative");
  });

  it("preserves the local Create draft across project reset without another commit", async () => {
    const commits = renderStartup();
    fireEvent.click(screen.getByRole("button", { name: "Create" }));
    await waitFor(() => expect(screen.getByLabelText("Parent directory"))
      .toHaveValue("/home/author/.narrative"));
    fireEvent.change(screen.getByLabelText("Name"), { target: { value: "New story" } });
    const initialCommits = commits.mock.calls.length;

    act(() => useGraphStore.getState().closeActiveProject());

    expect(commits.mock.calls.length).toBe(initialCommits);
    expect(screen.getByLabelText("Name")).toHaveValue("New story");
    expect(screen.getByRole("heading", { name: "Create project" })).toBeInTheDocument();
  });

  it("observes a replaced session-entry action and uses it when opening a project", async () => {
    const commits = renderStartup();
    fireEvent.click(screen.getByRole("button", { name: "Open" }));
    const project = await screen.findByRole("button", { name: /Project Aurora/ });
    const initialCommits = commits.mock.calls.length;
    const attachProjectSession = vi.fn(useGraphStore.getState().attachProjectSession);
    act(() => useGraphStore.setState({ attachProjectSession }));
    expect(commits.mock.calls.length).toBe(initialCommits + 1);

    fireEvent.click(project);

    await waitFor(() => expect(attachProjectSession).toHaveBeenCalledOnce());
    expect(useGraphStore.getState().activeProjectId).toBe("project-aurora");
    expect(useGraphStore.getState().activeSessionId).toBe(attachProjectSession.mock.calls[0]![0]);
    expect(useGraphStore.getState().getActiveGraph().nodes.length).toBeGreaterThan(0);
  });
});
