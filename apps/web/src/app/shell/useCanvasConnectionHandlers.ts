import type { Connection, ReactFlowProps } from "@xyflow/react";
import { useLayoutEffect, useMemo, useRef } from "react";
import type { WorkspaceMode } from "../../story-flow/workspace";
import { nodeIdFromConnectionNode } from "../graph/graphProjection";
import type { PendingGraphConnection } from "../workspaceShared";

type ConnectionHandlers = Required<Pick<ReactFlowProps, "onConnect" | "onConnectStart" | "onConnectEnd">>;

export interface CanvasConnectionInputs {
  workspaceMode: WorkspaceMode;
  connectionSourceId: string | null;
  connectionTargetId: string | null;
  beginFlowConnection: (sourceNodeId: string, targetNodeId: string) => Promise<void>;
  chooseGraphConnection: (connection: PendingGraphConnection) => void;
  onConnect: (connection: Connection) => void;
  setConnectionSourceId: (id: string | null) => void;
  setConnectionTargetId: (id: string | null) => void;
}

/** New-connection adapters only; feedback state and authoring commands keep their owners. */
export function useCanvasConnectionHandlers(inputs: CanvasConnectionInputs): ConnectionHandlers {
  const committed = useRef(inputs);
  // Ongoing gestures must not observe commands or endpoints from a suspended render.
  useLayoutEffect(() => { committed.current = inputs; }, [inputs]);
  return useMemo<ConnectionHandlers>(() => ({
    onConnect(connection) {
      const current = committed.current;
      if (current.workspaceMode === "flow" && connection.source && connection.target) {
        void current.beginFlowConnection(connection.source, connection.target);
      } else if (current.workspaceMode === "relationships" && connection.source && connection.target) {
        current.chooseGraphConnection({
          source: connection.source,
          sourceHandle: connection.sourceHandle ?? null,
          target: connection.target,
          targetHandle: connection.targetHandle ?? null
        });
      } else {
        current.onConnect(connection);
      }
    },
    onConnectEnd(_, connectionState) {
      const current = committed.current;
      const sourceId = nodeIdFromConnectionNode(connectionState.fromNode) ?? current.connectionSourceId;
      const targetId = nodeIdFromConnectionNode(connectionState.toNode) ?? current.connectionTargetId;
      if (connectionState.isValid !== true && sourceId && targetId) {
        if (current.workspaceMode === "flow") {
          void current.beginFlowConnection(sourceId, targetId);
        } else {
          const connection = {
            source: sourceId,
            sourceHandle: connectionState.fromHandle?.id ?? null,
            target: targetId,
            targetHandle: null
          };
          if (current.workspaceMode === "relationships") current.chooseGraphConnection(connection);
          else current.onConnect(connection);
        }
      }
      current.setConnectionSourceId(null);
      current.setConnectionTargetId(null);
    },
    onConnectStart(_, params) {
      committed.current.setConnectionSourceId(params.nodeId);
    }
  }), []);
}
