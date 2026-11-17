import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import postcss from "postcss";

test("Hand hit surface belongs only to the original pane without geometry or paint changes", () => {
  const root = postcss.parse(readFileSync(new URL("../src/styles/base.css", import.meta.url), "utf8"));
  const rules = [];
  root.walkRules((rule) => { if (rule.selector.includes(".react-flow__pane::after")) rules.push(rule); });
  assert.equal(rules.length, 1);
  assert.equal(rules[0].selector, ".pan-canvas .react-flow__pane::after");
  const declarations = Object.fromEntries(rules[0].nodes.map((node) => [node.prop, node.value]));
  assert.deepEqual(declarations, { content: '\"\"', position: "absolute", inset: "0", "z-index": "3", "pointer-events": "auto", cursor: "inherit" });
});

test("does not retain an unverified Hand viewport compositing promotion", () => {
  const root = postcss.parse(readFileSync(new URL("../src/styles/base.css", import.meta.url), "utf8"));
  const rules = [];
  root.walkDecls("will-change", (declaration) => {
    if (declaration.parent.selector === ".pan-canvas .react-flow__viewport") rules.push(declaration);
  });
  assert.equal(rules.length, 0);
});

test("rejected pointer-rule trial restores the existing secondary Hand barrier", () => {
  const root = postcss.parse(readFileSync(new URL("../src/styles/base.css", import.meta.url), "utf8"));
  const graphOverrides = [];
  root.walkDecls("pointer-events", declaration => {
    const selector = declaration.parent.selector ?? "";
    if (selector.includes(".pan-canvas") && /react-flow__(node|edge|edgelabel-renderer)/.test(selector)) {
      graphOverrides.push(selector);
    }
  });
  assert.equal(graphOverrides.length, 1);
  for (const selector of [".pan-canvas .react-flow__node *", ".pan-canvas .react-flow__edge *",
    ".pan-canvas .react-flow__edgelabel-renderer *"]) assert.ok(graphOverrides[0].includes(selector));
});
