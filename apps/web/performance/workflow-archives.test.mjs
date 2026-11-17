import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
for (const [file, suite, samples] of [["navigation", "navigation_v1", 2], ["node-authoring", "node-authoring_v1", 1], ["connections", "connections_v1", 1], ["lifecycle", "lifecycle_v1", 1]]) {
  test(`reviewed ${suite} archive contains successful owned observations only`, () => {
    const version = file === "lifecycle" ? "v2" : "v1";
    const report = JSON.parse(readFileSync(new URL(`../../../docs/verification/baselines/p9-1-${file}-${version}.json`, import.meta.url), "utf8"));
    assert.equal(report.interaction_suite, suite); assert.equal(report.cases.length, 2);
    for (const item of report.cases) {
      assert.equal(item.status, "ok"); assert.equal(item.cleanup, "released"); assert.equal(item.samples.length, samples);
      for (const sample of item.samples) {
        assert.equal(sample.dom.nodes, item.fixture_nodes === 1000 ? 1124 : 18);
        for (const [key, value] of Object.entries(sample.workflow)) {
          if (key.endsWith("verified") || key.endsWith("preserved") || key.endsWith("restored")) assert.equal(value, true);
          if (value && typeof value === "object") {
            for (const [metric, number] of Object.entries(value)) if (metric.endsWith("_ms")) assert.ok(Number.isFinite(number) && number >= 0);
          }
        }
      }
    }
    for (const marker of ["/Users/", "127.0.0.1", "session_id", "password", "http://", '"id":']) assert.ok(!JSON.stringify(report).includes(marker));
  });
}
