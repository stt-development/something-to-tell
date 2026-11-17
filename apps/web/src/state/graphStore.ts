import {
  addEdge,
  applyEdgeChanges,
  applyNodeChanges,
  type Connection,
  type Edge,
  type EdgeChange,
  MarkerType,
  type Node,
  type NodeChange,
  reconnectEdge as reconnectReactFlowEdge,
  type XYPosition
} from "@xyflow/react";
import { create } from "zustand";
import type { ProjectSessionState } from "@something-to-tell/contracts/project-session";
import type { ProjectManifestV2 } from "@something-to-tell/contracts/project-manifest";
import { COLLAPSED_FRAME_SIZE, enforceFrameMinimums, fitFrameToContent, FRAME_HEADER_HEIGHT, FRAME_MIN_SIZE, FRAME_PADDING, locationPlacementWouldCycle, moveNodePlacement } from "../composition/layout";
import { allowsComposition } from "../composition/contracts";
import type { DialogueDocument } from "../dialogue/contracts";
import type { QuestDocument } from "../quest/contracts";
import type { PlaybackTypedEffect } from "../playback/contracts";
import type { RuntimeGraphPersistence, RuntimeGraphSnapshot } from "../runtime/apiClient";
import type { StoryFlowSnapshot } from "../story-flow/contracts";
import type { DialogueTransitionDraft, EdgeDraft, FrameDraft, NarrativeEdgeData, NarrativeIssue, NarrativeNodeData, NarrativeProject, NodeDraft, ProjectDraft, QuestTransitionDraft, Selection } from "../types";
import {
  canonicalNodeCount,
  canonicalNodeId as canonicalId,
  createLocalNode,
  nextNodePosition,
  relationshipEdgeStyle as edgeStyle,
  resolveConnectionHandles,
  samePlacementGeometry
} from "./graphGeometry";

interface ProjectGraph {
  nodes: Node<NarrativeNodeData>[];
  edges: Edge<NarrativeEdgeData>[];
  issues: NarrativeIssue[];
}

interface GraphState {
  projects: NarrativeProject[];
  activeProjectId: string;
  activeSessionId: string | null;
  activeProjectSession: ProjectSessionState | null;
  activeAutosave: { enabled: boolean; interval_seconds: number } | null;
  activeProjectManifest: ProjectManifestV2 | null;
  freshProjectId: string | null;
  graphs: Record<string, ProjectGraph>;
  playbackEffectsByFlow: Record<string, PlaybackTypedEffect[]>;
  storyFlowsByProject: Record<string, StoryFlowSnapshot[]>;
  runtimeError: string | null;
  runtimePersistence: RuntimeGraphPersistence | null;
  runtimeStatus: "idle" | "loading" | "ready" | "fallback";
  selection: Selection | null;
  addEdgeBetweenNodes: (draft: EdgeDraft) => void;
  addManualNode: (draft: NodeDraft) => void;
  addNodeAt: (draft: NodeDraft, position: XYPosition) => void;
  addFrameAt: (draft: FrameDraft, position: XYPosition, size: { height: number; width: number }) => void;
  applyBootstrapNode: (node: Node<NarrativeNodeData>) => boolean;
  reconcileRuntimeNode: (node: Node<NarrativeNodeData>) => void;
  reconcileRuntimeEdge: (edge: Edge<NarrativeEdgeData>) => void;
  addLinkedInstance: (canonicalNodeId: string, frameId: string) => { message: string; valid: boolean };
  addFactionMember: (factionId: string, characterId: string) => { message: string; valid: boolean };
  createProject: (draft: ProjectDraft) => void;
  createDialogueTransition: (draft: DialogueTransitionDraft) => void;
  createQuestTransition: (draft: QuestTransitionDraft) => void;
  deleteEdge: (edgeId: string) => void;
  removePersistedEdge: (edgeId: string) => void;
  deleteNode: (nodeId: string) => void;
  removeInstance: (visualNodeId: string) => void;
  removeFactionMember: (factionId: string, characterId: string) => { message: string; valid: boolean };
  getActiveGraph: () => ProjectGraph;
  loadRuntimeSnapshot: (loadSnapshot: (isCurrent: () => boolean) => Promise<RuntimeGraphSnapshot>) => Promise<boolean>;
  onEdgesChange: (changes: EdgeChange<Edge<NarrativeEdgeData>>[]) => void;
  onConnect: (connection: Connection) => void;
  onNodesChange: (changes: NodeChange<Node<NarrativeNodeData>>[]) => void;
  completeNodeDrop: (nodeId: string, targetFrameId: string | null, previousNodes: Node<NarrativeNodeData>[]) => { message: string; valid: boolean };
  completeGroupMove: (previousNodes: Node<NarrativeNodeData>[]) => void;
  completeNodeResize: (previousNodes: Node<NarrativeNodeData>[]) => void;
  fitFrame: (frameId: string) => void;
  toggleFrameCollapse: (frameId: string) => void;
  reconnectEdge: (edgeId: string, connection: Partial<Connection>) => void;
  selectItem: (selection: Selection | null) => void;
  setActiveProject: (projectId: string) => void;
  setFreshProjectId: (projectId: string | null) => void;
  attachProjectSession: (sessionId: string) => void;
  markProjectSessionDirty: () => void;
  setProjectSessionState: (session: ProjectSessionState) => void;
  closeActiveProject: () => void;
  setRuntimePersistence: (persistence: RuntimeGraphPersistence | null) => void;
  updateEdge: (edgeId: string, draft: EdgeDraft) => void;
  updateDialogueDocument: (nodeId: string, document: DialogueDocument) => void;
  updateQuestDocument: (nodeId: string, document: QuestDocument) => void;
  updateNode: (nodeId: string, draft: NodeDraft) => void;
}

function emptyGraph(): ProjectGraph {
  return { nodes: [], edges: [], issues: [] };
}

function projectIdFromName(name: string, count: number) {
  const slug = name
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/(^-|-$)/g, "");

  return `project-${slug || "untitled"}-${count + 1}`;
}

function projectPathFromDraft(workspaceOrPath: string | undefined, name: string) {
  const base = (workspaceOrPath || "~/Stories").trim() || "~/Stories";
  if (base.endsWith(".narrative")) {
    return base;
  }

  const folderName = name.trim().replace(/[^a-zA-Z0-9]+/g, "") || "Untitled";
  return `${base.replace(/\/+$/g, "")}/${folderName}.narrative`;
}

function activeGraph(state: Pick<GraphState, "activeProjectId" | "graphs">) {
  return state.graphs[state.activeProjectId] ?? emptyGraph();
}

type GraphSet = (partial: Partial<GraphState> | ((state: GraphState) => Partial<GraphState>)) => void;

// A transient request ticket owned by this singleton store, never a second graph/session record.
let snapshotLoadGeneration = 0;

