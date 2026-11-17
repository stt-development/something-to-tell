import { MarkerType } from "@xyflow/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { createDefaultProjectSettings } from "@something-to-tell/contracts/project-manifest";
import type { RuntimeGraphPersistence } from "../runtime/apiClient";
import { validateDialogueDocument } from "../dialogue/contracts";
import { loadProjectFixturesForTests } from "../testFixtures/projectFixtures";
import { useGraphStore } from "./graphStore";

describe("graph store", () => {
  beforeEach(() => {
    useGraphStore.setState(useGraphStore.getInitialState(), true);
    loadProjectFixturesForTests();
  });

  it("keeps the production initial state free of canonical project content", () => {
    const state = useGraphStore.getInitialState();

    expect(state.activeProjectId).toBe("");
    expect(state.activeSessionId).toBeNull();
    expect(state.projects).toEqual([]);
    expect(state.graphs).toEqual({});
    expect(state.selection).toBeNull();
  });

  it("loads seeded projects, nodes, and edges only through the test bridge", () => {
    const state = useGraphStore.getState();
    const graph = state.getActiveGraph();

    expect(state.projects).toHaveLength(2);
    expect(graph.nodes.length).toBeGreaterThanOrEqual(3);
    expect(graph.edges.length).toBeGreaterThanOrEqual(2);
    expect(graph.issues).toHaveLength(3);
  });

  it("seeds a valid branching dialogue with a character-owned action outcome", () => {
    const graph = useGraphStore.getState().getActiveGraph();
    const dialogue = graph.nodes.find((node) => node.id === "node-dock-dialogue")!;
    const document = dialogue.data.dialogueDocument!;
    const transition = graph.edges.find((edge) => edge.id === "edge-dialogue-blockade")!;

    expect(document.participants).toEqual(["node-dockmaster", "node-hero"]);
    expect(document.elements).toHaveLength(5);
    expect(validateDialogueDocument(document)).toEqual([]);
    expect(transition).toMatchObject({
      source: dialogue.id,
      target: "node-mara-runs-blockade",
      data: { dialogueElementId: "line-mara-orders-run", relationshipType: "leads_to" }
    });
    expect(graph.nodes.find((node) => node.id === transition.target)?.data).toMatchObject({
      kind: "Event",
      title: "Mara Runs the Blockade"
    });
  });

  it("adds a manual node and selects it", () => {
    const before = useGraphStore.getState().getActiveGraph().nodes.length;

    useGraphStore.getState().addManualNode({ title: "Manual Scene", kind: "Scene", summary: "Draft scene", tags: [] });

    const state = useGraphStore.getState();
    expect(state.getActiveGraph().nodes).toHaveLength(before + 1);
    expect(state.selection?.type).toBe("node");
  });

  it("creates a project with an empty graph", () => {
    useGraphStore.getState().createProject({ description: "New workspace", name: "New Game", path: "~/Stories", settings: createDefaultProjectSettings() });

    const state = useGraphStore.getState();
    expect(state.projects.some((project) => project.name === "New Game" && project.path === "~/Stories/NewGame.narrative")).toBe(true);
    expect(state.getActiveGraph()).toEqual({ nodes: [], edges: [], issues: [] });
  });

  it("reconciles one persisted bootstrap node only into an empty project", () => {
    useGraphStore.getState().createProject({ description: "Starter", name: "Bootstrap", path: "~/Stories", settings: createDefaultProjectSettings() });
    const node = {
      id: "runtime-entry",
      type: "narrative" as const,
      position: { x: 160, y: 120 },
      width: 260,
      height: 156,
      data: { kind: "Event" as const, label: "Opening Event", title: "Opening Event", summary: "", tags: [] }
    };

    expect(useGraphStore.getState().applyBootstrapNode(node)).toBe(true);
    expect(useGraphStore.getState().getActiveGraph().nodes).toEqual([node]);
    expect(useGraphStore.getState().applyBootstrapNode({ ...node, id: "duplicate" })).toBe(false);
    expect(useGraphStore.getState().getActiveGraph().nodes).toHaveLength(1);
  });

  it("reconciles an atomically persisted continuation node without another runtime write", () => {
    const before = useGraphStore.getState().getActiveGraph().nodes.length;
    const node = {
      id: "runtime-continuation",
      type: "narrative" as const,
      position: { x: 480, y: 120 },
      data: { kind: "Event" as const, label: "Gate opens", title: "Gate opens", summary: "", tags: [] }
    };

    useGraphStore.getState().reconcileRuntimeNode(node);
    useGraphStore.getState().reconcileRuntimeNode(node);

    expect(useGraphStore.getState().getActiveGraph().nodes).toHaveLength(before + 1);
    expect(useGraphStore.getState().selection).toEqual({ type: "node", id: node.id });
  });

  it("reconciles an atomically persisted outcome edge without another runtime write", () => {
    const original = useGraphStore.getState().getActiveGraph().edges.find(
      (edge) => edge.id === "edge-dialogue-blockade"
    )!;
    const persisted = {
      ...original,
      data: {
        ...original.data,
        outcomeFlowComposition: {
          invocationId: "invocation-replacement",
          sourceFlowId: "flow-main-story",
          targetFlowId: "flow-replacement"
        }
      }
    };

    useGraphStore.getState().reconcileRuntimeEdge(persisted as typeof original);

    expect(useGraphStore.getState().getActiveGraph().edges.find((edge) => edge.id === original.id)?.data).toMatchObject({
      outcomeFlowComposition: {
        invocationId: "invocation-replacement",
        targetFlowId: "flow-replacement"
      }
    });
    expect(useGraphStore.getState().selection).toEqual({ type: "edge", id: original.id });
  });

  it("updates and deletes nodes with attached edges", () => {
    const store = useGraphStore.getState();
    const graph = store.getActiveGraph();
    const node = graph.nodes[0]!;

    store.updateNode(node.id, { title: "Revised Node", kind: "Quest", summary: "Changed", tags: ["quest"] });
    expect(useGraphStore.getState().getActiveGraph().nodes[0]!.data.title).toBe("Revised Node");

    store.deleteNode(node.id);
    const nextGraph = useGraphStore.getState().getActiveGraph();
    expect(nextGraph.nodes.some((candidate) => candidate.id === node.id)).toBe(false);
    expect(nextGraph.edges.some((edge) => edge.source === node.id || edge.target === node.id)).toBe(false);
    expect(nextGraph.issues.some((issue) => issue.nodeId === node.id)).toBe(false);
  });

  it("preserves a frame kind while updating its editable fields", () => {
    const store = useGraphStore.getState();

    store.updateNode("node-opening", {
      title: "Revised Opening",
      kind: "Location",
      summary: "Updated scene description.",
      tags: ["revised"]
    });

    expect(useGraphStore.getState().getActiveGraph().nodes.find((node) => node.id === "node-opening")?.data).toMatchObject({
      kind: "Scene",
      summary: "Updated scene description.",
      tags: ["revised"],
      title: "Revised Opening"
    });
  });

  it("updates specialized semantic metadata independently from tags", () => {
    const store = useGraphStore.getState();

    store.updateNode("node-ledger-condition", {
      title: "Ledger Verified",
      kind: "Condition",
      summary: "Verification gate.",
      tags: ["gate"],
      requirement: { expression: "ledger.verified", predicate: "has verified evidence", subject: "Mara" }
    });
    store.updateNode("node-route-consequence", {
      title: "Route Restored",
      kind: "Consequence",
      summary: "Travel resumes.",
      tags: ["outcome"],
      outcome: { effect: "The harbor route opens.", targetNodeIds: ["node-harbor"] }
    });
    store.updateNode("node-hero", {
      title: "Mara Vale",
      kind: "Character",
      summary: "Captain.",
      tags: ["crew", "voice"],
      characterRole: "Player captain"
    });
    store.updateNode("node-sealed-ledger", {
      title: "Sealed Ledger",
      kind: "Item",
      summary: "Evidence.",
      tags: ["evidence"],
      itemPurpose: "Negotiation evidence"
    });

    const graph = useGraphStore.getState().getActiveGraph();
    expect(graph.nodes.find((node) => node.id === "node-ledger-condition")?.data.requirement).toEqual({ expression: "ledger.verified", predicate: "has verified evidence", subject: "Mara" });
    expect(graph.nodes.find((node) => node.id === "node-route-consequence")?.data.outcome).toEqual({ effect: "The harbor route opens.", targetNodeIds: ["node-harbor"] });
    expect(graph.nodes.find((node) => node.id === "node-hero")?.data).toMatchObject({ characterRole: "Player captain", tags: ["crew", "voice"] });
    expect(graph.nodes.filter((node) => (node.data.canonicalNodeId ?? node.id) === "node-sealed-ledger").every((node) => node.data.itemPurpose === "Negotiation evidence")).toBe(true);
  });

  it("updates a dialogue document locally and persists it when the runtime is ready", async () => {
    const persistence = runtimePersistenceMock();
    const document = {
      dialogue_version: 1 as const,
      entry_element_id: null,
      participants: ["node-hero"],
      elements: []
    };
    useGraphStore.getState().setRuntimePersistence(persistence);
    useGraphStore.setState({ runtimeStatus: "ready" });

    useGraphStore.getState().updateDialogueDocument("node-dock-dialogue", document);
    await flushPromises();

    expect(useGraphStore.getState().getActiveGraph().nodes.find((node) => node.id === "node-dock-dialogue")?.data.dialogueDocument).toEqual(document);
    expect(persistence.updateDialogueDocument).toHaveBeenCalledWith("node-dock-dialogue", document);
  });

  it("updates Quest documents and creates graph-visible branch outcomes", async () => {
    const persistence = runtimePersistenceMock();
    useGraphStore.getState().setRuntimePersistence(persistence);
    useGraphStore.setState({ runtimeStatus: "ready" });
    const store = useGraphStore.getState();
    const document = store.getActiveGraph().nodes.find((node) => node.id === "node-smuggler-route")!.data.questDocument!;
    const revised = { ...document, objective: "Open either harbor route." };

    store.updateQuestDocument("node-smuggler-route", revised);
    store.createQuestTransition({
      branchId: "branch-blockade-route",
      document: revised,
      label: "creates a diversion",
      newTarget: { kind: "Event", summary: "The patrol turns away.", tags: [], title: "Harbor Diversion" },
      questNodeId: "node-smuggler-route",
      relationshipType: "causes",
      stageId: "stage-choose-route"
    });
    await flushPromises();

    const graph = useGraphStore.getState().getActiveGraph();
    expect(graph.nodes.find((node) => node.id === "node-smuggler-route")?.data.questDocument?.objective).toBe("Open either harbor route.");
    expect(graph.edges.at(-1)?.data).toMatchObject({ questBranchId: "branch-blockade-route", questStageId: "stage-choose-route", relationshipType: "causes" });
    expect(persistence.updateQuestDocument).toHaveBeenCalledWith("node-smuggler-route", revised);
    expect(persistence.createQuestTransition).toHaveBeenCalled();
  });

  it("synchronizes dialogue documents edited through a linked placement", async () => {
    const persistence = runtimePersistenceMock();
    useGraphStore.getState().setRuntimePersistence(persistence);
    useGraphStore.setState({ runtimeStatus: "ready" });
    useGraphStore.getState().addFrameAt(
      { title: "Second Scene", kind: "Scene", summary: "", tags: [] },
      { x: 1200, y: 80 },
      { width: 520, height: 360 }
    );
    const frameId = useGraphStore.getState().getActiveGraph().nodes.at(-1)!.id;
    useGraphStore.getState().addLinkedInstance("node-dock-dialogue", frameId);
    await flushPromises();
    const linked = useGraphStore.getState().getActiveGraph().nodes.find((node) => node.data.canonicalNodeId === "node-dock-dialogue" && node.data.isLinkedInstance)!;
    const document = { dialogue_version: 1 as const, entry_element_id: null, participants: ["node-hero"], elements: [] };

    useGraphStore.getState().updateDialogueDocument(linked.id, document);
    await flushPromises();

    expect(useGraphStore.getState().getActiveGraph().nodes
      .filter((node) => (node.data.canonicalNodeId ?? node.id) === "node-dock-dialogue")
      .every((node) => node.data.dialogueDocument === document)).toBe(true);
    expect(persistence.updateDialogueDocument).toHaveBeenCalledWith("node-dock-dialogue", document);
  });

  it("creates existing and new dialogue outcomes as atomic local graph mutations", () => {
    const store = useGraphStore.getState();
    const document = store.getActiveGraph().nodes.find((node) => node.id === "node-dock-dialogue")!.data.dialogueDocument!;

    store.createDialogueTransition({
      dialogueNodeId: "node-dock-dialogue",
      document,
      label: "reveals the route",
      originId: "answer-show-ledger",
      relationshipType: "reveals",
      targetNodeId: "node-smuggler-route"
    });
    store.createDialogueTransition({
      dialogueNodeId: "node-dock-dialogue",
      document,
      label: "Mara takes action",
      newTarget: { kind: "Event", summary: "Mara acts on her decision.", tags: ["outcome"], title: "Mara Acts" },
      originId: "line-mara-orders-run",
      relationshipType: "leads_to"
    });

    const graph = useGraphStore.getState().getActiveGraph();
    expect(graph.edges.at(-2)).toMatchObject({
      source: "node-dock-dialogue",
      target: "node-smuggler-route",
      data: { dialogueElementId: "answer-show-ledger", relationshipType: "reveals" }
    });
    expect(graph.nodes.at(-1)?.data).toMatchObject({ kind: "Event", title: "Mara Acts" });
    expect(graph.edges.at(-1)).toMatchObject({
      target: graph.nodes.at(-1)?.id,
      data: { dialogueElementId: "line-mara-orders-run", relationshipType: "leads_to" }
    });
  });

  it("updates persisted dialogue outcomes through the dedicated runtime boundary", async () => {
    const persistence = runtimePersistenceMock();
    useGraphStore.getState().setRuntimePersistence(persistence);
    useGraphStore.setState({ runtimeStatus: "ready" });

    useGraphStore.getState().updateEdge("edge-dialogue-blockade", {
      label: "Mara escapes",
      relationshipType: "changes",
      source: "node-dock-dialogue",
      target: "node-route-consequence"
    });
    await flushPromises();

    expect(persistence.updateDialogueTransition).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ dialogueElementId: "line-mara-orders-run", relationshipType: "changes" }),
        target: "node-route-consequence"
      })
    );
    expect(persistence.updateEdge).not.toHaveBeenCalled();
  });

  it("preserves Quest origins when editing an outcome edge", async () => {
    const persistence = runtimePersistenceMock();
    useGraphStore.getState().setRuntimePersistence(persistence);
    useGraphStore.setState({ runtimeStatus: "ready" });

    useGraphStore.getState().updateEdge("edge-quest-legal-route", {
      label: "restores passage",
      relationshipType: "unlocks",
      source: "node-smuggler-route",
      target: "node-route-consequence"
    });
    await flushPromises();

    expect(persistence.updateQuestTransition).toHaveBeenCalledWith(expect.objectContaining({
      data: expect.objectContaining({
        questBranchId: "branch-legal-route",
        questStageId: "stage-choose-route",
        relationshipType: "unlocks"
      })
    }));
    expect(persistence.updateEdge).not.toHaveBeenCalled();
  });

  it("preserves and explicitly clears specialized outcome call associations", () => {
    const store = useGraphStore.getState();
    const base = store.getActiveGraph().edges.find((edge) => edge.id === "edge-dialogue-blockade")!;
    const association = { invocationId: "invocation-outcome", sourceFlowId: "flow-main-story", targetFlowId: "flow-side" };

    store.updateEdge(base.id, {
      label: String(base.label),
      outcomeFlowComposition: association,
      relationshipType: "leads_to",
      source: base.source,
      target: base.target
    });
    expect(useGraphStore.getState().getActiveGraph().edges.find((edge) => edge.id === base.id)?.data?.outcomeFlowComposition).toEqual(association);

    useGraphStore.getState().updateEdge(base.id, {
      label: "Updated outcome",
      relationshipType: "leads_to",
      source: base.source,
      target: base.target
    });
    expect(useGraphStore.getState().getActiveGraph().edges.find((edge) => edge.id === base.id)?.data?.outcomeFlowComposition).toEqual(association);

    useGraphStore.getState().updateEdge(base.id, {
      label: "Updated outcome",
      outcomeFlowComposition: null,
      relationshipType: "leads_to",
      source: base.source,
      target: base.target
    });
    expect(useGraphStore.getState().getActiveGraph().edges.find((edge) => edge.id === base.id)?.data?.outcomeFlowComposition).toBeUndefined();
  });

  it("creates updates and deletes edges between existing nodes", () => {
    const store = useGraphStore.getState();
    const [source, , target] = store.getActiveGraph().nodes;

    store.addEdgeBetweenNodes({ source: source!.id, sourceHandle: "right", target: target!.id, targetHandle: "left", label: "blocks", relationshipType: "opposes" });
    const edge = useGraphStore.getState().getActiveGraph().edges.at(-1)!;
    expect(edge.data?.label).toBe("blocks");
    expect(edge.data?.relationshipType).toBe("opposes");
    expect(edge.sourceHandle).toBe("right");
    expect(edge.style).toEqual({ stroke: "#475569", strokeWidth: 3 });

    store.updateEdge(edge.id, { source: source!.id, sourceHandle: "bottom", target: target!.id, targetHandle: "top", label: "requires", relationshipType: "requires" });
    expect(useGraphStore.getState().getActiveGraph().edges.at(-1)!.data?.label).toBe("requires");
    expect(useGraphStore.getState().getActiveGraph().edges.at(-1)!.data?.relationshipType).toBe("requires");
    expect(useGraphStore.getState().getActiveGraph().edges.at(-1)!.sourceHandle).toBe("bottom");

    store.deleteEdge(edge.id);
    expect(useGraphStore.getState().getActiveGraph().edges.some((candidate) => candidate.id === edge.id)).toBe(false);
  });

  it("reconciles an edge removed by migration without issuing a second runtime delete", () => {
    const persistence = runtimePersistenceMock();
    useGraphStore.getState().setRuntimePersistence(persistence);
    useGraphStore.setState({ runtimeStatus: "ready" });
    const edgeId = useGraphStore.getState().getActiveGraph().edges[0]!.id;

    useGraphStore.getState().removePersistedEdge(edgeId);

    expect(useGraphStore.getState().getActiveGraph().edges.some((edge) => edge.id === edgeId)).toBe(false);
    expect(persistence.deleteEdge).not.toHaveBeenCalled();
  });

  it("adds and removes validated hidden Faction memberships with persistence", async () => {
    const persistence = runtimePersistenceMock();
    useGraphStore.getState().setRuntimePersistence(persistence);
    useGraphStore.setState({ runtimeStatus: "ready" });

    expect(useGraphStore.getState().addFactionMember("node-trade-guild", "node-dockmaster")).toMatchObject({ valid: true });
    await flushPromises();
    expect(useGraphStore.getState().getActiveGraph().edges.find((edge) => edge.id === "membership-runtime-created")).toMatchObject({
      source: "node-dockmaster",
      target: "node-trade-guild",
      data: { canvasVisibility: "hidden", relationshipType: "member_of" }
    });
    expect(persistence.createFactionMembership).toHaveBeenCalledWith("node-trade-guild", "node-dockmaster");
    expect(useGraphStore.getState().addFactionMember("node-trade-guild", "node-dockmaster")).toMatchObject({ valid: false });
    expect(useGraphStore.getState().addFactionMember("node-trade-guild", "node-sealed-ledger")).toMatchObject({ valid: false });

    expect(useGraphStore.getState().removeFactionMember("node-trade-guild", "node-dockmaster")).toMatchObject({ valid: true });
    await flushPromises();
    expect(useGraphStore.getState().getActiveGraph().nodes.some((node) => node.id === "node-dockmaster")).toBe(true);
    expect(persistence.removeFactionMembership).toHaveBeenCalledWith("node-trade-guild", "node-dockmaster");
  });

  it("creates an edge from a React Flow connection", () => {
    const store = useGraphStore.getState();
    const [source, , target] = store.getActiveGraph().nodes;

    store.onConnect({ source: source!.id, target: target!.id, sourceHandle: "right", targetHandle: "left" });

    const edge = useGraphStore.getState().getActiveGraph().edges.at(-1)!;
    expect(edge.source).toBe(source!.id);
    expect(edge.target).toBe(target!.id);
    expect(edge.data?.relationshipType).toBe("depends_on");
    expect(edge.sourceHandle).toBe("right");
    expect(edge.targetHandle).toBe("left");
    expect(edge.markerEnd).toEqual({ type: MarkerType.ArrowClosed });
  });

  it("auto-selects the nearest target handle when a connection lands on a node", () => {
    const store = useGraphStore.getState();
    const source = store.getActiveGraph().nodes.find((node) => node.id === "node-hero")!;
    const target = store.getActiveGraph().nodes.find((node) => node.id === "node-opening")!;

    store.onConnect({ source: source!.id, target: target!.id, sourceHandle: "right", targetHandle: null });

    const edge = useGraphStore.getState().getActiveGraph().edges.at(-1)!;
    expect(edge.sourceHandle).toBe("right");
    expect(edge.targetHandle).toBe("left");
  });

  it("reconnects an edge or deletes it when the connection is dropped empty", () => {
    const store = useGraphStore.getState();
    const source = store.getActiveGraph().nodes.find((node) => node.id === "node-embargo")!;
    const target = store.getActiveGraph().nodes.find((node) => node.id === "node-opening")!;
    const edge = store.getActiveGraph().edges[0]!;

    store.reconnectEdge(edge.id, { source: source!.id, sourceHandle: "bottom", target: target!.id });
    const reconnected = useGraphStore.getState().getActiveGraph().edges.find((candidate) => candidate.id === edge.id)!;
    expect(reconnected.source).toBe(source!.id);
    expect(reconnected.target).toBe(target!.id);
    expect(reconnected.sourceHandle).toBe("bottom");
    expect(reconnected.targetHandle).toBe("left");

    useGraphStore.getState().reconnectEdge(edge.id, {});
    expect(useGraphStore.getState().getActiveGraph().edges.some((candidate) => candidate.id === edge.id)).toBe(false);
  });

  it("switches active project through one store surface", () => {
    useGraphStore.getState().setActiveProject("project-citadel");

    const state = useGraphStore.getState();
    expect(state.activeProjectId).toBe("project-citadel");
    expect(state.selection).toEqual({ type: "project", id: "project-citadel" });
  });

  it("loads a runtime graph snapshot into the active project graph", async () => {
    await useGraphStore.getState().loadRuntimeSnapshot(async () => ({
      activeProjectId: "project-runtime",
      edges: [],
      issues: [
        {
          id: "issue-runtime",
          projectId: "project-runtime",
          nodeId: "node-runtime",
          edgeId: null,
          title: "Runtime issue",
          description: "Loaded issue",
          severity: "warning",
          status: "open"
        }
      ],
      nodes: [
        {
          id: "node-runtime",
          type: "narrative",
          position: { x: 10, y: 20 },
          data: { kind: "Scene", label: "Runtime", summary: "Loaded", tags: [], title: "Runtime" }
        }
      ],
      projects: [
        {
          id: "project-runtime",
          name: "Runtime Project",
          description: "Loaded from runtime",
          path: "~/Stories/Runtime.narrative",
          status: "open",
          updatedAt: "2026-06-20"
        }
      ]
    }));

    const state = useGraphStore.getState();
    expect(state.runtimeStatus).toBe("ready");
    expect(state.activeProjectId).toBe("project-runtime");
    expect(state.getActiveGraph().nodes[0]?.id).toBe("node-runtime");
    expect(state.getActiveGraph().issues[0]?.id).toBe("issue-runtime");
  });

  it("preserves a surviving selection across an authoritative project reload", async () => {
    const state = useGraphStore.getState();
    const selected = state.getActiveGraph().nodes[0]!;
    state.selectItem({ type: "node", id: selected.id });

    await useGraphStore.getState().loadRuntimeSnapshot(async () => ({
      activeProjectId: state.activeProjectId,
      edges: state.getActiveGraph().edges,
      issues: state.getActiveGraph().issues,
      nodes: state.getActiveGraph().nodes.map((node) => ({
        ...node,
        data: { ...node.data, summary: node.id === selected.id ? "Rehydrated" : node.data.summary }
      })),
      projects: state.projects,
      storyFlows: state.storyFlowsByProject[state.activeProjectId]
    }));

    expect(useGraphStore.getState().selection).toEqual({ type: "node", id: selected.id });
    expect(useGraphStore.getState().getActiveGraph().nodes.find((node) => node.id === selected.id)?.data.summary).toBe("Rehydrated");
  });

  it("keeps a clean workspace when runtime loading fails", async () => {
    useGraphStore.setState(useGraphStore.getInitialState(), true);
    await useGraphStore.getState().loadRuntimeSnapshot(async () => {
      throw new Error("Runtime unavailable");
    });

    const state = useGraphStore.getState();
    expect(state.runtimeStatus).toBe("fallback");
    expect(state.runtimeError).toBe("Runtime unavailable");
    expect(state.activeProjectId).toBe("");
    expect(state.projects).toEqual([]);
    expect(state.getActiveGraph()).toEqual({ nodes: [], edges: [], issues: [] });
  });

  it("persists optimistic node and edge mutations when runtime is ready", async () => {
    const persistence = runtimePersistenceMock();
    useGraphStore.getState().setRuntimePersistence(persistence);
    useGraphStore.setState({ runtimeStatus: "ready" });

    useGraphStore.getState().addManualNode({ title: "Runtime Scene", kind: "Scene", summary: "Persisted", tags: ["runtime"] });
    await flushPromises();
    expect(persistence.createNode).toHaveBeenCalledTimes(1);
    expect(useGraphStore.getState().getActiveGraph().nodes.at(-1)?.id).toBe("node-runtime-created");

    const [source, , target] = useGraphStore.getState().getActiveGraph().nodes;
    useGraphStore.getState().addEdgeBetweenNodes({ source: source!.id, target: target!.id, label: "runtime edge" });
    await flushPromises();
    expect(persistence.createEdge).toHaveBeenCalledTimes(1);
    expect(useGraphStore.getState().getActiveGraph().edges.at(-1)?.id).toBe("edge-runtime-created");

    useGraphStore.getState().updateNode(source!.id, { title: "Updated Runtime Scene", kind: "Quest", summary: "Updated", tags: [] });
    useGraphStore.getState().updateEdge("edge-runtime-created", { source: source!.id, target: target!.id, label: "updated edge" });
    useGraphStore.getState().deleteEdge("edge-runtime-created");
    useGraphStore.getState().deleteNode(source!.id);
    await flushPromises();

    expect(persistence.updateNode).toHaveBeenCalledTimes(1);
    expect(persistence.updateEdge).toHaveBeenCalledTimes(1);
    expect(persistence.deleteEdge).toHaveBeenCalledWith("edge-runtime-created");
    expect(persistence.deleteEntity).toHaveBeenCalledWith(source!.id);
  });

  it("persists a frame through the atomic composition boundary", async () => {
    const persistence = runtimePersistenceMock();
    useGraphStore.getState().setRuntimePersistence(persistence);
    useGraphStore.setState({ runtimeStatus: "ready" });

    useGraphStore.getState().addFrameAt(
      { title: "Harbor", kind: "Location", summary: "Dock district", tags: [] },
      { x: 120, y: 80 },
      { width: 540, height: 380 }
    );
    await flushPromises();

    expect(persistence.createFrame).toHaveBeenCalledWith(
      "project-aurora",
      expect.objectContaining({ position: { x: 120, y: 80 }, width: 540, height: 380 })
    );
    expect(useGraphStore.getState().getActiveGraph().nodes.at(-1)).toMatchObject({
      id: "frame-runtime-created",
      data: { isFrame: true, kind: "Location" }
    });
  });

  it("places a node in a frame and persists the complete gesture atomically", async () => {
    const persistence = runtimePersistenceMock();
    useGraphStore.getState().setRuntimePersistence(persistence);
    useGraphStore.setState({ runtimeStatus: "ready" });
    const previous = useGraphStore.getState().getActiveGraph().nodes;

    useGraphStore.getState().onNodesChange([{ id: "node-hero", type: "position", position: { x: 1300, y: 700 }, dragging: false }]);
    const result = useGraphStore.getState().completeNodeDrop("node-hero", "node-opening", previous);
    await flushPromises();

    expect(result).toMatchObject({ valid: true });
    expect(useGraphStore.getState().getActiveGraph().nodes.find((node) => node.id === "node-hero")).toMatchObject({
      parentId: "node-opening",
      position: { x: 900, y: 640 }
    });
    expect(useGraphStore.getState().getActiveGraph().nodes.find((node) => node.id === "node-opening")).toMatchObject({ width: 1184, height: 820 });
    expect(persistence.updatePlacement).not.toHaveBeenCalled();
    expect(persistence.updatePlacements).toHaveBeenCalledTimes(1);
    expect(persistence.updatePlacements).toHaveBeenCalledWith("project-aurora", expect.arrayContaining([
      expect.objectContaining({ id: "node-hero", parentId: "node-opening" }),
      expect.objectContaining({ id: "node-opening", width: 1184, height: 820 })
    ]));
  });

  it("restores an invalid drop and clamps frame resize until explicit fit", () => {
    useGraphStore.getState().addFrameAt(
      { title: "Warehouse", kind: "Location", summary: "", tags: [] },
      { x: 1100, y: 100 },
      { width: 520, height: 360 }
    );
    const frameId = useGraphStore.getState().getActiveGraph().nodes.at(-1)!.id;
    const beforeInvalidDrop = useGraphStore.getState().getActiveGraph().nodes;
    const invalid = useGraphStore.getState().completeNodeDrop("node-dock-dialogue", frameId, beforeInvalidDrop);
    expect(invalid).toMatchObject({ valid: false, message: "Location cannot contain Dialogue" });
    expect(useGraphStore.getState().getActiveGraph().nodes.find((node) => node.id === "node-dock-dialogue")?.parentId).toBe("node-opening");

    const beforeResize = useGraphStore.getState().getActiveGraph().nodes;
    useGraphStore.getState().onNodesChange([{ id: "node-opening", type: "dimensions", dimensions: { width: 100, height: 100 }, resizing: false }]);
    useGraphStore.getState().completeNodeResize(beforeResize);
    expect(useGraphStore.getState().getActiveGraph().nodes.find((node) => node.id === "node-opening")).toMatchObject({ width: 1060, height: 580 });

    useGraphStore.getState().onNodesChange([{ id: "node-opening", type: "dimensions", dimensions: { width: 900, height: 700 }, resizing: false }]);
    useGraphStore.getState().fitFrame("node-opening");
    expect(useGraphStore.getState().getActiveGraph().nodes.find((node) => node.id === "node-opening")).toMatchObject({ width: 1044, height: 564 });
  });

  it("collapses and expands a Scene placement without losing geometry or membership", async () => {
    const persistence = runtimePersistenceMock();
    useGraphStore.getState().setRuntimePersistence(persistence);
    useGraphStore.setState({ runtimeStatus: "ready" });
    const childIds = useGraphStore.getState().getActiveGraph().nodes
      .filter((node) => node.parentId === "node-opening")
      .map((node) => node.id);

    useGraphStore.getState().toggleFrameCollapse("node-opening");
    await flushPromises();
    expect(useGraphStore.getState().getActiveGraph().nodes.find((node) => node.id === "node-opening")).toMatchObject({
      width: 280,
      height: 112,
      data: { presentationState: "collapsed", expandedFrameSize: { width: 1060, height: 580 } }
    });
    expect(useGraphStore.getState().getActiveGraph().nodes.filter((node) => node.parentId === "node-opening").map((node) => node.id)).toEqual(childIds);
    expect(persistence.updatePlacement).toHaveBeenLastCalledWith("project-aurora", expect.objectContaining({
      data: expect.objectContaining({ presentationState: "collapsed" })
    }));

    useGraphStore.getState().toggleFrameCollapse("node-opening");
    expect(useGraphStore.getState().getActiveGraph().nodes.find((node) => node.id === "node-opening")).toMatchObject({
      width: 1060,
      height: 580,
      data: { presentationState: "expanded" }
    });
  });

  it("rolls back Scene presentation when placement persistence fails", async () => {
    const persistence = runtimePersistenceMock({ updatePlacement: vi.fn(async () => { throw new Error("presentation failed"); }) });
    useGraphStore.getState().setRuntimePersistence(persistence);
    useGraphStore.setState({ runtimeStatus: "ready" });

    useGraphStore.getState().toggleFrameCollapse("node-opening");
    await flushPromises();

    expect(useGraphStore.getState().getActiveGraph().nodes.find((node) => node.id === "node-opening")).toMatchObject({ width: 1060, height: 580 });
    expect(useGraphStore.getState().runtimeError).toBe("presentation failed");
  });

  it("expands a compact Scene before adding another linked placement", () => {
    useGraphStore.getState().toggleFrameCollapse("node-opening");

    expect(useGraphStore.getState().addLinkedInstance("node-hero", "node-opening")).toMatchObject({ valid: true });

    const graph = useGraphStore.getState().getActiveGraph();
    expect(graph.nodes.find((node) => node.id === "node-opening")).toMatchObject({
      height: 778,
      data: { presentationState: "expanded" }
    });
    expect(graph.nodes.some((node) => node.parentId === "node-opening" && node.data.canonicalNodeId === "node-hero")).toBe(true);
  });

  it("rejects Scene children and linked Location cycles without mutating composition", () => {
    const before = useGraphStore.getState().getActiveGraph().nodes;

    expect(useGraphStore.getState().addLinkedInstance("node-opening", "node-harbor")).toEqual({
      message: "Location cannot contain Scene",
      valid: false
    });
    expect(useGraphStore.getState().addLinkedInstance("node-harbor", "node-customs-office")).toEqual({
      message: "Location containment cannot create a cycle",
      valid: false
    });
    expect(useGraphStore.getState().getActiveGraph().nodes).toBe(before);
  });

  it("creates, synchronizes, and removes a linked visual instance", async () => {
    const persistence = runtimePersistenceMock();
    useGraphStore.getState().setRuntimePersistence(persistence);
    useGraphStore.setState({ runtimeStatus: "ready" });

    expect(useGraphStore.getState().addLinkedInstance("node-hero", "node-opening")).toMatchObject({ valid: true });
    await flushPromises();
    const linked = useGraphStore.getState().getActiveGraph().nodes.find((node) => node.data.isLinkedInstance && node.data.canonicalNodeId === "node-hero")!;
    expect(linked).toMatchObject({ id: "placement:linked-node-hero", parentId: "node-opening", data: { placementId: "linked-node-hero" } });
    expect(persistence.createLinkedPlacement).toHaveBeenCalledTimes(1);

    useGraphStore.getState().updateNode(linked.id, { title: "Mara Updated", kind: "Character", summary: "Shared", tags: ["shared"] });
    expect(useGraphStore.getState().getActiveGraph().nodes.filter((node) => (node.data.canonicalNodeId ?? node.id) === "node-hero").map((node) => node.data.title)).toEqual([
      "Mara Updated",
      "Mara Updated"
    ]);

    useGraphStore.getState().removeInstance(linked.id);
    await flushPromises();
    expect(useGraphStore.getState().getActiveGraph().nodes.some((node) => node.id === "node-hero")).toBe(true);
    expect(useGraphStore.getState().getActiveGraph().nodes.some((node) => node.id === linked.id)).toBe(false);
    expect(persistence.removePlacement).toHaveBeenCalledWith("linked-node-hero");
  });

  it("moves a linked visual placement without moving its canonical placement", () => {
    useGraphStore.getState().addLinkedInstance("node-hero", "node-opening");
    const before = useGraphStore.getState().getActiveGraph().nodes;
    const canonicalBefore = before.find((node) => node.id === "node-hero")!;
    const linkedBefore = before.find((node) => node.data.isLinkedInstance && node.data.canonicalNodeId === "node-hero")!;
    const linkedPosition = { x: linkedBefore.position.x + 40, y: linkedBefore.position.y + 24 };

    useGraphStore.getState().onNodesChange([{
      id: linkedBefore.id,
      type: "position",
      position: linkedPosition,
      dragging: true
    }]);

    const after = useGraphStore.getState().getActiveGraph().nodes;
    expect(after.find((node) => node.id === linkedBefore.id)?.position).toEqual(linkedPosition);
    expect(after.find((node) => node.id === canonicalBefore.id)?.position).toEqual(canonicalBefore.position);
  });

  it("persists a group movement atomically as one composition history entry", async () => {
    const persistence = runtimePersistenceMock();
    useGraphStore.getState().setRuntimePersistence(persistence);
    useGraphStore.setState({ runtimeStatus: "ready" });
    const before = useGraphStore.getState().getActiveGraph().nodes;
    const movedIds = ["node-hero", "node-trade-guild"];

    useGraphStore.getState().onNodesChange(movedIds.map((id, index) => ({
      id,
      type: "position" as const,
      position: { x: 900 + index * 320, y: 640 },
      dragging: false
    })));
    useGraphStore.getState().completeGroupMove(before);
    await flushPromises();

    expect(persistence.updatePlacements).toHaveBeenCalledTimes(1);
    expect(persistence.updatePlacements).toHaveBeenCalledWith("project-aurora", expect.arrayContaining([
      expect.objectContaining({ id: "node-hero" }),
      expect.objectContaining({ id: "node-trade-guild" })
    ]));

    expect(useGraphStore.getState().getActiveGraph().nodes.find((node) => node.id === "node-hero")?.position).toEqual({ x: 900, y: 640 });
  });

  it("creates and attaches a placement when a legacy Quest is moved for the first time", async () => {
    const legacyQuestId = "ce9aa006-b53b-497c-ae62-76be28587a71";
    const persistence = runtimePersistenceMock();
    useGraphStore.getState().setRuntimePersistence(persistence);
    useGraphStore.setState({ runtimeStatus: "ready" });
    const state = useGraphStore.getState();
    const graph = state.getActiveGraph();
    const questTemplate = graph.nodes.find((node) => node.id === "node-smuggler-route")!;
    useGraphStore.setState({
      graphs: {
        ...state.graphs,
        [state.activeProjectId]: {
          ...graph,
          nodes: [
            ...graph.nodes,
            {
              ...questTemplate,
              id: legacyQuestId,
              position: { x: 365, y: 1231 },
              data: {
                ...questTemplate.data,
                canonicalNodeId: undefined,
                label: "Quest node",
                placementId: undefined,
                rootPlacementId: undefined,
                title: "Quest node"
              }
            }
          ]
        }
      }
    });
    const before = useGraphStore.getState().getActiveGraph().nodes;

    useGraphStore.getState().onNodesChange([{
      id: legacyQuestId,
      type: "position",
      position: { x: 260, y: 420 },
      dragging: false
    }]);
    useGraphStore.getState().completeGroupMove(before);
    await flushPromises();

    expect(persistence.updatePlacement).toHaveBeenCalledWith(
      "project-aurora",
      expect.objectContaining({ id: legacyQuestId, position: { x: 260, y: 420 } })
    );
    expect(persistence.updatePlacements).not.toHaveBeenCalled();
    expect(useGraphStore.getState().getActiveGraph().nodes.find((node) => node.id === legacyQuestId))
      .toMatchObject({
        id: legacyQuestId,
        position: { x: 260, y: 420 },
        data: { placementId: `placement-${legacyQuestId}` }
      });
  });

  it("rolls back every optimistic group position when atomic persistence fails", async () => {
    const persistence = runtimePersistenceMock({ updatePlacements: vi.fn(async () => { throw new Error("group move failed"); }) });
    useGraphStore.getState().setRuntimePersistence(persistence);
    useGraphStore.setState({ runtimeStatus: "ready" });
    const before = useGraphStore.getState().getActiveGraph().nodes;

    useGraphStore.getState().onNodesChange([
      { id: "node-hero", type: "position", position: { x: 900, y: 640 }, dragging: false },
      { id: "node-trade-guild", type: "position", position: { x: 1220, y: 640 }, dragging: false }
    ]);
    useGraphStore.getState().completeGroupMove(before);
    await flushPromises();

    expect(useGraphStore.getState().getActiveGraph().nodes.find((node) => node.id === "node-hero")?.position).toEqual(
      before.find((node) => node.id === "node-hero")?.position
    );
    expect(useGraphStore.getState().getActiveGraph().nodes.find((node) => node.id === "node-trade-guild")?.position).toEqual(
      before.find((node) => node.id === "node-trade-guild")?.position
    );
    expect(useGraphStore.getState().runtimeError).toBe("group move failed");
  });

  it("rolls back an optimistic linked instance when persistence fails", async () => {
    const persistence = runtimePersistenceMock({ createLinkedPlacement: vi.fn(async () => { throw new Error("linked placement failed"); }) });
    useGraphStore.getState().setRuntimePersistence(persistence);
    useGraphStore.setState({ runtimeStatus: "ready" });
    const before = useGraphStore.getState().getActiveGraph().nodes.length;

    useGraphStore.getState().addLinkedInstance("node-hero", "node-opening");
    await flushPromises();

    expect(useGraphStore.getState().getActiveGraph().nodes).toHaveLength(before);
    expect(useGraphStore.getState().runtimeError).toBe("linked placement failed");
  });

  it("restores every placement when canonical deletion fails", async () => {
    const persistence = runtimePersistenceMock({ deleteEntity: vi.fn(async () => { throw new Error("entity delete failed"); }) });
    useGraphStore.getState().setRuntimePersistence(persistence);
    useGraphStore.setState({ runtimeStatus: "ready", selection: { type: "node", id: "node-sealed-ledger" } });
    const before = useGraphStore.getState().getActiveGraph();

    useGraphStore.getState().deleteNode("node-sealed-ledger");
    await flushPromises();

    expect(useGraphStore.getState().getActiveGraph()).toEqual(before);
    expect(useGraphStore.getState().selection).toEqual({ type: "node", id: "node-sealed-ledger" });
    expect(useGraphStore.getState().runtimeError).toBe("entity delete failed");
  });

  it("keeps optimistic local changes and exposes runtime errors when persistence fails", async () => {
    const persistence = runtimePersistenceMock({
      createNode: vi.fn(async () => {
        throw new Error("Runtime write failed");
      })
    });
    useGraphStore.getState().setRuntimePersistence(persistence);
    useGraphStore.setState({ runtimeStatus: "ready" });

    useGraphStore.getState().addManualNode({ title: "Local Only", kind: "Scene", summary: "Fallback", tags: [] });
    await flushPromises();

    const state = useGraphStore.getState();
    expect(state.getActiveGraph().nodes.at(-1)?.data.title).toBe("Local Only");
    expect(state.runtimeStatus).toBe("fallback");
    expect(state.runtimeError).toBe("Runtime write failed");
  });

  it("rolls a failed durable mutation back to the complete session snapshot", async () => {
    const before = useGraphStore.getState();
    const snapshot = {
      activeProjectId: before.activeProjectId,
      activeSessionId: "session-aurora",
      edges: before.getActiveGraph().edges,
      issues: before.getActiveGraph().issues,
      nodes: before.getActiveGraph().nodes,
      playbackEffectsByFlow: before.playbackEffectsByFlow,
      projects: before.projects,
      storyFlows: before.storyFlowsByProject[before.activeProjectId]
    };
    const persistence = runtimePersistenceMock({
      createNode: vi.fn(async () => {
        throw new Error("Durable write failed");
      }),
      loadProjectSessionSnapshot: vi.fn(async () => snapshot)
    });
    useGraphStore.getState().setRuntimePersistence(persistence);
    useGraphStore.setState({ activeSessionId: "session-aurora", runtimeStatus: "ready" });

    useGraphStore.getState().addManualNode({ title: "Must Roll Back", kind: "Scene", summary: "", tags: [] });
    await flushPromises();
    await flushPromises();

    const state = useGraphStore.getState();
    expect(state.getActiveGraph().nodes.some((node) => node.data.title === "Must Roll Back")).toBe(false);
    expect(state.runtimeStatus).toBe("ready");
    expect(state.runtimeError).toBe("Durable write failed");
  });
});

