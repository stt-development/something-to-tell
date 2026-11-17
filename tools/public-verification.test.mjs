// Explicit public entry points must retain product gates, not silently bypass absent files.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { publicReadme } from "./public-source-export.mjs";

const root = new URL("../", import.meta.url);
const { scripts } = JSON.parse(readFileSync(new URL("package.json", root), "utf8"));

test("public aggregate preserves functional gates and selects private archives explicitly", () => {
  assert.equal(scripts["verify:public"], "pnpm verify:source-size && pnpm verify:architecture:public && pnpm desktop:config:test && pnpm verify:backend:public && pnpm verify:frontend:public");
  assert.equal(scripts["verify:architecture:public"], "pnpm architecture:test && pnpm architecture:check && pnpm public-source:test");
  assert.equal(scripts["runtime:test:public"], "uv run pytest services/runtime/tests -m 'not internal_documentation'");
  assert.equal(scripts["runtime:test"], "uv run pytest services/runtime/tests");
  assert.equal(scripts["verify:backend:public"], "pnpm runtime:test:public && pnpm runtime:compile");
  assert.equal(scripts["verify:frontend:public"], "pnpm guides:check:public && pnpm web:typecheck && pnpm web:test && pnpm web:build");
  assert.equal(scripts["guides:check:public"], "node --test tools/user-guide-content.test.mjs");
  assert.match(scripts["verify:architecture"], /pnpm application-map:test && pnpm phase-loop:test/);
  assert.match(scripts["guides:check"], /tools\/user-guide-sources.test.mjs/);
});

test("public CI and README use the explicit aggregate without claiming integration acceptance", () => {
  const workflow = readFileSync(new URL(".github/workflows/functional-tests.yml", root), "utf8");
  assert.match(workflow, /run: pnpm verify:public/);
  assert.match(workflow, /pnpm web:test:e2e/);
  assert.match(workflow, /cargo test --locked/);
  assert.match(workflow, /STT_TEST_POSTGRES_URL:/);
  assert.match(publicReadme(), /pnpm verify:public/);
  assert.match(publicReadme(), /must not be interpreted as passing integration coverage/);
});
