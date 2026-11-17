import { describe, expect, it } from "vitest";
import type { NarrativeNodeData } from "../../types";
import { projectTreeEntries } from "./projectTreeEntries";

type Placement = { id: string; parentId?: string; data: NarrativeNodeData };
const node = (id: string, parentId?: string, canonicalNodeId?: string): Placement => ({
  id, parentId, data: { kind: "Lore", title: id, label: id, summary: "Text", tags: [], canonicalNodeId } as NarrativeNodeData
});

// Characterization oracle: the pre-007a recursive algorithm, small inputs only.
function legacy(nodes: Placement[]) {
  const canonical = nodes.filter((n) => n.id === (n.data.canonicalNodeId ?? n.id));
  const visual = new Map(nodes.map((n) => [n.id, n]));
  const ids = new Set(canonical.map((n) => n.data.canonicalNodeId ?? n.id));
  const children = new Map<string, Placement[]>(), roots: Placement[] = [];
  for (const n of canonical) {
    const parent = n.parentId ? visual.get(n.parentId) : undefined;
    const parentId = parent ? parent.data.canonicalNodeId ?? parent.id : undefined;
    if (parentId && ids.has(parentId) && parentId !== (n.data.canonicalNodeId ?? n.id)) {
      children.set(parentId, [...(children.get(parentId) ?? []), n]);
    } else roots.push(n);
  }
  const entries: Array<{ node: Placement; depth: number }> = [], visited = new Set<string>();
  const append = (n: Placement, depth: number) => {
    const id = n.data.canonicalNodeId ?? n.id;
    if (visited.has(id)) return;
    visited.add(id); entries.push({ node: n, depth });
    for (const child of children.get(id) ?? []) append(child, depth + 1);
  };
  for (const n of roots) append(n, 0);
  for (const n of canonical) append(n, 0);
  return entries;
}

describe("project tree query", () => {
  it("keeps linked parents, missing parents, duplicates and cyclic fallback exactly compatible", () => {
    const input = [node("child", "linked"), node("root"), node("linked", undefined, "root"),
      node("orphan", "missing"), node("a", "b"), node("b", "a"), node("self", "self"), node("root")];
    expect(projectTreeEntries(input)).toEqual(legacy(input));
    expect(projectTreeEntries([])).toEqual([]);
    expect(projectTreeEntries([node("linked", undefined, "absent")])).toEqual([]);
  });

  it("matches the legacy order/depth on seeded shuffled placement forests and cycles without mutation", () => {
    let seed = 1234567;
    const random = () => ((seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0) / 2 ** 32);
    for (let run = 0; run < 100; run++) {
      const input = Array.from({ length: 80 }, (_, i) => node(String(i), random() < .8 ? String(Math.floor(random() * 90)) : undefined));
      input.push(node("linked", undefined, "3"), node("linked-child", "linked"));
      for (let i = input.length - 1; i > 0; i--) {
        const j = Math.floor(random() * (i + 1)); [input[i], input[j]] = [input[j]!, input[i]!];
      }
      const before = JSON.stringify(input);
      input.forEach((n) => { Object.freeze(n.data); Object.freeze(n); }); Object.freeze(input);
      const actual = projectTreeEntries(input);
      expect(actual).toEqual(legacy(input));
      for (const entry of actual) expect(input.includes(entry.node)).toBe(true);
      expect(JSON.stringify(input)).toBe(before);
    }
  });

  it("enumerates a reversed 10000-deep chain without recursive stack limits", () => {
    const input = Array.from({ length: 10000 }, (_, i) => node(String(i), i ? String(i - 1) : undefined)).reverse();
    const entries = projectTreeEntries(input);
    expect(entries).toHaveLength(10000);
    entries.forEach((entry, i) => { expect(entry.node.id).toBe(String(i)); expect(entry.depth).toBe(i); });
  });

  it("keeps wide siblings complete and input ordered with one parent read per row", () => {
    let reads = 0;
    const input = Array.from({ length: 10000 }, (_, i) => ({ ...node(String(i)),
      get parentId() { reads++; return i ? "0" : undefined; } }));
    const entries = projectTreeEntries(input);
    expect(reads).toBe(10000);
    expect(entries).toHaveLength(10000);
    entries.forEach((entry, i) => { expect(entry.node).toBe(input[i]); expect(entry.depth).toBe(i ? 1 : 0); });
  });
});
