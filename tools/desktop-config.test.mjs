/** Guard Tauri's config-relative packaged assets separately from dev commands. */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const configDirectory = resolve(root, "apps/desktop/src-tauri");
const config = JSON.parse(readFileSync(resolve(configDirectory, "tauri.conf.json"), "utf8"));

test("public app surfaces use Engine while technical identities stay compatible", () => {
  const name = "Something To Tell Engine";
  assert.equal(config.productName, name);
  assert.equal(config.app.windows[0].title, name);
  assert.equal(config.identifier, "com.somethingtotell.app");
  assert.match(readFileSync(resolve(root, "apps/web/index.html"), "utf8"), /<title>Something To Tell Engine<\/title>/);
  const locales = readFileSync(resolve(root, "apps/web/src/localization/catalogs.ts"), "utf8");
  assert.equal([...locales.matchAll(/"app.name": "Something To Tell Engine"/g)].length, 2);
  assert.doesNotMatch(locales, /"app.name": "Something To Tell"/);
  for (const icon of ["apps/web/public/app-icon.svg", "apps/desktop/src-tauri/icons/icon.svg"]) {
    assert.ok(readFileSync(resolve(root, icon), "utf8").includes(`aria-label="${name} branching dialogue icon"`));
  }
});

test("production CSP restricts scripts/connections and grants only local core capabilities", () => {
  const security = config.app.security;
  assert.match(security.csp, /script-src 'self'/);
  assert.doesNotMatch(security.csp, /unsafe-eval|https?:\/\/\*/);
  assert.match(security.csp, /connect-src 'self' ipc: http:\/\/ipc.localhost http:\/\/127\.0\.0\.1:\*/);
  assert.match(security.csp, /object-src 'none'/);
  assert.deepEqual(security.capabilities.map(item => item.windows), [["main"]]);
  assert.deepEqual(security.capabilities.flatMap(item => item.permissions), ["core:default"]);
});

test("packaged frontend assets resolve from the Tauri configuration directory", () => {
  assert.equal(resolve(configDirectory, config.build.frontendDist), resolve(root, "apps/web/dist"));
});

test("the desktop prebuild produces the same web workspace used by packaging", () => {
  // Tauri executes prebuild from the desktop package, not from src-tauri.
  const command = config.build.beforeBuildCommand;
  assert.equal(command, "pnpm --dir ../web build");
  const web = JSON.parse(readFileSync(resolve(root, "apps/web/package.json"), "utf8"));
  assert.match(web.scripts.build, /vite build/);
});
