import { build, createServer, preview } from "vite";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { mkdtemp, mkdir, readFile, readdir, writeFile, rm } from "node:fs/promises";
import { tmpdir, cpus, platform, release } from "node:os";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";
import { guardedWorker } from "./guard.mjs";
import { phaseProbePlugin } from "./phases-plugin.mjs";
import { cleanupOwnedFixture } from "./owned-session.mjs";
import { startPostgres, preparePostgresFixture } from "./postgres.mjs";
import { calibrationSummary } from "./calibration.mjs";
import { probeRuntimeOrigin } from "./probe-runtime.mjs";

const web = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const repository = resolve(web, "../..");
const { values: options } = parseArgs({ options: {
  mode: { type: "string" }, samples: { type: "string" }, guard: { type: "string" }, trace: { type: "boolean" }, "fixture-variant": { type: "string" },
  size: { type: "string" }, report: { type: "string" }, quick: { type: "boolean" }, cpu: { type: "boolean" }, phases: { type: "boolean" }, selection: { type: "boolean" }, zoom: { type: "boolean" }, workflow: { type: "string" }, storage: { type: "string" }, calibration: { type: "boolean" }
} });
const mode = options.mode ?? "production";
const fixtureVariant = options["fixture-variant"];
if (fixtureVariant && (fixtureVariant !== "root_grid_v1" || options.size !== "1000" || options.workflow)) throw new Error("invalid_fixture_variant");
const samples = Number(options.samples ?? (options.calibration ? 21 : 2));
const guardMs = Number(options.guard ?? (options.calibration ? 300000 : 60000));
if (options.calibration && (mode !== "production" || options.cpu || options.trace || options.phases || options.workflow || options.zoom || options.selection || samples !== 21)) throw new Error("invalid_calibration_options");
if (options.trace && (mode !== "production" || options.cpu || options.phases || options.workflow || options.zoom || options.selection)) throw new Error("invalid_trace_options");
const storage = options.storage ?? "local_sqlite";
if (!["local_sqlite", "postgresql"].includes(storage) || storage === "postgresql" && options.workflow) throw new Error("invalid_acquisition_storage_options");
if ([options.zoom, options.selection, options.workflow].filter(Boolean).length > 1) throw new Error("choose_one_interaction_suite");
if (options.workflow && !["navigation", "node-authoring", "connections", "lifecycle"].includes(options.workflow)) throw new Error("invalid_workflow");
if (options.phases && (options.cpu || mode !== "production")) throw new Error("phases_require_separate_production_run");
if (!["production", "development"].includes(mode) || (options.size && !["small", "1000"].includes(options.size))
    || !Number.isInteger(samples) || samples < 1 || samples > 21
    || !Number.isInteger(guardMs) || guardMs < 1000 || guardMs > 300000) throw new Error("invalid_baseline_options");
const root = await mkdtemp(resolve(tmpdir(), "stt-frontend-baseline-"));
const reportPath = resolve(options.report ?? resolve(root, "report.json"));
// Tailwind content globs are cwd-relative: root invocation must match pnpm's web cwd.
process.chdir(web);
const runtimeOrigin = probeRuntimeOrigin();
const runtime = runtimeOrigin + "/api";
process.env.VITE_RUNTIME_URL = "/api";
let server;
let database;
const prepared = [];
const sourceHash = createHash("sha256");
const sourceFiles = execFileSync("git", ["ls-files", "--cached", "--others", "--exclude-standard", "apps/web/src", "packages/contracts/src"],
  { cwd: repository, encoding: "utf8" }).trim().split("\n").concat("apps/web/performance/rendering-policy.v1.json");
