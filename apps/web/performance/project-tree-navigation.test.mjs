import { test } from "node:test";
import assert from "node:assert/strict";
import { projectTreeButton } from "./project-tree-navigation.mjs";

function fixture({ target = 80, count = 100, opened = true } = {}) {
  let focus = 0, start = 0, presses = 0, opens = 0;
  const targetButton = { count: async () => target >= start && target < start + 16 && target < count ? 1 : 0 };
  const cursor = { locator() { return cursor; }, getAttribute: async () => String(focus) };
  const extent = { first() { return extent; }, getAttribute: async () => String(count) };
  const first = { first() { return first; }, focus: async () => { focus = start; } };
  const list = { locator(selector) { return selector === "button" ? first : selector === "button:focus" ? cursor : extent; } };
  const page = {
    evaluate: async (fn, id) => { assert.match(String(fn), /CSS.escape/); assert.equal(id, "target-id"); return "target-id"; },
    locator(selector) { return selector === ".project-tree-row" ? { count: async () => opened ? 16 : 0 } : targetButton; },
    getByTitle: () => ({ click: async () => { opened = true; opens++; } }),
    getByRole: () => list,
    keyboard: { press: async (key) => { presses++; focus = key === "Home" ? 0 : Math.min(focus + 12, count - 1); start = focus; } }
  };
  return { page, targetButton, stats: () => ({ presses, opens }) };
}

test("tree driver opens the rail and reaches distant identity through bounded native key steps", async () => {
  const f = fixture({ opened: false });
  assert.equal(await projectTreeButton(f.page, "target-id"), f.targetButton);
  assert.deepEqual(f.stats(), { presses: 7, opens: 1 });
});
test("an already-mounted exact target needs no keyboard or state inspection", async () => {
  const f = fixture({ target: 3 });
  assert.equal(await projectTreeButton(f.page, "target-id"), f.targetButton); assert.equal(f.stats().presses, 0);
});
test("absent identity or invalid extent fails rather than choosing a same-named visible row", async () => {
  const missing = fixture({ target: 999 });
  await assert.rejects(projectTreeButton(missing.page, "target-id"), /project_tree_target_missing/);
  assert.ok(missing.stats().presses < 12);
  const invalid = fixture({ count: NaN });
  await assert.rejects(projectTreeButton(invalid.page, "target-id"), /project_tree_extent_invalid/);
});
