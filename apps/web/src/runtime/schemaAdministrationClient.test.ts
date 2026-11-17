import { afterEach, describe, expect, it, vi } from "vitest";
import type { RemoteSchemaPlanV1 } from "@something-to-tell/contracts/remote-storage";
import samples from "../../../../services/runtime/tests/fixtures/remote_storage_v1.json";
import { createSchemaAdministrationClient } from "./schemaAdministrationClient";
import { createRuntimeTransport, RuntimeApiError } from "./transport";

const scope = { protocol_version: 1 as const, project_path: "/stories/Selected.narrative", profile_id: "admin" };
const plan: RemoteSchemaPlanV1 = { ...samples.schema_plan, protocol_version: 1, action: "upgrade" };
const command = { ...scope, plan_id: plan.plan_id, plan_fingerprint: plan.plan_fingerprint,
  backup_attestation_id: samples.schema_backup_attestation.backup_attestation_id };
const profile = { profile_id: "admin", label: "Administrator", host: "localhost", port: 5432,
  database: "story", username: "admin", tls_policy: "disable" };
const inspection = { protocol_version: 1, server_major: 17, schema_status: "older", schema_revision: "20261022_0011",
  tls_policy: "disable", tls_active: false, identity_verified: false, privileges: "administrator" };
const completed = { ...samples.schema_execution, action: "upgrade" };

function harness(responses: unknown[]) {
  const onMutation = vi.fn();
  const fetcher = vi.fn(async (_url: string, _init?: RequestInit) => new Response(JSON.stringify(responses.shift()), {
    status: 200, headers: { "content-type": "application/json" }
  }));
  const api = createSchemaAdministrationClient(createRuntimeTransport({ baseUrl: "http://runtime.test/api", fetcher,
    projectSessionId: "selected-session", projectPath: scope.project_path, onMutation }));
  return { api, fetcher, onMutation };
}

afterEach(() => vi.useRealTimers());

