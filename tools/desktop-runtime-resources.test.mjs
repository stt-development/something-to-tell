// Candidate staging is a publication boundary: stale/extra/escaping bytes must fail.
import assert from "node:assert/strict";
import fs from "node:fs";
import { syncBuiltinESMExports } from "node:module";
import { createHash } from "node:crypto";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test from "node:test";
import { stageRuntime, verifyCandidate } from "./desktop-runtime-resources.mjs";

const sha = bytes => createHash("sha256").update(bytes).digest("hex");

function fixture() {
  const root = mkdtempSync(join(tmpdir(), "stt-runtime-stage-"));
  const candidate = join(root, "dist/candidate/stt-runtime");
  mkdirSync(candidate, { recursive: true });
  const names = ["pyproject.toml", "uv.lock", "services/runtime/desktop_entry.py",
    "services/runtime/alembic.ini", "services/runtime/scripts/build_desktop_runtime.py",
    "services/runtime/migrations/env.py", "services/runtime/stt_runtime/app.py"];
  for (const path of names) {
    mkdirSync(dirname(join(root, path)), { recursive: true });
    writeFileSync(join(root, path), path);
  }
  const executable = process.platform === "win32" ? "stt-runtime.exe" : "stt-runtime";
  writeFileSync(join(candidate, executable), "binary", { mode: 0o755 });
  const manifest = { schema_version: 1, system: { darwin: "Darwin", linux: "Linux", win32: "Windows" }[process.platform],
    machine: process.arch, lock_sha256: sha("uv.lock"),
    sources: names.map(path => ({ path, sha256: sha(path) })),
    files: [{ path: executable, bytes: 6, sha256: sha("binary") }] };
  writeFileSync(join(dirname(candidate), "manifest.json"), JSON.stringify(manifest));
  return { root, candidate, manifest, executable };
}

