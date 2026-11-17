import assert from "node:assert/strict";
import test from "node:test";
import { EventEmitter } from "node:events";
import { spawnSync } from "node:child_process";
import { BROWSER_WORK_EVENTS, createBrowserWorkCollector, createBrowserWorkRecorder } from "./browser-work.mjs";

const thread = (pid = 1, tid = 2) => ({ ph: "M", name: "thread_name", pid, tid, args: { name: "CrRendererMain" } });
const event = (name, ts, dur, extra = {}) => ({ name, ts, dur, pid: 1, tid: 2, ph: "X", ...extra });

test("nested and overlapping main-thread events have union accounting, not summed CPU", () => {
  const collector = createBrowserWorkCollector();
  collector.collect([thread(), event("Paint", 0, 10000), event("Paint", 2000, 1000),
    event("PrePaint", 8000, 4000), event("Paint", 20000, 2000), event("Paint", 0, 90000, { tid: 7 })]);
  const result = collector.summarize();
  assert.equal(result.state, "observed"); assert.equal(result.allowlisted_union_ms, 14);
  assert.equal(result.main_event_count, 4);
  assert.deepEqual(result.events.find((row) => row.name === "Paint"), { name: "Paint", count: 3, timed_count: 3, instant_count: 0, union_ms: 12, inclusive_ms: 13, max_ms: 10 });
  assert.ok(result.unobserved_events.includes("HitTest"));
});

test("instant events are counts with unavailable duration, never fabricated zero timing", () => {
  const collector = createBrowserWorkCollector();
  collector.collect([thread(), event("Layerize", 0, undefined, { ph: "I" })]);
  const result = collector.summarize();
  assert.equal(result.state, "observed"); assert.equal(result.allowlisted_union_ms, null);
  assert.deepEqual(result.events[0], { name: "Layerize", count: 1, timed_count: 0, instant_count: 1,
    union_ms: null, inclusive_ms: null, max_ms: null });
});

test("trace chunks discard secrets, unknown names, arguments and all raw thread identities", () => {
  const collector = createBrowserWorkCollector();
  collector.collect([event("secret-project-name", 0, 1000), event("Layout", 0, 1000, { args: { url: "https://secret", text: "private text" } })]);
  collector.collect([thread()]);
  const text = JSON.stringify(collector.summarize());
  for (const secret of ["secret", "private", "args", "pid", "tid", "https"]) assert.ok(!text.includes(secret));
  assert.equal(collector.summarize().events.length, 1);
});

test("missing, ambiguous, lossy and invalid evidence is unavailable rather than zero", () => {
  for (const [rows, loss, reason] of [
    [[], false, "renderer_main_ambiguous_or_missing"],
    [[thread(), thread(3, 4)], false, "renderer_main_ambiguous_or_missing"],
    [[thread()], false, "no_allowlisted_main_events"],
    [[thread(), event("Paint", 0, -1)], false, "unsupported_event"],
    [[thread(), event("Paint", 0, 1)], true, "trace_data_loss"]
  ]) {
    const collector = createBrowserWorkCollector(); collector.collect(rows);
    assert.deepEqual(collector.summarize(loss), { state: "unavailable", reason });
  }
  const collector = createBrowserWorkCollector(); collector.collect([thread(), event("Paint", 0, 1, { ph: "B" })]);
  assert.deepEqual(collector.summarize(), { state: "unavailable", reason: "unsupported_event",
    unsupported_shapes: [{ name: "Paint", phase: "B", count: 1 }] });
});

test("bounded collection does not certify a truncated trace", () => {
  for (const limit of [0, -1, Infinity, 50001]) assert.throws(() => createBrowserWorkCollector(limit));
  const collector = createBrowserWorkCollector(2);
  collector.collect([thread(), ...Array.from({ length: 3 }, () => event("HitTest", 0, 1000))]);
  assert.deepEqual(collector.summarize(), { state: "unavailable", reason: "event_limit" });
  assert.ok(BROWSER_WORK_EVENTS.every((name) => /^[A-Za-z]+$/.test(name)));
});

test("CDP recorder resets between actions, removes listeners and never persists raw chunks", async () => {
  const cdp = new EventEmitter();
  const calls = [];
  cdp.send = async (method, payload) => {
    calls.push({ method, payload });
    if (method === "Tracing.end") {
      cdp.emit("Tracing.dataCollected", { value: [thread(), event("HitTest", 0, 1000, { args: { secret: "private" } })] });
      cdp.emit("Tracing.tracingComplete", { dataLossOccurred: false });
    }
  };
  const recorder = await createBrowserWorkRecorder({ context: () => ({ newCDPSession: async () => cdp }) });
  for (let index = 0; index < 2; index++) {
    await recorder.start();
    const result = await recorder.stop();
    assert.equal(result.state, "observed"); assert.equal(result.main_event_count, 1);
    assert.ok(!JSON.stringify(result).includes("private"));
    assert.equal(cdp.listenerCount("Tracing.dataCollected"), 0);
    assert.equal(cdp.listenerCount("Tracing.tracingComplete"), 0);
  }
  assert.equal(calls.filter((call) => call.method === "Tracing.start").length, 2);
  assert.equal(calls[0].payload.transferMode, "ReportEvents");
});

test("failed CDP start/end do not leave trace listeners behind", async () => {
  for (const fail of ["Tracing.start", "Tracing.end"]) {
    const cdp = new EventEmitter();
    cdp.send = async (method) => { if (method === fail) throw new Error("owned_cdp_failure"); };
    const recorder = await createBrowserWorkRecorder({ context: () => ({ newCDPSession: async () => cdp }) });
    if (fail === "Tracing.start") await assert.rejects(recorder.start(), /owned_cdp_failure/);
    else { await recorder.start(); await assert.rejects(recorder.stop(), /owned_cdp_failure/); }
    assert.equal(cdp.listenerCount("Tracing.dataCollected"), 0);
    assert.equal(cdp.listenerCount("Tracing.tracingComplete"), 0);
  }
});

test("trace CLI rejects mixed/unsupported modes before owned fixture preparation", () => {
  for (const extra of [["--cpu"], ["--phases"], ["--calibration"], ["--workflow", "navigation"],
    ["--zoom"], ["--selection"], ["--mode", "development"]]) {
    const result = spawnSync(process.execPath, [new URL("./run.mjs", import.meta.url).pathname, "--trace", ...extra], { encoding: "utf8" });
    assert.equal(result.status, 1);
    assert.match(result.stderr, /invalid_(?:trace|calibration)_options/);
    assert.ok(!result.stdout.includes("Sanitized report"));
  }
});
