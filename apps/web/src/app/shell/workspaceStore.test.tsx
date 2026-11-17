import { act, cleanup, render, renderHook, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createRuntimeApiClient, projectSessionToGraphSnapshot } from "../../runtime/apiClient";
import { useGraphStore } from "../../state/graphStore";
import { loadProjectFixturesForTests, projectFixture } from "../../testFixtures/projectFixtures";
import { selectWorkspaceSession, useWorkspaceStore } from "./workspaceStore";
import { ProjectSaveError } from "./ProjectSaveError";

function observeWorkspace() {
  let renders = 0;
  const hook = renderHook(() => {
    renders += 1;
    return useWorkspaceStore();
  });
  return { ...hook, renders: () => renders };
}

describe("workspace store subscription", () => {
  beforeEach(() => {
    useGraphStore.setState(useGraphStore.getInitialState(), true);
    loadProjectFixturesForTests();
  });

  afterEach(() => {
    cleanup();
    useGraphStore.setState(useGraphStore.getInitialState(), true);
  });

  it("avoids whole-workspace renders for transport and inactive graph publications", () => {
    const workspace = observeWorkspace();
    let broadRenders = 0;
    renderHook(() => {
      broadRenders += 1;
      return useGraphStore();
    });
    const initial = workspace.result.current;

    // Independent publications model client replacement and background hydration.
    act(() => useGraphStore.getState().setRuntimePersistence(createRuntimeApiClient()));
    act(() => useGraphStore.getState().setRuntimePersistence(null));
    act(() => useGraphStore.setState((state) => ({
      graphs: {
        ...state.graphs,
        "project-citadel": { nodes: [], edges: [], issues: [] }
      }
    })));

    expect(broadRenders).toBe(4);
    expect(workspace.renders()).toBe(1);
    expect(workspace.result.current).toBe(initial);
  });

  it("subscribes to optimistic active graph updates without replacing actions", () => {
    const workspace = observeWorkspace();
    const initial = workspace.result.current;
    const node = initial.activeGraph!.nodes[0]!;
    act(() => initial.onNodesChange([
      { type: "position", id: node.id, position: { x: 1234, y: 5678 } }
    ]));

    expect(workspace.renders()).toBe(2);
    expect(workspace.result.current.activeGraph).not.toBe(initial.activeGraph);
    expect(workspace.result.current.activeGraph!.nodes.find((entry) => entry.id === node.id)?.position)
      .toEqual({ x: 1234, y: 5678 });
    expect(workspace.result.current.onNodesChange).toBe(initial.onNodesChange);
    expect(workspace.result.current.getActiveGraph()).toBe(workspace.result.current.activeGraph);
  });

  it.each(["nodes", "edges", "issues"] as const)("observes active graph %s replacement", (field) => {
    const workspace = observeWorkspace();
    const originalGraph = workspace.result.current.activeGraph!;
    const replacement = { ...originalGraph, [field]: [...originalGraph[field]] };
    act(() => useGraphStore.setState((state) => ({
      graphs: { ...state.graphs, [state.activeProjectId]: replacement }
    })));

    expect(workspace.renders()).toBe(2);
    expect(workspace.result.current.activeGraph).toBe(replacement);
  });

  it("keeps selection updates reactive without copying graph data", () => {
    const workspace = observeWorkspace();
    const graph = workspace.result.current.activeGraph!;
    const selection = { type: "node" as const, id: graph.nodes[0]!.id };
    act(() => workspace.result.current.selectItem(selection));
    expect(workspace.renders()).toBe(2);
    expect(workspace.result.current.selection).toEqual(selection);
    expect(workspace.result.current.activeGraph).toBe(graph);
  });

  it("observes session, manifest locale and runtime diagnostics publications", () => {
    const workspace = observeWorkspace();
    const { response } = projectFixture("aurora");
    act(() => workspace.result.current.setProjectSessionState(response.session));
    expect(workspace.result.current.activeSessionId).toBe(response.session.session_id);
    expect(workspace.result.current.activeProjectSession).toEqual(selectWorkspaceSession(useGraphStore.getState()));
    expect(workspace.result.current.activeProjectSession).not.toHaveProperty("save_error");
    expect(workspace.result.current.activeProjectSession).not.toHaveProperty("save_status");
    const manifest = {
      ...response.document.manifest,
      settings: { ...response.document.manifest.settings, ui_locale: "ru" as const }
    };
    act(() => useGraphStore.setState({ activeProjectManifest: manifest }));
    expect(workspace.result.current.activeProjectManifest?.settings.ui_locale).toBe("ru");
    act(() => useGraphStore.setState({ runtimeStatus: "fallback", runtimeError: "offline" }));
    expect(workspace.result.current.runtimeError).toBe("offline");
    expect(workspace.result.current.runtimeStatus).toBe("fallback");
    expect(workspace.renders()).toBe(4);
  });

  it("tracks project switching, snapshot hydration and close without stale graph data", async () => {
    const workspace = observeWorkspace();
    const { activeProjectId, graphs } = useGraphStore.getState();
    const otherId = Object.keys(graphs).find((id) => id !== activeProjectId)!;
    act(() => useGraphStore.getState().setActiveProject(otherId));
    expect(workspace.result.current.activeGraph).toBe(graphs[otherId]);
    const snapshot = projectSessionToGraphSnapshot(projectFixture("aurora").response);
    await act(async () => { await workspace.result.current.loadRuntimeSnapshot(async () => snapshot); });
    expect(workspace.result.current.activeProjectId).toBe(activeProjectId);
    expect(workspace.result.current.activeGraph?.nodes).toEqual(snapshot.nodes);
    act(() => workspace.result.current.closeActiveProject());
    expect(workspace.result.current.activeProjectId).toBe("");
    expect(workspace.result.current.activeGraph).toBeUndefined();
    expect(workspace.result.current.selection).toBeNull();
    expect(workspace.result.current.getActiveGraph()).toEqual({ nodes: [], edges: [], issues: [] });
    expect(workspace.renders()).toBe(4);
  });

  it("updates and clears canonical error prose without rendering workspace", () => {
    const { response } = projectFixture("aurora");
    useGraphStore.getState().setProjectSessionState({ ...response.session, save_status: "error", save_error: "First error" });
    const workspace = observeWorkspace();
    const initial = workspace.result.current;
    render(<ProjectSaveError />);
    expect(screen.getByRole("alert")).toHaveTextContent("First error");
    for (const save_error of ["More specific error", null]) {
      act(() => useGraphStore.getState().setProjectSessionState({
        ...useGraphStore.getState().activeProjectSession!, save_error
      }));
      expect(workspace.renders()).toBe(1);
      expect(workspace.result.current).toBe(initial);
      expect(useGraphStore.getState().activeProjectSession?.save_error).toBe(save_error);
      if (save_error) expect(screen.getByRole("alert")).toHaveTextContent(save_error);
      else expect(screen.queryByRole("alert")).not.toBeInTheDocument();
    }
  });

  it("keeps revisions and replacement sessions reactive while the error leaf follows Close", () => {
    const { response } = projectFixture("aurora");
    useGraphStore.getState().setProjectSessionState(response.session);
    const workspace = observeWorkspace();
    const original = workspace.result.current.activeProjectSession;
    render(<ProjectSaveError />);
    act(() => useGraphStore.getState().setProjectSessionState({
      ...response.session, saved_revision: response.session.saved_revision + 1, save_error: "Revision error"
    }));
    expect(workspace.renders()).toBe(2);
    expect(workspace.result.current.activeProjectSession).not.toBe(original);
    expect(workspace.result.current.activeProjectSession?.saved_revision).toBe(response.session.saved_revision + 1);
    const replacement = projectFixture("citadel").response.session;
    act(() => useGraphStore.getState().setProjectSessionState({ ...replacement, save_error: "Other session error" }));
    expect(workspace.renders()).toBe(3);
    expect(workspace.result.current.activeSessionId).toBe(replacement.session_id);
    expect(screen.getByRole("alert")).toHaveTextContent("Other session error");
    act(() => useGraphStore.getState().closeActiveProject());
    expect(workspace.renders()).toBe(4);
    expect(workspace.result.current.activeProjectSession).toBeNull();
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
  });
});