for (const file of [...new Set(sourceFiles)].sort()) sourceHash.update(file).update("\0").update(readFileSync(resolve(repository, file))).update("\0");
const probeHash = createHash("sha256");
for (const file of ["run.mjs", "probe-runtime.mjs", "probe.mjs", "metrics.mjs", "guard.mjs", "cpu.mjs", "browser-work.mjs", "phases.mjs", "phases-plugin.mjs", "selection.mjs", "zoom.mjs", "navigation.mjs", "workflow-observation.mjs", "authoring.mjs", "owned-session.mjs", "connections.mjs", "lifecycle.mjs", "postgres.mjs", "calibration.mjs"]) probeHash.update(readFileSync(resolve(web, "performance", file)));
const report = { report_version: 1, mode, commit: execFileSync("git", ["rev-parse", "HEAD"], { cwd: repository, encoding: "utf8" }).trim(),
  started_at: new Date().toISOString(), probe_sha256: probeHash.digest("hex"), storage_mode: storage,
  app_source_sha256: sourceHash.digest("hex"),
  ...(fixtureVariant ? { fixture_variant: fixtureVariant } : {}),
  app_static_sources: ["apps/web/performance/rendering-policy.v1.json"],
  interaction_suite: options.trace ? "browser_timeline_v1" : options.calibration ? "calibration_v1" : options.workflow === "navigation" ? "navigation_v3"
    : options.workflow ? `${options.workflow}_v1` : options.zoom ? "zoom_v1" : options.selection ? "selection_v1" : "original_v1",
  instrumentation: options.trace ? "browser_timeline_main_thread" : options.phases ? "production_react_profiler_and_sync_phases" : options.cpu ? (mode === "production" ? "sampled_cpu_1000us_with_sourcemaps" : "sampled_cpu_1000us_with_native_sources") : "baseline_observers",
  worktree_dirty: Boolean(execFileSync("git", ["status", "--porcelain"], { cwd: repository, encoding: "utf8" }).trim()),
  environment: { os: platform(), release: release(), cpu: cpus()[0]?.model, logical_cpus: cpus().length },
  guard_ms: guardMs, targets: { menu_feedback_p95_ms: 100, pan_frame_p95_ms: 32, post_response_canvas_ms: 2000 },
  cases: [], attribution_limits: [options.phases ? "Named synchronous scopes only; React render overlaps projections and does not measure DOM commit duration; client document validation absent"
    : "No pure JSON CPU, hydration/projection or React commit separation yet",
    ...(options.phases ? ["React profiling and phase timers add overhead; compare with sequential observer-only controls, not latency acceptance"] : []),
    ...(options.trace ? ["Browser tracing adds overhead; allowlisted event intervals are inclusive, category unions overlap and are not additive CPU totals; absent events are not proof of zero work"] : []),
    ...(options.cpu ? ["Sampling and CDP introduce overhead; do not compare profiled latency directly with observer-only baselines",
      "Sampled leaf time includes idle/browser buckets; main-thread duration counters overlap and must not be added"] : []),
    "Only disposable fixtures; resource wait includes server and network, not isolated SQL CPU", "Small sample counts are observations, not p95 acceptance"] };

/** Release only our fixture sessions; never delete a project still held by runtime. */
async function cleanup(fixture) {
  return cleanupOwnedFixture(fixture, runtime);
}