/** A context switch retires the old loader's pending UI, not a newer request's state. */
function retiredSnapshotLoadStatus(state: GraphState, projectId = state.activeProjectId): Partial<GraphState> {
  return state.runtimeStatus === "loading" ? { runtimeStatus: state.graphs[projectId] ? "ready" : "idle" } : {};
}

// The store is the frontend integration point for later runtime-backed CRUD.
export const useGraphStore = create<GraphState>((set, get) => ({
  projects: [],
  activeProjectId: "",
  activeSessionId: null,
  activeProjectSession: null,
  activeAutosave: null,
  activeProjectManifest: null,
  freshProjectId: null,
  graphs: {},
  playbackEffectsByFlow: {},
  storyFlowsByProject: {},
  runtimeError: null,
  runtimePersistence: null,
  runtimeStatus: "idle",
  selection: null,
  addEdgeBetweenNodes: (draft) => {
    const activeProjectId = get().activeProjectId;
    const graph = get().getActiveGraph();
    const source = graph.nodes.find((node) => node.id === draft.source);
    const target = graph.nodes.find((node) => node.id === draft.target);

    if (!source || !target || source.id === target.id) {
      return;
    }
    const handles = resolveConnectionHandles(source, target, draft, graph.nodes);

    const edgeId = `edge-${source.id}-${target.id}-${graph.edges.length + 1}`;
    const edge: Edge<NarrativeEdgeData> = {
      id: edgeId,
      source: source.id,
      target: target.id,
      sourceHandle: handles.sourceHandle,
      targetHandle: handles.targetHandle,
      label: draft.label,
      data: { label: draft.label, relationshipType: draft.relationshipType ?? "depends_on" },
      reconnectable: true,
      markerEnd: { type: MarkerType.ArrowClosed },
      style: edgeStyle()
    };
    set((state) => {
      const current = activeGraph(state);
      return {
        graphs: {
          ...state.graphs,
          [state.activeProjectId]: {
            ...current,
            edges: addEdge(
              edge,
              current.edges
            )
          }
        },
        selection: { type: "edge", id: edgeId }
      };
    });
    persistRuntimeMutation(
      runtimeWriter(get())?.createEdge(activeProjectId, edge),
      (savedEdge) => replaceEdgeId(set, activeProjectId, edgeId, savedEdge),
      set
    );
  },
  addManualNode: (draft) => {
    get().addNodeAt(draft, nextNodePosition(canonicalNodeCount(get().getActiveGraph().nodes)));
  },
  addNodeAt: (draft, position) => {
    const activeProjectId = get().activeProjectId;
    const graph = get().getActiveGraph();
    const nextIndex = canonicalNodeCount(graph.nodes) + 1;
    const node: Node<NarrativeNodeData> = {
      id: `node-manual-${nextIndex}`,
      type: "narrative",
      position,
      width: 260,
      height: 156,
      data: {
        kind: draft.kind,
        label: draft.title,
        title: draft.title,
        summary: draft.summary,
        tags: draft.tags
      }
    };

    set((state) => ({
      graphs: {
        ...state.graphs,
        [state.activeProjectId]: {
          ...activeGraph(state),
          nodes: [...activeGraph(state).nodes, node]
        }
      },
      selection: { type: "node", id: node.id }
    }));
    persistRuntimeMutation(
      runtimeWriter(get())?.createNode(activeProjectId, node),
      (savedNode) => replaceNodeId(set, activeProjectId, node.id, savedNode),
      set
    );
  },
  addFrameAt: (draft, position, size) => {
    const activeProjectId = get().activeProjectId;
    const graph = get().getActiveGraph();
    const node: Node<NarrativeNodeData> = {
      id: `node-manual-${canonicalNodeCount(graph.nodes) + 1}`,
      type: "narrative",
      position,
      width: size.width,
      height: size.height,
      data: {
        isFrame: true,
        kind: draft.kind,
        label: draft.title,
        title: draft.title,
        summary: draft.summary,
        tags: draft.tags
      }
    };
    set((state) => ({
      graphs: {
        ...state.graphs,
        [state.activeProjectId]: {
          ...activeGraph(state),
          nodes: [...activeGraph(state).nodes, node]
        }
      },
      selection: { type: "node", id: node.id }
    }));
    persistRuntimeMutation(
      runtimeWriter(get())?.createFrame(activeProjectId, node),
      (savedNode) => replaceNodeId(set, activeProjectId, node.id, savedNode),
      set
    );
  },
  applyBootstrapNode: (node) => {
    const state = get();
    if (state.getActiveGraph().nodes.length > 0) return false;
    // Runtime bootstrap already persisted this node; reconciliation must not issue another write.
    set((current) => ({
      graphs: {
        ...current.graphs,
        [current.activeProjectId]: {
          ...activeGraph(current),
          nodes: [node]
        }
      },
      selection: { type: "node", id: node.id }
    }));
    return true;
  },
  reconcileRuntimeNode: (node) => {
    // Atomic cross-aggregate commands already persisted this canonical node.
    set((state) => {
      const graph = activeGraph(state);
      if (graph.nodes.some((candidate) => candidate.id === node.id)) return state;
      return {
        graphs: {
          ...state.graphs,
          [state.activeProjectId]: { ...graph, nodes: [...graph.nodes, node] }
        },
        selection: { type: "node", id: node.id }
      };
    });
  },
  reconcileRuntimeEdge: (edge) => {
    // Atomic cross-aggregate commands already persisted this semantic edge.
    set((state) => {
      const graph = activeGraph(state);
      return {
        graphs: {
          ...state.graphs,
          [state.activeProjectId]: {
            ...graph,
            edges: graph.edges.map((candidate) => candidate.id === edge.id ? edge : candidate)
          }
        },
        selection: { type: "edge", id: edge.id }
      };
    });
  },
  addLinkedInstance: (canonicalNodeId, frameId) => {
    const graph = get().getActiveGraph();
    const canonical = graph.nodes.find((node) => canonicalId(node) === canonicalNodeId);
    const frame = graph.nodes.find((node) => node.id === frameId && node.data.isFrame);
    if (!canonical || !frame) return { message: "Node or frame not found", valid: false };
    if (!allowsComposition(frame.data.kind, canonical.data.kind)) {
      return { message: `${frame.data.kind} cannot contain ${canonical.data.kind}`, valid: false };
    }
    if (locationPlacementWouldCycle(graph.nodes, canonicalNodeId, frame.id)) {
      return { message: "Location containment cannot create a cycle", valid: false };
    }
    if (graph.nodes.some((node) => canonicalId(node) === canonicalNodeId && node.parentId === frameId)) {
      return { message: `${canonical.data.title} is already in ${frame.data.title}`, valid: false };
    }
    // Adding to a compact Scene first restores its saved geometry so the new
    // placement can participate in normal adaptive frame sizing.
    if (frame.data.presentationState === "collapsed") {
      get().toggleFrameCollapse(frame.id);
      return get().addLinkedInstance(canonicalNodeId, frameId);
    }
    const childIndex = graph.nodes.filter((node) => node.parentId === frameId).length;
    const position = {
      x: FRAME_PADDING + (childIndex % 2) * 284,
      y: FRAME_HEADER_HEIGHT + FRAME_PADDING + Math.floor(childIndex / 2) * 180
    };
    const localId = `placement-local-${canonicalNodeId}-${graph.nodes.length + 1}`;
    const linked: Node<NarrativeNodeData> = {
      ...canonical,
      id: localId,
      parentId: frameId,
      position,
      data: {
        ...canonical.data,
        canonicalNodeId,
        containerNodeId: canonicalId(frame),
        isLinkedInstance: true,
        placementId: undefined,
        rootPlacementId: undefined
      }
    };
    const before = graph.nodes;
    const after = enforceFrameMinimums([...graph.nodes, linked]);
    set((state) => ({
      graphs: { ...state.graphs, [state.activeProjectId]: { ...activeGraph(state), nodes: after } },
      selection: { type: "node", id: localId }
    }));
    const writer = runtimeWriter(get());
    if (writer) {
      persistRuntimeMutation(
        writer.createLinkedPlacement(get().activeProjectId, canonicalNodeId, canonicalId(frame), position, { width: linked.width ?? 260, height: linked.height ?? 156 }),
        (placement) => replaceVisualPlacementId(set, get().activeProjectId, localId, placement.id),
        set,
        () => set((state) => ({ graphs: { ...state.graphs, [state.activeProjectId]: { ...activeGraph(state), nodes: before } }, selection: null }))
      );
    }
    return { message: `Linked ${canonical.data.title} to ${frame.data.title}`, valid: true };
  },
  addFactionMember: (factionId, characterId) => {
    const graph = get().getActiveGraph();
    const factionPlacement = graph.nodes.find((node) => node.id === factionId);
    const characterPlacement = graph.nodes.find((node) => node.id === characterId);
    const factionCanonicalId = factionPlacement ? canonicalId(factionPlacement) : factionId;
    const characterCanonicalId = characterPlacement ? canonicalId(characterPlacement) : characterId;
    const faction = graph.nodes.find((node) => canonicalId(node) === factionCanonicalId && !node.data.isLinkedInstance);
    const character = graph.nodes.find((node) => canonicalId(node) === characterCanonicalId && !node.data.isLinkedInstance);
    if (!faction || faction.data.kind !== "Faction") return { message: "Faction not found", valid: false };
    if (!character || character.data.kind !== "Character") return { message: "Only Characters can join a Faction", valid: false };
    if (graph.edges.some((edge) => edge.data?.relationshipType === "member_of" && edge.source === characterCanonicalId && edge.target === factionCanonicalId)) {
      return { message: "Character is already a member", valid: false };
    }
    const localEdgeId = `membership:${characterCanonicalId}:${factionCanonicalId}`;
    const membership: Edge<NarrativeEdgeData> = {
      id: localEdgeId,
      source: characterCanonicalId,
      target: factionCanonicalId,
      label: "member of",
      data: { canvasVisibility: "hidden", label: "member of", relationshipType: "member_of" }
    };
    set((state) => {
      const current = activeGraph(state);
      return {
        graphs: { ...state.graphs, [state.activeProjectId]: { ...current, edges: [...current.edges, membership] } },
        selection: { type: "node", id: factionId }
      };
    });
    const projectId = get().activeProjectId;
    persistRuntimeMutation(
      runtimeWriter(get())?.createFactionMembership(factionCanonicalId, characterCanonicalId),
      (saved) => replaceEdgeId(set, projectId, localEdgeId, saved),
      set
    );
    return { message: `${character.data.title} added`, valid: true };
  },
  createProject: (draft) => {
    const id = projectIdFromName(draft.name, get().projects.length);
    const project: NarrativeProject = {
      id,
      name: draft.name,
      description: draft.description,
      path: projectPathFromDraft(draft.path, draft.name),
      status: "open",
      updatedAt: new Date().toISOString().slice(0, 10)
    };
    set((state) => ({
      activeProjectId: id,
      graphs: { ...state.graphs, [id]: emptyGraph() },
      projects: [...state.projects, project],
      selection: { type: "project", id }
    }));
    persistRuntimeMutation(
      runtimeWriter(get())?.createProject({ ...draft, path: project.path }),
      (savedProject) => replaceProjectId(set, id, savedProject),
      set
    );
  },
  createDialogueTransition: (draft) => {
    const activeProjectId = get().activeProjectId;
    const graph = get().getActiveGraph();
    const selectedDialogue = graph.nodes.find((node) => node.id === draft.dialogueNodeId && node.data.kind === "Dialogue");
    const dialogueNodeId = selectedDialogue ? canonicalId(selectedDialogue) : draft.dialogueNodeId;
    const dialogue = graph.nodes.find((node) => canonicalId(node) === dialogueNodeId && !node.data.isLinkedInstance)
      ?? selectedDialogue;
    const originExists = draft.document.elements.some((element) =>
      element.id === draft.originId || (element.kind === "choice" && element.options.some((option) => option.id === draft.originId))
    );
    if (!dialogue || !originExists || Boolean(draft.targetNodeId) === Boolean(draft.newTarget)) {
      return;
    }
    const newTarget = draft.newTarget
      ? createLocalNode(
          draft.newTarget,
          `node-manual-${canonicalNodeCount(graph.nodes) + 1}`,
          nextNodePosition(canonicalNodeCount(graph.nodes))
        )
      : undefined;
    const selectedTarget = newTarget ?? graph.nodes.find((node) => node.id === draft.targetNodeId);
    const target = selectedTarget && !newTarget
      ? graph.nodes.find((node) => canonicalId(node) === canonicalId(selectedTarget) && !node.data.isLinkedInstance) ?? selectedTarget
      : selectedTarget;
    if (!target || canonicalId(target) === dialogueNodeId) {
      return;
    }
    const handles = resolveConnectionHandles(dialogue, target, {}, graph.nodes);
    const localEdgeId = `edge-dialogue-${draft.originId}-${graph.edges.length + 1}`;
    const edge: Edge<NarrativeEdgeData> = {
      id: localEdgeId,
      source: dialogueNodeId,
      sourceHandle: handles.sourceHandle,
      target: canonicalId(target),
      targetHandle: handles.targetHandle,
      label: draft.label,
      data: { dialogueElementId: draft.originId, label: draft.label, relationshipType: draft.relationshipType },
      markerEnd: { type: MarkerType.ArrowClosed },
      reconnectable: true,
      style: edgeStyle()
    };
    // Target and edge enter fallback state together, matching runtime transaction semantics.
    set((state) => {
      const current = activeGraph(state);
      return {
        graphs: {
          ...state.graphs,
          [state.activeProjectId]: {
            ...current,
            nodes: (newTarget ? [...current.nodes, newTarget] : current.nodes).map((node) =>
              canonicalId(node) === dialogueNodeId ? { ...node, data: { ...node.data, dialogueDocument: draft.document } } : node
            ),
            edges: [...current.edges, edge]
          }
        },
        selection: { type: "node", id: draft.dialogueNodeId }
      };
    });
    const canonicalDraft = { ...draft, dialogueNodeId, targetNodeId: target ? canonicalId(target) : undefined };
    persistRuntimeMutation(
      runtimeWriter(get())?.createDialogueTransition(activeProjectId, canonicalDraft, edge, newTarget),
      (saved) => {
        if (newTarget) {
          replaceNodeId(set, activeProjectId, newTarget.id, saved.targetNode);
        }
        replaceEdgeId(set, activeProjectId, localEdgeId, saved.edge);
      },
      set
    );
  },
  createQuestTransition: (draft) => {
    const activeProjectId = get().activeProjectId;
    const graph = get().getActiveGraph();
    const selectedQuest = graph.nodes.find((node) => node.id === draft.questNodeId && node.data.kind === "Quest");
    const questNodeId = selectedQuest ? canonicalId(selectedQuest) : draft.questNodeId;
    const quest = graph.nodes.find((node) => canonicalId(node) === questNodeId && !node.data.isLinkedInstance) ?? selectedQuest;
    const originExists = draft.document.stages.some((stage) =>
      stage.id === draft.stageId && stage.branches.some((branch) => branch.id === draft.branchId)
    );
    if (!quest || !originExists || Boolean(draft.targetNodeId) === Boolean(draft.newTarget)) return;

    const newTarget = draft.newTarget
      ? createLocalNode(draft.newTarget, `node-manual-${canonicalNodeCount(graph.nodes) + 1}`, nextNodePosition(canonicalNodeCount(graph.nodes)))
      : undefined;
    const selectedTarget = newTarget ?? graph.nodes.find((node) => node.id === draft.targetNodeId);
    const target = selectedTarget && !newTarget
      ? graph.nodes.find((node) => canonicalId(node) === canonicalId(selectedTarget) && !node.data.isLinkedInstance) ?? selectedTarget
      : selectedTarget;
    if (!target || canonicalId(target) === questNodeId) return;

    const handles = resolveConnectionHandles(quest, target, {}, graph.nodes);
    const localEdgeId = `edge-quest-${draft.branchId}-${graph.edges.length + 1}`;
    const edge: Edge<NarrativeEdgeData> = {
      id: localEdgeId,
      source: questNodeId,
      sourceHandle: handles.sourceHandle,
      target: canonicalId(target),
      targetHandle: handles.targetHandle,
      label: draft.label,
      data: {
        label: draft.label,
        questBranchId: draft.branchId,
        questStageId: draft.stageId,
        relationshipType: draft.relationshipType
      },
      markerEnd: { type: MarkerType.ArrowClosed },
      reconnectable: true,
      style: edgeStyle()
    };
    // The local aggregate, optional target, and edge mirror one runtime transaction.
    set((state) => {
      const current = activeGraph(state);
      return {
        graphs: {
          ...state.graphs,
          [state.activeProjectId]: {
            ...current,
            nodes: (newTarget ? [...current.nodes, newTarget] : current.nodes).map((node) =>
              canonicalId(node) === questNodeId ? { ...node, data: { ...node.data, questDocument: draft.document } } : node
            ),
            edges: [...current.edges, edge]
          }
        },
        selection: { type: "node", id: draft.questNodeId }
      };
    });
    const canonicalDraft = { ...draft, questNodeId, targetNodeId: canonicalId(target) };
    persistRuntimeMutation(
      runtimeWriter(get())?.createQuestTransition(activeProjectId, canonicalDraft, edge, newTarget),
      (saved) => {
        if (newTarget) replaceNodeId(set, activeProjectId, newTarget.id, saved.targetNode);
        replaceEdgeId(set, activeProjectId, localEdgeId, saved.edge);
      },
      set
    );
  },
  deleteEdge: (edgeId) => {
    set((state) => {
      const graph = activeGraph(state);
      return {
        graphs: {
          ...state.graphs,
            [state.activeProjectId]: {
              ...graph,
              edges: graph.edges.filter((edge) => edge.id !== edgeId),
              issues: graph.issues.filter((issue) => issue.edgeId !== edgeId)
            }
          },
        selection: null
      };
    });
    persistRuntimeMutation(runtimeWriter(get())?.deleteEdge(edgeId), undefined, set);
  },
  removePersistedEdge: (edgeId) => {
    // The migration transaction already removed the runtime relationship.
    set((state) => {
      const graph = activeGraph(state);
      return {
        graphs: {
          ...state.graphs,
          [state.activeProjectId]: {
            ...graph,
            edges: graph.edges.filter((edge) => edge.id !== edgeId),
            issues: graph.issues.filter((issue) => issue.edgeId !== edgeId)
          }
        },
        selection: null
      };
    });
  },
  deleteNode: (nodeId) => {
    const graphBeforeDeletion = get().getActiveGraph();
    const selectionBeforeDeletion = get().selection;
    const node = graphBeforeDeletion.nodes.find((candidate) => candidate.id === nodeId);
    const canonicalNodeId = node ? canonicalId(node) : nodeId;
    set((state) => {
      const graph = activeGraph(state);
      return {
        graphs: {
          ...state.graphs,
          [state.activeProjectId]: {
            nodes: graph.nodes.filter((node) => canonicalId(node) !== canonicalNodeId),
            edges: graph.edges.filter((edge) => edge.source !== canonicalNodeId && edge.target !== canonicalNodeId),
            issues: graph.issues.filter((issue) => issue.nodeId !== canonicalNodeId && !graph.edges.some((edge) => (edge.source === canonicalNodeId || edge.target === canonicalNodeId) && edge.id === issue.edgeId))
          }
        },
        selection: null
      };
    });
    persistRuntimeMutation(
      runtimeWriter(get())?.deleteEntity(canonicalNodeId),
      undefined,
      set,
      () => set((state) => ({
        graphs: { ...state.graphs, [state.activeProjectId]: graphBeforeDeletion },
        selection: selectionBeforeDeletion
      }))
    );
  },
  removeInstance: (visualNodeId) => {
    const graph = get().getActiveGraph();
    const instance = graph.nodes.find((node) => node.id === visualNodeId && node.data.isLinkedInstance);
    if (!instance) return;
    const before = graph.nodes;
    set((state) => ({
      graphs: { ...state.graphs, [state.activeProjectId]: { ...activeGraph(state), nodes: activeGraph(state).nodes.filter((node) => node.id !== visualNodeId) } },
      selection: null
    }));
    if (instance.data.placementId) {
      persistRuntimeMutation(
        runtimeWriter(get())?.removePlacement(instance.data.placementId),
        undefined,
        set,
        () => set((state) => ({ graphs: { ...state.graphs, [state.activeProjectId]: { ...activeGraph(state), nodes: before } } }))
      );
    }
  },
  removeFactionMember: (factionId, characterId) => {
    const graph = get().getActiveGraph();
    const faction = graph.nodes.find((node) => node.id === factionId);
    const character = graph.nodes.find((node) => node.id === characterId);
    const factionCanonicalId = faction ? canonicalId(faction) : factionId;
    const characterCanonicalId = character ? canonicalId(character) : characterId;
    const membership = graph.edges.find((edge) => edge.data?.relationshipType === "member_of"
      && edge.source === characterCanonicalId && edge.target === factionCanonicalId);
    if (!membership) return { message: "Faction membership not found", valid: false };
    set((state) => {
      const current = activeGraph(state);
      return {
        graphs: { ...state.graphs, [state.activeProjectId]: { ...current, edges: current.edges.filter((edge) => edge.id !== membership.id) } },
        selection: { type: "node", id: factionId }
      };
    });
    persistRuntimeMutation(runtimeWriter(get())?.removeFactionMembership(factionCanonicalId, characterCanonicalId), undefined, set);
    return { message: `${character?.data.title ?? "Character"} removed`, valid: true };
  },
  getActiveGraph: () => activeGraph(get()),
  loadRuntimeSnapshot: async (loadSnapshot) => {
    const generation = ++snapshotLoadGeneration;
    const { activeProjectId: projectId, activeSessionId: sessionId } = get();
    const isCurrent = () => generation === snapshotLoadGeneration
      && get().activeProjectId === projectId && get().activeSessionId === sessionId;
    set({ runtimeError: null, runtimeStatus: "loading" });
    try {
      const snapshot = await loadSnapshot(isCurrent);
      if (!isCurrent()) return false;
      if (!snapshot.activeProjectId) {
        set({ runtimeError: null, runtimeStatus: "fallback" });
        return false;
      }
      // New identity, metadata and complete graph publish together; never partially editable.
      set((state) => runtimeSnapshotState(state, snapshot, null));
      return true;
    } catch (error) {
      if (!isCurrent()) return false;
      set({
        runtimeError: error instanceof Error ? error.message : "Runtime graph loading failed",
        runtimeStatus: "fallback"
      });
      return false;
    }
  },
  onEdgesChange: (changes) => {
    set((state) => {
      const graph = activeGraph(state);
      return {
        graphs: {
          ...state.graphs,
          [state.activeProjectId]: {
            ...graph,
            edges: applyEdgeChanges(changes, graph.edges)
          }
        }
      };
    });
  },
  onConnect: (connection) => {
    if (!connection.source || !connection.target || connection.source === connection.target) {
      return;
    }
    const source = get().getActiveGraph().nodes.find((node) => node.id === connection.source);
    const target = get().getActiveGraph().nodes.find((node) => node.id === connection.target);
    if (!source || !target) {
      return;
    }
    get().addEdgeBetweenNodes({
      source: connection.source,
      target: connection.target,
      label: `${source.data.kind.toLowerCase()} link`,
      relationshipType: "depends_on",
      sourceHandle: connection.sourceHandle,
      targetHandle: connection.targetHandle
    });
  },
  onNodesChange: (changes) => {
    set((state) => {
      const graph = activeGraph(state);
      return {
        graphs: {
          ...state.graphs,
          [state.activeProjectId]: {
            ...graph,
            nodes: enforceFrameMinimums(applyNodeChanges(changes, graph.nodes))
          }
        }
      };
    });
  },
  completeNodeDrop: (nodeId, targetFrameId, previousNodes) => {
    const graph = get().getActiveGraph();
    const result = moveNodePlacement(graph.nodes, nodeId, targetFrameId);
    if (!result.valid) {
      set((state) => ({
        graphs: { ...state.graphs, [state.activeProjectId]: { ...activeGraph(state), nodes: previousNodes } }
      }));
      return { message: result.message, valid: false };
    }
    set((state) => ({
      graphs: { ...state.graphs, [state.activeProjectId]: { ...activeGraph(state), nodes: result.nodes } }
    }));
    persistChangedPlacementsAtomic(previousNodes, result.nodes, get, set);
    return { message: result.message, valid: true };
  },
  completeGroupMove: (previousNodes) => {
    const current = get().getActiveGraph().nodes;
    if (samePlacementGeometry(previousNodes, current)) return;
    persistChangedPlacementsAtomic(previousNodes, current, get, set);
  },
  completeNodeResize: (previousNodes) => {
    const current = get().getActiveGraph().nodes;
    if (samePlacementGeometry(previousNodes, current)) return;
    persistChangedPlacementsAtomic(previousNodes, current, get, set);
  },
  fitFrame: (frameId) => {
    const before = get().getActiveGraph().nodes;
    const after = fitFrameToContent(before, frameId);
    if (samePlacementGeometry(before, after)) return;
    set((state) => ({
      graphs: { ...state.graphs, [state.activeProjectId]: { ...activeGraph(state), nodes: after } }
    }));
    persistChangedPlacementsAtomic(before, after, get, set);
  },
  toggleFrameCollapse: (frameId) => {
    const graph = get().getActiveGraph();
    const frame = graph.nodes.find((node) => node.id === frameId && node.data.isFrame);
    if (!frame) return;
    const collapsing = frame.data.presentationState !== "collapsed";
    const expandedSize = collapsing
      ? { width: frame.width ?? FRAME_MIN_SIZE.width, height: frame.height ?? FRAME_MIN_SIZE.height }
      : frame.data.expandedFrameSize ?? FRAME_MIN_SIZE;
    const updatedFrame: Node<NarrativeNodeData> = {
      ...frame,
      width: collapsing ? COLLAPSED_FRAME_SIZE.width : expandedSize.width,
      height: collapsing ? COLLAPSED_FRAME_SIZE.height : expandedSize.height,
      data: {
        ...frame.data,
        presentationState: collapsing ? "collapsed" : "expanded",
        expandedFrameSize: collapsing ? expandedSize : undefined
      }
    };
    const updatedNodes = graph.nodes.map((node) => node.id === frameId ? updatedFrame : node);
    set((state) => ({
      graphs: { ...state.graphs, [state.activeProjectId]: { ...activeGraph(state), nodes: updatedNodes } },
      selection: { type: "node", id: frameId }
    }));
    persistRuntimeMutation(
      runtimeWriter(get())?.updatePlacement(get().activeProjectId, updatedFrame),
      undefined,
      set,
      () => set((state) => ({ graphs: { ...state.graphs, [state.activeProjectId]: { ...activeGraph(state), nodes: graph.nodes } } }))
    );
  },
  selectItem: (selection) => {
    // Primary selection is presentation state; equal intent must not notify the store.
    set((state) => state.selection === selection
      || (state.selection?.type === selection?.type && state.selection?.id === selection?.id)
      ? state : { selection });
  },
  reconnectEdge: (edgeId, connection) => {
    const sourceId = connection.source;
    const targetId = connection.target;
    if (!sourceId || !targetId || sourceId === targetId) {
      get().deleteEdge(edgeId);
      return;
    }

    let updatedEdge: Edge<NarrativeEdgeData> | null = null;
    const activeProjectId = get().activeProjectId;
    set((state) => {
      const graph = activeGraph(state);
      const edge = graph.edges.find((candidate) => candidate.id === edgeId);
      const source = graph.nodes.find((node) => node.id === sourceId);
      const target = graph.nodes.find((node) => node.id === targetId);
      if (!edge || !source || !target) {
        return state;
      }
      const handles = resolveConnectionHandles(source, target, connection, graph.nodes);

      return {
        graphs: {
          ...state.graphs,
          [state.activeProjectId]: {
            ...graph,
            edges: reconnectReactFlowEdge(
              edge,
              {
                source: sourceId,
                sourceHandle: handles.sourceHandle,
                target: targetId,
                targetHandle: handles.targetHandle
              },
              graph.edges,
              { shouldReplaceId: false }
            ).map((candidate) =>
              candidate.id === edgeId
                ? (updatedEdge = {
                    ...candidate,
                    markerEnd: { type: MarkerType.ArrowClosed },
                    reconnectable: true,
                    style: edgeStyle()
                  })
                : candidate
            )
          }
        },
        selection: { type: "edge", id: edgeId }
      };
    });
    if (updatedEdge) {
      const edgeToPersist = updatedEdge as Edge<NarrativeEdgeData>;
      const writer = runtimeWriter(get());
      if (edgeToPersist.data?.dialogueElementId) {
        persistRuntimeMutation(
          writer?.updateDialogueTransition(edgeToPersist),
          (saved) => replaceEdgeId(set, activeProjectId, edgeToPersist.id, saved.edge),
          set
        );
      } else if (edgeToPersist.data?.questBranchId) {
        persistRuntimeMutation(
          writer?.updateQuestTransition(edgeToPersist),
          (saved) => replaceEdgeId(set, activeProjectId, edgeToPersist.id, saved.edge),
          set
        );
      } else {
        persistRuntimeMutation(writer?.updateEdge(activeProjectId, edgeToPersist), undefined, set);
      }
    }
  },
  setActiveProject: (projectId) => {
    const state = get(), changed = state.activeProjectId !== projectId;
    if (changed) snapshotLoadGeneration++;
    set({ activeProjectId: projectId, selection: { type: "project", id: projectId },
      ...(changed ? retiredSnapshotLoadStatus(state, projectId) : {}) });
  },
  setFreshProjectId: (projectId) => {
    set({ freshProjectId: projectId });
  },
  attachProjectSession: (sessionId) => {
    const state = get(), changed = state.activeSessionId !== sessionId;
    if (changed) snapshotLoadGeneration++;
    set({ activeSessionId: sessionId, ...(changed ? retiredSnapshotLoadStatus(state) : {}) });
  },
  markProjectSessionDirty: () => {
    set((state) => {
      const session = state.activeProjectSession;
      // Mutation acknowledgements must not republish an unchanged session.
      if (!session || (session.save_status === "dirty" && session.save_error === null)) return state;
      return { activeProjectSession: { ...session, save_status: "dirty", save_error: null } };
    });
  },
  setProjectSessionState: (session) => {
    const state = get(), changed = state.activeSessionId !== session.session_id;
    if (changed) snapshotLoadGeneration++;
    set({ activeProjectSession: session, activeSessionId: session.session_id,
      ...(changed ? retiredSnapshotLoadStatus(state) : {}) });
  },
  closeActiveProject: () => {
    snapshotLoadGeneration++;
    set({
      activeProjectId: "",
      activeSessionId: null,
      activeProjectSession: null,
      activeAutosave: null,
      activeProjectManifest: null,
      freshProjectId: null,
      graphs: {},
      playbackEffectsByFlow: {},
      projects: [],
      runtimeError: null,
      runtimeStatus: "idle",
      selection: null,
      storyFlowsByProject: {}
    });
  },
  setRuntimePersistence: (persistence) => {
    set({ runtimePersistence: persistence });
  },
  updateEdge: (edgeId, draft) => {
    let updatedEdge: Edge<NarrativeEdgeData> | null = null;
    const activeProjectId = get().activeProjectId;
    set((state) => {
      const graph = activeGraph(state);
      const existingEdge = graph.edges.find((edge) => edge.id === edgeId);
      const source = graph.nodes.find((node) => node.id === draft.source);
      const target = graph.nodes.find((node) => node.id === draft.target);
      if (!existingEdge || !source || !target || draft.source === draft.target) {
        return state;
      }
      const handles = resolveConnectionHandles(source, target, draft, graph.nodes);
      updatedEdge = {
        ...existingEdge,
        source: draft.source,
        target: draft.target,
        sourceHandle: handles.sourceHandle,
        targetHandle: handles.targetHandle,
        label: draft.label,
        data: {
          label: draft.label,
          relationshipType: draft.relationshipType ?? existingEdge.data?.relationshipType ?? "depends_on",
          ...(existingEdge.data?.dialogueElementId ? { dialogueElementId: existingEdge.data.dialogueElementId } : {}),
          ...(existingEdge.data?.questStageId ? { questStageId: existingEdge.data.questStageId } : {}),
          ...(existingEdge.data?.questBranchId ? { questBranchId: existingEdge.data.questBranchId } : {}),
          ...(draft.outcomeFlowComposition === null
            ? {}
            : draft.outcomeFlowComposition
              ? { outcomeFlowComposition: draft.outcomeFlowComposition }
              : existingEdge.data?.outcomeFlowComposition
                ? { outcomeFlowComposition: existingEdge.data.outcomeFlowComposition }
                : {})
        },
        reconnectable: true,
        markerEnd: { type: MarkerType.ArrowClosed },
        style: edgeStyle()
      };
      return {
        graphs: {
          ...state.graphs,
          [state.activeProjectId]: {
            ...graph,
            edges: graph.edges.map((edge) =>
              edge.id === edgeId
                ? updatedEdge!
                : edge
            )
          }
        },
        selection: { type: "edge", id: edgeId }
      };
    });
    if (updatedEdge) {
      const edgeToPersist = updatedEdge as Edge<NarrativeEdgeData>;
      const writer = runtimeWriter(get());
      if (edgeToPersist.data?.dialogueElementId) {
        persistRuntimeMutation(
          writer?.updateDialogueTransition(edgeToPersist),
          (saved) => replaceEdgeId(set, activeProjectId, edgeToPersist.id, saved.edge),
          set
        );
      } else if (edgeToPersist.data?.questBranchId) {
        persistRuntimeMutation(
          writer?.updateQuestTransition(edgeToPersist),
          (saved) => replaceEdgeId(set, activeProjectId, edgeToPersist.id, saved.edge),
          set
        );
      } else {
        persistRuntimeMutation(writer?.updateEdge(activeProjectId, edgeToPersist), undefined, set);
      }
    }
  },
  updateDialogueDocument: (nodeId, document) => {
    // Keep the aggregate available for offline editing; runtime persistence is
    // opportunistic and uses the same fallback/error policy as graph CRUD.
    const activeProjectId = get().activeProjectId;
    const selectedDialogue = get().getActiveGraph().nodes.find((node) => node.id === nodeId && node.data.kind === "Dialogue");
    const dialogueNodeId = selectedDialogue ? canonicalId(selectedDialogue) : nodeId;
    let dialogueExists = false;
    set((state) => {
      const graph = activeGraph(state);
      const nodes = graph.nodes.map((node) => {
        if (canonicalId(node) !== dialogueNodeId || node.data.kind !== "Dialogue") {
          return node;
        }
        dialogueExists = true;
        return { ...node, data: { ...node.data, dialogueDocument: document } };
      });
      return dialogueExists
        ? {
            graphs: { ...state.graphs, [state.activeProjectId]: { ...graph, nodes } },
            selection: { type: "node", id: nodeId }
          }
        : state;
    });
    if (dialogueExists) {
      persistRuntimeMutation(runtimeWriter(get())?.updateDialogueDocument(dialogueNodeId, document), undefined, set);
    }
  },
  updateQuestDocument: (nodeId, document) => {
    const selectedQuest = get().getActiveGraph().nodes.find((node) => node.id === nodeId && node.data.kind === "Quest");
    const questNodeId = selectedQuest ? canonicalId(selectedQuest) : nodeId;
    let questExists = false;
    set((state) => {
      const graph = activeGraph(state);
      const nodes = graph.nodes.map((node) => {
        if (canonicalId(node) !== questNodeId || node.data.kind !== "Quest") return node;
        questExists = true;
        return { ...node, data: { ...node.data, questDocument: document } };
      });
      return questExists
        ? { graphs: { ...state.graphs, [state.activeProjectId]: { ...graph, nodes } }, selection: { type: "node", id: nodeId } }
        : state;
    });
    if (questExists) persistRuntimeMutation(runtimeWriter(get())?.updateQuestDocument(questNodeId, document), undefined, set);
  },
  updateNode: (nodeId, draft) => {
    let updatedNode: Node<NarrativeNodeData> | null = null;
    const activeProjectId = get().activeProjectId;
    set((state) => {
      const graph = activeGraph(state);
      const existing = graph.nodes.find((node) => node.id === nodeId);
      if (!existing) {
        return state;
      }
      const canonicalNodeId = canonicalId(existing);
      // Frame kind conversion requires a dedicated composition migration, so ordinary edits preserve it.
      const kind = existing.data.isFrame ? existing.data.kind : draft.kind;
      const canonicalData = {
        kind,
        label: draft.title,
        title: draft.title,
        summary: draft.summary,
        tags: draft.tags,
        ...(kind === "Condition" && draft.requirement ? { requirement: draft.requirement } : {}),
        ...(kind === "Consequence" && draft.outcome ? { outcome: draft.outcome } : {}),
        ...(kind === "Character" ? { characterRole: draft.characterRole ?? "" } : {}),
        ...(kind === "Item" ? { itemPurpose: draft.itemPurpose ?? "" } : {})
      };
      updatedNode = {
        ...(graph.nodes.find((node) => node.id === canonicalNodeId) ?? existing),
        id: canonicalNodeId,
        data: {
          ...existing.data,
          ...canonicalData,
          canonicalNodeId
        }
      };
      return {
        graphs: {
          ...state.graphs,
          [state.activeProjectId]: {
            ...graph,
            nodes: graph.nodes.map((node) => canonicalId(node) === canonicalNodeId
              ? { ...node, data: { ...node.data, ...canonicalData, canonicalNodeId } }
              : node)
          }
        },
        selection: { type: "node", id: nodeId }
      };
    });
    if (updatedNode) {
      persistRuntimeMutation(runtimeWriter(get())?.updateNode(activeProjectId, updatedNode), undefined, set);
    }
  }
}));

