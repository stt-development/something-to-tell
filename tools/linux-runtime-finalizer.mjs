// Preserve verified one-directory runtime bytes after linuxdeploy's ELF rewriting.
import { cpSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, readlinkSync, realpathSync, rmSync, symlinkSync, unlinkSync } from "node:fs";
import { dirname, isAbsolute, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { verifyCandidate } from "./desktop-runtime-resources.mjs";

const ROOT = fileURLToPath(new URL("../", import.meta.url));
const contained = (root, path) => path.startsWith(root + sep);

function directory(path) {
  const stat = lstatSync(path);
  if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error("linux_appdir_directory_invalid");
  return path;
}

/** Operates only on a fresh copy; linuxdeploy's rewritten runtime is never trusted. */
export function finalizeLinuxRuntime({ appdir, candidate, manifest, source = ROOT }) {
  const root = realpathSync(source);
  const input = realpathSync(directory(resolve(appdir)));
  const original = verifyCandidate(candidate, manifest, root);
  const builds = resolve(root, "build");
  if (!contained(root, input) || !input.endsWith(".AppDir") || contained(input, builds)) {
    throw new Error("linux_appdir_path_invalid");
  }
  directory(resolve(input, "usr"));
  const libraries = directory(resolve(input, "usr/lib"));
  const owners = readdirSync(libraries, { withFileTypes: true }).filter(entry => entry.isDirectory());
  const runtimes = owners.map(entry => resolve(libraries, entry.name, "runtime"))
    .filter(path => {
      try { return lstatSync(path).isDirectory() || lstatSync(path).isSymbolicLink(); }
      catch (error) { if (error.code === "ENOENT") return false; throw error; }
    });
  if (runtimes.length !== 1) throw new Error("linux_appdir_runtime_count_invalid");
  directory(runtimes[0]);
  const runtimeRelative = relative(input, runtimes[0]);
  if (!contained(input, realpathSync(runtimes[0]))) throw new Error("linux_appdir_path_invalid");

  mkdirSync(builds, { recursive: true });
  const output = resolve(mkdtempSync(resolve(builds, "linux-package-")), "Verified.AppDir");
  cpSync(input, output, { recursive: true, dereference: false, verbatimSymlinks: true, errorOnExist: true, force: false });
  const runtime = resolve(output, runtimeRelative);
  directory(resolve(output, "usr"));
  directory(resolve(output, "usr/lib"));
  directory(dirname(runtime));
  directory(runtime);
  // This is our newly copied subtree, never the source bundle or a user's project.
  rmSync(runtime, { recursive: true });
  cpSync(original, runtime, { recursive: true, dereference: false, verbatimSymlinks: true, errorOnExist: true, force: false });

  function relocateInternalLinks(path) {
    for (const entry of readdirSync(path, { withFileTypes: true })) {
      const current = resolve(path, entry.name);
      if (entry.isSymbolicLink()) {
        const target = readlinkSync(current);
        const actual = isAbsolute(target) ? realpathSync(target) : null;
        if (actual && contained(input, actual)) {
          const relocated = resolve(output, relative(input, actual));
          unlinkSync(current);
          symlinkSync(relative(dirname(current), relocated), current);
        }
      } else if (entry.isDirectory()) relocateInternalLinks(current);
    }
  }
  relocateInternalLinks(output);
  // Reject source mutation/copy races; never legitimize them by updating hashes.
  verifyCandidate(original, manifest, root);
  verifyCandidate(runtime, manifest, root);
  return { appdir: output, runtime, runtime_relative_path: runtimeRelative };
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  if (process.argv.length !== 5) throw new Error("Usage: linux-runtime-finalizer.mjs APPDIR RUNTIME MANIFEST");
  console.log(JSON.stringify(finalizeLinuxRuntime({ appdir: process.argv[2], candidate: process.argv[3],
    manifest: JSON.parse(readFileSync(process.argv[4], "utf8")) })));
}
