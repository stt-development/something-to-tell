import { spawn } from "node:child_process";
import { createInterface } from "node:readline";
import { assertOwnedFixture } from "./owned-session.mjs";

/** Parse through URL, never ad hoc DSN splitting or secret-bearing diagnostics. */
export function postgresConnection(value) {
  try {
    const url = new URL(value.replace(/^postgresql\+psycopg:/, "postgresql:"));
    if (url.protocol !== "postgresql:" || !url.username || !url.hostname) throw new Error();
    const tls = url.searchParams.get("sslmode") ?? "verify-full";
    if (!["disable", "require", "verify-full"].includes(tls)) throw new Error();
    return { host: url.hostname, port: Number(url.port || 5432), username: decodeURIComponent(url.username),
      password: decodeURIComponent(url.password), tls_policy: tls };
  } catch { throw new Error("invalid_probe_postgres_url"); }
}

export async function startPostgres(repository) {
  if (!process.env.STT_TEST_POSTGRES_URL) throw new Error("probe_postgres_test_url_required");
  const connection = postgresConnection(process.env.STT_TEST_POSTGRES_URL);
  const child = spawn("uv", ["run", "python", "-m", "services.runtime.scripts.frontend_postgres"],
    { cwd: repository, stdio: ["pipe", "pipe", "ignore"] });
  const exited = new Promise((resolve) => child.once("close", resolve));
  const lines = createInterface({ input: child.stdout });
  const ready = new Promise((resolve, reject) => {
    child.once("error", () => reject(new Error("probe_database_spawn_failed")));
    exited.then(() => reject(new Error("probe_database_start_failed")));
    lines.once("line", (line) => {
      try {
        const data = JSON.parse(line);
        if (!/^stt_p9_scale_[a-f0-9]{32}$/.test(data.database)) throw new Error();
        resolve(data.database);
      } catch { reject(new Error("probe_database_identity_invalid")); }
    });
  });
  let database;
  try { database = await ready; } catch (error) { child.stdin.end(); await exited; throw error; }
  lines.close();
  return {
    connection: { ...connection, database },
    async stop() {
      child.stdin.end();
      const code = await exited;
      if (code !== 0) throw new Error("probe_database_cleanup_failed");
    }
  };
}

/** Provision outside browser timings, through the same explicit migration boundary. */
export async function preparePostgresFixture(fixture, runtime, connection, fetcher = fetch) {
  assertOwnedFixture(fixture);
  const post = async (path, body) => {
    const response = await fetcher(runtime + path, { method: "POST", headers: { "content-type": "application/json", "X-Remote-Storage-Version": "1" },
      body: JSON.stringify(body), signal: AbortSignal.timeout(60000) });
    if (!response.ok) {
      const failure = await response.json().catch(() => null);
      const code = failure?.detail?.code;
      const error = new Error("probe_database_preparation_failed");
      error.code = typeof code === "string" && /^[a-z_]{1,80}$/.test(code) ? code : "unclassified";
      error.stage = path.split("/").at(-1);
      error.status = response.status;
      throw error;
    }
    return response.json();
  };
  const opened = await post("/project-sessions/open", { path: fixture.path, recovery_mode: "recover" });
  const sessionId = opened.session.session_id;
  try {
    const profile = await post("/storage-profiles", { ...connection, session_id: sessionId, label: "Disposable frontend baseline" });
    const migrated = await post("/storage-migrations", { session_id: sessionId, expected_revision: opened.session.saved_revision,
      target_mode: "postgresql", target_profile_id: profile.profile_id });
    const counts = Object.fromEntries(Object.entries(migrated.project.document).filter(([, value]) => Array.isArray(value)).map(([key, value]) => [key, value.length]));
    return { storage_mode: "postgresql", collection_counts: counts };
  } finally { await post(`/project-sessions/${encodeURIComponent(sessionId)}/close`, {}); }
}
