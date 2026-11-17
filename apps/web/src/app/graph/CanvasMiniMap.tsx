import { MiniMap, Panel, useNodes, useReactFlow, useStore } from "@xyflow/react";
import { memo, useCallback, useLayoutEffect, useMemo, useRef, useState, type PointerEvent, type KeyboardEvent } from "react";
import { useTranslation } from "react-i18next";
import { tr } from "../../localization/i18n";
import { useMiniMapExperimentEnabled } from "./canvasRenderingExperiment";
import { minimapOccupancy, minimapTransform, minimapViewport, minimapWorldPoint, type MiniMapOccupancy } from "./minimapOccupancy";
import { useReportDomMiniMapReady } from "./CanvasDomSafety";

// Independent release gate; explicit device preference remains authoritative.
export const BOUNDED_MINIMAP_ENABLED = true;
const WIDTH = 200, HEIGHT = 150;

/** Raster owner never subscribes to camera movement; pan updates only the SVG rectangle. */
const OccupancyRaster = memo(function OccupancyRaster({ model, onUnavailable }: { model: MiniMapOccupancy; onUnavailable: () => void }) {
  const canvas = useRef<HTMLCanvasElement>(null);
  useLayoutEffect(() => {
    const paint = () => {
      const element = canvas.current;
      let context: CanvasRenderingContext2D | null = null;
      try { context = element?.getContext("2d") ?? null; } catch { /* Restricted or exhausted WebView canvas uses legacy geometry. */ }
      if (!element || !context) { onUnavailable(); return; }
      const ratio = window.devicePixelRatio || 1;
      element.width = Math.ceil(WIDTH * ratio); element.height = Math.ceil(HEIGHT * ratio);
      context.setTransform(ratio, 0, 0, ratio, 0, 0); context.clearRect(0, 0, WIDTH, HEIGHT);
      const transform = minimapTransform(model.bounds, WIDTH, HEIGHT);
      const width = model.bounds.width / model.columns * transform.scale, height = model.bounds.height / model.rows * transform.scale;
      for (let index = 0; index < model.cells.length; index++) {
        const cell = model.cells[index]; if (!cell) continue;
        context.fillStyle = cell & 2 ? "#0f766e" : "#94a3b8";
        context.fillRect(transform.x + (model.bounds.x + index % model.columns * model.bounds.width / model.columns) * transform.scale,
          transform.y + (model.bounds.y + Math.floor(index / model.columns) * model.bounds.height / model.rows) * transform.scale, width, height);
      }
    };
    paint(); window.addEventListener("resize", paint);
    return () => window.removeEventListener("resize", paint);
  }, [model, onUnavailable]);
  return <canvas ref={canvas} width={WIDTH} height={HEIGHT} aria-hidden="true" />;
});

export function CanvasMiniMap() {
  const enabled = useMiniMapExperimentEnabled(BOUNDED_MINIMAP_ENABLED);
  return enabled ? <BoundedMiniMap /> : <LegacyMiniMap />;
}

function LegacyMiniMap() {
  useReportDomMiniMapReady(false);
  return <MiniMap pannable zoomable />;
}

/** Only public React Flow nodes/camera commands; no selection, history or authored writes. */
function BoundedMiniMap() {
  useTranslation();
  const nodes = useNodes();
  const origin = useStore((state) => state.nodeOrigin);
  const model = useMemo(() => minimapOccupancy(nodes, origin), [nodes, origin]);
  const [rasterUnavailable, setRasterUnavailable] = useState(false);
  const onUnavailable = useCallback(() => setRasterUnavailable(true), []);
  useReportDomMiniMapReady(Boolean(model && !rasterUnavailable));
  return model && !rasterUnavailable ? <MiniMapNavigator model={model} onUnavailable={onUnavailable} /> : <MiniMap pannable zoomable />;
}

function MiniMapNavigator({ model, onUnavailable }: { model: MiniMapOccupancy; onUnavailable: () => void }) {
  const transform = useStore((state) => state.transform);
  const width = useStore((state) => state.width), height = useStore((state) => state.height);
  const { setCenter, getViewport, setViewport } = useReactFlow();
  const mapping = useMemo(() => minimapTransform(model.bounds, WIDTH, HEIGHT), [model]);
  const camera = { x: transform[0], y: transform[1], zoom: transform[2] };
  const view = minimapViewport(mapping, camera, width, height);
  const activePointer = useRef<number | null>(null);
  useLayoutEffect(() => { activePointer.current = null; }, [model]);
  const navigate = (event: PointerEvent<HTMLDivElement>) => {
    const box = event.currentTarget.getBoundingClientRect();
    const point = minimapWorldPoint(mapping, { x: (event.clientX - box.x) * WIDTH / box.width, y: (event.clientY - box.y) * HEIGHT / box.height });
    if (model.nodeCount) void setCenter(point.x, point.y, { zoom: getViewport().zoom, duration: 0 });
  };
  const keyboard = (event: KeyboardEvent<HTMLDivElement>) => {
    const delta = ({ ArrowLeft: [1, 0], ArrowRight: [-1, 0], ArrowUp: [0, 1], ArrowDown: [0, -1] } as Record<string, number[]>)[event.key];
    if (!delta) return;
    event.preventDefault(); event.stopPropagation();
    const viewport = getViewport();
    void setViewport({ ...viewport, x: viewport.x + delta[0]! * width * 0.2, y: viewport.y + delta[1]! * height * 0.2 });
  };
  return <Panel position="bottom-right" className="react-flow__minimap bounded-minimap">
    <div className="bounded-minimap-surface nopan nodrag nowheel" role="group" tabIndex={0}
      aria-label={tr("canvasMiniMap.label", { count: model.nodeCount })}
      data-minimap-nodes={model.nodeCount} data-minimap-cells={model.occupiedCells}
      onKeyDown={keyboard}
      onPointerDown={(event) => { if (event.button !== 0) return; event.preventDefault(); event.stopPropagation();
        event.currentTarget.focus(); activePointer.current = event.pointerId; event.currentTarget.setPointerCapture(event.pointerId); navigate(event); }}
      onPointerMove={(event) => { if (activePointer.current === event.pointerId) { event.stopPropagation(); navigate(event); } }}
      onPointerUp={(event) => { if (activePointer.current === event.pointerId) { activePointer.current = null; event.currentTarget.releasePointerCapture(event.pointerId); } }}
      onPointerCancel={() => { activePointer.current = null; }} onLostPointerCapture={() => { activePointer.current = null; }}
      onWheel={(event) => {
        event.stopPropagation();
        const current = getViewport(), zoom = Math.min(10, Math.max(0.01, current.zoom * (event.deltaY < 0 ? 1.2 : 1 / 1.2)));
        void setCenter((width / 2 - current.x) / current.zoom, (height / 2 - current.y) / current.zoom, { zoom, duration: 0 });
      }}>
      <OccupancyRaster model={model} onUnavailable={onUnavailable} />
      <svg viewBox={`0 0 ${WIDTH} ${HEIGHT}`} aria-hidden="true" className="bounded-minimap-overlay">
        <rect className="bounded-minimap-viewport" x={view.x} y={view.y} width={view.width} height={view.height} />
      </svg>
    </div>
  </Panel>;
}
