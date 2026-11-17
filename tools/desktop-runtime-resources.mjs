// Stage only a manifest-verified owned candidate; never install, publish or overwrite.
import { createHash } from "node:crypto";
import { chmodSync, constants, copyFileSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, readlinkSync, realpathSync, statSync, writeFileSync } from "node:fs";
import { dirname, isAbsolute, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = fileURLToPath(new URL("../", import.meta.url));
const sha = bytes => createHash("sha256").update(bytes).digest("hex");

function safePath(value) {
  return typeof value === "string" && value.length > 0 && !isAbsolute(value)
    && !value.includes("\\") && !value.includes("\0")
    && value.split("/").every(part => part && part !== "." && part !== "..");
}

/** Compare every file/alias, not just the executable, before creating staging output. */
export function verifyCandidate(candidate, manifest, source = ROOT) {
  const root = realpathSync(candidate);
  if (manifest.schema_version !== 1 || !Array.isArray(manifest.files) || !Array.isArray(manifest.sources)) throw new Error("runtime_manifest_invalid");
  const system = { darwin: "Darwin", linux: "Linux", win32: "Windows" }[process.platform];
  const architecture = value => ({ arm64: "arm64", aarch64: "arm64", x64: "x64", x86_64: "x64", AMD64: "x64" })[value];
  if (manifest.system !== system || !architecture(manifest.machine) || architecture(manifest.machine) !== process.arch) throw new Error("runtime_candidate_platform_mismatch");
  const declared = new Set();
  for (const entry of manifest.files) {
    if (!safePath(entry.path) || declared.has(entry.path)) throw new Error("runtime_manifest_path_invalid");
    declared.add(entry.path);
    const location = resolve(root, entry.path), stat = lstatSync(location);
    const actual = realpathSync(location);
    if (!actual.startsWith(root + sep)) throw new Error("runtime_bundle_path_escape");
    if (entry.symlink !== undefined) {
      if (!stat.isSymbolicLink() || isAbsolute(entry.symlink) || readlinkSync(location) !== entry.symlink) throw new Error("runtime_bundle_alias_changed");
    } else if (!stat.isFile() || stat.isSymbolicLink() || stat.size !== entry.bytes || sha(readFileSync(location)) !== entry.sha256) {
      throw new Error("runtime_bundle_content_changed");
    }
  }
  const actual = [];
  function walk(directory) {
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      const path = resolve(directory, entry.name);
      if (entry.isDirectory()) walk(path);
      else actual.push(relative(root, path).split(sep).join("/"));
    }
  }
  walk(root);
  if (actual.length !== declared.size || actual.some(path => !declared.has(path))) throw new Error("runtime_bundle_extra_files");
  const expectedSources = new Set(["pyproject.toml", "uv.lock", "services/runtime/desktop_entry.py", "services/runtime/alembic.ini", "services/runtime/scripts/build_desktop_runtime.py"]);
  function sourceFiles(directory) {
    for (const entry of readdirSync(resolve(source, directory), { withFileTypes: true })) {
      const path = directory + "/" + entry.name;
      if (entry.isDirectory() && entry.name !== "__pycache__") sourceFiles(path);
      else if (entry.name.endsWith(".py") || (directory.startsWith("services/runtime/migrations") && entry.name.endsWith(".mako"))) expectedSources.add(path);
    }
  }
  sourceFiles("services/runtime/stt_runtime");
  sourceFiles("services/runtime/migrations");
  const sourcePaths = new Set();
  for (const entry of manifest.sources) {
    if (!safePath(entry.path) || sourcePaths.has(entry.path)
        || !expectedSources.has(entry.path)) throw new Error("runtime_source_path_invalid");
    sourcePaths.add(entry.path);
    const location = resolve(source, entry.path);
    if (lstatSync(location).isSymbolicLink() || sha(readFileSync(location)) !== entry.sha256) throw new Error("runtime_candidate_source_stale");
  }
  for (const path of expectedSources) {
    if (!sourcePaths.has(path)) throw new Error("runtime_source_manifest_incomplete");
  }
  if (manifest.lock_sha256 !== sha(readFileSync(resolve(source, "uv.lock")))) throw new Error("runtime_candidate_lock_stale");
  const executable = process.platform === "win32" ? "stt-runtime.exe" : "stt-runtime";
  if (!declared.has(executable) || !lstatSync(resolve(root, executable)).isFile()) throw new Error("runtime_executable_missing");
  if (process.platform !== "win32" && !(lstatSync(resolve(root, executable)).mode & 0o111)) throw new Error("runtime_executable_permissions_invalid");
  return root;
}

