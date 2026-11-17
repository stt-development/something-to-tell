import type { Node, ReactFlowProps } from "@xyflow/react";
import { useCallback, useLayoutEffect, useRef, type MutableRefObject } from "react";
import { tr } from "../../localization/i18n";
import type { CanvasSelection, NarrativeNodeData } from "../../types";

type DragStopHandler = NonNullable<ReactFlowProps<Node<NarrativeNodeData>>["onNodeDragStop"]>;

export interface CanvasDragStopInputs {
  getActiveGraph: () => { nodes: Node<NarrativeNodeData>[] };
  dragStartNodesRef: MutableRefObject<Node<NarrativeNodeData>[] | null>;
  groupDragActiveRef: MutableRefObject<boolean>;
  groupDragSelectionRef: MutableRefObject<CanvasSelection | null>;
  suppressPaneClickRef: MutableRefObject<boolean>;
  compositionDropRef: MutableRefObject<{ frameId: string; message: string; valid: boolean } | null>;
  completeNodeDrop: (nodeId: string, targetFrameId: string | null, previousNodes: Node<NarrativeNodeData>[]) => { message: string; valid: boolean };
  completeGroupMove: (previousNodes: Node<NarrativeNodeData>[]) => void;
  setCompositionDrop: (feedback: null) => void;
  setCompositionNotice: (message: string | null) => void;
  setCanvasSelection: (selection: CanvasSelection) => void;
}

/** Completes drag through existing commands; pending timers keep their event-time inputs. */
export function useCanvasDragStopHandler(inputs: CanvasDragStopInputs): DragStopHandler {
  const committed = useRef(inputs);
  useLayoutEffect(() => { committed.current = inputs; }, [inputs]);
  return useCallback<DragStopHandler>((_, node) => {
    const current = committed.current;
    const previousNodes = current.dragStartNodesRef.current ?? current.getActiveGraph().nodes;
    const movedSelection = current.groupDragSelectionRef.current;
    const groupMove = movedSelection !== null;
    const result = groupMove
      ? { message: tr("authoring.groupMoved", { count: movedSelection.nodeIds.length }), valid: true }
      : current.completeNodeDrop(node.id, current.compositionDropRef.current?.frameId ?? null, previousNodes);
    if (groupMove) current.completeGroupMove(previousNodes);
    current.dragStartNodesRef.current = null;
    current.compositionDropRef.current = null;
    current.setCompositionDrop(null);
    current.setCompositionNotice(result.message);
    window.setTimeout(() => current.setCompositionNotice(null), 1800);
    window.setTimeout(() => {
      // React Flow dispatches its synthetic pane click in a later task after drag-stop.
      // Do not redirect this task to refs/commands from a subsequent commit.
      current.groupDragActiveRef.current = false;
      current.groupDragSelectionRef.current = null;
      current.suppressPaneClickRef.current = false;
      if (movedSelection) current.setCanvasSelection(movedSelection);
    }, 100);
  }, []);
}