function runtimePersistenceMock(overrides: Partial<RuntimeGraphPersistence> = {}): RuntimeGraphPersistence {
  return {
    loadProjectSessionSnapshot: vi.fn(async () => {
      const state = useGraphStore.getState();
      return {
        activeProjectId: state.activeProjectId,
        activeSessionId: state.activeSessionId,
        edges: state.getActiveGraph().edges,
        issues: state.getActiveGraph().issues,
        nodes: state.getActiveGraph().nodes,
        playbackEffectsByFlow: state.playbackEffectsByFlow,
        projects: state.projects,
        storyFlows: state.storyFlowsByProject[state.activeProjectId]
      };
    }),
    createProject: vi.fn(async (draft) => ({
      id: "project-runtime-created",
      name: draft.name,
      description: draft.description,
      path: draft.path ?? "~/Stories",
      status: "open" as const,
      updatedAt: "2026-06-20"
    })),
    createNode: vi.fn(async (_projectId, node) => ({ ...node, id: "node-runtime-created" })),
    createFrame: vi.fn(async (_projectId, node) => ({ ...node, id: "frame-runtime-created" })),
    updatePlacement: vi.fn(async (projectId, node) => ({
      placement_version: 1 as const,
      id: node.data.placementId ?? `placement-${node.id}`,
      project_id: projectId,
      container_node_id: node.parentId ?? null,
      canonical_node_id: node.id,
      position: node.position,
      size: { width: node.width ?? 260, height: node.height ?? 156 },
      is_primary: true,
      presentation_state: "expanded" as const,
      metadata: {}
    })),
    updatePlacements: vi.fn(async (projectId) => ({
      composition_version: 1 as const,
      project_id: projectId,
      placements: [],
      semantic_relationships: []
    })),
    createLinkedPlacement: vi.fn(async (projectId, canonicalNodeId, containerNodeId, position, size) => ({
      placement_version: 1 as const,
      id: `linked-${canonicalNodeId}`,
      project_id: projectId,
      container_node_id: containerNodeId,
      canonical_node_id: canonicalNodeId,
      position,
      size,
      is_primary: false,
      presentation_state: "expanded" as const,
      metadata: { linked_instance: true }
    })),
    removePlacement: vi.fn(async () => ({ composition_version: 1 as const, project_id: "project-aurora", placements: [], semantic_relationships: [] })),
    deleteEntity: vi.fn(async () => undefined),
    updateNode: vi.fn(async (_projectId, node) => node),
    deleteNode: vi.fn(async () => undefined),
    createEdge: vi.fn(async (_projectId, edge) => ({ ...edge, id: "edge-runtime-created" })),
    updateEdge: vi.fn(async (_projectId, edge) => edge),
    deleteEdge: vi.fn(async () => undefined),
    createFactionMembership: vi.fn(async (factionId, characterId) => ({
      id: "membership-runtime-created",
      source: characterId,
      target: factionId,
      label: "member of",
      data: { canvasVisibility: "hidden" as const, label: "member of", relationshipType: "member_of" as const }
    })),
    removeFactionMembership: vi.fn(async () => undefined),
    loadDialogueDocument: vi.fn(async () => ({ dialogue_version: 1 as const, elements: [], entry_element_id: null, participants: [] })),
    updateDialogueDocument: vi.fn(async (_nodeId, document) => document),
    createDialogueTransition: vi.fn(async (_projectId, _draft, edge, newTarget) => ({
      edge,
      targetNode: newTarget ?? useGraphStore.getState().getActiveGraph().nodes.find((node) => node.id === edge.target)!
    })),
    updateDialogueTransition: vi.fn(async (edge) => ({
      edge,
      targetNode: useGraphStore.getState().getActiveGraph().nodes.find((node) => node.id === edge.target)!
    })),
    loadQuestDocument: vi.fn(async () => ({
      quest_version: 1 as const,
      objective: "",
      quest_giver_node_id: null,
      entry_stage_id: null,
      prerequisite_node_ids: [],
      reward_node_ids: [],
      stages: []
    })),
    updateQuestDocument: vi.fn(async (_nodeId, document) => document),
    createQuestTransition: vi.fn(async (_projectId, _draft, edge, newTarget) => ({
      edge,
      targetNode: newTarget ?? useGraphStore.getState().getActiveGraph().nodes.find((node) => node.id === edge.target)!
    })),
    updateQuestTransition: vi.fn(async (edge) => ({
      edge,
      targetNode: useGraphStore.getState().getActiveGraph().nodes.find((node) => node.id === edge.target)!
    })),
    analyzeScene: vi.fn(async (projectId, title) => ({
      project_id: projectId,
      suggestion_id: "suggestion-runtime",
      provider: "deterministic" as const,
      extracted_facts: [],
      patch: { title, description: "", operations: [], metadata: {} },
      warnings: []
    })),
    approveSuggestion: vi.fn(async (suggestionId) => ({
      id: suggestionId,
      project_id: "project-runtime",
      title: "Approved",
      description: "",
      status: "approved",
      patch: {},
      created_by: "local-user",
      metadata: {},
      created_at: "2026-07-11T00:00:00Z",
      updated_at: "2026-07-11T00:00:00Z"
    })),
    rejectSuggestion: vi.fn(async (suggestionId) => ({
      id: suggestionId,
      project_id: "project-runtime",
      title: "Rejected",
      description: "",
      status: "rejected",
      patch: {},
      created_by: "local-user",
      metadata: {},
      created_at: "2026-07-11T00:00:00Z",
      updated_at: "2026-07-11T00:00:00Z"
    })),
    approveSuggestionOperation: vi.fn(async (suggestionId, operationIndex) => ({
      id: suggestionId,
      project_id: "project-runtime",
      title: "Approved operation",
      description: "",
      status: "pending",
      patch: {},
      created_by: "local-user",
      metadata: { operation_decisions: { [operationIndex]: "approved" } },
      created_at: "2026-07-11T00:00:00Z",
      updated_at: "2026-07-11T00:00:00Z"
    })),
    rejectSuggestionOperation: vi.fn(async (suggestionId, operationIndex) => ({
      id: suggestionId,
      project_id: "project-runtime",
      title: "Rejected operation",
      description: "",
      status: "pending",
      patch: {},
      created_by: "local-user",
      metadata: { operation_decisions: { [operationIndex]: "rejected" } },
      created_at: "2026-07-11T00:00:00Z",
      updated_at: "2026-07-11T00:00:00Z"
    })),
    ...overrides
  };
}

function flushPromises() {
  return new Promise((resolve) => setTimeout(resolve, 0));
}