/** Persists one group gesture as a single runtime transaction and restores the complete pre-drag geometry on failure. */
function persistChangedPlacementsAtomic(
  before: readonly Node<NarrativeNodeData>[],
  after: readonly Node<NarrativeNodeData>[],
  get: () => GraphState,
  set: GraphSet
) {
  const changed = after.filter((node) => {
    const previous = before.find((candidate) => candidate.id === node.id);
    return previous && !samePlacementGeometry([previous], [node]);
  });
  const state = get();
  const writer = runtimeWriter(state);
  if (!writer || changed.length === 0) return;
  persistRuntimeMutation(
    persistPlacementChanges(writer, state.activeProjectId, changed),
    (created) => attachCreatedPlacementIds(set, state.activeProjectId, created),
    set,
    () => set((current) => ({
      graphs: {
        ...current.graphs,
        [current.activeProjectId]: { ...activeGraph(current), nodes: [...before] }
      }
    }))
  );
}

/** Creates missing legacy placements before using the normal batch update path. */
async function persistPlacementChanges(
  writer: RuntimeGraphPersistence,
  projectId: string,
  changed: Node<NarrativeNodeData>[]
): Promise<Array<{ nodeId: string; placementId: string }>> {
  const created: Array<{ nodeId: string; placementId: string }> = [];
  for (const node of changed.filter((candidate) => !candidate.data.placementId)) {
    const placement = await writer.updatePlacement(projectId, node);
    created.push({ nodeId: node.id, placementId: placement.id });
  }
  const existing = changed.filter((node) => Boolean(node.data.placementId));
  if (existing.length) await writer.updatePlacements(projectId, existing);
  return created;
}

