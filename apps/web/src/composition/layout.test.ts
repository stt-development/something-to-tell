import type { Node } from "@xyflow/react";
import { describe, expect, it } from "vitest";
import type { NarrativeNodeData } from "../types";
import { absoluteNodePosition, enforceFrameMinimums, fitFrameToContent, isPlacementDescendant, locationPlacementWouldCycle, moveNodePlacement } from "./layout";

describe("adaptive frame layout", () => {
  it("moves a compatible node to relative coordinates and grows the frame", () => {
    const nodes = fixtures();
    nodes[1] = { ...nodes[1]!, position: { x: 580, y: 330 } };

    const result = moveNodePlacement(nodes, "character", "scene");

    expect(result.valid).toBe(true);
    expect(result.nodes.find((node) => node.id === "character")).toMatchObject({ parentId: "scene", position: { x: 480, y: 230 } });
    expect(result.nodes.find((node) => node.id === "scene")).toMatchObject({ width: 764, height: 410 });
    expect(absoluteNodePosition(result.nodes, result.nodes.find((node) => node.id === "character")!)).toEqual({ x: 580, y: 330 });
  });

  it("rejects an invalid child kind without changing layout", () => {
    const nodes = fixtures();
    nodes.push(node("dialogue", "Dialogue", { x: 340, y: 140 }));
    nodes[0] = { ...nodes[0]!, data: { ...nodes[0]!.data, kind: "Location" } };

    const result = moveNodePlacement(nodes, "dialogue", "scene");

    expect(result).toMatchObject({ valid: false, message: "Location cannot contain Dialogue" });
    expect(result.nodes).toEqual(nodes);
  });

  it("moves a child with its frame and restores world coordinates when removed", () => {
    const contained = moveNodePlacement(fixtures(), "character", "scene").nodes;
    const movedFrame = contained.map((candidate) => candidate.id === "scene" ? { ...candidate, position: { x: 300, y: 240 } } : candidate);
    const child = movedFrame.find((candidate) => candidate.id === "character")!;
    expect(absoluteNodePosition(movedFrame, child)).toEqual({ x: 500, y: 400 });

    const root = moveNodePlacement(movedFrame, "character", null).nodes.find((candidate) => candidate.id === "character")!;
    expect(root).toMatchObject({ parentId: undefined, position: { x: 500, y: 400 } });
  });

  it("prevents manual shrink and supports explicit fit content", () => {
    let nodes = moveNodePlacement(fixtures(), "character", "scene").nodes;
    nodes = nodes.map((candidate) => candidate.id === "scene" ? { ...candidate, width: 200, height: 100 } : candidate);
    const clamped = enforceFrameMinimums(nodes);
    expect(clamped.find((node) => node.id === "scene")).toMatchObject({ width: 484, height: 340 });

    const oversized = clamped.map((candidate) => candidate.id === "scene" ? { ...candidate, width: 900, height: 700 } : candidate);
    expect(fitFrameToContent(oversized, "scene").find((node) => node.id === "scene")).toMatchObject({ width: 484, height: 340 });
  });

  it("rejects direct and indirect canonical Location cycles", () => {
    const locations = [
      { ...node("harbor", "Location", { x: 0, y: 0 }), data: { ...node("harbor", "Location", { x: 0, y: 0 }).data, isFrame: true } },
      { ...node("warehouse", "Location", { x: 24, y: 58 }), parentId: "harbor", data: { ...node("warehouse", "Location", { x: 0, y: 0 }).data, containerNodeId: "harbor", isFrame: true } },
      { ...node("office", "Location", { x: 24, y: 58 }), parentId: "warehouse", data: { ...node("office", "Location", { x: 0, y: 0 }).data, containerNodeId: "warehouse", isFrame: true } }
    ];

    expect(locationPlacementWouldCycle(locations, "harbor", "office")).toBe(true);
    expect(locationPlacementWouldCycle(locations, "office", "harbor", "office")).toBe(false);
    expect(moveNodePlacement(locations, "harbor", "office")).toMatchObject({ valid: false });
  });

  it("distinguishes descendant frames from valid enclosing drop targets", () => {
    const nodes = [
      { ...node("scene", "Scene", { x: 0, y: 0 }), data: { ...node("scene", "Scene", { x: 0, y: 0 }).data, isFrame: true } },
      { ...node("harbor", "Location", { x: 24, y: 58 }), parentId: "scene", data: { ...node("harbor", "Location", { x: 0, y: 0 }).data, isFrame: true } },
      { ...node("office", "Location", { x: 24, y: 58 }), parentId: "harbor", data: { ...node("office", "Location", { x: 0, y: 0 }).data, isFrame: true } }
    ];

    expect(isPlacementDescendant(nodes, "harbor", "scene")).toBe(true);
    expect(isPlacementDescendant(nodes, "office", "harbor")).toBe(true);
    expect(isPlacementDescendant(nodes, "scene", "harbor")).toBe(false);
  });
});

function fixtures(): Node<NarrativeNodeData>[] {
  return [
    { ...node("scene", "Scene", { x: 100, y: 100 }), width: 400, height: 300, data: { ...node("scene", "Scene", { x: 0, y: 0 }).data, isFrame: true } },
    node("character", "Character", { x: 300, y: 260 })
  ];
}

function node(id: string, kind: NarrativeNodeData["kind"], position: { x: number; y: number }): Node<NarrativeNodeData> {
  return { id, type: "narrative", position, width: 260, height: 156, data: { kind, label: id, title: id, summary: "", tags: [] } };
}
