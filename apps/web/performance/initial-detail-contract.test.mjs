import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { verifyInitialDetail } from "./initial-detail-contract.mjs";
test("initial card proof requires complete initial Fit and immediately readable reduced content", () => {
  const good = { nodes: 1124, ports: 4496, reduced: 1124, titled: 1124, previews: 1124, visible_previews: 1124,
    shells: 0, outside: 0, overlaps_controls: 0, frame_preview_overflow: 0 };
  assert.equal(verifyInitialDetail(good), good);
  for (const changed of [{ nodes: 1123 }, { ports: 4492 }, { reduced: 0 }, { titled: 1123 }, { previews: 0 },
    { visible_previews: 1123 }, { shells: 1 }, { outside: 1 }, { overlaps_controls: 1 }, { frame_preview_overflow: 1 }]) {
    assert.throws(() => verifyInitialDetail({ ...good, ...changed }), /initial_detail_gate_failed/);
  }
});
test("frozen initial Open/reopen matrix proves both sizes without Fit/Reveal and releases owned sessions", () => {
  const report = JSON.parse(readFileSync(new URL("../../../docs/verification/baselines/p9-1-005c4-initial-detail-v1.json", import.meta.url)));
  assert.equal(report.status, "passed"); assert.equal(report.quick, false); assert.equal(report.cleanup, "released");
  assert.equal(report.build_mode, "unoverridden_production_default");
  assert.deepEqual(report.cases.map((row) => row.viewport.width).sort(), [1024, 1440]);
  for (const row of report.cases) {
    assert.equal(row.status, "ok"); assert.equal(row.step, "complete"); assert.equal(row.page_errors, 0); assert.equal(row.write_attempts, 0);
    assert.equal(row.released_sessions, 2); assert.equal(row.document_unchanged, true); assert.equal(row.no_explicit_fit_or_reveal, true);
    assert.deepEqual(Object.keys(row.stages), ["first_open", "reopen"]);
    for (const stage of Object.values(row.stages)) { verifyInitialDetail(stage); assert.equal(stage.titled, 1124); assert.equal(stage.visible_previews, 1124); }
  }
});
