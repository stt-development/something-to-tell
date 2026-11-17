import { expect, it } from "vitest";
import { assertRemoteStorageHead, assertRemoteStorageRelease, assertRemoteStorageReleaseResult } from "@something-to-tell/contracts/remote-storage";
import samples from "../../../../services/runtime/tests/fixtures/remote_storage_v1.json";

/** Same inert wire as Python: release is not a command receipt or Saved response. */
it("accepts both exact shared release samples", () => {
  expect(() => assertRemoteStorageRelease(samples.release_request)).not.toThrow();
  expect(() => assertRemoteStorageReleaseResult(samples.release_result)).not.toThrow();
});

it.each([{ confirmation: false }, { confirmation: "save" }, { confirmation: null },
  { storage_generation: "bad" }, { storage_generation: samples.head.storage_generation + "\n" },
  { protocol_version: true }, { protocol_version: 2 }, { password: "secret" }, { force_unlock: true }, { observed_revision: 4 }])(
  "rejects unsafe or coerced release requests %#", override => {
    expect(() => assertRemoteStorageRelease({ ...samples.release_request, ...override })).toThrow("remote_contract_invalid");
  });

it("requires every explicit release request field", () => {
  for (const key of Object.keys(samples.release_request)) {
    const value = { ...samples.release_request } as Record<string, unknown>; delete value[key];
    expect(() => assertRemoteStorageRelease(value)).toThrow("remote_contract_invalid");
  }
});

it.each([{ status: "saved" }, { status: "released" }, { save_status: "clean" }, { document: {} },
  { session_id: "" }, { project_id: "project-a\n" }, { session_id: "session-a\n" },
  { storage_generation: "bad" }, { protocol_version: true }, { owner_token: "private" }])(
  "rejects false Saved/document claims or invalid release scope %#", override => {
    expect(() => assertRemoteStorageReleaseResult({ ...samples.release_result, ...override })).toThrow("remote_contract_invalid");
  });

it("uses exact whitespace-free identities for ordinary head guards too", () => {
  expect(() => assertRemoteStorageHead({ ...samples.head, project_id: "project-a\n" })).toThrow("remote_contract_invalid");
  expect(() => assertRemoteStorageHead({ ...samples.head, storage_generation: samples.head.storage_generation + "\n" })).toThrow("remote_contract_invalid");
});
