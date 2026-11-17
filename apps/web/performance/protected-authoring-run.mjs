import { build, preview } from "vite";
import { execFileSync } from "node:child_process";
import { mkdtemp, mkdir, readFile, writeFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import { tmpdir } from "node:os";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";
import { guardedWorker } from "./guard.mjs";
import { cleanupOwnedFixture } from "./owned-session.mjs";
import { APPROVED_GRAPH_CARD_DEFAULT, viewportCardGatePlugin } from "./viewport-cards-contract.mjs";
import { PROTECTED_AUTHORING_SUITE } from "./protected-authoring-contract.mjs";
import { PROTECTED_CONNECTIONS_SUITE } from "./protected-connections-contract.mjs";
import { PROTECTED_FRAMES_SUITE } from "./protected-frames-contract.mjs";
import { PROTECTED_LINKED_SUITE } from "./protected-linked-contract.mjs";
import { PROTECTED_FLOW_SUITE, compareFlowScopes } from "./protected-flow-contract.mjs";
import { PROTECTED_EXTREMES_SUITE, compareExtremeCases } from "./protected-extremes-contract.mjs";
import { PROTECTED_AUTOPAN_SUITE } from "./protected-autopan-contract.mjs";
import { PROTECTED_EDITORS_SUITE } from "./protected-editors-contract.mjs";
import { PROTECTED_BOUNDARY_SUITE, BOUNDARY_VARIANT } from "./protected-boundary-contract.mjs";
import { PROTECTED_FLOW_AUTHORING_SUITE } from "./protected-flow-authoring-contract.mjs";
import { EDGE_BOUNDARY_SUITE, edgeObservationPlugin, compareEdgeBoundaries } from "./edge-boundary-contract.mjs";
import { NODE_DETAIL_SUITE, DETAIL_VARIANT, APPROVED_NODE_DETAIL_DEFAULT, nodeDetailGatePlugin, compareDetailLayouts } from "./node-detail-contract.mjs";
import { MINIMAP_SUITE, APPROVED_MINIMAP_DEFAULT } from "./minimap-contract.mjs";
import { INITIAL_DETAIL_SUITE } from "./initial-detail-contract.mjs";
import { PROJECT_NAVIGATION_SUITE } from "./project-navigation-contract.mjs";
import { DIALOGUE_CONTROLS_SUITE } from "./dialogue-controls-contract.mjs";
import { QUEST_CONTROLS_SUITE } from "./quest-controls-contract.mjs";
import { RETENTION_SUITE } from "./retention-contract.mjs";
import { probeRuntimeOrigin } from "./probe-runtime.mjs";
import { NODE_DOM_SUITE, APPROVED_NODE_DOM_DEFAULT, nodeDomGatePlugin, compareDomScopes } from "./node-dom-contract.mjs";
import { APPROVED_TOOL_INTERACTION_DEFAULT, toolInteractionGatePlugin } from "./tool-interaction-contract.mjs";
import { APPROVED_TARGET_SELECTABLE_DEFAULT, selectableGatePlugins } from "./selectable-contract.mjs";

const { values } = parseArgs({ options: { report: { type: "string" }, quick: { type: "boolean" }, workflow: { type: "string" } } });
// Existing authoring remains the default; explicit scenario selection cannot
// silently turn a mistyped workflow into another write-capable UI drill.
const workflows = {
  "selectable-working": { suite: "target_selectable_working_v1", module: "node-dom", stableTool: true, selectableTrial: true, candidateName: "selectable", compare: compareDomScopes,
    fixtureVariant: "root_grid_v1", files: ["selectable-contract.mjs", "tool-interaction-contract.mjs", "project-tree-navigation.mjs", "protected-flow-dom.mjs", "protected-flow-contract.mjs", "calibration.mjs", "metrics.mjs", "rendering-policy.mjs", "rendering-policy.v1.json", "../../../services/runtime/scripts/prepare_frontend_baseline.py"],
    limits: ["Incremental011q Off/On with011p fixed On; release source defaults On", "Native keyboard/Shift/pointer parity, complete document, eight working timings not p95 acceptance"] },
  "selectable-dense": { suite: "target_selectable_dense_v1", module: "node-dom", stableTool: true, selectableTrial: true, candidateName: "selectable", compare: compareDomScopes,
    files: ["selectable-contract.mjs", "tool-interaction-contract.mjs", "project-tree-navigation.mjs", "protected-flow-dom.mjs", "protected-flow-contract.mjs", "calibration.mjs", "metrics.mjs"],
    limits: ["Original dense input;011p fixed On and only011q varied in test builds", "Native keyboard/Shift/pointer and complete geometry proof, not original Fit p95 acceptance"] },
  "selectable-authoring": { suite: "target_selectable_authoring_v1", module: "protected-authoring", stableTool: true, selectableTrial: true, candidateName: "selectable",
    files: ["selectable-contract.mjs", "tool-interaction-contract.mjs"], limits: ["Original1000 canary group/resize/text/Discard,011p fixed On with011q Off/On", "No default activation or performance acceptance"] },
  "selectable-connections": { suite: "target_selectable_connections_v1", module: "protected-connections", stableTool: true, selectableTrial: true, candidateName: "selectable",
    files: ["selectable-contract.mjs", "tool-interaction-contract.mjs"], limits: ["Original1000 UI connect/label/reconnect/detach,011p fixed On with011q Off/On", "No default activation or performance acceptance"] },
  "stable-tool-working": { suite: "stable_tool_working_v1", module: "node-dom", stableTool: true, candidateName: "stable", compare: compareDomScopes,
    fixtureVariant: "root_grid_v1", files: ["tool-interaction-contract.mjs", "project-tree-navigation.mjs", "protected-flow-dom.mjs", "protected-flow-contract.mjs", "calibration.mjs", "metrics.mjs", "rendering-policy.mjs", "rendering-policy.v1.json", "../../../services/runtime/scripts/prepare_frontend_baseline.py"],
    limits: ["Test-only stable drag/connect/reconnect, selectable unchanged; same spread working view Off/On", "Keyboard/Space/native pan parity, complete document; eight tool observations are not p95 acceptance"] },
  "stable-tool-dense": { suite: "stable_tool_dense_v1", module: "node-dom", stableTool: true, candidateName: "stable", compare: compareDomScopes,
    files: ["tool-interaction-contract.mjs", "project-tree-navigation.mjs", "protected-flow-dom.mjs", "protected-flow-contract.mjs", "calibration.mjs", "metrics.mjs"],
    limits: ["Original dense1000 input, test-only stable drag/connect/reconnect Off/On; DOM gate remains Off", "Native keyboard and geometry checks, not original Fit p95 acceptance"] },
  "stable-tool-authoring": { suite: "stable_tool_authoring_v1", module: "protected-authoring", stableTool: true, candidateName: "stable",
    files: ["tool-interaction-contract.mjs"], limits: ["Original1000 copy, real canary group drag, resize, text and Discard Off/On", "Graph body default unchanged, no performance or rollout acceptance"] },
  "stable-tool-connections": { suite: "stable_tool_connections_v1", module: "protected-connections", stableTool: true, candidateName: "stable",
    files: ["tool-interaction-contract.mjs"], limits: ["Original1000 copy, UI create, label, reconnect and detach Off/On", "Graph body default unchanged, no performance or rollout acceptance"] },
  "root-grid-tool-cpu": { suite: "root_grid_tool_cpu_v1", module: "node-dom", nodeDom: true, unoverridden: true, toolCpu: true,
    fixtureVariant: "root_grid_v1", files: ["project-tree-navigation.mjs", "protected-flow-dom.mjs", "protected-flow-contract.mjs", "calibration.mjs", "metrics.mjs", "cpu.mjs", "rendering-policy.mjs", "rendering-policy.v1.json", "../../../services/runtime/scripts/prepare_frontend_baseline.py"],
    limits: ["Opt-in redacted CPU attribution on ordinary working view, separate from timeline and calibration", "Three Select/Pan pairs per size with source maps; no production change or latency acceptance"] },
  "root-grid-tool-trace": { suite: "root_grid_tool_browser_work_v1", module: "node-dom", nodeDom: true, unoverridden: true, toolTrace: true,
    fixtureVariant: "root_grid_v1", files: ["project-tree-navigation.mjs", "protected-flow-dom.mjs", "protected-flow-contract.mjs", "calibration.mjs", "metrics.mjs", "browser-work.mjs", "rendering-policy.mjs", "rendering-policy.v1.json", "../../../services/runtime/scripts/prepare_frontend_baseline.py"],
    limits: ["Opt-in redacted browser-stage attribution on ordinary root-grid working view; three Select/Pan pairs per size", "Tracing adds overhead; no original Fit or p95 acceptance, no DOM activation or input policy change"] },
  "root-grid-defaults": { suite: "root_grid_default_working_v1", module: "node-dom", nodeDom: true, unoverridden: true,
    fixtureVariant: "root_grid_v1", files: ["project-tree-navigation.mjs", "protected-flow-dom.mjs", "protected-flow-contract.mjs", "calibration.mjs", "metrics.mjs", "rendering-policy.mjs", "rendering-policy.v1.json", "../../../services/runtime/scripts/prepare_frontend_baseline.py"],
    limits: ["Unmodified production default on separate root_grid_v1 input, focus a placed root Character rather than overlapping unplaced Lore", "Eight working-view tool observations, not phase p95 or experimental DOM acceptance"] },
  "root-grid-dom": { suite: "protected_root_grid_dom_v1", module: "node-dom", nodeDom: true, candidateName: "dom", compare: compareDomScopes,
    fixtureVariant: "root_grid_v1", files: ["project-tree-navigation.mjs", "protected-flow-dom.mjs", "protected-flow-contract.mjs", "calibration.mjs", "metrics.mjs", "rendering-policy.mjs", "rendering-policy.v1.json", "../../../services/runtime/scripts/prepare_frontend_baseline.py"],
    limits: ["Separate root_grid_v1 geometry diagnostic; original overlap baseline unchanged", "Eight working-view tool observations are not phase p95 acceptance; no production activation"] },
  "node-dom": { suite: NODE_DOM_SUITE, module: "node-dom", nodeDom: true, candidateName: "dom", compare: compareDomScopes,
    files: ["project-tree-navigation.mjs", "protected-flow-dom.mjs", "protected-flow-contract.mjs", "calibration.mjs", "metrics.mjs"], limits: ["Test-only default-Off/On Graph spatial DOM projection on the unchanged owned1000 fixture", "Eight conditional tool observations are not original Fit-view p95 acceptance; no occlusion cap or edge culling"] },
  "node-dom-authoring": { suite: "protected_node_dom_authoring_v1", module: "protected-authoring", nodeDom: true, candidateName: "dom",
    limits: ["Owned filtered canary create/group move/resize/edit/Discard with complete original document parity", "Graph body defaults unchanged; only the DOM gate differs, no phase latency acceptance"] },
  retention: { suite: RETENTION_SUITE, module: "retention", unoverridden: true, alternateFixture: true,
    files: ["../../../services/runtime/scripts/prepare_frontend_baseline.py"],
    limits: ["Six measured alternating owned small/1000 Open/Close cycles after two warmup cycles; equivalent closed-state CDP GC checkpoints", "Numeric heap/DOM/listener observations, not proof of arbitrary lifetime leak absence, timer counts or PostgreSQL release"] },
  "quest-controls": { suite: QUEST_CONTROLS_SUITE, module: "quest-controls", unoverridden: true, fixtureVariant: "long_quest_v1",
    files: ["project-tree-navigation.mjs", "dialogue-controls-contract.mjs", "../../../services/runtime/scripts/prepare_frontend_baseline.py"],
    limits: ["Owned 200-stage Quest, complete text, inactive target bounds, own-stage exclusion and local Style return", "Native Tab/pointer and public selectOption; no provider dispatch, authored Save or phase latency claim"] },
  "dialogue-controls-before": { suite: DIALOGUE_CONTROLS_SUITE, module: "dialogue-controls", unoverridden: true, observeOnly: true, fixtureVariant: "long_dialogue_v1",
    files: ["project-tree-navigation.mjs", "../../../services/runtime/scripts/prepare_frontend_baseline.py"],
    limits: ["Pre-optimization observation only, 200-element owned Dialogue variant; no bounded-control claim", "Native distant choice and local Style return, no provider dispatch or authored Save"] },
  "dialogue-controls": { suite: DIALOGUE_CONTROLS_SUITE, module: "dialogue-controls", unoverridden: true, fixtureVariant: "long_dialogue_v1",
    files: ["project-tree-navigation.mjs", "../../../services/runtime/scripts/prepare_frontend_baseline.py"],
    limits: ["Bounded inactive next-target options in 200-element owned Dialogue, all text rows retained", "Native distant choice and local Style return, no provider dispatch, authored Save or phase latency claim"] },
  "project-navigation": { suite: PROJECT_NAVIGATION_SUITE, module: "project-navigation", unoverridden: true,
    limits: ["Bounded actual navigation rows, distant End/Home/PageDown focus and native wheel at both desktop sizes", "Owned original pinned copy, read-only document and Close release; not phase latency acceptance"] },
  "initial-detail": { suite: INITIAL_DETAIL_SUITE, module: "initial-detail", unoverridden: true, fixtureVariant: DETAIL_VARIANT,
    files: ["../../../services/runtime/scripts/prepare_frontend_baseline.py"],
    limits: ["Unmodified production initial Open/reopen, complete projection Fit without explicit action and visible reduced title/text at both sizes", "Owned deep fixture, no authored writes or whole-phase latency acceptance"] },
  minimap: { suite: MINIMAP_SUITE, module: "minimap", unoverridden: true, fixtureVariant: DETAIL_VARIANT,
    files: ["node-detail-contract.mjs", "protected-flow-contract.mjs", "protected-flow-dom.mjs", "../../../services/runtime/scripts/prepare_frontend_baseline.py"],
    limits: ["Whole-projection 32x16 MiniMap, native click/drag navigation, Graph/focused/Flow scope and independent rollback/reload", "Owned deep-location copy, unchanged canonical document; not whole-phase latency acceptance"] },
  detail: { suite: NODE_DETAIL_SUITE, module: "node-detail", detail: true, candidateName: "detail", fixtureVariant: DETAIL_VARIANT, compare: compareDetailLayouts,
    files: ["protected-flow-dom.mjs", "protected-flow-contract.mjs", "protected-frames-contract.mjs", "protected-linked-contract.mjs", "rendering-policy.mjs", "rendering-policy.v1.json", "../../../services/runtime/scripts/prepare_frontend_baseline.py"],
    limits: ["Owned named deep-location geometry variant of pinned 1,000-node copy; overview/compact/fold/reveal and protected navigation", "Full original graph retained; no edge/Flow/MiniMap activation or whole-project latency acceptance"] },
  "detail-defaults": { suite: "node_detail_default_activation_v1", module: "node-detail", detail: true, contract: "node-detail", unoverridden: true, fixtureVariant: DETAIL_VARIANT,
    files: ["protected-flow-dom.mjs", "protected-flow-contract.mjs", "protected-frames-contract.mjs", "protected-linked-contract.mjs", "rendering-policy.mjs", "rendering-policy.v1.json", "../../../services/runtime/scripts/prepare_frontend_baseline.py"],
    limits: ["Unmodified production detail default, explicit device rollback/reload and Graph-only scope at both sizes", "Owned deep-location variant; no broader feature or latency acceptance"] },
  "edge-boundary": { suite: EDGE_BOUNDARY_SUITE, module: "edge-boundary", compare: compareEdgeBoundaries, observation: true,
    files: ["protected-flow-dom.mjs", "protected-flow-contract.mjs"], limits: ["Read-only native crossing/return routes and portal navigation with actual diagnostic candidates at both sizes", "All SVG routes remain mounted; no edge exclusion, production observation rollout or project latency acceptance"] },
  defaults: { suite: "viewport_graph_default_activation_v1", module: "graph-default", contract: "viewport-cards", unoverridden: true,
    limits: ["Actual production Graph default, explicit Off across reload, live On/Off and Flow fallback at both sizes", "Owned read-only pinned copy; no new geometry/performance acceptance, Flow activation or authored writes"] },
  "flow-authoring": { suite: PROTECTED_FLOW_AUTHORING_SUITE, module: "protected-flow-authoring", files: ["protected-flow-contract.mjs", "protected-flow-dom.mjs"],
    limits: ["One UI-created transition between existing canonical main members: pending Cancel, edit, reconnect, remove and scope return", "Owned pinned 1,000-node copy, selected endpoint masking and exact read-back; no calls/exits, release or latency acceptance"] },
  authoring: { suite: PROTECTED_AUTHORING_SUITE, module: "protected-authoring", limits: ["Graph canaries in an owned 1,000-node document; filter isolates three hit targets", "No connections, Flow, nested scopes, release or latency acceptance"] },
  connections: { suite: PROTECTED_CONNECTIONS_SUITE, module: "protected-connections", limits: ["Graph connection canaries in an owned 1,000-node document; filter isolates hit targets", "No containers/Flow/auto-pan/zoom extremes/release/latency acceptance"] },
  frames: { suite: PROTECTED_FRAMES_SUITE, module: "protected-frames", limits: ["Read-only nested Graph scopes in an owned pinned 1,000-node document", "No linked/editor authoring, Flow, auto-pan, zoom extremes, release or latency acceptance"] },
  linked: { suite: PROTECTED_LINKED_SUITE, module: "protected-linked", limits: ["Read-only Graph linked/primary selection, cancelled editor drafts, native focus and unplaced navigation", "Owned pinned 1,000-node copy; no authored saves, Flow, auto-pan or release/latency acceptance"] },
  flow: { suite: PROTECTED_FLOW_SUITE, module: "protected-flow", compare: compareFlowScopes, files: ["protected-flow-dom.mjs", "protected-boundary-contract.mjs"], limits: ["Read-only main/side Flow geometry, selected offscreen member and Graph restoration", "Owned pinned 1,000-node copy; no authoring, zoom extremes, auto-pan or release/latency acceptance"] },
  boundary: { suite: PROTECTED_BOUNDARY_SUITE, module: "protected-flow", fixtureVariant: BOUNDARY_VARIANT, compare: compareFlowScopes,
    files: ["protected-flow-dom.mjs", "protected-boundary-contract.mjs", "../../../services/runtime/scripts/prepare_frontend_baseline.py"],
    limits: ["Read-only standalone Scene-entry route, arrow, label, endpoint ports and full/shell geometry", "Named owned fixture variant; no boundary editing, Flow mutation, Playback or release/latency acceptance"] },
  extremes: { suite: PROTECTED_EXTREMES_SUITE, module: "protected-extremes", compare: compareExtremeCases, limits: ["Native 1%/1000% Graph/Flow zoom, selected/native-focus protection and Fit recovery", "Owned pinned 1,000-node copy; card/port geometry and route/label identities, not curve geometry at extremes or release/latency acceptance"] },
  autopan: { suite: PROTECTED_AUTOPAN_SUITE, module: "protected-autopan", files: ["protected-connections-contract.mjs"], limits: ["Live Graph connect/reconnect/detach and empty-pane cancellation in owned canaries", "No Escape-during-drag, Flow authoring, nested frames, release or latency acceptance"] },
  editors: { suite: PROTECTED_EDITORS_SUITE, module: "protected-editors", files: ["protected-linked-contract.mjs", "project-tree-navigation.mjs"], limits: ["Owned Dialogue/Quest primary and UI-created linked aggregate Save, pan and scope restoration", "No provider, style, outcome/Flow authoring, checkpoint Save/reopen or release/latency acceptance"] }
};
const workflow = values.workflow ?? "authoring";
if (!Object.hasOwn(workflows, workflow)) throw new Error("unsupported_protected_workflow");
const scenario = workflows[workflow];
const web = resolve(dirname(fileURLToPath(import.meta.url)), ".."), repository = resolve(web, "../..");
const root = await mkdtemp(resolve(tmpdir(), "stt-frontend-baseline-protected-"));
const output = resolve(values.report ?? resolve(root, "report.json"));
process.chdir(web); process.env.VITE_RUNTIME_URL = "/api";
const runtimeOrigin = probeRuntimeOrigin();
const runtime = runtimeOrigin + "/api", servers = [];
let fixture, switchFixture;
const observations = new Map();
const report = { report_version: 1, suite: scenario.suite, workflow, started_at: new Date().toISOString(), quick: Boolean(values.quick),
  commit: execFileSync("git", ["rev-parse", "HEAD"], { cwd: repository, encoding: "utf8" }).trim(), source_gate_enabled: APPROVED_GRAPH_CARD_DEFAULT, cases: [],
  limits: scenario.limits };
if (scenario.toolTrace) report.instrumentation = "browser_timeline_main_thread";
if (scenario.toolCpu) report.instrumentation = "sampled_cpu_1000us_with_sourcemaps";
try {
  const health = await fetch(`${runtime}/health`, { signal: AbortSignal.timeout(5000) });
  if (!health.ok) throw new Error("protected_authoring_runtime_unavailable");
  report.runtime = await health.json();
  const hash = createHash("sha256");
  for (const file of ["protected-authoring-run.mjs", "probe-runtime.mjs", `${scenario.module}-probe.mjs`, `${scenario.contract ?? scenario.module}-contract.mjs`, "protected-document-contract.mjs", "viewport-cards-contract.mjs", "owned-session.mjs", "guard.mjs", "zoom.mjs", "workflow-observation.mjs", ...(scenario.files ?? [])]) {
    hash.update(file).update("\0").update(await readFile(resolve(web, "performance", file))).update("\0");
  }
  report.harness_sha256 = hash.digest("hex");
  if (scenario.detail) report.detail_source_gate_enabled = APPROVED_NODE_DETAIL_DEFAULT;
  if (scenario.nodeDom) report.node_dom_source_gate_enabled = APPROVED_NODE_DOM_DEFAULT;
  if (scenario.stableTool) report.tool_interaction_source_gate_enabled = APPROVED_TOOL_INTERACTION_DEFAULT;
  if (scenario.selectableTrial) {
    report.target_selectable_source_gate_enabled = APPROVED_TARGET_SELECTABLE_DEFAULT;
    report.tool_interaction_build_override = true;
  }
  if (workflow === "minimap") report.minimap_source_gate_enabled = APPROVED_MINIMAP_DEFAULT;
  const appHash = createHash("sha256");
  const appFiles = execFileSync("git", ["ls-files", "--cached", "--others", "--exclude-standard", "apps/web/src", "packages/contracts/src"],
    { cwd: repository, encoding: "utf8" }).trim().split("\n").concat("apps/web/performance/rendering-policy.v1.json");
  for (const file of [...new Set(appFiles)].sort()) appHash.update(file).update("\0").update(await readFile(resolve(repository, file))).update("\0");
  report.app_source_sha256 = appHash.digest("hex");
  report.app_static_sources = ["apps/web/performance/rendering-policy.v1.json"];
  fixture = JSON.parse(execFileSync("uv", ["run", "python", "-m", "services.runtime.scripts.prepare_frontend_baseline", resolve(root, "fixture-1000"), "--size", "1000",
    ...(scenario.fixtureVariant ? ["--variant", scenario.fixtureVariant] : [])],
    { cwd: repository, encoding: "utf8", timeout: 60000 }).trim());
  report.fixture_source_sha256 = fixture.source_sha256;
  if (scenario.alternateFixture) {
    switchFixture = JSON.parse(execFileSync("uv", ["run", "python", "-m", "services.runtime.scripts.prepare_frontend_baseline",
      resolve(root, "stt-frontend-baseline-retention", "fixture-small"), "--size", "small"],
      { cwd: repository, encoding: "utf8", timeout: 60000 }).trim());
    report.switch_fixture_source_sha256 = switchFixture.source_sha256;
  }
  if (fixture.variant) report.fixture_variant = fixture.variant;
  if (fixture.variant === "root_grid_v1") report.fixture_geometry = fixture.geometry;
  if (scenario.unoverridden) report.build_mode = "unoverridden_production_default";
  for (const enabled of (scenario.unoverridden ? [null] : values.quick ? [true] : [false, true])) {
    const dist = resolve(root, `dist-${enabled}`);
    await build({ root: web, plugins: [...(scenario.unoverridden ? [] : scenario.selectableTrial ? selectableGatePlugins(enabled) : scenario.stableTool ? [toolInteractionGatePlugin(enabled), selectableGatePlugins(false)[1]] : scenario.nodeDom ? [nodeDomGatePlugin(enabled)] : scenario.detail ? [nodeDetailGatePlugin(enabled)] : [viewportCardGatePlugin(enabled)]),
      ...(scenario.observation ? [edgeObservationPlugin()] : [])], build: { outDir: dist, emptyOutDir: true, sourcemap: Boolean(scenario.toolCpu) } });
    const server = await preview({ root: web, build: { outDir: dist }, preview: { host: "127.0.0.1", port: 0,
      proxy: { "/api": { target: runtimeOrigin, changeOrigin: true } } } });
    servers.push(server);
    const url = `http://127.0.0.1:${server.httpServer.address().port}`;
    for (const viewport of (values.quick ? [{ width: 1440, height: 900 }] : [{ width: 1440, height: 900 }, { width: 1024, height: 768 }])) {
      const name = `${viewport.width}-${enabled === null ? "default" : enabled ? scenario.candidateName ?? "shell" : "full"}`;
      const artifacts = resolve(root, name); await mkdir(artifacts);
      const config = resolve(artifacts, "config.json"), result = resolve(artifacts, "result.json");
      await writeFile(config, JSON.stringify({ url, viewport, fixture, switchFixture, enabled, stableTool: Boolean(scenario.stableTool), selectableTrial: Boolean(scenario.selectableTrial), nodeDom: Boolean(scenario.nodeDom), toolTrace: Boolean(scenario.toolTrace), toolCpu: Boolean(scenario.toolCpu), dist: scenario.toolCpu ? dist : null, artifacts, result, observeOnly: Boolean(scenario.observeOnly) }));
      const outcome = await guardedWorker(process.execPath, [resolve(web, `performance/${scenario.module}-probe.mjs`), config], 180000);
      const { error_message, ...summary } = await readFile(result, "utf8").then(JSON.parse).catch(() => ({ step: "launch" }));
      report.cases.push({ name, viewport, enabled, ...summary, ...outcome });
      if (scenario.compare && outcome.status === "ok") observations.set(name, JSON.parse(await readFile(resolve(artifacts, "layouts.json"), "utf8")));
      console.log(JSON.stringify({ name, status: outcome.status, step: summary.step, artifacts }));
      await mkdir(dirname(output), { recursive: true }); await writeFile(output, JSON.stringify(report, null, 2));
      if (outcome.status !== "ok") throw new Error(`protected_${workflow}_browser_failed`);
    }
  }
  if (scenario.compare && !values.quick) {
    report.comparisons = [1440, 1024].map((width) => ({ width,
      stages: scenario.compare(observations.get(`${width}-full`), observations.get(`${width}-${scenario.candidateName ?? "shell"}`)) }));
    if (report.comparisons.some((entry) => Object.values(entry.stages).some((stage) => !stage.equal))) throw new Error(`protected_${workflow}_geometry_comparison_failed`);
  }
  report.status = "passed";
} catch (error) {
  report.status = "failed"; report.error_code = /^protected_(minimap|detail|detail-defaults|defaults|authoring|connections|frames|linked|flow|flow-authoring|boundary|edge-boundary|extremes|autopan|editors)_[a-z_]+$/.test(error.message) ? error.message : "probe_preparation_failed";
  process.exitCode = 1;
} finally {
  report.cleanup = fixture ? await cleanupOwnedFixture(fixture, runtime).catch(() => "failed") : "not_created";
  if (switchFixture) {
    report.switch_cleanup = await cleanupOwnedFixture(switchFixture, runtime).catch(() => "failed");
    if (report.switch_cleanup !== "released") { report.status = "failed"; process.exitCode = 1; }
  }
  for (const server of servers) await new Promise((resolve) => server.httpServer.close(resolve));
  if (report.cleanup !== "released" && fixture) { report.status = "failed"; process.exitCode = 1; }
  report.completed_at = new Date().toISOString();
  await mkdir(dirname(output), { recursive: true }); await writeFile(output, JSON.stringify(report, null, 2) + "\n");
  console.log(JSON.stringify({ report: output, artifacts: root, status: report.status, cleanup: report.cleanup }));
}
