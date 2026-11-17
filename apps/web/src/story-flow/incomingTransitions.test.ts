import { afterEach, expect, it, vi } from "vitest";
import { projectFixture } from "../testFixtures/projectFixtures";
import { buildIncomingTransitionLookup } from "./incomingTransitions";

const template = projectFixture("aurora").storyFlows[0]!.transitions[0]!;
afterEach(() => vi.restoreAllMocks());

it("matches raw target filters without canonicalization, sorting or duplicate removal", () => {
  const transitions = [template, { ...template, source_node_id: "other" },
    { ...template, target_node_id: "" }, { ...template, target_node_id: "__proto__" },
    { ...template, target_node_id: "missing", source_node_id: "missing" }];
  const grouped = buildIncomingTransitionLookup(transitions);
  for (const id of [template.target_node_id, "", "__proto__", "missing", "absent"]) {
    const expected = transitions.filter((item) => item.target_node_id === id);
    expect(grouped.get(id) ?? []).toEqual(expected);
    expected.forEach((item, index) => expect(grouped.get(id)![index]).toBe(item));
  }
});

it.each([20, 80])("reads each of %s explicit targets once without inspecting source rows or rescanning on lookup", (count) => {
  let targets = 0, sources = 0;
  const transitions = Array.from({ length: count }, (_, index) => new Proxy({ ...template, target_node_id: `target-${index % 2}` }, {
    get(target, key, receiver) {
      if (key === "target_node_id") targets++;
      if (key === "source_node_id") sources++;
      return Reflect.get(target, key, receiver);
    }
  }));
  const grouped = buildIncomingTransitionLookup(transitions);
  const get = vi.spyOn(grouped, "get");
  for (let index = 0; index < count; index++) expect(grouped.get(`target-${index % 2}`)).toHaveLength(count / 2);
  expect(get).toHaveBeenCalledTimes(count);
  expect({ targets, sources }).toEqual({ targets: count, sources: 0 });
});

it("uses current frozen inputs and leaves earlier groups and transition records untouched", () => {
  const item = Object.freeze({ ...template });
  const raw = Object.freeze([item]);
  const before = buildIncomingTransitionLookup(raw);
  const next = buildIncomingTransitionLookup([Object.freeze({ ...item, target_node_id: "new-target" })]);
  expect(next.has(item.target_node_id)).toBe(false);
  expect(next.get("new-target")![0]!.target_node_id).toBe("new-target");
  expect(before.get(item.target_node_id)![0]).toBe(item);
  expect(buildIncomingTransitionLookup(raw).get(item.target_node_id)).not.toBe(before.get(item.target_node_id));
  expect(buildIncomingTransitionLookup([]).size).toBe(0);
});
