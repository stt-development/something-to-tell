/** Small, sanitized metric summaries; never reinterpret a censored run as fast. */
export function summarize(values) {
  if (values.some((value) => !Number.isFinite(value) || value < 0)) throw new Error("invalid_baseline_sample");
  const sorted = [...values].sort((a, b) => a - b);
  if (!sorted.length) return { count: 0, median_ms: null, max_ms: null, p95_ms: null };
  return {
    count: sorted.length,
    median_ms: sorted[Math.floor(sorted.length / 2)],
    max_ms: sorted.at(-1),
    // Fewer than twenty observations cannot meaningfully resolve the upper tail.
    p95_ms: sorted.length >= 20 ? sorted[Math.ceil(sorted.length * 0.95) - 1] : null
  };
}

export function resourceSummary(entries) {
  return entries.filter((entry) => entry.name.includes("/api/")).map((entry) => ({
    route: sanitizeRoute(entry.name),
    wait_ms: Math.max(0, entry.responseStart - entry.requestStart),
    transfer_ms: Math.max(0, entry.responseEnd - entry.responseStart),
    decoded_bytes: entry.decodedBodySize
  }));
}

export function sanitizeRoute(url) {
  return new URL(url).pathname
    .replace(/\/project-sessions\/(?!open$|catalog$|create$|directories$)[^/]+/, "/project-sessions/:id")
    .replace(/\/projects\/[^/]+/, "/projects/:id");
}
