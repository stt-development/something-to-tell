// Guards must inspect an uncommitted publication snapshot, not report an empty success.
import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

for (const guard of ["architecture", "source-size"]) {
  test(`${guard} CLI checks new files and ignores local output before the first commit`, () => {
    const root = mkdtempSync(join(tmpdir(), "stt-repository-guard-"));
    try {
      execFileSync("git", ["init", root], { stdio: "ignore" });
      writeFileSync(join(root, ".gitignore"), "ignored.ts\n");
      writeFileSync(join(root, "ignored.ts"), "code\n".repeat(2001));
      mkdirSync(join(root, "apps/web/src/runtime"), { recursive: true });
      mkdirSync(join(root, "apps/web/src/components"), { recursive: true });
      writeFileSync(join(root, "apps/web/src/runtime/client.ts"), "import '../components/View';\n");
      const view = join(root, "apps/web/src/components/View.ts");
      writeFileSync(view, guard === "source-size" ? "code\n".repeat(2001) : "export const view = true;\n");
      const script = fileURLToPath(new URL(`./${guard}-guard.mjs`, import.meta.url));
      const result = spawnSync(process.execPath, [script], { cwd: root, encoding: "utf8" });
      assert.equal(result.status, 1, result.stdout + result.stderr);
      assert.match(result.stdout + result.stderr, guard === "source-size" ? /hard_limit/ : /runtime_client_imports_ui_or_state/);
      assert.doesNotMatch(result.stdout + result.stderr, /ignored\.ts/);
      assert.match(result.stdout, /2 (?:production files|checked)/);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
}
