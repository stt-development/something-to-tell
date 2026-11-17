import { expect, it, vi } from "vitest";
import type { EngineTagMutationCommandV1, EngineTagMutationResponseV1 } from "@something-to-tell/contracts/engine-tags";
import { createEngineTagRuntimeClient } from "./engineTagClient";

const response = (revision = 1): EngineTagMutationResponseV1 => ({ response_version: 1,
  catalog: { catalog_version: 1, project_id: "project", definitions: [], bindings: [], legacy_count: 0 },
  source_checksum: String(revision).repeat(64), history_revision: revision });
const command: EngineTagMutationCommandV1 = { command_version: 1, command_id: "command", action: "archive_definition", definition_id: "tag",
  expected_source_checksum: "a".repeat(64), expected_history_revision: 1 };
function deferred<T>() {
  let resolve!: (value: T) => void, reject!: (error: Error) => void;
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}
const transport = () => ({ getJson: vi.fn(), sendJson: vi.fn(), requestJson: vi.fn(), requestJsonWithTimeout: vi.fn(), deleteJson: vi.fn(), deleteResource: vi.fn() });

it("shares 200 overlapping validated reads per session and fetches fresh after settlement", async () => {
  const io = transport(), pending = deferred<unknown>(), value = response(); io.getJson.mockReturnValue(pending.promise);
  const client = createEngineTagRuntimeClient(io);
  const reads = Array.from({ length: 200 }, () => client.loadEngineTagRegistry("session/one"));
  pending.resolve(value); (await Promise.all(reads)).forEach((item) => expect(item).toBe(value));
  expect(io.getJson).toHaveBeenCalledTimes(1);
  expect(io.getJson).toHaveBeenCalledWith("/engine-tags/registry?session_id=session%2Fone");
  io.getJson.mockResolvedValueOnce(response(2)); expect((await client.loadEngineTagRegistry("session/one")).history_revision).toBe(2);
  expect(io.getJson).toHaveBeenCalledTimes(2);
});

it("isolates concurrent sessions and independent clients even with the same transport", async () => {
  const io = transport(), pending = deferred<unknown>(); io.getJson.mockReturnValue(pending.promise);
  const first = createEngineTagRuntimeClient(io), second = createEngineTagRuntimeClient(io);
  const reads = [first.loadEngineTagRegistry("one"), first.loadEngineTagRegistry("two"), second.loadEngineTagRegistry("one")];
  expect(io.getJson).toHaveBeenCalledTimes(3); pending.resolve(response()); await Promise.all(reads);
});

it("releases shared errors and malformed responses so retries are not poisoned", async () => {
  const io = transport(), pending = deferred<unknown>(), error = new Error("offline"); io.getJson.mockReturnValue(pending.promise);
  const client = createEngineTagRuntimeClient(io);
  const results = Promise.allSettled([client.loadEngineTagRegistry("one"), client.loadEngineTagRegistry("one")]);
  pending.reject(error); (await results).forEach((item) => expect(item).toMatchObject({ status: "rejected", reason: error }));
  io.getJson.mockResolvedValueOnce({}); await expect(client.loadEngineTagRegistry("one")).rejects.toThrow("Invalid engine tag registry response");
  io.getJson.mockResolvedValueOnce(response()); await expect(client.loadEngineTagRegistry("one")).resolves.toMatchObject({ history_revision: 1 });
  expect(io.getJson).toHaveBeenCalledTimes(3);
});

it("retires pending reuse at both command boundaries without cancelling original waiters", async () => {
  const io = transport(), before = deferred<unknown>(), during = deferred<unknown>(), after = deferred<unknown>(), write = deferred<unknown>();
  io.getJson.mockReturnValueOnce(before.promise).mockReturnValueOnce(during.promise).mockReturnValueOnce(after.promise).mockReturnValue(after.promise);
  io.sendJson.mockReturnValue(write.promise); const client = createEngineTagRuntimeClient(io);
  const oldRead = client.loadEngineTagRegistry("one"), mutation = client.applyEngineTagCommand(command);
  const duringRead = client.loadEngineTagRegistry("one"); expect(io.getJson).toHaveBeenCalledTimes(2);
  write.resolve(response(2)); await mutation;
  const freshRead = client.loadEngineTagRegistry("one"); expect(io.getJson).toHaveBeenCalledTimes(3);
  before.resolve(response()); during.resolve(response()); await Promise.all([oldRead, duringRead]);
  const joined = client.loadEngineTagRegistry("one");
  const value = response(2); after.resolve(value); expect(await freshRead).toBe(value); expect(await joined).toBe(value);
  expect(io.getJson).toHaveBeenCalledTimes(3);
  expect(io.sendJson).toHaveBeenCalledWith("POST", "/engine-tags/registry/commands", command);
});

it("failed commands propagate and still retire earlier pending reads", async () => {
  const io = transport(), before = deferred<unknown>(), error = new Error("conflict");
  io.getJson.mockReturnValueOnce(before.promise).mockResolvedValueOnce(response(2)); io.sendJson.mockRejectedValueOnce(error);
  const client = createEngineTagRuntimeClient(io), oldRead = client.loadEngineTagRegistry("one");
  await expect(client.applyEngineTagCommand(command)).rejects.toBe(error);
  await expect(client.loadEngineTagRegistry("one")).resolves.toMatchObject({ history_revision: 2 });
  before.resolve(response()); await oldRead; expect(io.getJson).toHaveBeenCalledTimes(2);
});

it("late retired read failure cannot evict a newer pending read", async () => {
  const io = transport(), old = deferred<unknown>(), fresh = deferred<unknown>();
  io.getJson.mockReturnValueOnce(old.promise).mockReturnValue(fresh.promise); io.sendJson.mockResolvedValue(response(2));
  const client = createEngineTagRuntimeClient(io);
  const original = Promise.allSettled([client.loadEngineTagRegistry("one")]);
  await client.applyEngineTagCommand(command); const next = client.loadEngineTagRegistry("one");
  old.reject(new Error("old failure")); await original;
  const joined = client.loadEngineTagRegistry("one"); expect(io.getJson).toHaveBeenCalledTimes(2);
  fresh.resolve(response(2)); await Promise.all([next, joined]);
});

it("preserves validation and transport for explicit preview/integrity/command operations", async () => {
  const io = transport(), client = createEngineTagRuntimeClient(io);
  io.sendJson.mockResolvedValueOnce({}); await expect(client.applyEngineTagCommand(command)).rejects.toThrow("Invalid engine tag registry response");
  const preview = { projection_version: 1, entries: [] }; io.sendJson.mockResolvedValueOnce(preview);
  await expect(client.previewEngineTagRegistry("one", "ink")).resolves.toBe(preview);
  expect(io.sendJson).toHaveBeenLastCalledWith("POST", "/engine-tags/registry/preview?session_id=one", { target: "ink" });
  const integrity = { report_version: 1, findings: [] }; io.getJson.mockResolvedValueOnce(integrity);
  await expect(client.inspectEngineTagIntegrity("one")).resolves.toBe(integrity);
  io.getJson.mockResolvedValueOnce({}); await expect(client.inspectEngineTagIntegrity("one")).rejects.toThrow("Invalid engine tag integrity response");
  io.sendJson.mockResolvedValueOnce({}); await expect(client.previewEngineTagRegistry("one", "ink")).rejects.toThrow("Invalid engine tag projection response");
});
