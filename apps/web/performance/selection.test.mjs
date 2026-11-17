import { test } from "node:test";
import assert from "node:assert/strict";
import { runInNewContext } from "node:vm";
import { readFileSync } from "node:fs";
import { visibleSelectionTarget, measureSelection } from "./selection.mjs";

function title(id, x, { covered = false, button = false, width = 80 } = {}) {
  const node = { getAttribute: () => id };
  return { node, covered, button,
    closest: () => node,
    getBoundingClientRect: () => ({ x, y: 0, width, height: 20 }) };
}

function documentFor(titles, selected = () => []) {
  return {
    querySelectorAll: (selector) => selector.endsWith(".selected")
      ? selected().map((id) => ({ getAttribute: () => id })) : titles,
    elementFromPoint: (x) => {
      const item = titles.find((entry) => Math.abs(entry.getBoundingClientRect().x + 20 - x) < 1);
      return !item || item.covered ? null : { closest: (selector) => selector === "button" ? (item.button ? {} : null) : item.node };
    }
  };
}

/** Minimal browser contract double, including evaluated DOM assertions and cleanup. */
function fakePage({ mismatch = false, mutation = false, failSecond = false } = {}) {
  let selected = [];
  let handler;
  let shift = false;
  let aborts = 0, fallbacks = 0, routes = 0;
  let phaseStarts = 0, phaseStops = 0;
  const titles = [title("private-A", 0), title("private-B", 100)];
  const dom = documentFor(titles, () => selected);
  const evaluate = (fn, arg) => runInNewContext(`(${fn.toString()})(arg)`, {
    arg, document: dom, requestAnimationFrame: (callback) => callback(0),
    window: { __sttPhaseProbe: { start() { phaseStarts++; }, stop() { phaseStops++; return { commits: 1 }; } } }
  });
  return {
    evaluate,
    async route(_pattern, callback) { handler = callback; routes++; },
    async unroute(_pattern, callback) { assert.equal(handler, callback); handler = null; },
    async waitForFunction(fn, arg) { assert.equal(await evaluate(fn, arg), true, "selection identity mismatch"); },
    getByRole(role, options) {
      assert.equal(role, "button");
      assert.equal(options.name, "Select");
      return { async click() {} };
    },
    keyboard: {
      async press(key) { assert.equal(key, "Escape"); selected = []; },
      async down(key) { assert.equal(key, "Shift"); shift = true; },
      async up(key) { assert.equal(key, "Shift"); shift = false; }
    },
    mouse: { async click(x) {
      if (failSecond && shift) throw new Error("click_failed");
      await handler({ request: () => ({ method: () => mutation ? "POST" : "GET" }),
        async abort() { aborts++; }, async fallback() { fallbacks++; } });
      const id = x < 100 ? "private-A" : mismatch ? "wrong-target" : "private-B";
      selected = shift ? [...selected, id] : [id];
    } },
    state: () => ({ selected, shift, handler, aborts, fallbacks, routes, phaseStarts, phaseStops })
  };
}

test("hit testing rejects covered, excluded, zero-size and button-intercepted titles", () => {
  const titles = [title("covered", 0, { covered: true }), title("button", 100, { button: true }),
    title("zero", 200, { width: 0 }), title("excluded", 300), title("usable", 400)];
  assert.deepEqual(visibleSelectionTarget("excluded", documentFor(titles)), { id: "usable", x: 420, y: 10 });
  assert.throws(() => visibleSelectionTarget(null, documentFor([title(null, 0), title("hidden", 100, { covered: true })])));
});
test("hit testing considers both current full and reduced visible headers", () => {
  const candidate = title("reduced", 100), dom = documentFor([candidate]);
  const read = dom.querySelectorAll;
  dom.querySelectorAll = (selector) => { assert.ok(selector.includes(".narrative-node-title-text")); assert.ok(selector.includes(".node-detail-title")); return read(selector); };
  assert.deepEqual(visibleSelectionTarget(null, dom), { id: "reduced", x: 120, y: 10 });
});

test("selection driver verifies real identities, records counts only and releases protection", async () => {
  const page = fakePage();
  let starts = 0, stops = 0;
  const cpu = { async start() { starts++; }, async stop() { stops++; return { sampled_ms: 1 }; } };
  const result = await measureSelection(page, { cpu, phases: true });
  assert.deepEqual([result.single.selected_count, result.multi.selected_count, result.clear.selected_count], [1, 2, 0]);
  assert.equal(result.blocked_mutations, 0);
  for (const action of [result.single, result.multi, result.clear]) {
    assert.ok(Number.isFinite(action.feedback_ms) && action.feedback_ms >= 0);
    assert.equal(action.cpu.sampled_ms, 1);
    assert.equal(action.phases.commits, 1);
  }
  assert.ok(!JSON.stringify(result).includes("private-"));
  assert.deepEqual({ ...page.state(), handler: Boolean(page.state().handler) }, {
    selected: [], shift: false, handler: false, aborts: 0, fallbacks: 2, routes: 1, phaseStarts: 3, phaseStops: 3
  });
  assert.equal(starts, 3); assert.equal(stops, 3);
});

