import type { Node, XYPosition } from "@xyflow/react";
import type { NarrativeNodeData } from "../types";
import { allowsComposition } from "./contracts";
import { buildFrameChildBounds, frameBoundsForChildren, type FrameChildBounds } from "./frameBounds";

export const FRAME_PADDING = 24;
export const FRAME_HEADER_HEIGHT = 34;
export const FRAME_MIN_SIZE = { width: 320, height: 220 };
export const COLLAPSED_FRAME_SIZE = { width: 280, height: 112 };

export interface CompositionLayoutResult {
  message: string;
  nodes: Node<NarrativeNodeData>[];
  valid: boolean;
}

/** Returns world coordinates while persisted child coordinates remain parent-relative. */
export function absoluteNodePosition(nodes: readonly Node<NarrativeNodeData>[], node: Node<NarrativeNodeData>): XYPosition {
  return createAbsoluteNodePositionResolver(nodes)(node);
}

/** One invocation-local visual lookup; callers own its lifetime over immutable inputs. */
export function createAbsoluteNodePositionResolver(nodes: readonly Node<NarrativeNodeData>[]): (node: Node<NarrativeNodeData>) => XYPosition {
  const byId = new Map(nodes.map((candidate) => [candidate.id, candidate]));
  return (node) => {
    let position = { ...node.position };
    let parentId = node.parentId;
    const visited = new Set<string>([node.id]);
    while (parentId) {
      if (visited.has(parentId)) break;
      visited.add(parentId);
      const parent = byId.get(parentId);
      if (!parent) break;
      position = { x: position.x + parent.position.x, y: position.y + parent.position.y };
      parentId = parent.parentId;
    }
    return position;
  };
}

/** Moves one visual placement and expands its target without changing canonical content. */
export function moveNodePlacement(
  nodes: readonly Node<NarrativeNodeData>[],
  nodeId: string,
  targetFrameId: string | null
): CompositionLayoutResult {
  const node = nodes.find((candidate) => candidate.id === nodeId);
  if (!node) return { message: "Node not found", nodes: [...nodes], valid: false };
  const worldPosition = absoluteNodePosition(nodes, node);
  if (!targetFrameId) {
    return {
      message: "Moved to root canvas",
      nodes: parentsBeforeChildren(nodes.map((candidate) => candidate.id === nodeId
        ? { ...candidate, parentId: undefined, position: worldPosition, data: { ...candidate.data, containerNodeId: undefined } }
        : candidate)),
      valid: true
    };
  }

  const frame = nodes.find((candidate) => candidate.id === targetFrameId && candidate.data.isFrame);
  if (!frame || frame.id === node.id) return { message: "Container not found", nodes: [...nodes], valid: false };
  if (!allowsComposition(frame.data.kind, node.data.kind)) {
    return { message: `${frame.data.kind} cannot contain ${node.data.kind}`, nodes: [...nodes], valid: false };
  }
  if (locationPlacementWouldCycle(nodes, node.data.canonicalNodeId ?? node.id, frame.id, node.id)) {
    return { message: "Location containment cannot create a cycle", nodes: [...nodes], valid: false };
  }
  if (isPlacementDescendant(nodes, frame.id, node.id)) {
    return { message: "A container cannot be moved inside its descendant", nodes: [...nodes], valid: false };
  }

  const frameWorld = absoluteNodePosition(nodes, frame);
  let relative = { x: worldPosition.x - frameWorld.x, y: worldPosition.y - frameWorld.y };
  const shiftX = Math.max(0, FRAME_PADDING - relative.x);
  const shiftY = Math.max(0, FRAME_HEADER_HEIGHT + FRAME_PADDING - relative.y);
  relative = { x: relative.x + shiftX, y: relative.y + shiftY };
  const childWidth = node.width ?? 260;
  const childHeight = node.height ?? 156;

  const moved = nodes.map((candidate) => {
    if (candidate.id === frame.id) {
      return {
        ...candidate,
        position: { x: candidate.position.x - shiftX, y: candidate.position.y - shiftY },
        width: Math.max((frame.width ?? FRAME_MIN_SIZE.width) + shiftX, relative.x + childWidth + FRAME_PADDING),
        height: Math.max((frame.height ?? FRAME_MIN_SIZE.height) + shiftY, relative.y + childHeight + FRAME_PADDING)
      };
    }
    if (candidate.id === node.id) {
      return { ...candidate, parentId: frame.id, position: relative, data: { ...candidate.data, containerNodeId: frame.id } };
    }
    if (candidate.parentId === frame.id && (shiftX || shiftY)) {
      return { ...candidate, position: { x: candidate.position.x + shiftX, y: candidate.position.y + shiftY } };
    }
    return candidate;
  });
  return { message: `Placed in ${frame.data.title}`, nodes: parentsBeforeChildren(moved), valid: true };
}

