import { Position, getBezierPath, getSmoothStepPath, type Edge, type EdgeProps } from "@xyflow/react";
import { render, screen } from "@testing-library/react";
import type { ReactNode } from "react";
import { afterEach, expect, it, vi } from "vitest";
import * as flow from "../../story-flow/workspace";
import type { NarrativeEdgeData } from "../../types";
import { RelationshipEdge, StoryFlowEdge } from "./GraphCanvasParts";

// Delegate real geometry helpers; replace only SVG chrome/portal hosting, not route math.
// This isolates render-body work and cannot measure React Flow scheduling, portal layout or paint.
vi.mock("@xyflow/react", async (original) => {
  const actual = await original<typeof import("@xyflow/react")>();
  return { ...actual, getBezierPath: vi.fn(actual.getBezierPath), getSmoothStepPath: vi.fn(actual.getSmoothStepPath),
    BaseEdge: ({ id, path, markerEnd }: { id: string; path: string; markerEnd?: string }) => <svg><path data-testid={id} d={path} markerEnd={markerEnd} /></svg>,
    EdgeLabelRenderer: ({ children }: { children: ReactNode }) => <>{children}</>
  };
});
afterEach(() => { vi.clearAllMocks(); vi.restoreAllMocks(); });
const props = (): EdgeProps<Edge<NarrativeEdgeData>> & { data: NarrativeEdgeData } => ({
  id: "route", source: "a", target: "b", sourceX: 10, sourceY: 30, targetX: 610, targetY: 130,
  sourcePosition: Position.Right, targetPosition: Position.Left, selected: false, selectable: true,
  deletable: true, animated: false, data: { label: "Visible route", flowRouteLabelLane: 1 }, markerEnd: "url(#arrow)"
});

it.each([
  { kind: "relationship", Component: RelationshipEdge, helper: getBezierPath },
  { kind: "smooth Story", Component: StoryFlowEdge, helper: getSmoothStepPath }
])("counts real %s path construction separately from repeated label rendering", ({ Component, helper }) => {
  const value = props();
  const shift = vi.spyOn(flow, "shiftedFlowLabelPosition");
  const view = render(<Component {...value} />);
  expect(helper).toHaveBeenCalledOnce();
  const first = screen.getByTestId(value.id).getAttribute("d");
  expect(first).toMatch(/^M/);
  expect(screen.getByText("Visible route")).toBeVisible();
  expect(screen.getByTestId(value.id)).toHaveAttribute("marker-end", "url(#arrow)");
  view.rerender(<Component {...value} selected data={{ ...value.data, label: "Renamed label" }} />);
  expect(helper).toHaveBeenCalledTimes(2);
  expect(screen.getByTestId(value.id)).toHaveAttribute("d", first!);
  expect(screen.getByText("Renamed label")).toBeVisible();
  view.rerender(<Component {...value} sourceX={40} targetPosition={Position.Top} />);
  expect(helper).toHaveBeenCalledTimes(3);
  expect(screen.getByTestId(value.id).getAttribute("d")).not.toBe(first);
  expect(shift).toHaveBeenCalledTimes(Component === StoryFlowEdge ? 3 : 0);
});

it("keeps return-arc construction and lane shifting distinct from smooth-step paths", () => {
  const arc = vi.spyOn(flow, "flowRouteArcPath");
  const shift = vi.spyOn(flow, "shiftedFlowLabelPosition");
  const value = props();
  const view = render(<StoryFlowEdge {...value} data={{ ...value.data, flowRouteArc: true, flowRouteLabelLane: 0 }} />);
  expect(arc).toHaveBeenCalledOnce();
  expect(getSmoothStepPath).not.toHaveBeenCalled();
  const [path, x, y] = arc.mock.results[0]!.value as ReturnType<typeof flow.flowRouteArcPath>;
  expect(screen.getByTestId(value.id)).toHaveAttribute("d", path);
  expect(screen.getByText("Visible route").parentElement).toHaveStyle({ transform: `translate(-50%, -50%) translate(${x}px, ${y}px)` });
  view.rerender(<StoryFlowEdge {...value} data={{ ...value.data, flowRouteArc: true, flowRouteLabelLane: 0 }} />);
  expect(arc).toHaveBeenCalledTimes(2);
  expect(shift).toHaveBeenCalledTimes(2);
  expect(screen.getByTestId(value.id)).toHaveAttribute("d", path);
});

it("uses current self-loop endpoints and relation label precedence without introducing route caches", () => {
  const value = { ...props(), target: "a", targetX: 10, targetY: 30 };
  render(<RelationshipEdge {...value} label="Semantic label" />);
  expect(getBezierPath).toHaveBeenCalledOnce();
  expect(getBezierPath).toHaveBeenCalledWith(expect.objectContaining({ sourceX: 10, targetX: 10, sourceY: 30, targetY: 30 }));
  expect(screen.getByText("Semantic label")).toBeVisible();
  expect(screen.queryByText("Visible route")).not.toBeInTheDocument();
});
