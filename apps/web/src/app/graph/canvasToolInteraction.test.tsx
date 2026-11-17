import { fireEvent, render, screen } from "@testing-library/react";
import { expect, it, vi } from "vitest";
import { blockHandNodeArrow, STABLE_TOOL_INTERACTION_EXPERIMENT_ENABLED } from "./canvasToolInteraction";

it("enables the author-approved stable interaction release default", () => {
  expect(STABLE_TOOL_INTERACTION_EXPERIMENT_ENABLED).toBe(true);
});

it("suppresses graph arrows, not existing Escape/Space owners or editable controls", () => {
  const bubble = vi.fn();
  render(<div onKeyDown={bubble}><div onKeyDownCapture={blockHandNodeArrow}>
    <div className="react-flow__node"><span data-testid="label">Node</span>
      <input aria-label="Draft" /><div contentEditable suppressContentEditableWarning><span data-testid="editable">Draft</span></div></div>
    <button>Control</button>
  </div></div>);
  for (const key of ["ArrowUp", "ArrowDown", "ArrowLeft", "ArrowRight"]) {
    expect(fireEvent.keyDown(screen.getByTestId("label"), { key })).toBe(false);
  }
  expect(bubble).not.toHaveBeenCalled();
  for (const key of ["Escape", " ", "Enter", "Delete", "Backspace", "Tab"]) {
    fireEvent.keyDown(screen.getByTestId("label"), { key });
  }
  for (const target of [screen.getByLabelText("Draft"), screen.getByTestId("editable"), screen.getByText("Control")]) {
    expect(fireEvent.keyDown(target, { key: "ArrowRight" })).toBe(true);
  }
  expect(bubble).toHaveBeenCalledTimes(9);
});
