import { build, preview } from "vite";
import { execFileSync } from "node:child_process";
import { mkdtemp, mkdir, readFile, writeFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import { tmpdir } from "node:os";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";
import { spreadPlacements } from "./rendering-policy.mjs";
import { guardedWorker } from "./guard.mjs";
import { cleanupOwnedFixture } from "./owned-session.mjs";
import { APPROVED_GRAPH_CARD_DEFAULT, compareCardLayouts, viewportCardGatePlugin, VIEWPORT_CARD_SUITE } from "./viewport-cards-contract.mjs";

const { values } = parseArgs({ options: { report: { type: "string" }, quick: { type: "boolean" } } });
const web = resolve(dirname(fileURLToPath(import.meta.url)), ".."), repository = resolve(web, "../..");
const root = await mkdtemp(resolve(tmpdir(), "stt-frontend-baseline-viewport-"));
const output = resolve(values.report ?? resolve(root, "report.json"));
// Tailwind's existing content paths are relative to the web package's cwd.
process.chdir(web);
const runtime = "http://127.0.0.1:8719/api", fixtures = [], servers = [];
const report = { report_version: 1, suite: VIEWPORT_CARD_SUITE, started_at: new Date().toISOString(),
  commit: execFileSync("git", ["rev-parse", "HEAD"], { cwd: repository, encoding: "utf8" }).trim(),
  worktree_dirty: Boolean(execFileSync("git", ["status", "--porcelain"], { cwd: repository, encoding: "utf8" }).trim()),
  source_gate_enabled: APPROVED_GRAPH_CARD_DEFAULT, cases: [], comparisons: [], cleanup: [],
  limits: ["Read-only Graph geometry/navigation only; not Flow/authoring/LOD/latency acceptance", "Body counts may differ; wrappers/Handles/edges/labels/MiniMap geometry must not"] };
const fingerprint = (value) => createHash("sha256").update(JSON.stringify(value)).digest("hex");
const observations = new Map();
process.env.VITE_RUNTIME_URL = "/api";
try {
  const health = await fetch(`${runtime}/health`, { signal: AbortSignal.timeout(5000) });
  if (!health.ok) throw new Error("viewport_card_runtime_unavailable");
  report.runtime = await health.json();
  report.environment = { platform: process.platform, node: process.version };
  const appFiles = execFileSync("git", ["ls-files", "--cached", "--others", "--exclude-standard", "apps/web/src", "packages/contracts/src"],
    { cwd: repository, encoding: "utf8" }).trim().split("\n");
  const appHash = createHash("sha256");
  for (const file of [...new Set(appFiles)].sort()) appHash.update(file).update("\0").update(await readFile(resolve(repository, file))).update("\0");
  report.app_source_sha256 = appHash.digest("hex");
  const harnessHash = createHash("sha256");
  for (const file of ["viewport-cards-run.mjs", "viewport-cards-probe.mjs", "viewport-cards-contract.mjs", "rendering-policy.mjs", "rendering-policy.v1.json", "owned-session.mjs", "guard.mjs", "zoom.mjs", "workflow-observation.mjs"]) {
    harnessHash.update(file).update("\0").update(await readFile(resolve(web, "performance", file))).update("\0");
  }
  report.harness_sha256 = harnessHash.digest("hex");
  const denseDir = resolve(root, "fixture-1000");
  const dense = JSON.parse(execFileSync("uv", ["run", "python", "-m", "services.runtime.scripts.prepare_frontend_baseline", denseDir, "--size", "1000"],
    { cwd: repository, encoding: "utf8", timeout: 60000 }).trim());
  fixtures.push(dense);
  const source = JSON.parse(await readFile(resolve(denseDir, "source.json"), "utf8"));
  dense.render_count = source.placements.length + source.nodes.filter((node) => !source.placements.some((p) => p.canonical_node_id === node.id)).length;
  const before = fingerprint(source);
  const spreadDir = resolve(root, "stt-frontend-baseline-spread", "fixture-1000");
  await mkdir(spreadDir, { recursive: true });
  const spread = { ...dense, directory: spreadDir, path: resolve(spreadDir, "Baseline.narrative") };
  fixtures.push(spread);
  await writeFile(resolve(spreadDir, "source.json"), JSON.stringify({ ...source, placements: spreadPlacements(source.placements) }));
  if (fingerprint(source) !== before) throw new Error("viewport_card_source_mutated");
  execFileSync("uv", ["run", "python", "-m", "services.runtime.scripts.import_project_fixture", resolve(spreadDir, "source.json"), spread.path],
    { cwd: repository, encoding: "utf8", timeout: 60000 });
  const matrix = values.quick ? [["root_grid_v1", spread, { width: 1440, height: 900 }]]
    : [["pinned_original_overlap", dense], ["root_grid_v1", spread]].flatMap(([variant, fixture]) =>
      [{ width: 1440, height: 900 }, { width: 1024, height: 768 }].map((viewport) => [variant, fixture, viewport]));
  report.fixture_source_sha256 = dense.source_sha256;
  report.source_document_sha256 = before;
  report.quick = Boolean(values.quick);
  for (const enabled of [false, true]) {
    const dist = resolve(root, `dist-${enabled}`);
    await build({ root: web, plugins: [viewportCardGatePlugin(enabled)], build: { outDir: dist, emptyOutDir: true } });
    const server = await preview({ root: web, build: { outDir: dist }, preview: { host: "127.0.0.1", port: 0,
      proxy: { "/api": { target: "http://127.0.0.1:8719", changeOrigin: true } } } });
    servers.push(server);
    const url = `http://127.0.0.1:${server.httpServer.address().port}`;
    for (const [variant, fixture, viewport] of matrix) {
      const name = `${variant}-${viewport.width}-${enabled ? "shell" : "full"}`;
      const artifacts = resolve(root, name); await mkdir(artifacts);
      const result = resolve(artifacts, "result.json"), config = resolve(artifacts, "config.json");
      await writeFile(config, JSON.stringify({ url, fixture, viewport, enabled, artifacts, result }));
      const outcome = await guardedWorker(process.execPath, [resolve(web, "performance/viewport-cards-probe.mjs"), config], 180000);
      const raw = await readFile(result, "utf8").then(JSON.parse).catch(() => ({ step: "launch" }));
      const { stages = {}, error_message, ...summary } = raw;
      report.cases.push({ name, variant, viewport, enabled, ...summary, ...outcome,
        stages: Object.fromEntries(Object.entries(stages).map(([stage, value]) => [stage, { counts: value.counts, visible_shells: value.visible_shells,
          invalid_handle_bounds: value.invalid_handle_bounds, geometry_sha256: fingerprint(value.geometry) }])) });
      observations.set(name, stages);
      console.log(JSON.stringify({ name, status: outcome.status, step: raw.step, artifacts }));
      await mkdir(dirname(output), { recursive: true }); await writeFile(output, JSON.stringify(report, null, 2));
      if (outcome.status !== "ok") throw new Error("viewport_card_browser_gate_failed");
    }
  }
  for (const [variant, , viewport] of matrix) {
    const key = `${variant}-${viewport.width}`, full = observations.get(`${key}-full`), shell = observations.get(`${key}-shell`);
    report.comparisons.push({ variant, viewport, stages: Object.fromEntries(Object.keys(full).map((stage) => [stage, compareCardLayouts(full[stage], shell[stage])])) });
  }
  if (report.comparisons.some((entry) => Object.values(entry.stages).some((value) => !value.equal))) throw new Error("viewport_card_comparison_failed");
  if (report.cases.filter((entry) => entry.enabled).some((entry) => !Object.values(entry.stages).some((stage) => stage.counts.shells > 0))) {
    throw new Error("viewport_card_no_shells_observed");
  }
  report.status = "passed";
} catch (error) {
  report.status = "failed"; report.error_code = /^viewport_card_[a-z_]+$/.test(error.message) ? error.message : "probe_preparation_failed";
  process.exitCode = 1;
} finally {
  for (const fixture of fixtures) report.cleanup.push(await cleanupOwnedFixture(fixture, runtime).catch(() => "failed"));
  for (const server of servers) await new Promise((resolve) => server.httpServer.close(resolve));
  if (report.cleanup.some((status) => status !== "released")) { report.status = "failed"; process.exitCode = 1; }
  report.completed_at = new Date().toISOString();
  await mkdir(dirname(output), { recursive: true }); await writeFile(output, JSON.stringify(report, null, 2) + "\n");
  console.log(JSON.stringify({ report: output, artifacts: root, status: report.status, cleanup: report.cleanup }));
}
