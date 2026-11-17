/** UI observations include verification cost; never report a failed action as fast. */
export async function observeAction(perform, verify, clock = () => performance.now()) {
  const start = clock();
  await perform();
  await verify();
  const elapsed = clock() - start;
  if (!Number.isFinite(elapsed) || elapsed < 0) throw new Error("invalid_action_clock");
  return { settled_ms: elapsed };
}

/** Optional diagnostic scope; cleanup also runs on failed actions, without a success sample. */
export async function observeActionWithPhases(perform, verify, collector = null) {
  if (!collector) return observeAction(perform, verify);
  await collector.start();
  let phases;
  let result;
  try { result = await observeAction(perform, verify); }
  finally { phases = await collector.stop(); }
  return { ...result, phases };
}

/** Sidebar Open exists before Close completes; only this heading proves startup. */
export function waitStartScreen(page) {
  return page.getByRole("heading", { name: "Projects", exact: true }).waitFor({ state: "visible" });
}

/** Geometric assertion only; authored target ids/coordinates never enter reports. */
export function centeredTreeTarget(id, dom = document) {
  const node = [...dom.querySelectorAll(".react-flow__node")].find((item) => item.getAttribute("data-id") === id);
  const canvas = dom.querySelector(".react-flow");
  if (!node || !canvas) return false;
  const n = node.getBoundingClientRect(), c = canvas.getBoundingClientRect();
  return Math.abs(n.x + n.width / 2 - c.x - c.width / 2) < 24
    && Math.abs(n.y + n.height / 2 - c.y - c.height / 2) < 24;
}

/** Match real full/reduced rendered titles without application state hooks or canonical aliasing. */
export function treeNodeForLabel(label, dom = document) {
  return [...dom.querySelectorAll(".react-flow__node")].find((node) =>
    node.querySelector(".narrative-node-title")?.getAttribute("title") === label
    || node.querySelector(".node-detail-title")?.textContent.trim() === label)?.getAttribute("data-id") ?? null;
}

/** Hover is proven only when all four actual attachment ports are visible. */
export function hoveredTargetPorts(id, dom = document, style = getComputedStyle) {
  const node = [...dom.querySelectorAll(".react-flow__node")].find((item) => item.getAttribute("data-id") === id);
  const ports = node ? [...node.querySelectorAll(".narrative-handle")] : [];
  return ports.length === 4 && ports.every((port) => Number(style(port).opacity) > 0.9);
}
