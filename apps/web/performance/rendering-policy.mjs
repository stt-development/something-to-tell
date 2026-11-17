import { createHash } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";
import { gunzipSync } from "node:zlib";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

// Opt-in policy arithmetic/fixture audit only. Nothing here is imported by the application.
export const policy = JSON.parse(readFileSync(new URL("./rendering-policy.v1.json", import.meta.url), "utf8"));
const hash = (value) => createHash("sha256").update(value).digest("hex");

/** Raw placement geometry, not the full React Flow projection or mounted DOM. */
export function placementRectangles(placements) {
  const primary = new Map(placements.filter((p) => p.is_primary).map((p) => [p.canonical_node_id, p]));
  return placements.map((p) => {
    let current = p, x = p.x, y = p.y, depth = 0;
    const seen = new Set([p.id]);
    while (current.container_node_id !== null) {
      current = primary.get(current.container_node_id);
      if (!current || seen.has(current.id)) throw new Error("invalid_policy_ancestry");
      seen.add(current.id);
      x += current.x; y += current.y; depth++;
    }
    if (![x, y, p.width, p.height].every(Number.isFinite) || p.width < 0 || p.height < 0) throw new Error("invalid_policy_geometry");
    return { id: p.id, root: current.id, depth, x, y, width: p.width, height: p.height };
  });
}

export function bounds(rects) {
  if (!rects.length) return { x: 0, y: 0, width: 0, height: 0 };
  const x = Math.min(...rects.map((r) => r.x)), y = Math.min(...rects.map((r) => r.y));
  return { x, y, width: Math.max(...rects.map((r) => r.x + r.width)) - x, height: Math.max(...rects.map((r) => r.y + r.height)) - y };
}

/** A separately named measurement variant: move only roots; never edit the pinned file. */
export function spreadPlacements(placements) {
  const rects = placementRectangles(placements), groups = new Map();
  for (const r of rects) { const group = groups.get(r.root) ?? []; group.push(r); groups.set(r.root, group); }
  const spans = new Map([...groups].map(([id, values]) => [id, bounds(values)]));
  const columns = Math.max(1, Math.ceil(Math.sqrt(spans.size))), gap = policy.spread_gap_world;
  const width = Math.max(1440, ...[...spans.values()].map((r) => r.width + 2 * gap));
  const height = Math.max(900, ...[...spans.values()].map((r) => r.height + 2 * gap));
  let index = 0;
  return placements.map((p) => {
    if (p.container_node_id !== null) return p;
    const span = spans.get(p.id);
    const moved = { ...p, x: p.x - span.x + (index % columns) * width + gap,
      y: p.y - span.y + Math.floor(index / columns) * height + gap };
    index++;
    return moved;
  });
}

export function viewportRect(viewport, camera, margin = 0) {
  if (![viewport.width, viewport.height, camera.x, camera.y, camera.zoom, margin].every(Number.isFinite)
      || viewport.width <= 0 || viewport.height <= 0 || camera.zoom <= 0 || margin < 0) throw new Error("invalid_policy_viewport");
  return { x: (-camera.x - margin) / camera.zoom, y: (-camera.y - margin) / camera.zoom,
    width: (viewport.width + 2 * margin) / camera.zoom, height: (viewport.height + 2 * margin) / camera.zoom };
}
export const intersects = (a, b) => a.x <= b.x + b.width && a.x + a.width >= b.x && a.y <= b.y + b.height && a.y + a.height >= b.y;
export const spatiallyEligible = (r, viewport, camera, retained = false) =>
  intersects(r, viewportRect(viewport, camera, retained ? policy.release_overscan_css_px : policy.entry_overscan_css_px));
function validZoom(zoom) {
  if (!Number.isFinite(zoom) || zoom < policy.min_zoom || zoom > policy.max_zoom) throw new Error("invalid_policy_zoom");
}
export function visibleLevels(zoom, previous) {
  validZoom(zoom);
  const nominal = (value) => policy.base_visible_levels + (value < policy.extra_level_zoom ? 0 : 1 + Math.floor(Math.log2(value / policy.extra_level_zoom)));
  const next = nominal(zoom);
  if (previous === undefined || zoom === policy.max_zoom) return next;
  return next > previous ? Math.max(previous, nominal(zoom / (1 + policy.zoom_hysteresis_ratio)))
    : Math.min(previous, nominal(zoom / (1 - policy.zoom_hysteresis_ratio)));
}
export function detailBand(zoom, previous) {
  validZoom(zoom);
  if (previous === undefined) return zoom >= policy.full_zoom ? "full" : zoom >= policy.compact_zoom ? "compact" : "overview";
  const full = policy.full_zoom * (1 + (previous === "full" ? -1 : 1) * policy.zoom_hysteresis_ratio);
  const compact = policy.compact_zoom * (1 + (previous === "overview" ? 1 : -1) * policy.zoom_hysteresis_ratio);
  return zoom >= full ? "full" : zoom >= compact ? "compact" : "overview";
}

