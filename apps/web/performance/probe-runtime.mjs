/** Probe-only routing: never send test storage credentials to a remote origin. */
export function probeRuntimeOrigin(value = process.env.STT_PERF_RUNTIME_ORIGIN) {
  if (value === undefined) return "http://127.0.0.1:8719";
  try {
    const url = new URL(value);
    if (url.protocol !== "http:" || !["127.0.0.1", "localhost"].includes(url.hostname)
      || url.username || url.password || url.pathname !== "/" || url.search || url.hash) throw new Error();
    return url.origin;
  } catch {
    // Never include supplied values: a rejected URL may contain credentials.
    throw new Error("invalid_probe_runtime_origin");
  }
}
