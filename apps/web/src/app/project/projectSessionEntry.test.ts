import { beforeEach, expect, it, vi } from "vitest";
import { useGraphStore } from "../../state/graphStore";
import { projectFixture } from "../../testFixtures/projectFixtures";
import { RuntimeApiError } from "../../runtime/transport";
import { closeAcquiredSession, enterProjectSession, ProjectEntryReleaseError } from "./projectSessionEntry";

beforeEach(() => { useGraphStore.getState().closeActiveProject(); useGraphStore.setState(useGraphStore.getInitialState(), true); });
const fixture = () => projectFixture("aurora").response;
function setup() {
  const close = vi.fn(async (_id: string) => {});
  return { close, loadSnapshot: useGraphStore.getState().loadRuntimeSnapshot, activeSessionId: () => useGraphStore.getState().activeSessionId };
}
it("enters the guard before acquisition and publishes one complete accepted session", async () => {
  const response = fixture(), options = setup();
  const result = await enterProjectSession({ ...options, acquire: async ({ isCurrent }) => {
    expect(useGraphStore.getState().runtimeStatus).toBe("loading"); expect(isCurrent()).toBe(true); return response;
  } });
  expect(result).toBe(response); expect(options.close).not.toHaveBeenCalled();
  expect(useGraphStore.getState().activeSessionId).toBe(response.session.session_id);
});
it("Close during acquisition rejects and releases only the newly acquired session", async () => {
  const options = setup(), response = fixture(), beforeInstall = vi.fn();
  const result = await enterProjectSession({ ...options, beforeInstall, acquire: async () => { useGraphStore.getState().closeActiveProject(); return response; } });
  expect(result).toBeNull(); expect(options.close).toHaveBeenCalledTimes(1); expect(options.close).toHaveBeenCalledWith(response.session.session_id);
  expect(beforeInstall).not.toHaveBeenCalled(); expect(useGraphStore.getState().activeProjectId).toBe("");
});
it("retains ownership when setup fails after Create and preserves the original error after release", async () => {
  const options = setup(), response = fixture(), failure = Error("storage setup failed");
  await expect(enterProjectSession({ ...options, acquire: async ({ retain }) => { retain(response); throw failure; } })).rejects.toBe(failure);
  expect(options.close).toHaveBeenCalledTimes(1); expect(options.close).toHaveBeenCalledWith(response.session.session_id); expect(useGraphStore.getState().activeSessionId).toBeNull();
});
it("never installs after a predecessor-close failure and releases the new acquisition", async () => {
  const options = setup(), failure = Error("predecessor is dirty"), response = fixture();
  await expect(enterProjectSession({ ...options, acquire: async () => response, beforeInstall: async () => { throw failure; } })).rejects.toBe(failure);
  expect(options.close).toHaveBeenCalledOnce(); expect(useGraphStore.getState().activeSessionId).toBeNull();
});
it("does not close a rejected session if it is already the current adopted session", async () => {
  const options = setup(), response = fixture();
  const result = await enterProjectSession({ ...options, acquire: async () => {
    useGraphStore.getState().attachProjectSession(response.session.session_id); return response;
  } });
  expect(result).toBeNull(); expect(options.close).not.toHaveBeenCalled();
  expect(useGraphStore.getState().activeSessionId).toBe(response.session.session_id);
});
it("cleanup failure propagates actionable ownership metadata instead of forcing save/discard or hiding it", async () => {
  const options = setup(), response = fixture(), failure = Error("connection lost"); options.close.mockRejectedValue(failure);
  const result = enterProjectSession({ ...options, acquire: async () => { useGraphStore.getState().closeActiveProject(); return response; } });
  await expect(result).rejects.toBeInstanceOf(ProjectEntryReleaseError);
  await expect(result).rejects.toMatchObject({ sessionId: response.session.session_id, projectName: response.document.manifest.name, releaseError: failure });
  expect(useGraphStore.getState().activeProjectId).toBe("");
});
it("keeps cleanup identity even when a rejected candidate document is malformed", async () => {
  const options = setup(), response = fixture();
  options.close.mockRejectedValue(Error("cleanup unavailable"));
  const malformed = { ...response, document: null } as unknown as typeof response;
  await expect(enterProjectSession({ ...options, acquire: async () => malformed })).rejects.toMatchObject({
    sessionId: response.session.session_id, projectName: response.session.project_id
  });
});
it("only authoritative 404/not-found counts as already released", async () => {
  await expect(closeAcquiredSession(async () => { throw new RuntimeApiError("gone", "project_session_not_found", 404); }, "owned")).resolves.toBeUndefined();
  for (const error of [Error("offline"), new RuntimeApiError("dirty", "project_unsaved_changes", 409), new RuntimeApiError("bad", "other", 404)]) {
    await expect(closeAcquiredSession(async () => { throw error; }, "owned")).rejects.toBe(error);
  }
});

it.each(["success", "failure"])("newer entry survives an obsolete acquisition %s", async (outcome) => {
  const options = setup(), response = fixture();
  let resolve!: (value: typeof response) => void, reject!: (error: Error) => void;
  const pending = new Promise<typeof response>((yes, no) => { resolve = yes; reject = no; });
  const stale = enterProjectSession({ ...options, acquire: () => pending });
  const current = projectFixture("citadel").response;
  expect(await enterProjectSession({ ...options, acquire: async () => current })).toBe(current);
  if (outcome === "success") resolve(response); else reject(Error("obsolete failure"));
  expect(await stale).toBeNull(); expect(useGraphStore.getState().activeSessionId).toBe(current.session.session_id);
  if (outcome === "success") expect(options.close).toHaveBeenCalledWith(response.session.session_id);
  else expect(options.close).not.toHaveBeenCalled();
});
