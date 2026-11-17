// Phase9.2 reference inventory protects the author's unchanged examples.
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFileSync, readdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import test from "node:test";

const root = new URL("../", import.meta.url);
const inventory = JSON.parse(readFileSync(new URL("docs/verification/user-guide-sources.json", root), "utf8"));

test("every original example remains in place with identical contents", () => {
  const names = readdirSync(new URL("docs/examples/", root)).filter(name => name.endsWith(".md")).sort();
  assert.deepEqual(names, inventory.sources.map(source => source.file).sort());
  for (const source of inventory.sources) {
    const path = new URL(`docs/examples/${source.file}`, root);
    assert.equal(createHash("sha256").update(readFileSync(path)).digest("hex"), source.sha256, fileURLToPath(path));
    assert.ok(["user-reference", "technical-reference", "index"].includes(source.audience));
    for (const id of source.guide_ids) assert.ok(inventory.articles.some(article => article.id === id));
  }
});

test("guide plan has paired localized metadata and covers every category", () => {
  assert.equal(new Set(inventory.articles.map(article => article.id)).size, inventory.articles.length);
  for (const article of inventory.articles) {
    assert.ok(inventory.categories.some(category => category.id === article.category));
    for (const locale of ["en", "ru"]) {
      assert.ok(article.title[locale]);
      assert.ok(article.summary[locale]);
    }
  }
  for (const category of inventory.categories) assert.ok(inventory.articles.some(article => article.category === category.id));
});
