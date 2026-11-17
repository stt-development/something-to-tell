import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

test("frozen registry evidence preserves failed before gate and complete two-size acceptance", () => {
  const read = (file) => JSON.parse(readFileSync(new URL(`../../../docs/verification/frontend-performance/${file}`, import.meta.url)));
  const before = read("p9-1-008a2-registry-storm.json"), after = read("p9-1-008d-dialogue-registry.json");
  assert.equal(before.status, "failed"); assert.equal(before.cleanup, "released");
  assert.equal(before.cases[0].registry_requests, 406); assert.equal(before.cases[0].close_requests, 1);
  assert.equal(after.fixture_source_sha256, before.fixture_source_sha256);
  assert.equal(after.fixture_variant, "long_dialogue_v1"); assert.equal(after.build_mode, "unoverridden_production_default");
  assert.equal(after.status, "passed"); assert.equal(after.cleanup, "released");
  assert.deepEqual(after.cases.map((row) => row.viewport.width), [1440, 1024]);
  for (const row of after.cases) {
    assert.equal(row.status, "ok"); assert.equal(row.registry_requests, 2); assert.equal(row.close_requests, 1);
    assert.equal(row.close_status, 200); assert.equal(row.before_close_status, "clean"); assert.equal(row.session_released, true);
    assert.equal(row.document_unchanged, true); assert.equal(row.unexpected_writes, 0); assert.equal(row.page_errors, 0);
    assert.equal(row.native_tab_and_pointer_focus, true); assert.equal(row.public_distant_option_selection, true); assert.equal(row.local_style_return, true);
    for (const stage of Object.values(row.stages)) {
      assert.equal(stage.rows, 200); assert.equal(stage.text_fields, 199); assert.equal(stage.next_selectors, 201);
      assert.ok(stage.next_options <= 402); assert.ok(stage.max_selector_options <= 2);
    }
  }
});
