/** Frontend mirror of the runtime-owned Quest aggregate schema. */
export interface QuestBranch {
  id: string;
  label: string;
  condition: string;
  target_stage_id: string | null;
}

export interface QuestStage {
  id: string;
  title: string;
  description: string;
  branches: QuestBranch[];
}

export interface QuestDocument {
  quest_version: 1;
  objective: string;
  quest_giver_node_id: string | null;
  entry_stage_id: string | null;
  prerequisite_node_ids: string[];
  reward_node_ids: string[];
  stages: QuestStage[];
}

export interface QuestValidationIssue {
  code: "duplicate_id" | "duplicate_reference" | "empty_branch_label" | "empty_stage_title" | "invalid_entry" | "invalid_stage_target";
  message: string;
  path: string;
}

/** Lazily turns a generic Quest card into a valid one-stage aggregate. */
export function createQuestDocument(title: string, summary: string): QuestDocument {
  return {
    quest_version: 1,
    objective: summary || title,
    quest_giver_node_id: null,
    entry_stage_id: "stage-1",
    prerequisite_node_ids: [],
    reward_node_ids: [],
    stages: [{ id: "stage-1", title, description: summary, branches: [] }]
  };
}

/** Validates aggregate-local invariants before runtime-owned reference checks. */
export function validateQuestDocument(document: QuestDocument): QuestValidationIssue[] {
  const issues: QuestValidationIssue[] = [];
  uniqueReferences(document.prerequisite_node_ids, "prerequisite_node_ids", issues);
  uniqueReferences(document.reward_node_ids, "reward_node_ids", issues);

  const stageIds = new Set<string>();
  const branchIds = new Set<string>();
  document.stages.forEach((stage, stageIndex) => {
    addUniqueId(stage.id, `stages.${stageIndex}.id`, stageIds, issues);
    if (!stage.title.trim()) {
      issues.push(issue("empty_stage_title", "Quest stages require a title.", `stages.${stageIndex}.title`));
    }
    stage.branches.forEach((branch, branchIndex) => {
      addUniqueId(branch.id, `stages.${stageIndex}.branches.${branchIndex}.id`, branchIds, issues);
      if (!branch.label.trim()) {
        issues.push(issue("empty_branch_label", "Quest branches require a label.", `stages.${stageIndex}.branches.${branchIndex}.label`));
      }
    });
  });

  if ((document.stages.length === 0 && document.entry_stage_id !== null) ||
      (document.stages.length > 0 && (document.entry_stage_id === null || !stageIds.has(document.entry_stage_id)))) {
    issues.push(issue("invalid_entry", "Quest entry stage must reference an existing stage.", "entry_stage_id"));
  }
  document.stages.forEach((stage, stageIndex) => stage.branches.forEach((branch, branchIndex) => {
    if (branch.target_stage_id !== null && !stageIds.has(branch.target_stage_id)) {
      issues.push(issue("invalid_stage_target", `Quest branch target does not exist: ${branch.target_stage_id}`, `stages.${stageIndex}.branches.${branchIndex}.target_stage_id`));
    }
  }));
  return issues;
}

function uniqueReferences(values: string[], path: string, issues: QuestValidationIssue[]) {
  const seen = new Set<string>();
  values.forEach((value, index) => {
    if (seen.has(value)) issues.push(issue("duplicate_reference", `Duplicate Quest reference: ${value}`, `${path}.${index}`));
    seen.add(value);
  });
}

function addUniqueId(id: string, path: string, ids: Set<string>, issues: QuestValidationIssue[]) {
  if (ids.has(id)) issues.push(issue("duplicate_id", `Duplicate Quest id: ${id}`, path));
  ids.add(id);
}

function issue(code: QuestValidationIssue["code"], message: string, path: string): QuestValidationIssue {
  return { code, message, path };
}
