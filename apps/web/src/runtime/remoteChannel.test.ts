import { describe, expect, it, vi } from "vitest";
import { assertRemoteStorageHead, type RemoteStorageHeadV1 } from "@something-to-tell/contracts/remote-storage";
import { createRuntimeTransport } from "./transport";

const head: RemoteStorageHeadV1 = {
  protocol_version: 1, project_id: "project-pg", storage_generation: "00000000-0000-4000-8000-000000000001",
  authoring_revision: "9007199254740993", saved_authoring_revision: "0", saved_revision: "0",
  writer_epoch: "7", document_checksum: "a".repeat(64), state: "ready"
};

describe("remote guarded transport", () => {
  it("serializes writes using exact decimal heads and unique command identities", async () => {
    const observed: Headers[] = [];
    const fetcher = vi.fn(async (_: string, init?: RequestInit) => {
      const request = new Headers(init?.headers);
      observed.push(request);
      const revision = String(BigInt(request.get("X-Remote-Expected-Revision")!) + 1n);
      return new Response(JSON.stringify({ id: crypto.randomUUID() }), { status: 201, headers: {
        "X-Remote-Result-Revision": revision, "X-Remote-Storage-Generation": head.storage_generation,
        "X-Remote-Command-Id": request.get("X-Remote-Command-Id")!, "X-Remote-Document-Checksum": "b".repeat(64)
      } });
    });
    const transport = createRuntimeTransport({ fetcher, projectSessionId: "remote-session", remoteStorage: head });
    await Promise.all([transport.sendJson("POST", "/nodes", {}), transport.sendJson("POST", "/nodes", {})]);
    expect(observed.map(item => item.get("X-Remote-Expected-Revision"))).toEqual(["9007199254740993", "9007199254740994"]);
    expect(observed[0]!.get("X-Remote-Command-Id")).not.toBe(observed[1]!.get("X-Remote-Command-Id"));
    expect(observed.every(item => item.get("X-Remote-Storage-Version") === "1" && item.get("X-Remote-Writer-Epoch") === "7")).toBe(true);
  });

  it("does not recover and replay a remote mutation after network response loss", async () => {
    const fetcher = vi.fn(async () => { throw new TypeError("network lost"); });
    const transport = createRuntimeTransport({ fetcher, projectSessionId: "remote-session", projectPath: "/stories/Test.narrative", remoteStorage: head });
    await expect(transport.sendJson("POST", "/nodes", {})).rejects.toMatchObject({ code: "remote_commit_unknown" });
    await expect(transport.sendJson("POST", "/nodes", {})).rejects.toMatchObject({ code: "remote_commit_unknown" });
    expect(fetcher).toHaveBeenCalledTimes(1);
  });

  it("validates untrusted heads including secret fields and bigint coercion", () => {
    expect(() => assertRemoteStorageHead(head)).not.toThrow();
    for (const invalid of [{ ...head, owner_token: "must not cross wire" },
      { ...head, authoring_revision: 9007199254740993 }, { ...head, authoring_revision: "01" },
      { ...head, authoring_revision: "9223372036854775808" }, { ...head, protocol_version: true }]) {
      expect(() => assertRemoteStorageHead(invalid)).toThrow("remote_contract_invalid");
    }
  });

  it("rejects a malformed response receipt and blocks later requests", async () => {
    const fetcher = vi.fn(async (_: string, init?: RequestInit) => new Response("{}", { headers: {
      "X-Remote-Result-Revision": "01", "X-Remote-Storage-Generation": head.storage_generation,
      "X-Remote-Command-Id": new Headers(init?.headers).get("X-Remote-Command-Id")!,
      "X-Remote-Document-Checksum": "b".repeat(64)
    } }));
    const transport = createRuntimeTransport({ fetcher, projectSessionId: "remote-session", remoteStorage: head });
    await expect(transport.sendJson("POST", "/nodes", {})).rejects.toMatchObject({ code: "remote_contract_invalid" });
    await expect(transport.sendJson("POST", "/nodes", {})).rejects.toMatchObject({ code: "remote_commit_unknown" });
    expect(fetcher).toHaveBeenCalledTimes(1);
  });

  it("does not publish a delayed older snapshot over a newer command head", async () => {
    const fetcher = vi.fn(async (path: string, init?: RequestInit) => {
      if (path.endsWith("/snapshot")) return new Response(JSON.stringify({ session: {
        session_id: "remote-session", storage_mode: "postgresql", session_version: 2,
        project_id: head.project_id, remote_storage: head, remote_state: "ready"
      } }));
      return new Response("{}", { headers: {
        "X-Remote-Result-Revision": "9007199254740994", "X-Remote-Storage-Generation": head.storage_generation,
        "X-Remote-Command-Id": new Headers(init?.headers).get("X-Remote-Command-Id")!,
        "X-Remote-Document-Checksum": "b".repeat(64)
      } });
    });
    const transport = createRuntimeTransport({ fetcher, projectSessionId: "remote-session", remoteStorage: head });
    await transport.sendJson("POST", "/nodes", {});
    await expect(transport.getJson("/snapshot")).rejects.toMatchObject({ code: "remote_revision_stale" });
  });

  it("blocks writes after a truncated domain response even with a committed receipt", async () => {
    const fetcher = vi.fn(async (_: string, init?: RequestInit) => new Response("{", { headers: {
      "X-Remote-Result-Revision": "9007199254740994", "X-Remote-Storage-Generation": head.storage_generation,
      "X-Remote-Command-Id": new Headers(init?.headers).get("X-Remote-Command-Id")!,
      "X-Remote-Document-Checksum": "b".repeat(64)
    } }));
    const transport = createRuntimeTransport({ fetcher, projectSessionId: "remote-session", remoteStorage: head });
    await expect(transport.sendJson("POST", "/nodes", {})).rejects.toMatchObject({ code: "remote_contract_invalid" });
    await expect(transport.sendJson("POST", "/nodes", {})).rejects.toMatchObject({ code: "remote_commit_unknown" });
    expect(fetcher).toHaveBeenCalledTimes(1);
  });
});
