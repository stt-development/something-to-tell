import { expect, it } from "vitest";
import { createAbsoluteNodePositionResolver } from "../../composition/layout";
import { projectSessionToGraphSnapshot } from "../../runtime/projections";
import { projectGraphForWorkspace } from "../../story-flow/workspace";
import { projectFixture } from "../../testFixtures/projectFixtures";
import { queryViewportEligibility } from "./viewportEligibility";

it.each(["relationships", "flow"] as const)("consumes current %s projection geometry without canonical merging or changing authored coordinates", (workspaceMode) => {
  const fixture = projectFixture("aurora");
  const raw = projectSessionToGraphSnapshot(fixture.response);
  const snapshot = fixture.storyFlows.find((item) => item.flow.id === "flow-main-story")!;
  const projection = projectGraphForWorkspace(raw.nodes, raw.edges, workspaceMode, snapshot, fixture.storyFlows);
  const before = JSON.stringify({ raw, projection });
  const world = createAbsoluteNodePositionResolver(projection.nodes);
  // The geometry owner supplies already projected rectangles; eligibility never resolves raw ancestry positions.
  const placements = projection.nodes.map((node) => ({ id: node.id, parentId: node.parentId,
    worldBounds: { ...world(node), width: node.width ?? 260, height: node.height ?? 156 } }));
  const target = workspaceMode === "relationships" ? projection.nodes.find((node) => node.data.isLinkedInstance)!
    : projection.nodes.find((node) => node.id === "node-dock-dialogue")!;
  const value = queryViewportEligibility({ scope: { projectId: raw.activeProjectId, workspaceMode, flowId: snapshot.flow.id, focusedFrameId: null },
    placements, viewport: { x: 1e6, y: 1e6, width: 1440, height: 900, zoom: 1 }, protectedIds: new Set([target.id]) });
  const expected = new Set([target.id]);
  const byId = new Map(projection.nodes.map((node) => [node.id, node]));
  let parentId = target.parentId;
  while (parentId) { expected.add(parentId); parentId = byId.get(parentId)?.parentId; }
  expect(value.eligibleIds).toEqual(expected);
  expect(value.fallback).toBe("none");
  if (workspaceMode === "relationships") expect(value.eligibleIds.has(target.data.canonicalNodeId!)).toBe(false);
  else {
    expect(target.parentId).toBeUndefined();
    expect(placements.find((item) => item.id === target.id)!.worldBounds).toMatchObject({ x: 430, y: 0 });
  }
  expect(JSON.stringify({ raw, projection })).toBe(before);
});
