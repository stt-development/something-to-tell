// Synthetic AppDirs test byte preservation; no native Linux tooling is simulated.
import assert from "node:assert/strict";
import fs from "node:fs";
import { syncBuiltinESMExports } from "node:module";
import { createHash } from "node:crypto";
import { tmpdir } from "node:os";
import { dirname, join, relative } from "node:path";
import test from "node:test";
import { finalizeLinuxRuntime } from "./linux-runtime-finalizer.mjs";

const sha = value => createHash("sha256").update(value).digest("hex");

function fixture() {
  const root = fs.mkdtempSync(join(tmpdir(), "stt-linux-finalizer-"));
  const candidate = join(root, "staging/runtime");
  const names = ["pyproject.toml", "uv.lock", "services/runtime/desktop_entry.py",
    "services/runtime/alembic.ini", "services/runtime/scripts/build_desktop_runtime.py",
    "services/runtime/migrations/env.py", "services/runtime/stt_runtime/app.py"];
  for (const name of names) {
    fs.mkdirSync(dirname(join(root, name)), { recursive: true });
    fs.writeFileSync(join(root, name), name);
  }
  const executable = process.platform === "win32" ? "stt-runtime.exe" : "stt-runtime";
  fs.mkdirSync(candidate, { recursive: true });
  fs.writeFileSync(join(candidate, executable), "verified", { mode: 0o755 });
  const appdir = join(root, "packages/Input With Spaces.AppDir");
  const runtime = join(appdir, "usr/lib/Product With Spaces/runtime");
  fs.mkdirSync(runtime, { recursive: true });
  fs.writeFileSync(join(runtime, executable), "rewritten-by-linuxdeploy");
  fs.writeFileSync(join(appdir, "AppRun"), "shell frontend", { mode: 0o755 });
  const manifest = { schema_version: 1,
    system: { darwin: "Darwin", linux: "Linux", win32: "Windows" }[process.platform], machine: process.arch,
    lock_sha256: sha("uv.lock"), sources: names.map(path => ({ path, sha256: sha(path) })),
    files: [{ path: executable, bytes: 8, sha256: sha("verified") }] };
  return { root, candidate, appdir, manifest, executable, runtime };
}

test("restores canonical runtime into fresh AppDir without changing either input", () => {
  const f = fixture();
  try {
    const result = finalizeLinuxRuntime({ ...f, source: f.root });
    assert.notEqual(result.appdir, f.appdir);
    assert.equal(fs.readFileSync(join(result.runtime, f.executable), "utf8"), "verified");
    assert.equal(fs.readFileSync(join(f.candidate, f.executable), "utf8"), "verified");
    assert.equal(fs.readFileSync(join(f.runtime, f.executable), "utf8"), "rewritten-by-linuxdeploy");
    assert.equal(fs.readFileSync(join(result.appdir, "AppRun"), "utf8"), "shell frontend");
    if (process.platform !== "win32") assert.ok(fs.statSync(join(result.runtime, f.executable)).mode & 0o111);
    assert.equal(result.runtime_relative_path, relative(f.appdir, f.runtime));
  } finally { fs.rmSync(f.root, { recursive: true, force: true }); }
});

test("rejects changed canonical source before copying", () => {
  const f = fixture();
  try {
    fs.writeFileSync(join(f.candidate, f.executable), "tampered");
    assert.throws(() => finalizeLinuxRuntime({ ...f, source: f.root }), /runtime_bundle_content_changed/);
    assert.equal(fs.existsSync(join(f.root, "build")), false);
  } finally { fs.rmSync(f.root, { recursive: true, force: true }); }
});

test("rejects a copy race instead of adopting changed output hashes", () => {
  const f = fixture();
  const copy = fs.cpSync;
  try {
    fs.cpSync = (input, output, options) => {
      copy(input, output, options);
      if (input === fs.realpathSync(f.candidate)) fs.writeFileSync(join(output, f.executable), "tampered");
    };
    syncBuiltinESMExports();
    assert.throws(() => finalizeLinuxRuntime({ ...f, source: f.root }), /runtime_bundle_content_changed/);
  } finally {
    fs.cpSync = copy;
    syncBuiltinESMExports();
    fs.rmSync(f.root, { recursive: true, force: true });
  }
});

test("rejects runtime symlinks before writing a fresh AppDir", { skip: process.platform === "win32" }, () => {
  const f = fixture();
  try {
    fs.rmSync(f.runtime, { recursive: true });
    fs.symlinkSync(f.candidate, f.runtime);
    assert.throws(() => finalizeLinuxRuntime({ ...f, source: f.root }), /linux_appdir_directory_invalid/);
    assert.equal(fs.existsSync(join(f.root, "build")), false);
  } finally { fs.rmSync(f.root, { recursive: true, force: true }); }
});

test("relocates internal absolute metadata aliases without altering the input link", { skip: process.platform === "win32" }, () => {
  const f = fixture();
  try {
    fs.symlinkSync(join(f.appdir, "AppRun"), join(f.appdir, ".DirIcon"));
    const result = finalizeLinuxRuntime({ ...f, source: f.root });
    assert.equal(fs.readlinkSync(join(result.appdir, ".DirIcon")), "AppRun");
    assert.equal(fs.readlinkSync(join(f.appdir, ".DirIcon")), join(f.appdir, "AppRun"));
  } finally { fs.rmSync(f.root, { recursive: true, force: true }); }
});

test("a copied ancestor cannot redirect runtime replacement outside fresh output", { skip: process.platform === "win32" }, () => {
  const f = fixture();
  const copy = fs.cpSync;
  const outside = join(f.root, "outside");
  fs.mkdirSync(outside);
  fs.writeFileSync(join(outside, "sentinel"), "untouched");
  try {
    fs.cpSync = (input, output, options) => {
      copy(input, output, options);
      if (input === fs.realpathSync(f.appdir)) {
        const owner = join(output, "usr/lib/Product With Spaces");
        fs.rmSync(owner, { recursive: true });
        fs.symlinkSync(outside, owner);
      }
    };
    syncBuiltinESMExports();
    assert.throws(() => finalizeLinuxRuntime({ ...f, source: f.root }), /linux_appdir_directory_invalid/);
    assert.equal(fs.readFileSync(join(outside, "sentinel"), "utf8"), "untouched");
  } finally {
    fs.cpSync = copy;
    syncBuiltinESMExports();
    fs.rmSync(f.root, { recursive: true, force: true });
  }
});
