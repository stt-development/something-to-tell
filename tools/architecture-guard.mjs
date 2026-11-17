#!/usr/bin/env node

/**
 * Deterministic dependency guard for the production Python and TypeScript trees.
 *
 * The parser intentionally covers repository-owned static imports only. Dynamic
 * runtime loading remains an adapter concern and must not define domain ownership.
 */

import { execFileSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { dirname, extname, normalize, posix, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const PYTHON_ROOT = "services/runtime/stt_runtime";
const WEB_ROOT = "apps/web/src";
const CONTRACTS_ROOT = "packages/contracts/src";
const PRODUCTION_EXTENSIONS = new Set([".py", ".ts", ".tsx"]);
const TEST_FILE = /(?:^|\/)(?:tests?\/|[^/]+\.test\.(?:ts|tsx)$)/;

const FORBIDDEN_PYTHON_TARGETS = new Map([
  ["domain", new Set(["analysis", "api", "canon", "composition", "db", "dialogue", "impact", "membership", "narrative_state", "playback", "project_document", "project_format", "project_history", "project_session", "quest", "repositories", "schemas", "story_flow", "style_system"])],
  ["core", new Set(["api", "db", "repositories"])],
  ["schemas", new Set(["api", "db", "repositories"])],
  ["repositories/interfaces.py", new Set(["api", "db", "repositories/sqlite.py"])]
]);

function compareText(left, right) {
  return left < right ? -1 : left > right ? 1 : 0;
}

function repositoryPath(path) {
  return path.replaceAll("\\", "/").replace(/^\.\//, "");
}

/** Return production files participating in architecture ownership. */
export function isArchitectureSource(path) {
  const normalized = repositoryPath(path);
  if (TEST_FILE.test(normalized)) return false;
  if (!PRODUCTION_EXTENSIONS.has(extname(normalized))) return false;
  return normalized.startsWith(`${PYTHON_ROOT}/`)
    || normalized.startsWith(`${WEB_ROOT}/`)
    || normalized.startsWith(`${CONTRACTS_ROOT}/`);
}

/** Extract static ES module specifiers without depending on the TS compiler. */
export function parseTypeScriptImports(content) {
  const imports = new Set();
  const patterns = [
    /\b(?:import|export)\s+(?:type\s+)?(?:[^"']*?\s+from\s+)?["']([^"']+)["']/g,
    /\bimport\s*\(\s*["']([^"']+)["']\s*\)/g
  ];
  for (const pattern of patterns) {
    for (const match of content.matchAll(pattern)) imports.add(match[1]);
  }
  return [...imports].sort(compareText);
}

/** Extract Python modules from ordinary import and from-import statements. */
export function parsePythonImports(content) {
  const imports = new Set();
  for (const rawLine of content.split(/\r?\n/)) {
    const line = rawLine.trim();
    const fromMatch = /^from\s+([.\w]+)\s+import\s+/.exec(line);
    if (fromMatch) imports.add(fromMatch[1]);
    const importMatch = /^import\s+(.+)$/.exec(line);
    if (!importMatch) continue;
    for (const item of importMatch[1].split(",")) {
      const moduleName = item.trim().split(/\s+as\s+/)[0];
      if (/^[.\w]+$/.test(moduleName)) imports.add(moduleName);
    }
  }
  return [...imports].sort(compareText);
}

function parsePythonDependencyModules(content) {
  const modules = new Set(parsePythonImports(content));
  const fromPattern = /^\s*from\s+([.\w]+)\s+import\s+(\([^)]*\)|[^\n]+)/gm;
  for (const match of content.matchAll(fromPattern)) {
    const base = match[1];
    const imported = match[2].replace(/[()]/g, " ");
    for (const item of imported.split(",")) {
      const name = item.trim().split(/\s+as\s+/)[0];
      if (!/^\w+$/.test(name)) continue;
      modules.add(base.endsWith(".") ? `${base}${name}` : `${base}.${name}`);
    }
  }
  return [...modules].sort(compareText);
}

function resolveCandidate(base, candidates, knownPaths) {
  for (const candidate of candidates) {
    const path = repositoryPath(posix.normalize(posix.join(base, candidate)));
    if (knownPaths.has(path)) return path;
  }
  return null;
}

/** Resolve one internal TypeScript import to its tracked production file. */
export function resolveTypeScriptImport(sourcePath, specifier, knownPaths) {
  let base;
  let target;
  if (specifier.startsWith("@something-to-tell/contracts/")) {
    base = CONTRACTS_ROOT;
    target = specifier
      .slice("@something-to-tell/contracts/".length)
      .replace(/-([a-z])/g, (_match, letter) => letter.toUpperCase());
  } else if (specifier.startsWith(".")) {
    base = dirname(repositoryPath(sourcePath)).replaceAll("\\", "/");
    target = specifier;
  } else {
    return null;
  }
  return resolveCandidate(base, [
    target,
    `${target}.ts`,
    `${target}.tsx`,
    `${target}/index.ts`,
    `${target}/index.tsx`
  ], knownPaths);
}

/** Resolve a runtime-local Python module, including relative imports. */
export function resolvePythonImport(sourcePath, moduleName, knownPaths) {
  let parts;
  if (moduleName.startsWith(".")) {
    const dots = /^\.+/.exec(moduleName)?.[0].length ?? 0;
    const sourceModule = repositoryPath(sourcePath)
      .slice(0, -3)
      .split("/");
    sourceModule.pop();
    parts = sourceModule.slice(0, Math.max(0, sourceModule.length - dots + 1));
    const remainder = moduleName.slice(dots);
    if (remainder) parts.push(...remainder.split("."));
  } else {
    const prefix = "services.runtime.stt_runtime.";
    if (moduleName === "services.runtime.stt_runtime") {
      parts = PYTHON_ROOT.split("/");
    } else if (moduleName.startsWith(prefix)) {
      parts = [...PYTHON_ROOT.split("/"), ...moduleName.slice(prefix.length).split(".")];
    } else {
      return null;
    }
  }
  const target = parts.join("/");
  return resolveCandidate("", [`${target}.py`, `${target}/__init__.py`], knownPaths);
}

function pythonOwner(path) {
  return repositoryPath(path).slice(`${PYTHON_ROOT}/`.length).split("/")[0];
}

function pythonTargetKey(path) {
  return repositoryPath(path).slice(`${PYTHON_ROOT}/`.length).replace(/\/__init__\.py$/, "");
}

function forbiddenReason(source, target) {
  if (source.startsWith(`${PYTHON_ROOT}/`)) {
    const sourceRelative = source.slice(`${PYTHON_ROOT}/`.length);
    const ownerRule = FORBIDDEN_PYTHON_TARGETS.get(pythonOwner(source));
    const fileRule = FORBIDDEN_PYTHON_TARGETS.get(sourceRelative);
    const targetOwner = pythonOwner(target);
    const targetKey = pythonTargetKey(target);
    if (ownerRule?.has(targetOwner) || fileRule?.has(targetOwner) || fileRule?.has(targetKey)) {
      return "forbidden_python_import";
    }
    if (source !== `${PYTHON_ROOT}/app.py`
      && !sourceRelative.startsWith("api/") && targetKey.startsWith("api/")) {
      return "runtime_policy_imports_api";
    }
  }
  if (source.startsWith(`${CONTRACTS_ROOT}/`) && target.startsWith(`${WEB_ROOT}/`)) {
    return "contracts_import_web";
  }
  if (source !== `${WEB_ROOT}/App.tsx`
    && source.startsWith(`${WEB_ROOT}/`) && !source.startsWith(`${WEB_ROOT}/app/`)
    && target.startsWith(`${WEB_ROOT}/app/`)) {
    return "web_policy_imports_app";
  }
  if (source.startsWith(`${WEB_ROOT}/runtime/`) && (
    target.startsWith(`${WEB_ROOT}/components/`)
    || target.startsWith(`${WEB_ROOT}/startup/`)
    || target.startsWith(`${WEB_ROOT}/state/`)
  )) {
    return "runtime_client_imports_ui_or_state";
  }
  return null;
}

/** Build a stable internal dependency graph and collect forbidden directions. */
export function buildArchitectureGraph(entries) {
  const sources = entries
    .map((entry) => ({ path: repositoryPath(entry.path), content: entry.content }))
    .filter((entry) => isArchitectureSource(entry.path))
    .sort((left, right) => compareText(left.path, right.path));
  const knownPaths = new Set(sources.map((entry) => entry.path));
  const graph = new Map(sources.map((entry) => [entry.path, new Set()]));
  const violations = [];

  for (const source of sources) {
    const python = source.path.endsWith(".py");
    const specifiers = python
      ? parsePythonDependencyModules(source.content)
      : parseTypeScriptImports(source.content);
    for (const specifier of specifiers) {
      const target = python
        ? resolvePythonImport(source.path, specifier, knownPaths)
        : resolveTypeScriptImport(source.path, specifier, knownPaths);
      if (!target || target === source.path) continue;
      graph.get(source.path).add(target);
      const code = forbiddenReason(source.path, target);
      if (code) violations.push({ code, source: source.path, target });
    }
  }
  violations.sort((left, right) => (
    compareText(left.source, right.source)
    || compareText(left.target, right.target)
    || compareText(left.code, right.code)
  ));
  return { graph, violations };
}

/** Find canonical cycles so the same cycle is reported once in stable order. */
export function findDependencyCycles(graph) {
  const cycles = new Map();
  const visited = new Set();
  const active = [];
  const activeIndexes = new Map();

  function visit(node) {
    if (activeIndexes.has(node)) {
      const cycle = active.slice(activeIndexes.get(node));
      const rotations = cycle.map((_, index) => [...cycle.slice(index), ...cycle.slice(0, index)]);
      rotations.sort((left, right) => compareText(left.join("\0"), right.join("\0")));
      const canonical = rotations[0];
      cycles.set(canonical.join(" -> "), [...canonical, canonical[0]]);
      return;
    }
    if (visited.has(node)) return;
    activeIndexes.set(node, active.length);
    active.push(node);
    for (const target of [...(graph.get(node) ?? [])].sort(compareText)) visit(target);
    active.pop();
    activeIndexes.delete(node);
    visited.add(node);
  }

  for (const node of [...graph.keys()].sort(compareText)) visit(node);
  return [...cycles.values()].sort((left, right) => compareText(left.join("\0"), right.join("\0")));
}

/** Evaluate already-loaded sources for unit tests and the CLI adapter. */
export function evaluateArchitecture(entries) {
  const { graph, violations } = buildArchitectureGraph(entries);
  const cycles = findDependencyCycles(graph);
  return {
    checkedCount: graph.size,
    diagnostics: [
      ...violations.map((item) => ({ ...item, detail: `${item.source} -> ${item.target}` })),
      ...cycles.map((cycle) => ({
        code: "dependency_cycle",
        source: cycle[0],
        target: cycle.at(-2),
        detail: cycle.join(" -> ")
      }))
    ].sort((left, right) => (
      compareText(left.source, right.source)
      || compareText(left.code, right.code)
      || compareText(left.detail, right.detail)
    ))
  };
}

function repositoryRoot() {
  return execFileSync("git", ["rev-parse", "--show-toplevel"], { encoding: "utf8" }).trim();
}

function repositoryEntries(root) {
  // Include new source before the first commit, while respecting ignored output.
  const output = execFileSync("git", ["ls-files", "--cached", "--others", "--exclude-standard", "-z"], {
    cwd: root,
    encoding: "utf8",
    maxBuffer: 16 * 1024 * 1024
  });
  return [...new Set(output.split("\0").filter(Boolean))].flatMap((path) => {
    const absolute = resolve(root, path);
    return existsSync(absolute) ? [{ path, content: readFileSync(absolute, "utf8") }] : [];
  });
}

export function runCli(root = repositoryRoot()) {
  const result = evaluateArchitecture(repositoryEntries(root));
  for (const item of result.diagnostics) {
    console.error(`ERROR ${item.source}:0:0 ${item.code} ${item.detail}`);
  }
  console.log(`Architecture guard: ${result.checkedCount} production files, ${result.diagnostics.length} errors.`);
  return result.diagnostics.length === 0 ? 0 : 1;
}

const invokedPath = process.argv[1] ? normalize(resolve(process.argv[1])) : "";
if (invokedPath === fileURLToPath(import.meta.url)) {
  try {
    process.exitCode = runCli();
  } catch (error) {
    console.error(`ERROR architecture-guard:0:0 ${error instanceof Error ? error.message : "architecture_guard_failed"}`);
    process.exitCode = 1;
  }
}
