/** Observer projection cannot mutate protocol guards, replay, save or cross scopes. */
import { expect, it, vi } from "vitest";
import type { RemoteStorageHeadV1 } from "@something-to-tell/contracts/remote-storage";
import type { RemoteSessionObservation } from "./remoteChannel";
import { createRuntimeTransport } from "./transport";

const head: RemoteStorageHeadV1 = { protocol_version: 1, project_id: "observed-project", storage_generation: "00000000-0000-4000-8000-000000000001",
  authoring_revision: "9007199254740993", saved_authoring_revision: "0", saved_revision: "0", writer_epoch: "7", document_checksum: "a".repeat(64), state: "ready" };
function receipt(init: RequestInit | undefined, body = "{}") {
  return new Response(body, { headers: { "X-Remote-Result-Revision": "9007199254740994",
    "X-Remote-Storage-Generation": head.storage_generation, "X-Remote-Command-Id": new Headers(init?.headers).get("X-Remote-Command-Id")!,
    "X-Remote-Document-Checksum": "b".repeat(64) } });
}
function setup(fetcher: (url: string, init?: RequestInit) => Promise<Response>, signal?: AbortSignal) {
  const observations: RemoteSessionObservation[] = [], onMutation = vi.fn();
  const fetch = vi.fn(fetcher);
  const transport = createRuntimeTransport({ projectSessionId: "observed-session", remoteStorage: head, fetcher: fetch, onMutation,
    onRemoteStorageObserved: value => observations.push(value), remoteObservationSignal: signal });
  return { transport, observations, fetch, onMutation };
}

it("publishes frozen receipt projections with exact counters and no extra mutation callback", async () => {
  const { transport, observations, onMutation, fetch } = setup(async (_, init) => receipt(init));
  await transport.sendJson("POST", "/nodes", {});
  const state = observations.at(-1)!;
  expect(state).toMatchObject({ sessionId: "observed-session", blocked: false, errorCode: null, unresolvedCommandId: null });
  expect(state.head.authoring_revision).toBe("9007199254740994");
  expect(Object.isFrozen(state)).toBe(true); expect(Object.isFrozen(state.head)).toBe(true);
  expect(() => { (state.head as RemoteStorageHeadV1).authoring_revision = "0"; }).toThrow();
  expect(onMutation).toHaveBeenCalledTimes(1); expect(fetch).toHaveBeenCalledTimes(1);
});

it("preserves the exact attempted command identity after network loss without retry", async () => {
  const { transport, observations, fetch, onMutation } = setup(async () => { throw new TypeError("private network detail"); });
  await expect(transport.sendJson("POST", "/nodes", { body: "private authored text" })).rejects.toMatchObject({ code: "remote_commit_unknown" });
  const state = observations.at(-1)!;
  expect(state.unresolvedCommandId).toBe(new Headers(fetch.mock.calls[0]![1]?.headers).get("X-Remote-Command-Id"));
  expect(state).toMatchObject({ blocked: true, errorCode: "remote_commit_unknown" });
  expect(JSON.stringify(state)).not.toMatch(/private|authored/);
  await expect(transport.sendJson("POST", "/nodes", {})).rejects.toMatchObject({ code: "remote_commit_unknown" });
  expect(fetch).toHaveBeenCalledTimes(1); expect(onMutation).not.toHaveBeenCalled();
});

it("retains request identity after a valid receipt but truncated domain body", async () => {
  const { transport, observations, fetch } = setup(async (_, init) => receipt(init, "{"));
  await expect(transport.sendJson("POST", "/nodes", {})).rejects.toMatchObject({ code: "remote_contract_invalid" });
  expect(observations.at(-1)).toMatchObject({ blocked: true, errorCode: "remote_contract_invalid",
    unresolvedCommandId: new Headers(fetch.mock.calls[0]![1]?.headers).get("X-Remote-Command-Id"), head: { authoring_revision: "9007199254740994" } });
});

