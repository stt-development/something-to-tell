import { ReactFlow, ReactFlowProvider, type ReactFlowInstance, type Node } from "@xyflow/react";
import { act, fireEvent, render, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { CanvasMiniMap } from "./CanvasMiniMap";
import { CanvasRenderingExperimentControl } from "../settings/CanvasRenderingExperimentControl";
import { MINIMAP_EXPERIMENT_KEY, setMiniMapExperimentEnabled } from "./canvasRenderingExperiment";
import { tr, i18next } from "../../localization/i18n";
import { CanvasDomSafetyContext } from "./CanvasDomSafety";

let paint = vi.fn();
beforeEach(() => {
  paint = vi.fn(); vi.spyOn(HTMLCanvasElement.prototype, "getContext").mockReturnValue({ setTransform: vi.fn(), clearRect: vi.fn(), fillRect: paint } as unknown as CanvasRenderingContext2D);
});
afterEach(async () => { vi.restoreAllMocks(); act(() => setMiniMapExperimentEnabled(false)); await i18next.changeLanguage("en"); });
const nodes: Node[] = [{ id: "near", position: { x: -500, y: -200 }, width: 200, height: 100, data: { label: "Near" } },
  { id: "far", position: { x: 10000, y: 5000 }, width: 500, height: 300, data: { label: "Far" } }];
function setup(input: Node[] = nodes, reportMiniMapReady?: (ready: boolean) => void) {
  let instance: ReactFlowInstance | undefined;
  const rendered = render(<ReactFlowProvider initialWidth={1024} initialHeight={768}>
    <CanvasRenderingExperimentControl />
    <ReactFlow width={1024} height={768} defaultNodes={input} minZoom={0.01} maxZoom={10} onInit={(api) => { instance = api; }}>
      <CanvasDomSafetyContext.Provider value={reportMiniMapReady ? { reportMiniMapReady } : null}>
        <CanvasMiniMap />
      </CanvasDomSafetyContext.Provider>
    </ReactFlow>
  </ReactFlowProvider>);
  return { ...rendered, api: () => instance! };
}
it("toggles only MiniMap, paints <=512 cells and pan updates no raster work or node data", async () => {
  act(() => setMiniMapExperimentEnabled(true));
  const view = setup();
  await waitFor(() => expect(view.container.querySelector(".bounded-minimap-surface")).not.toBeNull());
  const surface = view.getByRole("group", { name: "Graph overview: 2 visual nodes" });
  expect(surface).toHaveAttribute("data-minimap-nodes", "2"); expect(Number(surface.getAttribute("data-minimap-cells"))).toBeLessThanOrEqual(512);
  expect(view.container.querySelectorAll(".react-flow__minimap-node")).toHaveLength(0);
  expect(view.container.querySelectorAll(".bounded-minimap canvas")).toHaveLength(1);
  const previous = structuredClone(view.api().getNodes()), calls = paint.mock.calls.length;
  await act(async () => { await view.api().setViewport({ x: -333, y: 222, zoom: 0.5 }); });
  expect(paint).toHaveBeenCalledTimes(calls); expect(view.api().getNodes()).toEqual(previous);
  const viewport = view.api().getViewport(); fireEvent.keyDown(surface, { key: "ArrowRight" });
  // Shared jsdom ResizeObserver supplies a 500px viewport, independent of CSS width.
  await waitFor(() => expect(view.api().getViewport().x).toBeCloseTo(viewport.x - 500 * 0.2));
  expect(paint).toHaveBeenCalledTimes(calls);
  fireEvent.click(view.getByRole("checkbox", { name: tr("canvasExperiment.minimap") }));
  expect(view.container.querySelector(".bounded-minimap")).toBeNull(); expect(localStorage.getItem(MINIMAP_EXPERIMENT_KEY)).toBe("false");
  expect(view.getByRole("checkbox", { name: tr("canvasExperiment.graphCards") })).toBeChecked();
  expect(view.getByRole("checkbox", { name: tr("canvasExperiment.nodeDetail") })).toBeChecked();
});
it("selection repaints the same cell budget, replacement releases old geometry, and locale updates accessible counts", async () => {
  act(() => setMiniMapExperimentEnabled(true)); const view = setup();
  await waitFor(() => expect(paint).toHaveBeenCalled());
  const painted = paint.mock.calls.length;
  fireEvent(window, new Event("resize")); expect(paint.mock.calls.length).toBe(painted * 2);
  const count = Number(view.container.querySelector("[data-minimap-cells]")!.getAttribute("data-minimap-cells"));
  await act(async () => { view.api().setNodes((current) => current.map((node) => ({ ...node, selected: true }))); });
  expect(Number(view.container.querySelector("[data-minimap-cells]")!.getAttribute("data-minimap-cells"))).toBe(count);
  await act(async () => { view.api().setNodes([nodes[0]!]); });
  expect(view.getByRole("group", { name: "Graph overview: 1 visual nodes" })).toHaveAttribute("data-minimap-nodes", "1");
  await act(async () => { await i18next.changeLanguage("ru"); });
  expect(view.getByRole("group", { name: "Обзор графа: 1 визуальных узлов" })).toBeVisible();
});
it("unknown geometry uses legacy MiniMap rather than silently removing the unknown node", async () => {
  act(() => setMiniMapExperimentEnabled(true));
  const view = setup([{ ...nodes[0]!, width: undefined }]);
  await waitFor(() => expect(view.container.querySelector(".react-flow__minimap-svg")).not.toBeNull());
  expect(view.container.querySelector(".bounded-minimap")).toBeNull(); expect(view.api().getNodes()).toHaveLength(1);
});

it.each([null, "throws"])("unavailable Canvas 2D (%s) keeps legacy overview and original nodes", async (mode) => {
  vi.mocked(HTMLCanvasElement.prototype.getContext).mockImplementation(() => { if (mode === "throws") throw Error("restricted"); return null; });
  act(() => setMiniMapExperimentEnabled(true)); const view = setup();
  await waitFor(() => expect(view.container.querySelector(".react-flow__minimap-svg")).not.toBeNull());
  expect(view.container.querySelector(".bounded-minimap")).toBeNull(); expect(view.api().getNodes()).toHaveLength(2);
});

it("reports an experimental safety hold before legacy/raster fallback can lose hidden overview records", async () => {
  act(() => setMiniMapExperimentEnabled(true));
  const report = vi.fn(), view = setup(nodes, report);
  await waitFor(() => expect(report.mock.calls.at(-1)).toEqual([true]));
  act(() => setMiniMapExperimentEnabled(false));
  await waitFor(() => expect(report.mock.calls.at(-1)).toEqual([false]));
  expect(view.api().getNodes()).toHaveLength(2);
});
