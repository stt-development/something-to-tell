import { test } from "node:test";
import assert from "node:assert/strict";
import { runInNewContext } from "node:vm";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { readFileSync } from "node:fs";
import { settledViewport, measureZoom, zoomFailureCode } from "./zoom.mjs";

/** Drive deterministic browser frames without faking the observed settling result. */
function observe(sequence, options = {}, { missing = false, invalidCss = false, stepMs = 16 } = {}) {
  let frames = 0;
  return runInNewContext(`(${settledViewport.toString()})(options)`, {
    options, performance: { now: () => frames * stepMs },
    requestAnimationFrame(callback) { frames++; callback(); },
    document: { querySelector: () => missing ? null : {} },
    getComputedStyle: () => ({ transform: "matrix" }),
    DOMMatrixReadOnly: class {
      constructor() {
        if (invalidCss) throw new Error("invalid_css");
        const value = sequence[Math.min(frames - 1, sequence.length - 1)];
        Object.assign(this, { a: value.zoom, e: value.x, f: value.y });
      }
    }
  });
}
const camera = (zoom, x = 10) => ({ x, y: 20, zoom });

test("viewport requires requested direction and three stable full transforms", async () => {
  const result = await observe([camera(1), camera(1.1), camera(1.2), camera(1.2), camera(1.2)],
    { before: camera(1), direction: 1 });
  assert.equal(result.observed_frames, 5);
  assert.equal(result.viewport.zoom, 1.2);
  assert.equal((await observe([camera(1)], {})).observed_frames, 3);
  const delayed = await observe([camera(1), camera(1), camera(1), camera(0.8)], { minimumMs: 350 });
  assert.equal(delayed.viewport.zoom, 0.8);
  assert.ok(delayed.observed_frames >= 22);
});

test("unchanged/wrong-direction/continuously moving viewports hit the frame bound", async () => {
  for (const sequence of [[camera(1)], [camera(0.8)], Array.from({ length: 6 }, (_, x) => camera(1.2, x))]) {
    await assert.rejects(observe(sequence, { before: camera(1), direction: 1, maxFrames: 6 }), /zoom_settle_exceeded/);
  }
});

test("wall deadline, absent viewport, invalid matrices and CSS parser errors reject", async () => {
  await assert.rejects(observe([camera(1)], {}, { stepMs: 2000 }), /zoom_settle_exceeded/);
  await assert.rejects(observe([camera(1)], {}, { missing: true }), /zoom_viewport_unavailable/);
  await assert.rejects(observe([camera(NaN)]), /zoom_viewport_invalid/);
  await assert.rejects(observe([camera(0)]), /zoom_viewport_invalid/);
  await assert.rejects(observe([camera(1)], {}, { invalidCss: true }), /invalid_css/);
  assert.throws(() => observe([camera(1)], { maxFrames: 181 }), /invalid_zoom_observation/);
  assert.throws(() => observe([camera(1)], { direction: 1 }), /invalid_zoom_observation/);
  assert.throws(() => observe([camera(1)], { minimumMs: Infinity }), /invalid_zoom_observation/);
});

test("only allowlisted failure codes enter reports, not paths or arbitrary messages", () => {
  assert.equal(zoomFailureCode(new Error("zoom_round_trip_not_restored")), "zoom_round_trip_not_restored");
  assert.equal(zoomFailureCode({ message: "page.evaluate: Error: zoom_settle_exceeded\nprivate stack" }), "zoom_settle_exceeded");
  assert.equal(zoomFailureCode(new Error("/Users/private/project")), undefined);
  assert.equal(zoomFailureCode(new Error("private zoom_settle_exceeded")), undefined);
});

