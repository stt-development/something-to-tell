import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { policy, placementRectangles, spreadPlacements, viewportRect, intersects, spatiallyEligible,
  visibleLevels, detailBand, minimapOccupancy, auditPolicy, bounds } from "./rendering-policy.mjs";

const placement = (id, x, y, parent = null, primary = true) => ({ id, canonical_node_id: id, x, y,
  width: 100, height: 80, container_node_id: parent, is_primary: primary, metadata: { authored: true } });

test("policy is versioned and frozen for future integration, with CSS and independent MiniMap budgets", () => {
  assert.equal(policy.policy_version, 1);
  assert.equal(policy.status, "frozen_for_implementation_not_enabled");
  assert.equal(policy.entry_overscan_css_px, 240);
  assert.equal(policy.release_overscan_css_px, 360);
  assert.ok(policy.release_overscan_css_px > policy.entry_overscan_css_px);
  assert.equal(policy.minimap_columns * policy.minimap_rows, 512);
});

for (const zoom of [0.01, 1, 10]) test(`CSS overscan transforms consistently to world space at zoom=${zoom}`, () => {
  const viewport = { width: 1024, height: 768 }, camera = { x: 40, y: -50, zoom };
  assert.deepEqual(viewportRect(viewport, camera, 240), {
    x: -280 / zoom, y: -190 / zoom, width: 1504 / zoom, height: 1248 / zoom
  });
});

test("inclusive entry/release borders retain a fringe node without turning exact-viewport clipping into policy", () => {
  const view = { width: 100, height: 100 }, camera = { x: 0, y: 0, zoom: 1 };
  const rect = (x) => ({ x, y: 0, width: 10, height: 10 });
  assert.equal(spatiallyEligible(rect(340), view, camera), true);
  assert.equal(spatiallyEligible(rect(341), view, camera), false);
  assert.equal(spatiallyEligible(rect(341), view, camera, true), true);
  assert.equal(spatiallyEligible(rect(460), view, camera, true), true);
  assert.equal(spatiallyEligible(rect(461), view, camera, true), false);
  assert.equal(intersects(rect(-10), { x: 0, y: 0, width: 100, height: 100 }), true);
});

test("a large intersecting frame is not culled by its offscreen origin", () => {
  const frame = { x: -2000, y: -1000, width: 4000, height: 2000 };
  assert.equal(spatiallyEligible(frame, { width: 1440, height: 900 }, { x: 0, y: 0, zoom: 1 }), true);
});

test("actual parent chains, not overlap or canonical aliases, determine world rectangles and depth", () => {
  const raw = [placement("root", 100, 200), placement("inner", 20, 30, "root"),
    placement("child", -5, 4, "inner"), { ...placement("linked", 9, 8, "root", false), canonical_node_id: "child" },
    placement("overlap", 100, 200)];
  const rects = placementRectangles(raw);
  assert.deepEqual(rects.map(({ x, y, depth }) => ({ x, y, depth })), [
    { x: 100, y: 200, depth: 0 }, { x: 120, y: 230, depth: 1 }, { x: 115, y: 234, depth: 2 },
    { x: 109, y: 208, depth: 1 }, { x: 100, y: 200, depth: 0 }
  ]);
  assert.notEqual(rects[2].id, rects[3].id);
});

test("the offline audit rejects unknown geometry/ancestry rather than falsely reporting successful culling", () => {
  assert.throws(() => placementRectangles([placement("orphan", 0, 0, "missing")]), /invalid_policy_ancestry/);
  assert.throws(() => placementRectangles([placement("loop", 0, 0, "loop")]), /invalid_policy_ancestry/);
  assert.throws(() => placementRectangles([placement("bad", NaN, 0)]), /invalid_policy_geometry/);
  assert.throws(() => viewportRect({ width: 0, height: 10 }, { x: 0, y: 0, zoom: 1 }), /invalid_policy_viewport/);
});

