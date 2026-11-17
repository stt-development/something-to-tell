import { describe, expect, it } from "vitest";
import * as wire from "@something-to-tell/contracts/remote-storage";
import samples from "../../../../services/runtime/tests/fixtures/remote_storage_v1.json";

describe("schema plan C1 contracts without administration execution", () => {
  it("accepts the same known-committed execution result as Python", () => {
    expect(() => wire.assertRemoteSchemaExecution(samples.schema_execution)).not.toThrow();
    expect(() => wire.assertRemoteSchemaExecution({ ...samples.schema_execution, action: "upgrade" })).not.toThrow();
  });

  it.each([{ status: "pending" }, { action: ["provision"] }, { action: "drop" },
    { schema_revision: null }, { schema_revision: "bad\nstamp" }, { plan_id: "bad" },
    { protocol_version: true }, { password: "private" }, { project_path: "/private/path" }])(
    "rejects pending, coerced or secret schema result %#", override => {
      expect(() => wire.assertRemoteSchemaExecution({ ...samples.schema_execution, ...override })).toThrow("remote_contract_invalid");
    });
  it("validates the same reviewed plan and confirmation metadata as Python", () => {
    const plan: wire.RemoteSchemaPlanV1 = { ...samples.schema_plan, protocol_version: 1, action: "upgrade" };
    const request: wire.RemoteSchemaBackupAttestationRequestV1 = { ...samples.schema_backup_request,
      protocol_version: 1, confirmation: "backup_and_restore_verified" };
    const attestation: wire.RemoteSchemaBackupAttestationV1 = { ...samples.schema_backup_attestation, protocol_version: 1 };
    expect(wire.REMOTE_SCHEMA_PLAN_TTL_SECONDS).toBe(300);
    expect(() => wire.assertRemoteSchemaPlan(plan)).not.toThrow();
    expect(() => wire.assertRemoteSchemaBackupAttestation(attestation)).not.toThrow();
    expect(JSON.parse(JSON.stringify({ plan, request, attestation }))).toEqual({
      plan: samples.schema_plan, request: samples.schema_backup_request, attestation: samples.schema_backup_attestation
    });
  });

  it("supports provisioning without implying a saved backup or source revision", () => {
    expect(() => wire.assertRemoteSchemaPlan({ ...samples.schema_plan,
      action: "provision", source_schema_revision: null, backup_required: false })).not.toThrow();
  });

  it.each([
    { action: "provision" }, { source_schema_revision: null }, { backup_required: false },
    { backup_required: "true" }, { action: ["upgrade"], backup_required: false },
    { migration_revisions: [] }, { migration_revisions: ["wrong-target"] },
    { migration_revisions: ["20261022_0012", "20261022_0012"] },
    { migration_revisions: ["20261022_0011", "20261022_0012"] }, { migration_revisions: Array(129).fill("x") },
    { target_schema_revision: "bad\nstamp" }, { target_schema_revision: "20261022_0012\n" },
    { plan_id: samples.schema_plan.plan_id + "\n" }, { plan_fingerprint: "c".repeat(64) + "\n" },
    { expires_at: "2026-02-30T12:05:00Z" }, { expires_at: "2026-10-23T12:05:00+01:00" },
    { expires_at: "2026-10-23T12:05:00" }, { expires_at: "2026-10-23T12:05:00Z\n" },
    { expires_at: "0000-01-01T00:00:00Z" }, { password: "not-retained" },
    { project_path: "/private/project" }, { protocol_version: true }
  ])("rejects inconsistent or secret plan fields %#", override => {
    expect(() => wire.assertRemoteSchemaPlan({ ...samples.schema_plan, ...override })).toThrow("remote_contract_invalid");
  });

  it.each([{ backup: "dump content" }, { plan_id: null }, { backup_attestation_id: "bad" },
    { backup_attestation_id: samples.schema_backup_attestation.backup_attestation_id + "\n" }])(
    "rejects invalid backup attestation fields %#", override => {
      expect(() => wire.assertRemoteSchemaBackupAttestation({ ...samples.schema_backup_attestation, ...override }))
        .toThrow("remote_contract_invalid");
    });
});
