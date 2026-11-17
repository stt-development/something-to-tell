import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { APPROVED_TOOL_INTERACTION_DEFAULT, toolInteractionGatePlugin } from "./tool-interaction-contract.mjs";

test("approved tool default is On and exact Off rollback rejects ambiguous or absent build overrides", () => {
  const source = readFileSync(new URL("../src/app/graph/canvasToolInteraction.ts", import.meta.url), "utf8");
  const id = "/src/app/graph/canvasToolInteraction.ts";
  assert.equal(APPROVED_TOOL_INTERACTION_DEFAULT, true);
  const on = toolInteractionGatePlugin(true), off = toolInteractionGatePlugin(false);
  assert.ok(on.transform(source, id).includes("EXPERIMENT_ENABLED = true;")); on.buildEnd();
  assert.ok(off.transform(source, id).includes("EXPERIMENT_ENABLED = false;")); off.buildEnd();
  assert.equal(toolInteractionGatePlugin(true).transform(source, "/src/other.ts"), undefined);
  assert.throws(() => toolInteractionGatePlugin(true).buildEnd());
  assert.throws(() => toolInteractionGatePlugin(true).transform(source.repeat(2), id));
  assert.throws(() => toolInteractionGatePlugin(true).transform("renamed", id));
  assert.throws(() => toolInteractionGatePlugin("true"));
});
