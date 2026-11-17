import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { ViewportTooltip, fittingSide } from "./ViewportTooltip";

function rect(left: number, top: number, width: number, height: number): DOMRect {
  return { bottom: top + height, height, left, right: left + width, top, width, x: left, y: top, toJSON: () => ({}) };
}

describe("ViewportTooltip", () => {
  it("shows delegated tooltip content immediately for pointer and keyboard focus", () => {
    render(
      <>
        <button data-tooltip="Open project settings">Settings</button>
        <ViewportTooltip />
      </>
    );
    const button = screen.getByRole("button", { name: "Settings" });

    fireEvent.pointerOver(button);
    expect(screen.getByRole("tooltip")).toHaveTextContent("Open project settings");
    fireEvent.pointerOut(button);
    expect(screen.queryByRole("tooltip")).not.toBeInTheDocument();
    fireEvent.focusIn(button);
    expect(screen.getByRole("tooltip")).toBeInTheDocument();
  });

  it("uses the same viewport layer for diagnostic data-preview content", () => {
    render(
      <>
        <span data-preview="Two unresolved issues" tabIndex={0}>2</span>
        <ViewportTooltip />
      </>
    );

    fireEvent.focusIn(screen.getByText("2"));
    expect(screen.getByRole("tooltip")).toHaveTextContent("Two unresolved issues");
  });

  it("flips preferred directions toward available viewport space", () => {
    const tooltip = rect(0, 0, 120, 32);

    expect(fittingSide("top", rect(120, 2, 24, 24), tooltip, 320, 200)).toBe("bottom");
    expect(fittingSide("right", rect(292, 80, 24, 24), tooltip, 320, 200)).toBe("left");
    expect(fittingSide("bottom", rect(120, 80, 24, 24), tooltip, 320, 200)).toBe("bottom");
  });
});
