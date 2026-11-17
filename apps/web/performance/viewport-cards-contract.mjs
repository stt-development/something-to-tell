/** Versioned independently of the historical DOM-count/selection probes. */
export const VIEWPORT_CARD_SUITE = "viewport_card_shell_graph_v1";
export const RELEASE_MODULE = "/src/app/graph/CanvasNodePresentation.tsx";
export const APPROVED_GRAPH_CARD_DEFAULT = true;

/** Test-bundle-only switch: never edits the source gate or a project preference. */
export function viewportCardGatePlugin(enabled) {
  let transformed = 0;
  return { name: "viewport-card-browser-gate",
    transform(code, id) {
      if (!id.endsWith(RELEASE_MODULE)) return null;
      const declaration = `export const VIEWPORT_CARD_PRESENTATION_ENABLED = ${APPROVED_GRAPH_CARD_DEFAULT};`;
      if (code.split(declaration).length !== 2) throw new Error("viewport_card_release_gate_changed");
      const parameter = '{ children, enabled, detailEnabled, workspaceMode = "relationships" }';
      if (code.split(parameter).length !== 2) throw new Error("viewport_card_test_override_changed");
      transformed++;
      // Use the explicit component override in both modes; never approve Flow
      // through a production default or let remembered preferences affect controls.
      return code.replace(parameter, `{ children, enabled = ${enabled}, detailEnabled, workspaceMode = "relationships" }`);
    },
    buildEnd(error) { if (!error && transformed !== 1) throw new Error("viewport_card_gate_not_verified"); }
  };
}

/** Compare complete read-only DOM geometry; body counts intentionally differ. */
export function compareCardLayouts(reference, candidate, tolerance = 0.05) {
  const counts = ["wrappers", "handles", "edges", "labels", "minimap"];
  if (!reference?.geometry || !candidate?.geometry || !Number.isFinite(tolerance) || tolerance < 0
    || !counts.every((key) => Number.isInteger(reference.counts?.[key]) && Number.isInteger(candidate.counts?.[key])
      && reference.counts[key] >= 0 && candidate.counts[key] >= 0)) {
    return { equal: false, mismatches: 1, max_numeric_delta: 0, tolerance_world: tolerance };
  }
  let mismatches = 0, maxDelta = 0;
  function compare(a, b) {
    if (typeof a === "number" && typeof b === "number") {
      const delta = Math.abs(a - b);
      maxDelta = Math.max(maxDelta, delta);
      if (!Number.isFinite(delta) || delta > tolerance) mismatches++;
    } else if (a && b && typeof a === "object" && typeof b === "object") {
      const keys = Object.keys(a), other = Object.keys(b);
      if (keys.length !== other.length || keys.some((key) => !Object.hasOwn(b, key))) { mismatches++; return; }
      for (const key of keys) compare(a[key], b[key]);
    } else if (a !== b) mismatches++;
  }
  compare(reference.geometry, candidate.geometry);
  for (const key of counts) {
    if (reference.counts[key] !== candidate.counts[key]) mismatches++;
  }
  return { equal: mismatches === 0, mismatches, max_numeric_delta: maxDelta, tolerance_world: tolerance };
}

/** Browser DOM read only; no React Flow store/global application hooks. */
export function readCardLayout({ preciseCamera = false } = {}) {
  const canvas = document.querySelector(".react-flow"), viewport = document.querySelector(".react-flow__viewport");
  if (!canvas || !viewport) throw new Error("viewport_card_canvas_missing");
  // Both computed and inline transform strings round translations. Typed CSS
  // avoids that serialization at 1%; legacy probes retain their original mode.
  const typed = preciseCamera ? viewport.attributeStyleMap?.get("transform") : null;
  if (preciseCamera && typeof typed?.toMatrix !== "function") throw new Error("viewport_card_precise_camera_missing");
  const camera = preciseCamera ? typed.toMatrix() : new DOMMatrixReadOnly(getComputedStyle(viewport).transform), outer = canvas.getBoundingClientRect();
  const rect = (element) => {
    const b = element.getBoundingClientRect();
    return [(b.x - outer.x - camera.e) / camera.a, (b.y - outer.y - camera.f) / camera.a, b.width / camera.a, b.height / camera.a];
  };
  const wrappers = [...document.querySelectorAll(".react-flow__node")];
  const nodes = wrappers.map((element) => ({ id: element.getAttribute("data-id"), bounds: rect(element),
    card: rect(element.querySelector("article")),
    handles: [...element.querySelectorAll(".narrative-handle")].map((handle) => ({ id: handle.dataset.handleid, bounds: rect(handle) }))
  })).sort((a, b) => a.id.localeCompare(b.id));
  const edges = [...document.querySelectorAll(".react-flow__edge")].map((element) => ({ id: element.getAttribute("data-id"),
    path: element.querySelector(".react-flow__edge-path")?.getAttribute("d") ?? null })).sort((a, b) => a.id.localeCompare(b.id));
  const labels = [...document.querySelectorAll(".react-flow__edgelabel-renderer > *")].map((element) => ({
    text: element.textContent, bounds: rect(element) }));
  const shells = [...document.querySelectorAll('article[data-node-presentation="shell"]')];
  const mini = document.querySelector(".bounded-minimap-surface");
  return { minimap_coverage: mini ? { represented_nodes: Number(mini.dataset.minimapNodes), cells: Number(mini.dataset.minimapCells),
      dom: mini.querySelectorAll("*").length } : null,
    counts: { wrappers: wrappers.length, handles: nodes.reduce((count, node) => count + node.handles.length, 0), edges: edges.length,
    labels: labels.length, minimap: document.querySelectorAll(".react-flow__minimap-node").length,
    full_bodies: document.querySelectorAll('article[data-node-presentation="full"]').length, shells: shells.length,
    total_dom: document.querySelectorAll("*").length },
    visible_shells: shells.filter((element) => {
      const b = element.getBoundingClientRect();
      return b.right > outer.left && b.left < outer.right && b.bottom > outer.top && b.top < outer.bottom;
    }).length,
    invalid_handle_bounds: nodes.flatMap((node) => node.handles).filter((handle) => handle.bounds[2] <= 0 || handle.bounds[3] <= 0).length,
    geometry: { camera: [camera.e, camera.f, camera.a], nodes, edges, labels } };
}
