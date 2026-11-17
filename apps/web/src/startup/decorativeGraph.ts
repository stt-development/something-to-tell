export type DecorativeNodeKind = "character" | "dialogue" | "event" | "item" | "location" | "quest" | "scene";

export interface DecorativeGraphNode {
  height: number;
  id: string;
  kind: DecorativeNodeKind;
  width: number;
  x: number;
  y: number;
}

export interface DecorativeGraphEdge {
  id: string;
  kind: "relationship" | "story";
  source: string;
  target: string;
}

export interface DecorativeGraph {
  edges: DecorativeGraphEdge[];
  nodes: DecorativeGraphNode[];
  worldHeight: number;
  worldWidth: number;
}

/** Frontend-owned decorative budget; this data never enters ProjectDocument or runtime storage. */
export const STARTUP_GRAPH_BUDGET = Object.freeze({
  edges: 44,
  nodes: 24,
  worldHeight: 760,
  worldWidth: 1920
});

export const STARTUP_GRAPH_SEED = 0x51a7c0de;

const KINDS: DecorativeNodeKind[] = ["scene", "character", "quest", "dialogue", "location", "item", "event"];

/** Creates a stable random-looking graph without importing fixtures or authored project content. */
export function createDecorativeGraph(seed = STARTUP_GRAPH_SEED): DecorativeGraph {
  const random = seededRandom(seed);
  const nodes: DecorativeGraphNode[] = [];
  const layers = 6;
  const lanes = 4;
  for (let layer = 0; layer < layers; layer += 1) {
    for (let lane = 0; lane < lanes; lane += 1) {
      const id = `decorative-${layer}-${lane}`;
      nodes.push({
        height: 48 + Math.round(random() * 22),
        id,
        kind: KINDS[Math.floor(random() * KINDS.length)]!,
        width: 132 + Math.round(random() * 54),
        x: 76 + layer * 306 + Math.round((random() - 0.5) * 68),
        y: 62 + lane * 166 + Math.round((random() - 0.5) * 54)
      });
    }
  }

  const edges: DecorativeGraphEdge[] = [];
  for (let layer = 0; layer < layers - 1; layer += 1) {
    for (let lane = 0; lane < lanes; lane += 1) {
      edges.push({
        id: `story-${layer}-${lane}`,
        kind: "story",
        source: `decorative-${layer}-${lane}`,
        target: `decorative-${layer + 1}-${lane}`
      });
    }
  }
  for (let branch = 0; branch < 8; branch += 1) {
    const layer = branch % (layers - 1);
    const lane = Math.floor(random() * lanes);
    const targetLane = (lane + (random() > 0.5 ? 1 : lanes - 1)) % lanes;
    edges.push({
      id: `branch-${branch}`,
      kind: "story",
      source: `decorative-${layer}-${lane}`,
      target: `decorative-${layer + 1}-${targetLane}`
    });
  }
  for (let relationship = 0; relationship < 16; relationship += 1) {
    const sourceIndex = Math.floor(random() * nodes.length);
    let targetIndex = Math.floor(random() * nodes.length);
    if (targetIndex === sourceIndex) targetIndex = (targetIndex + lanes + 1) % nodes.length;
    edges.push({
      id: `relationship-${relationship}`,
      kind: "relationship",
      source: nodes[sourceIndex]!.id,
      target: nodes[targetIndex]!.id
    });
  }

  return {
    edges: edges.slice(0, STARTUP_GRAPH_BUDGET.edges),
    nodes: nodes.slice(0, STARTUP_GRAPH_BUDGET.nodes),
    worldHeight: STARTUP_GRAPH_BUDGET.worldHeight,
    worldWidth: STARTUP_GRAPH_BUDGET.worldWidth
  };
}

function seededRandom(seed: number) {
  let state = seed >>> 0;
  return () => {
    state += 0x6d2b79f5;
    let value = state;
    value = Math.imul(value ^ (value >>> 15), value | 1);
    value ^= value + Math.imul(value ^ (value >>> 7), value | 61);
    return ((value ^ (value >>> 14)) >>> 0) / 4294967296;
  };
}
