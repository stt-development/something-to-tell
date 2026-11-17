import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { TraceMap } from "@jridgewell/trace-mapping";
import { summarizeCpu, sourceName, performanceDelta } from "./cpu.mjs";

const node = (id, url, functionName = "privateFunction", children = []) => ({
  id, children, callFrame: { url, functionName, lineNumber: 0, columnNumber: 0 }
});

test("sampling charges leaf self time once and accounts idle, GC and unknown ids", () => {
  const profile = { startTime: 0, endTime: 12000,
    nodes: [node(1, "http://localhost/src/App.tsx", "App", [2]),
      node(2, "http://localhost/src/app/graph/graphProjection.tsx"),
      node(3, "", "(idle)"), node(4, "", "(garbage collector)")],
    samples: [2, 3, 4, 99], timeDeltas: [3000, 2000, 1000, 4000] };
  const result = summarizeCpu(profile);
  assert.equal(result.sampled_ms, 10);
  assert.equal(result.unrepresented_tail_ms, 2);
  assert.equal(result.top_sources.reduce((sum, row) => sum + row.self_ms, 0), 10);
  assert.equal(result.top_sources.find((row) => row.category === "application").self_ms, 3);
  assert.ok(!JSON.stringify(result).includes("privateFunction"));
  assert.ok(!JSON.stringify(result).includes("http://"));
});

test("production maps resolve original sources with CDP zero-based line offsets", () => {
  const map = new TraceMap({ version: 3, names: [], sources: ["../../src/App.tsx"], mappings: "AAAA" });
  const result = summarizeCpu({ startTime: 0, endTime: 1000, nodes: [node(1, "http://localhost/assets/app.js?secret=1")],
    samples: [1], timeDeltas: [1000] }, new Map([["/assets/app.js", map]]));
  assert.equal(result.top_sources[0].source, "apps/web/src/App.tsx");
  assert.equal(result.top_sources[0].category, "application");
  assert.equal(result.accounting_consistent, true);
});

test("source names redact unrelated paths and normalize dependency and contract owners", () => {
  assert.equal(sourceName("/Users/private/secret.ts"), "[unmapped]");
  assert.equal(sourceName("../../node_modules/.pnpm/react-dom@18/node_modules/react-dom/cjs/react-dom.js"), "node_modules/react-dom/cjs/react-dom.js");
  assert.equal(sourceName("../../packages/contracts/src/projectDocument.ts"), "packages/contracts/src/projectDocument.ts");
});

test("missing or regressing CDP counters stay unavailable, not zero", () => {
  assert.deepEqual(performanceDelta({ metrics: [{ name: "ScriptDuration", value: 1 }] },
    { metrics: [{ name: "ScriptDuration", value: 1.25 }] }), {
    TaskDuration_ms: null, ScriptDuration_ms: 250, LayoutDuration_ms: null, RecalcStyleDuration_ms: null
  });
  assert.equal(performanceDelta({ metrics: [{ name: "TaskDuration", value: 2 }] },
    { metrics: [{ name: "TaskDuration", value: 1 }] }).TaskDuration_ms, null);
});

test("tool CPU sampling is opt-in and leaves observer-only calibration actions unchanged", () => {
  const source = readFileSync(new URL("./probe.mjs", import.meta.url), "utf8");
  const calibration = source.slice(source.indexOf('persist(`pan_${index}`)'), source.indexOf("const beforePan"));
  assert.match(calibration, /if \(config.calibration\) \{/);
  assert.match(calibration, /sample\.tool_select_feedback_ms = \(await calibratedTool\(page, "Select"\)\)\.settled_ms/);
  assert.match(calibration, /sample\.tool_pan_feedback_ms = \(await calibratedTool\(page, "Pan canvas"\)\)\.settled_ms/);
  const diagnostic = calibration.slice(calibration.indexOf("} else {"));
  assert.match(diagnostic, /if \(timeline \|\| cpu\)/);
  assert.match(diagnostic, /\[\["tool_select", "Select"\], \["tool_pan", "Pan canvas"\]\]/);
  assert.match(diagnostic, /await cpu\?\.start\(\)/);
  assert.match(diagnostic, /if \(cpu\) sample\.cpu\[name\] = await cpu\.stop\(\)/);
  assert.match(diagnostic, /if \(timeline\) sample\.browser_work\[name\] = await timeline\.stop\(\)/);
});

test("invalid timing arrays fail and top-source truncation retains residual time", () => {
  assert.throws(() => summarizeCpu({ startTime: 0, endTime: 1, samples: [1], timeDeltas: [] }));
  assert.throws(() => summarizeCpu({ startTime: 0, endTime: 1, samples: [1], timeDeltas: [-1] }));
  const inconsistent = summarizeCpu({ startTime: 0, endTime: 500, nodes: [], samples: [99], timeDeltas: [1000] });
  assert.equal(inconsistent.accounting_consistent, false);
  assert.equal(inconsistent.unrepresented_tail_ms, null);
  const profile = { startTime: 0, endTime: 14000,
    nodes: Array.from({ length: 14 }, (_, id) => node(id, `http://localhost/src/n${id}.tsx`)),
    samples: Array.from({ length: 14 }, (_, id) => id), timeDeltas: Array(14).fill(1000) };
  const result = summarizeCpu(profile);
  assert.equal(result.top_sources.length, 12);
  assert.equal(result.other_sources_ms, 2);
  assert.equal(result.by_category.reduce((sum, row) => sum + row.self_ms, 0), 14);
});

test("archived CPU actions retain source accounting and match observer-only graph inputs", () => {
  const load = (name) => JSON.parse(readFileSync(new URL(`../../../docs/verification/baselines/${name}.json`, import.meta.url), "utf8"));
  const report = load("p9-1-000b1-cpu-production-v1");
  const baseline = load("p9-1-000a-production-v1");
  assert.equal(report.instrumentation, "sampled_cpu_1000us_with_sourcemaps");
  assert.equal(report.app_source_sha256, baseline.app_source_sha256);
  assert.equal(report.cases.length, 2);
  for (const item of report.cases) {
    const control = baseline.cases.find((entry) => entry.name === item.name);
    assert.equal(item.fixture_source_sha256, control.fixture_source_sha256);
    assert.equal(item.status, "ok");
    assert.equal(item.cleanup, "released");
    assert.equal(item.samples.length, 2);
    for (const sample of item.samples) {
      assert.deepEqual(sample.dom, control.samples[0].dom);
      assert.deepEqual(Object.keys(sample.cpu), ["open", "menu", "pan", "flow"]);
      for (const profile of Object.values(sample.cpu)) {
        assert.ok(profile.accounting_consistent);
        const grouped = profile.by_category.reduce((sum, row) => sum + row.self_ms, 0);
        const sources = profile.top_sources.reduce((sum, row) => sum + row.self_ms, profile.other_sources_ms);
        assert.ok(Math.abs(grouped - profile.sampled_ms) < 1e-6);
        assert.ok(Math.abs(sources - profile.sampled_ms) < 1e-6);
        for (const row of profile.top_sources) {
          assert.equal(sourceName(row.source), row.source.startsWith("[") ? "[unmapped]" : row.source);
          assert.ok(!row.source.includes("..") && !row.source.includes("://"));
          assert.deepEqual(Object.keys(row), ["source", "category", "self_ms", "samples"]);
        }
        assert.ok(profile.main_thread.TaskDuration_ms > 0);
      }
    }
  }
});
