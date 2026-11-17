import { test } from "node:test";
import assert from "node:assert/strict";
import { verifyDialogueControls, verifyDialogueRegistryRequests } from "./dialogue-controls-contract.mjs";

test("long-dialogue control evidence cannot hide text rows or accept unbounded inactive options", () => {
  const bounded = { rows: 200, next_selectors: 201, next_options: 207, max_selector_options: 2, text_fields: 199 };
  assert.equal(verifyDialogueControls(bounded), bounded);
  const before = { ...bounded, next_options: 40401, max_selector_options: 201 };
  assert.equal(verifyDialogueControls(before, true), before);
  assert.throws(() => verifyDialogueControls(before), /unbounded/);
  for (const invalid of [{ ...bounded, rows: 0 }, { ...bounded, next_selectors: 1 },
    { ...bounded, text_fields: 0 }, { ...bounded, next_options: 0 }]) {
    assert.throws(() => verifyDialogueControls(invalid), /incomplete/);
  }
});

test("two editor mounts share only overlapping registry requests and cannot hide a storm", () => {
  assert.equal(verifyDialogueRegistryRequests(1), 1); assert.equal(verifyDialogueRegistryRequests(2), 2);
  for (const invalid of [0, 3, 406, NaN, 1.5]) assert.throws(() => verifyDialogueRegistryRequests(invalid), /unbounded/);
});
