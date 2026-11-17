import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { APPROVED_TARGET_SELECTABLE_DEFAULT, selectableGatePlugins } from "./selectable-contract.mjs";

test("approved selectable default is On, with fixed011p and exact verified Off rollback", () => {
  const tool = readFileSync(new URL("../src/app/graph/canvasToolInteraction.ts", import.meta.url), "utf8");
  const selection = readFileSync(new URL("../src/app/graph/CanvasSelectableReactFlow.tsx", import.meta.url), "utf8");
  assert.equal(APPROVED_TARGET_SELECTABLE_DEFAULT, true);
  for (const enabled of [false, true]) {
    const [stable, selectable] = selectableGatePlugins(enabled);
    assert.ok(stable.transform(tool, "/src/app/graph/canvasToolInteraction.ts").includes("EXPERIMENT_ENABLED = true;"));
    stable.buildEnd();
    assert.ok(selectable.transform(selection, "/src/app/graph/CanvasSelectableReactFlow.tsx")
      .includes(`SELECTABLE_EXPERIMENT_ENABLED = ${enabled};`));
    selectable.buildEnd();
  }
  assert.throws(() => selectableGatePlugins("true"));
  assert.throws(() => selectableGatePlugins(true)[1].buildEnd());
  assert.throws(() => selectableGatePlugins(true)[1].transform(selection.repeat(2), "/src/app/graph/CanvasSelectableReactFlow.tsx"));
  assert.equal(selectableGatePlugins(true)[1].transform(selection, "/src/app/other.tsx"), undefined);
});
