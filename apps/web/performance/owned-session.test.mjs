import { test } from "node:test";
import assert from "node:assert/strict";
import { assertOwnedFixture, cleanupOwnedFixture, observeCommand } from "./owned-session.mjs";
import { mkdtemp, mkdir, writeFile, unlink, rm, access } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
test("write-capable probes reject user paths and mismatched temporary project folders", () => {
  assert.doesNotThrow(() => assertOwnedFixture({ directory: "/tmp/stt-frontend-baseline-unit/fixture-small", path: "/tmp/stt-frontend-baseline-unit/fixture-small/Baseline.narrative" }));
  assert.throws(() => assertOwnedFixture({ directory: "/Users/author/.narrative", path: "/Users/author/.narrative/Aurora.narrative" }));
  assert.throws(() => assertOwnedFixture({ directory: "/tmp/stt-frontend-baseline-unit/fixture-1000", path: "/tmp/other/Baseline.narrative" }));
});
test("command observations expose numeric receipt metrics without response contents", async () => {
  const response = { ok: () => true, finished: async () => null, request: () => ({ timing: () => ({ responseEnd: 7 }) }), status: () => 200 };
  const result = await observeCommand({ waitForResponse: async () => response }, () => true, async () => {}, async () => {});
  assert.equal(result.command_response_ms, 7); assert.equal(result.status, 200);
  assert.ok(result.total_ms >= result.feedback_ms);
});
test("failed receipts and absent network timings fail instead of reporting zeros", async () => {
  for (const good of [false, true]) {
    const response = { ok: () => good, finished: async () => null, request: () => ({ timing: () => ({ responseEnd: -1 }) }) };
    await assert.rejects(observeCommand({ waitForResponse: async () => response }, () => true, async () => {}, async () => {}));
  }
});
test("failed dirty owned drills discard then close, but retain still-held folders", async () => {
  for (const release of [true, false]) {
    const root = await mkdtemp(resolve(tmpdir(), "stt-frontend-baseline-cleanup-"));
    const directory = resolve(root, "fixture-small"), path = resolve(directory, "Baseline.narrative");
    const lock = resolve(path, "cache/project.lock.json");
    await mkdir(resolve(path, "cache"), { recursive: true });
    await writeFile(lock, JSON.stringify({ session_id: "owned-only" }));
    const calls = [];
    try {
      const result = await cleanupOwnedFixture({ directory, path }, "http://probe/api", async (url) => {
        calls.push(url.split("/").at(-1));
        const ok = calls.length === 2 || calls.length === 3 && release;
        if (calls.length === 3 && release) await unlink(lock);
        return { ok, async arrayBuffer() {} };
      });
      assert.deepEqual(calls, ["close", "discard", "close"]);
      assert.equal(result, release ? "released" : "retained_locked_fixture");
      if (release) await assert.rejects(access(directory)); else await access(lock);
    } finally { await rm(root, { recursive: true, force: true }); }
  }
});