/** Whole-project occupancy budget; geometry outside the main viewport still contributes. */
export function minimapOccupancy(rects) {
  const extent = bounds(rects), cells = new Set();
  const column = (x) => Math.max(0, Math.min(policy.minimap_columns - 1, Math.floor((x - extent.x) / (extent.width || 1) * policy.minimap_columns)));
  const row = (y) => Math.max(0, Math.min(policy.minimap_rows - 1, Math.floor((y - extent.y) / (extent.height || 1) * policy.minimap_rows)));
  for (const r of rects) for (let x = column(r.x); x <= column(r.x + r.width); x++)
    for (let y = row(r.y); y <= row(r.y + r.height); y++) cells.add(y * policy.minimap_columns + x);
  return { occupied_cells: cells.size, budget: policy.minimap_columns * policy.minimap_rows };
}

/** Checksums plus aggregate geometric counts only; never authored ids, content or coordinates. */
export function auditPolicy() {
  const manifest = JSON.parse(readFileSync(new URL("../../../fixtures/benchmarks/manifest.v1.json", import.meta.url), "utf8"));
  const pinned = manifest.projects["1000"];
  const bytes = readFileSync(new URL(`../../../fixtures/benchmarks/${pinned.file}`, import.meta.url));
  const json = gunzipSync(bytes);
  if (hash(bytes) !== pinned.gzip_sha256 || hash(json) !== pinned.json_sha256) throw new Error("policy_fixture_drift");
  const document = JSON.parse(json), before = hash(JSON.stringify(document)), cases = [];
  for (const [variant, placements] of [["pinned_original_overlap", document.placements], [policy.spread_variant, spreadPlacements(document.placements)]]) {
    const rects = placementRectangles(placements), root = rects.find((r) => r.depth === 0);
    const histogram = {};
    for (const r of rects) histogram[r.depth] = (histogram[r.depth] ?? 0) + 1;
    const observations = [];
    for (const [width, height] of [[1440, 900], [1024, 768]]) for (const zoom of [0.01, 0.2, 1, 10]) {
      const viewport = { width, height }, camera = { x: width / 2 - (root.x + root.width / 2) * zoom,
        y: height / 2 - (root.y + root.height / 2) * zoom, zoom };
      observations.push({ viewport, zoom, levels: visibleLevels(zoom),
        exact_intersections: rects.filter((r) => intersects(r, viewportRect(viewport, camera))).length,
        entry_intersections: rects.filter((r) => spatiallyEligible(r, viewport, camera)).length,
        release_intersections: rects.filter((r) => spatiallyEligible(r, viewport, camera, true)).length });
    }
    cases.push({ variant, placement_geometry_sha256: hash(JSON.stringify(placements)), placements: placements.length,
      distinct_root_origins: new Set(placements.filter((p) => p.container_node_id === null).map((p) => `${p.x},${p.y}`)).size,
      depth_histogram: histogram, minimap: minimapOccupancy(rects), observations });
  }
  if (before !== hash(JSON.stringify(document))) throw new Error("policy_fixture_mutated");
  return { report_version: 1, measurement: "offline_raw_placement_geometry_not_dom_or_latency", policy,
    audit_source_sha256: hash(readFileSync(fileURLToPath(import.meta.url))),
    policy_spec_sha256: hash(readFileSync(new URL("./rendering-policy.v1.json", import.meta.url))),
    source_gzip_sha256: hash(bytes), source_json_sha256: hash(json), canonical_nodes: document.nodes.length,
    unplaced_canonical_nodes: document.nodes.length - new Set(document.placements.map((p) => p.canonical_node_id)).size,
    input_unchanged: true, camera_anchor: "first_root_center", cases };
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const report = JSON.stringify(auditPolicy(), null, 2) + "\n";
  const output = process.argv[2];
  if (output) writeFileSync(output, report); else process.stdout.write(report);
}
