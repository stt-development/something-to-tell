import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync } from "node:fs";
import { allowedRetentionWrite, summarizeRetention } from "./retention-contract.mjs";

const samples = () => Array.from({ length: 7 }, (_, checkpoint) => ({ checkpoint, heap_used: 1000 + checkpoint,
  dom_nodes: 20, documents: 1, listeners: 3, canvas_nodes: 0, canvas_edges: 0, story_beats: 0, navigation_lists: 0 }));
test("only explicitly owned path aliases and session ids permit lifecycle writes", () => {
  const paths = new Set(["/owned/file", "/canonical/owned/file"]), ids = new Set(["owned:id"]);
  const allowed = (path, method, body) => allowedRetentionWrite(path, method, body, paths, ids);
  assert.equal(allowed("/api/project-sessions/open", "POST", { path: "/canonical/owned/file" }), true);
  assert.equal(allowed("/api/project-sessions/owned%3Aid/close", "POST", {}), true);
  for (const [path, method, body] of [["/api/project-sessions/open", "POST", { path: "/foreign/file" }],
    ["/api/project-sessions/open", "POST", {}], ["/api/project-sessions/foreign/close", "POST", {}],
    ["/api/project-sessions/owned%3Aid/save", "POST", {}], ["/api/project-sessions/owned%3Aid/discard", "POST", {}],
    ["/api/project-sessions/owned%3Aid/close", "PUT", {}]]) assert.equal(allowed(path, method, body), false);
});
test("compares equivalent closed checkpoints without inventing a heap threshold", () => {
  const result = summarizeRetention(samples());
  assert.deepEqual(result.heap_used, { first: 1000, last: 1006, range: 6, delta: 6 });
  assert.deepEqual(result.dom_nodes, { first: 20, last: 20, range: 0, delta: 0 });
  const large = samples(); large.at(-1).heap_used = 1e9;
  assert.equal(summarizeRetention(large).heap_used.last, 1e9); // Observations must expose, not hide, growth.
});
test("rejects incomplete or incomparable samples and retained workspace DOM", () => {
  for (const change of [(rows) => rows.pop(), (rows) => { rows[2].checkpoint = 4; },
    (rows) => { rows[1].heap_used = NaN; }, (rows) => { rows[1].listeners = undefined; },
    ...["canvas_nodes", "canvas_edges", "story_beats", "navigation_lists"].map((key) => (rows) => { rows[1][key] = 1; })]) {
    const rows = samples(); change(rows); assert.throws(() => summarizeRetention(rows), /retention_checkpoint_incomplete/);
  }
});
test("archived production-default matrices release all owned sessions and retain complete observations", () => {
  const report = JSON.parse(readFileSync(new URL("../../../docs/verification/frontend-performance/p9-1-010-retention.json", import.meta.url), "utf8"));
  assert.equal(report.status, "passed"); assert.equal(report.cleanup, "released"); assert.equal(report.switch_cleanup, "released");
  assert.match(report.app_source_sha256, /^[a-f0-9]{64}$/); assert.match(report.harness_sha256, /^[a-f0-9]{64}$/);
  assert.equal(report.build_mode, "unoverridden_production_default");
  assert.deepEqual(report.cases.map((row) => row.viewport.width), [1440, 1024]);
  for (const row of report.cases) {
    assert.equal(row.status, "ok"); assert.equal(row.step, "complete"); assert.equal(row.released_sessions, 8);
    assert.equal(row.page_errors, 0); assert.equal(row.unexpected_writes, 0);
    assert.equal(row.cycles.length, 8);
    assert.deepEqual(row.cycles.map((cycle) => cycle.canonical_nodes), [1000, 16, 1000, 16, 1000, 16, 1000, 16]);
    assert.ok(row.cycles.every((cycle) => cycle.document_unchanged && cycle.old_history_missing && cycle.locale_round_trip));
    assert.deepEqual(summarizeRetention(row.checkpoints), row.retained_changes);
    assert.ok(row.checkpoints.every((sample) => sample.detached_roots === 0));
  }
});