it.each(["remote_auth_failed", "remote_tls_failed", "remote_storage_timeout", "remote_storage_unavailable", "remote_writer_lost",
  "remote_revision_stale", "remote_generation_mismatch", "remote_schema_future", "remote_schema_unknown", "remote_schema_partial",
  "remote_storage_protocol_unsupported", "remote_local_publication_required", "project_session_not_found", "remote_project_busy", "remote_schema_busy"])(
  "observes %s as a stable code without exposing server details", async code => {
    const { transport, observations, onMutation } = setup(async () => new Response(JSON.stringify({ detail: { code, message: "private password", parameters: { secret: "private" } } }), { status: 409 }));
    await expect(transport.sendJson("POST", "/nodes", {})).rejects.toMatchObject({ code });
    expect(observations.at(-1)).toMatchObject({ errorCode: code, blocked: !["remote_project_busy", "remote_schema_busy"].includes(code) });
    expect(JSON.stringify(observations)).not.toContain("private"); expect(onMutation).not.toHaveBeenCalled();
  });

it("reports failed reads without inventing a write command or replaying them", async () => {
  const { transport, observations, fetch } = setup(async () => { throw new TypeError("offline"); });
  await expect(transport.getJson("/nodes")).rejects.toMatchObject({ code: "remote_storage_unavailable" });
  expect(observations.at(-1)).toMatchObject({ errorCode: "remote_storage_unavailable", blocked: true, unresolvedCommandId: null });
  await expect(transport.sendJson("POST", "/nodes", {})).rejects.toMatchObject({ code: "remote_commit_unknown" });
  expect(fetch).toHaveBeenCalledTimes(1);
});

it("redacts malformed read bodies and reports a contract failure without a command id", async () => {
  const { transport, observations } = setup(async () => new Response("private-invalid-json"));
  await expect(transport.getJson("/nodes")).rejects.toMatchObject({ code: "remote_contract_invalid", message: "remote_contract_invalid" });
  expect(observations.at(-1)).toMatchObject({ blocked: true, errorCode: "remote_contract_invalid", unresolvedCommandId: null });
  expect(JSON.stringify(observations)).not.toContain("private");
});

it("a successful inspection cannot unblock or advance a guard without its document", async () => {
  let offline = true;
  const { transport, observations } = setup(async () => {
    if (offline) throw new TypeError("offline");
    return new Response(JSON.stringify({ ...head, authoring_revision: "9007199254740999" }));
  });
  await expect(transport.getJson("/nodes")).rejects.toBeDefined(); offline = false;
  await transport.getJson("/project-sessions/observed-session/remote-storage");
  expect(observations.at(-1)).toMatchObject({ blocked: true, errorCode: "remote_storage_unavailable", head: { authoring_revision: head.authoring_revision } });
});

it.each(["session", "project", "generation"])("rejects a mismatched %s without publishing foreign scope", async scope => {
  const { transport, observations } = setup(async () => new Response(JSON.stringify({ session: { session_id: scope === "session" ? "foreign-session" : "observed-session",
    project_id: scope === "project" ? "foreign-project" : head.project_id, storage_mode: "postgresql", session_version: 2, remote_state: "ready",
    remote_storage: { ...head, ...(scope === "project" ? { project_id: "foreign-project" } : {}),
      ...(scope === "generation" ? { storage_generation: "00000000-0000-4000-8000-000000000002" } : {}) } } })));
  await expect(transport.getJson("/project-sessions/observed-session/snapshot")).rejects.toMatchObject({ code: scope === "generation" ? "remote_generation_mismatch" : "remote_project_scope_mismatch" });
  expect(observations.at(-1)).toMatchObject({ sessionId: "observed-session", blocked: true, head });
  expect(JSON.stringify(observations)).not.toContain("foreign");
});

it("retires delayed observations and dirty callbacks without cancelling server execution", async () => {
  const controller = new AbortController(); let complete!: (response: Response) => void;
  const { transport, observations, fetch, onMutation } = setup(() => new Promise(resolve => { complete = resolve; }), controller.signal);
  const operation = transport.sendJson("POST", "/nodes", {});
  await vi.waitFor(() => expect(fetch).toHaveBeenCalledTimes(1)); controller.abort();
  complete(receipt(fetch.mock.calls[0]![1])); await expect(operation).resolves.toEqual({});
  expect(observations).toHaveLength(0); expect(onMutation).not.toHaveBeenCalled();
});

it("observer exceptions cannot turn a committed response into a failed request", async () => {
  const transport = createRuntimeTransport({ projectSessionId: "observed-session", remoteStorage: head,
    fetcher: async (_, init) => receipt(init), onRemoteStorageObserved: () => { throw new Error("presentation failed"); } });
  await expect(transport.sendJson("POST", "/nodes", {})).resolves.toEqual({});
});
