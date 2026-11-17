import type {
CanonIssueProjection,
CanonOwnerRef
} from "@something-to-tell/contracts/canon-check";
import type {
ImpactFinding,
ImpactResourceRef,
ImpactSeed
} from "@something-to-tell/contracts/impact-analysis";
import {
type ImpactVisualChange
} from "@something-to-tell/contracts/impact-resolution";
import {
type Edge,
type Node
} from "@xyflow/react";
import { resolveCanonOwner } from "../../canon/navigation";
import type { NarrativeStateSnapshot } from "../../narrative-state/contracts";
import { useGraphStore } from "../../state/graphStore";
import { type StoryFlowSnapshot } from "../../story-flow/contracts";
import {
type ProjectWorkspacePreference
} from "../../story-flow/workspace";
import {
type NarrativeEdgeData,
type NarrativeNodeData
} from "../../types";


import { useWorkspaceState } from "../shell/useWorkspaceState";
import { impactCallerBlockAfterClose,impactResourceKey,impactSeedKeys,type AnalysisTool,type ImpactCaller } from "../workspaceShared";

type ImpactNavigationState = Pick<ReturnType<typeof useWorkspaceState>, "analysisHeaderButtonRef" | "canonOpen" | "canvasSelection" | "impactBlockedCallerKey" | "impactCaller" | "impactOpen" | "impactOriginRef" | "impactRun" | "impactSeeds" | "sceneAnalysisOpen" | "setCanonOpen" | "setImpactBlockedCallerKey" | "setImpactCaller" | "setImpactError" | "setImpactOpen" | "setImpactResolutionError" | "setImpactResolutionRun" | "setImpactResolutionVerificationPending" | "setImpactRun" | "setImpactSeeds" | "setLastAnalysisTool" | "setSceneAnalysisOpen" | "setSelectedCanonIssueId">;

export type ImpactNavigationControllerContext = ImpactNavigationState & {
  setContextMenu: (menu: null) => void;
  activeStoryFlow: StoryFlowSnapshot | null;
  edges: Edge<NarrativeEdgeData>[];
  focusRenderedNode: (node: Node<NarrativeNodeData>, zoom?: number) => void;
  narrativeStateSnapshot: NarrativeStateSnapshot | null;
  nodes: Node<NarrativeNodeData>[];
  openCanonIssueTarget: (owner: CanonOwnerRef, destination: "flow" | "graph" | "source" | "story", issue?: CanonIssueProjection) => void;
  selectItem: ReturnType<typeof useGraphStore.getState>["selectItem"];
  startPlayback: (flowOverride?: StoryFlowSnapshot) => Promise<void>;
  updateWorkspacePreference: (update: Partial<ProjectWorkspacePreference>) => void;
  visibleStoryFlows: StoryFlowSnapshot[];
  workspaceGraph: { edges: Edge<NarrativeEdgeData>[]; nodes: Node<NarrativeNodeData>[] };
};

