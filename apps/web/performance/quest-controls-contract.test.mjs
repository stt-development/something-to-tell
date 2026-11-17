import { test } from "node:test";
import assert from "node:assert/strict";
import { verifyQuestControls } from "./quest-controls-contract.mjs";

test("Quest evidence retains all descriptions and cannot certify a truncated target surface", () => {
  const value = { stages: 200, descriptions: 200, selectors: 200, options: 202, max_options: 2 };
  assert.equal(verifyQuestControls(value), value);
  for (const invalid of [{ ...value, stages: 10 }, { ...value, descriptions: 0 }, { ...value, selectors: 0 },
    { ...value, options: 0 }, { ...value, options: 40000 }, { ...value, max_options: 200 }]) {
    assert.throws(() => verifyQuestControls(invalid), /incomplete_or_unbounded/);
  }
});
