export const MINIMAP_SUITE = "bounded_minimap_navigation_v1";
export const APPROVED_MINIMAP_DEFAULT = true;

/** Read-only DOM oracle: complete mounted projection, never its visible/detail subset. */
export function observeMiniMap() {
  const flow = document.querySelector(".react-flow"), viewport = flow.querySelector(".react-flow__viewport");
  const camera = new DOMMatrixReadOnly(getComputedStyle(viewport).transform), canvasBox = flow.getBoundingClientRect();
  const rects = [...flow.querySelectorAll(".react-flow__node")].map((node) => node.getBoundingClientRect());
  const x = Math.min(...rects.map((r) => (r.x - canvasBox.x - camera.e) / camera.a));
  const y = Math.min(...rects.map((r) => (r.y - canvasBox.y - camera.f) / camera.a));
  const right = Math.max(...rects.map((r) => (r.right - canvasBox.x - camera.e) / camera.a));
  const bottom = Math.max(...rects.map((r) => (r.bottom - canvasBox.y - camera.f) / camera.a));
  const bounds = { x, y, width: right - x, height: bottom - y };
  const scale = Math.min(184 / bounds.width, 134 / bounds.height);
  const mapping = { scale, x: (200 - bounds.width * scale) / 2 - x * scale, y: (150 - bounds.height * scale) / 2 - y * scale };
  const surface = flow.querySelector(".bounded-minimap-surface"), canvas = surface?.querySelector("canvas"), rect = surface?.querySelector("rect");
  const expected = { x: mapping.x - camera.e / camera.a * scale, y: mapping.y - camera.f / camera.a * scale,
    width: canvasBox.width / camera.a * scale, height: canvasBox.height / camera.a * scale };
  const difference = rect ? Math.max(...Object.entries(expected).map(([key, value]) => Math.abs(Number(rect.getAttribute(key)) - value))) : Infinity;
  let paintedPixels = 0;
  if (canvas) {
    const rgba = canvas.getContext("2d").getImageData(0, 0, canvas.width, canvas.height).data;
    for (let i = 3; i < rgba.length; i += 4) if (rgba[i]) paintedPixels++;
  }
  return { nodes: rects.length, represented: Number(surface?.dataset.minimapNodes), cells: Number(surface?.dataset.minimapCells),
    minimap_dom: surface?.querySelectorAll("*").length, legacy_shapes: flow.querySelectorAll(".react-flow__minimap-node").length,
    paintedPixels, viewport_delta: difference, bounds, mapping,
    camera: { x: camera.e, y: camera.f, zoom: camera.a }, width: canvasBox.width, height: canvasBox.height };
}

export function verifyMiniMapObservation(value) {
  if (!(value.nodes > 0 && value.represented === value.nodes && value.cells > 0 && value.cells <= 512
    && value.minimap_dom === 3 && value.legacy_shapes === 0 && value.paintedPixels > 0 && value.viewport_delta < 0.05)) {
    throw Error("minimap_projection_or_paint_failed");
  }
  // No authored ids/content/coordinates in the public report.
  return { projection_nodes: value.nodes, represented_nodes: value.represented, painted_cells: value.cells,
    minimap_dom: value.minimap_dom, legacy_shapes: value.legacy_shapes, painted_pixels: value.paintedPixels,
    viewport_delta_css_px: value.viewport_delta };
}
