import type { NarrativeEffectOwnerRef } from "@something-to-tell/contracts/narrative-state";
import type { ImpactResourceRef } from "@something-to-tell/contracts/impact-analysis";
import type { Edge, Node, ReactFlowProps, XYPosition } from "@xyflow/react";
import { useLayoutEffect, useMemo, useRef, type MutableRefObject } from "react";
import { temporalOwnerForGraphSelection } from "../../narrative-state/graphOverlay";
import type { WorkspaceMode } from "../../story-flow/workspace";
import type { CanvasSelection, FrameDraft, NarrativeEdgeData, NarrativeNodeData, NodeDraft, Selection } from "../../types";
import { defaultFrameDraft, defaultNodeDraft, frameKindForTool } from "../graph/graphProjection";
import { DEFAULT_FRAME_SIZE, type CanvasContextMenuState, type Dialog, type ToolMode } from "../workspaceShared";

export interface CanvasClickInputs {
  toolMode: ToolMode;
  workspaceMode: WorkspaceMode;
  nodes: Node<NarrativeNodeData>[];
  groupDragActiveRef: MutableRefObject<boolean>;
  suppressPaneClickRef: MutableRefObject<boolean>;
  selectCanvasElement: (type: "edge" | "node", id: string, additive: boolean) => void;
  selectItem: (selection: Selection | null) => void;
  setSelectedTemporalOwner: (owner: NarrativeEffectOwnerRef | null) => void;
  setSelectedAnalysisOperation: (index: number) => void;
  setContextMenu: (menu: CanvasContextMenuState | null) => void;
  setDialog: (dialog: Dialog) => void;
  setSelectedInvocationId: (id: string | null) => void;
  openDialogueEditor: (node: Node<NarrativeNodeData>) => Promise<void>;
  openQuestEditor: (node: Node<NarrativeNodeData>) => Promise<void>;
  impactResourceForNode: (node: Node<NarrativeNodeData>) => ImpactResourceRef;
  impactResourceForEdge: (edge: Edge<NarrativeEdgeData>) => ImpactResourceRef;
  setCanvasSelection: (selection: CanvasSelection) => void;
  setToolMode: (mode: ToolMode) => void;
  addNodeAt: (draft: NodeDraft, position: XYPosition) => void;
  addFrameAt: (draft: FrameDraft, position: XYPosition, size: { height: number; width: number }) => void;
  screenToFlowPosition: (position: XYPosition) => XYPosition;
}

type ClickHandlers = Required<Pick<ReactFlowProps<Node<NarrativeNodeData>, Edge<NarrativeEdgeData>>,
  "onNodeClick" | "onEdgeClick" | "onPaneClick" | "onNodeDoubleClick" | "onEdgeDoubleClick"
  | "onNodeContextMenu" | "onEdgeContextMenu" | "onPaneContextMenu">>;

/** Click adapters only; workspace/store/controllers retain all mutation authority. */
export function useCanvasClickHandlers(inputs: CanvasClickInputs): ClickHandlers {
  const committed = useRef(inputs);
  // Browser interactions after commit must not see inputs from a suspended render.
  useLayoutEffect(() => { committed.current = inputs; }, [inputs]);
  return useMemo<ClickHandlers>(() => ({
    onNodeDoubleClick(_event, node) {
      const current = committed.current;
      if (current.toolMode === "pan") return;
      if (node.data.kind === "Dialogue") void current.openDialogueEditor(node);
      else if (node.data.kind === "Quest") void current.openQuestEditor(node);
      else {
        current.selectItem({ type: "node", id: node.id });
        current.setDialog("edit-node");
      }
    },
    onEdgeDoubleClick(_event, edge) {
      const current = committed.current;
      if (current.toolMode === "pan") return;
      current.selectItem({ type: "edge", id: edge.id });
      if (edge.data?.flowInvocation) {
        current.setSelectedInvocationId(edge.data.flowInvocation.invocationId);
        current.setDialog("flow-call-bindings");
      } else current.setDialog(edge.data?.flowTransition ? "edit-flow-transition" : "edit-edge");
    },
    onNodeContextMenu(event, node) {
      event.preventDefault();
      const current = committed.current;
      if (current.toolMode === "pan") return;
      current.selectCanvasElement("node", node.id, event.shiftKey);
      current.setContextMenu({ x: event.clientX, y: event.clientY, impactResource: current.impactResourceForNode(node) });
    },
    onEdgeContextMenu(event, edge) {
      event.preventDefault();
      const current = committed.current;
      if (current.toolMode === "pan") return;
      current.selectCanvasElement("edge", edge.id, event.shiftKey);
      current.setContextMenu({ x: event.clientX, y: event.clientY, impactResource: current.impactResourceForEdge(edge) });
    },
    onPaneContextMenu(event) {
      event.preventDefault();
      const current = committed.current;
      if (current.toolMode === "pan") return;
      const position = current.screenToFlowPosition({ x: event.clientX, y: event.clientY });
      current.setContextMenu({ x: event.clientX, y: event.clientY, flowX: position.x, flowY: position.y });
    },
    onNodeClick(event, node) {
      const current = committed.current;
      if (current.toolMode !== "pan" && !current.groupDragActiveRef.current) {
        current.setSelectedTemporalOwner(current.workspaceMode === "relationships"
          ? temporalOwnerForGraphSelection({ type: "node", id: node.id }, current.nodes, [])
          : null);
        current.selectCanvasElement("node", node.id, event.shiftKey);
      }
    },
    onEdgeClick(event, edge) {
      const current = committed.current;
      if (current.toolMode === "pan") return;
      if (typeof edge.data?.analysisOperationIndex === "number") {
        current.setSelectedAnalysisOperation(edge.data.analysisOperationIndex);
      } else {
        current.setSelectedTemporalOwner(current.workspaceMode === "relationships"
          ? temporalOwnerForGraphSelection({ type: "edge", id: edge.id }, current.nodes, [edge])
          : null);
        current.selectCanvasElement("edge", edge.id, event.shiftKey);
      }
    },
    onPaneClick(event) {
      const current = committed.current;
      current.setContextMenu(null);
      current.setSelectedTemporalOwner(null);
      if (current.suppressPaneClickRef.current) {
        current.suppressPaneClickRef.current = false;
      } else if (frameKindForTool(current.toolMode)) {
        const kind = frameKindForTool(current.toolMode)!;
        current.addFrameAt(defaultFrameDraft(kind), current.screenToFlowPosition({ x: event.clientX, y: event.clientY }), DEFAULT_FRAME_SIZE);
        current.setToolMode("select");
      } else if (current.toolMode === "pan") {
        return;
      } else if (current.toolMode !== "select" && current.toolMode !== "scene-frame" && current.toolMode !== "location-frame") {
        current.addNodeAt(defaultNodeDraft(current.toolMode), current.screenToFlowPosition({ x: event.clientX, y: event.clientY }));
        current.setToolMode("select");
      } else {
        current.setCanvasSelection({ edgeIds: [], nodeIds: [] });
        current.selectItem(null);
      }
    }
  }), []);
}