/** Keeps canonical node identity stable while attaching its newly created visual record. */
function attachCreatedPlacementIds(
  set: GraphSet,
  projectId: string,
  created: Array<{ nodeId: string; placementId: string }>
) {
  if (!created.length) return;
  const placementByNode = new Map(created.map((item) => [item.nodeId, item.placementId]));
  set((state) => {
    const graph = state.graphs[projectId];
    if (!graph) return {};
    return {
      graphs: {
        ...state.graphs,
        [projectId]: {
          ...graph,
          nodes: graph.nodes.map((node) => {
            const placementId = placementByNode.get(node.id);
            return placementId ? { ...node, data: { ...node.data, placementId } } : node;
          })
        }
      }
    };
  });
}

// Durable sessions keep writing after a recoverable request error; fixture-only
// graphs remain gated by the legacy ready state.
function runtimeWriter(state: GraphState) {
  return state.activeSessionId || state.runtimeStatus === "ready"
    ? state.runtimePersistence
    : null;
}

// Durable mutation failures replace optimistic state with the authoritative
// complete project document while preserving an actionable error.
function persistRuntimeMutation<T>(
  mutation: Promise<T> | undefined,
  onSuccess: ((value: T) => void) | undefined,
  set: GraphSet,
  onError?: () => void
) {
  if (!mutation) {
    return;
  }

  void mutation
    .then((value) => {
      onSuccess?.(value);
      set({ runtimeError: null, runtimeStatus: "ready" });
    })
    .catch((error: unknown) => {
      onError?.();
      const message = error instanceof Error ? error.message : "Runtime persistence failed";
      const state = useGraphStore.getState();
      if (state.activeSessionId && state.runtimePersistence) {
        const sessionId = state.activeSessionId;
        const persistence = state.runtimePersistence;
        void persistence.loadProjectSessionSnapshot(sessionId)
          .then((snapshot) => {
            useGraphStore.setState((current) => runtimeSnapshotState(current, snapshot, message));
          })
          .catch((reloadError: unknown) => {
            set({
              runtimeError: `${message}; reconciliation failed: ${reloadError instanceof Error ? reloadError.message : "unknown error"}`,
              runtimeStatus: "fallback"
            });
          });
        return;
      }
      set({
        runtimeError: message,
        runtimeStatus: "fallback"
      });
    });
}