test("stages exact candidate into fresh resources without overwriting previous output", () => {
  const { root, candidate, executable } = fixture();
  try {
    const first = stageRuntime({ candidate, source: root });
    const second = stageRuntime({ candidate, source: root });
    assert.notEqual(first.runtime, second.runtime);
    assert.equal(readFileSync(join(first.runtime, executable), "utf8"), "binary");
    const config = JSON.parse(readFileSync(first.configuration));
    assert.deepEqual(Object.values(config.bundle.resources), ["runtime/"]);
    assert.ok(Object.keys(config.bundle.resources)[0].endsWith("/runtime/"));
    assert.equal(readFileSync(join(candidate, executable), "utf8"), "binary");
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("rejects changed or added artifact files before creating staging directories", () => {
  const { root, candidate, manifest, executable } = fixture();
  try {
    writeFileSync(join(candidate, executable), "tamper");
    assert.throws(() => verifyCandidate(candidate, manifest, root), /content_changed/);
    writeFileSync(join(candidate, executable), "binary");
    writeFileSync(join(candidate, "extra"), "extra");
    assert.throws(() => stageRuntime({ candidate, source: root }), /extra_files/);
    assert.equal(existsSync(join(root, "build")), false);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("rejects stale source sets, wrong platform and unsafe manifest paths", () => {
  const { root, candidate, manifest, executable } = fixture();
  try {
    const invalid = structuredClone(manifest); invalid.files[0].path = "../outside";
    assert.throws(() => verifyCandidate(candidate, invalid, root), /path_invalid/);
    assert.throws(() => verifyCandidate(candidate, { ...manifest, system: "other" }, root), /platform_mismatch/);
    if (process.platform !== "win32") {
      chmodSync(join(candidate, executable), 0o644);
      assert.throws(() => verifyCandidate(candidate, manifest, root), /permissions_invalid/);
      chmodSync(join(candidate, executable), 0o755);
    }
    writeFileSync(join(root, "services/runtime/stt_runtime/new.py"), "new code");
    assert.throws(() => verifyCandidate(candidate, manifest, root), /manifest_incomplete/);
    rmSync(join(root, "services/runtime/stt_runtime/new.py"));
    writeFileSync(join(root, "uv.lock"), "changed");
    assert.throws(() => verifyCandidate(candidate, manifest, root), /source_stale/);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("rejects candidate aliases that escape the bundle", { skip: process.platform === "win32" }, () => {
  const { root, candidate, manifest, executable } = fixture();
  try {
    rmSync(join(candidate, executable));
    symlinkSync(join(root, "uv.lock"), join(candidate, executable));
    assert.throws(() => verifyCandidate(candidate, manifest, root), /path_escape/);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("Tauri exposes only state-owned resource start/status and explicit exit cleanup", () => {
  const adapter = readFileSync(new URL("../apps/desktop/src-tauri/src/runtime_commands.rs", import.meta.url), "utf8");
  const shell = readFileSync(new URL("../apps/desktop/src-tauri/src/lib.rs", import.meta.url), "utf8");
  assert.match(adapter, /pub async fn start_bundled_runtime\([\s\S]*?app: AppHandle,[\s\S]*?state: State<'_, DesktopRuntime>,\s*\)/);
  assert.match(adapter, /app\s*\.path\(\)\s*\.resource_dir\(\)/);
  assert.match(adapter, /spawn_blocking/);
  assert.doesNotMatch(adapter, /std::process::Command|STT_RUNTIME_URL/);
  assert.match(shell, /runtime_commands::start_bundled_runtime/);
  assert.match(shell, /tauri::RunEvent::Exit/);
  assert.match(shell, /runtime\.stop\(\)/);
});

test("materializes internal file/directory aliases before bundling with a distinct checked manifest", { skip: process.platform === "win32" }, () => {
  const { root, candidate, manifest } = fixture();
  try {
    mkdirSync(join(candidate, "data"));
    writeFileSync(join(candidate, "data/value"), "value");
    symlinkSync("data", join(candidate, "alias"));
    manifest.files.push({ path: "data/value", bytes: 5, sha256: sha("value") }, { path: "alias", symlink: "data" });
    writeFileSync(join(dirname(candidate), "manifest.json"), JSON.stringify(manifest));
    const result = stageRuntime({ candidate, source: root });
    const expanded = JSON.parse(readFileSync(result.manifest));
    assert.equal(expanded.normalization.strategy, "materialize-internal-aliases-v1");
    assert.equal(expanded.files.find(file => file.path === "alias/value").sha256, sha("value"));
    assert.ok(expanded.files.every(file => file.symlink === undefined));
    assert.equal(verifyCandidate(result.runtime, expanded, root), realpathSync(result.runtime));
    assert.notEqual(result.source_manifest_sha256, result.manifest_sha256);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("rejects an internal directory-alias cycle instead of recursively expanding it", { skip: process.platform === "win32" }, () => {
  const { root, candidate, manifest } = fixture();
  try {
    mkdirSync(join(candidate, "data"));
    symlinkSync(".", join(candidate, "data/loop"));
    manifest.files.push({ path: "data/loop", symlink: "." });
    writeFileSync(join(dirname(candidate), "manifest.json"), JSON.stringify(manifest));
    assert.throws(() => stageRuntime({ candidate, source: root }), /alias_cycle/);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("a candidate changed during copy is rejected, not legitimized by a new manifest", () => {
  const { root, candidate } = fixture();
  const original = fs.copyFileSync;
  try {
    // Mutate after preflight, at the actual copy boundary; no timing-dependent watcher.
    fs.copyFileSync = (input, output, flags) => {
      writeFileSync(input, "tamper");
      return original(input, output, flags);
    };
    syncBuiltinESMExports();
    assert.throws(() => stageRuntime({ candidate, source: root }), /changed_during_copy/);
  } finally {
    fs.copyFileSync = original;
    syncBuiltinESMExports();
    rmSync(root, { recursive: true, force: true });
  }
});
