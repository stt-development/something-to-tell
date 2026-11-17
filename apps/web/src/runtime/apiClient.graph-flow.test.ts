import { MarkerType, type Node } from "@xyflow/react";
import { describe, expect, it, vi } from "vitest";
import {
  PROJECT_SETTINGS_VERSION,
  createDefaultProjectSettings
} from "@something-to-tell/contracts/project-manifest";
import type { ImpactAnalysisRequest } from "@something-to-tell/contracts/impact-analysis";
import type { ImpactResolutionRequest } from "@something-to-tell/contracts/impact-resolution";
import type { VisualPlacement } from "../composition/contracts";
import type { NarrativeNodeData } from "../types";
import type { StoryFlow } from "../story-flow/contracts";
import { applyRuntimeComposition, createRuntimeApiClient, projectSessionToGraphSnapshot, RuntimeApiError, runtimeEdgeToFlowEdge, runtimeIssueToNarrativeIssue, runtimeNodeToFlowNode, runtimeProjectToNarrativeProject, type RuntimeNode, type RuntimeProjectSessionResponse } from "./apiClient";


describe("runtime graph and flow clients", () => {
  it("loads a runtime graph snapshot with project-scoped nodes, edges, and issues", async () => {
    const fetcher = vi.fn(async (input: string) => {
      if (input.endsWith("/projects")) {
        return jsonResponse([
          {
            id: "project-runtime",
            name: "Runtime Project",
            path: "~/Stories/Runtime.narrative",
            format_version: 1,
            metadata: {},
            created_at: "2026-06-20T10:00:00Z",
            updated_at: "2026-06-20T11:00:00Z"
          }
        ]);
      }
      if (input.endsWith("/nodes?project_id=project-runtime")) {
        return jsonResponse([]);
      }
      if (input.endsWith("/edges?project_id=project-runtime")) {
        return jsonResponse([]);
      }
      if (input.endsWith("/issues?project_id=project-runtime")) {
        return jsonResponse([
          {
            id: "issue-runtime",
            project_id: "project-runtime",
            title: "Runtime issue",
            node_id: "node-runtime",
            edge_id: null,
            description: "Loaded issue",
            severity: "warning",
            status: "open",
            metadata: {},
            created_at: "2026-06-20T10:00:00Z",
            updated_at: "2026-06-20T11:00:00Z"
          }
        ]);
      }
      if (input.endsWith("/compositions?project_id=project-runtime")) {
        return jsonResponse({ composition_version: 1, project_id: "project-runtime", placements: [], semantic_relationships: [] });
      }
      return new Response(null, { status: 404 });
    });

    const client = createRuntimeApiClient({ baseUrl: "http://runtime.test/api", fetcher });
    const snapshot = await client.loadGraphSnapshot();

    expect(snapshot.activeProjectId).toBe("project-runtime");
    expect(snapshot.projects).toHaveLength(1);
    expect(snapshot.issues).toHaveLength(1);
    expect(fetcher).toHaveBeenCalledWith("http://runtime.test/api/nodes?project_id=project-runtime", undefined);
    expect(fetcher).toHaveBeenCalledWith("http://runtime.test/api/edges?project_id=project-runtime", undefined);
    expect(fetcher).toHaveBeenCalledWith("http://runtime.test/api/issues?project_id=project-runtime", undefined);
    expect(fetcher).toHaveBeenCalledWith("http://runtime.test/api/compositions?project_id=project-runtime", undefined);
  });

  it("writes Faction membership through its dedicated runtime endpoints", async () => {
    const fetcher = vi.fn(async (input: string, init?: RequestInit) => {
      if (input.endsWith("/factions/faction/members") && init?.method === "POST") {
        expect(JSON.parse(String(init.body))).toEqual({ character_node_id: "character" });
        return jsonResponse({
          id: "membership-runtime",
          project_id: "project-runtime",
          source_node_id: "character",
          target_node_id: "faction",
          type: "member_of",
          label: "member of",
          condition: "",
          metadata: { canvas_visibility: "hidden" },
          created_at: "2026-06-20T10:00:00Z",
          updated_at: "2026-06-20T11:00:00Z"
        });
      }
      if (input.endsWith("/factions/faction/members/character") && init?.method === "DELETE") {
        return new Response(null, { status: 204 });
      }
      return new Response(null, { status: 404 });
    });
    const client = createRuntimeApiClient({ baseUrl: "http://runtime.test/api", fetcher });

    await expect(client.createFactionMembership("faction", "character")).resolves.toMatchObject({
      source: "character",
      target: "faction",
      data: { relationshipType: "member_of" }
    });
    await expect(client.removeFactionMembership("faction", "character")).resolves.toBeUndefined();
  });

  it("round-trips specialized Requirement and Outcome metadata", async () => {
    const fetcher = vi.fn(async (_input: string, init?: RequestInit) => {
      const body = JSON.parse(String(init?.body));
      expect(body.metadata).toMatchObject({
        requirement: { expression: "flags.ledger", predicate: "has the ledger", subject: "Mara" }
      });
      return jsonResponse({
        id: "requirement",
        project_id: body.project_id,
        type: body.type,
        title: body.title,
        summary: body.summary,
        body: body.body,
        status: body.status,
        metadata: body.metadata,
        created_at: "2026-06-20T10:00:00Z",
        updated_at: "2026-06-20T11:00:00Z"
      });
    });
    const client = createRuntimeApiClient({ baseUrl: "http://runtime.test/api", fetcher });
    const requirement: Node<NarrativeNodeData> = {
      id: "requirement",
      type: "narrative",
      position: { x: 10, y: 20 },
      data: {
        kind: "Condition",
        label: "Ledger Acquired",
        title: "Ledger Acquired",
        summary: "Gate",
        tags: ["gate"],
        requirement: { expression: "flags.ledger", predicate: "has the ledger", subject: "Mara" }
      }
    };

    await expect(client.updateNode("project-runtime", requirement)).resolves.toMatchObject({
      data: { kind: "Condition", requirement: { expression: "flags.ledger", predicate: "has the ledger", subject: "Mara" } }
    });
    expect(runtimeNodeToFlowNode({
      ...runtimeNode("outcome", "Consequence"),
      metadata: { outcome: { effect: "Route opens", targetNodeIds: ["harbor", 42] } }
    }).data.outcome).toEqual({ effect: "Route opens", targetNodeIds: ["harbor"] });
  });

  it("persists Character role and Item purpose separately from tags", async () => {
    const fetcher = vi.fn(async (_input: string, init?: RequestInit) => {
      const body = JSON.parse(String(init?.body));
      if (body.type === "Character") {
        expect(body.metadata).toMatchObject({ character_role: "Player captain", tags: ["crew", "voice"] });
      } else {
        expect(body.metadata).toMatchObject({ item_purpose: "Negotiation evidence", tags: ["evidence"] });
      }
      return jsonResponse({
        id: body.type.toLowerCase(),
        project_id: body.project_id,
        type: body.type,
        title: body.title,
        summary: body.summary,
        body: body.body,
        status: body.status,
        metadata: body.metadata,
        created_at: "2026-06-20T10:00:00Z",
        updated_at: "2026-06-20T11:00:00Z"
      });
    });
    const client = createRuntimeApiClient({ baseUrl: "http://runtime.test/api", fetcher });
    const semanticNode = (kind: "Character" | "Item", tags: string[]): Node<NarrativeNodeData> => ({
      id: kind.toLowerCase(),
      type: "narrative",
      position: { x: 0, y: 0 },
      data: { kind, label: kind, title: kind, summary: "", tags }
    });
    const character = semanticNode("Character", ["crew", "voice"]);
    character.data.characterRole = "Player captain";
    const item = semanticNode("Item", ["evidence"]);
    item.data.itemPurpose = "Negotiation evidence";

    await expect(client.updateNode("project-runtime", character)).resolves.toMatchObject({ data: { characterRole: "Player captain", tags: ["crew", "voice"] } });
    await expect(client.updateNode("project-runtime", item)).resolves.toMatchObject({ data: { itemPurpose: "Negotiation evidence", tags: ["evidence"] } });
  });

  it("writes project, node, edge, and delete mutations through runtime endpoints", async () => {
    const fetcher = vi.fn(async (input: string, init?: RequestInit) => {
      if (input.endsWith("/projects") && init?.method === "POST") {
        expect(JSON.parse(String(init.body))).toMatchObject({
          format_version: 1,
          metadata: { description: "Runtime notes", status: "open" },
          name: "Runtime Project"
        });
        return jsonResponse({
          id: "project-runtime",
          name: "Runtime Project",
          path: "~/Stories",
          format_version: 1,
          metadata: { description: "Runtime notes" },
          created_at: "2026-06-20T10:00:00Z",
          updated_at: "2026-06-20T11:00:00Z"
        });
      }
      if (input.endsWith("/nodes") && init?.method === "POST") {
        expect(JSON.parse(String(init.body))).toMatchObject({
          metadata: { position: { x: 10, y: 20 }, tags: ["intro"] },
          project_id: "project-runtime",
          title: "Opening Dock",
          type: "Scene"
        });
        return jsonResponse({
          id: "node-runtime",
          project_id: "project-runtime",
          type: "Scene",
          title: "Opening Dock",
          summary: "Runtime scene",
          body: "Runtime scene",
          status: "canon",
          metadata: { position: { x: 10, y: 20 }, tags: ["intro"] },
          created_at: "2026-06-20T10:00:00Z",
          updated_at: "2026-06-20T11:00:00Z"
        });
      }
      if (input.endsWith("/edges") && init?.method === "POST") {
        expect(JSON.parse(String(init.body))).toMatchObject({
          label: "reveals",
          metadata: { dialogue_element_id: "line-result", sourceHandle: "right", targetHandle: "left" },
          project_id: "project-runtime",
          source_node_id: "source",
          target_node_id: "target",
          type: "reveals"
        });
        return jsonResponse({
          id: "edge-runtime",
          project_id: "project-runtime",
          source_node_id: "source",
          target_node_id: "target",
          type: "reveals",
          label: "reveals",
          condition: "",
          metadata: { dialogue_element_id: "line-result", sourceHandle: "right", targetHandle: "left" },
          created_at: "2026-06-20T10:00:00Z",
          updated_at: "2026-06-20T11:00:00Z"
        });
      }
      if (input.endsWith("/nodes/node-runtime") && init?.method === "DELETE") {
        return new Response(null, { status: 204 });
      }
      return new Response(null, { status: 404 });
    });

    const client = createRuntimeApiClient({ baseUrl: "http://runtime.test/api", fetcher });

    await expect(client.createProject({
      description: "Runtime notes",
      name: "Runtime Project",
      path: "~/Stories",
      settings: createDefaultProjectSettings()
    })).resolves.toMatchObject({
      id: "project-runtime"
    });
    await expect(
      client.createNode("project-runtime", {
        id: "node-local",
        type: "narrative",
        position: { x: 10, y: 20 },
        data: { kind: "Scene", label: "Opening Dock", summary: "Runtime scene", tags: ["intro"], title: "Opening Dock" }
      })
    ).resolves.toMatchObject({ id: "node-runtime" });
    await expect(
      client.createEdge("project-runtime", {
        id: "edge-local",
        source: "source",
        sourceHandle: "right",
        target: "target",
        targetHandle: "left",
        label: "reveals",
        data: { dialogueElementId: "line-result", label: "reveals", relationshipType: "reveals" }
      })
    ).resolves.toMatchObject({ id: "edge-runtime" });
    await expect(client.deleteNode("node-runtime")).resolves.toBeUndefined();
  });

  it("requests scene analysis patch previews from the runtime", async () => {
    const fetcher = vi.fn(async (input: string, init?: RequestInit) => {
      if (input.endsWith("/analysis/scenes") && init?.method === "POST") {
        expect(JSON.parse(String(init.body))).toMatchObject({
          metadata: {},
          project_id: "project-runtime",
          provider: "deterministic",
          scene_text: "Character: Mara Vale",
          title: "Opening"
        });
        return jsonResponse({
          project_id: "project-runtime",
          suggestion_id: "suggestion-runtime",
          provider: "deterministic",
          extracted_facts: [],
          patch: { title: "Opening graph suggestions", description: "", operations: [], metadata: {} },
          warnings: ["No applicable graph changes were found."]
        });
      }
      return new Response(null, { status: 404 });
    });

    const client = createRuntimeApiClient({ baseUrl: "http://runtime.test/api", fetcher });

    await expect(client.analyzeScene("project-runtime", "Opening", "Character: Mara Vale")).resolves.toMatchObject({
      suggestion_id: "suggestion-runtime",
      warnings: ["No applicable graph changes were found."]
    });
  });

  it("loads and updates dialogue documents through dedicated runtime endpoints", async () => {
    const document = { dialogue_version: 1 as const, elements: [], entry_element_id: null, participants: ["node-character"] };
    const fetcher = vi.fn(async (input: string, init?: RequestInit) => {
      expect(input).toBe("http://runtime.test/api/dialogues/node-dialogue");
      if (init?.method === "PUT") {
        expect(JSON.parse(String(init.body))).toEqual(document);
      }
      return jsonResponse(document);
    });
    const client = createRuntimeApiClient({ baseUrl: "http://runtime.test/api", fetcher });

    await expect(client.loadDialogueDocument("node-dialogue")).resolves.toEqual(document);
    await expect(client.updateDialogueDocument("node-dialogue", document)).resolves.toEqual(document);
    expect(fetcher).toHaveBeenNthCalledWith(1, "http://runtime.test/api/dialogues/node-dialogue", undefined);
    expect(fetcher).toHaveBeenNthCalledWith(
      2,
      "http://runtime.test/api/dialogues/node-dialogue",
      expect.objectContaining({ method: "PUT" })
    );
  });

  it("loads and updates Quest documents through dedicated runtime endpoints", async () => {
    const document = {
      quest_version: 1 as const,
      objective: "Open the route",
      quest_giver_node_id: null,
      entry_stage_id: "stage-1",
      prerequisite_node_ids: [],
      reward_node_ids: [],
      stages: [{ id: "stage-1", title: "Start", description: "", branches: [] }]
    };
    const fetcher = vi.fn(async (input: string, init?: RequestInit) => {
      expect(input).toBe("http://runtime.test/api/quests/node-quest");
      if (init?.method === "PUT") expect(JSON.parse(String(init.body))).toEqual(document);
      return jsonResponse(document);
    });
    const client = createRuntimeApiClient({ baseUrl: "http://runtime.test/api", fetcher });

    await expect(client.loadQuestDocument("node-quest")).resolves.toEqual(document);
    await expect(client.updateQuestDocument("node-quest", document)).resolves.toEqual(document);
  });

  it("hydrates Quest aggregate and transition metadata", () => {
    const quest = runtimeNodeToFlowNode({
      ...runtimeNode("quest", "Quest"),
      metadata: {
        quest_document: {
          quest_version: 1,
          objective: "Open the route",
          quest_giver_node_id: null,
          entry_stage_id: null,
          prerequisite_node_ids: [],
          reward_node_ids: [],
          stages: []
        }
      }
    });
    const edge = runtimeEdgeToFlowEdge({
      id: "quest-edge",
      project_id: "project-runtime",
      source_node_id: "quest",
      target_node_id: "event",
      type: "leads_to",
      label: "opens",
      condition: "",
      metadata: {
        quest_stage_id: "stage-1",
        quest_branch_id: "branch-open",
        outcome_flow_composition: {
          invocation_id: "invocation-quest",
          source_flow_id: "flow-main",
          target_flow_id: "flow-side"
        }
      },
      created_at: "2026-06-20T10:00:00Z",
      updated_at: "2026-06-20T10:00:00Z"
    });

    expect(quest.data.questDocument?.objective).toBe("Open the route");
    expect(edge.data).toMatchObject({
      outcomeFlowComposition: { invocationId: "invocation-quest", sourceFlowId: "flow-main", targetFlowId: "flow-side" },
      questStageId: "stage-1",
      questBranchId: "branch-open"
    });
  });

  it("creates and updates atomic dialogue transitions", async () => {
    const document = {
      dialogue_version: 1 as const,
      entry_element_id: "line-result",
      participants: ["node-character"],
      elements: [
        { id: "line-result", kind: "line" as const, next_element_id: null, speaker_node_id: "node-character", text: "Go." }
      ]
    };
    const fetcher = vi.fn(async (input: string, init?: RequestInit) => {
      const body = JSON.parse(String(init?.body));
      expect(body).toMatchObject({
        dialogue_element_id: "line-result",
        label: "Mara acts",
        relationship_type: "leads_to"
      });
      if (init?.method === "POST") {
        expect(body).toMatchObject({ dialogue_document: document, dialogue_node_id: "node-dialogue", new_target: { title: "Mara Acts", type: "Event" } });
      } else {
        expect(input).toBe("http://runtime.test/api/dialogue-transitions/edge-transition");
        expect(body.target_node_id).toBe("node-event");
      }
      return jsonResponse({
        edge: {
          id: "edge-transition",
          project_id: "project-runtime",
          source_node_id: "node-dialogue",
          target_node_id: "node-event",
          type: "leads_to",
          label: "Mara acts",
          condition: "",
          metadata: { dialogue_element_id: "line-result" },
          created_at: "2026-07-15T10:00:00Z",
          updated_at: "2026-07-15T10:00:00Z"
        },
        target_node: {
          id: "node-event",
          project_id: "project-runtime",
          type: "Event",
          title: "Mara Acts",
          summary: "Action outcome",
          body: "Action outcome",
          status: "canon",
          metadata: {},
          created_at: "2026-07-15T10:00:00Z",
          updated_at: "2026-07-15T10:00:00Z"
        }
      });
    });
    const client = createRuntimeApiClient({ baseUrl: "http://runtime.test/api", fetcher });
    const edge = {
      id: "edge-transition",
      source: "node-dialogue",
      target: "node-event",
      label: "Mara acts",
      data: { dialogueElementId: "line-result", label: "Mara acts", relationshipType: "leads_to" as const }
    };

    await expect(client.createDialogueTransition(
      "project-runtime",
      {
        dialogueNodeId: "node-dialogue",
        document,
        label: "Mara acts",
        newTarget: { kind: "Event", summary: "Action outcome", tags: [], title: "Mara Acts" },
        originId: "line-result",
        relationshipType: "leads_to"
      },
      edge,
      { id: "node-local", position: { x: 20, y: 40 }, data: { kind: "Event", label: "Mara Acts", summary: "Action outcome", tags: [], title: "Mara Acts" } }
    )).resolves.toMatchObject({ edge: { data: { dialogueElementId: "line-result" } }, targetNode: { id: "node-event" } });
    await expect(client.updateDialogueTransition(edge)).resolves.toMatchObject({ edge: { id: "edge-transition" } });
  });

  it("approves and rejects persisted suggestions through runtime endpoints", async () => {
    const fetcher = vi.fn(async (input: string, init?: RequestInit) => {
      expect(init?.method).toBe("POST");
      const status = input.endsWith("/approve") ? "approved" : "rejected";
      return jsonResponse({
        id: "suggestion-runtime",
        project_id: "project-runtime",
        title: "Suggestion",
        description: "",
        status,
        patch: {},
        created_by: "local-user",
        metadata: {},
        created_at: "2026-07-11T00:00:00Z",
        updated_at: "2026-07-11T00:00:00Z"
      });
    });
    const client = createRuntimeApiClient({ baseUrl: "http://runtime.test/api", fetcher });

    await expect(client.approveSuggestion("suggestion-runtime")).resolves.toMatchObject({ status: "approved" });
    await expect(client.rejectSuggestion("suggestion-runtime")).resolves.toMatchObject({ status: "rejected" });
    expect(fetcher).toHaveBeenCalledWith(
      "http://runtime.test/api/suggestions/suggestion-runtime/approve",
      expect.objectContaining({ method: "POST" })
    );
  });

  it("reviews and decides progression migrations through dedicated endpoints", async () => {
    const candidate = {
      candidate_version: 1 as const,
      fingerprint: "fingerprint",
      project_id: "project-runtime",
      edge_id: "edge",
      source_node_id: "source",
      target_node_id: "target",
      origin_kind: "relationship" as const,
      label: "Next",
      condition: "",
      evidence: ["Relationship type is leads_to."],
      origin_metadata: {}
    };
    const decision = {
      decision_version: 1 as const,
      id: "decision",
      project_id: "project-runtime",
      fingerprint: "fingerprint",
      edge_id: "edge",
      status: "rejected" as const,
      flow_id: null,
      transition_id: null,
      original_relationship: "unchanged" as const,
      candidate
    };
    const review = { review_version: 1 as const, pending: [candidate], decisions: [] };
    const fetcher = vi.fn(async (input: string, init?: RequestInit) => {
      if (!init?.method) return jsonResponse(review);
      if (input.endsWith("/reject")) return jsonResponse(decision);
      return jsonResponse({ decision: { ...decision, status: "accepted" }, snapshot: { snapshot_version: 1 } });
    });
    const client = createRuntimeApiClient({ baseUrl: "http://runtime.test/api", fetcher });

    await expect(client.reviewProgressionMigrations("project-runtime")).resolves.toEqual(review);
    await expect(client.rejectProgressionMigration("project-runtime", "fingerprint")).resolves.toEqual(decision);
    await client.acceptProgressionMigration("project-runtime", "fingerprint", "flow-main", {
      preserveRelationship: false,
      kind: "next",
      label: "Next",
      condition: ""
    });
    expect(fetcher).toHaveBeenLastCalledWith(
      "http://runtime.test/api/progression-migrations/fingerprint/accept",
      expect.objectContaining({
        body: JSON.stringify({
          project_id: "project-runtime",
          flow_id: "flow-main",
          preserve_relationship: false,
          kind: "next",
          label: "Next",
          condition: "",
          is_default: false
        })
      })
    );
  });

  it("approves and rejects individual suggestion operations", async () => {
    const fetcher = vi.fn(async (input: string) =>
      jsonResponse({
        id: "suggestion-runtime",
        project_id: "project-runtime",
        title: "Suggestion",
        description: "",
        status: "pending",
        patch: {},
        created_by: "local-user",
        metadata: { operation_decisions: { "2": input.endsWith("/approve") ? "approved" : "rejected" } },
        created_at: "2026-07-11T00:00:00Z",
        updated_at: "2026-07-11T00:00:00Z"
      })
    );
    const client = createRuntimeApiClient({ baseUrl: "http://runtime.test/api", fetcher });

    await expect(client.approveSuggestionOperation("suggestion-runtime", 2)).resolves.toMatchObject({
      metadata: { operation_decisions: { "2": "approved" } }
    });
    await expect(client.rejectSuggestionOperation("suggestion-runtime", 2)).resolves.toMatchObject({
      metadata: { operation_decisions: { "2": "rejected" } }
    });
    expect(fetcher).toHaveBeenCalledWith(
      "http://runtime.test/api/suggestions/suggestion-runtime/operations/2/approve",
      expect.objectContaining({ method: "POST" })
    );
  });

  it("loads the complete read-only Story Flow integrity report", async () => {
    const report = {
      project_id: "project-runtime",
      flow_id: "flow-main",
      facts: [{
        code: "unreachable_member",
        level: "warning",
        message: "Member is unreachable.",
        action: "Connect it to the route.",
        flow_id: "flow-main",
        node_id: "node-draft",
        transition_id: null,
        scene_node_id: null,
        container_node_id: null,
        placement_id: null,
        relationship_id: null
      }]
    };
    const fetcher = vi.fn(async () => jsonResponse(report));
    const client = createRuntimeApiClient({ baseUrl: "http://runtime.test/api", fetcher });

    await expect(client.getStoryFlowIntegrity("flow-main")).resolves.toEqual(report);
    expect(fetcher).toHaveBeenCalledWith(
      "http://runtime.test/api/story-flows/flow-main/integrity",
      undefined
    );
  });

  it("authors revisioned calls, named exits, returns, and reviewed deletion", async () => {
    const timestamp = "2026-08-03T10:00:00Z";
    const fetcher = vi.fn(async (input: string, init?: RequestInit) => {
      const url = String(input);
      if (init?.method === "DELETE") return new Response(null, { status: 204 });
      const body = JSON.parse(String(init?.body));
      if (url.endsWith("/flow-composition/invocations")) return jsonResponse({
        invocation_version: 1,
        id: "call-side",
        ...body,
        is_default: body.is_default,
        created_at: timestamp,
        updated_at: timestamp
      }, 201);
      if (url.endsWith("/flow-composition/invocations/call-side")) return jsonResponse({
        invocation_version: 1,
        id: "call-side",
        ...body,
        created_at: timestamp,
        updated_at: timestamp
      });
      if (url.endsWith("/flow-composition/exits")) return jsonResponse({
        exit_version: 1,
        id: "exit-success",
        ...body,
        created_at: timestamp,
        updated_at: timestamp
      }, 201);
      return jsonResponse({
        binding_version: 1,
        id: "binding-success",
        ...body,
        created_at: timestamp,
        updated_at: timestamp
      }, 201);
    });
    const onMutation = vi.fn();
    const client = createRuntimeApiClient({
      baseUrl: "http://runtime.test/api",
      fetcher,
      projectRevision: 7,
      projectSessionId: "session-runtime",
      onMutation
    });

    const invocation = await client.createFlowInvocation("project", "main", "source", "side", {
      label: "Call side",
      condition: "flag.ready",
      priority: 1,
      isDefault: false
    });
    await client.updateFlowInvocation("project", invocation.id, "main", "source", "side", {
      label: "Updated call",
      condition: "flag.updated",
      priority: 2,
      isDefault: false
    });
    const flowExit = await client.createFlowExit("project", "side", "ending", "success", "Succeeded");
    await client.createFlowExitBinding("project", invocation.id, flowExit.id, "continue");
    await client.deleteFlowInvocation("project", invocation.id);

    const invocationRequest = fetcher.mock.calls.find(([url]) => String(url).endsWith("/flow-composition/invocations"))!;
    expect(JSON.parse(String(invocationRequest[1]?.body))).toMatchObject({ expected_revision: 7, source_flow_id: "main", target_flow_id: "side" });
    expect(new Headers(invocationRequest[1]?.headers).get("X-Project-Session-Id")).toBe("session-runtime");
    const updateRequest = fetcher.mock.calls.find(([url]) => String(url).endsWith("/flow-composition/invocations/call-side"))!;
    expect(updateRequest[1]?.method).toBe("PUT");
    expect(JSON.parse(String(updateRequest[1]?.body))).toMatchObject({ label: "Updated call", priority: 2 });
    const deletion = fetcher.mock.calls.at(-1)!;
    expect(JSON.parse(String(deletion[1]?.body))).toMatchObject({ expected_revision: 7, impact_reviewed: true });
    expect(onMutation).toHaveBeenCalledTimes(5);
  });

  it("creates a specialized outcome side flow through one atomic runtime command", async () => {
    const timestamp = "2026-08-04T10:00:00Z";
    const invocation = {
      invocation_version: 1 as const,
      id: "call-replacement",
      project_id: "project-runtime",
      source_flow_id: "flow-main",
      source_node_id: "node-dialogue",
      target_flow_id: "flow-replacement",
      label: "Take replacement",
      condition: "",
      priority: 1,
      is_default: true,
      created_at: timestamp,
      updated_at: timestamp
    };
    const snapshot = (id: string, name: string) => ({
      snapshot_version: 1,
      flow: { ...runtimeStoryFlow(), id, name },
      nodes: [],
      transitions: [],
      scene_boundaries: [],
      scene_children: {},
      invocations: id === "flow-main" ? [invocation] : [],
      exits: [],
      bindings: []
    });
    const fetcher = vi.fn(async (_input: string, init?: RequestInit) => jsonResponse({
      edge: {
        id: "edge-outcome",
        project_id: "project-runtime",
        source_node_id: "node-dialogue",
        target_node_id: "node-event",
        type: "leads_to",
        label: "Take replacement",
        condition: "",
        metadata: {
          dialogue_element_id: "answer-route",
          outcome_flow_composition: {
            invocation_id: invocation.id,
            source_flow_id: invocation.source_flow_id,
            target_flow_id: invocation.target_flow_id
          }
        },
        created_at: timestamp,
        updated_at: timestamp
      },
      invocation,
      source_flow: snapshot("flow-main", "Main Story"),
      target_flow: snapshot("flow-replacement", "Replacement outcome")
    }, 201));
    const onMutation = vi.fn();
    const client = createRuntimeApiClient({
      baseUrl: "http://runtime.test/api",
      fetcher,
      onMutation,
      projectRevision: 7,
      projectSessionId: "session-runtime"
    });

    const result = await client.createOutcomeSideFlow(
      "project-runtime",
      "edge-outcome",
      "flow-main",
      {
        condition: "",
        description: "Atomic replacement",
        isDefault: true,
        label: "Take replacement",
        name: "Replacement outcome",
        priority: 1
      }
    );

    expect(result.edge.data?.outcomeFlowComposition).toEqual({
      invocationId: "call-replacement",
      sourceFlowId: "flow-main",
      targetFlowId: "flow-replacement"
    });
    expect(result.targetFlow.flow.name).toBe("Replacement outcome");
    expect(fetcher).toHaveBeenCalledTimes(1);
    expect(fetcher).toHaveBeenCalledWith(
      "http://runtime.test/api/flow-composition/outcomes/new-side-flow",
      expect.objectContaining({ method: "POST" })
    );
    expect(JSON.parse(String(fetcher.mock.calls[0]?.[1]?.body))).toMatchObject({
      edge_id: "edge-outcome",
      expected_revision: 7,
      name: "Replacement outcome",
      source_flow_id: "flow-main"
    });
    expect(onMutation).toHaveBeenCalledTimes(1);
  });

  it("preserves structured runtime analysis errors", async () => {
    const fetcher = vi.fn(async () =>
      new Response(JSON.stringify({ detail: {
        code: "provider_unavailable",
        message: "The configured analysis provider is unavailable.",
        message_key: "analysis.provider_unavailable",
        parameters: { provider: "fixture" }
      } }), {
        headers: { "Content-Type": "application/json" },
        status: 503,
        statusText: "Service Unavailable"
      })
    );
    const client = createRuntimeApiClient({ baseUrl: "http://runtime.test/api", fetcher });

    await expect(client.analyzeScene("project-runtime", "Opening", "Character: Mara Vale")).rejects.toEqual(
      expect.objectContaining<Partial<RuntimeApiError>>({
        code: "provider_unavailable",
        message: "The configured analysis provider is unavailable.",
        messageKey: "analysis.provider_unavailable",
        parameters: { provider: "fixture" },
        status: 503
      })
    );
  });

  it("sends revision-safe typed effect and reviewed initial-holder commands", async () => {
    const fetcher = vi.fn(async (input: string, init?: RequestInit) => {
      if (input.endsWith("/narrative-state/projects/project-runtime")) return jsonResponse({ project_id: "project-runtime", initial_states: [], effects: [], bindings: [], integrity: { project_id: "project-runtime", facts: [] } });
      if (input.endsWith("/narrative-state/effects")) return jsonResponse(JSON.parse(String(init?.body)).effect, 201);
      if (input.endsWith("/narrative-state/effects/effect-flag/impact")) return jsonResponse({ subject_kind: "effect", subject_id: "effect-flag", initial_state_ids: [], effect_ids: ["effect-flag"], binding_ids: ["binding-1"] });
      if (input.endsWith("/narrative-state/effects/effect-flag") && init?.method === "PUT") return jsonResponse(JSON.parse(String(init.body)).effect);
      if (input.endsWith("/narrative-state/effects/effect-flag") && init?.method === "DELETE") return new Response(null, { status: 204 });
      if (input.endsWith("/narrative-state/bindings")) return jsonResponse({ id: "binding-1", binding_version: 1, ...JSON.parse(String(init?.body)), created_at: "2026-08-07T10:00:00Z", updated_at: "2026-08-07T10:00:00Z" }, 201);
      if (input.endsWith("/narrative-state/bindings/reorder")) return jsonResponse([]);
      if (input.endsWith("/narrative-state/bindings/binding-1") && init?.method === "DELETE") return new Response(null, { status: 204 });
      if (input.endsWith("/narrative-state/relationship-imports/preview")) return jsonResponse({ project_id: "project-runtime", edge_id: "edge-owns", flow_id: "flow-main", custody: { custody_version: 1, item_node_id: "item-ledger", holder: { holder_version: 1, kind: "character", node_id: "character-mara" } }, already_applied: false, conflict_holder: null });
      if (input.endsWith("/narrative-state/relationship-imports")) return jsonResponse({ changed: true, initial_state: { id: "state-main" } });
      return new Response(null, { status: 404 });
    });
    const client = createRuntimeApiClient({ baseUrl: "http://runtime.test/api", fetcher, projectRevision: 7, projectSessionId: "session-active" });
    const effect = { effect_version: 1 as const, id: "effect-flag", project_id: "project-runtime", operation: "set_flag" as const, payload: { flag: "ledger_presented" }, repeat_policy: "once" as const, explanation: "The ledger was presented." };
    const owner = { owner_version: 1 as const, owner_kind: "flow_transition" as const, owner_id: "transition-1" };

    await client.getNarrativeStateSnapshot("project-runtime");
    await client.createNarrativeEffect("project-runtime", effect);
    await client.updateNarrativeEffect("project-runtime", { ...effect, explanation: "Updated." });
    await client.getNarrativeEffectImpact(effect.id);
    await client.createNarrativeEffectBinding("project-runtime", effect.id, owner, 0);
    await client.reorderNarrativeEffectBindings("project-runtime", owner, [{ binding_id: "binding-1", application_order: 0 }]);
    await client.deleteNarrativeEffectBinding("project-runtime", "binding-1");
    await client.deleteNarrativeEffect("project-runtime", effect.id, true);
    await client.previewRelationshipInitialState("project-runtime", "edge-owns", "flow-main");
    await client.applyRelationshipInitialState("project-runtime", "edge-owns", "flow-main");

    const bodies = fetcher.mock.calls.map(([, init]) => init?.body ? JSON.parse(String(init.body)) : null);
    expect(bodies).toEqual(expect.arrayContaining([
      expect.objectContaining({ expected_revision: 7, effect }),
      expect.objectContaining({ expected_revision: 7, effect_id: "effect-flag", owner }),
      { project_id: "project-runtime", edge_id: "edge-owns", flow_id: "flow-main" },
      expect.objectContaining({ expected_revision: 7, edge_id: "edge-owns", impact_reviewed: true })
    ]));
    expect(fetcher.mock.calls.every(([, init]) => new Headers(init?.headers).get("X-Project-Session-Id") === "session-active")).toBe(true);
    expect(fetcher.mock.calls.map(([input, init]) => `${init?.method ?? "GET"} ${input}`)).toEqual(expect.arrayContaining([
      "GET http://runtime.test/api/narrative-state/projects/project-runtime",
      "PUT http://runtime.test/api/narrative-state/effects/effect-flag",
      "GET http://runtime.test/api/narrative-state/effects/effect-flag/impact",
      "PUT http://runtime.test/api/narrative-state/bindings/reorder",
      "DELETE http://runtime.test/api/narrative-state/bindings/binding-1",
      "DELETE http://runtime.test/api/narrative-state/effects/effect-flag"
    ]));
  });
});

