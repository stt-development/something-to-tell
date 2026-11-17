import type { DialogueDocument } from "./contracts";

export interface DialogueCanvasMetrics {
  choices: number;
  endings: number;
  lines: number;
  participants: number;
}

/** Derives compact canvas facts without persisting presentation-only state. */
export function dialogueCanvasMetrics(
  document: DialogueDocument | undefined,
  externalOriginIds: Iterable<string> = []
): DialogueCanvasMetrics {
  if (!document) {
    return { choices: 0, endings: 0, lines: 0, participants: 0 };
  }
  const externalOrigins = new Set(externalOriginIds);
  let choices = 0;
  let endings = 0;
  let lines = 0;

  for (const element of document.elements) {
    if (element.kind === "line") {
      lines += 1;
      if (element.next_element_id === null && !externalOrigins.has(element.id)) {
        endings += 1;
      }
      continue;
    }
    choices += 1;
    endings += element.options.filter((option) =>
      option.next_element_id === null && !externalOrigins.has(option.id)
    ).length;
  }

  return { choices, endings, lines, participants: document.participants.length };
}