export function stageRuntime({ candidate, source = ROOT }) {
  const manifestPath = resolve(dirname(candidate), "manifest.json");
  const manifest = JSON.parse(readFileSync(manifestPath, "utf8"));
  const original = verifyCandidate(candidate, manifest, source);
  const builds = resolve(source, "build");
  mkdirSync(builds, { recursive: true });
  const directory = mkdtempSync(resolve(builds, "desktop-package-"));
  const runtime = resolve(directory, "runtime");
  const files = [];
  const expectedFiles = new Map(manifest.files.filter(entry => entry.symlink === undefined)
    .map(entry => [realpathSync(resolve(original, entry.path)), entry]));
  function materialize(input, output, ancestors = new Set()) {
    const actual = realpathSync(input), stat = statSync(actual);
    if (actual !== original && !actual.startsWith(original + sep)) throw new Error("runtime_bundle_path_escape");
    if (stat.isDirectory()) {
      if (ancestors.has(actual)) throw new Error("runtime_bundle_alias_cycle");
      mkdirSync(output);
      for (const name of readdirSync(actual)) materialize(resolve(actual, name), resolve(output, name), new Set([...ancestors, actual]));
    } else if (stat.isFile()) {
      copyFileSync(actual, output, constants.COPYFILE_EXCL);
      chmodSync(output, stat.mode & 0o777);
      const expected = expectedFiles.get(actual), hash = sha(readFileSync(output));
      if (!expected || expected.bytes !== stat.size || expected.sha256 !== hash) throw new Error("runtime_bundle_changed_during_copy");
      files.push({ path: relative(runtime, output).split(sep).join("/"), bytes: stat.size, sha256: hash });
    } else throw new Error("runtime_bundle_file_invalid");
  }
  // Tauri may flatten file aliases and omit directory aliases. Normalize once,
  // before signing/bundling, and hash every expanded file instead of waiving drift.
  materialize(original, runtime);
  files.sort((left, right) => left.path < right.path ? -1 : left.path > right.path ? 1 : 0);
  const sourceHash = sha(readFileSync(manifestPath));
  const normalized = { ...manifest, files, normalization: { strategy: "materialize-internal-aliases-v1", source_manifest_sha256: sourceHash } };
  verifyCandidate(runtime, normalized, source);
  const configuration = resolve(directory, "tauri.runtime.conf.json");
  const config = { bundle: { resources: { [runtime.split(sep).join("/") + "/"]: "runtime/" } } };
  writeFileSync(configuration, JSON.stringify(config, null, 2) + "\n", { flag: "wx" });
  const normalizedPath = resolve(directory, "runtime-manifest.json");
  const normalizedJson = JSON.stringify(normalized, null, 2) + "\n";
  writeFileSync(normalizedPath, normalizedJson, { flag: "wx" });
  return { configuration, runtime, manifest: normalizedPath,
    manifest_sha256: sha(normalizedJson), source_manifest_sha256: sourceHash };
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  if (process.argv.length !== 3 || !existsSync(process.argv[2])) throw new Error("Usage: node tools/desktop-runtime-resources.mjs CANDIDATE_DIRECTORY");
  console.log(JSON.stringify(stageRuntime({ candidate: resolve(process.argv[2]) })));
}
