import type { ImpactAnalysisRun, ImpactFinding, ImpactResourceRef } from "@something-to-tell/contracts/impact-analysis";
import type { Edge, Node } from "@xyflow/react";
import { canonOwnerCanvasEdgeId, canonOwnerNodeId } from "../canon/navigation";
import type { NarrativeEdgeData, NarrativeNodeData } from "../types";

export type ImpactHighlightRole = "seed" | "direct" | "transitive";

export interface ImpactHighlight {
  findingId: string | null;
  preview: string;
  propagation: ImpactFinding["propagation"] | null;
  role: ImpactHighlightRole;
}

export interface ImpactHighlightProjection<TNode, TEdge> {
  edges: TEdge[];
  nodes: TNode[];
  storyNodes: Map<string, ImpactHighlight>;
}

const rolePriority: Record<ImpactHighlightRole, number> = { seed: 0, direct: 1, transitive: 2 };

/** Projects one authoritative run onto existing visual identities without inventing canvas records. */
export function projectImpactHighlights<
  TNode extends Node<NarrativeNodeData>,
  TEdge extends Edge<NarrativeEdgeData>
>(
  nodes: readonly TNode[],
  edges: readonly TEdge[],
  run: ImpactAnalysisRun | null,
  seedPreview: string,
  findingPreview: (finding: ImpactFinding) => string
): ImpactHighlightProjection<TNode, TEdge> {
  const byResource = new Map<string, ImpactHighlight>();
  if (run?.status === "completed") {
    const seeds = run.request.scenario.type === "selection"
      ? run.request.scenario.seeds
      : run.findings.flatMap((finding) => finding.seeds);
    for (const seed of seeds) setHighlight(byResource, seed.resource, {
      findingId: null,
      preview: seedPreview,
      propagation: null,
      role: "seed"
    });
    for (const finding of run.findings) setHighlight(byResource, finding.target, {
      findingId: finding.id,
      preview: findingPreview(finding),
      propagation: finding.propagation,
      role: finding.distance === 1 ? "direct" : "transitive"
    });
  }

  const nodeHighlights = new Map<string, ImpactHighlight>();
  const edgeHighlights = new Map<string, ImpactHighlight>();
  for (const [key, highlight] of byResource) {
    const resource = parseResourceKey(key);
    const nodeId = canonOwnerNodeId(resource, nodes);
    const edgeId = canonOwnerCanvasEdgeId(resource)
      ?? edges.find((edge) => impactEdgeOwnsResource(edge, resource))?.id
      ?? null;
    if (nodeId) mergeHighlight(nodeHighlights, nodeId, highlight);
    if (edgeId) mergeHighlight(edgeHighlights, edgeId, highlight);
  }

  return {
    nodes: nodes.map((node) => {
      const highlight = nodeHighlights.get(node.data.canonicalNodeId ?? node.id);
      return { ...node, data: { ...node.data, impactHighlight: highlight } } as TNode;
    }),
    edges: edges.map((edge) => {
      const highlight = edgeHighlights.get(edge.id);
      return {
        ...edge,
        data: { ...edge.data, impactHighlight: highlight },
        style: highlight ? impactEdgeStyle(edge.style, highlight) : edge.style
      } as TEdge;
    }),
    storyNodes: nodeHighlights
  };
}

/** Returns the immediate dependency explanation retained by the runtime path. */
export function firstHop(finding: ImpactFinding) {
  return finding.paths[0]?.dependencies[0] ?? null;
}

function setHighlight(target: Map<string, ImpactHighlight>, resource: ImpactResourceRef, highlight: ImpactHighlight) {
  const key = resourceKey(resource);
  const current = target.get(key);
  if (!current || rolePriority[highlight.role] < rolePriority[current.role]) target.set(key, highlight);
}

function mergeHighlight(target: Map<string, ImpactHighlight>, id: string, highlight: ImpactHighlight) {
  const current = target.get(id);
  if (!current || rolePriority[highlight.role] < rolePriority[current.role]) target.set(id, highlight);
}

function impactEdgeOwnsResource(edge: Edge<NarrativeEdgeData>, resource: ImpactResourceRef): boolean {
  if (resource.owner_type === "scene_boundary") return edge.data?.sceneBoundary?.boundaryId === resource.owner_id;
  return false;
}

function impactEdgeStyle(style: Edge["style"], highlight: ImpactHighlight): Edge["style"] {
  const color = highlight.role === "seed" ? "#0f766e" : highlight.role === "direct" ? "#dc2626" : "#2563eb";
  return {
    ...style,
    stroke: color,
    strokeDasharray: highlight.role === "transitive" ? "8 5" : undefined,
    strokeWidth: highlight.role === "seed" ? 5 : 4
  };
}

function resourceKey(resource: ImpactResourceRef): string {
  return JSON.stringify([resource.owner_type, resource.owner_id, resource.context_type, resource.context_id]);
}

function parseResourceKey(key: string): ImpactResourceRef {
  const [owner_type, owner_id, context_type, context_id] = JSON.parse(key) as Array<string | null>;
  return { owner_type: owner_type!, owner_id: owner_id!, context_type: context_type ?? null, context_id: context_id ?? null };
}
