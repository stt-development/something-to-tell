import type { Edge, Node } from "@xyflow/react";
import { expect, it } from "vitest";
import type { DialogueDocument } from "../../dialogue/contracts";
import type { NarrativeEdgeData, NarrativeIssue, NarrativeNodeData } from "../../types";
import { indexDialogueCharacters, indexDialogueIssues, indexDialogueTransitions, indexPersistedDialogue } from "./dialogueEditorLookups";

it("preserves first persisted element/option identity even for malformed duplicate ids", () => {
  const line = { id: "line", kind: "line" as const, text: "First", speaker_node_id: "actor", next_element_id: null };
  const choice = { id: "choice", kind: "choice" as const, prompt: "Question", options: [
    { id: "answer", text: "First", condition: "", next_element_id: null }, { id: "answer", text: "Duplicate", condition: "", next_element_id: null }] };
  const document: DialogueDocument = { dialogue_version: 1, entry_element_id: line.id, participants: ["actor"],
    elements: [line, choice, { ...line, text: "Duplicate" }, { ...choice, options: [] }] };
  const index = indexPersistedDialogue(document);
  for (const element of document.elements) expect(index.get(element.id)?.element).toBe(document.elements.find((row) => row.id === element.id));
  expect(index.get("choice")?.options.get("answer")).toBe(choice.options.find((row) => row.id === "answer"));
  expect(index.get("line")?.options.size).toBe(0); expect(index.get("missing")).toBeUndefined();
  expect(indexPersistedDialogue({ ...document, elements: [] }).size).toBe(0);
});

it("preserves character first-match identity and reads each id once for 10000 inputs", () => {
  let reads = 0;
  const characters = Array.from({ length: 10000 }, (_, i) => ({
    get id() { reads++; return String(i); }, position: { x: 0, y: 0 },
    data: { kind: "Character", title: String(i), label: String(i), summary: "", tags: [] } as NarrativeNodeData
  }));
  const index = indexDialogueCharacters(characters); expect(reads).toBe(10000);
  const duplicate: Node<NarrativeNodeData> = { ...characters[0]!, data: { ...characters[0]!.data, title: "Other" } };
  expect(indexDialogueCharacters([...characters, duplicate]).get("0")).toBe(characters[0]);
  expect(index.size).toBe(10000); expect(index.get("9999")).toBe(characters[9999]);
});

it("keeps exact transition filter order/identity, including empty origins and absent data", () => {
  const edges: Edge<NarrativeEdgeData>[] = Array.from({ length: 100 }, (_, i) => ({ id: String(i), source: "dialogue", target: "event",
    data: i % 7 ? { dialogueElementId: i % 3 ? "line" : "" } as NarrativeEdgeData : undefined }));
  const index = indexDialogueTransitions(edges);
  for (const origin of ["line", "", "missing"]) {
    const actual = index.get(origin) ?? [], expected = edges.filter((edge) => edge.data?.dialogueElementId === origin);
    expect(actual).toEqual(expected); actual.forEach((edge, i) => expect(edge).toBe(expected[i]));
  }
  expect(indexDialogueTransitions([]).size).toBe(0);
});

it("matches issue filtering without duplicating repeated owner ids or losing multi-owner order", () => {
  const issues: NarrativeIssue[] = Array.from({ length: 100 }, (_, i) => ({ id: String(i), projectId: "project", title: "Issue", description: "Fix",
    severity: "warning", status: "open", dialogueOwnerIds: i % 5 ? ["line", "line", ...(i % 2 ? ["answer"] : [])] : undefined }));
  const index = indexDialogueIssues(issues);
  for (const owner of ["line", "answer", "missing"]) expect(index.get(owner) ?? []).toEqual(issues.filter((issue) => issue.dialogueOwnerIds?.includes(owner)));
  expect(indexDialogueIssues([]).size).toBe(0);
  expect(indexDialogueIssues([issues[1]!, issues[1]!]).get("line")).toHaveLength(2);
});

it("does not mutate input collections or frozen nested records", () => {
  const document: DialogueDocument = { dialogue_version: 1, entry_element_id: null, participants: [], elements: [] };
  Object.freeze(document.elements); Object.freeze(document);
  const transitions: Edge<NarrativeEdgeData>[] = []; Object.freeze(transitions);
  const issues: NarrativeIssue[] = []; Object.freeze(issues);
  expect(indexPersistedDialogue(document).size).toBe(0);
  expect(indexDialogueTransitions(transitions).size).toBe(0); expect(indexDialogueIssues(issues).size).toBe(0);
});
