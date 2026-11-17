import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { TraceMap, originalPositionFor } from "@jridgewell/trace-mapping";

/** Allow repository/dependency source names only, never filesystem or origin data. */
export function sourceName(value) {
  const path = value.replaceAll("\\", "/").split("?")[0];
  const dependency = path.lastIndexOf("node_modules/");
  if (dependency >= 0) return "node_modules/" + path.slice(dependency + 13);
  for (const prefix of ["apps/web/src/", "packages/contracts/src/"]) {
    const index = path.indexOf(prefix);
    if (index >= 0) return path.slice(index);
  }
  if (/^(?:\/|(?:\.\.\/)*|\.\/)?src\//.test(path)) return "apps/web/" + path.slice(path.indexOf("src/"));
  return "[unmapped]";
}

function category(source) {
  if (source.startsWith("apps/") || source.startsWith("packages/")) return "application";
  if (source.startsWith("node_modules/react-dom/") || source.startsWith("node_modules/react/")) return "react_runtime";
  if (source.startsWith("node_modules/@xyflow/")) return "react_flow";
  if (source.startsWith("node_modules/zustand/")) return "zustand";
  return source.startsWith("node_modules/") ? "other_dependency" : source.slice(1, -1);
}

function frameSource(frame, maps) {
  if (frame.functionName === "(idle)") return "[idle]";
  if (frame.functionName === "(garbage collector)") return "[gc]";
  if (frame.functionName === "(program)") return "[browser_system]";
  if (!frame.url) return "[unmapped]";
  let path;
  try { path = new URL(frame.url).pathname; } catch { return "[unmapped]"; }
  const map = maps.get(path);
  if (map && frame.lineNumber >= 0 && frame.columnNumber >= 0) {
    const original = originalPositionFor(map, { line: frame.lineNumber + 1, column: frame.columnNumber });
    return original.source ? sourceName(original.source) : "[unmapped]";
  }
  // Dev modules have source paths; a minified release bundle without a map does not.
  return sourceName(path);
}

/** Charge each timeDelta to its sampled leaf once, not every parent in the stack. */
export function summarizeCpu(profile, maps = new Map()) {
  const { samples = [], timeDeltas = [], nodes = [], startTime, endTime } = profile;
  if (samples.length !== timeDeltas.length || !Number.isFinite(startTime) || !Number.isFinite(endTime)
      || endTime < startTime || timeDeltas.some((value) => !Number.isFinite(value) || value < 0)) {
    throw new Error("invalid_cpu_profile");
  }
  const sources = new Map(nodes.map((node) => [node.id, frameSource(node.callFrame, maps)]));
  const totals = new Map();
  for (let index = 0; index < samples.length; index++) {
    const source = sources.get(samples[index]) ?? "[unmapped]";
    const row = totals.get(source) ?? { source, category: category(source), self_ms: 0, samples: 0 };
    row.self_ms += timeDeltas[index] / 1000;
    row.samples++;
    totals.set(source, row);
  }
  const all = [...totals.values()].sort((a, b) => b.self_ms - a.self_ms || a.source.localeCompare(b.source));
  const groups = new Map();
  for (const row of all) groups.set(row.category, (groups.get(row.category) ?? 0) + row.self_ms);
  const sampledMs = timeDeltas.reduce((sum, value) => sum + value, 0) / 1000;
  const windowMs = (endTime - startTime) / 1000;
  return {
    profile_window_ms: windowMs, sampled_ms: sampledMs, sample_count: samples.length,
    accounting_consistent: sampledMs <= windowMs,
    unrepresented_tail_ms: sampledMs <= windowMs ? windowMs - sampledMs : null,
    by_category: [...groups].map(([name, self_ms]) => ({ category: name, self_ms })),
    top_sources: all.slice(0, 12),
    other_sources_ms: all.slice(12).reduce((sum, row) => sum + row.self_ms, 0)
  };
}

/** CDP duration counters overlap CPU samples: report alongside, never add them. */
export function performanceDelta(before, after) {
  const start = new Map(before.metrics.map((entry) => [entry.name, entry.value]));
  const end = new Map(after.metrics.map((entry) => [entry.name, entry.value]));
  return Object.fromEntries(["TaskDuration", "ScriptDuration", "LayoutDuration", "RecalcStyleDuration"].map((name) => {
    const a = start.get(name), b = end.get(name);
    return [name + "_ms", a !== undefined && b !== undefined && b >= a ? (b - a) * 1000 : null];
  }));
}

export async function createCpuRecorder(page, dist) {
  const maps = new Map();
  if (dist) {
    for (const name of readdirSync(join(dist, "assets")).filter((entry) => entry.endsWith(".js.map"))) {
      const data = JSON.parse(readFileSync(join(dist, "assets", name), "utf8"));
      delete data.sourcesContent;
      maps.set("/assets/" + name.slice(0, -4), new TraceMap(data));
    }
  }
  const cdp = await page.context().newCDPSession(page);
  await cdp.send("Performance.enable");
  await cdp.send("Profiler.enable");
  await cdp.send("Profiler.setSamplingInterval", { interval: 1000 });
  let before;
  return {
    async start() {
      before = await cdp.send("Performance.getMetrics");
      await cdp.send("Profiler.start");
    },
    async stop() {
      const after = await cdp.send("Performance.getMetrics");
      const { profile } = await cdp.send("Profiler.stop");
      return { ...summarizeCpu(profile, maps), main_thread: performanceDelta(before, after) };
    }
  };
}
