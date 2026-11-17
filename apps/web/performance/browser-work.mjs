/** Fixed names only: no trace arguments, URLs, stack frames or authored data survive. */
export const BROWSER_WORK_EVENTS = Object.freeze([
  "HitTest", "Paint", "PrePaint", "Layerize", "UpdateLayerTree", "CompositeLayers",
  "Layout", "UpdateLayoutTree", "RecalculateStyles", "EvaluateScript", "FunctionCall",
  "EventDispatch", "RunMicrotasks", "TimerFire", "FireAnimationFrame"
]);
const allowed = new Set(BROWSER_WORK_EVENTS);

function unionMs(rows) {
  const intervals = rows.map((row) => [row.start, row.start + row.duration]).sort((a, b) => a[0] - b[0]);
  let total = 0, end = -Infinity;
  for (const [start, nextEnd] of intervals) {
    total += Math.max(0, nextEnd - Math.max(start, end));
    end = Math.max(end, nextEnd);
  }
  return total / 1000;
}

/** Each recorder belongs only to an opt-in isolated browser action, never the app. */
export function createBrowserWorkCollector(limit = 50000) {
  if (!Number.isInteger(limit) || limit < 1 || limit > 50000) throw new Error("invalid_browser_work_limit");
  const rows = [], threads = new Set();
  const unsupported = new Map();
  let truncated = false, invalid = false;
  return {
    collect(events) {
      for (const event of events) {
        if (event.ph === "M" && event.name === "thread_name" && event.args?.name === "CrRendererMain") {
          if (threads.size < 2 && Number.isInteger(event.pid) && Number.isInteger(event.tid)) threads.add(`${event.pid}:${event.tid}`);
          continue;
        }
        if (!allowed.has(event.name)) continue;
        if (event.ph !== "X" && event.ph !== "I" && event.ph !== "i") {
          const phase = ["B", "E", "I", "i", "b", "e", "s", "t", "f"].includes(event.ph) ? event.ph : "unknown";
          const key = `${event.name}:${phase}`;
          unsupported.set(key, (unsupported.get(key) ?? 0) + 1);
          invalid = true; continue;
        }
        const instant = event.ph !== "X";
        if (!Number.isInteger(event.pid) || !Number.isInteger(event.tid)
          || !Number.isFinite(event.ts) || (!instant && (!Number.isFinite(event.dur) || event.dur < 0))) { invalid = true; continue; }
        if (rows.length >= limit) { truncated = true; continue; }
        rows.push({ name: event.name, thread: `${event.pid}:${event.tid}`, start: event.ts, duration: instant ? null : event.dur });
      }
    },
    summarize(dataLoss = false) {
      const reason = truncated ? "event_limit" : dataLoss ? "trace_data_loss" : invalid ? "unsupported_event"
        : threads.size !== 1 ? "renderer_main_ambiguous_or_missing" : null;
      if (reason) return { state: "unavailable", reason,
        ...(unsupported.size ? { unsupported_shapes: [...unsupported].map(([key, count]) => {
          const [name, phase] = key.split(":"); return { name, phase, count };
        }) } : {}) };
      const main = rows.filter((row) => threads.has(row.thread));
      if (!main.length) return { state: "unavailable", reason: "no_allowlisted_main_events" };
      const events = BROWSER_WORK_EVENTS.flatMap((name) => {
        const group = main.filter((row) => row.name === name);
        const timed = group.filter((row) => row.duration !== null);
        return group.length ? [{ name, count: group.length, timed_count: timed.length, instant_count: group.length - timed.length,
          union_ms: timed.length ? unionMs(timed) : null,
          inclusive_ms: timed.length ? timed.reduce((sum, row) => sum + row.duration, 0) / 1000 : null,
          max_ms: timed.length ? timed.reduce((max, row) => Math.max(max, row.duration), 0) / 1000 : null }] : [];
      });
      const timed = main.filter((row) => row.duration !== null);
      return { state: "observed", main_event_count: main.length, allowlisted_union_ms: timed.length ? unionMs(timed) : null, events,
        unobserved_events: BROWSER_WORK_EVENTS.filter((name) => !events.some((row) => row.name === name)) };
    }
  };
}

/** CDP Tracing ReportEvents; discard raw chunks immediately after numeric extraction. */
export async function createBrowserWorkRecorder(page) {
  const cdp = await page.context().newCDPSession(page);
  let collector, receive;
  return {
    async start() {
      collector = createBrowserWorkCollector();
      receive = ({ value }) => collector.collect(value);
      cdp.on("Tracing.dataCollected", receive);
      try {
        await cdp.send("Tracing.start", { transferMode: "ReportEvents",
          categories: "devtools.timeline,disabled-by-default-devtools.timeline,__metadata" });
      } catch (error) { cdp.off("Tracing.dataCollected", receive); throw error; }
    },
    async stop() {
      let timer, complete;
      const done = new Promise((resolve, reject) => {
        complete = resolve;
        cdp.once("Tracing.tracingComplete", complete);
        timer = setTimeout(() => reject(new Error("browser_timeline_timeout")), 10000);
      });
      try {
        await cdp.send("Tracing.end");
        const result = await done;
        return collector.summarize(Boolean(result.dataLossOccurred));
      } finally {
        clearTimeout(timer);
        cdp.off("Tracing.tracingComplete", complete);
        cdp.off("Tracing.dataCollected", receive);
        collector = null;
      }
    }
  };
}
