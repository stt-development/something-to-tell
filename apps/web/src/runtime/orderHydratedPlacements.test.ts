import type { Node } from "@xyflow/react";
import { describe, expect, it, vi } from "vitest";
// @ts-expect-error Vitest supplies Node; production web types intentionally omit it.
import { readFileSync } from "node:fs";
// @ts-expect-error Vitest supplies Node; production web types intentionally omit it.
import { gunzipSync } from "node:zlib";
import { parentsBeforeChildren } from "../composition/layout";
import type { NarrativeNodeData } from "../types";
import { projectFixture } from "../testFixtures/projectFixtures";
import { projectSessionToGraphSnapshot } from "./projections";
import * as ordering from "./orderHydratedPlacements";

const node = (id: string, parentId?: string): Node<NarrativeNodeData> => ({ id, parentId, position: { x: 20, y: 60 },
  width: 260, height: 156, data: { kind: "Lore", label: id, title: id, summary: "Text", tags: ["tag"] } });
describe("hydration-only parent ordering", () => {
  it.each([
    [], [node("root")], [node("child", "root"), node("root"), node("sibling", "root")],
    [node("orphan", "missing"), node("root"), node("child", "orphan")],
    [node("a", "b"), node("b", "a"), node("c", "a")], [node("self", "self"), node("root")],
    [node("duplicate", "root"), node("duplicate"), node("root")]
  ])("matches legacy roots, missing parents, siblings and ambiguous fallback (%#)", (...nodes) => {
    const input = nodes as Node<NarrativeNodeData>[], before = structuredClone(input);
    const actual = ordering.orderHydratedPlacements(input);
    expect(actual).toEqual(parentsBeforeChildren(input)); expect(input).toEqual(before);
    expect(actual.every((entry) => input.includes(entry))).toBe(true); expect(actual).not.toBe(input);
  });
  it("retains exact sibling order in deterministically shuffled forests without mutating rows", () => {
    let seed = 314159;
    const random = () => { seed = (seed * 1664525 + 1013904223) >>> 0; return seed / 2 ** 32; };
    for (let sample = 0; sample < 100; sample++) {
      const input = Array.from({ length: 32 }, (_, i) => node(String(i), i && random() > 0.2 ? String(Math.floor(random() * i)) : undefined));
      for (let i = input.length - 1; i > 0; i--) { const j = Math.floor(random() * (i + 1)); [input[i], input[j]] = [input[j]!, input[i]!]; }
      expect(ordering.orderHydratedPlacements(input)).toEqual(parentsBeforeChildren(input));
    }
  });
  it("bounds ancestry/id work on a reversed 10,000-deep chain without recursion or truncation", () => {
    let reads = 0;
    const input = Array.from({ length: 10000 }, (_, i) => {
      const entry = node(String(i), i ? String(i - 1) : undefined);
      Object.defineProperty(entry, "id", { get: () => { reads++; return String(i); } }); return entry;
    }).reverse();
    const result = ordering.orderHydratedPlacements(input), work = reads;
    expect(result).toHaveLength(10000); expect(result[0]!.id).toBe("0"); expect(result[9999]!.id).toBe("9999");
    expect(work).toBeLessThan(150000); expect(input[0]!.id).toBe("9999");
  });
  it.each(["aurora", "citadel", "pinned-1000"] as const)("complete %s DTO including linked/specialized content matches legacy projection", (name) => {
    const base = projectFixture(name === "citadel" ? "citadel" : "aurora").response;
    // A dynamic path avoids Vite's browser-asset rewriting of literal new URL inputs.
    const pack = "../../../../fixtures/benchmarks/storage-scale-1000.v1.json.gz";
    const source = name === "pinned-1000" ? JSON.parse(gunzipSync(readFileSync(new URL(pack, import.meta.url))).toString()) : null;
    const response = source ? { ...base, document: source,
      session: { ...base.session, project_id: source.manifest.project_id, saved_revision: source.manifest.saved_revision,
        loaded_revision: source.manifest.saved_revision } } : base;
    const before = JSON.stringify(response), actual = projectSessionToGraphSnapshot(response);
    const spy = vi.spyOn(ordering, "orderHydratedPlacements").mockImplementation(parentsBeforeChildren);
    try { expect(actual).toEqual(projectSessionToGraphSnapshot(response)); } finally { spy.mockRestore(); }
    expect(JSON.stringify(response)).toBe(before);
  });
});
