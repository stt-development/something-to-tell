import type { NarrativeEffectOwnerRef } from "@something-to-tell/contracts/narrative-state";
import {
type Edge,
type Node
} from "@xyflow/react";
import type { NarrativeStateSnapshot } from "../../narrative-state/contracts";
import {
type PlaybackSelection,
type PlaybackSourceTarget,
type PlaybackWorkspaceError
} from "../../playback/PlaybackWorkspace";
import type { PlaybackFact,PlaybackSession } from "../../playback/contracts";
import { buildPlaybackPrepareCommand,narrativeOwnerForPlaybackEffect } from "../../playback/prepare";
import { createRuntimeApiClient } from "../../runtime/apiClient";
import { type StoryFlowSnapshot } from "../../story-flow/contracts";
import {
projectGraphForWorkspace,
type ProjectWorkspacePreference,
type WorkspaceMode
} from "../../story-flow/workspace";
import {
type Selection as GraphSelection,
type NarrativeEdgeData,
type NarrativeNodeData
} from "../../types";


import type { Dispatch,MutableRefObject,SetStateAction } from "react";
import { playbackSessionAnnouncement } from "../analysis/sceneAnalysis";
import { nodeForWorkspaceFocus } from "../graph/graphProjection";
import type { Dialog } from "../workspaceShared";

export interface PlaybackControllerContext {
  activeStoryFlow: StoryFlowSnapshot | null;
  buildEdges: Edge<NarrativeEdgeData>[];
  canonOpen: boolean;
  editStoryNode: (node: Node<NarrativeNodeData>) => void;
  focusRenderedNode: (node: Node<NarrativeNodeData>, zoom?: number) => void;
  narrativeStateSnapshot: NarrativeStateSnapshot | null;
  nodes: Node<NarrativeNodeData>[];
  openStoryNodeInWorkspace: (node: Node<NarrativeNodeData>, mode: "flow" | "relationships") => void;
  openTemporalEffectOwner: (owner: NarrativeEffectOwnerRef) => void;
  playbackEffectsByFlow: Record<string, NonNullable<Parameters<typeof buildPlaybackPrepareCommand>[2]>>;
  playbackOriginModeRef: MutableRefObject<WorkspaceMode>;
  playbackPlayButtonRef: MutableRefObject<HTMLButtonElement | null>;
  playbackSession: PlaybackSession | null;
  playbackSubmittingRef: MutableRefObject<boolean>;
  projectStoryFlows: StoryFlowSnapshot[];
  runtimePersistence: ReturnType<typeof createRuntimeApiClient>;
  selectItem: (selection: GraphSelection | null) => void;
  setDialog: Dispatch<SetStateAction<Dialog>>;
  setPlaybackAnnouncement: Dispatch<SetStateAction<string>>;
  setPlaybackBusy: Dispatch<SetStateAction<boolean>>;
  setPlaybackError: Dispatch<SetStateAction<PlaybackWorkspaceError | null>>;
  setPlaybackLoading: Dispatch<SetStateAction<boolean>>;
  setPlaybackOpen: Dispatch<SetStateAction<boolean>>;
  setPlaybackPreparationFacts: Dispatch<SetStateAction<PlaybackFact[]>>;
  setPlaybackSession: Dispatch<SetStateAction<PlaybackSession | null>>;
  updateWorkspacePreference: (update: Partial<ProjectWorkspacePreference>) => void;
  visibleStoryFlows: StoryFlowSnapshot[];
  workspaceMode: WorkspaceMode;
}

