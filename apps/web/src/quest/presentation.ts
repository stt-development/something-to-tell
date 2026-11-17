import type { QuestDocument } from "./contracts";

export interface QuestCanvasMetrics {
  branches: number;
  prerequisites: number;
  rewards: number;
  stages: number;
}

/** Derives card metrics without persisting duplicate presentation data. */
export function questCanvasMetrics(document: QuestDocument | undefined): QuestCanvasMetrics {
  return {
    branches: document?.stages.reduce((total, stage) => total + stage.branches.length, 0) ?? 0,
    prerequisites: document?.prerequisite_node_ids.length ?? 0,
    rewards: document?.reward_node_ids.length ?? 0,
    stages: document?.stages.length ?? 0
  };
}