/** Clamps frame dimensions so direct children can never be hidden by manual resize. */
export function enforceFrameMinimums(nodes: readonly Node<NarrativeNodeData>[]): Node<NarrativeNodeData>[] {
  let childBounds: ReadonlyMap<string, FrameChildBounds> | undefined;
  return nodes.map((node) => {
    if (!node.data.isFrame || node.data.presentationState === "collapsed") return node;
    childBounds ??= buildFrameChildBounds(nodes);
    const required = frameSizeForBounds(childBounds.get(node.id));
    return {
      ...node,
      width: Math.max(node.width ?? FRAME_MIN_SIZE.width, required.width),
      height: Math.max(node.height ?? FRAME_MIN_SIZE.height, required.height)
    };
  });
}

/** Explicit fit is the only operation allowed to shrink a frame around its contents. */
export function fitFrameToContent(nodes: readonly Node<NarrativeNodeData>[], frameId: string): Node<NarrativeNodeData>[] {
  const required = frameContentSize(nodes, frameId);
  return nodes.map((node) => node.id === frameId && node.data.presentationState !== "collapsed"
    ? { ...node, width: required.width, height: required.height }
    : node);
}

export function parentsBeforeChildren(nodes: readonly Node<NarrativeNodeData>[]): Node<NarrativeNodeData>[] {
  const depth = (node: Node<NarrativeNodeData>) => {
    let value = 0;
    let parentId = node.parentId;
    const visited = new Set<string>();
    while (parentId && !visited.has(parentId)) {
      visited.add(parentId);
      value += 1;
      parentId = nodes.find((candidate) => candidate.id === parentId)?.parentId;
    }
    return value;
  };
  return [...nodes].sort((left, right) => depth(left) - depth(right));
}

/** Validates canonical Location ancestry for both moves and linked copies. */
export function locationPlacementWouldCycle(
  nodes: readonly Node<NarrativeNodeData>[],
  childCanonicalNodeId: string,
  targetFrameId: string,
  excludedPlacementId?: string
) {
  const byId = new Map(nodes.map((node) => [node.id, node]));
  const canonicalId = (node: Node<NarrativeNodeData>) => node.data.canonicalNodeId ?? node.id;
  const child = nodes.find((node) => canonicalId(node) === childCanonicalNodeId);
  const target = byId.get(targetFrameId);
  if (child?.data.kind !== "Location" || target?.data.kind !== "Location") return false;
  const adjacency = new Map<string, Set<string>>();
  for (const placement of nodes) {
    if (placement.id === excludedPlacementId || placement.data.kind !== "Location" || !placement.parentId) continue;
    const parent = byId.get(placement.parentId);
    if (parent?.data.kind !== "Location") continue;
    const parentId = canonicalId(parent);
    adjacency.set(parentId, new Set([...(adjacency.get(parentId) ?? []), canonicalId(placement)]));
  }
  const targetCanonicalId = canonicalId(target);
  adjacency.set(targetCanonicalId, new Set([...(adjacency.get(targetCanonicalId) ?? []), childCanonicalNodeId]));
  const visiting = new Set<string>();
  const visited = new Set<string>();
  const visit = (nodeId: string): boolean => {
    if (visiting.has(nodeId)) return true;
    if (visited.has(nodeId)) return false;
    visiting.add(nodeId);
    if ([...(adjacency.get(nodeId) ?? [])].some(visit)) return true;
    visiting.delete(nodeId);
    visited.add(nodeId);
    return false;
  };
  return [...adjacency.keys()].some((nodeId) => !visited.has(nodeId) && visit(nodeId));
}

function frameContentSize(nodes: readonly Node<NarrativeNodeData>[], frameId: string) {
  return frameSizeForBounds(frameBoundsForChildren(nodes.filter((node) => node.parentId === frameId)));
}

function frameSizeForBounds(bounds: FrameChildBounds | undefined) {
  return {
    width: Math.max(FRAME_MIN_SIZE.width, (bounds?.right ?? 0) + FRAME_PADDING),
    height: Math.max(FRAME_MIN_SIZE.height, (bounds?.bottom ?? 0) + FRAME_PADDING)
  };
}

/** Reports visual ancestry so a dragged frame never treats its own contents as drop targets. */
export function isPlacementDescendant(nodes: readonly Node<NarrativeNodeData>[], candidateId: string, ancestorId: string) {
  let current = nodes.find((node) => node.id === candidateId);
  const visited = new Set<string>();
  while (current?.parentId && !visited.has(current.parentId)) {
    if (current.parentId === ancestorId) return true;
    visited.add(current.parentId);
    current = nodes.find((node) => node.id === current?.parentId);
  }
  return false;
}
