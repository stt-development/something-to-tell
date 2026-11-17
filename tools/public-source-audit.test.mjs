import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { auditPublicSource, recordPublicAudit, renderAuditSummary } from "./public-source-audit.mjs";
import { publicReadme } from "./public-source-export.mjs";

function fixture() {
  const root = mkdtempSync(join(tmpdir(), "stt-public-audit-"));
  const source = join(root, "source"), target = join(root, "public");
  for (const directory of [source, target]) {
    mkdirSync(directory); execFileSync("git", ["init", "-b", "main", directory], { stdio: "ignore" });
    writeFileSync(join(directory, ".gitignore"), "node_modules/\n.env\n");
    writeFileSync(join(directory, "main.py"), "print('hello')\n");
  }
  writeFileSync(join(source, "README.md"), "Private introduction");
  writeFileSync(join(target, "README.md"), publicReadme());
  writeFileSync(join(source, "AGENTS.md"), "private");
  mkdirSync(join(source, "docs")); writeFileSync(join(source, "docs/private.md"), "private");
  return { root, source, target };
}

test("records actual copied files and expected README/exclusions without assuming a committed public repo", () => {
  const { root, source, target } = fixture();
  try {
    const report = auditPublicSource({ source, target });
    assert.equal(report.summary.identical, 2); assert.equal(report.summary["readme-replacement"], 1);
    assert.equal(report.summary.excluded, 2); assert.equal(report.summary["unexpected-difference"], 0);
    assert.equal(report.public_commit, null); assert.equal(report.public_has_history, false);
    assert.equal(report.files.find(file => file.path === "main.py").source.sha256, report.files.find(file => file.path === "main.py").public.sha256);
    assert.deepEqual(report.excluded.map(file => file.reason).sort(), ["agent-instructions", "documentation-outside-guides"]);
    assert.match(renderAuditSummary(report), /README.md.*readme-replacement/);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("detects pending transfers, public edits and extra files without modifying them", () => {
  const { root, source, target } = fixture();
  try {
    writeFileSync(join(source, "new.py"), "new source");
    writeFileSync(join(target, "main.py"), "public change");
    writeFileSync(join(target, "unexpected.txt"), "extra");
    writeFileSync(join(target, ".env"), "ignored local secret");
    const report = auditPublicSource({ source, target });
    assert.equal(report.summary["missing-public"], 1); assert.equal(report.summary["unexpected-difference"], 1);
    assert.equal(report.summary.extra_public, 1);
    assert.equal(readFileSync(join(target, "main.py"), "utf8"), "public change");
    assert.equal(existsSync(join(target, "new.py")), false);
    const records = join(root, "private-records");
    recordPublicAudit(report, records, target); recordPublicAudit(report, records, target);
    assert.equal(JSON.parse(readFileSync(join(records, "public-copy-manifest.json"), "utf8")).summary.extra_public, 1);
    const events = readFileSync(join(records, "public-transfer-log.jsonl"), "utf8").trim().split("\n").map(line => JSON.parse(line));
    assert.equal(events.length, 2); assert.equal(events[0].event, "verified-snapshot");
    assert.throws(() => recordPublicAudit(report, target, target), /outside the public/);
    assert.throws(() => recordPublicAudit(report, join(target, "not-created"), target), /outside the public/);
    assert.equal(existsSync(join(target, "not-created")), false);
    assert.equal(existsSync(join(target, "public-copy-manifest.json")), false);
  } finally { rmSync(root, { recursive: true, force: true }); }
});