try {
  if (storage === "postgresql") database = await startPostgres(repository);
  const proxy = { "/api": { target: runtimeOrigin, changeOrigin: true } };
  const dist = resolve(root, "dist");
  if (mode === "production") {
    await build({ root: web,
      ...(options.phases ? { plugins: [phaseProbePlugin()], resolve: { alias: [{ find: /^react-dom$/, replacement: "react-dom/profiling" }] } } : {}),
      build: { outDir: dist, emptyOutDir: true, sourcemap: Boolean(options.cpu) } });
    // Check the actual emitted code, not just the source config, for hook isolation.
    const bundles = (await readdir(resolve(dist, "assets"))).filter((name) => name.endsWith(".js"));
    let hasPhaseHooks = false;
    for (const name of bundles) hasPhaseHooks ||= (await readFile(resolve(dist, "assets", name), "utf8")).includes("__sttPhaseProbe");
    if (hasPhaseHooks !== Boolean(options.phases)) throw new Error("phase_bundle_isolation_failed");
    report.phase_bundle_hooks_present = hasPhaseHooks;
    server = await preview({ root: web, build: { outDir: dist }, preview: { host: "127.0.0.1", port: 0, proxy } });
  } else {
    server = await createServer({ root: web, server: { host: "127.0.0.1", port: 0, proxy } });
    await server.listen();
  }
  const address = server.httpServer.address();
  const url = `http://127.0.0.1:${address.port}`;
  for (const size of (options.size ? [options.size] : ["small", "1000"])) {
    const directory = resolve(root, `fixture-${size}`);
    const raw = execFileSync("uv", ["run", "python", "-m", "services.runtime.scripts.prepare_frontend_baseline", directory, "--size", size,
      ...(fixtureVariant ? ["--variant", fixtureVariant] : [])],
      { cwd: repository, encoding: "utf8", timeout: 60000, stdio: ["ignore", "pipe", "ignore"] });
    const fixture = JSON.parse(raw.trim());
    prepared.push(fixture);
    if (database) {
      try { Object.assign(fixture, await preparePostgresFixture(fixture, runtime, database.connection)); }
      catch (error) {
        report.cases.push({ name: `${mode}-${size}-preparation`, fixture_nodes: fixture.node_count,
          fixture_source_sha256: fixture.source_sha256, geometry: fixture.geometry, storage_mode: storage,
          status: "preparation_failed", step: error.stage ?? "database_preparation", error_code: error.code ?? "unclassified", samples: [] });
        continue;
      }
    }
    let switchFixture;
    if (options.workflow === "lifecycle") {
      const switchSize = size === "small" ? "1000" : "small";
      const switchDirectory = resolve(root, `stt-frontend-baseline-switch-${size}`, `fixture-${switchSize}`);
      switchFixture = JSON.parse(execFileSync("uv", ["run", "python", "-m", "services.runtime.scripts.prepare_frontend_baseline", switchDirectory, "--size", switchSize],
        { cwd: repository, encoding: "utf8", timeout: 60000, stdio: ["ignore", "pipe", "ignore"] }).trim());
      prepared.push(switchFixture);
    }
    for (const variant of (options.quick || options.calibration ? ["reference"] : ["reference", "constrained", "delayed"])) {
      const name = `${mode}-${size}-${variant}`;
      const artifacts = resolve(root, name);
      await mkdir(artifacts);
      const result = resolve(artifacts, "result.json");
      const config = resolve(artifacts, "config.json");
      const viewport = variant === "constrained" ? { width: 1024, height: 768 } : { width: 1440, height: 900 };
      await writeFile(config, JSON.stringify({ url, fixture, viewport, samples, artifacts, result,
        cpu: Boolean(options.cpu), trace: Boolean(options.trace), phases: Boolean(options.phases), selection: Boolean(options.selection), zoom: Boolean(options.zoom), workflow: options.workflow, switchFixture, calibration: Boolean(options.calibration), dist: mode === "production" ? dist : null,
        delayMs: variant === "delayed" ? 1000 : 0 }));
      const outcome = await guardedWorker(process.execPath, [resolve(web, "performance/probe.mjs"), config], guardMs);
      const observation = await readFile(result, "utf8").then(JSON.parse).catch(() => ({ step: "worker_start" }));
      const value = { name, fixture_nodes: fixture.node_count, fixture_source_sha256: fixture.source_sha256,
        geometry: fixture.geometry,
        viewport, dpr: 1, storage_mode: fixture.storage_mode, collection_counts: fixture.collection_counts,
        injected_open_delay_ms: variant === "delayed" ? 1000 : 0,
        ...observation, ...outcome };
      report.cases.push(value);
      console.log(JSON.stringify({ case: name, status: value.status, step: value.step, samples: value.samples?.length ?? 0 }));
      await mkdir(dirname(reportPath), { recursive: true });
      await writeFile(reportPath, JSON.stringify(report, null, 2) + "\n");
      // A guard-exceeded renderer is not retried indefinitely in more variants.
      if (outcome.status !== "ok") break;
    }
  }
} finally {
  for (const fixture of prepared) {
    const status = await cleanup(fixture).catch(() => "cleanup_failed");
    report.cases.filter((entry) => entry.fixture_source_sha256 === fixture.source_sha256).forEach((entry) => {
      if (!entry.cleanup || entry.cleanup === "released") entry.cleanup = status;
    });
  }
  if (database) {
    report.database_cleanup = await database.stop().then(() => "released", () => "failed");
    if (report.database_cleanup !== "released") process.exitCode = 1;
  }
  await mkdir(dirname(reportPath), { recursive: true });
  report.completed_at = new Date().toISOString();
  if (options.calibration) report.cases.forEach((entry) => { entry.calibration = calibrationSummary(entry); });
  await writeFile(reportPath, JSON.stringify(report, null, 2) + "\n");
  if (server?.close) await server.close();
  else await new Promise((resolve) => server?.httpServer.close(resolve) ?? resolve());
  console.log(`Sanitized report: ${reportPath}`);
  console.log(`Disposable screenshots/artifacts: ${root}`);
}
if (report.cases.some((entry) => entry.status !== "ok" || entry.cleanup !== "released")) process.exitCode = 1;
