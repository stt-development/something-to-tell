import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { runInNewContext } from "node:vm";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import ts from "typescript";
import { createPhaseCollector, PHASE_NAMES } from "./phases.mjs";
import { instrumentPhaseSource, phaseProbePlugin, PHASE_TARGETS } from "./phases-plugin.mjs";

test("collector has bounded fixed scopes, ignores inactive work and counts committed renders", () => {
  let time = 0;
  const probe = createPhaseCollector(() => time);
  probe.begin("store_prepare")();
  probe.onRender("private-id", "mount", 999);
  probe.start();
  const finish = probe.begin("snapshot_projection");
  time = 4;
  finish(); finish();
  probe.onRender("private-id", "mount", 3, 100, 0, 4);
  probe.onRender("private-id", "nested-update", 2);
  const result = probe.stop();
  assert.deepEqual(Object.keys(result.phases), PHASE_NAMES);
  assert.deepEqual(result.phases.snapshot_projection, { count: 1, total_ms: 4, max_ms: 4 });
  assert.equal(result.phases.store_prepare.count, 0);
  assert.equal(result.react.commits, 2);
  assert.equal(result.react.render_actual_ms, 5);
  assert.equal(result.react.render_max_ms, 3);
  assert.equal(result.react.by_phase["nested-update"], 1);
  assert.ok(!JSON.stringify(result).includes("private-id"));
  assert.equal(result.client_document_validation, "not_present_in_open_path");
  result.react.commits = 99;
  assert.equal(probe.stop().react.commits, 2);
});

test("new action windows discard late completions and do not subtract overlapping scopes", () => {
  let time = 0;
  const probe = createPhaseCollector(() => time);
  probe.start();
  const late = probe.begin("store_prepare");
  probe.start();
  late();
  const outer = probe.begin("workspace_projection");
  const inner = probe.begin("view_filter");
  time = 3; inner();
  time = 5; outer();
  const result = probe.stop();
  assert.equal(result.phases.store_prepare.count, 0);
  assert.equal(result.phases.workspace_projection.total_ms, 5);
  assert.equal(result.phases.view_filter.total_ms, 3);
});

test("collector rejects unknown labels, invalid durations and regressing clocks", () => {
  let time = 3;
  const probe = createPhaseCollector(() => time);
  assert.throws(() => probe.begin("authored title"));
  probe.start();
  assert.throws(() => probe.onRender("app", "unknown", 1));
  assert.throws(() => probe.onRender("app", "update", NaN));
  const end = probe.begin("store_prepare");
  time = 0;
  assert.throws(end);
});

test("AST wrapper preserves return identity, this and thrown errors with finally accounting", () => {
  const source = `export function runtimeSnapshotState(value: any) {
    if (value.fail) throw value.fail;
    return this.identity;
  }`;
  const code = instrumentPhaseSource(source, "state/graphStore.ts");
  const probe = createPhaseCollector(() => 1);
  const exports = {};
  runInNewContext(ts.transpileModule(code, { compilerOptions: { module: ts.ModuleKind.CommonJS } }).outputText,
    { exports, require: () => ({ probe }) });
  const identity = {};
  const failure = new Error("original");
  probe.start();
  assert.equal(exports.runtimeSnapshotState.call({ identity }, {}), identity);
  assert.throws(() => exports.runtimeSnapshotState({ fail: failure }), (error) => error === failure);
  assert.equal(probe.stop().phases.store_prepare.count, 2);
});

test("target drift, duplicate roots and async scopes fail rather than report zeros", () => {
  assert.equal(instrumentPhaseSource("untouched", "elsewhere.ts"), null);
  assert.throws(() => instrumentPhaseSource("export function renamed() {}", "state/graphStore.ts"));
  assert.throws(() => instrumentPhaseSource("async function runtimeSnapshotState() {}", "state/graphStore.ts"));
  assert.throws(() => instrumentPhaseSource("const root = <><App /><App /></>;", "main.tsx"));
  assert.throws(() => instrumentPhaseSource("function runtimeSnapshotState( {", "state/graphStore.ts"));
});

test("all real targets remain parseable and normal Vite/main sources contain no hooks", () => {
  for (const owner of [...Object.keys(PHASE_TARGETS), "main.tsx"]) {
    const original = readFileSync(new URL("../src/" + owner, import.meta.url), "utf8");
    assert.ok(!original.includes("__sttPhaseProbe"));
    const code = instrumentPhaseSource(original, owner);
    const ast = ts.createSourceFile(owner, code, ts.ScriptTarget.Latest, true,
      owner.endsWith(".tsx") ? ts.ScriptKind.TSX : ts.ScriptKind.TS);
    assert.equal(ast.parseDiagnostics.length, 0);
    if (owner === "main.tsx") assert.ok(code.includes('<__sttProfiler id="app"'));
  }
  const config = readFileSync(new URL("../vite.config.ts", import.meta.url), "utf8");
  assert.ok(!config.includes("phaseProbePlugin") && !config.includes("react-dom/profiling"));
});

