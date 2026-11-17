/** Browser-side observation; DOMMatrix handles CSS transforms without string parsing. */
export function settledViewport({ before = null, direction = 0, maxFrames = 180, minimumMs = 0 } = {}) {
  if (!Number.isInteger(maxFrames) || maxFrames < 3 || maxFrames > 180 || ![-1, 0, 1].includes(direction)
      || !Number.isFinite(minimumMs) || minimumMs < 0 || minimumMs > 1000
      || (direction && (!before || ![before.x, before.y, before.zoom].every(Number.isFinite)))) {
    throw new Error("invalid_zoom_observation");
  }
  return new Promise((resolve, reject) => {
    let previous = null, stable = 0, frames = 0;
    const started = performance.now();
    function frame() {
      try {
        const element = document.querySelector(".react-flow__viewport");
        if (!element) return reject(new Error("zoom_viewport_unavailable"));
        const matrix = new DOMMatrixReadOnly(getComputedStyle(element).transform);
        const viewport = { x: matrix.e, y: matrix.f, zoom: matrix.a };
        if (![viewport.x, viewport.y, viewport.zoom].every(Number.isFinite) || viewport.zoom <= 0) {
          return reject(new Error("zoom_viewport_invalid"));
        }
        frames++;
        if (performance.now() - started >= 5000) return reject(new Error("zoom_settle_exceeded"));
        const changed = !direction || direction * (viewport.zoom - before.zoom) > 1e-6;
        stable = changed && previous && ["x", "y", "zoom"].every((key) => Math.abs(viewport[key] - previous[key]) < 1e-6)
          ? stable + 1 : 0;
        if (stable >= 2 && performance.now() - started >= minimumMs) return resolve({ viewport, observed_frames: frames });
        if (frames >= maxFrames) return reject(new Error("zoom_settle_exceeded"));
        previous = viewport;
        requestAnimationFrame(frame);
      } catch (error) { reject(error); }
    }
    requestAnimationFrame(frame);
  });
}

/** Only fixed diagnostic codes may cross into reports, never arbitrary errors. */
export function zoomFailureCode(error) {
  const firstLine = String(error?.message ?? "").split("\n", 1)[0];
  return ["zoom_attempted_mutation", "zoom_rendered_counts_changed", "zoom_round_trip_not_restored",
    "zoom_settle_exceeded", "zoom_viewport_unavailable", "zoom_viewport_invalid"].find((code) =>
    firstLine === code || firstLine.endsWith("Error: " + code));
}

/** UI-only round trip; no transform setters, fixture movement or canonical writes. */
export async function measureZoom(page, { cpu = null, phases = false } = {}) {
  let blocked = 0;
  const protect = async (route) => {
    if (!["GET", "HEAD"].includes(route.request().method())) {
      blocked++;
      await route.abort();
    } else await route.fallback();
  };
  const counts = () => page.evaluate(() => ({
    nodes: document.querySelectorAll(".react-flow__node").length,
    edges: document.querySelectorAll(".react-flow__edge").length,
    minimap_shapes: document.querySelectorAll(".react-flow__minimap-node").length,
    selected_nodes: document.querySelectorAll(".react-flow__node.selected").length
  }));
  const action = async (before, direction) => {
    if (phases) await page.evaluate(() => window.__sttPhaseProbe.start());
    await cpu?.start();
    const start = performance.now();
    await page.locator(direction > 0 ? ".react-flow__controls-zoomin" : ".react-flow__controls-zoomout").click();
    const observed = await page.evaluate(settledViewport, { before, direction });
    const result = { settled_ms: performance.now() - start, zoom_before: before.zoom,
      zoom_after: observed.viewport.zoom, observed_frames: observed.observed_frames };
    if (cpu) result.cpu = await cpu.stop();
    if (phases) result.phases = await page.evaluate(() => window.__sttPhaseProbe.stop());
    return { viewport: observed.viewport, result };
  };
  await page.route("**/api/**", protect);
  try {
    // App schedules projection fit after 80 ms with a 260 ms animation.
    const initial = (await page.evaluate(settledViewport, { minimumMs: 350 })).viewport;
    const beforeCounts = await counts();
    const zoomIn = await action(initial, 1);
    const zoomOut = await action(zoomIn.viewport, -1);
    const afterCounts = await counts();
    if (blocked) throw new Error("zoom_attempted_mutation");
    if (!Object.keys(beforeCounts).every((key) => beforeCounts[key] === afterCounts[key])) throw new Error("zoom_rendered_counts_changed");
    // Compare camera state internally; reports must not retain placement coordinates.
    if (!["x", "y", "zoom"].every((key) => Math.abs(initial[key] - zoomOut.viewport[key]) <= 1e-3)) {
      throw new Error("zoom_round_trip_not_restored");
    }
    return { zoom_in: zoomIn.result, zoom_out: zoomOut.result, rendered_before: beforeCounts,
      rendered_after: afterCounts, round_trip_restored: true, blocked_mutations: blocked };
  } finally {
    await page.unroute("**/api/**", protect);
  }
}
