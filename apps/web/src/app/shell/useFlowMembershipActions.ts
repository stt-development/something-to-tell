import { useEffect, useLayoutEffect, useMemo, useRef } from "react";
import type { WorkspaceMode } from "../../story-flow/workspace";

interface MembershipActions {
  onAddToFlow: () => void;
  onContinueFlow: () => void;
  onCallFlow: () => void;
  onCreateFlowExit: () => void;
  onSetFlowEntry: () => void;
  onConfigureSceneBoundary: () => void;
}
export interface FlowMembershipActionInputs {
  projectId: string;
  nodes: readonly { id: string; data: { canonicalNodeId?: string; kind?: string } }[];
  activeStoryFlow: { flow: { id: string }; nodes: readonly { node_id: string }[] } | null;
  workspaceMode: WorkspaceMode;
  addNodeToActiveStoryFlow: (id: string) => Promise<unknown>;
  openContinueFlow: (id: string) => void;
  openFlowInvocation: (id: string) => void;
  openFlowExit: (id: string) => void;
  setEntryCandidateId: (id: string) => void;
  setBoundarySceneId: (id: string) => void;
  setFlowActionError: (error: null) => void;
  setDialog: (dialog: "set-flow-entry" | "scene-boundary") => void;
}
type Committed = Pick<FlowMembershipActionInputs, "workspaceMode" | "projectId" | "addNodeToActiveStoryFlow" | "openContinueFlow" | "openFlowInvocation" | "openFlowExit" | "setEntryCandidateId" | "setBoundarySceneId" | "setFlowActionError" | "setDialog"> & {
  flowId: string | null;
  members: ReadonlySet<string>;
  scenes: ReadonlySet<string>;
  bundles: ReadonlyMap<string, MembershipActions>;
};

/** Canonical member-node adapters only; the existing Flow controller owns mutations/dialogs. */
export function useFlowMembershipActions(inputs: FlowMembershipActionInputs): ReadonlyMap<string, Partial<MembershipActions>> {
  const { projectId, nodes, activeStoryFlow, workspaceMode, addNodeToActiveStoryFlow, openContinueFlow, openFlowInvocation, openFlowExit, setEntryCandidateId, setBoundarySceneId, setFlowActionError, setDialog } = inputs;
  const committed = useRef<Committed | null>(null);
  const flowId = activeStoryFlow?.flow.id ?? null;
  const { bundles, members, scenes, actions } = useMemo(() => {
    const previous = committed.current;
    const members = new Set(activeStoryFlow?.nodes.map((item) => item.node_id));
    const scenes = new Set(nodes.filter((node) => node.data.kind === "Scene").map((node) => node.data.canonicalNodeId ?? node.id));
    const bundles = new Map<string, MembershipActions>();
    const actions = new Map<string, Partial<MembershipActions>>();
    for (const node of nodes) {
      const id = node.data.canonicalNodeId ?? node.id;
      if (actions.has(id)) continue;
      let bundle = previous?.projectId === projectId && previous.flowId === flowId ? previous.bundles.get(id) : undefined;
      if (activeStoryFlow) {
        if (!bundle) {
          const created: MembershipActions = {
            onAddToFlow() {
              const current = committed.current;
              if (current?.bundles.get(id) === created && current.workspaceMode === "relationships" && !current.members.has(id)) {
                void current.addNodeToActiveStoryFlow(id);
              }
            },
            onContinueFlow() {
              const current = committed.current;
              if (current?.bundles.get(id) === created && (current.workspaceMode === "relationships" || current.workspaceMode === "flow") && current.members.has(id)) {
                current.openContinueFlow(id);
              }
            },
            onCallFlow() {
              const current = committed.current;
              if (current?.bundles.get(id) === created && (current.workspaceMode === "relationships" || current.workspaceMode === "flow") && current.members.has(id)) {
                current.openFlowInvocation(id);
              }
            },
            onCreateFlowExit() {
              const current = committed.current;
              if (current?.bundles.get(id) === created && (current.workspaceMode === "relationships" || current.workspaceMode === "flow") && current.members.has(id)) {
                current.openFlowExit(id);
              }
            },
            onSetFlowEntry() {
              const current = committed.current;
              if (current?.bundles.get(id) === created && (current.workspaceMode === "relationships" || current.workspaceMode === "flow") && current.members.has(id)) {
                current.setEntryCandidateId(id);
                current.setDialog("set-flow-entry");
              }
            },
            onConfigureSceneBoundary() {
              const current = committed.current;
              if (current?.bundles.get(id) === created && (current.workspaceMode === "relationships" || current.workspaceMode === "flow") && current.members.has(id) && current.scenes.has(id)) {
                current.setBoundarySceneId(id);
                current.setFlowActionError(null);
                current.setDialog("scene-boundary");
              }
            }
          };
          bundle = created;
        }
        bundles.set(id, bundle);
      }
      // Keep both keys explicit so ineligible actions cannot leak from source node data.
      actions.set(id, {
        onAddToFlow: workspaceMode === "relationships" && !members.has(id) ? bundle?.onAddToFlow : undefined,
        onContinueFlow: (workspaceMode === "relationships" || workspaceMode === "flow") && members.has(id) ? bundle?.onContinueFlow : undefined,
        onCallFlow: (workspaceMode === "relationships" || workspaceMode === "flow") && members.has(id) ? bundle?.onCallFlow : undefined,
        onCreateFlowExit: (workspaceMode === "relationships" || workspaceMode === "flow") && members.has(id) ? bundle?.onCreateFlowExit : undefined,
        onSetFlowEntry: (workspaceMode === "relationships" || workspaceMode === "flow") && members.has(id) ? bundle?.onSetFlowEntry : undefined,
        onConfigureSceneBoundary: (workspaceMode === "relationships" || workspaceMode === "flow") && members.has(id) && scenes.has(id) ? bundle?.onConfigureSceneBoundary : undefined
      });
    }
    return { bundles, members, scenes, actions };
  }, [projectId, nodes, activeStoryFlow, flowId, workspaceMode]);
  // Publish eligibility/commands and prune only after commit, never from a speculative render.
  useLayoutEffect(() => {
    committed.current = { projectId, flowId, bundles, members, scenes, workspaceMode, addNodeToActiveStoryFlow, openContinueFlow, openFlowInvocation, openFlowExit, setEntryCandidateId, setBoundarySceneId, setFlowActionError, setDialog };
  }, [projectId, flowId, bundles, members, scenes, workspaceMode, addNodeToActiveStoryFlow, openContinueFlow, openFlowInvocation, openFlowExit, setEntryCandidateId, setBoundarySceneId, setFlowActionError, setDialog]);
  useEffect(() => () => { committed.current = null; }, []);
  return actions;
}