function runtimeSnapshotState(
  state: GraphState,
  snapshot: RuntimeGraphSnapshot,
  runtimeError: string | null
): Partial<GraphState> {
  return {
    activeProjectId: snapshot.activeProjectId,
    activeSessionId: snapshot.activeSessionId ?? state.activeSessionId,
    activeProjectSession: snapshot.projectSession ?? state.activeProjectSession,
    activeAutosave: snapshot.autosave ?? state.activeAutosave,
    activeProjectManifest: snapshot.manifest ?? state.activeProjectManifest,
    freshProjectId: null,
    graphs: {
      ...state.graphs,
      [snapshot.activeProjectId]: {
        edges: snapshot.edges,
        issues: snapshot.issues,
        nodes: snapshot.nodes
      }
    },
    playbackEffectsByFlow: snapshot.playbackEffectsByFlow ?? {},
    projects: snapshot.projects,
    runtimeError,
    runtimeStatus: "ready",
    selection: selectionAfterRuntimeSnapshot(state, snapshot),
    storyFlowsByProject: {
      ...state.storyFlowsByProject,
      [snapshot.activeProjectId]: snapshot.storyFlows ?? []
    }
  };
}

/** Keeps author focus across authoritative reloads when the selected record survived. */
function selectionAfterRuntimeSnapshot(state: GraphState, snapshot: RuntimeGraphSnapshot): Selection {
  if (state.activeProjectId !== snapshot.activeProjectId || !state.selection) {
    return { type: "project", id: snapshot.activeProjectId };
  }
  if (state.selection.type === "node" && snapshot.nodes.some((node) => node.id === state.selection?.id)) {
    return state.selection;
  }
  if (state.selection.type === "edge" && snapshot.edges.some((edge) => edge.id === state.selection?.id)) {
    return state.selection;
  }
  return { type: "project", id: snapshot.activeProjectId };
}