function fakePage({ method = "GET", countChange = false, drift = false, failClick = false } = {}) {
  let viewport = camera(0.5), handler, aborts = 0, fallbacks = 0;
  let starts = 0, stops = 0;
  const counts = { nodes: 18, edges: 12, minimap_shapes: 18, selected_nodes: 0 };
  return {
    async route(_pattern, callback) { handler = callback; },
    async unroute(_pattern, callback) { assert.equal(handler, callback); handler = null; },
    evaluate(fn, arg) {
      if (fn === settledViewport) return observe([viewport], arg);
      return runInNewContext(`(${fn.toString()})()`, {
        document: { querySelectorAll: (selector) => ({ length: counts[{
          ".react-flow__node": "nodes", ".react-flow__edge": "edges", ".react-flow__minimap-node": "minimap_shapes",
          ".react-flow__node.selected": "selected_nodes"
        }[selector]] }) },
        window: { __sttPhaseProbe: { start() { starts++; }, stop() { stops++; return { commits: 1 }; } } }
      });
    },
    locator(selector) { return { async click() {
      if (failClick) throw new Error("click_failed");
      await handler({ request: () => ({ method: () => method }), async abort() { aborts++; }, async fallback() { fallbacks++; } });
      if (selector === ".react-flow__controls-zoomin") viewport = camera(viewport.zoom * 1.2);
      else {
        assert.equal(selector, ".react-flow__controls-zoomout");
        viewport = camera(viewport.zoom / 1.2, drift ? 11 : 10);
        if (countChange) counts.nodes--;
      }
    } }; },
    state: () => ({ handler, aborts, fallbacks, starts, stops })
  };
}

test("UI round trip checks counts, composes profilers and never serializes coordinates", async () => {
  const page = fakePage({ method: "HEAD" });
  let starts = 0, stops = 0;
  const cpu = { async start() { starts++; }, async stop() { stops++; return { sampled_ms: 1 }; } };
  const result = await measureZoom(page, { cpu, phases: true });
  assert.equal(result.zoom_in.zoom_before, 0.5);
  assert.equal(result.zoom_in.zoom_after, 0.6);
  assert.equal(result.zoom_out.zoom_after, 0.5);
  assert.equal(result.round_trip_restored, true);
  assert.equal(result.blocked_mutations, 0);
  assert.deepEqual({ ...result.rendered_before }, { ...result.rendered_after });
  for (const action of [result.zoom_in, result.zoom_out]) {
    assert.ok(Number.isFinite(action.settled_ms) && action.settled_ms >= 0);
    assert.equal(action.observed_frames, 3);
    assert.equal(action.cpu.sampled_ms, 1);
    assert.equal(action.phases.commits, 1);
  }
  assert.equal(starts, 2); assert.equal(stops, 2);
  assert.deepEqual(page.state(), { handler: null, aborts: 0, fallbacks: 2, starts: 2, stops: 2 });
  assert.ok(!JSON.stringify(result).includes('"x":') && !JSON.stringify(result).includes('"y":'));
});

test("writes are blocked and fail the drill, never accepted as fast samples", async () => {
  const page = fakePage({ method: "POST" });
  await assert.rejects(measureZoom(page), /zoom_attempted_mutation/);
  assert.deepEqual(page.state(), { handler: null, aborts: 2, fallbacks: 0, starts: 0, stops: 0 });
});

test("count drift, camera drift and click failures release request protection", async () => {
  for (const [options, error] of [[{ countChange: true }, /zoom_rendered_counts_changed/],
    [{ drift: true }, /zoom_round_trip_not_restored/], [{ failClick: true }, /click_failed/]]) {
    const page = fakePage(options);
    await assert.rejects(measureZoom(page), error);
    assert.equal(page.state().handler, null);
  }
});

test("CLI rejects combining interaction suites before opening projects", () => {
  const result = spawnSync(process.execPath, [fileURLToPath(new URL("./run.mjs", import.meta.url)), "--zoom", "--selection"],
    { encoding: "utf8", timeout: 5000 });
  assert.equal(result.error, undefined);
  assert.equal(result.status, 1);
  assert.ok(result.stderr.includes("choose_one_interaction_suite"));
});

const archive = (kind) => JSON.parse(readFileSync(new URL(`../../../docs/verification/baselines/p9-1-000b3b1-zoom-${kind}-v1.json`, import.meta.url), "utf8"));

