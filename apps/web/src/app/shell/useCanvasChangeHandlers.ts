import type { Edge, Node, ReactFlowProps } from "@xyflow/react";
import { useLayoutEffect, useMemo, useRef, type Dispatch, type MutableRefObject, type SetStateAction } from "react";
import { createCanvasSelection, type CanvasSelection, type NarrativeEdgeData, type NarrativeNodeData } from "../../types";
import { sameCanvasSelection, withoutDoubleAppliedDescendantMoves } from "../workspaceShared";

type ChangeHandlers = Required<Pick<ReactFlowProps<Node<NarrativeNodeData>, Edge<NarrativeEdgeData>>,
  "onNodesChange" | "onEdgesChange">>;

export interface CanvasChangeInputs extends ChangeHandlers {
  alternatePanGestureRef: MutableRefObject<boolean>;
  groupDragActiveRef: MutableRefObject<boolean>;
  canvasSelection: CanvasSelection;
  setCanvasSelection: Dispatch<SetStateAction<CanvasSelection>>;
  getActiveGraph: () => { nodes: Node<NarrativeNodeData>[] };
}

/** Adapts React Flow batches; the workspace/store retain selection and mutation authority. */
export function useCanvasChangeHandlers(inputs: CanvasChangeInputs): ChangeHandlers {
  const committed = useRef(inputs);
  // A speculative or suspended render must not replace commands used by live gestures.
  useLayoutEffect(() => { committed.current = inputs; }, [inputs]);
  return useMemo<ChangeHandlers>(() => ({
    onEdgesChange(changes) {
      const current = committed.current;
      const selectionChanges = current.alternatePanGestureRef.current
        ? []
        : changes.filter((change) => change.type === "select");
      if (selectionChanges.length) {
        current.setCanvasSelection((selection) => {
          const selected = new Set(selection.edgeIds);
          for (const change of selectionChanges) change.selected ? selected.add(change.id) : selected.delete(change.id);
          const next = createCanvasSelection(selection.nodeIds, [...selected]);
          return sameCanvasSelection(selection, next) ? selection : next;
        });
      }
      current.onEdgesChange(current.alternatePanGestureRef.current ? changes.filter((change) => change.type !== "select") : changes);
    },
    onNodesChange(changes) {
      const current = committed.current;
      const preserveSelection = current.alternatePanGestureRef.current || current.groupDragActiveRef.current;
      const selectionChanges = preserveSelection
        ? []
        : changes.filter((change) => change.type === "select");
      if (selectionChanges.length) {
        current.setCanvasSelection((selection) => {
          const selected = new Set(selection.nodeIds);
          for (const change of selectionChanges) change.selected ? selected.add(change.id) : selected.delete(change.id);
          const next = createCanvasSelection([...selected], selection.edgeIds);
          return sameCanvasSelection(selection, next) ? selection : next;
        });
      }
      const applicableChanges = preserveSelection
        ? changes.filter((change) => change.type !== "select")
        : changes;
      current.onNodesChange(withoutDoubleAppliedDescendantMoves(applicableChanges, current.getActiveGraph().nodes, current.canvasSelection.nodeIds));
    }
  }), []);
}