describe("narrow schema administration transport", () => {
  it("saves an explicitly requested scoped definition without connecting or mutating authoring state", async () => {
    const { api, fetcher, onMutation } = harness([profile]);
    await expect(api.addProfile({ protocol_version: 1, project_path: scope.project_path,
      label: "Administrator", host: "localhost", port: 5432, database: "story", username: "admin",
      password: "explicit-private-test-password", tls_policy: "disable" })).resolves.toEqual(profile);
    expect(fetcher).toHaveBeenCalledOnce();
    expect(fetcher.mock.calls[0]![0]).toBe("http://runtime.test/api/storage-profiles/folder");
    expect(JSON.parse(String(fetcher.mock.calls[0]![1]?.body))).not.toHaveProperty("session_id");
    expect(onMutation).not.toHaveBeenCalled();
  });

  it("rejects a secret echoed by configuration instead of rendering it", async () => {
    const { api } = harness([{ ...profile, password: "private" }]);
    await expect(api.addProfile({ protocol_version: 1, project_path: scope.project_path,
      label: "Administrator", host: "localhost", port: 5432, database: "story", username: "admin",
      password: "explicit-private-test-password", tls_policy: "disable" }))
      .rejects.toMatchObject({ code: "remote_contract_invalid" });
  });
  it("uses v1 scoped explicit calls without dirty tracking, Open, Save or implicit execution", async () => {
    const { api, fetcher, onMutation } = harness([{ profiles: [profile] }, inspection, plan, samples.schema_backup_attestation, completed]);
    await expect(api.listProfiles(scope.project_path)).resolves.toEqual({ profiles: [profile] });
    await expect(api.inspect(scope)).resolves.toEqual(inspection);
    expect(fetcher).toHaveBeenCalledTimes(2);
    await api.prepare({ ...scope, action: "upgrade", expected_schema_revision: "20261022_0011" });
    await api.attest({ ...scope, plan_id: plan.plan_id, plan_fingerprint: plan.plan_fingerprint,
      confirmation: "backup_and_restore_verified" });
    await expect(api.execute(command, plan)).resolves.toEqual(completed);
    expect(fetcher.mock.calls.map(([url]) => url.replace("http://runtime.test/api", ""))).toEqual([
      "/storage-profiles/available", "/storage-profiles/inspect", "/storage-profiles/schema-plans",
      "/storage-profiles/schema-plans/backup-attestations", "/storage-profiles/schema-plans/execute"
    ]);
    for (const [, init] of fetcher.mock.calls) {
      expect(new Headers(init?.headers).get("X-Remote-Storage-Version")).toBe("1");
      expect(new Headers(init?.headers).get("X-Project-Session-Id")).toBe("selected-session");
      expect(init?.method).toBe("POST");
      expect(JSON.parse(String(init?.body))).toMatchObject({ protocol_version: 1, project_path: scope.project_path });
    }
    expect(JSON.parse(String(fetcher.mock.calls[0]![1]?.body))).not.toHaveProperty("profile_id");
    expect(onMutation).not.toHaveBeenCalled();
  });

  it.each([{ profiles: [{ ...profile, password: "private" }] }, { profiles: [profile, profile] },
    { profiles: [{ ...profile, port: "5432" }] }, { profiles: [{ ...profile, tls_policy: "off" }] },
    { profiles: null }, { profiles: [], password: "private" }])("rejects secret/malformed profile summaries %#", async response => {
    const { api } = harness([response]);
    await expect(api.listProfiles(scope.project_path)).rejects.toMatchObject({ code: "remote_contract_invalid" });
  });

  it.each([{ server_major: "17" }, { server_major: 17.5 }, { schema_revision: null }, { schema_status: "empty" },
    { privileges: ["administrator"] }, { tls_active: true }, { identity_verified: true }, { password: "private" }])(
    "rejects inconsistent/secret inspection response %#", async override => {
      const { api } = harness([{ ...inspection, ...override }]);
      await expect(api.inspect(scope)).rejects.toMatchObject({ code: "remote_contract_invalid" });
    });

  it("correlates a plan's action/source with its request", async () => {
    const { api } = harness([plan]);
    await expect(api.prepare({ ...scope, action: "provision", expected_schema_revision: null }))
      .rejects.toMatchObject({ code: "remote_contract_invalid" });
  });

  it("rejects another plan's backup acknowledgement", async () => {
    const { api } = harness([{ ...samples.schema_backup_attestation, plan_fingerprint: "d".repeat(64) }]);
    await expect(api.attest({ ...scope, plan_id: plan.plan_id, plan_fingerprint: plan.plan_fingerprint,
      confirmation: "backup_and_restore_verified" })).rejects.toMatchObject({ code: "remote_contract_invalid" });
  });

  it("requires matching reviewed metadata before sending Execute", async () => {
    const { api, fetcher } = harness([]);
    await expect(api.execute({ ...command, plan_fingerprint: "d".repeat(64) }, plan))
      .rejects.toMatchObject({ code: "remote_contract_invalid" });
    expect(fetcher).not.toHaveBeenCalled();
  });

  it.each([{ action: "provision" }, { schema_revision: "20261022_0011" },
    { plan_id: "55555555-5555-4555-8555-555555555555" }, { status: "pending" }])(
    "does not report an unrelated/incomplete result as successful %#", async override => {
      const { api, fetcher } = harness([{ ...completed, ...override }]);
      await expect(api.execute(command, plan)).rejects.toMatchObject({ code: "remote_contract_invalid" });
      expect(fetcher).toHaveBeenCalledOnce();
    });

  it("does not recover a session or replay an administration failure", async () => {
    const { api, fetcher, onMutation } = harness([]);
    fetcher.mockResolvedValue(new Response(JSON.stringify({ detail: { code: "project_session_not_found" } }), { status: 404 }));
    await expect(api.inspect(scope)).rejects.toMatchObject({ code: "project_session_not_found" });
    expect(fetcher).toHaveBeenCalledOnce(); expect(onMutation).not.toHaveBeenCalled();
  });

  it("maps network failure during Execute to unknown, with no automatic retry", async () => {
    const { api, fetcher, onMutation } = harness([]);
    fetcher.mockRejectedValue(new TypeError("private network detail"));
    await expect(api.execute(command, plan)).rejects.toMatchObject({ code: "remote_commit_unknown", status: 503 });
    expect(fetcher).toHaveBeenCalledOnce(); expect(onMutation).not.toHaveBeenCalled();
  });

  it("bounds a hanging Execute and clears its timer without claiming rollback", async () => {
    vi.useFakeTimers();
    const { api, fetcher } = harness([]);
    fetcher.mockImplementation((_url, init) => new Promise((_resolve, reject) => {
      init!.signal!.addEventListener("abort", () => reject(new DOMException("Aborted", "AbortError")), { once: true });
    }));
    const assertion = expect(api.execute(command, plan)).rejects.toBeInstanceOf(RuntimeApiError);
    await vi.advanceTimersByTimeAsync(45000);
    await assertion;
    expect(fetcher).toHaveBeenCalledOnce(); expect(vi.getTimerCount()).toBe(0);
  });
});
