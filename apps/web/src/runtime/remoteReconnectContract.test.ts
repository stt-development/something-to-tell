import { expect, it } from "vitest";
import { assertRemoteReconnectBegin, assertRemoteReconnectAbandon, assertRemoteReconnectOutcome } from "@something-to-tell/contracts/remote-storage";
import samples from "../../../../services/runtime/tests/fixtures/remote_reconnect_v1.json";

const validators = { begin: assertRemoteReconnectBegin, abandon: assertRemoteReconnectAbandon, outcome: assertRemoteReconnectOutcome };

it.each(["begin", "abandon", "outcome"] as const)("validates exact shared %s and required fields", name => {
  const validate: (value: unknown) => void = validators[name];
  expect(() => validate(samples[name])).not.toThrow();
  for (const key of Object.keys(samples[name])) {
    const value: Record<string, unknown> = { ...samples[name] }; delete value[key];
    expect(() => validate(value)).toThrow("remote_contract_invalid");
  }
  for (const override of [{ protocol_version: true }, { protocol_version: 2 }, { project_id: "a\n" },
    { attempt_id: "bad" }, { storage_generation: "bad" }, { owner_token: "secret" }, { document: {} }, { save_status: "clean" }]) {
    expect(() => validate({ ...samples[name], ...override })).toThrow("remote_contract_invalid");
  }
});

it.each([{ observed_revision: 1 }, { observed_revision: "9223372036854775808" }, { unresolved_command_id: "bad" },
  { confirmation: "save" }, { confirmation: true }])("requires exact revision and reload consent %#", override => {
  expect(() => assertRemoteReconnectBegin({ ...samples.begin, ...override })).toThrow("remote_contract_invalid");
});

it.each(["unknown", "pending", "ready", "failed", "releasing", "release_failed", "released"])("validates %s state invariants", status => {
  const result_session_id = ["ready", "release_failed"].includes(status) ? "session-new" : null;
  const error_code = ["failed", "release_failed"].includes(status) ? "remote_storage_unavailable" : null;
  const value = { ...samples.outcome, status, result_session_id, error_code };
  expect(() => assertRemoteReconnectOutcome(value)).not.toThrow();
  expect(() => assertRemoteReconnectOutcome({ ...value, result_session_id: result_session_id ? null : "session-new" })).toThrow();
  expect(() => assertRemoteReconnectOutcome({ ...value, error_code: error_code ? null : "remote_storage_unavailable" })).toThrow();
});

it.each([{ result_session_id: "session-old" }, { status: "saved" }, { error_code: "secret driver text" }, { result_session_id: "" }])(
  "rejects aliased or unsafe results %#", override => {
    expect(() => assertRemoteReconnectOutcome({ ...samples.outcome, ...override })).toThrow("remote_contract_invalid");
  });
