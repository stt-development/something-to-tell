import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { execFileSync } from "node:child_process";
import { dirname, resolve } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { readPhaseExecution, validatePhaseExecution } from "./phase-loop.mjs";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const current = JSON.parse(readFileSync(resolve(ROOT, "docs/tasks/phase-execution.json"), "utf8"));
// Lifecycle tests must keep passing when the real phase later closes or changes.
const sample = { schema_version: 1, mode: "phase-loop", phase: "P3", ledger: "docs/tasks/phase-3-example.md",
  status: "ready", next_task: "P3-002", last_completed_task: "P3-001", last_verified_commit: "abcdef0",
  phase_approval: "required", commit_policy: "when-authorized", authorization: "Fixture authorization only.",
  stop_reason: null, resume_note: "Fixture resume note." };

/** Owned temporary files only; never modifies the real phase checkpoint or application projects. */
function withLedger(ledger, run) {
  const root = mkdtempSync(resolve(tmpdir(), "stt-phase-loop-"));
  try {
    mkdirSync(resolve(root, "docs/tasks"), { recursive: true });
    writeFileSync(resolve(root, "docs/tasks/phase-execution.json"), JSON.stringify(sample));
    writeFileSync(resolve(root, sample.ledger), ledger);
    run(root);
  } finally { rmSync(root, { recursive: true, force: true }); }
}

test("committed checkpoint has an authorized phase and resolvable task hints", () => {
  assert.deepEqual(readPhaseExecution(ROOT), current); assert.ok(Object.isFrozen(readPhaseExecution(ROOT)));
});

test("ready/running resumes stay in the approved phase without automatic phase rollover", () => {
  for (const status of ["ready", "running"]) assert.equal(validatePhaseExecution({ ...sample, status }).status, status);
  for (const field of ["next_task", "last_completed_task"]) {
    assert.throws(() => validatePhaseExecution({ ...sample, [field]: "P10-001" }), /authorized phase/);
  }
  assert.throws(() => validatePhaseExecution({ ...sample, phase: "P10" }), /ledger/);
  assert.throws(() => validatePhaseExecution({ ...sample, ledger: "../outside.md" }), /ledger/);
  assert.throws(() => validatePhaseExecution({ ...sample, phase_approval: "automatic" }));
});

test("phase handoff cannot carry a next-task cursor or omit its stop reason", () => {
  const handoff = { ...sample, status: "awaiting-phase-approval", next_task: null, stop_reason: "Phase exit evidence verified; author approval required." };
  assert.equal(validatePhaseExecution(handoff).status, "awaiting-phase-approval");
  assert.throws(() => validatePhaseExecution({ ...handoff, next_task: sample.next_task }), /phase boundary/);
  assert.throws(() => validatePhaseExecution({ ...handoff, stop_reason: null }), /reason/);
});

test("blocked/paused states require an explanation and cannot impersonate normal running", () => {
  for (const status of ["blocked", "paused"]) {
    assert.equal(validatePhaseExecution({ ...sample, status, stop_reason: "Author decision needed." }).status, status);
    assert.throws(() => validatePhaseExecution({ ...sample, status }), /reason/);
  }
  assert.throws(() => validatePhaseExecution({ ...sample, next_task: null }), /cursor/);
  assert.throws(() => validatePhaseExecution({ ...sample, stop_reason: "silently stopped" }));
});

test("unsupported versions, fields and authorization-free checkpoints are rejected", () => {
  for (const change of [{ schema_version: 2 }, { mode: "daemon" }, { status: "complete" }, { authorization: "" },
    { commit_policy: "all-operations-approved" }, { last_verified_commit: "not-a-commit" }, { secret: "must-not-store" }]) {
    assert.throws(() => validatePhaseExecution({ ...sample, ...change }));
  }
});

test("persistent agent entry point and normal architecture verification include the loop contract", () => {
  const agents = readFileSync(resolve(ROOT, "AGENTS.md"), "utf8"), orchestrator = readFileSync(resolve(ROOT, "docs/orchestrator.md"), "utf8");
  for (const path of ["docs/orchestrator.md", "docs/architecture/phase-scoped-agent-loop.md", "docs/tasks/phase-execution.json"]) assert.ok(agents.includes(path));
  assert.ok(orchestrator.includes("phase-scoped-agent-loop.md"));
  const pkg = JSON.parse(readFileSync(resolve(ROOT, "package.json"), "utf8"));
  assert.ok(pkg.scripts["verify:architecture"].includes("phase-loop:test"));
});

test("resume hints must resolve to actual task headings rather than prose mentions", () => {
  const previous = `## ${sample.last_completed_task}: Prior task\n`;
  withLedger(`${previous}**${sample.next_task}: Next task**\n`, (root) => assert.equal(readPhaseExecution(root).next_task, sample.next_task));
  withLedger(`${previous}See ${sample.next_task}: mentioned only in prose\n`, (root) => assert.throws(() => readPhaseExecution(root), /next_task does not name/));
  withLedger(`### ${sample.next_task}: Next task\n`, (root) => assert.throws(() => readPhaseExecution(root), /last_completed_task does not name/));
});

test("status CLI is read-only and refuses an approval/advance argument", () => {
  const path = resolve(ROOT, "docs/tasks/phase-execution.json"), before = readFileSync(path, "utf8"), command = resolve(ROOT, "tools/phase-loop.mjs");
  const value = JSON.parse(execFileSync(process.execPath, [command], { encoding: "utf8" }));
  assert.deepEqual(value, current);
  assert.throws(() => execFileSync(process.execPath, [command, "--approve-next-phase"], { stdio: "pipe" }));
  assert.equal(readFileSync(path, "utf8"), before);
});
