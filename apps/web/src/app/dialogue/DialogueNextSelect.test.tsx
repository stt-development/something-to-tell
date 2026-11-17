import { act, fireEvent, render } from "@testing-library/react";
import { useState } from "react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import type { DialogueDocument } from "../../dialogue/contracts";
import { applyProjectLocale } from "../../localization/i18n";
import { createDialogueNextTargets, DialogueNextSelect, DialogueNextTargets, dialogueElementSummary } from "./DialogueNextSelect";

const document = (count: number): DialogueDocument => ({ dialogue_version: 1, participants: ["actor"], entry_element_id: "line-0",
  elements: Array.from({ length: count }, (_, i) => ({ id: `line-${i}`, kind: "line", text: `Line ${i}`, speaker_node_id: "actor", next_element_id: null })) });
beforeEach(async () => { await applyProjectLocale("en"); });
afterEach(async () => { await applyProjectLocale("en"); });

it("keeps complete small native lists including the 80-target boundary", () => {
  const props = { document: document(80), label: "Next", onChange: vi.fn(), value: null };
  const view = render(<DialogueNextSelect {...props} />), select = view.getByRole("combobox", { name: "Next" });
  expect(select.querySelectorAll("option")).toHaveLength(81);
  fireEvent.focus(select); fireEvent.blur(select); expect(select.querySelectorAll("option")).toHaveLength(81);
  expect(props.onChange).not.toHaveBeenCalled();
});

it("materializes full ordered targets before pointer bubbling or first keyboard input", () => {
  const doc = document(100), observed = vi.fn();
  const view = render(<div onPointerDown={(event) => observed((event.target as HTMLSelectElement).options.length)}>
    <DialogueNextSelect document={doc} label="Next" value="line-99" onChange={vi.fn()} />
  </div>);
  const select = view.getByRole("combobox", { name: "Next" }); expect(select.querySelectorAll("option")).toHaveLength(2);
  fireEvent.pointerDown(select); expect(observed).toHaveBeenCalledWith(101);
  expect([...select.querySelectorAll("option")].map((option) => option.value)).toEqual(["", ...doc.elements.map((element) => element.id)]);
  fireEvent.blur(select); expect(select).toHaveValue("line-99"); expect(select.querySelectorAll("option")).toHaveLength(2);
  fireEvent.keyDown(select, { key: "ArrowDown" }); expect(select.querySelectorAll("option")).toHaveLength(101);
});

it("supports focused distant selection and End without changing value during expand/blur", () => {
  const changed = vi.fn(), doc = document(100);
  function Editor() {
    const [value, setValue] = useState<string | null>(null);
    return <DialogueNextSelect document={doc} label="Next" value={value} onChange={(next) => { changed(next); setValue(next); }} />;
  }
  const view = render(<Editor />), select = view.getByRole("combobox", { name: "Next" });
  expect(select.querySelectorAll("option")).toHaveLength(1);
  act(() => select.focus()); expect(select).toHaveFocus(); expect(select.querySelectorAll("option")).toHaveLength(101);
  expect(changed).not.toHaveBeenCalled();
  fireEvent.change(select, { target: { value: "line-99" } }); fireEvent.blur(select);
  expect(changed).toHaveBeenCalledWith("line-99"); expect(select).toHaveValue("line-99");
  fireEvent.focus(select); fireEvent.change(select, { target: { value: "" } }); fireEvent.blur(select);
  expect(changed).toHaveBeenLastCalledWith(null); expect(select).toHaveValue(""); expect(select.querySelectorAll("option")).toHaveLength(1);
});

it("shares one bounded source summary pass across 100 inactive controls", () => {
  let reads = 0;
  const doc = document(100);
  doc.elements = doc.elements.map((element, i) => ({ ...element, get text() { reads++; return `Line ${i}`; } }));
  const controls = Array.from({ length: 100 }, (_, i) => <DialogueNextSelect key={i} document={doc} label={`Next ${i}`} value="line-99" onChange={vi.fn()} />);
  const view = render(<DialogueNextTargets document={doc}>{controls}</DialogueNextTargets>);
  expect(reads).toBe(100); expect(view.container.querySelectorAll("option")).toHaveLength(200);
  view.rerender(<DialogueNextTargets document={{ ...doc }}>{controls}</DialogueNextTargets>); expect(reads).toBe(100);
});

it("observes replacement/reordered targets and locale without losing the select or focus", async () => {
  const doc = document(100), props = { document: doc, label: "Next", value: "line-99", onChange: vi.fn() };
  const view = render(<DialogueNextSelect {...props} />), select = view.getByRole("combobox", { name: "Next" });
  act(() => select.focus());
  const replacement = { ...doc, elements: [...doc.elements].reverse().map((element) => element.id === "line-99" ? { ...element, text: "Renamed" } : element) };
  view.rerender(<DialogueNextSelect {...props} document={replacement} />);
  expect(view.getByRole("combobox", { name: "Next" })).toBe(select); expect(select).toHaveFocus();
  expect(select.querySelectorAll("option")[1]).toHaveTextContent("1. Line: Renamed");
  await act(async () => { await applyProjectLocale("ru"); });
  expect(select.querySelectorAll("option")[1]).not.toHaveTextContent("Line:"); expect(select).toHaveValue("line-99");
  fireEvent.blur(select); expect(select.querySelectorAll("option")).toHaveLength(2);
  expect(select.querySelectorAll("option")[1]).toHaveTextContent("Renamed");
});

it("retains first-match duplicate behavior, source immutability and existing summary rules", () => {
  const doc = document(2), first = doc.elements[0]!;
  if (first.kind !== "line") throw new Error("Expected line fixture");
  doc.elements.push({ ...first, text: "Duplicate" }); Object.freeze(doc.elements);
  const targets = createDialogueNextTargets(doc.elements);
  expect(targets.ordered).toHaveLength(3); expect(targets.byId.get("line-0")?.summary).toBe("Line 0");
  expect(dialogueElementSummary({ ...first, text: " ".repeat(20) })).toBe(first.id);
  expect(dialogueElementSummary({ ...first, text: "a".repeat(60) })).toHaveLength(48);
  expect(createDialogueNextTargets([]).ordered).toEqual([]);
});
