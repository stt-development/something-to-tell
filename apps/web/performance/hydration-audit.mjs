import { createServer } from "vite";
import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { gunzipSync } from "node:zlib";
import { createHash } from "node:crypto";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { tmpdir } from "node:os";
import { execFileSync } from "node:child_process";

/** Offline synthetic envelope only, never a runtime session or a live project. */
export function hydrationEnvelope(source) {
  return { document: source, session: { session_id: "offline-hydration-audit", project_id: source.manifest.project_id,
    project_path: "offline-fixture", saved_revision: source.manifest.saved_revision, loaded_revision: source.manifest.saved_revision,
    save_status: "clean", lifecycle: "open", storage_mode: source.manifest.settings.storage.mode } };
}

/** Count actual parent-sort property reads over the original pre-sort projection order. */
export function parentOrderAudit(source, snapshot, order) {
  const byId = new Map(snapshot.nodes.map((node) => [node.id, node])), placements = new Map();
  for (const placement of source.placements) {
    const group = placements.get(placement.canonical_node_id) ?? [];
    group.push(placement); placements.set(placement.canonical_node_id, group);
  }
  const projected = source.nodes.flatMap((node) => {
    const group = placements.get(node.id);
    return group?.length ? [...group].sort((a, b) => Number(b.is_primary) - Number(a.is_primary))
      .map((placement) => byId.get(placement.is_primary ? node.id : `placement:${placement.id}`)) : [byId.get(node.id)];
  });
  if (projected.some((node) => !node) || projected.length !== snapshot.nodes.length) throw Error("hydration_audit_projection_mismatch");
  let idReads = 0, parentReads = 0;
  const observed = projected.map((node) => ({
    get id() { idReads++; return node.id; }, get parentId() { parentReads++; return node.parentId; }
  }));
  const result = order(observed);
  // Read ids after stopping access accounting so parity checking cannot inflate the work count.
  const work = { id_reads: idReads, parent_reads: parentReads };
  if (JSON.stringify(result.map((node) => node.id)) !== JSON.stringify(snapshot.nodes.map((node) => node.id))) throw Error("hydration_audit_order_mismatch");
  return { ...work, projected_nodes: projected.length, exact_order: true };
}

/** Synchronous parse CPU only; never label this native Response.json or acquisition time. */
export function parseAudit(text, count = 5, now = () => performance.now()) {
  if (!Number.isInteger(count) || count < 1 || count > 21) throw Error("hydration_audit_sample_count_invalid");
  const samples = [];
  for (let index = 0; index < count; index++) {
    const started = now(), value = JSON.parse(text), elapsed = now() - started;
    if (!Number.isFinite(elapsed) || elapsed < 0) throw Error("hydration_audit_clock_invalid");
    samples.push({ cache: index ? "warm_same_process" : "first_parse", milliseconds: elapsed, nodes: value.document.nodes.length });
  }
  return samples;
}

async function main() {
  const web = resolve(dirname(fileURLToPath(import.meta.url)), ".."), repository = resolve(web, "../..");
  const output = resolve(process.argv[2] ?? "/private/tmp/stt-hydration-offline.json");
  const manifest = JSON.parse(await readFile(resolve(repository, "fixtures/benchmarks/manifest.v1.json"), "utf8"));
  const hash = createHash("sha256");
  const sources = execFileSync("git", ["ls-files", "--cached", "--others", "--exclude-standard", "apps/web/src", "packages/contracts/src"],
    { cwd: repository, encoding: "utf8" }).trim().split("\n").concat("apps/web/performance/rendering-policy.v1.json");
  for (const file of [...new Set(sources)].sort()) hash.update(file).update("\0").update(await readFile(resolve(repository, file))).update("\0");
  // Offline SSR loading needs neither a listening HMR socket nor the dev server's shared cache.
  const cacheDir = await mkdtemp(resolve(tmpdir(), "stt-hydration-offline-"));
  const server = await createServer({ root: web, cacheDir, configFile: false,
    server: { middlewareMode: true, hmr: false, watch: null }, optimizeDeps: { noDiscovery: true }, appType: "custom" });
  const report = { suite: "offline_hydration_work_v1", status: "running", cases: [], node_version: process.version,
    app_source_sha256: hash.digest("hex"), harness_sha256: createHash("sha256").update(await readFile(fileURLToPath(import.meta.url))).digest("hex"),
    limits: ["Node/Vite SSR synchronous offline input work, not browser/native Response.json or live storage latency",
      "Synthetic envelope; no runtime, project session, provider or authored writes"] };
  try {
    const { projectSessionToGraphSnapshot } = await server.ssrLoadModule("/src/runtime/projections.ts");
    const { orderHydratedPlacements } = await server.ssrLoadModule("/src/runtime/orderHydratedPlacements.ts");
    for (const size of [1000]) {
      const pack = await readFile(resolve(repository, `fixtures/benchmarks/storage-scale-${size}.v1.json.gz`));
      const sha = createHash("sha256").update(pack).digest("hex");
      if (sha !== manifest.projects[String(size)].gzip_sha256) throw Error("hydration_audit_fixture_changed");
      const source = JSON.parse(gunzipSync(pack).toString()), envelope = hydrationEnvelope(source), text = JSON.stringify(envelope);
      const before = JSON.stringify(source), started = performance.now();
      const snapshot = projectSessionToGraphSnapshot(envelope), conversion = performance.now() - started;
      if (JSON.stringify(source) !== before) throw Error("hydration_audit_input_mutated");
      report.cases.push({ source_nodes: size, fixture_sha256: sha, input_bytes: Buffer.byteLength(text),
        parse_samples: parseAudit(text), dto_first_conversion_ms: conversion,
        parent_order: parentOrderAudit(source, snapshot, orderHydratedPlacements), input_unchanged: true });
    }
    report.status = "passed";
  } catch (error) { report.status = "failed"; throw error; }
  finally { await server.close(); await writeFile(output, JSON.stringify(report, null, 2) + "\n"); }
  console.log(JSON.stringify({ report: output, status: report.status }));
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) await main();
