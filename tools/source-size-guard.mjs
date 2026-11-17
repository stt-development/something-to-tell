#!/usr/bin/env node

/**
 * Repository-wide source line guard owned by ADR 0020.
 *
 * The pure evaluation functions are exported so thresholds, exclusions, waiver
 * resistance, and diagnostics can be tested without spawning Git.
 */

import { execFileSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { extname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

export const WARNING_LIMIT = 1_000;
export const HARD_LIMIT = 2_000;

const SOURCE_EXTENSIONS = new Set([
  ".c", ".cc", ".cpp", ".cs", ".css", ".go", ".h", ".hpp", ".java",
  ".js", ".jsx", ".kt", ".kts", ".less", ".mjs", ".cjs", ".py",
  ".rb", ".rs", ".sass", ".scss", ".sh", ".swift", ".ts", ".tsx"
]);
const STATIC_DATA_EXTENSIONS = new Set([
  ".csv", ".golden", ".json", ".lock", ".snap", ".tsv", ".yaml", ".yml"
]);
const OUTPUT_OR_DEPENDENCY_DIRECTORIES = new Set([
  ".git", ".mypy_cache", ".pnpm-store", ".pytest_cache", ".ruff_cache",
  ".venv", ".vite", "build", "cache", "coverage", "dist", "htmlcov",
  "node_modules", "playwright-report", "target", "test-results", "vendor",
  "third_party", "third-party"
]);
const GENERATED_HEADER = /(?:^|\n)\s*(?:\/\/|#|\/\*)?\s*(?:@generated\b|code generated\b|generated file\b|do not edit\b)/i;

function compareText(left, right) {
  return left < right ? -1 : left > right ? 1 : 0;
}

export function normalizeRepositoryPath(path) {
  return path.replaceAll("\\", "/").replace(/^\.\//, "");
}

export function countPhysicalLines(content) {
  if (content.length === 0) return 0;
  const matches = content.match(/\r\n|\r|\n/g)?.length ?? 0;
  return matches + (/\r\n$|\r$|\n$/.test(content) ? 0 : 1);
}

/** Returns the policy exclusion category, or null for an in-scope source file. */
export function exclusionReason(path, content = "") {
  const normalized = normalizeRepositoryPath(path);
  const segments = normalized.split("/");
  const extension = extname(normalized).toLowerCase();

  if (segments[0] === "docs") return "documentation";
  if (segments.some((segment) => OUTPUT_OR_DEPENDENCY_DIRECTORIES.has(segment))) {
    return "output-or-dependency";
  }
  if (/^(?:.*\/)?services\/runtime\/migrations\/versions\//.test(normalized)) {
    return "database-migration";
  }
  if (STATIC_DATA_EXTENSIONS.has(extension)) return "static-data";
  if (
    /(?:^|\/)localization\/(?:catalogs?|messages)\.[^/]+$/i.test(normalized)
    || /(?:^|\/)locales\/(?:catalogs?|messages)\.[^/]+$/i.test(normalized)
  ) {
    return "localization-catalog";
  }
  if (!SOURCE_EXTENSIONS.has(extension)) return "unsupported-extension";
  if (/(?:^|[._-])generated(?:[._-]|$)/i.test(normalized.split("/").at(-1) ?? "")) {
    return "generated-source";
  }
  // Generated ownership must be declared near the top; prose mentions later in
  // a normal source file must not accidentally disable enforcement.
  if (GENERATED_HEADER.test(content.split(/\r\n|\r|\n/, 8).join("\n"))) {
    return "generated-source";
  }
  return null;
}

function diagnostic(level, code, path, lineCount, limit) {
  return { level, code, path, lineCount, limit };
}

/** Evaluate already-tracked file content and return stable path-ordered results. */
export function evaluateSourceSizes(entries) {
  const included = new Map();
  let excludedCount = 0;

  for (const entry of entries) {
    const path = normalizeRepositoryPath(entry.path);
    if (exclusionReason(path, entry.content) !== null) {
      excludedCount += 1;
      continue;
    }
    included.set(path, countPhysicalLines(entry.content));
  }

  const diagnostics = [];
  for (const [path, lineCount] of [...included.entries()].sort(([left], [right]) => compareText(left, right))) {
    if (lineCount > HARD_LIMIT) {
      diagnostics.push(diagnostic("error", "hard_limit", path, lineCount, HARD_LIMIT));
    } else if (lineCount > WARNING_LIMIT) {
      diagnostics.push(diagnostic("warning", "warning_limit", path, lineCount, WARNING_LIMIT));
    }
  }

  diagnostics.sort((left, right) => (
    compareText(left.path, right.path)
    || compareText(left.level, right.level)
    || compareText(left.code, right.code)
  ));
  return {
    diagnostics,
    checkedCount: included.size,
    excludedCount,
    errorCount: diagnostics.filter((item) => item.level === "error").length,
    warningCount: diagnostics.filter((item) => item.level === "warning").length
  };
}

export function formatDiagnostic(item) {
  return `${item.level.toUpperCase()} ${item.path}:${item.lineCount}:${item.limit} ${item.code}`;
}

function repositoryRoot() {
  return execFileSync("git", ["rev-parse", "--show-toplevel"], { encoding: "utf8" }).trim();
}

function repositoryEntries(root) {
  // A clean public snapshot has no tracked files until its first commit.
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
  const result = evaluateSourceSizes(repositoryEntries(root));
  for (const item of result.diagnostics) console.log(formatDiagnostic(item));
  console.log(
    `Source size guard: ${result.checkedCount} checked, ${result.excludedCount} excluded, `
    + `${result.warningCount} warnings, ${result.errorCount} errors.`
  );
  return result.errorCount === 0 ? 0 : 1;
}

const invokedPath = process.argv[1] ? resolve(process.argv[1]) : "";
if (invokedPath === fileURLToPath(import.meta.url)) {
  try {
    process.exitCode = runCli();
  } catch (error) {
    console.error(`ERROR source-size-guard:0:0 ${error instanceof Error ? error.message : "source_size_guard_failed"}`);
    process.exitCode = 1;
  }
}
