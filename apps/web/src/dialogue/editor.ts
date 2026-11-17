import type { DialogueChoiceElement, DialogueDocument, DialogueElement, DialogueLineElement } from "./contracts";

export type DialogueElementKind = DialogueElement["kind"];
export type DialogueMoveDirection = "down" | "up";

export interface DialogueDeletionImpact {
  incomingOrigins: string[];
  removesEntry: boolean;
}

/** Creates an element with an aggregate-local stable id and appends it. */
export function appendDialogueElement(
  document: DialogueDocument,
  kind: DialogueElementKind,
  speakerNodeId?: string
): DialogueDocument {
  const ids = dialogueOriginIds(document);
  const element = kind === "line"
    ? {
        id: uniqueDialogueId("line", ids),
        kind: "line" as const,
        next_element_id: null,
        speaker_node_id: speakerNodeId ?? document.participants[0] ?? "",
        text: ""
      }
    : {
        id: uniqueDialogueId("choice", ids),
        kind: "choice" as const,
        options: [],
        prompt: ""
      };

  return {
    ...document,
    elements: [...document.elements, element],
    entry_element_id: document.entry_element_id ?? element.id
  };
}

/** Duplicates authored content while assigning fresh element and option ids. */
export function duplicateDialogueElement(document: DialogueDocument, elementId: string): DialogueDocument {
  const index = document.elements.findIndex((element) => element.id === elementId);
  if (index < 0) {
    return document;
  }
  const ids = dialogueOriginIds(document);
  const source = document.elements[index]!;
  let duplicate: DialogueElement;
  if (source.kind === "line") {
    duplicate = { ...source, id: uniqueDialogueId("line", ids) };
  } else {
    const choiceId = uniqueDialogueId("choice", ids);
    duplicate = {
      ...source,
      id: choiceId,
      options: source.options.map((option) => {
        const id = uniqueDialogueId("answer", ids);
        ids.add(id);
        return { ...option, id };
      })
    };
  }
  const elements = [...document.elements];
  elements.splice(index + 1, 0, duplicate);
  return { ...document, elements };
}

/** Reorders presentation without rewriting stable branch references. */
export function moveDialogueElement(
  document: DialogueDocument,
  elementId: string,
  direction: DialogueMoveDirection
): DialogueDocument {
  const index = document.elements.findIndex((element) => element.id === elementId);
  const targetIndex = direction === "up" ? index - 1 : index + 1;
  if (index < 0 || targetIndex < 0 || targetIndex >= document.elements.length) {
    return document;
  }
  const elements = [...document.elements];
  const [element] = elements.splice(index, 1);
  elements.splice(targetIndex, 0, element!);
  return { ...document, elements };
}

/** Reports branches that must be detached before destructive confirmation. */
export function dialogueDeletionImpact(document: DialogueDocument, elementId: string): DialogueDeletionImpact {
  const incomingOrigins: string[] = [];
  for (const element of document.elements) {
    if (element.kind === "line" && element.next_element_id === elementId) {
      incomingOrigins.push(element.id);
    }
    if (element.kind === "choice") {
      for (const option of element.options) {
        if (option.next_element_id === elementId) {
          incomingOrigins.push(option.id);
        }
      }
    }
  }
  return { incomingOrigins, removesEntry: document.entry_element_id === elementId };
}

/** Deletes an element and converts every now-broken internal branch into an ending. */
export function deleteDialogueElement(document: DialogueDocument, elementId: string): DialogueDocument {
  const elements = document.elements
    .filter((element) => element.id !== elementId)
    .map((element): DialogueElement => {
      if (element.kind === "line") {
        return element.next_element_id === elementId ? { ...element, next_element_id: null } : element;
      }
      return {
        ...element,
        options: element.options.map((option) =>
          option.next_element_id === elementId ? { ...option, next_element_id: null } : option
        )
      };
    });
  return {
    ...document,
    elements,
    entry_element_id: document.entry_element_id === elementId ? elements[0]?.id ?? null : document.entry_element_id
  };
}

/** Adds a choice answer with an id unique across elements and answers. */
export function appendChoiceOption(document: DialogueDocument, choiceId: string): DialogueDocument {
  const ids = dialogueOriginIds(document);
  const optionId = uniqueDialogueId("answer", ids);
  return {
    ...document,
    elements: document.elements.map((element) =>
      element.kind === "choice" && element.id === choiceId
        ? { ...element, options: [...element.options, { condition: "", id: optionId, next_element_id: null, text: "" }] }
        : element
    )
  };
}

export function updateDialogueLine(
  document: DialogueDocument,
  lineId: string,
  updates: Partial<Omit<DialogueLineElement, "id" | "kind">>
): DialogueDocument {
  return updateElement(document, lineId, (element) => element.kind === "line" ? { ...element, ...updates } : element);
}

export function updateDialogueChoice(
  document: DialogueDocument,
  choiceId: string,
  updates: Partial<Omit<DialogueChoiceElement, "id" | "kind" | "options">>
): DialogueDocument {
  return updateElement(document, choiceId, (element) => element.kind === "choice" ? { ...element, ...updates } : element);
}

export function updateChoiceOption(
  document: DialogueDocument,
  choiceId: string,
  optionId: string,
  updates: { condition?: string; next_element_id?: string | null; text?: string }
): DialogueDocument {
  return updateElement(document, choiceId, (element) =>
    element.kind === "choice"
      ? { ...element, options: element.options.map((option) => option.id === optionId ? { ...option, ...updates } : option) }
      : element
  );
}

export function deleteChoiceOption(document: DialogueDocument, choiceId: string, optionId: string): DialogueDocument {
  return updateElement(document, choiceId, (element) =>
    element.kind === "choice"
      ? { ...element, options: element.options.filter((option) => option.id !== optionId) }
      : element
  );
}

function updateElement(
  document: DialogueDocument,
  elementId: string,
  update: (element: DialogueElement) => DialogueElement
): DialogueDocument {
  return { ...document, elements: document.elements.map((element) => element.id === elementId ? update(element) : element) };
}

function dialogueOriginIds(document: DialogueDocument): Set<string> {
  return new Set(document.elements.flatMap((element) =>
    element.kind === "choice" ? [element.id, ...element.options.map((option) => option.id)] : [element.id]
  ));
}

function uniqueDialogueId(prefix: string, ids: Set<string>): string {
  let sequence = 1;
  while (ids.has(`${prefix}-${sequence}`)) {
    sequence += 1;
  }
  return `${prefix}-${sequence}`;
}