function replaceVisualPlacementId(set: GraphSet, projectId: string, localId: string, placementId: string) {
  const visualId = `placement:${placementId}`;
  set((state) => {
    const graph = state.graphs[projectId];
    if (!graph) return {};
    return {
      graphs: {
        ...state.graphs,
        [projectId]: {
          ...graph,
          nodes: graph.nodes.map((node) => node.id === localId
            ? { ...node, id: visualId, data: { ...node.data, placementId } }
            : node)
        }
      },
      selection: state.selection?.type === "node" && state.selection.id === localId ? { type: "node", id: visualId } : state.selection
    };
  });
}

function replaceProjectId(set: GraphSet, localProjectId: string, savedProject: NarrativeProject) {
  set((state) => {
    const graph = state.graphs[localProjectId] ?? emptyGraph();
    const { [localProjectId]: _discarded, ...remainingGraphs } = state.graphs;
    return {
      activeProjectId: state.activeProjectId === localProjectId ? savedProject.id : state.activeProjectId,
      graphs: {
        ...remainingGraphs,
        [savedProject.id]: graph
      },
      projects: state.projects.map((project) => (project.id === localProjectId ? savedProject : project)),
      selection: state.selection?.id === localProjectId ? { type: "project", id: savedProject.id } : state.selection
    };
  });
}

