import { expect, it } from "vitest";
import { projectTargetSelectable } from "./targetSelectionProjection";

it("preserves every row, geometry and explicit per-element permissions", () => {
  const rows = [{ id: "a", position: { x: 10, y: 20 }, data: { text: "Text" } },
    { id: "b", position: { x: 50, y: 70 }, data: { text: "Other" } }];
  const result = projectTargetSelectable(rows, "a", true);
  expect(result.known).toBe(true);
  expect(result.rows).toEqual([{ ...rows[0], selectable: false }, rows[1]]);
  expect(result.rows![0]!.position).toBe(rows[0]!.position);
  expect(result.rows![0]!.data).toBe(rows[0]!.data);
  expect(result.rows![1]).toBe(rows[1]);
  expect(rows[0]).not.toHaveProperty("selectable");
  for (const selectable of [false, true]) {
    const explicit = [{ id: "a", selectable }];
    expect(projectTargetSelectable(explicit, "a", true).rows).toBe(explicit);
  }
  expect(projectTargetSelectable(rows, null, true).rows).toBe(rows);
  expect(projectTargetSelectable(rows, "a", false).rows).toBe(rows);
});

it("unknown and duplicated targets are not declared safely projected", () => {
  for (const rows of [undefined, [], [{ id: "other" }], [{ id: "a" }, { id: "a" }]]) {
    expect(projectTargetSelectable(rows, "a", true)).toEqual({ rows, known: false });
  }
});
