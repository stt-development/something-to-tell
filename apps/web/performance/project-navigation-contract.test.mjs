import { test } from "node:test";
import assert from "node:assert/strict";
import { verifyProjectNavigation } from "./project-navigation-contract.mjs";

test("navigation evidence requires mounted bounded rows and complete scroll extent", () => {
  const valid = [{ mounted: 17, total: 1000, height: 288, extent: 24000 }];
  assert.equal(verifyProjectNavigation(valid), valid);
  for (const invalid of [[], [{ ...valid[0], mounted: 1000 }], [{ ...valid[0], mounted: 0 }],
    [{ ...valid[0], total: 80 }], [{ ...valid[0], extent: 288 }], [{ ...valid[0], height: 0 }]]) {
    assert.throws(() => verifyProjectNavigation(invalid), /unbounded_or_incomplete/);
  }
});
