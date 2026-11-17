import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const STATUSES = new Set(["ready", "running", "blocked", "paused", "awaiting-phase-approval"]);
const FIELDS = ["schema_version", "mode", "phase", "ledger", "status", "next_task", "last_completed_task",
  "last_verified_commit", "phase_approval", "commit_policy", "authorization", "stop_reason", "resume_note"];

/** Structure/phase consistency only: consent and acceptance remain human/agent review obligations. */
export function validatePhaseExecution(value) {
  assert.ok(value && typeof value === "object" && !Array.isArray(value), "checkpoint must be an object");
  assert.deepEqual(Object.keys(value).sort(), [...FIELDS].sort(), "unsupported checkpoint fields");
  assert.equal(value.schema_version, 1); assert.equal(value.mode, "phase-loop");
  assert.match(value.phase, /^P\d+(?:\.\d+)*$/);
  const phaseSlug = value.phase.slice(1).replaceAll(".", "-");
  assert.match(value.ledger, new RegExp(`^docs/tasks/phase-${phaseSlug}-[a-z0-9-]+\\.md$`), "ledger must belong to the authorized phase");
  assert.ok(STATUSES.has(value.status), "unsupported execution status");
  assert.equal(value.phase_approval, "required"); assert.equal(value.commit_policy, "when-authorized");
  for (const field of ["authorization", "resume_note"]) assert.ok(typeof value[field] === "string" && value[field].trim(), `${field} is required`);
  for (const field of ["next_task", "last_completed_task"]) {
    assert.ok(value[field] === null || (typeof value[field] === "string" && value[field].startsWith(`${value.phase}-`)), `${field} must remain inside the authorized phase`);
  }
  assert.ok(value.last_verified_commit === null || (typeof value.last_verified_commit === "string" && /^[a-f0-9]{7,40}$/.test(value.last_verified_commit)), "invalid verified commit hint");
  if (value.status === "ready" || value.status === "running") {
    assert.ok(value.next_task, "active phase requires a task cursor"); assert.equal(value.stop_reason, null);
  } else {
    assert.ok(typeof value.stop_reason === "string" && value.stop_reason.trim(), "stopped execution requires a reason");
  }
  if (value.status === "awaiting-phase-approval") assert.equal(value.next_task, null, "phase boundary cannot queue next-phase work");
  return Object.freeze({ ...value });
}

/** Recognize only the repository's authored task-heading forms, not dependencies or task status. */
function hasTask(ledger, id) {
  return ledger.split(/\r?\n/).some((line) => /^(?:#{1,6}\s+|\*\*)/.test(line)
    && line.replace(/^#{1,6}\s+/, "").replace(/^\*\*/, "").startsWith(`${id}:`));
}

export function readPhaseExecution(root = ROOT) {
  const value = validatePhaseExecution(JSON.parse(readFileSync(resolve(root, "docs/tasks/phase-execution.json"), "utf8")));
  const ledger = readFileSync(resolve(root, value.ledger), "utf8");
  for (const field of ["next_task", "last_completed_task"]) {
    if (value[field] !== null) assert.ok(hasTask(ledger, value[field]), `${field} does not name a task in its ledger`);
  }
  return value;
}

// Read-only bootstrap command: deliberately has no advance/approve/write/LLM mode.
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    assert.equal(process.argv.length, 2, "phase:status accepts no write or approval arguments");
    process.stdout.write(`${JSON.stringify(readPhaseExecution(), null, 2)}\n`);
  } catch (error) {
    process.stderr.write(`Phase checkpoint invalid: ${error.message}\n`); process.exitCode = 1;
  }
}
