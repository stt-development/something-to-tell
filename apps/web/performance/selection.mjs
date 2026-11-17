/** Find a real exposed title, not an occluded node in the pinned overlap stacks. */
export function visibleSelectionTarget(excludedId, dom = document) {
  for (const title of dom.querySelectorAll(".react-flow__node .narrative-node-title-text, .react-flow__node .node-detail-title")) {
    const node = title.closest(".react-flow__node");
    const id = node?.getAttribute("data-id");
    if (!id || id === excludedId) continue;
    const box = title.getBoundingClientRect();
    if (box.width <= 0 || box.height <= 0) continue;
    const x = box.x + Math.min(20, box.width / 2), y = box.y + box.height / 2;
    const hit = dom.elementFromPoint(x, y);
    if (hit?.closest(".react-flow__node") === node && !hit.closest("button")) return { id, x, y };
  }
  throw new Error("selection_target_unavailable");
}

/** UI-only drill. Identities stay local; abort any attempted write before runtime. */
export async function measureSelection(page, { cpu = null, phases = false } = {}) {
  let blocked = 0;
  const protect = async (route) => {
    if (!["GET", "HEAD"].includes(route.request().method())) {
      blocked++;
      await route.abort();
    } else await route.fallback();
  };
  const selected = (ids) => page.waitForFunction((expected) => {
    const actual = [...document.querySelectorAll(".react-flow__node.selected")].map((node) => node.getAttribute("data-id")).sort();
    return actual.length === expected.length && actual.every((id, index) => id === expected[index]);
  }, [...ids].sort());
  const measure = async (action, ids) => {
    if (phases) await page.evaluate(() => window.__sttPhaseProbe.start());
    await cpu?.start();
    const start = performance.now();
    await action();
    await selected(ids);
    await page.evaluate(() => new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve))));
    const result = { feedback_ms: performance.now() - start, selected_count: ids.length };
    if (cpu) result.cpu = await cpu.stop();
    if (phases) result.phases = await page.evaluate(() => window.__sttPhaseProbe.stop());
    return result;
  };
  await page.route("**/api/**", protect);
  try {
    await page.getByRole("button", { name: "Select", exact: true }).click();
    await page.keyboard.press("Escape");
    await selected([]);
    const first = await page.evaluate(visibleSelectionTarget, null);
    const single = await measure(() => page.mouse.click(first.x, first.y), [first.id]);
    const second = await page.evaluate(visibleSelectionTarget, first.id);
    const multi = await measure(async () => {
      await page.keyboard.down("Shift");
      try { await page.mouse.click(second.x, second.y); }
      finally { await page.keyboard.up("Shift"); }
    }, [first.id, second.id]);
    const clear = await measure(() => page.keyboard.press("Escape"), []);
    if (blocked) throw new Error("selection_attempted_mutation");
    return { single, multi, clear, blocked_mutations: blocked };
  } finally {
    await page.unroute("**/api/**", protect);
  }
}
