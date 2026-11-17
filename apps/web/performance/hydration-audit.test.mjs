import { test } from "node:test";
import assert from "node:assert/strict";
import { hydrationEnvelope, parentOrderAudit, parseAudit } from "./hydration-audit.mjs";

test("offline envelope does not attach, copy or mutate any authored record", () => {
  const source = { manifest: { project_id: "offline", saved_revision: 3, settings: { storage: { mode: "local_sqlite" } } } };
  const envelope = hydrationEnvelope(source);
  assert.equal(envelope.document, source); assert.equal(envelope.session.project_id, "offline");
  assert.equal(envelope.session.saved_revision, 3); assert.equal(envelope.session.save_status, "clean");
});
test("offline parse retains first/warm labels and counts only the bounded synchronous call", () => {
  let time = 0;
  const rows = parseAudit('{"document":{"nodes":[{}]}}', 2, () => time++);
  assert.deepEqual(rows, [{ cache: "first_parse", milliseconds: 1, nodes: 1 }, { cache: "warm_same_process", milliseconds: 1, nodes: 1 }]);
  assert.throws(() => parseAudit("bad"), SyntaxError);
  for (const count of [0, -1, 1.5, 22]) assert.throws(() => parseAudit("{}", count), /sample_count_invalid/);
  assert.throws(() => parseAudit('{"document":{"nodes":[]}}', 1, () => NaN), /clock_invalid/);
});
test("parent-order audit reconstructs original primary/linked ordering and rejects lost geometry", () => {
  const source = { nodes: [{ id: "child" }, { id: "parent" }], placements: [
    { id: "link", canonical_node_id: "child", is_primary: false },
    { id: "primary", canonical_node_id: "child", is_primary: true }
  ] };
  const snapshot = { nodes: [{ id: "parent" }, { id: "child", parentId: "parent" }, { id: "placement:link", parentId: "parent" }] };
  const order = (nodes) => [...nodes].sort((a, b) => Number(Boolean(a.parentId)) - Number(Boolean(b.parentId)));
  const result = parentOrderAudit(source, snapshot, order);
  assert.equal(result.exact_order, true); assert.equal(result.projected_nodes, 3); assert.ok(result.parent_reads > 0);
  assert.equal(result.id_reads, 0); // Output parity reads are intentionally excluded.
  assert.throws(() => parentOrderAudit(source, { nodes: snapshot.nodes.slice(0, 2) }, order), /projection_mismatch/);
  assert.throws(() => parentOrderAudit(source, snapshot, (nodes) => nodes), /order_mismatch/);
});
