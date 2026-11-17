import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const MAP_PATH = resolve(ROOT, "docs/architecture/application-map.md");
const MAP = readFileSync(MAP_PATH, "utf8");
const README = readFileSync(resolve(ROOT, "README.md"), "utf8");
const ORCHESTRATOR = readFileSync(resolve(ROOT, "docs/orchestrator.md"), "utf8");

const DIAGRAM_SECTIONS = [
  "Process And Package Topology",
  "Frontend Ownership",
  "Runtime Layers",
  "Project Folder And Storage",
  "Durable Domain Relationships",
  "Analysis And Agent Data Flow",
  "Lifecycle"
];

/** Return one second-level Markdown section without consuming its successor. */
function sectionBody(title) {
  const marker = `## ${title}`;
  const start = MAP.indexOf(marker);
  assert.notEqual(start, -1, `missing application-map section: ${title}`);
  const bodyStart = start + marker.length;
  const next = MAP.indexOf("\n## ", bodyStart);
  return MAP.slice(bodyStart, next === -1 ? MAP.length : next);
}

/** Extract local Markdown targets from authored owner references. */
function localLinks(content) {
  return [...content.matchAll(/\[[^\]]+\]\(([^)]+\.md(?:#[^)]+)?)\)/g)]
    .map((match) => match[1]);
}

test("README publishes one resolvable application map entry point", () => {
  const target = README.match(/\[application map\]\(([^)]+)\)/)?.[1];

  assert.equal(target, "docs/architecture/application-map.md");
  assert.equal(existsSync(resolve(ROOT, target)), true);
});

test("the map contains every required architecture view exactly once", () => {
  for (const title of DIAGRAM_SECTIONS) {
    assert.equal((MAP.match(new RegExp(`^## ${title}$`, "gm")) ?? []).length, 1);
    assert.equal((sectionBody(title).match(/```mermaid/g) ?? []).length, 1);
  }
  assert.equal((MAP.match(/```mermaid/g) ?? []).length, DIAGRAM_SECTIONS.length);
});

test("every diagram section names at least one resolvable owner document", () => {
  for (const title of DIAGRAM_SECTIONS) {
    const body = sectionBody(title);
    assert.match(body, /Owner docs:/, `${title} has no owner-doc references`);
    const links = localLinks(body);
    assert.ok(links.length > 0, `${title} has no local owner-doc links`);
    for (const link of links) {
      const target = link.split("#", 1)[0];
      assert.equal(
        existsSync(resolve(dirname(MAP_PATH), target)),
        true,
        `${title} links to missing owner doc: ${target}`
      );
    }
  }
});

test("all application-map Markdown document links resolve", () => {
  for (const link of localLinks(MAP)) {
    const target = link.split("#", 1)[0];
    assert.equal(existsSync(resolve(dirname(MAP_PATH), target)), true, target);
  }
});

test("Mermaid blocks use supported declarations and balanced subgraphs", () => {
  const blocks = [...MAP.matchAll(/```mermaid\n([\s\S]*?)```/g)].map((match) => match[1]);

  for (const block of blocks) {
    const lines = block.split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
    assert.match(lines[0], /^(?:flowchart (?:LR|TB)|erDiagram|stateDiagram-v2)$/);
    if (!lines[0].startsWith("flowchart")) continue;
    const subgraphs = lines.filter((line) => line.startsWith("subgraph ")).length;
    const ends = lines.filter((line) => line === "end").length;
    assert.equal(ends, subgraphs, `unbalanced subgraph in ${lines[0]}`);
  }
});

test("orchestrator makes application-map review a mandatory task gate", () => {
  assert.match(
    ORCHESTRATOR,
    /Every task must review `docs\/architecture\/application-map\.md`\./
  );
  assert.match(
    ORCHESTRATOR,
    /A task cannot move to\s+`done` with a known stale diagram\./
  );
});
