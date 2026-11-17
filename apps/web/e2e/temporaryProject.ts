import { expect, test as base, type Page } from "@playwright/test";
import { mkdtemp, readFile, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

interface TemporaryProjectFixtures {
  _projectCleanup: void;
  projectDirectory: string;
}

const registeredProjectDirectories = new WeakMap<Page, Set<string>>();

/**
 * Keeps durable-project browser tests outside the user's real catalog and
 * releases runtime sessions even when an assertion interrupts the workflow.
 */
export const test = base.extend<TemporaryProjectFixtures>({
  _projectCleanup: [async ({ page }, use) => {
    await use();
    for (const directory of registeredProjectDirectories.get(page) ?? []) {
      await cleanupProjectDirectory(directory);
    }
    registeredProjectDirectories.delete(page);
  }, { auto: true }],
  projectDirectory: async ({}, use, testInfo) => {
    const directory = await mkdtemp(join(tmpdir(), `stt-e2e-${testInfo.workerIndex}-`));
    try {
      await use(directory);
    } finally {
      await cleanupProjectDirectory(directory);
    }
  }
});

export { expect };

/** Registers fixture-import directories for automatic per-page teardown. */
export function registerTemporaryProjectDirectory(page: Page, directory: string): void {
  const directories = registeredProjectDirectories.get(page) ?? new Set<string>();
  directories.add(directory);
  registeredProjectDirectories.set(page, directories);
}

async function cleanupProjectDirectory(directory: string): Promise<void> {
  try {
    await closeProjectSessions(directory);
  } finally {
    await rm(directory, { force: true, recursive: true });
  }
}

/** Saves dirty test sessions before closing them so teardown never loses diagnostics. */
async function closeProjectSessions(directory: string): Promise<void> {
  const entries = await readdir(directory, { withFileTypes: true }).catch(() => []);
  for (const entry of entries) {
    if (!entry.isDirectory() || !entry.name.endsWith(".narrative")) continue;
    const lockPath = join(directory, entry.name, "cache", "project.lock.json");
    const lock = await readFile(lockPath, "utf8")
      .then((value) => JSON.parse(value) as { session_id: string })
      .catch(() => null);
    if (!lock) continue;

    const current = await requestSession(lock.session_id).catch(() => null);
    if (!current) continue;
    if (current.session.save_status !== "clean") {
      const saved = await fetch(`${sessionApi(lock.session_id)}/save`, {
        body: JSON.stringify({
          expected_revision: current.session.saved_revision,
          reason: "manual"
        }),
        headers: { "content-type": "application/json" },
        method: "POST"
      });
      // Test projects may be discarded when a deliberately failing workflow
      // leaves an unsavable draft; releasing the runtime lock takes priority.
      if (!saved.ok) {
        await fetch(`${sessionApi(lock.session_id)}/discard`, {
          headers: { "content-type": "application/json" },
          method: "POST"
        });
      }
    }
    await fetch(`${sessionApi(lock.session_id)}/close`, {
      body: "{}",
      headers: { "content-type": "application/json" },
      method: "POST"
    });
  }
}

function requestSession(sessionId: string): Promise<{ session: { save_status: string; saved_revision: number } }> {
  return fetch(sessionApi(sessionId)).then(async (response) => {
    if (!response.ok) throw new Error(`Session inspection failed: ${response.status}`);
    return response.json() as Promise<{ session: { save_status: string; saved_revision: number } }>;
  });
}

function sessionApi(sessionId: string): string {
  return `http://127.0.0.1:8719/api/project-sessions/${sessionId}`;
}
