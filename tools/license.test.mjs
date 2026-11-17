// Protect the agreed GPL version choice and the verbatim standard license text.
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import test from "node:test";

const root = new URL("../", import.meta.url);

test("application packages agree on GPL-3.0-or-later without enabling registry publication", () => {
  for (const file of ["package.json", "apps/web/package.json", "apps/desktop/package.json", "packages/contracts/package.json"]) {
    const manifest = JSON.parse(readFileSync(new URL(file, root), "utf8"));
    assert.equal(manifest.license, "GPL-3.0-or-later", file);
    assert.equal(manifest.private, true, file);
  }
});

test("LICENSE preserves the retrieved standard GPL text and README declares the later-version choice", () => {
  const license = readFileSync(new URL("LICENSE", root));
  assert.equal(createHash("sha256").update(license).digest("hex"), "fb981668c18a279e285fc4d83fba1e836cc84dd4daa73c9697d3cfd2d8aca6e0");
  const readme = readFileSync(new URL("README.md", root), "utf8");
  assert.match(readme, /SPDX-License-Identifier: GPL-3\.0-or-later/);
  assert.match(readme, /Third-party components retain their own licenses/);
  assert.match(readme, /does not by itself put your independently authored stories/);
});
