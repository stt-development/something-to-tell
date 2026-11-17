import { beforeEach, expect, it } from "vitest";
import type { RuntimeGraphSnapshot } from "../runtime/apiTypes";
import { projectSessionToGraphSnapshot } from "../runtime/projections";
import { projectFixture } from "../testFixtures/projectFixtures";
import { useGraphStore } from "./graphStore";

const snapshot = (name: "aurora" | "citadel") => projectSessionToGraphSnapshot(projectFixture(name).response);
function deferred() {
  let resolve!: (value: RuntimeGraphSnapshot) => void, reject!: (error: Error) => void;
  const promise = new Promise<RuntimeGraphSnapshot>((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}
beforeEach(() => { useGraphStore.getState().closeActiveProject(); useGraphStore.setState(useGraphStore.getInitialState(), true); });

it("publishes identity, session, manifest, graph and flows in one coherent installation", async () => {
  const value = snapshot("aurora"), observed: ReturnType<typeof useGraphStore.getState>[] = [];
  const unsubscribe = useGraphStore.subscribe((state) => observed.push(state));
  try { expect(await useGraphStore.getState().loadRuntimeSnapshot(async () => value)).toBe(true); } finally { unsubscribe(); }
  const ready = observed.filter((state) => state.runtimeStatus === "ready"); expect(ready).toHaveLength(1);
  expect(ready[0]).toMatchObject({ activeProjectId: value.activeProjectId, activeSessionId: value.activeSessionId,
    activeProjectManifest: value.manifest, activeProjectSession: value.projectSession });
  expect(ready[0]!.graphs[value.activeProjectId]!.nodes).toBe(value.nodes);
  expect(ready[0]!.storyFlowsByProject[value.activeProjectId]).toBe(value.storyFlows);
});
it.each(["success", "failure"])("close retires delayed %s even from an initially empty workspace", async (outcome) => {
  const response = deferred(), load = useGraphStore.getState().loadRuntimeSnapshot(() => response.promise);
  expect(useGraphStore.getState().runtimeStatus).toBe("loading"); useGraphStore.getState().closeActiveProject();
  if (outcome === "success") response.resolve(snapshot("aurora")); else response.reject(Error("obsolete"));
  expect(await load).toBe(false); expect(useGraphStore.getState()).toMatchObject({ activeProjectId: "", activeSessionId: null,
    projects: [], graphs: {}, runtimeStatus: "idle", runtimeError: null });
});
it.each(["success", "failure"])("newer installation rejects older %s without changing current data or feedback", async (outcome) => {
  const first = deferred(), old = useGraphStore.getState().loadRuntimeSnapshot(() => first.promise);
  const current = snapshot("citadel"); expect(await useGraphStore.getState().loadRuntimeSnapshot(async () => current)).toBe(true);
  const state = useGraphStore.getState();
  if (outcome === "success") first.resolve(snapshot("aurora")); else first.reject(Error("obsolete"));
  expect(await old).toBe(false); expect(useGraphStore.getState()).toBe(state);
});
it("retiring an older completion cannot clear a newer pending load", async () => {
  const first = deferred(), second = deferred();
  const old = useGraphStore.getState().loadRuntimeSnapshot(() => first.promise);
  const latest = useGraphStore.getState().loadRuntimeSnapshot(() => second.promise);
  first.resolve(snapshot("aurora")); expect(await old).toBe(false); expect(useGraphStore.getState().runtimeStatus).toBe("loading");
  second.resolve(snapshot("citadel")); expect(await latest).toBe(true); expect(useGraphStore.getState().runtimeStatus).toBe("ready");
});
it("project ABA changes invalidate the ticket rather than treating matching final ids as unchanged", async () => {
  const response = deferred(), load = useGraphStore.getState().loadRuntimeSnapshot(() => response.promise);
  useGraphStore.getState().setActiveProject("other"); useGraphStore.getState().setActiveProject("");
  expect(useGraphStore.getState().runtimeStatus).toBe("idle");
  const current = useGraphStore.getState(); response.resolve(snapshot("aurora"));
  expect(await load).toBe(false); expect(useGraphStore.getState()).toBe(current);
});
it.each(["attach", "session-state"])("session identity change via %s invalidates the ticket", async (action) => {
  const response = deferred(), load = useGraphStore.getState().loadRuntimeSnapshot(() => response.promise);
  if (action === "attach") useGraphStore.getState().attachProjectSession("new-session");
  else useGraphStore.getState().setProjectSessionState(projectFixture("citadel").response.session);
  expect(useGraphStore.getState().runtimeStatus).toBe("idle");
  const current = useGraphStore.getState(); response.resolve(snapshot("aurora"));
  expect(await load).toBe(false); expect(useGraphStore.getState()).toBe(current);
});
it("passes a live read-only predicate into the loader and retains current failure semantics", async () => {
  let current!: () => boolean; const response = deferred();
  const load = useGraphStore.getState().loadRuntimeSnapshot((isCurrent) => { current = isCurrent; return response.promise; });
  expect(current()).toBe(true); useGraphStore.getState().closeActiveProject(); expect(current()).toBe(false);
  response.reject(Error("obsolete")); expect(await load).toBe(false);
  expect(await useGraphStore.getState().loadRuntimeSnapshot(async () => { throw Error("current error"); })).toBe(false);
  expect(useGraphStore.getState()).toMatchObject({ runtimeStatus: "fallback", runtimeError: "current error" });
});
it("empty snapshots remain rejected without inventing a partial project", async () => {
  expect(await useGraphStore.getState().loadRuntimeSnapshot(async () => ({ ...snapshot("aurora"), activeProjectId: "" }))).toBe(false);
  expect(useGraphStore.getState()).toMatchObject({ activeProjectId: "", graphs: {}, runtimeStatus: "fallback" });
});

it("same-session status updates keep a valid load current and retire pending UI only on identity changes", async () => {
  const value = snapshot("aurora"); await useGraphStore.getState().loadRuntimeSnapshot(async () => value);
  let current!: () => boolean; const response = deferred();
  const load = useGraphStore.getState().loadRuntimeSnapshot((isCurrent) => { current = isCurrent; return response.promise; });
  useGraphStore.getState().setProjectSessionState({ ...value.projectSession!, save_status: "saving" });
  expect(current()).toBe(true); expect(useGraphStore.getState().runtimeStatus).toBe("loading");
  response.resolve(value); expect(await load).toBe(true);
  const second = deferred(), pending = useGraphStore.getState().loadRuntimeSnapshot(() => second.promise);
  useGraphStore.getState().attachProjectSession("different"); expect(useGraphStore.getState().runtimeStatus).toBe("ready");
  expect(useGraphStore.getState().graphs[value.activeProjectId]!.nodes).toBe(value.nodes);
  second.resolve(snapshot("citadel")); expect(await pending).toBe(false);
});
