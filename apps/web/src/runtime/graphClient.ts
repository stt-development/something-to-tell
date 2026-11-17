/* Graph runtime endpoint ownership. */
import { type Edge, type Node } from "@xyflow/react";
import type { ProjectCompositionSnapshot, VisualPlacement } from "../composition/contracts";
import type { DialogueDocument } from "../dialogue/contracts";
import type { QuestDocument } from "../quest/contracts";
import { type FrameDraft, type NarrativeEdgeData, type NarrativeNodeData, type NarrativeProject, type ProjectDraft } from "../types";
import type { RuntimeDialogueTransitionResult, RuntimeEdge, RuntimeGraphAuthoringPersistence, RuntimeGraphLoaderPersistence, RuntimeGraphSnapshot, RuntimeIssue, RuntimeNode, RuntimeProject, RuntimeQuestTransitionResult } from "./apiTypes";
import { DEFAULT_NODE_SIZE, applyRuntimeComposition, flowEdgeToRuntimePayload, flowNodeToRuntimePayload, outcomeFlowCompositionPayload, projectDraftToRuntimeCreate, runtimeEdgeToFlowEdge, runtimeIssueToNarrativeIssue, runtimeNodeToFlowNode, runtimeProjectToNarrativeProject } from "./projections";
import type { RuntimeTransport } from "./transport";
import { RuntimeApiError } from "./transport";
export function createGraphRuntimeClient(transport: RuntimeTransport): RuntimeGraphAuthoringPersistence & RuntimeGraphLoaderPersistence {
  const { deleteResource, getJson, requestJson, sendJson } = transport;
  return {
    async loadGraphSnapshot(projectId?: string): Promise<RuntimeGraphSnapshot> {
      const runtimeProjects = await getJson<RuntimeProject[]>("/projects");
      const activeProject = runtimeProjects.find((project) => project.id === projectId) ?? runtimeProjects[0];
      if (!activeProject) {
        return { activeProjectId: "", edges: [], issues: [], nodes: [], playbackEffectsByFlow: {}, projects: [], storyFlows: [] };
      }
      const [runtimeNodes, runtimeEdges, runtimeIssues, composition] = await Promise.all([
        getJson<RuntimeNode[]>(`/nodes?project_id=${encodeURIComponent(activeProject.id)}`),
        getJson<RuntimeEdge[]>(`/edges?project_id=${encodeURIComponent(activeProject.id)}`),
        getJson<RuntimeIssue[]>(`/issues?project_id=${encodeURIComponent(activeProject.id)}`),
        getJson<ProjectCompositionSnapshot>(`/compositions?project_id=${encodeURIComponent(activeProject.id)}`)
      ]);
      return {
        activeProjectId: activeProject.id,
        // Hidden semantic edges stay in application state for traversal and specialized editors.
        edges: runtimeEdges.map(runtimeEdgeToFlowEdge),
        issues: runtimeIssues.map(runtimeIssueToNarrativeIssue),
        nodes: applyRuntimeComposition(runtimeNodes.map(runtimeNodeToFlowNode), composition),
        projects: runtimeProjects.map(runtimeProjectToNarrativeProject)
      };
    },
    async createProject(draft: ProjectDraft): Promise<NarrativeProject> {
      const project = await sendJson<RuntimeProject>("POST", "/projects", projectDraftToRuntimeCreate(draft));
      return runtimeProjectToNarrativeProject(project);
    },
    async createNode(projectId: string, node: Node<NarrativeNodeData>): Promise<Node<NarrativeNodeData>> {
      const runtimeNode = await sendJson<RuntimeNode>("POST", "/nodes", flowNodeToRuntimePayload(projectId, node));
      return runtimeNodeToFlowNode(runtimeNode);
    },
    async createFrame(projectId: string, node: Node<NarrativeNodeData>): Promise<Node<NarrativeNodeData>> {
      const response = await sendJson<{
        node: RuntimeNode;
        placement: VisualPlacement;
      }>("POST", "/compositions/frames", {
        body: node.data.summary,
        kind: node.data.kind as FrameDraft["kind"],
        metadata: { label: node.data.label, tags: node.data.tags },
        position: node.position,
        project_id: projectId,
        size: {
          height: node.height ?? DEFAULT_NODE_SIZE.height,
          width: node.width ?? DEFAULT_NODE_SIZE.width
        },
        status: "canon",
        summary: node.data.summary,
        title: node.data.title
      });
      const savedNode = runtimeNodeToFlowNode(response.node);
      return {
        ...savedNode,
        data: {
          ...savedNode.data,
          isFrame: true,
          placementId: response.placement.id,
          rootPlacementId: response.placement.id
        }
      };
    },
    async updatePlacement(projectId: string, node: Node<NarrativeNodeData>): Promise<VisualPlacement> {
      const canonicalNodeId = node.data.canonicalNodeId ?? node.id;
      const payload = {
        container_node_id: node.parentId ?? null,
        is_primary: !node.data.isLinkedInstance,
        metadata: {
          ...(node.data.isLinkedInstance ? { linked_instance: true } : {}),
          ...(node.data.expandedFrameSize ? { expanded_frame_size: node.data.expandedFrameSize } : {})
        },
        position: node.position,
        presentation_state: node.data.presentationState ?? "expanded",
        project_id: projectId,
        size: { height: node.height ?? DEFAULT_NODE_SIZE.height, width: node.width ?? DEFAULT_NODE_SIZE.width }
      };
      const snapshot = node.data.placementId
        ? await sendJson<ProjectCompositionSnapshot>("PUT", `/compositions/placements/${encodeURIComponent(node.data.placementId)}`, payload)
        : await sendJson<ProjectCompositionSnapshot>("POST", "/compositions/placements", { ...payload, canonical_node_id: canonicalNodeId });
      const saved = snapshot.placements.find((placement) => placement.canonical_node_id === canonicalNodeId && placement.container_node_id === (node.parentId ?? null));
      if (!saved)
        throw new RuntimeApiError("Runtime did not return the updated placement", "composition_placement_missing", 500);
      return saved;
    },
    async updatePlacements(projectId, nodes): Promise<ProjectCompositionSnapshot> {
      if (nodes.some((node) => !node.data.placementId)) {
        throw new RuntimeApiError("Group movement requires persisted placements", "composition_placement_missing", 409);
      }
      return sendJson<ProjectCompositionSnapshot>("PUT", "/compositions/placements", {
        project_id: projectId,
        placements: nodes.map((node) => ({
          placement_id: node.data.placementId,
          project_id: projectId,
          container_node_id: node.parentId ?? null,
          position: node.position,
          size: { width: node.width ?? DEFAULT_NODE_SIZE.width, height: node.height ?? DEFAULT_NODE_SIZE.height },
          is_primary: !node.data.isLinkedInstance,
          presentation_state: node.data.presentationState ?? "expanded",
          metadata: {
            ...(node.data.isLinkedInstance ? { linked_instance: true } : {}),
            ...(node.data.expandedFrameSize ? { expanded_frame_size: node.data.expandedFrameSize } : {})
          }
        }))
      });
    },
    async createLinkedPlacement(projectId, canonicalNodeId, containerNodeId, position, size): Promise<VisualPlacement> {
      const snapshot = await sendJson<ProjectCompositionSnapshot>("POST", "/compositions/placements", {
        canonical_node_id: canonicalNodeId,
        container_node_id: containerNodeId,
        is_primary: false,
        metadata: { linked_instance: true },
        position,
        presentation_state: "expanded",
        project_id: projectId,
        size
      });
      const placement = snapshot.placements.find((item) => item.canonical_node_id === canonicalNodeId && item.container_node_id === containerNodeId);
      if (!placement)
        throw new RuntimeApiError("Runtime did not return the linked placement", "composition_placement_missing", 500);
      return placement;
    },
    async removePlacement(placementId): Promise<ProjectCompositionSnapshot> {
      return requestJson<ProjectCompositionSnapshot>(`/compositions/placements/${encodeURIComponent(placementId)}`, { method: "DELETE" });
    },
    async deleteEntity(canonicalNodeId): Promise<void> {
      await deleteResource(`/compositions/entities/${encodeURIComponent(canonicalNodeId)}`);
    },
    async updateNode(projectId: string, node: Node<NarrativeNodeData>): Promise<Node<NarrativeNodeData>> {
      const runtimeNode = await sendJson<RuntimeNode>("PUT", `/nodes/${encodeURIComponent(node.id)}`, flowNodeToRuntimePayload(projectId, node));
      return runtimeNodeToFlowNode(runtimeNode);
    },
    async deleteNode(nodeId: string): Promise<void> {
      await deleteResource(`/nodes/${encodeURIComponent(nodeId)}`);
    },
    async createEdge(projectId: string, edge: Edge<NarrativeEdgeData>): Promise<Edge<NarrativeEdgeData>> {
      const runtimeEdge = await sendJson<RuntimeEdge>("POST", "/edges", flowEdgeToRuntimePayload(projectId, edge));
      return runtimeEdgeToFlowEdge(runtimeEdge);
    },
    async updateEdge(projectId: string, edge: Edge<NarrativeEdgeData>): Promise<Edge<NarrativeEdgeData>> {
      const runtimeEdge = await sendJson<RuntimeEdge>("PUT", `/edges/${encodeURIComponent(edge.id)}`, flowEdgeToRuntimePayload(projectId, edge));
      return runtimeEdgeToFlowEdge(runtimeEdge);
    },
    async deleteEdge(edgeId: string): Promise<void> {
      await deleteResource(`/edges/${encodeURIComponent(edgeId)}`);
    },
    async createFactionMembership(factionId, characterId): Promise<Edge<NarrativeEdgeData>> {
      const edge = await sendJson<RuntimeEdge>("POST", `/factions/${encodeURIComponent(factionId)}/members`, {
        character_node_id: characterId
      });
      return runtimeEdgeToFlowEdge(edge);
    },
    async removeFactionMembership(factionId, characterId): Promise<void> {
      await deleteResource(`/factions/${encodeURIComponent(factionId)}/members/${encodeURIComponent(characterId)}`);
    },
    async loadDialogueDocument(nodeId: string): Promise<DialogueDocument> {
      return getJson<DialogueDocument>(`/dialogues/${encodeURIComponent(nodeId)}`);
    },
    async updateDialogueDocument(nodeId: string, document: DialogueDocument): Promise<DialogueDocument> {
      return sendJson<DialogueDocument>("PUT", `/dialogues/${encodeURIComponent(nodeId)}`, document);
    },
    async createDialogueTransition(projectId, draft, edge, newTarget): Promise<RuntimeDialogueTransitionResult> {
      const response = await sendJson<{
        edge: RuntimeEdge;
        target_node: RuntimeNode;
      }>("POST", "/dialogue-transitions", {
        dialogue_element_id: draft.originId,
        dialogue_node_id: draft.dialogueNodeId,
        dialogue_document: draft.document,
        label: draft.label,
        relationship_type: draft.relationshipType,
        ...(newTarget
          ? {
            new_target: {
              body: newTarget.data.summary,
              metadata: {
                height: newTarget.height ?? DEFAULT_NODE_SIZE.height,
                kind: newTarget.data.kind,
                label: newTarget.data.label,
                position: newTarget.position,
                tags: newTarget.data.tags,
                width: newTarget.width ?? DEFAULT_NODE_SIZE.width
              },
              status: "canon",
              summary: newTarget.data.summary,
              title: newTarget.data.title,
              type: newTarget.data.kind
            }
          }
          : { target_node_id: edge.target })
      });
      return { edge: runtimeEdgeToFlowEdge(response.edge), targetNode: runtimeNodeToFlowNode(response.target_node) };
    },
    async updateDialogueTransition(edge): Promise<RuntimeDialogueTransitionResult> {
      const response = await sendJson<{
        edge: RuntimeEdge;
        target_node: RuntimeNode;
      }>("PUT", `/dialogue-transitions/${encodeURIComponent(edge.id)}`, {
        dialogue_element_id: edge.data?.dialogueElementId,
        label: typeof edge.label === "string" ? edge.label : edge.data?.label ?? "",
        outcome_flow_composition: outcomeFlowCompositionPayload(edge.data?.outcomeFlowComposition),
        relationship_type: edge.data?.relationshipType ?? "leads_to",
        target_node_id: edge.target
      });
      return { edge: runtimeEdgeToFlowEdge(response.edge), targetNode: runtimeNodeToFlowNode(response.target_node) };
    },
    async loadQuestDocument(nodeId: string): Promise<QuestDocument> {
      return getJson<QuestDocument>(`/quests/${encodeURIComponent(nodeId)}`);
    },
    async updateQuestDocument(nodeId: string, document: QuestDocument): Promise<QuestDocument> {
      return sendJson<QuestDocument>("PUT", `/quests/${encodeURIComponent(nodeId)}`, document);
    },
    async createQuestTransition(_projectId, draft, edge, newTarget): Promise<RuntimeQuestTransitionResult> {
      const response = await sendJson<{
        edge: RuntimeEdge;
        target_node: RuntimeNode;
      }>("POST", "/quest-transitions", {
        quest_node_id: draft.questNodeId,
        quest_stage_id: draft.stageId,
        quest_branch_id: draft.branchId,
        quest_document: draft.document,
        label: draft.label,
        relationship_type: draft.relationshipType,
        ...(newTarget
          ? {
            new_target: {
              body: newTarget.data.summary,
              metadata: {
                height: newTarget.height ?? DEFAULT_NODE_SIZE.height,
                kind: newTarget.data.kind,
                label: newTarget.data.label,
                position: newTarget.position,
                tags: newTarget.data.tags,
                width: newTarget.width ?? DEFAULT_NODE_SIZE.width
              },
              status: "canon",
              summary: newTarget.data.summary,
              title: newTarget.data.title,
              type: newTarget.data.kind
            }
          }
          : { target_node_id: edge.target })
      });
      return { edge: runtimeEdgeToFlowEdge(response.edge), targetNode: runtimeNodeToFlowNode(response.target_node) };
    },
    async updateQuestTransition(edge): Promise<RuntimeQuestTransitionResult> {
      const response = await sendJson<{
        edge: RuntimeEdge;
        target_node: RuntimeNode;
      }>("PUT", `/quest-transitions/${encodeURIComponent(edge.id)}`, {
        quest_stage_id: edge.data?.questStageId,
        quest_branch_id: edge.data?.questBranchId,
        label: typeof edge.label === "string" ? edge.label : edge.data?.label ?? "",
        outcome_flow_composition: outcomeFlowCompositionPayload(edge.data?.outcomeFlowComposition),
        relationship_type: edge.data?.relationshipType ?? "leads_to",
        target_node_id: edge.target
      });
      return { edge: runtimeEdgeToFlowEdge(response.edge), targetNode: runtimeNodeToFlowNode(response.target_node) };
    }
  };
}
