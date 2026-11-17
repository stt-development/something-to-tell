import type { Connection, Edge, Node, ReactFlowProps } from "@xyflow/react";
import { useLayoutEffect, useMemo, useRef } from "react";
import type { FlowTransition, StoryFlowSnapshot } from "../../story-flow/contracts";
import type { NarrativeEdgeData, NarrativeNodeData } from "../../types";
import { nodeIdFromConnectionNode } from "../graph/graphProjection";

type ReconnectHandlers = Required<Pick<ReactFlowProps<Node<NarrativeNodeData>, Edge<NarrativeEdgeData>>,
  "onReconnect" | "onReconnectStart" | "onReconnectEnd">>;

export interface CanvasReconnectInputs {
  activeStoryFlow: Pick<StoryFlowSnapshot, "transitions"> | null;
  connectionTargetId: string | null;
  reconnectFlowTransition: (transition: FlowTransition, sourceNodeId: string, targetNodeId: string) => Promise<void>;
  reconnectEdge: (edgeId: string, connection: Partial<Connection>) => void;
  deleteEdge: (edgeId: string) => void;
  setConnectionSourceId: (id: string | null) => void;
  setConnectionTargetId: (id: string | null) => void;
}

/** Reconnect adapters only; flow/graph commands retain mutation and persistence authority. */
export function useCanvasReconnectHandlers(inputs: CanvasReconnectInputs): ReconnectHandlers {
  const committed = useRef(inputs);
  // Live gestures must not see flow/command inputs from an uncommitted render.
  useLayoutEffect(() => { committed.current = inputs; }, [inputs]);
  return useMemo<ReconnectHandlers>(() => ({
    onReconnect(edge, connection) {
      const current = committed.current;
      const transition = current.activeStoryFlow?.transitions.find((item) => `story-flow:${item.id}` === edge.id);
      if (transition && connection.source && connection.target) {
        void current.reconnectFlowTransition(transition, connection.source, connection.target);
      } else {
        current.reconnectEdge(edge.id, connection);
      }
    },
    onReconnectEnd(_, edge, handleType, connectionState) {
      const current = committed.current;
      const targetId = nodeIdFromConnectionNode(connectionState.toNode) ?? current.connectionTargetId;
      if (connectionState.isValid !== true && targetId) {
        current.reconnectEdge(
          edge.id,
          handleType === "source"
            ? {
                source: targetId,
                sourceHandle: null,
                target: edge.target,
                targetHandle: edge.targetHandle ?? null
              }
            : {
                source: edge.source,
                sourceHandle: edge.sourceHandle ?? null,
                target: targetId,
                targetHandle: null
              }
        );
      } else if (connectionState.isValid !== true) {
        current.deleteEdge(edge.id);
      }
      current.setConnectionSourceId(null);
      current.setConnectionTargetId(null);
    },
    onReconnectStart(_, edge, handleType) {
      committed.current.setConnectionSourceId(handleType === "source" ? edge.target : edge.source);
    }
  }), []);
}
