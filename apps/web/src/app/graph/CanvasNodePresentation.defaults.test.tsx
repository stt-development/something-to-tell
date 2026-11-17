import { ReactFlow, ReactFlowProvider } from "@xyflow/react";
import { fireEvent, render, waitFor } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import { CanvasNodePresentation, CanvasNodePresentationBridge, VIEWPORT_CARD_PRESENTATION_ENABLED } from "./CanvasNodePresentation";
import * as experiment from "./canvasRenderingExperiment";
import { NARRATIVE_NODE_TYPES } from "./GraphCanvasParts";
import { CanvasRenderingExperimentControl } from "../settings/CanvasRenderingExperimentControl";
import { tr } from "../../localization/i18n";

afterEach(() => vi.restoreAllMocks());

it("inherits the approved default with blocked storage but permits an in-memory Off", () => {
  const preference = experiment.createGraphCardExperiment(() => { throw Error("blocked"); });
  expect(preference.getSnapshot() ?? VIEWPORT_CARD_PRESENTATION_ENABLED).toBe(true);
  preference.setEnabled(false);
  expect(preference.getSnapshot() ?? VIEWPORT_CARD_PRESENTATION_ENABLED).toBe(false);
});

it("inherits the actual approved Graph default, but explicit Off survives mode changes, remount and reload", async () => {
  expect(VIEWPORT_CARD_PRESENTATION_ENABLED).toBe(true);
  expect(localStorage.getItem(experiment.GRAPH_CARD_EXPERIMENT_KEY)).toBeNull();
  const nodes = [{ id: "far", type: "narrative", position: { x: 10000, y: 0 }, width: 260, height: 156,
    data: { kind: "Lore" as const, title: "Far", label: "Far", summary: "Text", tags: [] } }];
  const view = (mode: "relationships" | "flow", enabled?: boolean) => <ReactFlowProvider initialWidth={1440} initialHeight={900}>
    <CanvasRenderingExperimentControl />
    <CanvasNodePresentation workspaceMode={mode} enabled={enabled}>
      <ReactFlow width={1440} height={900} nodes={nodes} nodeTypes={NARRATIVE_NODE_TYPES}>
        <CanvasNodePresentationBridge nodes={nodes} scope={{ projectId: "project", workspaceMode: mode, flowId: null, focusedFrameId: null }}
          resetKey="document" protectedOwnerIds={[]} />
      </ReactFlow>
    </CanvasNodePresentation>
  </ReactFlowProvider>;
  const rendered = render(view("relationships"));
  const card = () => rendered.container.querySelector("article")!;
  const checkbox = rendered.getByRole("checkbox", { name: tr("canvasExperiment.graphCards") });
  await waitFor(() => expect(card()).toHaveAttribute("data-node-presentation", "shell"));
  expect(checkbox).toBeChecked();
  rendered.rerender(view("flow"));
  expect(card()).toHaveAttribute("data-node-presentation", "full");
  rendered.rerender(view("relationships"));
  await waitFor(() => expect(card()).toHaveAttribute("data-node-presentation", "shell"));
  fireEvent.click(checkbox);
  expect(checkbox).not.toBeChecked();
  expect(card()).toHaveAttribute("data-node-presentation", "full");
  expect(experiment.createGraphCardExperiment(() => localStorage).getSnapshot() ?? true).toBe(false);
  rendered.rerender(view("flow")); rendered.rerender(view("relationships"));
  expect(card()).toHaveAttribute("data-node-presentation", "full");
  rendered.rerender(view("flow", true));
  await waitFor(() => expect(card()).toHaveAttribute("data-node-presentation", "shell"));
  rendered.rerender(view("relationships", false));
  expect(card()).toHaveAttribute("data-node-presentation", "full");
  rendered.unmount();
  const remounted = render(view("relationships"));
  expect(remounted.getByRole("checkbox", { name: tr("canvasExperiment.graphCards") })).not.toBeChecked();
  expect(remounted.container.querySelector("article")).toHaveAttribute("data-node-presentation", "full");
  expect(remounted.container.querySelectorAll(".react-flow__handle")).toHaveLength(4);
});
