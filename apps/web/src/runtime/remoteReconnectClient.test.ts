/** Lost lifecycle replies permit read-only lookup, never automatic reacquisition. */
import { afterEach, expect, it, vi } from "vitest";
import { type RemoteReconnectBeginV1, type RemoteReconnectAbandonV1, type RemoteStorageHeadV1 } from "@something-to-tell/contracts/remote-storage";
import { createRemoteStorageClient } from "./remoteClient";
import { createRuntimeTransport } from "./transport";
import samples from "../../../../services/runtime/tests/fixtures/remote_reconnect_v1.json";
import storage from "../../../../services/runtime/tests/fixtures/remote_storage_v1.json";

const begin = samples.begin as RemoteReconnectBeginV1;
const abandon = samples.abandon as RemoteReconnectAbandonV1;
const scope = { protocol_version: 1 as const, project_id: begin.project_id, storage_generation: begin.storage_generation, attempt_id: begin.attempt_id };
afterEach(() => vi.useRealTimers());

it("recovers a lost begin response by explicit lookup with no automatic retry or dirty effect", async () => {
  const onMutation = vi.fn();
  const fetcher = vi.fn(async (_url: string, init?: RequestInit) => {
    if (init?.method === "POST") throw new TypeError("lost reply");
    return new Response(JSON.stringify(samples.outcome));
  });
  const client = createRemoteStorageClient(createRuntimeTransport({ fetcher, projectSessionId: "session-old", onMutation }));
  await expect(client.beginRemoteReconnect("session-old", begin)).rejects.toMatchObject({ code: "remote_storage_unavailable" });
  expect(fetcher).toHaveBeenCalledTimes(1);
  await expect(client.inspectRemoteReconnect("session-old", scope)).resolves.toEqual(samples.outcome);
  const [url, init] = fetcher.mock.calls[1]!;
  expect(url).toContain(`/reconnect-attempts/${scope.attempt_id}?project_id=project-a&storage_generation=${scope.storage_generation}`);
  expect(new Headers(init?.headers).get("X-Remote-Storage-Version")).toBe("1");
  expect(fetcher).toHaveBeenCalledTimes(2); expect(onMutation).not.toHaveBeenCalled();
});

it("begins and abandons through a blocked authoring channel without command guards", async () => {
  const onMutation = vi.fn();
  const fetcher = vi.fn(async (url: string, _init?: RequestInit) => {
    if (url.endsWith("/nodes")) throw new TypeError("lost authoring response");
    return new Response(JSON.stringify(url.endsWith("/abandon")
      ? { ...samples.outcome, status: "released", result_session_id: null } : samples.outcome));
  });
  const transport = createRuntimeTransport({ fetcher, projectSessionId: "session-old", onMutation,
    remoteStorage: storage.head as RemoteStorageHeadV1 });
  await expect(transport.sendJson("POST", "/nodes", {})).rejects.toMatchObject({ code: "remote_commit_unknown" });
  const client = createRemoteStorageClient(transport);
  await client.beginRemoteReconnect("session-old", begin);
  await client.abandonRemoteReconnect("session-old", abandon, true);
  for (const [, init] of fetcher.mock.calls.slice(1)) expect(new Headers(init?.headers).has("X-Remote-Command-Id")).toBe(false);
  expect(fetcher.mock.calls[2]![1]?.keepalive).toBe(true);
  expect(onMutation).not.toHaveBeenCalled();
});

it.each([{ source_session_id: "foreign" }, { project_id: "foreign" }, { storage_generation: "33333333-3333-4333-8333-333333333333" },
  { attempt_id: "44444444-4444-4444-8444-444444444444" }, { result_session_id: "session-old" }, { document: {} }, { status: "saved" }])(
  "rejects foreign or misleading outcomes on every operation %#", async override => {
    const fetcher = vi.fn(async () => new Response(JSON.stringify({ ...samples.outcome, ...override })));
    const client = createRemoteStorageClient(createRuntimeTransport({ fetcher }));
    await expect(client.beginRemoteReconnect("session-old", begin)).rejects.toMatchObject({ code: "remote_contract_invalid" });
    await expect(client.inspectRemoteReconnect("session-old", scope)).rejects.toMatchObject({ code: "remote_contract_invalid" });
    await expect(client.abandonRemoteReconnect("session-old", abandon)).rejects.toMatchObject({ code: "remote_contract_invalid" });
    expect(fetcher).toHaveBeenCalledTimes(3);
  });

it("validates requests before network dispatch", async () => {
  const fetcher = vi.fn(), client = createRemoteStorageClient(createRuntimeTransport({ fetcher }));
  await expect(client.beginRemoteReconnect("session-old", { ...begin, confirmation: "save" } as unknown as RemoteReconnectBeginV1)).rejects.toMatchObject({ code: "remote_contract_invalid" });
  await expect(client.abandonRemoteReconnect("session-old", { ...abandon, confirmation: "save" } as unknown as RemoteReconnectAbandonV1)).rejects.toMatchObject({ code: "remote_contract_invalid" });
  expect(() => client.inspectRemoteReconnect("session-old", { ...scope, attempt_id: "bad" })).toThrow();
  expect(fetcher).not.toHaveBeenCalled();
});

it.each(["begin", "inspect", "abandon"] as const)("bounds hanging %s without replay", async action => {
  vi.useFakeTimers();
  const fetcher = vi.fn((_url: string, init?: RequestInit) => new Promise<Response>((_, reject) => {
    init?.signal?.addEventListener("abort", () => reject(new DOMException("Aborted", "AbortError")));
  }));
  const client = createRemoteStorageClient(createRuntimeTransport({ fetcher }));
  const promise = action === "begin" ? client.beginRemoteReconnect("session-old", begin)
    : action === "inspect" ? client.inspectRemoteReconnect("session-old", scope) : client.abandonRemoteReconnect("session-old", abandon);
  const result = expect(promise).rejects.toMatchObject({ code: "remote_storage_unavailable" });
  await vi.advanceTimersByTimeAsync(action === "inspect" ? 15000 : 45000); await result;
  expect(fetcher).toHaveBeenCalledTimes(1); expect(vi.getTimerCount()).toBe(0);
});
