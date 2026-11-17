import { ReactFlow, ReactFlowProvider, type Node } from "@xyflow/react";
import { fireEvent, render, waitFor } from "@testing-library/react";
import { expect, it } from "vitest";
import { CanvasNodePresentation, CanvasNodePresentationBridge, NODE_DETAIL_PRESENTATION_ENABLED } from "./CanvasNodePresentation";
import { CanvasRenderingExperimentControl } from "../settings/CanvasRenderingExperimentControl";
import { createCanvasExperimentPreference, NODE_DETAIL_EXPERIMENT_KEY } from "./canvasRenderingExperiment";
import { NARRATIVE_NODE_TYPES } from "./GraphCanvasParts";
import { tr } from "../../localization/i18n";
import type { NarrativeNodeRenderData } from "../workspaceShared";

it("inherits accepted detail On under restricted storage but retains explicit in-memory Off", () => {
  expect(NODE_DETAIL_PRESENTATION_ENABLED).toBe(true);
  const preference = createCanvasExperimentPreference(NODE_DETAIL_EXPERIMENT_KEY, () => { throw Error("restricted"); });
  expect(preference.getSnapshot() ?? NODE_DETAIL_PRESENTATION_ENABLED).toBe(true);
  preference.setEnabled(false); expect(preference.getSnapshot() ?? NODE_DETAIL_PRESENTATION_ENABLED).toBe(false);
});

it("uses actual Graph detail default independently of spatial preference, falls back in Flow and preserves Off on remount", async () => {
  expect(localStorage.getItem(NODE_DETAIL_EXPERIMENT_KEY)).toBeNull();
  const nodes: Node<NarrativeNodeRenderData>[] = Array.from({ length: 4 }, (_, i) => ({
    id: `default-${i}`, type: "narrative", parentId: i ? `default-${i - 1}` : undefined, position: { x: i ? 20 : 0, y: i ? 60 : 0 },
    width: 800 - i * 150, height: 650 - i * 140,
    data: { kind: i === 3 ? "Lore" : "Location", isFrame: i < 3, title: `Default ${i}`, label: `Default ${i}`, summary: "Full text", tags: [] }
  }));
  const view = (mode: "relationships" | "flow" = "relationships") => <ReactFlowProvider initialWidth={1440} initialHeight={900}>
    <CanvasRenderingExperimentControl />
    <CanvasNodePresentation workspaceMode={mode}><ReactFlow width={1440} height={900} nodes={nodes} nodeTypes={NARRATIVE_NODE_TYPES}>
      <CanvasNodePresentationBridge nodes={nodes} scope={{ projectId: "project", workspaceMode: mode, flowId: null, focusedFrameId: null }} resetKey={1} protectedOwnerIds={[]} />
    </ReactFlow></CanvasNodePresentation>
  </ReactFlowProvider>;
  const rendered = render(view()), leaf = () => rendered.container.querySelector('[data-id="default-3"] article')!;
  const detail = rendered.getByRole("checkbox", { name: tr("canvasExperiment.nodeDetail") });
  const spatial = rendered.getByRole("checkbox", { name: tr("canvasExperiment.graphCards") });
  await waitFor(() => expect(leaf()).toHaveAttribute("data-node-presentation", "folded"));
  expect(detail).toBeChecked(); expect(spatial).toBeChecked();
  fireEvent.click(spatial); await waitFor(() => expect(leaf()).toHaveAttribute("data-node-presentation", "folded")); expect(detail).toBeChecked();
  rendered.rerender(view("flow")); expect(leaf()).toHaveAttribute("data-node-presentation", "full");
  rendered.rerender(view()); await waitFor(() => expect(leaf()).toHaveAttribute("data-node-presentation", "folded"));
  fireEvent.click(detail); expect(leaf()).toHaveAttribute("data-node-presentation", "full"); expect(spatial).not.toBeChecked();
  expect(createCanvasExperimentPreference(NODE_DETAIL_EXPERIMENT_KEY, () => localStorage).getSnapshot()).toBe(false);
  rendered.unmount(); const remounted = render(view());
  expect(remounted.getByRole("checkbox", { name: tr("canvasExperiment.nodeDetail") })).not.toBeChecked();
  expect(remounted.container.querySelector('[data-id="default-3"] article')).toHaveAttribute("data-node-presentation", "full");
  expect(remounted.container.querySelectorAll(".narrative-handle")).toHaveLength(16);
});
