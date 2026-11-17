/** Validated lifecycle result only; never closes UI state or replays authoring. */
import { afterEach, expect, it, vi } from "vitest";
import type { RemoteStorageHeadV1, RemoteStorageReleaseV1 } from "@something-to-tell/contracts/remote-storage";
import { createRemoteStorageClient } from "./remoteClient";
import { createRuntimeTransport } from "./transport";
import samples from "../../../../services/runtime/tests/fixtures/remote_storage_v1.json";

const command = samples.release_request as RemoteStorageReleaseV1;
const head = { ...samples.head, state: "ready", protocol_version: 1 } as RemoteStorageHeadV1;
afterEach(() => vi.useRealTimers());

it("can release a blocked channel without a new command guard, replay, dirty or Save", async () => {
  const onMutation = vi.fn();
  const fetcher = vi.fn(async (url: string, _init?: RequestInit) => {
    if (url.endsWith("/nodes")) throw new TypeError("lost reply");
    return new Response(JSON.stringify(samples.release_result));
  });
  const transport = createRuntimeTransport({ fetcher, projectSessionId: "session-a", remoteStorage: head, onMutation });
  await expect(transport.sendJson("POST", "/nodes", {})).rejects.toMatchObject({ code: "remote_commit_unknown" });
  const result = await createRemoteStorageClient(transport).releaseRemoteStorage("session-a", "project-a", command);
  expect(result).toEqual(samples.release_result); expect(fetcher).toHaveBeenCalledTimes(2);
  const [url, init] = fetcher.mock.calls[1]!;
  expect(url).toContain("/project-sessions/session-a/remote-storage/release");
  expect(JSON.parse(init!.body as string)).toEqual(samples.release_request);
  const headers = new Headers(init?.headers);
  expect(headers.get("X-Remote-Storage-Version")).toBe("1"); expect(headers.get("X-Project-Session-Id")).toBe("session-a");
  expect(headers.has("X-Remote-Command-Id")).toBe(false); expect(onMutation).not.toHaveBeenCalled();
});

it("rejects malformed consent before network activity", async () => {
  const fetcher = vi.fn(); const client = createRemoteStorageClient(createRuntimeTransport({ fetcher }));
  await expect(client.releaseRemoteStorage("session-a", "project-a", { ...command, confirmation: "save" } as unknown as RemoteStorageReleaseV1))
    .rejects.toMatchObject({ code: "remote_contract_invalid" });
  expect(fetcher).not.toHaveBeenCalled();
});

it.each([{ session_id: "other-session" }, { project_id: "other-project" },
  { storage_generation: "22222222-2222-4222-8222-222222222222" }, { status: "saved" },
  { protocol_version: true }, { document: {} }, { password: "private" }, { save_status: "clean" }])(
  "never accepts a mismatched or misleading release acknowledgement %#", async override => {
    const onMutation = vi.fn(), fetcher = vi.fn(async () => new Response(JSON.stringify({ ...samples.release_result, ...override })));
    const client = createRemoteStorageClient(createRuntimeTransport({ fetcher, projectSessionId: "session-a", onMutation }));
    await expect(client.releaseRemoteStorage("session-a", "project-a", command)).rejects.toMatchObject({ code: "remote_contract_invalid" });
    expect(fetcher).toHaveBeenCalledTimes(1); expect(onMutation).not.toHaveBeenCalled();
  });

it("a lost release response is not confirmed or automatically retried", async () => {
  const fetcher = vi.fn(async () => { throw new TypeError("private network detail"); });
  const client = createRemoteStorageClient(createRuntimeTransport({ fetcher }));
  await expect(client.releaseRemoteStorage("session-a", "project-a", command)).rejects.toMatchObject({ code: "remote_storage_unavailable" });
  expect(fetcher).toHaveBeenCalledTimes(1);
});

it("bounds a hanging release request and clears its timeout without retry", async () => {
  vi.useFakeTimers();
  const fetcher = vi.fn((_url: string, init?: RequestInit) => new Promise<Response>((_, reject) => {
    init?.signal?.addEventListener("abort", () => reject(new DOMException("Aborted", "AbortError")));
  }));
  const client = createRemoteStorageClient(createRuntimeTransport({ fetcher }));
  const result = expect(client.releaseRemoteStorage("session-a", "project-a", command)).rejects.toMatchObject({ code: "remote_storage_unavailable" });
  await vi.advanceTimersByTimeAsync(45000); await result;
  expect(fetcher).toHaveBeenCalledTimes(1); expect(vi.getTimerCount()).toBe(0);
});
