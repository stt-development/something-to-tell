export const INITIAL_DETAIL_SUITE = "informative_initial_graph_v1";

/** Native initial camera/body observation; never request an explicit Fit or mutate view state. */
export function observeInitialDetail() {
  const flow = document.querySelector(".workspace-stage > .react-flow"), canvas = flow.getBoundingClientRect();
  const controls = [flow.parentElement.querySelector(".tool-rail"), flow.querySelector(".react-flow__minimap")]
    .filter(Boolean).map((element) => element.getBoundingClientRect());
  const nodes = [...flow.querySelectorAll(".react-flow__node")], reduced = [...flow.querySelectorAll(".node-detail-header")];
  const visibleText = (element) => {
    if (!element || !element.textContent.trim() || element.classList.contains("sr-only")) return false;
    const box = element.getBoundingClientRect(), style = getComputedStyle(element);
    return box.width > 0 && box.height > 0 && style.display !== "none" && style.visibility !== "hidden";
  };
  const intersects = (a, b) => a.x < b.right && a.right > b.x && a.y < b.bottom && a.bottom > b.y;
  return { nodes: nodes.length, ports: flow.querySelectorAll(".narrative-handle").length, reduced: reduced.length,
    titled: reduced.filter((header) => visibleText(header.querySelector(".node-detail-title"))).length,
    previews: flow.querySelectorAll(".node-detail-preview").length,
    visible_previews: [...flow.querySelectorAll(".node-detail-preview")].filter(visibleText).length,
    shells: flow.querySelectorAll('article[data-node-presentation="shell"]').length,
    outside: nodes.filter((node) => { const b = node.getBoundingClientRect(); return b.x < canvas.x - 0.5 || b.y < canvas.y - 0.5 || b.right > canvas.right + 0.5 || b.bottom > canvas.bottom + 0.5; }).length,
    overlaps_controls: nodes.filter((node) => controls.some((control) => intersects(node.getBoundingClientRect(), control))).length,
    frame_preview_overflow: [...flow.querySelectorAll(".node-detail-frame-preview")].filter((preview) => {
      const box = preview.getBoundingClientRect(), node = preview.closest(".react-flow__node").getBoundingClientRect();
      const zoom = node.width / parseFloat(preview.closest(".react-flow__node").style.width);
      return box.bottom > node.y + 58 * zoom + 0.5;
    }).length };
}
export function verifyInitialDetail(value) {
  if (!(value.nodes === 1124 && value.ports === 4496 && value.reduced > 0 && value.titled === value.reduced
    && value.previews > 0 && value.visible_previews === value.previews && value.shells === 0
    && value.outside === 0 && value.overlaps_controls === 0 && value.frame_preview_overflow === 0)) throw Error("initial_detail_gate_failed");
  return value;
}
