import { describe, expect, it } from "vitest";
import * as wire from "@something-to-tell/contracts/remote-storage";
import samples from "../../../../services/runtime/tests/fixtures/remote_storage_v1.json";

describe("remote storage v1 inert wire boundary", () => {
  it("shares server policy defaults without rounding bigint counters", () => {
    for (const [name, value] of Object.entries(samples.constants)) {
      expect(wire[name as keyof typeof wire]).toEqual(value);
    }
    expect(BigInt(samples.head.authoring_revision)).toBe(9007199254740993n);
    expect(BigInt(wire.REMOTE_COUNTER_MAX)).toBe(9223372036854775807n);
  });

  it("round trips golden guards, heads, receipts and outcomes", () => {
    // Explicit literal fields make the shared JSON exercise the compile-time DTOs.
    const head: wire.RemoteStorageHeadV1 = { ...samples.head, protocol_version: 1, state: "ready" };
    const guard: wire.RemoteCommandGuardV1 = { ...samples.guard, protocol_version: 1 };
    const receipt: wire.RemoteCommandReceiptV1 = { ...samples.receipt, protocol_version: 1, result: "changed" };
    const context = {
      protocol_version: guard.protocol_version, project_id: guard.project_id,
      storage_generation: guard.storage_generation, command_id: guard.command_id,
    };
    const outcome: wire.RemoteCommandOutcomeV1 = { ...context, status: "committed", receipt };
    const pending: wire.RemoteCommandOutcomeV1 = { ...context, status: "unknown", receipt: null };
    expect(JSON.parse(JSON.stringify({ head, guard, receipt }))).toEqual({
      head: samples.head, guard: samples.guard, receipt: samples.receipt,
    });
    expect(outcome.receipt?.result_revision).toBe(head.authoring_revision);
    expect(pending.receipt).toBeNull();
  });

  it("keeps administration intent and reconnect explicit", () => {
    const request: wire.RemoteSchemaPlanRequestV1 = {
      protocol_version: 1, project_path: "/tmp/Example.narrative", profile_id: "admin",
      action: "upgrade", expected_schema_revision: "old",
    };
    const execute: wire.RemoteSchemaExecuteRequestV1 = {
      protocol_version: request.protocol_version, project_path: request.project_path,
      profile_id: request.profile_id, plan_id: samples.guard.command_id,
      plan_fingerprint: "a".repeat(64), backup_attestation_id: null,
    };
    const reconnect: wire.RemoteStorageReconnectV1 = {
      protocol_version: 1, storage_generation: samples.guard.storage_generation,
      observed_revision: samples.head.authoring_revision, unresolved_command_id: null,
    };
    expect(execute.profile_id).toBe("admin");
    expect(reconnect.observed_revision).toBe(samples.head.authoring_revision);
  });
});
