import { test } from "node:test";
import assert from "node:assert/strict";
import { postgresConnection, preparePostgresFixture } from "./postgres.mjs";
import { readFileSync } from "node:fs";
test("DSNs use structured decoding and invalid inputs never leak credentials", () => {
  const config = postgresConnection("postgresql+psycopg://user:p%40ss@127.0.0.1:55432/test?sslmode=disable");
  assert.equal(config.password, "p@ss"); assert.equal(config.port, 55432); assert.equal(config.tls_policy, "disable");
  assert.equal(postgresConnection("postgresql://user:p@localhost/test").tls_policy, "verify-full");
  assert.throws(() => postgresConnection("private-invalid-key"), /^Error: invalid_probe_postgres_url$/);
});
test("only owned fixtures migrate and preparation releases its opened session", async () => {
  const calls = [];
  const fixture = { directory: "/tmp/stt-frontend-baseline-unit/fixture-small", path: "/tmp/stt-frontend-baseline-unit/fixture-small/Baseline.narrative" };
  const fetcher = async (url, init) => {
    assert.equal(init.headers["X-Remote-Storage-Version"], "1");
    calls.push({ url, body: JSON.parse(init.body) });
    const value = url.endsWith("/open") ? { session: { session_id: "owned", saved_revision: 0 } }
      : url.endsWith("storage-profiles") ? { profile_id: "temporary" }
        : url.endsWith("storage-migrations") ? { project: { document: { nodes: [1, 2], edges: [] } } } : {};
    return { ok: true, json: async () => value };
  };
  const result = await preparePostgresFixture(fixture, "http://probe/api", { database: "owned_database" }, fetcher);
  assert.deepEqual(result, { storage_mode: "postgresql", collection_counts: { nodes: 2, edges: 0 } });
  assert.ok(calls.at(-1).url.endsWith("/owned/close"));
  await assert.rejects(preparePostgresFixture({ directory: "/Users/author", path: "/Users/author/Aurora" }, "http://probe", {}, fetcher));
  assert.equal(calls.length, 4);
});
test("preparation failures preserve safe machine codes and close the owned session", async () => {
  const calls = [];
  const fixture = { directory: "/tmp/stt-frontend-baseline-unit/fixture-small", path: "/tmp/stt-frontend-baseline-unit/fixture-small/Baseline.narrative" };
  const fetcher = async (url) => {
    calls.push(url);
    if (url.endsWith("storage-migrations")) return { ok: false, status: 503, json: async () => ({ detail: { code: "remote_storage_timeout", parameters: { password: "never-retain" } } }) };
    return { ok: true, json: async () => url.endsWith("/open") ? { session: { session_id: "owned", saved_revision: 0 } } : { profile_id: "temporary" } };
  };
  await assert.rejects(preparePostgresFixture(fixture, "http://probe/api", {}, fetcher), (error) => {
    assert.equal(error.code, "remote_storage_timeout"); assert.equal(error.stage, "storage-migrations");
    assert.ok(!JSON.stringify(error).includes("never-retain")); return true;
  });
  assert.ok(calls.at(-1).endsWith("/owned/close"));
});
test("storage evidence compares equivalent small graphs and preserves unsupported large preparation", () => {
  const load = (kind) => JSON.parse(readFileSync(new URL(`../../../docs/verification/baselines/p9-1-${kind}-acquisition-v1.json`, import.meta.url), "utf8"));
  const pg = load("postgresql"), sqlite = load("sqlite");
  assert.equal(pg.storage_mode, "postgresql"); assert.equal(sqlite.storage_mode, "local_sqlite");
  assert.equal(pg.app_source_sha256, sqlite.app_source_sha256); assert.equal(pg.probe_sha256, sqlite.probe_sha256);
  assert.ok(Date.parse(pg.completed_at) <= Date.parse(sqlite.started_at));
  assert.equal(pg.database_cleanup, "released");
  assert.equal(pg.cases[0].fixture_source_sha256, sqlite.cases[0].fixture_source_sha256);
  assert.deepEqual(pg.cases[0].samples[0].dom, sqlite.cases[0].samples[0].dom);
  assert.equal(pg.cases[1].status, "preparation_failed"); assert.equal(pg.cases[1].error_code, "remote_storage_timeout");
  assert.deepEqual(pg.cases[1].samples, []);
  for (const item of [...pg.cases, ...sqlite.cases]) assert.equal(item.cleanup, "released");
  for (const marker of ["password", "postgresql://", "session_id", "127.0.0.1"]) assert.ok(!JSON.stringify(pg).includes(marker));
});
