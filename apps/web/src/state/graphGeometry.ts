import type { Node, XYPosition } from "@xyflow/react";
import { absoluteNodePosition } from "../composition/layout";
import type { EdgeDraft, NarrativeNodeData, NodeDraft } from "../types";

/** Places locally-created nodes predictably until runtime persistence returns. */
export function nextNodePosition(count: number): XYPosition {
  return { x: 160 + count * 36, y: 120 + count * 28 };
}

/** Builds the optimistic React Flow node used before a durable id is available. */
export function createLocalNode(draft: NodeDraft, id: string, position: XYPosition): Node<NarrativeNodeData> {
  return {
    id,
    type: "narrative",
    position,
    width: 260,
    height: 156,
    data: { kind: draft.kind, label: draft.title, title: draft.title, summary: draft.summary, tags: draft.tags }
  };
}

/** Resolves omitted handles from absolute centers, including nested placements. */
export function resolveConnectionHandles(
  source: Node<NarrativeNodeData>,
  target: Node<NarrativeNodeData>,
  connection: Pick<EdgeDraft, "sourceHandle" | "targetHandle">,
  nodes: readonly Node<NarrativeNodeData>[]
) {
  return {
    sourceHandle: connection.sourceHandle ?? closestSide(source, target, nodes),
    targetHandle: connection.targetHandle ?? closestSide(target, source, nodes)
  };
}

function closestSide(
  node: Node<NarrativeNodeData>,
  other: Node<NarrativeNodeData>,
  nodes: readonly Node<NarrativeNodeData>[]
) {
  const center = nodeCenter(node, nodes);
  const otherCenter = nodeCenter(other, nodes);
  const dx = otherCenter.x - center.x;
  const dy = otherCenter.y - center.y;
  if (Math.abs(dx) >= Math.abs(dy)) return dx >= 0 ? "right" : "left";
  return dy >= 0 ? "bottom" : "top";
}

function nodeCenter(node: Node<NarrativeNodeData>, nodes: readonly Node<NarrativeNodeData>[]) {
  const position = absoluteNodePosition(nodes, node);
  return {
    x: position.x + (node.width ?? 260) / 2,
    y: position.y + (node.height ?? 156) / 2
  };
}

/** Keeps relationship edges visually distinct from Story Flow transitions. */
export function relationshipEdgeStyle() {
  return { stroke: "#475569", strokeWidth: 3 };
}

/** Compares every persisted placement field affected by move and resize gestures. */
export function samePlacementGeometry(
  left: readonly Node<NarrativeNodeData>[],
  right: readonly Node<NarrativeNodeData>[]
) {
  return left.length === right.length && left.every((node) => {
    const candidate = right.find((item) => item.id === node.id);
    return candidate
      && candidate.parentId === node.parentId
      && candidate.position.x === node.position.x
      && candidate.position.y === node.position.y
      && candidate.width === node.width
      && candidate.height === node.height;
  });
}

/** Returns the durable canonical owner behind a primary or linked placement. */
export function canonicalNodeId(node: Node<NarrativeNodeData>) {
  return node.data.canonicalNodeId ?? node.id;
}

/** Counts canonical entities rather than duplicated visual placements. */
export function canonicalNodeCount(nodes: readonly Node<NarrativeNodeData>[]) {
  return new Set(nodes.map(canonicalNodeId)).size;
}
