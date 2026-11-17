import type { ProjectSessionResponse } from "./projectSession";

/**
 * Shared mirror of the runtime-owned ProjectHistory transport contract.
 * Reversible patches remain private to the runtime; UI consumers receive only
 * bounded command metadata and the authoritative post-mutation project.
 */
export const PROJECT_HISTORY_VERSION = 1 as const;
export const PROJECT_HISTORY_CAPACITY = 10 as const;

export interface ProjectHistoryCommandRef {
  command_id: string;
  command_kind: string;
  label_key: string;
  label_parameters: Record<string, unknown>;
}

export interface ProjectHistorySummary {
  history_version: typeof PROJECT_HISTORY_VERSION;
  history_revision: number;
  capacity: typeof PROJECT_HISTORY_CAPACITY;
  undo_depth: number;
  redo_depth: number;
  next_undo: ProjectHistoryCommandRef | null;
  next_redo: ProjectHistoryCommandRef | null;
}

export interface ProjectHistoryMutation {
  expected_history_revision: number;
}

export interface ProjectHistoryMutationResponse<TDialogueDocument, TQuestDocument> {
  project: ProjectSessionResponse<TDialogueDocument, TQuestDocument>;
  history: ProjectHistorySummary;
}
