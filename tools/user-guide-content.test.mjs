// Content checks cover authored guide pairs; Markdown semantics are tested by the reader.
import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import test from "node:test";

const directory = new URL("../docs/guides/", import.meta.url);
const names = readdirSync(directory).filter(name => /\.(en|ru)\.md$/.test(name));

test("packaged catalog has unique, paired articles and covers each localized category", () => {
  const catalog = JSON.parse(readFileSync(new URL("catalog.json", directory), "utf8"));
  assert.equal(new Set(catalog.categories.map(category => category.id)).size, catalog.categories.length);
  assert.equal(new Set(catalog.articles.map(article => article.id)).size, catalog.articles.length);
  assert.deepEqual(names.sort(), catalog.articles.flatMap(article => [`${article.id}.en.md`, `${article.id}.ru.md`]).sort());
  for (const category of catalog.categories) {
    assert.ok(catalog.articles.some(article => article.category === category.id), category.id);
    for (const locale of ["en", "ru"]) assert.ok(category.title[locale].trim());
  }
  for (const article of catalog.articles) {
    assert.ok(catalog.categories.some(category => category.id === article.category), article.id);
    for (const locale of ["en", "ru"]) {
      assert.ok(article.title[locale].trim(), article.id);
      assert.ok(article.summary[locale].trim(), article.id);
    }
  }
});

test("every delivered user topic has both languages and substantial practical instructions", () => {
  assert.ok(names.length > 0);
  for (const name of names) {
    assert.ok(names.includes(name.replace(/\.(en|ru)\.md$/, name.endsWith(".en.md") ? ".ru.md" : ".en.md")), name);
    const text = readFileSync(new URL(name, directory), "utf8");
    assert.ok(text.startsWith("# "), name);
    assert.ok(text.split("\n").length >= 20, name);
    assert.doesNotMatch(text, /TODO|\/api\/|pg_dump|SQLAlchemy|ProjectDocument|P9\.2-/, name);
  }
});
