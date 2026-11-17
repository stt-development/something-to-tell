import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import postcss from "postcss";

test("ineffective idle shadow trial remains rejected and original CSS is restored", () => {
  const read = name => JSON.parse(readFileSync(new URL(`../../../docs/verification/baselines/${name}.json`, import.meta.url)));
  const trial = read("p9-1-011k-rejected-shadow"), control = read("p9-1-011i-sqlite");
  const row = trial.cases[0], original = control.cases.find(item => item.fixture_nodes === 1000);
  assert.notEqual(trial.app_source_sha256, control.app_source_sha256);
  assert.deepEqual(row.geometry, original.geometry);
  assert.equal(row.status, "ok"); assert.equal(row.cleanup, "released");
  assert.equal(row.samples.length, 21);
  assert.equal(row.calibration.criteria.filter(item => item.state === "exceeds_target").length, 5);
  for (const [file, selector, expected] of [
    ["canvas-nodes.css", ".narrative-node", "0 10px 24px rgb(15 23 42 / 10%)"],
    ["canvas-frames.css", ".narrative-node-frame", "0 8px 20px rgb(15 23 42 / 7%)"]]) {
    const css = postcss.parse(readFileSync(new URL(`../src/styles/${file}`, import.meta.url), "utf8"));
    const rules = css.nodes.filter(node => node.selector === selector);
    assert.equal(rules.length, 1);
    assert.equal(rules[0].nodes.find(node => node.prop === "box-shadow").value, expected);
  }
});