function emptyProjectSession(): RuntimeProjectSessionResponse {
  const timestamp = "2026-07-28T10:00:00Z";
  return {
    session: {
      session_version: 1,
      session_id: "session-clean",
      project_id: "project-clean",
      project_path: "/stories/Clean.narrative",
      storage_mode: "local_sqlite",
      loaded_revision: 0,
      saved_revision: 0,
      save_status: "clean",
      lifecycle: "open",
      opened_at: timestamp,
      last_saved_at: timestamp,
      save_error: null
    },
    document: {
      document_version: 5,
      checksum: "checksum",
      manifest: {
        format_version: 2,
        project_id: "project-clean",
        name: "Clean",
        description: "",
        created_at: timestamp,
        updated_at: timestamp,
        saved_revision: 0,
        settings_version: PROJECT_SETTINGS_VERSION,
        settings: createDefaultProjectSettings(),
        asset_paths: []
      },
      project_metadata: {},
      nodes: [],
      edges: [],
      issues: [],
      suggestions: [],
      engine_tags: [],
      placements: [],
      dialogues: [],
      quests: [],
      story_flows: [],
      story_flow_nodes: [],
      flow_transitions: [],
      scene_flow_boundaries: [],
      flow_invocations: [],
      flow_exits: [],
      flow_exit_bindings: [],
      flow_initial_states: [],
      narrative_effects: [],
      narrative_effect_bindings: [],
      style_profiles: [],
      scene_style_assignments: [],
      agent_memories: []
    }
  };
}

