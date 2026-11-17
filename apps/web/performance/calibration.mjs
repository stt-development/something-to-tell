import { summarize } from "./metrics.mjs";
import { observeAction } from "./workflow-observation.mjs";

/** Verify the actual UI state, not only that a tool/menu click was dispatched. */
export function activeCanvasTool(label, dom = document) {
  return dom.querySelector(`nav button[aria-label="${label}"]`)?.classList.contains("tool-button-active") === true;
}
export async function calibratedTool(page, label) {
  return observeAction(() => page.getByRole("button", { name: label, exact: true }).click(), async () => {
    await page.waitForFunction(activeCanvasTool, label);
    await page.evaluate(() => new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve))));
  });
}
export async function calibratedMenu(page, open) {
  return observeAction(() => page.getByTitle("Projects", { exact: true }).click(), async () => {
    await page.waitForFunction((expected) => Boolean(document.querySelector(".project-tree-row")) === expected, open);
    await page.evaluate(() => new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve))));
  });
}

/** Fixed numerical summaries only; unavailable observations can never pass targets. */
export function calibrationSummary(item) {
  if (item.status !== "ok") return { state: "unavailable", reason: item.error_code ?? item.status, criteria: [] };
  const rows = item.samples ?? [];
  const first = rows.filter((row) => row.cache === "first_project_install");
  const warm = rows.filter((row) => row.cache === "warm_same_page");
  const metric = (samples, key) => summarize(samples.map((row) => row[key]));
  const values = {
    open_first: metric(first, "open_canvas_ms"), open_warm: metric(warm, "open_canvas_ms"),
    canvas_first: metric(first, "post_response_canvas_ms"), canvas_warm: metric(warm, "post_response_canvas_ms"),
    menu_close: metric(rows, "menu_close_feedback_ms"), menu_open: metric(rows, "menu_open_feedback_ms"),
    tool_select: metric(rows, "tool_select_feedback_ms"), tool_pan: metric(rows, "tool_pan_feedback_ms"),
    runtime_open_wait: summarize(rows.flatMap((row) => row.resources.filter((entry) => entry.route === "/api/project-sessions/open").map((entry) => entry.wait_ms))),
    gesture_frame_p95: summarize(rows.map((row) => row.pan_frames.p95_ms).filter((value) => value !== null))
  };
  const criteria = [];
  const add = (name, observed, limit, available) => criteria.push({ name, observed_ms: available ? observed : null, limit_ms: limit,
    state: !available ? "unavailable" : observed <= limit ? "within_target" : "exceeds_target" });
  for (const name of ["menu_close", "menu_open", "tool_select", "tool_pan"]) add(name + "_p95", values[name].p95_ms, 100, values[name].p95_ms !== null);
  add("first_canvas_max", values.canvas_first.max_ms, 2000, first.length > 0);
  add("warm_canvas_max", values.canvas_warm.max_ms, 2000, warm.length >= 20);
  add("worst_gesture_frame_p95", values.gesture_frame_p95.max_ms, 32,
    rows.length >= 20 && values.gesture_frame_p95.count === rows.length && rows.every((row) => row.pan_frames.count >= 20));
  return { state: criteria.some((entry) => entry.state === "unavailable") ? "incomplete"
    : criteria.some((entry) => entry.state === "exceeds_target") ? "baseline_exceeds_targets" : "within_measured_targets",
    first_count: first.length, warm_count: warm.length, metrics: values, criteria };
}
