import { useEffect, useRef } from "react";
import { createDecorativeGraph, type DecorativeGraph, type DecorativeGraphNode } from "./decorativeGraph";

const GRAPH = createDecorativeGraph();
const SCROLL_PIXELS_PER_SECOND = 7;
const STATIC_OFFSET = GRAPH.worldWidth * 0.18;

const NODE_COLORS: Record<DecorativeGraphNode["kind"], string> = {
  character: "#2563eb",
  dialogue: "#7c3aed",
  event: "#dc2626",
  item: "#ca8a04",
  location: "#059669",
  quest: "#ea580c",
  scene: "#0891b2"
};

/** Draws a project-free startup visual without React state, input handling, or runtime dependencies. */
export function DecorativeGraphBackground() {
  const canvasRef = useRef<HTMLCanvasElement | null>(null);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    let context: CanvasRenderingContext2D | null = null;
    try {
      context = canvas.getContext("2d");
    } catch {
      return;
    }
    if (!context) return;

    const reducedMotion = window.matchMedia?.("(prefers-reduced-motion: reduce)").matches ?? false;
    let animationFrame = 0;
    let startedAt: number | null = null;
    let stopped = false;

    const resizeAndDraw = () => {
      const bounds = canvas.getBoundingClientRect();
      const ratio = Math.min(window.devicePixelRatio || 1, 2);
      canvas.width = Math.max(1, Math.round(bounds.width * ratio));
      canvas.height = Math.max(1, Math.round(bounds.height * ratio));
      context.setTransform(ratio, 0, 0, ratio, 0, 0);
      drawDecorativeGraph(context, GRAPH, bounds.width, bounds.height, reducedMotion ? STATIC_OFFSET : 0);
    };

    const animate = (timestamp: number) => {
      if (stopped) return;
      startedAt ??= timestamp;
      const bounds = canvas.getBoundingClientRect();
      const offset = (((timestamp - startedAt) / 1000) * SCROLL_PIXELS_PER_SECOND) % GRAPH.worldWidth;
      drawDecorativeGraph(context, GRAPH, bounds.width, bounds.height, offset);
      animationFrame = window.requestAnimationFrame(animate);
    };

    resizeAndDraw();
    const observer = typeof ResizeObserver === "function" ? new ResizeObserver(resizeAndDraw) : null;
    observer?.observe(canvas);
    if (!observer) window.addEventListener("resize", resizeAndDraw);
    if (!reducedMotion && typeof window.requestAnimationFrame === "function") {
      animationFrame = window.requestAnimationFrame(animate);
    }

    return () => {
      stopped = true;
      observer?.disconnect();
      if (!observer) window.removeEventListener("resize", resizeAndDraw);
      if (animationFrame && typeof window.cancelAnimationFrame === "function") window.cancelAnimationFrame(animationFrame);
    };
  }, []);

  return <canvas aria-hidden="true" className="clean-start-graph" data-testid="clean-start-graph" ref={canvasRef} />;
}

function drawDecorativeGraph(
  context: CanvasRenderingContext2D,
  graph: DecorativeGraph,
  viewportWidth: number,
  viewportHeight: number,
  offset: number
) {
  context.clearRect(0, 0, viewportWidth, viewportHeight);
  const verticalScale = Math.max(0.78, Math.min(1.08, viewportHeight / graph.worldHeight));
  const verticalOffset = (viewportHeight - graph.worldHeight * verticalScale) / 2;
  const firstCopy = -offset;
  for (let copyX = firstCopy - graph.worldWidth; copyX < viewportWidth + graph.worldWidth; copyX += graph.worldWidth) {
    drawGraphCopy(context, graph, copyX, verticalOffset, verticalScale);
  }
}

function drawGraphCopy(
  context: CanvasRenderingContext2D,
  graph: DecorativeGraph,
  offsetX: number,
  offsetY: number,
  verticalScale: number
) {
  const byId = new Map(graph.nodes.map((node) => [node.id, node]));
  context.save();
  context.translate(offsetX, offsetY);
  context.scale(1, verticalScale);

  for (const edge of graph.edges) {
    const source = byId.get(edge.source);
    const target = byId.get(edge.target);
    if (!source || !target) continue;
    const start = { x: source.x + source.width, y: source.y + source.height / 2 };
    const end = { x: target.x, y: target.y + target.height / 2 };
    context.beginPath();
    context.moveTo(start.x, start.y);
    context.bezierCurveTo(start.x + 70, start.y, end.x - 70, end.y, end.x, end.y);
    context.strokeStyle = edge.kind === "story" ? "#334155" : "#64748b";
    context.lineWidth = edge.kind === "story" ? 2.2 : 1.2;
    context.setLineDash(edge.kind === "story" ? [] : [5, 6]);
    context.stroke();
    if (edge.kind === "story") drawArrow(context, end.x, end.y);
  }
  context.setLineDash([]);

  for (const node of graph.nodes) drawDecorativeNode(context, node);
  context.restore();
}

function drawArrow(context: CanvasRenderingContext2D, x: number, y: number) {
  context.beginPath();
  context.moveTo(x, y);
  context.lineTo(x - 9, y - 5);
  context.lineTo(x - 9, y + 5);
  context.closePath();
  context.fillStyle = "#334155";
  context.fill();
}

function drawDecorativeNode(context: CanvasRenderingContext2D, node: DecorativeGraphNode) {
  context.fillStyle = "#ffffff";
  context.strokeStyle = "#94a3b8";
  context.lineWidth = 1;
  context.beginPath();
  context.roundRect(node.x, node.y, node.width, node.height, 6);
  context.fill();
  context.stroke();

  context.fillStyle = NODE_COLORS[node.kind];
  context.beginPath();
  context.roundRect(node.x, node.y, node.width, 12, [6, 6, 0, 0]);
  context.fill();

  context.fillStyle = "#cbd5e1";
  context.fillRect(node.x + 12, node.y + 24, node.width * 0.62, 4);
  context.fillStyle = "#e2e8f0";
  context.fillRect(node.x + 12, node.y + 35, node.width * 0.78, 3);
  if (node.height > 58) context.fillRect(node.x + 12, node.y + 45, node.width * 0.48, 3);
}
