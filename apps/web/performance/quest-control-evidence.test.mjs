import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

test("Quest and touched Dialogue gates share current source, retain text and release both sizes", () => {
  const read = (name) => JSON.parse(readFileSync(new URL(`../../../docs/verification/frontend-performance/${name}`, import.meta.url)));
  const quest = read("p9-1-008b-quest-controls.json"), dialogue = read("p9-1-008b-dialogue-compatibility.json");
  assert.equal(quest.app_source_sha256, dialogue.app_source_sha256);
  assert.equal(quest.fixture_variant, "long_quest_v1"); assert.equal(dialogue.fixture_variant, "long_dialogue_v1");
  for (const report of [quest, dialogue]) {
    assert.equal(report.status, "passed"); assert.equal(report.cleanup, "released"); assert.equal(report.build_mode, "unoverridden_production_default");
    assert.deepEqual(report.cases.map((row) => row.viewport.width), [1440, 1024]);
    for (const row of report.cases) {
      assert.equal(row.status, "ok"); assert.equal(row.document_unchanged, true); assert.equal(row.registry_requests, 2);
      assert.equal(row.unexpected_writes, 0); assert.equal(row.page_errors, 0); assert.equal(row.session_released, true);
      if (report === quest) {
        assert.equal(row.own_stage_excluded, true); assert.equal(row.draft_and_style_return, true); assert.equal(row.internal_external_outcome_state, true);
        for (const stage of Object.values(row.stages)) { assert.equal(stage.stages, 200); assert.equal(stage.descriptions, 200); assert.ok(stage.max_options <= 2); }
      }
    }
  }
});