/** Owns selection projection and navigation between Impact findings and authoring surfaces. */
export function createImpactNavigationController(context: ImpactNavigationControllerContext) {
  const {
    activeStoryFlow, analysisHeaderButtonRef, canonOpen, canvasSelection, edges,
    focusRenderedNode, impactBlockedCallerKey, impactCaller, impactOpen, impactOriginRef,
    impactRun, impactSeeds, narrativeStateSnapshot, nodes, openCanonIssueTarget,
    sceneAnalysisOpen, selectItem, setCanonOpen, setContextMenu,
    setImpactBlockedCallerKey, setImpactCaller, setImpactError, setImpactOpen,
    setImpactResolutionError, setImpactResolutionRun,
    setImpactResolutionVerificationPending, setImpactRun, setImpactSeeds,
    setLastAnalysisTool, setSceneAnalysisOpen, setSelectedCanonIssueId, startPlayback,
    updateWorkspacePreference, visibleStoryFlows, workspaceGraph
  } = context;


  function impactResourceForNode(node: Node<NarrativeNodeData>): ImpactResourceRef {
    return {
      owner_type: "node",
      owner_id: node.data.canonicalNodeId ?? node.id,
      context_type: null,
      context_id: null
    };
  }



  function impactResourceForEdge(edge: Edge<NarrativeEdgeData>): ImpactResourceRef {
    if (edge.data?.flowTransition) {
      return {
        owner_type: "flow_transition",
        owner_id: edge.data.flowTransition.transitionId,
        context_type: "flow",
        context_id: edge.data.flowTransition.flowId
      };
    }
    if (edge.data?.flowInvocation) {
      return {
        owner_type: "flow_invocation",
        owner_id: edge.data.flowInvocation.invocationId,
        context_type: "flow",
        context_id: edge.data.flowInvocation.sourceFlowId
      };
    }
    if (edge.data?.sceneBoundary) {
      return {
        owner_type: "scene_boundary",
        owner_id: edge.data.sceneBoundary.boundaryId,
        context_type: "flow",
        context_id: edge.data.sceneBoundary.flowId
      };
    }
    return { owner_type: "edge", owner_id: edge.id, context_type: null, context_id: null };
  }



  function selectedImpactSeeds(): ImpactSeed[] {
    const resources = [
      ...canvasSelection.nodeIds.flatMap((id) => {
        const node = nodes.find((candidate) => candidate.id === id);
        return node ? [impactResourceForNode(node)] : [];
      }),
      ...canvasSelection.edgeIds.flatMap((id) => {
        const edge = workspaceGraph.edges.find((candidate) => candidate.id === id) ?? edges.find((candidate) => candidate.id === id);
        return edge ? [impactResourceForEdge(edge)] : [];
      })
    ];
    const unique = new Map(resources.map((resource) => [impactResourceKey(resource), resource]));
    return [...unique.values()].map((resource) => ({ seed_version: 1, resource }));
  }



  function openImpactWorkspace(resources?: ImpactResourceRef[], origin?: HTMLElement | null, caller: ImpactCaller | null = null) {
    const nextSeeds = resources?.map((resource) => ({ seed_version: 1 as const, resource })) ?? selectedImpactSeeds();
    if (caller || impactSeedKeys(nextSeeds) !== impactSeedKeys(impactSeeds)) {
      setImpactRun(null);
      setImpactError(null);
      setImpactResolutionRun(null);
      setImpactResolutionError(null);
      setImpactResolutionVerificationPending(false);
    }
    impactOriginRef.current = origin ?? analysisHeaderButtonRef.current;
    setImpactCaller(caller);
    setLastAnalysisTool("impact");
    if (!caller?.kind.startsWith("canon-")) setSelectedCanonIssueId(null);
    setImpactSeeds(nextSeeds);
    // Reviewed callers remain mounted below Impact so local filters, drafts,
    // and the exact focus origin survive the round trip without applying data.
    if (caller?.kind !== "scene-suggestion") setSceneAnalysisOpen(false);
    if (!caller?.kind.startsWith("canon-")) setCanonOpen(false);
    setImpactOpen(true);
    setContextMenu(null);
  }



  function closeImpactWorkspace() {
    const caller = impactCaller;
    if (caller) {
      setImpactBlockedCallerKey((current) => impactCallerBlockAfterClose(current, caller.key, impactRun?.status ?? null));
    }
    setImpactOpen(false);
    const origin = impactOriginRef.current;
    setImpactCaller(null);
    // Canon may restore its own panel focus during the same commit. Defer the
    // caller restoration until that accessibility effect has completed.
    window.setTimeout(() => {
      const callerOrigin = caller
        ? [...document.querySelectorAll<HTMLElement>("[data-impact-origin]")]
          .find((element) => element.dataset.impactOrigin === caller.key) ?? null
        : null;
      if (caller?.kind === "canon-issue" && callerOrigin) callerOrigin.focus();
      else if (origin?.isConnected) origin.focus();
      else callerOrigin?.focus();
    }, 0);
  }



  /** Keeps the three analysis surfaces mutually exclusive while preserving the user's last tool. */
  function selectAnalysisTool(tool: AnalysisTool, toggle = false) {
    const isOpen = tool === "scene" ? sceneAnalysisOpen : tool === "impact" ? impactOpen : canonOpen;
    setLastAnalysisTool(tool);
    setSceneAnalysisOpen(false);
    setCanonOpen(false);
    setImpactOpen(false);
    if (toggle && isOpen) return;
    if (tool === "scene") setSceneAnalysisOpen(true);
    if (tool === "canon") setCanonOpen(true);
    if (tool === "impact") openImpactWorkspace(undefined, analysisHeaderButtonRef.current);
  }



  function impactResourceLabel(resource: ImpactResourceRef): string {
    if (resource.owner_type === "node") {
      return nodes.find((node) => (node.data.canonicalNodeId ?? node.id) === resource.owner_id)?.data.title ?? resource.owner_id;
    }
    if (resource.owner_type === "edge") {
      const edge = edges.find((candidate) => candidate.id === resource.owner_id);
      return String(edge?.data?.label ?? edge?.label ?? resource.owner_id);
    }
    const projected = workspaceGraph.edges.find((edge) => {
      const candidate = impactResourceForEdge(edge);
      return candidate.owner_type === resource.owner_type && candidate.owner_id === resource.owner_id;
    });
    return String(projected?.data?.label ?? projected?.label ?? resource.owner_id);
  }



  /** Resolves a finding through the same stable owner adapters used by Canon and Playback. */
  function openImpactFinding(finding: ImpactFinding) {
    const owner = finding.target;
    setImpactOpen(false);
    if (finding.domain === "canon" || owner.owner_type === "issue") {
      setSelectedCanonIssueId(owner.owner_type === "issue" ? owner.owner_id : null);
      setCanonOpen(true);
      return;
    }

    const resources = [owner, ...finding.paths.flatMap((path) => [...path.resources].reverse())];
    if (finding.domain === "playback" || owner.owner_type.startsWith("playback_")) {
      const flowId = resources.find((resource) => resource.owner_type === "flow")?.owner_id
        ?? resources.find((resource) => resource.context_type === "flow")?.context_id
        ?? null;
      const flow = visibleStoryFlows.find((candidate) => candidate.flow.id === flowId) ?? activeStoryFlow;
      if (flow) {
        updateWorkspacePreference({ mode: "flow", activeFlowId: flow.flow.id });
        void startPlayback(flow);
      }
      return;
    }

    if (owner.owner_type === "placement") {
      const placement = nodes.find((node) => node.data.placementId === owner.owner_id);
      if (placement) {
        updateWorkspacePreference({ mode: "relationships", activeFlowId: activeStoryFlow?.flow.id ?? null });
        selectItem({ type: "node", id: placement.id });
        window.setTimeout(() => focusRenderedNode(placement), 100);
      }
      return;
    }

    if (owner.owner_type === "flow_member" || owner.owner_type === "flow_entry" || owner.owner_type === "flow_terminal") {
      const flow = visibleStoryFlows.find((candidate) => candidate.flow.id === owner.context_id) ?? activeStoryFlow;
      const memberNodeId = owner.owner_type === "flow_member"
        ? flow?.nodes.find((member) => member.id === owner.owner_id)?.node_id
        : owner.owner_id;
      if (flow && memberNodeId) {
        openCanonIssueTarget({ owner_type: "node", owner_id: memberNodeId, context_type: null, context_id: null }, "flow");
      }
      return;
    }

    const navigable = resources.find((resource) => {
      const resolved = resolveCanonOwner(resource, nodes, visibleStoryFlows, narrativeStateSnapshot);
      return resolved.nodeId || resolved.canvasEdgeId || resolved.flowId || resolved.temporalOwner;
    }) ?? owner;
    const resolved = resolveCanonOwner(navigable, nodes, visibleStoryFlows, narrativeStateSnapshot);
    const destination: "flow" | "graph" | "source" = finding.domain === "flow"
      ? "flow"
      : finding.domain === "dialogue" || finding.domain === "quest" || finding.domain === "temporal"
        ? "source"
        : "graph";
    openCanonIssueTarget(navigable, resolved.surface === "temporal" ? "source" : destination);
  }



  /** Focuses the authored owner represented by one validated visual-diff row. */
  function openImpactResolutionChange(change: ImpactVisualChange) {
    const owner = change.after_resource ?? change.before_resource;
    if (!owner) return;
    setImpactOpen(false);
    if (change.surface === "canon" && owner.owner_type === "issue") {
      setSelectedCanonIssueId(owner.owner_id);
      setCanonOpen(true);
      return;
    }
    const destination = change.surface === "flow" ? "flow"
      : change.surface === "story" ? "story"
        : change.surface === "graph" || change.surface === "composition" ? "graph"
          : "source";
    openCanonIssueTarget(owner, destination);
  }



  /** Opens the derived readable projection and focuses its first affected beat marker. */
  function openImpactStoryProjection() {
    setImpactOpen(false);
    updateWorkspacePreference({ mode: "story", activeFlowId: activeStoryFlow?.flow.id ?? null });
    window.setTimeout(() => {
      const marker = document.querySelector<HTMLElement>(".story-impact-marker");
      marker?.scrollIntoView?.({ block: "center" });
      marker?.focus();
    }, 100);
  }

  return { impactResourceForNode, impactResourceForEdge, selectedImpactSeeds, openImpactWorkspace, closeImpactWorkspace, selectAnalysisTool, impactResourceLabel, openImpactFinding, openImpactResolutionChange, openImpactStoryProjection };
}
