import { test } from "node:test";
import assert from "node:assert/strict";
import { observeAction, observeActionWithPhases, centeredTreeTarget, hoveredTargetPorts, waitStartScreen, treeNodeForLabel } from "./workflow-observation.mjs";

test("observations wait for verification and retain no action return payload", async () => {
  let time = 0;
  const result = await observeAction(async () => { time = 2; return { private: "body" }; }, async () => { time = 5; }, () => time);
  assert.deepEqual(result, { settled_ms: 5 });
});
test("failed actions, failed verification and invalid clocks never yield success timing", async () => {
  await assert.rejects(observeAction(async () => { throw new Error("action"); }, async () => {}), /action/);
  await assert.rejects(observeAction(async () => {}, async () => { throw new Error("verification"); }), /verification/);
  let time = 1;
  await assert.rejects(observeAction(async () => { time = 0; }, async () => {}, () => time), /invalid_action_clock/);
});

test("optional action attribution starts before work and always stops without accepting failures", async () => {
  const calls = [];
  const collector = { start: async () => calls.push("start"), stop: async () => { calls.push("stop"); return { count: 3 }; } };
  const value = await observeActionWithPhases(async () => calls.push("work"), async () => calls.push("verify"), collector);
  assert.deepEqual(calls, ["start", "work", "verify", "stop"]); assert.deepEqual(value.phases, { count: 3 });
  calls.length = 0;
  await assert.rejects(observeActionWithPhases(async () => { throw Error("failed"); }, async () => {}, collector), /failed/);
  assert.deepEqual(calls, ["start", "stop"]);
  const plain = await observeActionWithPhases(async () => {}, async () => {});
  assert.equal(Object.hasOwn(plain, "phases"), false);
});
test("tree focus checks the intended node against actual canvas center", () => {
  const node = { getAttribute: () => "private-id", getBoundingClientRect: () => ({ x: 40, y: 40, width: 20, height: 20 }) };
  const dom = { querySelectorAll: () => [node], querySelector: () => ({ getBoundingClientRect: () => ({ x: 0, y: 0, width: 100, height: 100 }) }) };
  assert.equal(centeredTreeTarget("private-id", dom), true);
  assert.equal(centeredTreeTarget("absent", dom), false);
  node.getBoundingClientRect = () => ({ x: 100, y: 100, width: 20, height: 20 });
  assert.equal(centeredTreeTarget("private-id", dom), false);
});
test("hover cannot pass for absent/hidden/incomplete attachment ports", () => {
  let ports = [];
  const dom = { querySelectorAll: () => [{ getAttribute: () => "target", querySelectorAll: () => ports }] };
  const style = (port) => port;
  assert.equal(hoveredTargetPorts("target", dom, style), false);
  ports = Array.from({ length: 4 }, () => ({ opacity: "1" }));
  assert.equal(hoveredTargetPorts("target", dom, style), true);
  ports[0].opacity = "0";
  assert.equal(hoveredTargetPorts("target", dom, style), false);
  assert.equal(hoveredTargetPorts("absent", dom, style), false);
});
test("close readiness cannot be satisfied by the workspace sidebar Open button", async () => {
  let waited = false;
  await waitStartScreen({ getByRole(role, options) {
    assert.equal(role, "heading"); assert.deepEqual(options, { name: "Projects", exact: true });
    return { async waitFor(options) { assert.equal(options.state, "visible"); waited = true; } };
  } });
  assert.equal(waited, true);
});
test("tree navigation resolves exact full or reduced title identity, not an absent or different alias", () => {
  const full = { getAttribute: () => "full-id", querySelector: (selector) => selector === ".narrative-node-title" ? { getAttribute: () => "Lore: Full" } : null };
  const reduced = { getAttribute: () => "reduced-id", querySelector: (selector) => selector === ".node-detail-title" ? { textContent: "Lore: Reduced" } : null };
  const dom = { querySelectorAll: () => [full, reduced] };
  assert.equal(treeNodeForLabel("Lore: Full", dom), "full-id"); assert.equal(treeNodeForLabel("Lore: Reduced", dom), "reduced-id");
  assert.equal(treeNodeForLabel("Lore: Missing", dom), null); assert.equal(treeNodeForLabel("Lore: Red", dom), null);
});