/** Coordinates executable playback while delegating graph and editor navigation to the shell. */
export function createPlaybackController(context: PlaybackControllerContext) {
  const {
    activeStoryFlow, buildEdges: canvasEdges, canonOpen, editStoryNode, focusRenderedNode,
    narrativeStateSnapshot, nodes, openStoryNodeInWorkspace, openTemporalEffectOwner,
    playbackEffectsByFlow, playbackOriginModeRef, playbackPlayButtonRef, playbackSession,
    playbackSubmittingRef, projectStoryFlows, runtimePersistence, selectItem, setDialog,
    setPlaybackAnnouncement, setPlaybackBusy, setPlaybackError, setPlaybackLoading,
    setPlaybackOpen, setPlaybackPreparationFacts, setPlaybackSession,
    updateWorkspacePreference, visibleStoryFlows, workspaceMode
  } = context;


  /** Opens an isolated runtime session without changing the selected authoring projection. */
  async function startPlayback(flowOverride?: StoryFlowSnapshot) {
    const playbackFlow = flowOverride ?? activeStoryFlow;
    playbackOriginModeRef.current = workspaceMode;
    setPlaybackOpen(true);
    setPlaybackLoading(true);
    setPlaybackBusy(false);
    setPlaybackSession(null);
    setPlaybackError(null);
    setPlaybackPreparationFacts([]);
    setPlaybackAnnouncement("Preparing Playback.");
    try {
      if (!playbackFlow || !playbackFlow.flow.entry_node_id || playbackFlow.nodes.length === 0) {
        if (playbackFlow) {
          const missingEntry = !playbackFlow.flow.entry_node_id;
          setPlaybackPreparationFacts([{
            fact_version: 1,
            code: missingEntry ? "missing_entry" : "empty_flow",
            level: "error",
            message: missingEntry ? "Story Flow has no Playback entry." : "Story Flow has no members to play.",
            action: missingEntry ? "Choose one flow member as entry." : "Add at least one flow member and choose an entry.",
            flow_id: playbackFlow.flow.id,
            node_id: null,
            transition_id: null,
            effect_id: null
          }]);
        }
        setPlaybackError({
          kind: "empty",
          message: "Choose an entry beat and add at least one member before starting Playback."
        });
        return;
      }
      const effects = Object.values(playbackEffectsByFlow).flat();
      const prepareCommand = buildPlaybackPrepareCommand(playbackFlow, nodes, effects, visibleStoryFlows, narrativeStateSnapshot);
      const preparation = await runtimePersistence.preparePlayback(prepareCommand);
      if (!preparation.definition) {
        setPlaybackPreparationFacts(preparation.facts);
        setPlaybackError({
          kind: "runtime",
          message: preparation.facts.map((fact) => fact.message).join(" ") || "The Story Flow could not be prepared."
        });
        return;
      }
      const session = await runtimePersistence.startPlayback({
        command_version: 1,
        definition: preparation.definition,
        initial_state: null,
        visit_threshold: 3
      });
      setPlaybackSession(session);
      setPlaybackAnnouncement(`${session.step?.title ?? "Entry beat"} is ready.`);
    } catch (error) {
      setPlaybackError({
        kind: "runtime",
        message: error instanceof Error ? error.message : "Playback could not start."
      });
    } finally {
      setPlaybackLoading(false);
    }
  }



  /** Applies one guarded Story Flow transition or internal Dialogue reply. */
  async function choosePlaybackSelection(selection: PlaybackSelection) {
    if (!playbackSession || playbackSubmittingRef.current) return;
    playbackSubmittingRef.current = true;
    setPlaybackBusy(true);
    setPlaybackError(null);
    try {
      const nextSession = await runtimePersistence.choosePlayback(playbackSession.id, {
            command_version: 1,
            source_revision: playbackSession.source_revision,
            transition_id: selection.kind === "transition" ? selection.id : null,
            dialogue_option_id: selection.kind === "dialogue" ? selection.id : null,
            allow_visit_threshold: false
          });
      setPlaybackSession(nextSession);
      setPlaybackAnnouncement(playbackSessionAnnouncement(
        nextSession,
        selection.kind === "dialogue" ? "Selected reply in" : "Advanced to"
      ));
    } catch (error) {
      setPlaybackError({
        kind: "runtime",
        message: error instanceof Error ? error.message : "The selected choice could not be applied."
      });
    } finally {
      playbackSubmittingRef.current = false;
      setPlaybackBusy(false);
    }
  }



  /** Restores the latest runtime-owned trace boundary and discards that future. */
  async function backPlayback() {
    if (!playbackSession || playbackSession.trace.length === 0 || playbackSubmittingRef.current) return;
    playbackSubmittingRef.current = true;
    setPlaybackBusy(true);
    setPlaybackError(null);
    try {
      const previousSession = await runtimePersistence.backPlayback(playbackSession.id, {
            command_version: 1,
            source_revision: playbackSession.source_revision
          });
      setPlaybackSession(previousSession);
      setPlaybackAnnouncement(playbackSessionAnnouncement(previousSession, "Returned to", false));
    } catch (error) {
      setPlaybackError({
        kind: "runtime",
        message: error instanceof Error ? error.message : "Playback could not move back."
      });
    } finally {
      playbackSubmittingRef.current = false;
      setPlaybackBusy(false);
    }
  }



  /** Rebuilds the current definition before resetting all transient traversal state. */
  async function restartPlayback() {
    if (!playbackSession || playbackSubmittingRef.current) return;
    playbackSubmittingRef.current = true;
    setPlaybackBusy(true);
    setPlaybackError(null);
    try {
      if (!activeStoryFlow) throw new Error("The selected Story Flow is no longer available.");
      const effects = Object.values(playbackEffectsByFlow).flat();
      const preparation = await runtimePersistence.preparePlayback(
        buildPlaybackPrepareCommand(activeStoryFlow, nodes, effects, visibleStoryFlows, narrativeStateSnapshot)
      );
      if (!preparation.definition) {
        throw new Error(preparation.facts.map((fact) => fact.message).join(" ") || "The Story Flow could not be prepared.");
      }
      const restarted = await runtimePersistence.restartPlayback(playbackSession.id, {
        command_version: 1,
        definition: preparation.definition,
        initial_state: null,
        visit_threshold: playbackSession.visit_threshold
      });
      setPlaybackSession(restarted);
      setPlaybackAnnouncement(playbackSessionAnnouncement(restarted, "Restarted at", false));
    } catch (error) {
      setPlaybackError({
        kind: "runtime",
        message: error instanceof Error ? error.message : "Playback could not restart."
      });
    } finally {
      playbackSubmittingRef.current = false;
      setPlaybackBusy(false);
    }
  }



  /** Suspends Playback and resolves one runtime owner through existing authoring routes. */
  function openPlaybackSource(target: PlaybackSourceTarget) {
    if (!activeStoryFlow) return;
    setPlaybackOpen(false);
    if (target.kind === "fact") {
      if (target.fact.transition_id) {
        openPlaybackTransitionSource(target.fact.transition_id);
        return;
      }
      if (target.fact.effect_id) {
        openPlaybackEffectSource(target.fact.effect_id);
        return;
      }
      if (target.fact.node_id) {
        openPlaybackNodeSource(target.fact.node_id, "edit");
        return;
      }
      updateWorkspacePreference({ mode: "flow", activeFlowId: target.fact.flow_id ?? activeStoryFlow.flow.id });
      selectItem(null);
      return;
    }
    if (target.kind === "transition") {
      openPlaybackTransitionSource(target.transitionId);
      return;
    }
    if (target.kind === "effect") {
      openPlaybackEffectSource(target.effectId);
      return;
    }
    openPlaybackNodeSource(target.nodeId, target.mode);
  }



  function openPlaybackEffectSource(effectId: string) {
    if (!activeStoryFlow) return;
    const narrativeOwner = narrativeOwnerForPlaybackEffect(narrativeStateSnapshot, effectId);
    if (narrativeOwner) {
      openTemporalEffectOwner(narrativeOwner);
      return;
    }
    const effect = (playbackEffectsByFlow[activeStoryFlow.flow.id] ?? [])
      .find((candidate) => candidate.id === effectId);
    if (effect?.owner_transition_id) {
      openPlaybackTransitionSource(effect.owner_transition_id);
    } else if (effect?.owner_node_id) {
      openPlaybackNodeSource(effect.owner_node_id, "edit");
    } else {
      updateWorkspacePreference({ mode: "flow", activeFlowId: activeStoryFlow.flow.id });
      selectItem(null);
    }
  }



  function openPlaybackTransitionSource(transitionId: string) {
    if (!activeStoryFlow) return;
    const transition = activeStoryFlow.transitions.find((candidate) => candidate.id === transitionId);
    updateWorkspacePreference({ mode: "flow", activeFlowId: activeStoryFlow.flow.id });
    selectItem({ type: "edge", id: `story-flow:${transitionId}` });
    const sourceNode = transition
      ? nodes.find((node) => (node.data.canonicalNodeId ?? node.id) === transition.source_node_id && node.id === transition.source_node_id)
      : null;
    if (sourceNode) {
      const projection = projectGraphForWorkspace(nodes, canvasEdges, "flow", activeStoryFlow, projectStoryFlows);
      window.setTimeout(() => focusRenderedNode(nodeForWorkspaceFocus(sourceNode, projection.nodes, "flow")), 100);
    }
  }



  function openPlaybackNodeSource(
    nodeId: string,
    mode: "edit" | "flow" | "relationships" | "story"
  ) {
    const node = nodes.find((candidate) => candidate.id === nodeId)
      ?? nodes.find((candidate) => candidate.data.canonicalNodeId === nodeId);
    if (!node) return;
    if (mode === "edit") {
      editStoryNode(node);
      return;
    }
    if (mode === "story") {
      updateWorkspacePreference({ mode: "story", activeFlowId: activeStoryFlow?.flow.id ?? null });
      selectItem({ type: "node", id: node.id });
      window.setTimeout(() => {
        const beat = [...document.querySelectorAll<HTMLElement>("[data-story-node-id]")]
          .find((candidate) => candidate.dataset.storyNodeId === nodeId);
        beat?.scrollIntoView?.({ block: "center" });
        beat?.focus();
      }, 100);
      return;
    }
    openStoryNodeInWorkspace(node, mode);
  }



  /** Resumes unchanged definitions or exposes a stale session that requires Restart. */
  async function returnToPlayback() {
    if (!playbackSession || !activeStoryFlow) return;
    setDialog(null);
    const effects = Object.values(playbackEffectsByFlow).flat();
    const observedRevision = buildPlaybackPrepareCommand(activeStoryFlow, nodes, effects, visibleStoryFlows, narrativeStateSnapshot).source_revision;
    setPlaybackOpen(true);
    setPlaybackBusy(true);
    try {
      const inspectedSession = await runtimePersistence.inspectPlayback(playbackSession.id, observedRevision);
      setPlaybackSession(inspectedSession);
      const stale = inspectedSession.facts.some((fact) => fact.code === "stale_source_revision");
      setPlaybackAnnouncement(stale
        ? "Authored source changed. Restart Playback to use the new definition."
        : `${inspectedSession.step?.title ?? "Playback beat"} is ready.`);
    } catch (error) {
      setPlaybackError({
        kind: "runtime",
        message: error instanceof Error ? error.message : "Playback revision inspection failed."
      });
    } finally {
      setPlaybackBusy(false);
    }
  }



  /** Closes the transient workspace and restores keyboard focus at its authoring origin. */
  function exitPlayback() {
    setPlaybackOpen(false);
    setPlaybackSession(null);
    setPlaybackError(null);
    setPlaybackPreparationFacts([]);
    setPlaybackAnnouncement("");
    updateWorkspacePreference({ mode: playbackOriginModeRef.current });
    window.setTimeout(() => {
      const canonSelection = canonOpen
        ? document.querySelector<HTMLElement>('.canon-workspace [aria-selected="true"]')
        : null;
      (canonSelection ?? playbackPlayButtonRef.current)?.focus();
    }, 0);
  }

  return { backPlayback, choosePlaybackSelection, exitPlayback, openPlaybackEffectSource, openPlaybackNodeSource, openPlaybackSource, openPlaybackTransitionSource, restartPlayback, returnToPlayback, startPlayback };
}
