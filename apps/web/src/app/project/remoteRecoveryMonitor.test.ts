import { expect, it, vi } from "vitest";
import type { RemoteStorageHeadV1 } from "@something-to-tell/contracts/remote-storage";
import samples from "../../../../../services/runtime/tests/fixtures/remote_storage_v1.json";
import { createRemoteRecoveryMonitor } from "./remoteRecoveryMonitor";

it("publishes only matching immutable observations and never changes the source guard", () => {
  const head = samples.head as RemoteStorageHeadV1;
  const monitor = createRemoteRecoveryMonitor("source", head, () => true), listener = vi.fn();
  const stop = monitor.subscribe(listener);
  const value = { sessionId: "source", head, blocked: true, errorCode: "remote_commit_unknown", unresolvedCommandId: samples.guard.command_id };
  const initial = monitor.getSnapshot();
  for (const foreign of [{ ...value, sessionId: "foreign" }, { ...value, head: { ...head, project_id: "foreign" } },
    { ...value, head: { ...head, storage_generation: "foreign" } }]) monitor.observe(foreign);
  expect(monitor.getSnapshot()).toBe(initial); expect(listener).not.toHaveBeenCalled();
  monitor.observe(value);
  expect(listener).toHaveBeenCalledOnce(); expect(monitor.getSnapshot()).toEqual(value);
  expect(monitor.getSnapshot()).not.toBe(value); expect(Object.isFrozen(monitor.getSnapshot().head)).toBe(true);
  expect(head).toEqual(samples.head);
  stop(); monitor.observe(value); expect(listener).toHaveBeenCalledOnce();
});

it("rejects callbacks after scope retirement and supports StrictMode mount rehearsal", () => {
  let current = true;
  const head = samples.head as RemoteStorageHeadV1;
  const monitor = createRemoteRecoveryMonitor("source", head, () => current), initial = monitor.getSnapshot();
  const value = { ...initial, blocked: true };
  monitor.setMounted(false); monitor.observe(value); expect(monitor.getSnapshot()).toBe(initial);
  monitor.setMounted(true); monitor.observe(value); expect(monitor.getSnapshot().blocked).toBe(true);
  const accepted = monitor.getSnapshot(); current = false;
  monitor.observe({ ...value, errorCode: "remote_auth_failed" }); expect(monitor.getSnapshot()).toBe(accepted);
});
