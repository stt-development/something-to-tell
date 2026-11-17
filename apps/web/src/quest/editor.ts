import type { QuestBranch, QuestDocument, QuestStage } from "./contracts";

export type QuestMoveDirection = "down" | "up";

export interface QuestStageDeletionImpact {
  incomingBranchIds: string[];
  removesEntry: boolean;
}

/** Appends a valid stage with an aggregate-local stable id. */
export function appendQuestStage(document: QuestDocument): QuestDocument {
  const id = uniqueId("stage", questIds(document));
  const stage: QuestStage = { id, title: `Stage ${document.stages.length + 1}`, description: "", branches: [] };
  return { ...document, entry_stage_id: document.entry_stage_id ?? id, stages: [...document.stages, stage] };
}

/** Copies stage content while assigning fresh stage and branch ids. */
export function duplicateQuestStage(document: QuestDocument, stageId: string): QuestDocument {
  const index = document.stages.findIndex((stage) => stage.id === stageId);
  if (index < 0) return document;
  const ids = questIds(document);
  const source = document.stages[index]!;
  const id = uniqueId("stage", ids);
  ids.add(id);
  const duplicate: QuestStage = {
    ...source,
    id,
    title: `${source.title} copy`,
    branches: source.branches.map((branch) => {
      const branchId = uniqueId("branch", ids);
      ids.add(branchId);
      return { ...branch, id: branchId };
    })
  };
  const stages = [...document.stages];
  stages.splice(index + 1, 0, duplicate);
  return { ...document, stages };
}

/** Reorders presentation while stable ids keep branch references intact. */
export function moveQuestStage(document: QuestDocument, stageId: string, direction: QuestMoveDirection): QuestDocument {
  const index = document.stages.findIndex((stage) => stage.id === stageId);
  const target = direction === "up" ? index - 1 : index + 1;
  if (index < 0 || target < 0 || target >= document.stages.length) return document;
  const stages = [...document.stages];
  const [stage] = stages.splice(index, 1);
  stages.splice(target, 0, stage!);
  return { ...document, stages };
}

export function updateQuestStage(document: QuestDocument, stageId: string, updates: Partial<Omit<QuestStage, "id" | "branches">>): QuestDocument {
  return { ...document, stages: document.stages.map((stage) => stage.id === stageId ? { ...stage, ...updates } : stage) };
}

export function appendQuestBranch(document: QuestDocument, stageId: string): QuestDocument {
  const id = uniqueId("branch", questIds(document));
  return updateStage(document, stageId, (stage) => ({
    ...stage,
    branches: [...stage.branches, { id, label: `Path ${stage.branches.length + 1}`, condition: "", target_stage_id: null }]
  }));
}

export function updateQuestBranch(
  document: QuestDocument,
  stageId: string,
  branchId: string,
  updates: Partial<Omit<QuestBranch, "id">>
): QuestDocument {
  return updateStage(document, stageId, (stage) => ({
    ...stage,
    branches: stage.branches.map((branch) => branch.id === branchId ? { ...branch, ...updates } : branch)
  }));
}

export function deleteQuestBranch(document: QuestDocument, stageId: string, branchId: string): QuestDocument {
  return updateStage(document, stageId, (stage) => ({ ...stage, branches: stage.branches.filter((branch) => branch.id !== branchId) }));
}

/** Reports internal references that a confirmed stage deletion will detach. */
export function questStageDeletionImpact(document: QuestDocument, stageId: string): QuestStageDeletionImpact {
  return {
    incomingBranchIds: document.stages.flatMap((stage) => stage.branches.filter((branch) => branch.target_stage_id === stageId).map((branch) => branch.id)),
    removesEntry: document.entry_stage_id === stageId
  };
}

/** Deletes a stage and converts internal branches targeting it into endings. */
export function deleteQuestStage(document: QuestDocument, stageId: string): QuestDocument {
  const stages = document.stages
    .filter((stage) => stage.id !== stageId)
    .map((stage) => ({
      ...stage,
      branches: stage.branches.map((branch) => branch.target_stage_id === stageId ? { ...branch, target_stage_id: null } : branch)
    }));
  return {
    ...document,
    entry_stage_id: document.entry_stage_id === stageId ? stages[0]?.id ?? null : document.entry_stage_id,
    stages
  };
}

function updateStage(document: QuestDocument, stageId: string, update: (stage: QuestStage) => QuestStage): QuestDocument {
  return { ...document, stages: document.stages.map((stage) => stage.id === stageId ? update(stage) : stage) };
}

function questIds(document: QuestDocument): Set<string> {
  return new Set(document.stages.flatMap((stage) => [stage.id, ...stage.branches.map((branch) => branch.id)]));
}

function uniqueId(prefix: string, ids: Set<string>): string {
  let index = ids.size + 1;
  while (ids.has(`${prefix}-${index}`)) index += 1;
  return `${prefix}-${index}`;
}
