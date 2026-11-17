import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { summarize, resourceSummary, sanitizeRoute } from "./metrics.mjs";
import { guardedWorker } from "./guard.mjs";

test("summaries do not manufacture p95 from small samples or mutate inputs", () => {
  const values = [3, 1, 2];
  assert.deepEqual(summarize(values), { count: 3, median_ms: 2, max_ms: 3, p95_ms: null });
  assert.deepEqual(values, [3, 1, 2]);
  assert.equal(summarize(Array.from({ length: 20 }, (_, i) => i + 1)).p95_ms, 19);
  assert.equal(summarize([]).median_ms, null);
  assert.throws(() => summarize([NaN]));
});

test("resource summaries strip query paths and session identities", () => {
  const rows = resourceSummary([{ name: "http://localhost/api/project-sessions/private-id/save?path=secret",
    requestStart: 1, responseStart: 5, responseEnd: 7, decodedBodySize: 30 }]);
  assert.deepEqual(rows, [{ route: "/api/project-sessions/:id/save", wait_ms: 4, transfer_ms: 2, decoded_bytes: 30 }]);
  assert.equal(sanitizeRoute("http://localhost/api/project-sessions/private-id"), "/api/project-sessions/:id");
  assert.equal(sanitizeRoute("http://localhost/api/narrative-state/projects/private-id"), "/api/narrative-state/projects/:id");
  assert.equal(sanitizeRoute("http://localhost/api/project-sessions/open"), "/api/project-sessions/open");
});

test("external guard bounds an unresponsive worker", async () => {
  assert.equal((await guardedWorker(process.execPath, ["-e", "setInterval(()=>{},1000)"], 200)).status, "guard_exceeded");
  assert.equal((await guardedWorker(process.execPath, ["-e", "process.exit(0)"], 2000)).status, "ok");
  assert.equal((await guardedWorker(process.execPath, ["-e", "process.exit(2)"], 2000)).status, "failed");
  assert.throws(() => guardedWorker(process.execPath, [], 0));
});

test("archived observations are complete, sequential and compare the same Graph", () => {
  const load = (mode) => JSON.parse(readFileSync(new URL(`../../../docs/verification/baselines/p9-1-000a-${mode}-v1.json`, import.meta.url), "utf8"));
  const production = load("production"), development = load("development");
  assert.ok(Date.parse(production.completed_at) <= Date.parse(development.started_at));
  assert.equal(production.cases.length, 6);
  assert.equal(development.cases.length, 2);
  for (const report of [production, development]) {
    for (const item of report.cases) {
      assert.equal(item.status, "ok");
      assert.equal(item.cleanup, "released");
      for (const sample of item.samples) {
        assert.equal(sample.dom.nodes, item.fixture_nodes === 1000 ? 1124 : 18);
        for (const entry of sample.resources) assert.ok(entry.route.startsWith("/api/") && !entry.route.includes("?"));
      }
    }
  }
});
