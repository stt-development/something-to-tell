/**
 * Frontend mirror of the runtime-owned Phase 3.5 dialogue schema.
 * Keep this module aligned with services/runtime/stt_runtime/schemas/dialogue.py
 * until generated shared contracts replace the documented mirror.
 */
export interface DialogueLineElement {
  id: string;
  kind: "line";
  speaker_node_id: string;
  text: string;
  next_element_id: string | null;
}

export interface DialogueChoiceOption {
  id: string;
  text: string;
  condition: string;
  next_element_id: string | null;
}

export interface DialogueChoiceElement {
  id: string;
  kind: "choice";
  prompt: string;
  options: DialogueChoiceOption[];
}

export type DialogueElement = DialogueLineElement | DialogueChoiceElement;

export interface DialogueDocument {
  dialogue_version: 1;
  entry_element_id: string | null;
  participants: string[];
  elements: DialogueElement[];
}

export interface DialogueValidationIssue {
  code: "duplicate_id" | "duplicate_participant" | "empty_text" | "invalid_entry" | "invalid_next" | "invalid_speaker";
  message: string;
  path: string;
}

export function createEmptyDialogueDocument(): DialogueDocument {
  return { dialogue_version: 1, elements: [], entry_element_id: null, participants: [] };
}

/** Validates cross-reference invariants that TypeScript types cannot express. */
export function validateDialogueDocument(document: DialogueDocument): DialogueValidationIssue[] {
  const issues: DialogueValidationIssue[] = [];
  const participantIds = new Set<string>();
  document.participants.forEach((participantId, index) => {
    if (participantIds.has(participantId)) {
      issues.push(issue("duplicate_participant", `Duplicate dialogue participant: ${participantId}`, `participants.${index}`));
    }
    participantIds.add(participantId);
  });

  const elementIds = new Set(document.elements.map((element) => element.id));
  const originIds = new Set<string>();
  document.elements.forEach((element, elementIndex) => {
    addOriginId(element.id, `elements.${elementIndex}.id`, originIds, issues);
    if (element.kind === "line") {
      if (!element.text.trim()) {
        issues.push(issue("empty_text", "Dialogue lines require text.", `elements.${elementIndex}.text`));
      }
      if (!participantIds.has(element.speaker_node_id)) {
        issues.push(issue("invalid_speaker", `Line speaker is not a participant: ${element.speaker_node_id}`, `elements.${elementIndex}.speaker_node_id`));
      }
      validateNext(element.next_element_id, `elements.${elementIndex}.next_element_id`, elementIds, issues);
      return;
    }
    element.options.forEach((option, optionIndex) => {
      if (!option.text.trim()) {
        issues.push(issue("empty_text", "Dialogue answers require text.", `elements.${elementIndex}.options.${optionIndex}.text`));
      }
      addOriginId(option.id, `elements.${elementIndex}.options.${optionIndex}.id`, originIds, issues);
      validateNext(option.next_element_id, `elements.${elementIndex}.options.${optionIndex}.next_element_id`, elementIds, issues);
    });
  });

  if ((document.elements.length === 0 && document.entry_element_id !== null) ||
      (document.elements.length > 0 && (document.entry_element_id === null || !elementIds.has(document.entry_element_id)))) {
    issues.push(issue("invalid_entry", "Dialogue entry element must reference an existing element.", "entry_element_id"));
  }
  return issues;
}

function addOriginId(id: string, path: string, ids: Set<string>, issues: DialogueValidationIssue[]) {
  if (ids.has(id)) {
    issues.push(issue("duplicate_id", `Duplicate dialogue element or option id: ${id}`, path));
  }
  ids.add(id);
}

function validateNext(nextId: string | null, path: string, elementIds: Set<string>, issues: DialogueValidationIssue[]) {
  if (nextId !== null && !elementIds.has(nextId)) {
    issues.push(issue("invalid_next", `Dialogue next element does not exist: ${nextId}`, path));
  }
}

function issue(code: DialogueValidationIssue["code"], message: string, path: string): DialogueValidationIssue {
  return { code, message, path };
}
