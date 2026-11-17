import { render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { DecorativeGraphBackground } from "./DecorativeGraphBackground";

describe("DecorativeGraphBackground", () => {
  beforeEach(() => window.localStorage.clear());
  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  it("remains non-interactive and performs no runtime or storage work when canvas is unavailable", () => {
    const fetch = vi.fn();
    vi.stubGlobal("fetch", fetch);
    vi.spyOn(HTMLCanvasElement.prototype, "getContext").mockReturnValue(null);

    render(<DecorativeGraphBackground />);

    const canvas = screen.getByTestId("clean-start-graph");
    expect(canvas).toHaveAttribute("aria-hidden", "true");
    expect(fetch).not.toHaveBeenCalled();
    expect(window.localStorage).toHaveLength(0);
  });

  it("draws one static frame when animation APIs are unavailable", () => {
    const context = fakeCanvasContext();
    vi.spyOn(HTMLCanvasElement.prototype, "getContext").mockReturnValue(context);
    vi.stubGlobal("requestAnimationFrame", undefined);

    render(<DecorativeGraphBackground />);

    expect(context.clearRect).toHaveBeenCalledTimes(1);
    expect(context.roundRect).toHaveBeenCalled();
    expect(screen.getByTestId("clean-start-graph")).toBeInTheDocument();
  });
});

function fakeCanvasContext() {
  return {
    beginPath: vi.fn(),
    bezierCurveTo: vi.fn(),
    clearRect: vi.fn(),
    closePath: vi.fn(),
    fill: vi.fn(),
    fillRect: vi.fn(),
    lineTo: vi.fn(),
    moveTo: vi.fn(),
    restore: vi.fn(),
    roundRect: vi.fn(),
    save: vi.fn(),
    scale: vi.fn(),
    setLineDash: vi.fn(),
    setTransform: vi.fn(),
    stroke: vi.fn(),
    translate: vi.fn()
  } as unknown as CanvasRenderingContext2D;
}
