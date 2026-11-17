import { act, fireEvent, render, screen } from "@testing-library/react";
import type { ReactNode } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { CanvasFitControls, readCanvasFitPadding, useCanvasFitView } from "./CanvasFitControls";

const fit = vi.hoisted(() => vi.fn(async () => true));
vi.mock("@xyflow/react", () => ({
  useReactFlow: () => ({ fitView: fit }),
  Controls: ({ fitViewOptions }: { fitViewOptions: unknown }) => <output data-testid="padding">{JSON.stringify(fitViewOptions)}</output>
}));

describe("Fit command and native-controls padding adapter", () => {
  let resize: () => void, disconnect: ReturnType<typeof vi.fn>;
  let canvasWidth = 1024;
  beforeEach(() => {
    canvasWidth = 1024; fit.mockClear(); disconnect = vi.fn();
    vi.stubGlobal("ResizeObserver", class {
      constructor(callback: () => void) { resize = callback; }
      observe() {}
      disconnect = disconnect;
    });
    vi.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockImplementation(function (this: HTMLElement) {
      if (this.classList.contains("react-flow")) return { x: 0, y: 56, width: canvasWidth, height: 712 } as DOMRect;
      if (this.classList.contains("tool-rail")) return { x: 12, y: 72, width: 52, height: 600 } as DOMRect;
      if (this.classList.contains("react-flow__minimap")) return { x: canvasWidth - 216, y: 602, width: 200, height: 150 } as DOMRect;
      return { x: 0, y: 0, width: 0, height: 0 } as DOMRect;
    });
  });
  afterEach(() => { vi.restoreAllMocks(); vi.unstubAllGlobals(); });

  function Command({ exact = false, virtualized = false }: { exact?: boolean; virtualized?: boolean }) {
    const fitView = useCanvasFitView(virtualized);
    return <button onClick={() => void fitView({ duration: 260, padding: 0, ...(exact ? { minZoom: 1.05, maxZoom: 1.05 } : {}) })}>Fit</button>;
  }
  function Workspace({ children }: { children: ReactNode }) {
    return <div className="workspace-stage"><div className="tool-rail" /><div className="react-flow"><div className="react-flow__minimap" />{children}</div></div>;
  }

  it("reads current mounted overlays at command time while retaining other Fit options", () => {
    render(<Workspace><Command /></Workspace>);
    canvasWidth = 1440;
    fireEvent.click(screen.getByRole("button"));
    expect(fit).toHaveBeenCalledWith({ duration: 260, padding: { left: "76px", right: "0px", top: "0px", bottom: "178px" } });
  });

  it("preserves fixed-zoom navigation and missing-canvas fallbacks", () => {
    const view = render(<Workspace><Command exact /></Workspace>);
    fireEvent.click(screen.getByRole("button"));
    expect(fit).toHaveBeenCalledWith({ duration: 260, padding: 0, minZoom: 1.05, maxZoom: 1.05 });
    view.unmount(); expect(readCanvasFitPadding(0.2)).toBe(0.2);
  });

  it("updates only the controls' padding on resize and disconnects observation", () => {
    const view = render(<Workspace><CanvasFitControls /></Workspace>);
    const before = screen.getByTestId("padding").textContent;
    canvasWidth = 1440; act(() => resize());
    expect(screen.getByTestId("padding").textContent).not.toBe(before);
    expect(fit).not.toHaveBeenCalled();
    view.unmount(); expect(disconnect).toHaveBeenCalledOnce();
  });

  it("includes the complete projection only when the DOM experiment requests it", () => {
    render(<Workspace><Command virtualized /></Workspace>);
    fireEvent.click(screen.getByRole("button"));
    expect(fit).toHaveBeenCalledWith(expect.objectContaining({ includeHiddenNodes: true, duration: 260 }));
  });
});