function replaceNodeId(set: GraphSet, projectId: string, localNodeId: string, savedNode: Node<NarrativeNodeData>) {
  set((state) => {
    const graph = state.graphs[projectId];
    if (!graph) {
      return {};
    }

    return {
      graphs: {
        ...state.graphs,
        [projectId]: {
          edges: graph.edges.map((edge) => ({
            ...edge,
            source: edge.source === localNodeId ? savedNode.id : edge.source,
            target: edge.target === localNodeId ? savedNode.id : edge.target
          })),
          issues: graph.issues.map((issue) => (issue.nodeId === localNodeId ? { ...issue, nodeId: savedNode.id } : issue)),
          nodes: graph.nodes.map((node) => (node.id === localNodeId ? savedNode : node))
        }
      },
      selection: state.selection?.type === "node" && state.selection.id === localNodeId ? { type: "node", id: savedNode.id } : state.selection
    };
  });
}

function replaceEdgeId(set: GraphSet, projectId: string, localEdgeId: string, savedEdge: Edge<NarrativeEdgeData>) {
  set((state) => {
    const graph = state.graphs[projectId];
    if (!graph) {
      return {};
    }

    return {
      graphs: {
        ...state.graphs,
        [projectId]: {
          ...graph,
          edges: graph.edges.map((edge) => (edge.id === localEdgeId ? savedEdge : edge)),
          issues: graph.issues.map((issue) => (issue.edgeId === localEdgeId ? { ...issue, edgeId: savedEdge.id } : issue))
        }
      },
      selection: state.selection?.type === "edge" && state.selection.id === localEdgeId ? { type: "edge", id: savedEdge.id } : state.selection
    };
  });
}