test("spread variant changes root coordinates only, deterministically preserving descendant offsets and every other field", () => {
  const raw = Object.freeze([Object.freeze(placement("a", 0, 0)), Object.freeze(placement("b", 0, 0)),
    Object.freeze(placement("child", -200, 50, "a"))]);
  const before = JSON.stringify(raw), moved = spreadPlacements(raw);
  assert.deepEqual(moved, spreadPlacements(raw));
  assert.equal(moved[2], raw[2]);
  for (let i = 0; i < raw.length; i++) {
    const { x, y, ...fields } = raw[i], { x: nx, y: ny, ...next } = moved[i];
    assert.deepEqual(next, fields);
  }
  const rects = placementRectangles(moved);
  assert.equal(intersects(bounds(rects.filter((r) => r.root === "a")), bounds(rects.filter((r) => r.root === "b"))), false);
  assert.equal(JSON.stringify(raw), before);
});

test("three initial containment levels enrich with zoom, not with arbitrary z-index or overlap", () => {
  assert.deepEqual([0.01, 0.2, 1, 1.25, 2.5, 5, 10].map((z) => visibleLevels(z)), [3, 3, 3, 4, 5, 6, 7]);
  assert.equal(visibleLevels(1.3, 3), 3);
  assert.equal(visibleLevels(1.44, 3), 4);
  assert.equal(visibleLevels(1.1, 4), 4);
  assert.equal(visibleLevels(1.06, 4), 3);
  assert.equal(visibleLevels(10, 6), 7);
  assert.throws(() => visibleLevels(Infinity), /invalid_policy_zoom/);
});

test("overview/compact/full detail has symmetric zoom hysteresis and a deterministic initial state", () => {
  assert.deepEqual([0.01, 0.2, 0.65, 10].map((z) => detailBand(z)), ["overview", "compact", "full", "full"]);
  assert.equal(detailBand(0.21, "overview"), "overview");
  assert.equal(detailBand(0.23, "overview"), "compact");
  assert.equal(detailBand(0.18, "compact"), "compact");
  assert.equal(detailBand(0.16, "compact"), "overview");
  assert.equal(detailBand(0.7, "compact"), "compact");
  assert.equal(detailBand(0.75, "compact"), "full");
  assert.equal(detailBand(0.56, "full"), "full");
  assert.equal(detailBand(0.55, "full"), "compact");
});

test("MiniMap includes distant and large-frame extents independently from main viewport eligibility", () => {
  const rects = [{ x: 0, y: 0, width: 10, height: 10 }, { x: 100000, y: 100000, width: 1000, height: 2000 }];
  assert.equal(spatiallyEligible(rects[1], { width: 1440, height: 900 }, { x: 0, y: 0, zoom: 1 }), false);
  assert.equal(minimapOccupancy(rects).occupied_cells, 2);
  assert.equal(minimapOccupancy([{ x: 0, y: 0, width: 1000, height: 1000 }]).occupied_cells, 512);
  assert.equal(minimapOccupancy([]).occupied_cells, 0);
});

test("archive reproduces pinned checksums, unchanged data and honest dense-versus-spread geometric limits", () => {
  const archived = JSON.parse(readFileSync(new URL("../../../docs/verification/baselines/p9-1-005a-rendering-policy-v1.json", import.meta.url), "utf8"));
  assert.deepEqual(auditPolicy(), archived);
  assert.equal(archived.canonical_nodes, 1000);
  assert.equal(archived.unplaced_canonical_nodes, 8);
  assert.equal(archived.input_unchanged, true);
  const [dense, spread] = archived.cases;
  assert.notEqual(dense.placement_geometry_sha256, spread.placement_geometry_sha256);
  assert.deepEqual(dense.depth_histogram, spread.depth_histogram);
  assert.equal(dense.placements, 1116);
  assert.equal(dense.distinct_root_origins, 11);
  assert.equal(spread.distinct_root_origins, 682);
  for (const value of archived.cases) for (const observation of value.observations) {
    assert.ok(observation.exact_intersections <= observation.entry_intersections);
    assert.ok(observation.entry_intersections <= observation.release_intersections);
    assert.ok(value.minimap.occupied_cells <= value.minimap.budget);
  }
  for (const marker of ["/Users/", "session_id", "password", '"id":', "canonical_node_id", "http://"]) assert.ok(!JSON.stringify(archived).includes(marker));
});