function runtimeStoryFlow(): StoryFlow {
  return {
    flow_version: 1,
    id: "flow-main",
    project_id: "project-runtime",
    name: "Main Story",
    description: "",
    kind: "main",
    status: "draft",
    entry_node_id: null,
    metadata: {},
    created_at: "2026-07-23T10:00:00Z",
    updated_at: "2026-07-23T10:00:00Z"
  };
}

function jsonResponse(payload: unknown, status = 200) {
  return new Response(JSON.stringify(payload), {
    headers: { "Content-Type": "application/json" },
    status
  });
}

function runtimeNode(id: string, type: string): RuntimeNode {
  return {
    id,
    project_id: "project-runtime",
    type,
    title: id,
    summary: "",
    body: "",
    status: "canon",
    metadata: type === "Scene" || type === "Location" ? { composition_frame: true } : {},
    created_at: "2026-07-16T10:00:00Z",
    updated_at: "2026-07-16T10:00:00Z"
  };
}

function placement(
  id: string,
  canonicalNodeId: string,
  containerNodeId: string | null,
  position: { x: number; y: number },
  size: { width: number; height: number }
): VisualPlacement {
  return {
    placement_version: 1,
    id,
    project_id: "project-runtime",
    container_node_id: containerNodeId,
    canonical_node_id: canonicalNodeId,
    position,
    size,
    is_primary: true,
    presentation_state: "expanded",
    metadata: {}
  };
}
