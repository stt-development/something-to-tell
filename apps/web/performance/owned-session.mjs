import { readFile, rm } from "node:fs/promises";
import { resolve } from "node:path";

/** A second guard before permitting any write-capable UI drill. */
export function assertOwnedFixture(fixture) {
  const directory = resolve(fixture.directory);
  if (!/\/stt-frontend-baseline-[^/]+\/fixture-(small|1000)$/.test(directory)
      || resolve(fixture.path) !== resolve(directory, "Baseline.narrative")) throw new Error("unowned_probe_fixture");
}

/** Dirty failed drills must release only their own checkpoint/lock, never user data. */
export async function cleanupOwnedFixture(fixture, runtime, fetcher = fetch) {
  assertOwnedFixture(fixture);
  const lockPath = resolve(fixture.path, "cache/project.lock.json");
  const held = () => readFile(lockPath, "utf8").then(JSON.parse).catch(() => null);
  const lock = await held();
  if (lock) {
    const post = (action) => fetcher(`${runtime}/project-sessions/${encodeURIComponent(lock.session_id)}/${action}`, {
      method: "POST", headers: { "content-type": "application/json", "X-Remote-Storage-Version": "1" }, body: "{}", signal: AbortSignal.timeout(30000)
    }).catch(() => null);
    let response = await post("close");
    if (!response?.ok && await held()) {
      const discarded = await post("discard");
      if (discarded?.ok) response = await post("close");
    }
    if (response?.ok) await response.arrayBuffer();
  }
  if (await held()) return "retained_locked_fixture";
  await rm(fixture.directory, { recursive: true, force: true });
  return "released";
}

export async function ownedSession(page, config) {
  assertOwnedFixture(config.fixture);
  const lock = JSON.parse(await readFile(resolve(config.fixture.path, "cache/project.lock.json"), "utf8"));
  const seed = JSON.parse(await readFile(resolve(config.fixture.directory, "source.json"), "utf8"));
  const read = async () => {
    const response = await page.request.get(`${config.url}/api/project-sessions/${encodeURIComponent(lock.session_id)}`);
    if (!response.ok()) throw new Error("probe_snapshot_read_failed");
    const payload = await response.json();
    if (payload.session.project_id !== seed.manifest.project_id || payload.document.manifest.project_id !== seed.manifest.project_id) {
      throw new Error("probe_project_identity_mismatch");
    }
    return payload;
  };
  return { read, initial: await read(), sessionId: lock.session_id };
}

/** Receipt and UI clocks overlap; return both rather than subtracting one from another. */
export async function observeCommand(page, matches, perform, verifyFeedback) {
  const pending = page.waitForResponse(matches).then((response) => ({ response }), (error) => ({ error }));
  const start = performance.now();
  await perform();
  await verifyFeedback();
  const feedback = performance.now() - start;
  const result = await pending;
  if (result.error) throw result.error;
  if (!result.response.ok() || await result.response.finished()) throw new Error("probe_command_failed");
  const receipt = result.response.request().timing().responseEnd;
  if (!Number.isFinite(receipt) || receipt < 0) throw new Error("probe_command_timing_unavailable");
  return { feedback_ms: feedback, command_response_ms: receipt, total_ms: performance.now() - start, status: result.response.status() };
}
