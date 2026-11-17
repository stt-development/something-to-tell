import { describe, expect, it, vi } from "vitest";
import type { RuntimeProjectSessionResponse } from "./apiTypes";
import { createStyleRuntimeClient } from "./styleClient";
import type { RuntimeTransport } from "./transport";

describe("style runtime client", () => {
  it("authors profiles and Scene assignments through stable encoded routes", async () => {
    const profile = {
      style_profile_version: 1 as const,
      id: "style-noir",
      project_id: "project-aurora",
      name: "Harbor noir",
      description: "",
      guidance: "Use restrained prose.",
      traits: { traits_version: 1 as const, tone: [], rhythm: [], pacing: [], vocabulary: [], dramatic_intensity: null },
      positive_examples: [],
      created_at: "2026-09-05T10:00:00Z",
      updated_at: "2026-09-05T10:00:00Z"
    };
    const assignment = {
      assignment_version: 1 as const,
      id: "assignment-one",
      project_id: profile.project_id,
      scene_node_id: "scene/one",
      style_profile_id: profile.id,
      created_at: profile.created_at,
      updated_at: profile.updated_at
    };
    const sendJson = vi.fn(async (_method, path) => path.includes("scene-assignments") ? assignment : profile);
    const getJson = vi.fn(async () => ({ impact_version: 1, profile_id: profile.id, uses_project_default: true, scene_node_ids: [] }));
    const deleteJson = vi.fn().mockResolvedValue(undefined);
    const deleteResource = vi.fn().mockResolvedValue(undefined);
    const client = createStyleRuntimeClient({ sendJson, getJson, deleteJson, deleteResource } as unknown as RuntimeTransport);

    await expect(client.createStyleProfile(profile)).resolves.toEqual(profile);
    await expect(client.updateStyleProfile(profile)).resolves.toEqual(profile);
    await expect(client.upsertSceneStyleAssignment(assignment)).resolves.toEqual(assignment);
    await client.inspectStyleProfileDeletionImpact(profile.id, profile.project_id, profile.id);
    await client.deleteStyleProfile(profile.id, {
      project_id: profile.project_id,
      default_style_profile_id: profile.id,
      replacement_profile_id: null,
      impact_reviewed: true
    });
    await client.clearSceneStyleAssignment(assignment.scene_node_id, profile.project_id);

    expect(sendJson).toHaveBeenCalledWith("PUT", "/styles/scene-assignments/scene%2Fone", assignment);
    expect(getJson).toHaveBeenCalledWith("/styles/profiles/style-noir/deletion-impact?project_id=project-aurora&default_style_profile_id=style-noir");
    expect(deleteJson).toHaveBeenCalledWith("/styles/profiles/style-noir", expect.objectContaining({ impact_reviewed: true }));
    expect(deleteResource).toHaveBeenCalledWith("/styles/scene-assignments/scene%2Fone?project_id=project-aurora");
  });

  it("projects project-owned profiles and Scene assignments from the session document", async () => {
    const profile = {
      style_profile_version: 1 as const,
      id: "style-noir",
      project_id: "project-aurora",
      name: "Harbor noir",
      description: "",
      guidance: "Use restrained prose.",
      traits: {
        traits_version: 1 as const,
        tone: ["restrained"],
        rhythm: [],
        pacing: [],
        vocabulary: [],
        dramatic_intensity: null
      },
      positive_examples: [],
      created_at: "2026-09-05T10:00:00Z",
      updated_at: "2026-09-05T10:00:00Z"
    };
    const assignment = {
      assignment_version: 1 as const,
      id: "scene-style-docks",
      project_id: "project-aurora",
      scene_node_id: "scene-docks",
      style_profile_id: profile.id,
      created_at: profile.created_at,
      updated_at: profile.updated_at
    };
    const response = {
      session: { project_id: "project-aurora" },
      document: {
        manifest: { settings: { style_system: { default_style_profile_id: profile.id } } },
        style_profiles: [profile],
        scene_style_assignments: [assignment]
      }
    } as unknown as RuntimeProjectSessionResponse;
    const getJson = vi.fn(async () => response);
    const client = createStyleRuntimeClient({ getJson } as unknown as RuntimeTransport);

    await expect(client.loadStyleCatalog("session with spaces")).resolves.toEqual({
      catalog_version: 1,
      project_id: "project-aurora",
      default_style_profile_id: profile.id,
      profiles: [profile],
      scene_assignments: [assignment]
    });
    expect(getJson).toHaveBeenCalledWith("/project-sessions/session%20with%20spaces");
  });

  it("requests and validates one runtime-owned effective Style decision", async () => {
    const response = {
      resolution_version: 1,
      target_node_id: "node-shared",
      status: "context_required",
      source: null,
      scene_context: null,
      candidate_contexts: [
        { scene_node_id: "scene-a", scene_title: "Alpha" },
        { scene_node_id: "scene-b", scene_title: "Beta" }
      ],
      style_profile_id: null,
      profile: null,
      unavailable_reason: null
    };
    const sendJson = vi.fn(async () => response);
    const client = createStyleRuntimeClient({ sendJson } as unknown as RuntimeTransport);

    await expect(client.resolveEffectiveStyle(
      "session-1",
      "node-shared",
      { context_version: 1, scene_node_id: "scene-b", placement_id: "placement-b" }
    )).resolves.toEqual(response);
    expect(sendJson).toHaveBeenCalledWith("POST", "/style-resolution/resolve", {
      request_version: 1,
      session_id: "session-1",
      target_node_id: "node-shared",
      context: { context_version: 1, scene_node_id: "scene-b", placement_id: "placement-b" }
    });
  });

  it("rejects an invalid resolver response at the browser boundary", async () => {
    const client = createStyleRuntimeClient({
      sendJson: vi.fn(async () => ({ resolution_version: 1, status: "resolved" }))
    } as unknown as RuntimeTransport);

    await expect(client.resolveEffectiveStyle("session-1", "node-1")).rejects.toMatchObject({
      code: "style_resolution_invalid"
    });
  });

  it("starts, inspects, cancels, and retries immutable Style runs", async () => {
    const request = {
      request_version: 1 as const,
      session_id: "session one",
      target: { kind: "node_text" as const, node_id: "node-one" },
      style_context: null,
      observed_source_checksum: "a".repeat(64),
      expected_history_revision: 3,
      additional_instructions: "",
      content_consent: true as const
    };
    const response = {
      response_version: 1,
      run: {
        run_version: 1,
        id: "run-1",
        project_id: "project-aurora",
        request,
        style_profile_id: "style-noir",
        style_profile_name: "Harbor noir",
        source_checksum: "a".repeat(64),
        source_text_checksum: "b".repeat(64),
        history_revision: 3,
        predecessor_run_id: null,
        status: "running",
        progress: 25,
        recommendation: null,
        error_code: null,
        started_at: "2026-09-07T10:00:00Z",
        completed_at: null
      }
    };
    const sendJson = vi.fn(async () => response);
    const getJson = vi.fn(async () => response);
    const client = createStyleRuntimeClient({ sendJson, getJson } as unknown as RuntimeTransport);
    await expect(client.startStyleRewrite(request)).resolves.toEqual(response.run);
    await expect(client.inspectStyleRewrite("session one", "run/1")).resolves.toEqual(response.run);
    await expect(client.cancelStyleRewrite("session one", "run/1")).resolves.toEqual(response.run);
    await expect(client.retryStyleRewrite("session one", "run/1", {
      retry_version: 1,
      observed_source_checksum: "a".repeat(64),
      expected_history_revision: 3,
      additional_instructions: "Tighter rhythm",
      content_consent: true
    })).resolves.toEqual(response.run);

    expect(getJson).toHaveBeenCalledWith("/style-rewrites/runs/run%2F1?session_id=session%20one");
    expect(sendJson).toHaveBeenCalledWith(
      "POST",
      "/style-rewrites/runs/run%2F1/cancel?session_id=session%20one",
      {}
    );
  });

  it("rejects malformed Style run output", async () => {
    const client = createStyleRuntimeClient({
      sendJson: vi.fn(async () => ({ response_version: 1, run: { status: "completed" } }))
    } as unknown as RuntimeTransport);

    await expect(client.startStyleRewrite({} as never)).rejects.toThrow(
      "style_rewrite_response_invalid"
    );
  });

  it("validates the canonical approval envelope", async () => {
    const approval = {
      response_version: 1,
      result: { project: {}, history: {} },
      run: {
        run_version: 1,
        id: "run-1",
        project_id: "project-1",
        request: {
          request_version: 1,
          session_id: "session-1",
          target: { kind: "node_text", node_id: "node-1" },
          style_context: null,
          observed_source_checksum: "a".repeat(64),
          expected_history_revision: 2,
          additional_instructions: "",
          content_consent: true
        },
        style_profile_id: "style-1",
        style_profile_name: "Noir",
        source_checksum: "a".repeat(64),
        source_text_checksum: "b".repeat(64),
        history_revision: 2,
        predecessor_run_id: null,
        status: "stale",
        progress: 100,
        recommendation: null,
        error_code: "style_rewrite_run_stale",
        started_at: "2026-09-07T10:00:00Z",
        completed_at: "2026-09-07T10:00:01Z"
      },
      canon_check_recommended: true
    };
    const client = createStyleRuntimeClient({
      sendJson: vi.fn(async () => approval)
    } as unknown as RuntimeTransport);

    await expect(client.approveStyleRewrite("session-1", "run-1", {
      approval_version: 1,
      recommendation_id: "recommendation-1",
      source_checksum: "a".repeat(64),
      expected_history_revision: 2
    })).resolves.toEqual(approval);
  });
});