test("diagnostic plugin is build-only, scoped and fails missing modules", () => {
  const plugin = phaseProbePlugin();
  assert.equal(plugin.apply, "build");
  assert.equal(plugin.transform("untouched", "/tmp/other/main.tsx"), null);
  assert.throws(() => plugin.buildEnd());
  assert.doesNotThrow(() => plugin.buildEnd(new Error("already failed")));
  assert.equal(plugin.resolveId("react"), undefined);
  assert.ok(plugin.load(plugin.resolveId("virtual:stt-phase-probe")).includes("window.__sttPhaseProbe"));
});

test("root CLI pins Tailwind working directory and fingerprints the consumed static rendering policy", () => {
  const source = readFileSync(new URL("./run.mjs", import.meta.url), "utf8");
  assert.ok(source.includes("process.chdir(web);"));
  assert.ok(source.indexOf("process.chdir(web);") < source.indexOf("await build({ root: web"));
  assert.ok(source.includes('.concat("apps/web/performance/rendering-policy.v1.json")'));
});

test("CLI rejects mixed CPU/phase instrumentation and development phases before setup", () => {
  const runner = fileURLToPath(new URL("./run.mjs", import.meta.url));
  for (const flags of [["--phases", "--cpu"], ["--phases", "--mode=development"]]) {
    const result = spawnSync(process.execPath, [runner, ...flags], { encoding: "utf8", timeout: 5000 });
    assert.equal(result.error, undefined);
    assert.equal(result.status, 1);
    assert.ok(result.stderr.includes("phases_require_separate_production_run"));
  }
});

test("archived phase/control runs are sequential, isolated and preserve graph counts", () => {
  const load = (kind) => JSON.parse(readFileSync(new URL(`../../../docs/verification/baselines/p9-1-000b2-${kind}-v1.json`, import.meta.url), "utf8"));
  const profile = load("phases-production"), control = load("observer-control");
  assert.equal(profile.instrumentation, "production_react_profiler_and_sync_phases");
  assert.equal(control.instrumentation, "baseline_observers");
  assert.equal(profile.phase_bundle_hooks_present, true);
  assert.equal(control.phase_bundle_hooks_present, false);
  assert.equal(profile.app_source_sha256, control.app_source_sha256);
  assert.equal(profile.probe_sha256, control.probe_sha256);
  assert.ok(Date.parse(profile.completed_at) <= Date.parse(control.started_at));
  assert.equal(profile.cases.length, 2);
  assert.equal(control.cases.length, 2);
  for (let index = 0; index < profile.cases.length; index++) {
    const item = profile.cases[index], comparison = control.cases[index];
    assert.equal(item.fixture_source_sha256, comparison.fixture_source_sha256);
    for (const entry of [item, comparison]) {
      assert.equal(entry.status, "ok");
      assert.equal(entry.cleanup, "released");
      assert.equal(entry.samples.length, 2);
    }
    for (let sampleIndex = 0; sampleIndex < 2; sampleIndex++) {
      const sample = item.samples[sampleIndex], normal = comparison.samples[sampleIndex];
      assert.deepEqual(sample.dom, normal.dom);
      assert.equal(sample.flow_dom_nodes, normal.flow_dom_nodes);
      assert.equal(sample.dom.nodes, item.fixture_nodes === 1000 ? 1124 : 18);
      assert.equal(normal.phases, undefined);
      assert.deepEqual(Object.keys(sample.phases), ["open", "menu", "pan", "flow"]);
      assert.ok(sample.phases.open.react.commits > 0);
      assert.equal(sample.phases.open.phases.snapshot_projection.count, 1);
      assert.equal(sample.phases.open.phases.store_prepare.count, 1);
      for (const action of Object.values(sample.phases)) {
        assert.deepEqual(Object.keys(action.phases), PHASE_NAMES);
        assert.equal(action.client_document_validation, "not_present_in_open_path");
        assert.equal(action.react.commits, Object.values(action.react.by_phase).reduce((a, b) => a + b, 0));
        for (const row of Object.values(action.phases)) assert.ok(row.total_ms >= row.max_ms && row.max_ms >= 0);
      }
    }
  }
  for (const report of [profile, control]) {
    for (const marker of ["/Users/", "127.0.0.1", "session_id", "sourcesContent", "http://", "postgresql://"]) {
      assert.ok(!JSON.stringify(report).includes(marker));
    }
  }
});
