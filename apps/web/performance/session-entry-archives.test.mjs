import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
const json = (name) => JSON.parse(readFileSync(new URL(`../../../docs/verification/baselines/${name}.json`, import.meta.url)));
const sqlite = json("p9-1-006c2-entry-sqlite-v1"), postgres = json("p9-1-006c2-entry-postgresql-v1"), lifecycle = json("p9-1-006c2-entry-lifecycle-v1");
test("session-entry SQLite and small PostgreSQL first/warm opens share final sources and release owned resources", () => {
  assert.equal(sqlite.app_source_sha256, postgres.app_source_sha256); assert.equal(sqlite.app_source_sha256, lifecycle.app_source_sha256);
  for (const row of [...sqlite.cases, postgres.cases[0]]) {
    assert.equal(row.status, "ok"); assert.equal(row.cleanup, "released"); assert.equal(row.samples.length, 2);
    assert.deepEqual(row.samples.map((sample) => sample.cache), ["first_project_install", "warm_same_page"]);
  }
  assert.deepEqual(sqlite.cases.map((row) => row.fixture_nodes), [16, 1000]); assert.equal(postgres.database_cleanup, "released");
});
test("large PostgreSQL preparation failure is preserved as a blocked gate, not invented browser success", () => {
  const row = postgres.cases[1];
  assert.equal(row.fixture_nodes, 1000); assert.equal(row.status, "preparation_failed");
  assert.equal(row.step, "storage-migrations"); assert.equal(row.error_code, "remote_storage_timeout");
  assert.equal(row.samples.length, 0); assert.equal(row.cleanup, "released");
});
test("owned lifecycle retains dirty decisions, durable checkpoint and actual project replacement", () => {
  const row = lifecycle.cases[0]; assert.equal(row.status, "ok"); assert.equal(row.cleanup, "released"); assert.equal(row.samples.length, 1);
  const flow = row.samples[0].workflow;
  for (const key of ["rejected_save_preserved", "checkpoint_restored", "project_switch_verified"]) assert.equal(flow[key], true);
  assert.equal(flow.switched_node_count, 1000); assert.equal(flow.save.status, 200); assert.equal(flow.discard_close.status, 200);
});
