import { act, fireEvent, render } from "@testing-library/react";
import { beforeEach, afterEach, expect, it, vi } from "vitest";
import type { QuestStage } from "../../quest/contracts";
import { applyProjectLocale, tr } from "../../localization/i18n";
import { createQuestStageTargets, QuestStageTargets, QuestStageTargetSelect } from "./QuestStageTargetSelect";

const stages = (count: number): QuestStage[] => Array.from({ length: count }, (_, i) => ({ id: `stage-${i}`, title: `Stage ${i}`, description: "Description", branches: [] }));
beforeEach(async () => { await applyProjectLocale("en"); });
afterEach(async () => { await applyProjectLocale("en"); });

it("keeps small stage order, External outcome and owning-stage exclusion", () => {
  const source = stages(3), changed = vi.fn();
  const view = render(<QuestStageTargetSelect stages={source} ownerId="stage-1" value="stage-2" onChange={changed} />);
  const select = view.getByRole("combobox", { name: "Internal target" });
  expect([...select.querySelectorAll("option")].map((option) => option.value)).toEqual(["", "stage-0", "stage-2"]);
  expect(select).toHaveValue("stage-2"); fireEvent.change(select, { target: { value: "" } }); expect(changed).toHaveBeenCalledWith(null);
});

it("materializes every eligible long target before native pointer bubbling and keyboard focus", () => {
  const observed = vi.fn(), changed = vi.fn();
  const view = render(<div onPointerDown={(event) => observed((event.target as HTMLSelectElement).options.length)}>
    <QuestStageTargetSelect stages={stages(100)} ownerId="stage-0" value="stage-99" onChange={changed} />
  </div>);
  const select = view.getByRole("combobox", { name: "Internal target" });
  expect(select.querySelectorAll("option")).toHaveLength(2); fireEvent.pointerDown(select); expect(observed).toHaveBeenCalledWith(100);
  expect(select.querySelector('option[value="stage-0"]')).toBeNull();
  fireEvent.change(select, { target: { value: "stage-98" } }); expect(changed).toHaveBeenCalledWith("stage-98");
  fireEvent.blur(select); expect(select.querySelectorAll("option")).toHaveLength(2);
  act(() => select.focus()); expect(select).toHaveFocus(); expect(select.querySelectorAll("option")).toHaveLength(100);
});

it("uses current reordered/replaced titles and locale while preserving select identity/focus", async () => {
  const source = stages(100), props = { ownerId: "stage-0", value: "stage-99", onChange: vi.fn() };
  const view = render(<QuestStageTargets stages={source}><QuestStageTargetSelect {...props} stages={source} /></QuestStageTargets>);
  const select = view.getByRole("combobox", { name: "Internal target" }); act(() => select.focus());
  const replacement = source.map((stage) => stage.id === "stage-99" ? { ...stage, title: "Renamed stage" } : stage).reverse();
  view.rerender(<QuestStageTargets stages={replacement}><QuestStageTargetSelect {...props} stages={replacement} /></QuestStageTargets>);
  expect(select.querySelectorAll("option")[1]).toHaveTextContent("Renamed stage"); expect(select).toHaveFocus();
  await act(async () => { await applyProjectLocale("ru"); });
  expect(view.getByRole("combobox", { name: tr("quest.internalTarget") })).toBe(select);
  fireEvent.blur(select); expect(select).toHaveValue("stage-99"); expect(select.querySelectorAll("option")).toHaveLength(2);
  expect(select.querySelectorAll("option")[1]).toHaveTextContent("Renamed stage");
});

it("does not silently repair a missing or self target and handles empty/shrinking input", () => {
  const changed = vi.fn(), source = stages(100);
  const view = render(<QuestStageTargetSelect stages={source} ownerId="stage-0" value="absent" onChange={changed} />);
  const select = view.getByRole("combobox", { name: "Internal target" });
  fireEvent.focus(select); fireEvent.blur(select); expect(changed).not.toHaveBeenCalled();
  view.rerender(<QuestStageTargetSelect stages={source} ownerId="stage-0" value="stage-0" onChange={changed} />);
  expect(select.querySelectorAll("option")).toHaveLength(1); expect(changed).not.toHaveBeenCalled();
  view.rerender(<QuestStageTargetSelect stages={[]} ownerId="stage-0" value={null} onChange={changed} />);
  expect(select.querySelectorAll("option")).toHaveLength(1); expect(select).toHaveValue("");
});

it("keeps first-match index identity and falls back when a context belongs to different stage input", () => {
  const source = stages(100), duplicate = { ...source[0]!, title: "Duplicate" };
  const index = createQuestStageTargets([...source, duplicate]); expect(index.byId.get("stage-0")).toBe(source[0]);
  const other = [{ ...source[99]!, title: "Other input" }]; Object.freeze(other);
  const view = render(<QuestStageTargets stages={source}><QuestStageTargetSelect stages={other} ownerId="stage-0" value="stage-99" onChange={vi.fn()} /></QuestStageTargets>);
  expect(view.getByRole("option", { name: "Other input" })).toHaveValue("stage-99");
  expect(createQuestStageTargets([]).byId.size).toBe(0);
});
