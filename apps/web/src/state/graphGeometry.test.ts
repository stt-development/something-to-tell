import type { Node } from "@xyflow/react";
import { describe, expect, it } from "vitest";
import type { NarrativeNodeData } from "../types";
import {
  canonicalNodeCount,
  createLocalNode,
  resolveConnectionHandles,
  samePlacementGeometry
} from "./graphGeometry";

describe("graph geometry helpers", () => {
  it("resolves handles from absolute nested positions", () => {
    const frame = node("frame", { x: 100, y: 80 });
    const child = { ...node("child", { x: 30, y: 40 }), parentId: frame.id };
    const target = node("target", { x: 600, y: 120 });

    expect(resolveConnectionHandles(child, target, {}, [frame, child, target])).toEqual({
      sourceHandle: "right",
      targetHandle: "left"
    });
  });

  it("preserves explicit handles and compares complete placement geometry", () => {
    const source = node("source", { x: 0, y: 0 });
    const target = node("target", { x: 0, y: 400 });

    expect(resolveConnectionHandles(source, target, {
      sourceHandle: "left",
      targetHandle: "right"
    }, [source, target])).toEqual({ sourceHandle: "left", targetHandle: "right" });
    expect(samePlacementGeometry([source], [{ ...source, width: 300 }])).toBe(false);
    expect(samePlacementGeometry([source], [{ ...source }])).toBe(true);
  });

  it("builds optimistic nodes and counts linked instances once", () => {
    const created = createLocalNode(
      { kind: "Event", title: "Arrival", summary: "", tags: [] },
      "local",
      { x: 10, y: 20 }
    );
    const linked = {
      ...created,
      id: "placement:linked",
      data: { ...created.data, canonicalNodeId: created.id }
    };

    expect(created).toMatchObject({ id: "local", position: { x: 10, y: 20 } });
    expect(canonicalNodeCount([created, linked])).toBe(1);
  });
});

function node(id: string, position: { x: number; y: number }): Node<NarrativeNodeData> {
  return {
    id,
    type: "narrative",
    position,
    width: 260,
    height: 156,
    data: { kind: "Event", label: id, title: id, summary: "", tags: [] }
  };
}
