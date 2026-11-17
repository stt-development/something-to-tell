import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { exportPublicSource, isPublicSourcePath, publicReadme } from "./public-source-export.mjs";

test("publication excludes all agent/master-plan files and only admits docs/guides", () => {
  for (const path of ["AGENTS.md", "nested/AGENTS.md", "narrative_graph_agent_system_master_plan.md", "docs/adr/a.md", "docs/examples/a.md", "docs/verification/a.json", "docs/orchestrator.md", "docs/guides/AGENTS.md", "/absolute", "../file", "x/.git/config"]) assert.equal(isPublicSourcePath(path), false, path);
  for (const path of [".env.example", "LICENSE", "apps/web/src/App.tsx", "docs/guides/catalog.json", "docs/guides/assets/start/a.png", "tools/phase-loop.mjs"]) assert.equal(isPublicSourcePath(path), true, path);
});

test("public README contains guides/license links, not private documentation references", () => {
  const text = publicReadme();
  assert.match(text, /docs\/guides\/README\.md/);
  assert.match(text, /\[LICENSE\]\(LICENSE\)/);
  assert.doesNotMatch(text, /docs\/(architecture|adr|tasks|verification|examples)|AGENTS\.md|narrative_graph_agent_system_master_plan/);
  assert.match(text, /Experimental packaged candidates start a verified/);
  assert.match(text, /Browser and Tauri development\nrequire the backend separately/);
  assert.doesNotMatch(text, /collaborat|Steam/i);
  assert.match(text, /one active writer at a time/);
  assert.doesNotMatch(readFileSync(new URL("../README.md", import.meta.url), "utf8"), /collaborat|Steam/i);
});

test("both repository descriptions publish only the agreed English descriptor", () => {
  const internal = readFileSync(new URL("../README.md", import.meta.url), "utf8");
  for (const text of [internal, publicReadme()]) {
    assert.ok(text.startsWith("# Something To Tell Engine\n\n*Visual authoring for branching stories*\n"));
    assert.doesNotMatch(text, /Визуальный редактор ветвящихся историй/);
  }
});

test("export uses current nonignored files, preserves bytes and refuses overwriting target work", () => {
  const directory = mkdtempSync(join(tmpdir(), "stt-public-export-"));
  const source = join(directory, "source"), target = join(directory, "public");
  try {
    for (const path of [source, target]) { mkdirSync(path); execFileSync("git", ["init", "-b", "main", path], { stdio: "ignore" }); }
    writeFileSync(join(source, ".gitignore"), ".env\n");
    writeFileSync(join(source, "README.md"), "Internal readme");
    writeFileSync(join(source, "main.py"), "print('current working tree')\n");
    writeFileSync(join(source, ".env"), "PRIVATE=true");
    writeFileSync(join(source, "AGENTS.md"), "Private instructions");
    mkdirSync(join(source, "docs/guides"), { recursive: true });
    writeFileSync(join(source, "docs/guides/a.en.md"), "# Guide");
    writeFileSync(join(source, "docs/private.md"), "Private doc");
    execFileSync("git", ["-C", source, "add", "."]);
    execFileSync("git", ["-C", source, "-c", "user.name=Export Test", "-c", "user.email=export-test@example.invalid", "commit", "-m", "test"], { stdio: "ignore" });
    const plan = exportPublicSource({ source, target });
    assert.equal(plan.files, 4); assert.equal(plan.excluded, 2);
    assert.equal(existsSync(join(target, "main.py")), false);
    const copied = exportPublicSource({ source, target, write: true });
    assert.equal(copied.tree_sha256, plan.tree_sha256);
    assert.equal(readFileSync(join(target, "main.py"), "utf8"), readFileSync(join(source, "main.py"), "utf8"));
    assert.equal(readFileSync(join(target, "README.md"), "utf8"), publicReadme());
    for (const path of ["AGENTS.md", ".env", "docs/private.md"]) assert.equal(existsSync(join(target, path)), false);
    assert.equal(execFileSync("git", ["-C", target, "rev-list", "--all"], { encoding: "utf8" }), "");
    assert.equal(exportPublicSource({ source, target, write: true }).tree_sha256, copied.tree_sha256);
    writeFileSync(join(target, "main.py"), "User edit");
    assert.throws(() => exportPublicSource({ source, target, write: true }), /differing data/);
    assert.equal(readFileSync(join(target, "main.py"), "utf8"), "User edit");
  } finally { rmSync(directory, { recursive: true, force: true }); }
});