test("zoom archive preserves workload counts, direction, restoration and report privacy", () => {
  const report = archive("production");
  const control = JSON.parse(readFileSync(new URL("../../../docs/verification/baselines/p9-1-000b2-observer-control-v1.json", import.meta.url), "utf8"));
  assert.equal(report.interaction_suite, "zoom_v1");
  assert.equal(report.instrumentation, "baseline_observers");
  assert.equal(report.phase_bundle_hooks_present, false);
  assert.equal(report.app_source_sha256, control.app_source_sha256);
  assert.equal(report.cases.length, 2);
  for (let index = 0; index < report.cases.length; index++) {
    const item = report.cases[index];
    assert.equal(item.fixture_source_sha256, control.cases[index].fixture_source_sha256);
    assert.equal(item.status, "ok"); assert.equal(item.cleanup, "released");
    assert.equal(item.samples.length, 2);
    for (const sample of item.samples) {
      assert.deepEqual(sample.dom, control.cases[index].samples[0].dom);
      assert.deepEqual(Object.keys(sample.zoom), ["flow", "graph"]);
      for (const [mode, zoom] of Object.entries(sample.zoom)) {
        assert.equal(zoom.blocked_mutations, 0);
        assert.equal(zoom.round_trip_restored, true);
        assert.deepEqual(zoom.rendered_before, zoom.rendered_after);
        assert.equal(zoom.rendered_after.nodes, mode === "graph" ? sample.dom.nodes : sample.flow_dom_nodes);
        assert.ok(zoom.zoom_in.zoom_after > zoom.zoom_in.zoom_before);
        assert.ok(zoom.zoom_out.zoom_after < zoom.zoom_out.zoom_before);
        assert.ok(Math.abs(zoom.zoom_out.zoom_after - zoom.zoom_in.zoom_before) <= 1e-3);
        for (const key of ["zoom_in", "zoom_out"]) {
          const action = zoom[key];
          assert.ok(Number.isFinite(action.settled_ms) && action.settled_ms >= 0);
          assert.ok(action.observed_frames >= 3 && action.observed_frames <= 180);
          assert.deepEqual(Object.keys(action), ["settled_ms", "zoom_before", "zoom_after", "observed_frames"]);
        }
      }
    }
  }
  for (const marker of ["/Users/", "127.0.0.1", "session_id", "http://", "postgresql://", '"x":', '"y":']) {
    assert.ok(!JSON.stringify(report).includes(marker));
  }
});

test("supplemental zoom profiling remains separate from ordinary button latency", () => {
  const normal = archive("production"), profile = archive("phases");
  assert.equal(profile.interaction_suite, "zoom_v1");
  assert.equal(profile.instrumentation, "production_react_profiler_and_sync_phases");
  assert.equal(profile.phase_bundle_hooks_present, true);
  assert.equal(profile.app_source_sha256, normal.app_source_sha256);
  assert.equal(profile.probe_sha256, normal.probe_sha256);
  assert.ok(Date.parse(normal.completed_at) <= Date.parse(profile.started_at));
  assert.equal(profile.cases.length, 2);
  for (let index = 0; index < profile.cases.length; index++) {
    const item = profile.cases[index];
    assert.equal(item.fixture_source_sha256, normal.cases[index].fixture_source_sha256);
    assert.equal(item.status, "ok"); assert.equal(item.cleanup, "released");
    assert.equal(item.samples.length, 1);
    for (const zoom of Object.values(item.samples[0].zoom)) {
      assert.equal(zoom.blocked_mutations, 0); assert.equal(zoom.round_trip_restored, true);
      assert.deepEqual(zoom.rendered_before, zoom.rendered_after);
      for (const key of ["zoom_in", "zoom_out"]) assert.ok(zoom[key].phases.react.commits > 0);
    }
  }
  assert.ok(!JSON.stringify(profile).includes('"x":') && !JSON.stringify(profile).includes('"y":'));
});
