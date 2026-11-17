import type { Edge, Node } from "@xyflow/react";
import type { DialogueChoiceOption, DialogueDocument, DialogueElement } from "../../dialogue/contracts";
import type { NarrativeEdgeData, NarrativeIssue, NarrativeNodeData } from "../../types";

/** View-only first-match indices; malformed duplicate ids retain Array.find semantics. */
export function indexPersistedDialogue(document: DialogueDocument) {
  const elements = new Map<string, { element: DialogueElement; options: ReadonlyMap<string, DialogueChoiceOption> }>();
  for (const element of document.elements) {
    const id = element.id;
    if (elements.has(id)) continue;
    const options = new Map<string, DialogueChoiceOption>();
    if (element.kind === "choice") for (const option of element.options) {
      const optionId = option.id;
      if (!options.has(optionId)) options.set(optionId, option);
    }
    elements.set(id, { element, options });
  }
  return elements;
}

export function indexDialogueCharacters(characters: Node<NarrativeNodeData>[]) {
  const result = new Map<string, Node<NarrativeNodeData>>();
  for (const character of characters) {
    const id = character.id;
    if (!result.has(id)) result.set(id, character);
  }
  return result;
}

/** Bucket append retains the exact source order used by outcome rendering/deletion. */
export function indexDialogueTransitions(transitions: Edge<NarrativeEdgeData>[]) {
  const result = new Map<string, Edge<NarrativeEdgeData>[]>();
  for (const transition of transitions) {
    const origin = transition.data?.dialogueElementId;
    if (origin === undefined) continue;
    const bucket = result.get(origin);
    if (bucket) bucket.push(transition); else result.set(origin, [transition]);
  }
  return result;
}

export function indexDialogueIssues(issues: NarrativeIssue[]) {
  const result = new Map<string, NarrativeIssue[]>();
  for (const issue of issues) for (const owner of new Set(issue.dialogueOwnerIds)) {
    const bucket = result.get(owner);
    if (bucket) bucket.push(issue); else result.set(owner, [issue]);
  }
  return result;
}
