/** Export review must translate every shipped label/error without raw templates. */
// @ts-expect-error Vitest supplies Node at runtime; production web types intentionally omit it.
import { readFileSync } from "node:fs";
import { afterEach, describe, expect, it } from "vitest";
import { enCatalog, ruCatalog } from "./catalogs";
import { applyProjectLocale, localizeRuntimeText, tr } from "./i18n";

const keys = Object.keys(enCatalog).filter((key) => key.startsWith("export."));
// Keep this test-only source read outside Vite's static asset URL rewriting.
const readRuntimeSource = (relativePath: string) => String(readFileSync(new URL(relativePath, import.meta.url), "utf8"));

describe("export localization completeness", () => {
  afterEach(async () => { await applyProjectLocale("en"); });

  it.each(["en", "ru"] as const)("renders every export label and diagnostic in %s", async (locale) => {
    await applyProjectLocale(locale);
    for (const key of keys) {
      const source = enCatalog[key as keyof typeof enCatalog];
      const parameters = Object.fromEntries([...source.matchAll(/{{(\w+)}}/g)].map((match) => [match[1], "3"]));
      const localized = localizeRuntimeText(key, parameters);
      expect(localized, key).not.toBe(key);
      expect(localized, key).not.toMatch(/{{|}}/);
      expect(localized, key).not.toBe(tr("errors.runtimeRequestFailed"));
      expect(ruCatalog[key as keyof typeof ruCatalog], key).toBeTruthy();
    }
  });

  it("covers literal runtime diagnostic keys and all contract filesystem errors", () => {
    const directory = "../../../../services/runtime/stt_runtime/";
    for (const file of ["coordinator", "errors", "executable_projection", "ink", "ink_compiler", "ink_state", "projection", "serialization", "writer", "yarn_spinner"]) {
      const source = readRuntimeSource(`${directory}export/${file}.py`);
      for (const match of source.matchAll(/["'](export\.(?:diagnostic|error)\.[a-z0-9_.-]+)["']/g)) {
        expect(keys, `${file}: ${match[1]}`).toContain(match[1]);
      }
    }
    const contract = readRuntimeSource(`${directory}schemas/export.py`);
    const errors = contract.slice(contract.indexOf("ExportErrorCode = Literal["), contract.indexOf("_CHECKSUM_PATTERN"));
    for (const match of errors.matchAll(/"(export_[a-z_]+)"/g)) expect(keys).toContain(`export.error.${match[1]}`);
  });
});