test("wrong identities fail even when selected counts match", async () => {
  const page = fakePage({ mismatch: true });
  await assert.rejects(measureSelection(page), /selection identity mismatch/);
  assert.equal(page.state().handler, null);
  assert.equal(page.state().shift, false);
});

test("selection windows abort writes and reject the run instead of accepting censored timings", async () => {
  const page = fakePage({ mutation: true });
  await assert.rejects(measureSelection(page), /selection_attempted_mutation/);
  assert.equal(page.state().aborts, 2);
  assert.equal(page.state().fallbacks, 0);
  assert.equal(page.state().handler, null);
});

test("failed Shift clicks release the modifier and route handler", async () => {
  const page = fakePage({ failSecond: true });
  await assert.rejects(measureSelection(page), /click_failed/);
  assert.equal(page.state().shift, false);
  assert.equal(page.state().handler, null);
});

test("archived selection cases verify counts on unchanged pinned graph workloads", () => {
  const load = (name) => JSON.parse(readFileSync(new URL(`../../../docs/verification/baselines/${name}.json`, import.meta.url), "utf8"));
  const report = load("p9-1-000b3a-selection-production-v1");
  const control = load("p9-1-000b2-observer-control-v1");
  assert.equal(report.interaction_suite, "selection_v1");
  assert.equal(report.instrumentation, "baseline_observers");
  assert.equal(report.phase_bundle_hooks_present, false);
  assert.equal(report.app_source_sha256, control.app_source_sha256);
  assert.equal(report.cases.length, 2);
  for (let index = 0; index < report.cases.length; index++) {
    const item = report.cases[index];
    assert.equal(item.fixture_source_sha256, control.cases[index].fixture_source_sha256);
    assert.equal(item.status, "ok");
    assert.equal(item.cleanup, "released");
    assert.equal(item.samples.length, 2);
    for (const sample of item.samples) {
      assert.deepEqual(sample.dom, control.cases[index].samples[0].dom);
      assert.deepEqual(Object.keys(sample.selection), ["flow", "graph"]);
      for (const selection of Object.values(sample.selection)) {
        assert.equal(selection.blocked_mutations, 0);
        assert.deepEqual([selection.single.selected_count, selection.multi.selected_count, selection.clear.selected_count], [1, 2, 0]);
        for (const key of ["single", "multi", "clear"]) {
          assert.deepEqual(Object.keys(selection[key]), ["feedback_ms", "selected_count"]);
          assert.ok(Number.isFinite(selection[key].feedback_ms) && selection[key].feedback_ms >= 0);
        }
      }
    }
  }
  for (const marker of ["/Users/", "127.0.0.1", "session_id", "http://", "postgresql://", '"id":']) {
    assert.ok(!JSON.stringify(report).includes(marker));
  }
});

test("supplemental selection phase evidence stays separate and has real React callbacks", () => {
  const load = (kind) => JSON.parse(readFileSync(new URL(`../../../docs/verification/baselines/p9-1-000b3a-selection-${kind}-v1.json`, import.meta.url), "utf8"));
  const normal = load("production"), profiled = load("phases");
  assert.equal(profiled.interaction_suite, "selection_v1");
  assert.equal(profiled.instrumentation, "production_react_profiler_and_sync_phases");
  assert.equal(profiled.phase_bundle_hooks_present, true);
  assert.equal(profiled.app_source_sha256, normal.app_source_sha256);
  assert.equal(profiled.probe_sha256, normal.probe_sha256);
  assert.ok(Date.parse(normal.completed_at) <= Date.parse(profiled.started_at));
  assert.equal(profiled.cases.length, 2);
  for (let index = 0; index < profiled.cases.length; index++) {
    const item = profiled.cases[index];
    assert.equal(item.fixture_source_sha256, normal.cases[index].fixture_source_sha256);
    assert.equal(item.status, "ok");
    assert.equal(item.cleanup, "released");
    assert.equal(item.samples.length, 1);
    assert.deepEqual(item.samples[0].dom, normal.cases[index].samples[0].dom);
    for (const selection of Object.values(item.samples[0].selection)) {
      assert.equal(selection.blocked_mutations, 0);
      assert.deepEqual([selection.single.selected_count, selection.multi.selected_count, selection.clear.selected_count], [1, 2, 0]);
      for (const key of ["single", "multi", "clear"]) assert.ok(selection[key].phases.react.commits > 0);
    }
  }
  assert.ok(!JSON.stringify(profiled).includes('"id":'));
});
