import { MarkerType, type Node } from "@xyflow/react";
import { describe, expect, it, vi } from "vitest";
import {
  createDefaultProjectSettings
} from "@something-to-tell/contracts/project-manifest";
import type { ImpactAnalysisRequest } from "@something-to-tell/contracts/impact-analysis";
import type { ImpactResolutionRequest } from "@something-to-tell/contracts/impact-resolution";
import type { NarrativeNodeData } from "../types";
import { applyRuntimeComposition, createRuntimeApiClient, projectSessionToGraphSnapshot, RuntimeApiError, runtimeEdgeToFlowEdge, runtimeIssueToNarrativeIssue, runtimeNodeToFlowNode, runtimeProjectToNarrativeProject } from "./apiClient";
import {
  emptyProjectSession,
  jsonResponse,
  placement,
  runtimeNode,
  runtimeStoryFlow
} from "./apiClient.testSupport";


describe("runtime project and analysis clients", () => {
  it("resolves the default project catalog and scans a selected directory", async () => {
    const catalog = {
      directory: "/home/author/.narrative",
      is_default: true,
      projects: []
    };
    const fetcher = vi.fn(async (_input: string) => jsonResponse(catalog));
    const client = createRuntimeApiClient({ baseUrl: "http://runtime.test/api", fetcher });

    await expect(client.listProjectCatalog()).resolves.toEqual(catalog);
    await expect(client.listProjectCatalog("/other stories")).resolves.toEqual(catalog);
    expect(fetcher.mock.calls.map(([input]) => input)).toEqual([
      "http://runtime.test/api/project-sessions/catalog",
      "http://runtime.test/api/project-sessions/catalog?path=%2Fother%20stories"
    ]);
  });

  it("loads one directory level for the project folder tree", async () => {
    const listing = {
      directory: "/home/author",
      parent: "/home",
      directories: [{ name: "Stories", path: "/home/author/Stories" }]
    };
    const fetcher = vi.fn(async () => jsonResponse(listing));
    const client = createRuntimeApiClient({ baseUrl: "http://runtime.test/api", fetcher });

    await expect(client.listProjectDirectories("/home/author")).resolves.toEqual(listing);
    expect(fetcher).toHaveBeenCalledWith(
      "http://runtime.test/api/project-sessions/directories?path=%2Fhome%2Fauthor",
      undefined
    );
  });

  it("scopes runtime requests to the active project session", async () => {
    const catalog = { directory: "/stories", is_default: false, projects: [] };
    const fetcher = vi.fn(async (_input: string, init?: RequestInit) => {
      expect(new Headers(init?.headers).get("X-Project-Session-Id")).toBe("session-active");
      return jsonResponse(catalog);
    });
    const client = createRuntimeApiClient({
      baseUrl: "http://runtime.test/api",
      fetcher,
      projectSessionId: "session-active"
    });

    await expect(client.listProjectCatalog("/stories")).resolves.toEqual(catalog);
  });

  it("inspects and applies runtime-owned project history with revision guards", async () => {
    const project = emptyProjectSession();
    const command = {
      command_id: "command-update-node",
      command_kind: "update_node",
      label_key: "history.command.updateNode",
      label_parameters: { title: "Gatekeeper" }
    };
    const before = {
      history_version: 1 as const,
      history_revision: 4,
      capacity: 10 as const,
      undo_depth: 1,
      redo_depth: 0,
      next_undo: command,
      next_redo: null
    };
    const after = { ...before, history_revision: 5, undo_depth: 0, redo_depth: 1, next_undo: null, next_redo: command };
    const fetcher = vi.fn(async (input: string, init?: RequestInit) => {
      if (input.endsWith("/history") && !init?.method) return jsonResponse(before);
      if (input.endsWith("/history/undo")) return jsonResponse({ project, history: after });
      if (input.endsWith("/history/redo")) return jsonResponse({ project, history: before });
      return new Response(null, { status: 404 });
    });
    const client = createRuntimeApiClient({ baseUrl: "http://runtime.test/api", fetcher, projectSessionId: "session-clean" });

    await expect(client.inspectProjectHistory("session-clean")).resolves.toEqual(before);
    await expect(client.undoProjectHistory("session-clean", 4)).resolves.toEqual({ project, history: after });
    await expect(client.redoProjectHistory("session-clean", 5)).resolves.toEqual({ project, history: before });
    expect(fetcher.mock.calls.map(([input, init]) => [input, init?.method, init?.body])).toEqual([
      ["http://runtime.test/api/project-sessions/session-clean/history", undefined, undefined],
      ["http://runtime.test/api/project-sessions/session-clean/history/undo", "POST", JSON.stringify({ expected_history_revision: 4 })],
      ["http://runtime.test/api/project-sessions/session-clean/history/redo", "POST", JSON.stringify({ expected_history_revision: 5 })]
    ]);
  });

  it("starts, polls, and cancels session-owned Impact Analysis without dirty tracking", async () => {
    const request: ImpactAnalysisRequest = {
      request_version: 1 as const,
      observed_saved_revision: 2,
      expected_history_revision: 4,
      source_checksum: "a".repeat(64),
      scenario: {
        scenario_version: 1 as const,
        type: "selection" as const,
        intent: "modify" as const,
        seeds: [{
          seed_version: 1 as const,
          resource: { owner_type: "node", owner_id: "gate", context_type: null, context_id: null }
        }]
      },
      direction: "both" as const,
      domains: ["graph", "flow"],
      limits: { limits_version: 1 as const, max_depth: 3, max_paths_per_target: 3, max_targets: 500 }
    };
    const response = {
      response_version: 1 as const,
      run: {
        run_version: 1 as const,
        id: "impact-run",
        project_id: "project-clean",
        saved_revision: 2,
        history_revision: 4,
        source_checksum: request.source_checksum,
        status: "running" as const,
        request,
        findings: [],
        summary: {
          summary_version: 1 as const,
          finding_count: 0,
          direct_count: 0,
          transitive_count: 0,
          propagation: { required: 0, conditional: 0, contextual: 0 },
          truncated: false,
          omitted_count: 0
        },
        diagnostics: [],
        started_at: "2026-08-26T10:00:00Z",
        completed_at: null
      }
    };
    const onMutation = vi.fn();
    const fetcher = vi.fn(async (_input: string, _init?: RequestInit) => jsonResponse(response));
    const client = createRuntimeApiClient({ baseUrl: "http://runtime.test/api", fetcher, onMutation });

    await expect(client.startImpactRun("session clean", request)).resolves.toEqual(response);
    await expect(client.inspectImpactRun("session clean", "impact/run")).resolves.toEqual(response);
    await expect(client.cancelImpactRun("session clean", "impact/run")).resolves.toEqual(response);

    const resolutionRequest: ImpactResolutionRequest = {
      request_version: 1,
      impact_run_id: "impact/run",
      finding_ids: ["f".repeat(64)],
      source_checksum: request.source_checksum,
      provider_source: "project_default",
      provider_profile_id: null,
      model_id: "structured-model",
      content_consent: true,
      requested_alternative_count: 3,
      limits: {
        limits_version: 1,
        max_findings: 50,
        max_context_resources: 200,
        max_context_characters: 120_000,
        max_patch_operations: 200,
        max_visual_changes: 500
      }
    };
    const context = {
      context_version: 1 as const,
      project_id: "project-clean",
      saved_revision: 2,
      history_revision: 4,
      source_checksum: request.source_checksum,
      request: resolutionRequest,
      findings: [],
      resources: [],
      glossary: [],
      omitted_resource_count: 0,
      omitted_domains: []
    };
    fetcher.mockResolvedValueOnce(jsonResponse(context));
    await expect(
      client.buildImpactResolutionContext("session clean", "impact/run", resolutionRequest)
    ).resolves.toEqual(context);
    const resolutionResponse = {
      response_version: 1 as const,
      run: {
        run_version: 1 as const,
        id: "resolution/run",
        project_id: "project-clean",
        saved_revision: 2,
        history_revision: 4,
        source_checksum: request.source_checksum,
        request: resolutionRequest,
        status: "running" as const,
        explanation: null,
        alternatives: [],
        visual_projections: [],
        diagnostics: [],
        started_at: "2026-08-31T10:00:00Z",
        completed_at: null
      }
    };
    fetcher.mockResolvedValueOnce(jsonResponse(resolutionResponse));
    fetcher.mockResolvedValueOnce(jsonResponse(resolutionResponse));
    fetcher.mockResolvedValueOnce(jsonResponse(resolutionResponse));
    await expect(
      client.startImpactResolutionRun("session clean", resolutionRequest)
    ).resolves.toEqual(resolutionResponse);
    await expect(
      client.inspectImpactResolutionRun("session clean", "resolution/run")
    ).resolves.toEqual(resolutionResponse);
    await expect(
      client.cancelImpactResolutionRun("session clean", "resolution/run")
    ).resolves.toEqual(resolutionResponse);
    const patch = {
      patch_version: 1 as const,
      patch_id: "patch-1",
      project_id: "project-clean",
      source_checksum: request.source_checksum,
      target_checksum: "b".repeat(64),
      operations: [{ op: "remove_record" as const, collection: "edges" as const, record_id: "edge-1" }]
    };
    const edit = { edit_version: 1 as const, alternative_id: "alternative-1", patch };
    const review = {
      command_version: 1 as const,
      alternative_id: "alternative-1",
      proposal_semantic_fingerprint: "c".repeat(64),
      source_checksum: request.source_checksum,
      expected_history_revision: 4
    };
    const decisionResponse = {
      response_version: 1 as const,
      decision: {
        decision_version: 1 as const,
        finding_fingerprints: resolutionRequest.finding_ids,
        proposal_semantic_fingerprint: review.proposal_semantic_fingerprint,
        source_checksum: request.source_checksum,
        decision: "rejected" as const,
        decided_at: "2026-09-01T10:01:00Z"
      },
      run: resolutionResponse.run
    };
    fetcher.mockResolvedValueOnce(jsonResponse(resolutionResponse));
    fetcher.mockResolvedValueOnce(jsonResponse({
      ...decisionResponse,
      decision: { ...decisionResponse.decision, decision: "approved" as const }
    }));
    fetcher.mockResolvedValueOnce(jsonResponse(decisionResponse));
    await expect(client.editImpactResolutionAlternative("session clean", "resolution/run", edit)).resolves.toEqual(resolutionResponse);
    await expect(client.approveImpactResolutionAlternative("session clean", "resolution/run", review)).resolves.toMatchObject({ decision: { decision: "approved" } });
    await expect(client.rejectImpactResolutionAlternative("session clean", "resolution/run", review)).resolves.toEqual(decisionResponse);

    expect(fetcher.mock.calls.map(([input, init]) => [input, init?.method, init?.body])).toEqual([
      ["http://runtime.test/api/project-sessions/session%20clean/impact-analysis/runs", "POST", JSON.stringify(request)],
      ["http://runtime.test/api/project-sessions/session%20clean/impact-analysis/runs/impact%2Frun", undefined, undefined],
      ["http://runtime.test/api/project-sessions/session%20clean/impact-analysis/runs/impact%2Frun/cancel", "POST", "{}"],
      ["http://runtime.test/api/project-sessions/session%20clean/impact-analysis/runs/impact%2Frun/resolution-context", "POST", JSON.stringify(resolutionRequest)],
      ["http://runtime.test/api/project-sessions/session%20clean/impact-analysis/resolution-runs", "POST", JSON.stringify(resolutionRequest)],
      ["http://runtime.test/api/project-sessions/session%20clean/impact-analysis/resolution-runs/resolution%2Frun", undefined, undefined],
      ["http://runtime.test/api/project-sessions/session%20clean/impact-analysis/resolution-runs/resolution%2Frun/cancel", "POST", "{}"],
      ["http://runtime.test/api/project-sessions/session%20clean/impact-analysis/resolution-runs/resolution%2Frun/edit", "POST", JSON.stringify(edit)],
      ["http://runtime.test/api/project-sessions/session%20clean/impact-analysis/resolution-runs/resolution%2Frun/approve", "POST", JSON.stringify(review)],
      ["http://runtime.test/api/project-sessions/session%20clean/impact-analysis/resolution-runs/resolution%2Frun/reject", "POST", JSON.stringify(review)]
    ]);
    expect(onMutation).not.toHaveBeenCalled();
  });

  it("uses stable canon run and review routes without optimistic dirty tracking", async () => {
    const run = {
      run_version: 1 as const,
      id: "run-1",
      project_id: "project-clean",
      saved_revision: 2,
      source_checksum: "a".repeat(64),
      rule_pack_version: 1,
      mode: "deterministic" as const,
      remote_consent: false,
      scope: [],
      status: "completed" as const,
      started_at: "2026-08-21T10:00:00Z",
      completed_at: "2026-08-21T10:00:01Z",
      summary: {
        fact_count: 0,
        candidate_count: 0,
        opened_count: 0,
        retained_count: 0,
        resolved_count: 0,
        severity: { info: 0, warning: 0, critical: 0 }
      },
      diagnostics: []
    };
    const issueList = {
      project_id: "project-clean",
      issues: [],
      active_count: 0,
      severity: { info: 0, warning: 0, critical: 0 }
    };
    const suggestion = {
      issue_id: "issue-1",
      status: "unavailable" as const,
      suggestion_id: null,
      message_key: "canon.suggestion.unavailable",
      suggestion: null
    };
    const providerProfiles = {
      profiles: [{ profile_id: "provider-1", label: "Writing account", provider: "openai" as const }]
    };
    const providerModels = {
      profile: providerProfiles.profiles[0]!,
      models: [{
        id: "writer-model",
        label: "writer-model",
        owned_by: "openai",
        capabilities: ["text_generation", "structured_output"]
      }]
    };
    const decision = {
      suggestion: {
        suggestion_version: 1 as const,
        id: "canon-fix-1",
        issue_id: "issue-1",
        project_id: "project-clean",
        status: "approved" as const,
        why: null,
        how: null,
        patch: {
          patch_version: 1 as const,
          patch_id: "patch-1",
          project_id: "project-clean",
          source_checksum: "a".repeat(64),
          target_checksum: "b".repeat(64),
          operations: []
        }
      },
      project: emptyProjectSession(),
      history: {
        history_version: 1 as const,
        history_revision: 4,
        capacity: 10 as const,
        undo_depth: 0,
        redo_depth: 0,
        next_undo: null,
        next_redo: null
      }
    };
    const onMutation = vi.fn();
    const fetcher = vi.fn(async (input: string, init?: RequestInit) => {
      if (input.endsWith("/canon-provider-profiles?session_id=session-clean") && !init?.method) return jsonResponse(providerProfiles);
      if (input.endsWith("/canon-provider-profiles") && init?.method === "POST") return jsonResponse(providerModels, 201);
      if (input.endsWith("/canon-provider-profiles/provider-1") && init?.method === "PUT") return jsonResponse(providerModels);
      if (input.endsWith("/canon-provider-profiles/provider-1?session_id=session-clean") && init?.method === "DELETE") {
        return jsonResponse({ deleted_profile_id: "provider-1" });
      }
      if (input.endsWith("/canon-provider-profiles/provider-1/models?session_id=session-clean")) return jsonResponse(providerModels);
      if (input.endsWith("/canon-checks/runs") && init?.method === "POST") return jsonResponse(run, 201);
      if (input.endsWith("/canon-checks/runs/run-1") && !init?.method) return jsonResponse(run);
      if (input.endsWith("/canon-checks/runs/run-1/cancel")) return jsonResponse(run);
      if (input.endsWith("/canon-checks/projects/project-clean/issues")) return jsonResponse(issueList);
      if (input.endsWith("/canon-checks/issues/issue-1/status")) return jsonResponse({ id: "issue-1" });
      if (input.endsWith("/canon-checks/issues/issue-1/suggest")) return jsonResponse(suggestion);
      if (input.endsWith("/canon-checks/issues/issue-1/impact-analysis")) {
        return jsonResponse({ run: { id: "impact-from-canon" } }, 201);
      }
      if (input.endsWith("/canon-checks/suggestions/canon-fix-1/approve")) return jsonResponse(decision);
      if (input.endsWith("/canon-checks/suggestions/canon-fix-1/reject")) {
        return jsonResponse({ ...decision, suggestion: { ...decision.suggestion, status: "rejected" } });
      }
      return new Response(null, { status: 404 });
    });
    const client = createRuntimeApiClient({ baseUrl: "http://runtime.test/api", fetcher, onMutation });
    const command = {
      session_id: "session-clean",
      observed_saved_revision: 2,
      expected_history_revision: 4,
      mode: "deterministic" as const,
      remote_consent: false,
      scope: [],
      enabled_rule_overrides: {},
      severity_overrides: {}
    };

    await expect(client.startCanonRun(command)).resolves.toEqual(run);
    await expect(client.listCanonProviderProfiles("session-clean")).resolves.toEqual(providerProfiles);
    await expect(client.createCanonProviderProfile({
      session_id: "session-clean",
      label: "Writing account",
      provider: "openai",
      api_key: "sk-transient-secret"
    })).resolves.toEqual(providerModels);
    await expect(client.updateCanonProviderProfile("provider-1", {
      session_id: "session-clean",
      label: "Writing account",
      provider: "anthropic",
      api_key: "sk-ant-transient-secret"
    })).resolves.toEqual(providerModels);
    await expect(client.deleteCanonProviderProfile("session-clean", "provider-1")).resolves.toEqual({
      deleted_profile_id: "provider-1"
    });
    await expect(client.listCanonProviderModels("session-clean", "provider-1")).resolves.toEqual(providerModels);
    await expect(client.inspectCanonRun("run-1")).resolves.toEqual(run);
    await expect(client.cancelCanonRun("run-1")).resolves.toEqual(run);
    await expect(client.listCanonIssues("project-clean")).resolves.toEqual(issueList);
    await client.changeCanonIssueStatus("issue-1", {
      session_id: "session-clean",
      expected_history_revision: 4,
      status: "review"
    });
    await expect(client.requestCanonIssueSuggestion("issue-1", {
      session_id: "session-clean",
      source_checksum: "b".repeat(64)
    })).resolves.toEqual(suggestion);
    await expect(client.startCanonIssueImpact("issue-1", {
      session_id: "session-clean",
      expected_history_revision: 4,
      source_checksum: "b".repeat(64)
    })).resolves.toEqual({ run: { id: "impact-from-canon" } });
    await expect(client.approveCanonFixSuggestion("canon-fix-1", {
      session_id: "session-clean",
      expected_history_revision: 4
    })).resolves.toEqual(decision);
    await expect(client.rejectCanonFixSuggestion("canon-fix-1", {
      session_id: "session-clean",
      expected_history_revision: 5
    })).resolves.toMatchObject({ suggestion: { status: "rejected" } });

    expect(JSON.parse(String(fetcher.mock.calls[0]?.[1]?.body))).toEqual(command);
    expect(onMutation).not.toHaveBeenCalled();
  });

  it("creates, opens, closes, and projects runtime-owned project sessions", async () => {
    const response = emptyProjectSession();
    const onMutation = vi.fn();
    const fetcher = vi.fn(async (input: string, init?: RequestInit) => {
      if (input.endsWith("/project-sessions/create")) return jsonResponse(response, 201);
      if (input.endsWith("/project-sessions/open")) return jsonResponse(response);
      if (input.endsWith("/project-sessions/session-clean") && !init?.method) {
        return jsonResponse(response);
      }
      if (input.endsWith("/project-sessions/session-clean/close")) {
        return jsonResponse({ ...response, session: { ...response.session, lifecycle: "closed" } });
      }
      if (input.endsWith("/project-sessions/session-clean/exit")) {
        return jsonResponse({ ...response.session, lifecycle: "closed" });
      }
      if (input.endsWith("/project-sessions/session-clean/save")) {
        return jsonResponse({
          ...response,
          session: { ...response.session, saved_revision: 1, save_status: "clean" }
        });
      }
      if (input.endsWith("/project-sessions/session-clean/save-as")) {
        const command = JSON.parse(String(init?.body));
        return jsonResponse({
          source_session: response.session,
          destination_path: command.path,
          project_id: "portable-copy",
          saved_revision: 1,
          backup_path: null
        });
      }
      if (input.endsWith("/project-sessions/session-clean/settings")) {
        const command = JSON.parse(String(init?.body));
        return jsonResponse({
          ...response,
          document: {
            ...response.document,
            manifest: { ...response.document.manifest, ...command }
          }
        });
      }
      if (input.includes("/storage-profiles?session_id=") && !init?.method) {
        return jsonResponse({
          profiles: [{
            profile_id: "studio-primary",
            label: "Studio PostgreSQL",
            host: "db.internal",
            port: 5432,
            database: "narrative",
            username: "writer",
            tls_policy: "verify-full"
          }]
        });
      }
      if (input.endsWith("/storage-profiles") && init?.method === "POST") {
        const { password: _password, session_id: _sessionId, ...profile } = JSON.parse(String(init.body));
        return jsonResponse({ profile_id: "profile-project", ...profile }, 201);
      }
      if (input.endsWith("/storage-profiles/test")) {
        return jsonResponse({
          profile: {
            profile_id: "studio-primary",
            label: "Studio PostgreSQL",
            host: "db.internal",
            port: 5432,
            database: "narrative",
            username: "writer",
            tls_policy: "verify-full"
          },
          connected: true,
          tls_active: true,
          schema_status: "current",
          schema_revision: "20260723_0003",
          permissions_valid: true
        });
      }
      if (input.endsWith("/storage-migrations")) {
        return jsonResponse({
          source_mode: "local_sqlite",
          target_mode: "postgresql",
          verified_checksum: response.document.checksum,
          record_count: 1,
          project: {
            ...response,
            document: { ...response.document, checksum: "a".repeat(64) },
            session: { ...response.session, storage_mode: "postgresql", session_version: 2, remote_state: "ready",
              remote_storage: { protocol_version: 1, project_id: response.session.project_id,
                storage_generation: "00000000-0000-4000-8000-000000000001", writer_epoch: "1",
                authoring_revision: "0", saved_authoring_revision: "0", saved_revision: "0",
                document_checksum: "a".repeat(64), state: "ready" } }
          }
        });
      }
      if (input.endsWith("/project-sessions/session-clean/discard")) return jsonResponse(response);
      if (input.endsWith("/nodes") && init?.method === "POST") return jsonResponse(runtimeNode("saved-node", "Event"), 201);
      return new Response(null, { status: 404 });
    });
    const client = createRuntimeApiClient({
      baseUrl: "http://runtime.test/api",
      fetcher,
      onMutation,
      projectSessionId: "session-clean"
    });

    await expect(client.createProjectSession({
      path: "/stories/Clean.narrative",
      name: "Clean",
      description: "",
      settings: createDefaultProjectSettings()
    })).resolves.toEqual(response);
    await expect(client.openProjectSession({
      path: "/stories/Clean.narrative",
      recover_stale_lock: false
    })).resolves.toEqual(response);
    await expect(client.closeProjectSession("session-clean")).resolves.toMatchObject({
      session: { lifecycle: "closed" }
    });
    await expect(client.exitProjectSession("session-clean", {
      expected_revision: 0
    })).resolves.toMatchObject({ lifecycle: "closed" });
    const exitCall = fetcher.mock.calls.find(([input]) => input.endsWith("/project-sessions/session-clean/exit"));
    expect(exitCall?.[1]).toMatchObject({ keepalive: true, method: "POST" });
    await expect(client.saveProjectSession("session-clean", {
      expected_revision: 0,
      reason: "manual"
    })).resolves.toMatchObject({ session: { saved_revision: 1, save_status: "clean" } });
    await expect(client.saveProjectSessionAs("session-clean", {
      path: "/stories/Clean Copy.narrative",
      expected_revision: 0,
      identity: "regenerate",
      replace_existing: false
    })).resolves.toMatchObject({
      destination_path: "/stories/Clean Copy.narrative",
      project_id: "portable-copy"
    });
    await expect(client.discardProjectSession("session-clean")).resolves.toEqual(response);
    await expect(client.updateProjectSettings("session-clean", {
      expected_history_revision: 3,
      name: "Clean revised",
      description: "Russian authoring",
      settings: {
        ...createDefaultProjectSettings(),
        content_locale: "ru",
        ui_locale: "ru"
      }
    })).resolves.toMatchObject({
      document: { manifest: { name: "Clean revised", settings: { ui_locale: "ru" } } }
    });
    await expect(client.listStorageProfiles("session-clean")).resolves.toMatchObject({
      profiles: [{ profile_id: "studio-primary" }]
    });
    await expect(client.createStorageProfile({
      session_id: "session-clean",
      label: "Project DB",
      host: "db.internal",
      port: 5432,
      database: "story",
      username: "writer",
      password: "write-only",
      tls_policy: "verify-full"
    })).resolves.toMatchObject({
      profile_id: "profile-project",
      label: "Project DB"
    });
    await expect(client.testStorageProfile("session-clean", "studio-primary")).resolves.toMatchObject({
      connected: true,
      schema_status: "current"
    });
    await expect(client.migrateStorage({
      session_id: "session-clean",
      expected_revision: 0,
      target_mode: "postgresql",
      target_profile_id: "studio-primary"
    })).resolves.toMatchObject({
      target_mode: "postgresql",
      project: { session: { storage_mode: "postgresql" } }
    });
    await client.createNode("project-clean", {
      id: "optimistic-node",
      position: { x: 0, y: 0 },
      data: { kind: "Event", label: "Saved node", title: "Saved node", summary: "", body: "", status: "canon", tags: [] }
    });
    expect(onMutation).toHaveBeenCalledTimes(1);
    await expect(client.loadProjectSessionSnapshot("session-clean")).resolves.toMatchObject({
      activeProjectId: "project-clean",
      activeSessionId: "session-clean"
    });
    expect(projectSessionToGraphSnapshot(response)).toMatchObject({
      activeProjectId: "project-clean",
      activeSessionId: "session-clean",
      nodes: [],
      edges: [],
      issues: [],
      projects: [{ id: "project-clean", name: "Clean", path: "/stories/Clean.narrative" }]
    });
  });

  it("rejects secret-shaped settings before frontend persistence", async () => {
    const fetcher = vi.fn();
    const client = createRuntimeApiClient({ baseUrl: "http://runtime.test/api", fetcher });
    const settings = createDefaultProjectSettings();
    settings.canon_check.provider_options = { api_key: "not-portable" };

    await expect(client.updateProjectSettings("session-clean", {
      expected_history_revision: 0,
      name: "Clean",
      description: "",
      settings
    })).rejects.toThrow("Project settings must not contain secret field: api_key");
    await expect(client.createProjectSession({
      path: "/stories/Unsafe.narrative",
      name: "Unsafe",
      description: "",
      settings
    })).rejects.toThrow("Project settings must not contain secret field: api_key");
    expect(fetcher).not.toHaveBeenCalled();
  });

  it("loads and manages dedicated Story Flow resources", async () => {
    const flow = runtimeStoryFlow();
    const snapshot = { snapshot_version: 1 as const, flow, nodes: [], transitions: [], scene_boundaries: [], scene_children: {} };
    const entryNode = runtimeNode("entry-event", "Event");
    const entryPlacement = placement("entry-placement", entryNode.id, null, { x: 160, y: 120 }, { width: 260, height: 156 });
    const bootstrapSnapshot = {
      ...snapshot,
      flow: { ...flow, status: "active" as const, entry_node_id: entryNode.id },
      nodes: [{
        flow_node_version: 1 as const,
        id: "membership-entry",
        project_id: "project-runtime",
        flow_id: flow.id,
        node_id: entryNode.id,
        presentation_order: 0,
        metadata: {},
        created_at: flow.created_at,
        updated_at: flow.updated_at
      }]
    };
    const continuedSnapshot = {
      ...bootstrapSnapshot,
      transitions: [{
        transition_version: 1 as const, id: "transition-next", project_id: "project-runtime", flow_id: flow.id,
        source_node_id: entryNode.id, target_node_id: "target-event", kind: "next" as const, label: "Continue",
        condition: "", priority: 0, is_default: false, metadata: {}, created_at: flow.created_at, updated_at: flow.updated_at
      }]
    };
    const fetcher = vi.fn(async (input: string, init?: RequestInit) => {
      if (input.endsWith("/story-flows?project_id=project-runtime")) return jsonResponse([flow]);
      if (input.endsWith("/story-flows/bootstrap") && init?.method === "POST") {
        return jsonResponse({
          node: entryNode,
          placement: entryPlacement,
          membership: bootstrapSnapshot.nodes[0],
          snapshot: bootstrapSnapshot
        });
      }
      if (input.endsWith("/story-flows/flow-main/continue-existing") && init?.method === "POST") {
        return jsonResponse({ snapshot: continuedSnapshot });
      }
      if (input.endsWith("/story-flows/flow-main/continue-new") && init?.method === "POST") {
        return jsonResponse({ node: runtimeNode("target-event", "Event"), snapshot: continuedSnapshot });
      }
      if (input.endsWith("/story-flows/flow-main/entry") && init?.method === "POST") return jsonResponse(continuedSnapshot);
      if (input.endsWith("/story-flows/flow-main/nodes") && init?.method === "POST") return jsonResponse(continuedSnapshot);
      if (input.endsWith("/story-flows/flow-main/scenes/entry-event/boundary") && init?.method === "PUT") return jsonResponse(continuedSnapshot);
      if (input.endsWith("/story-flows/flow-main/scenes/entry-event/boundary") && init?.method === "DELETE") return new Response(null, { status: 204 });
      if (input.endsWith("/story-flows/flow-main/nodes/entry-event/transition-order") && init?.method === "PUT") return jsonResponse(continuedSnapshot);
      if (input.endsWith("/story-flows/flow-main/transitions/transition-next") && init?.method === "PUT") return jsonResponse(continuedSnapshot.transitions[0]);
      if (input.endsWith("/story-flows/flow-main/transitions/transition-next") && init?.method === "DELETE") return new Response(null, { status: 204 });
      if (input.endsWith("/story-flows") && init?.method === "POST") return jsonResponse(flow);
      if (input.endsWith("/story-flows/flow-main") && init?.method === "PUT") return jsonResponse(snapshot);
      if (input.endsWith("/story-flows/flow-main/archive") && init?.method === "POST") {
        return jsonResponse({ ...flow, status: "archived" });
      }
      if (input.endsWith("/story-flows/flow-main") && !init?.method) {
        return jsonResponse(snapshot);
      }
      if (input.endsWith("/story-flows/flow-main/impact")) {
        return jsonResponse({ flow_id: "flow-main", membership_count: 0, transition_count: 0, scene_boundary_count: 0, canonical_nodes_deleted: false });
      }
      if (input.endsWith("/story-flows/flow-main?confirmed=true")) return new Response(null, { status: 204 });
      return new Response(null, { status: 404 });
    });
    const client = createRuntimeApiClient({ baseUrl: "http://runtime.test/api", fetcher });

    await expect(client.listStoryFlowSnapshots("project-runtime")).resolves.toHaveLength(1);
    await expect(client.createStoryFlow("project-runtime", { name: "Main Story", description: "", kind: "main" })).resolves.toEqual(snapshot);
    await expect(client.updateStoryFlow(snapshot, { name: "Primary Route", description: "Updated", kind: "main" })).resolves.toEqual(snapshot);
    await expect(client.archiveStoryFlow(flow)).resolves.toMatchObject({ status: "archived" });
    await expect(client.bootstrapStoryFlow("project-runtime", {
      kind: "Event",
      title: "Opening event",
      summary: "",
      position: { x: 160, y: 120 },
      size: { width: 260, height: 156 }
    })).resolves.toMatchObject({
      node: { id: "entry-event", position: { x: 160, y: 120 } },
      snapshot: { flow: { entry_node_id: "entry-event" } }
    });
    await expect(client.setStoryFlowSceneBoundary(
      snapshot,
      "entry-event",
      "target-event",
      ["target-event"]
    )).resolves.toEqual(continuedSnapshot);
    await expect(client.deleteStoryFlowSceneBoundary(snapshot, "entry-event")).resolves.toBeUndefined();
    expect(fetcher).toHaveBeenCalledWith(
      "http://runtime.test/api/story-flows/flow-main/scenes/entry-event/boundary",
      expect.objectContaining({
        body: JSON.stringify({
          project_id: "project-runtime",
          entry_node_id: "target-event",
          exit_node_ids: ["target-event"],
          metadata: {}
        }),
        method: "PUT"
      })
    );
    await expect(client.getStoryFlowDeletionImpact("flow-main")).resolves.toMatchObject({ canonical_nodes_deleted: false });
    await expect(client.deleteStoryFlow("flow-main")).resolves.toBeUndefined();
    const transition = { kind: "next" as const, label: "Continue", condition: "", priority: 0, is_default: false };
    await expect(client.continueStoryFlowExisting(bootstrapSnapshot, "entry-event", "target-event", transition)).resolves.toEqual(continuedSnapshot);
    await expect(client.continueStoryFlowNew(bootstrapSnapshot, "entry-event", {
      kind: "Event", title: "Target", summary: "", tags: []
    }, transition)).resolves.toMatchObject({ node: { id: "target-event" }, snapshot: continuedSnapshot });
    await expect(client.setStoryFlowEntry(bootstrapSnapshot, "target-event")).resolves.toEqual(continuedSnapshot);
    await expect(client.addStoryFlowMembership(bootstrapSnapshot, "target-event")).resolves.toEqual(continuedSnapshot);
    await expect(client.reorderStoryFlowTransitions(continuedSnapshot, "entry-event", ["transition-next"])).resolves.toEqual(continuedSnapshot);
    await expect(client.updateStoryFlowTransition(continuedSnapshot, continuedSnapshot.transitions[0]!, {
      sourceNodeId: "entry-event", targetNodeId: "target-event"
    })).resolves.toEqual(continuedSnapshot.transitions[0]);
    await expect(client.deleteStoryFlowTransition(continuedSnapshot, "transition-next")).resolves.toBeUndefined();
  });

  it("projects primary placements into parent-relative React Flow nodes", () => {
    const frame = runtimeNodeToFlowNode(runtimeNode("frame", "Scene"));
    const character = runtimeNodeToFlowNode(runtimeNode("character", "Character"));
    const projected = applyRuntimeComposition([frame, character], {
      composition_version: 1,
      project_id: "project-runtime",
      semantic_relationships: [],
      placements: [
        placement("frame-placement", "frame", null, { x: 100, y: 80 }, { width: 600, height: 420 }),
        placement("character-primary", "character", null, { x: 720, y: 80 }, { width: 260, height: 156 }),
        { ...placement("character-placement", "character", "frame", { x: 24, y: 58 }, { width: 260, height: 156 }), is_primary: false }
      ]
    });

    expect(projected.map((node) => node.id)).toEqual(["frame", "character", "placement:character-placement"]);
    expect(projected[2]).toMatchObject({ parentId: "frame", position: { x: 24, y: 58 }, data: { canonicalNodeId: "character", isLinkedInstance: true, placementId: "character-placement" } });
  });

  it("updates an existing visual placement through the composition API", async () => {
    const fetcher = vi.fn(async (input: string, init?: RequestInit) => {
      expect(input).toBe("http://runtime.test/api/compositions/placements/placement-character");
      expect(JSON.parse(String(init?.body))).toMatchObject({ container_node_id: "frame", position: { x: 32, y: 64 } });
      return jsonResponse({
        composition_version: 1,
        project_id: "project-runtime",
        semantic_relationships: [],
        placements: [placement("placement-character", "character", "frame", { x: 32, y: 64 }, { width: 260, height: 156 })]
      });
    });
    const client = createRuntimeApiClient({ baseUrl: "http://runtime.test/api", fetcher });

    await expect(client.updatePlacement("project-runtime", {
      id: "character",
      type: "narrative",
      parentId: "frame",
      position: { x: 32, y: 64 },
      width: 260,
      height: 156,
      data: { kind: "Character", label: "Mara", title: "Mara", summary: "", tags: [], placementId: "placement-character" }
    })).resolves.toMatchObject({ id: "placement-character", container_node_id: "frame" });
  });

  it("sends group placement geometry through one batch request", async () => {
    const snapshot = {
      composition_version: 1 as const,
      project_id: "project-runtime",
      semantic_relationships: [],
      placements: [
        placement("placement-first", "first", null, { x: 140, y: 100 }, { width: 260, height: 156 }),
        placement("placement-second", "second", null, { x: 440, y: 100 }, { width: 260, height: 156 })
      ]
    };
    const fetcher = vi.fn(async (input: string, init?: RequestInit) => {
      expect(input).toBe("http://runtime.test/api/compositions/placements");
      expect(init?.method).toBe("PUT");
      const command = JSON.parse(String(init?.body));
      expect(command.placements).toHaveLength(2);
      expect(command.placements).toEqual(expect.arrayContaining([
        expect.objectContaining({ placement_id: "placement-first", project_id: "project-runtime" }),
        expect.objectContaining({ placement_id: "placement-second", project_id: "project-runtime" })
      ]));
      return jsonResponse(snapshot);
    });
    const client = createRuntimeApiClient({ baseUrl: "http://runtime.test/api", fetcher });
    const nodes = snapshot.placements.map((item) => ({
      id: item.canonical_node_id,
      type: "narrative" as const,
      position: item.position,
      width: item.size.width,
      height: item.size.height,
      data: { kind: "Event" as const, label: item.id, title: item.id, summary: "", tags: [], placementId: item.id }
    }));

    await expect(client.updatePlacements("project-runtime", nodes)).resolves.toEqual(snapshot);
    expect(fetcher).toHaveBeenCalledTimes(1);
  });

  it("recovers a lost project session and retries one group placement update", async () => {
    const recovered = {
      ...emptyProjectSession(),
      session: { ...emptyProjectSession().session, session_id: "session-recovered" }
    };
    const snapshot = {
      composition_version: 1 as const,
      project_id: "project-runtime",
      semantic_relationships: [],
      placements: [placement("placement-requirement", "requirement", null, { x: 180, y: 120 }, { width: 260, height: 156 })]
    };
    const onSessionRecovered = vi.fn();
    const fetcher = vi.fn(async (input: string, init?: RequestInit) => {
      if (input.endsWith("/project-sessions/open")) {
        expect(JSON.parse(String(init?.body))).toEqual({
          path: "/stories/Aurora.narrative",
          recover_stale_lock: true,
          recovery_mode: "recover",
          expected_lock_session_id: "session-stale"
        });
        return jsonResponse(recovered);
      }
      const sessionId = new Headers(init?.headers).get("X-Project-Session-Id");
      if (sessionId === "session-stale") {
        return jsonResponse({
          detail: {
            code: "project_session_not_found",
            message_key: "project_session.project_session_not_found",
            parameters: { session_id: sessionId }
          }
        }, 404);
      }
      expect(sessionId).toBe("session-recovered");
      return jsonResponse(snapshot);
    });
    const client = createRuntimeApiClient({
      baseUrl: "http://runtime.test/api",
      fetcher,
      projectPath: "/stories/Aurora.narrative",
      projectSessionId: "session-stale",
      onSessionRecovered
    });
    const node = {
      id: "requirement",
      type: "narrative" as const,
      position: { x: 180, y: 120 },
      width: 260,
      height: 156,
      data: { kind: "Condition" as const, label: "Requirement", title: "Requirement", summary: "", tags: [], placementId: "placement-requirement" }
    };

    await expect(client.updatePlacements("project-runtime", [node])).resolves.toEqual(snapshot);
    expect(onSessionRecovered).toHaveBeenCalledWith(recovered);
    expect(fetcher).toHaveBeenCalledTimes(3);
  });

  it("persists and hydrates collapsed Scene placement presentation", async () => {
    const fetcher = vi.fn(async (_input: string, init?: RequestInit) => {
      expect(JSON.parse(String(init?.body))).toMatchObject({
        is_primary: true,
        metadata: { expanded_frame_size: { width: 900, height: 430 } },
        presentation_state: "collapsed",
        size: { width: 280, height: 112 }
      });
      return jsonResponse({
        composition_version: 1,
        project_id: "project-runtime",
        semantic_relationships: [],
        placements: [{
          ...placement("scene-placement", "scene", null, { x: 40, y: 60 }, { width: 280, height: 112 }),
          is_primary: true,
          metadata: { expanded_frame_size: { width: 900, height: 430 } },
          presentation_state: "collapsed"
        }]
      });
    });
    const client = createRuntimeApiClient({ baseUrl: "http://runtime.test/api", fetcher });
    const scene: Node<NarrativeNodeData> = {
      id: "scene",
      type: "narrative",
      position: { x: 40, y: 60 },
      width: 280,
      height: 112,
      data: {
        expandedFrameSize: { width: 900, height: 430 },
        isFrame: true,
        kind: "Scene" as const,
        label: "Opening",
        placementId: "scene-placement",
        presentationState: "collapsed" as const,
        summary: "",
        tags: [],
        title: "Opening"
      }
    };

    await expect(client.updatePlacement("project-runtime", scene)).resolves.toMatchObject({ presentation_state: "collapsed" });
    expect(applyRuntimeComposition([scene], {
      composition_version: 1,
      project_id: "project-runtime",
      semantic_relationships: [],
      placements: [{
        ...placement("scene-placement", "scene", null, { x: 40, y: 60 }, { width: 280, height: 112 }),
        is_primary: true,
        metadata: { expanded_frame_size: { width: 900, height: 430 } },
        presentation_state: "collapsed"
      }]
    })[0]?.data).toMatchObject({ presentationState: "collapsed", expandedFrameSize: { width: 900, height: 430 } });
  });

  it("creates and removes linked placements without deleting canonical content", async () => {
    const fetcher = vi.fn(async (input: string, init?: RequestInit) => {
      if (input.endsWith("/compositions/placements") && init?.method === "POST") {
        expect(JSON.parse(String(init.body))).toMatchObject({ canonical_node_id: "character", container_node_id: "frame", is_primary: false });
        return jsonResponse({
          composition_version: 1,
          project_id: "project-runtime",
          semantic_relationships: [],
          placements: [{ ...placement("linked-placement", "character", "frame", { x: 24, y: 58 }, { width: 260, height: 156 }), is_primary: false }]
        });
      }
      expect(input).toContain("/compositions/placements/linked-placement");
      expect(init?.method).toBe("DELETE");
      return jsonResponse({ composition_version: 1, project_id: "project-runtime", semantic_relationships: [], placements: [] });
    });
    const client = createRuntimeApiClient({ baseUrl: "http://runtime.test/api", fetcher });

    await expect(client.createLinkedPlacement("project-runtime", "character", "frame", { x: 24, y: 58 }, { width: 260, height: 156 })).resolves.toMatchObject({ id: "linked-placement", is_primary: false });
    await expect(client.removePlacement("linked-placement")).resolves.toMatchObject({ placements: [] });
  });

  it("deletes a canonical entity through the composition boundary", async () => {
    const fetcher = vi.fn(async (input: string, init?: RequestInit) => {
      expect(input).toBe("http://runtime.test/api/compositions/entities/node%2Fledger");
      expect(init?.method).toBe("DELETE");
      return new Response(null, { status: 204 });
    });
    const client = createRuntimeApiClient({ baseUrl: "http://runtime.test/api", fetcher });

    await expect(client.deleteEntity("node/ledger")).resolves.toBeUndefined();
  });

  it("creates a composition frame and reconciles its root placement", async () => {
    const fetcher = vi.fn(async (_input: string, init?: RequestInit) => {
      expect(init?.method).toBe("POST");
      expect(JSON.parse(String(init?.body))).toMatchObject({
        kind: "Scene",
        position: { x: 120, y: 90 },
        size: { width: 520, height: 360 }
      });
      return jsonResponse({
        node: {
          id: "frame-runtime",
          project_id: "project-runtime",
          type: "Scene",
          title: "Opening",
          summary: "Composition",
          body: "Composition",
          status: "canon",
          metadata: {
            composition_frame: true,
            root_placement_id: "placement-runtime",
            position: { x: 120, y: 90 },
            width: 520,
            height: 360
          },
          created_at: "2026-07-16T10:00:00Z",
          updated_at: "2026-07-16T10:00:00Z"
        },
        placement: {
          placement_version: 1,
          id: "placement-runtime",
          project_id: "project-runtime",
          container_node_id: null,
          canonical_node_id: "frame-runtime",
          position: { x: 120, y: 90 },
          size: { width: 520, height: 360 },
          is_primary: true,
          presentation_state: "expanded",
          metadata: {}
        }
      });
    });
    const client = createRuntimeApiClient({ baseUrl: "http://runtime.test/api", fetcher });

    await expect(client.createFrame("project-runtime", {
      id: "frame-local",
      type: "narrative",
      position: { x: 120, y: 90 },
      width: 520,
      height: 360,
      data: { isFrame: true, kind: "Scene", label: "Opening", summary: "Composition", tags: [], title: "Opening" }
    })).resolves.toMatchObject({
      id: "frame-runtime",
      data: { isFrame: true, rootPlacementId: "placement-runtime" }
    });
  });

  it("maps runtime project, node, and edge records into frontend graph shapes", () => {
    expect(
      runtimeProjectToNarrativeProject({
        id: "project-runtime",
        name: "Runtime Project",
        path: "~/Stories/Runtime.narrative",
        format_version: 1,
        metadata: { description: "Loaded from runtime", status: "draft" },
        created_at: "2026-06-20T10:00:00Z",
        updated_at: "2026-06-20T11:00:00Z"
      })
    ).toMatchObject({
      description: "Loaded from runtime",
      id: "project-runtime",
      status: "draft",
      updatedAt: "2026-06-20"
    });

    expect(
      runtimeNodeToFlowNode({
        id: "node-runtime",
        project_id: "project-runtime",
        type: "Location",
        title: "Runtime Node",
        summary: "Summary",
        body: "Body",
        status: "canon",
        metadata: { position: { x: 12, y: 24 }, tags: ["runtime"], width: 320 },
        created_at: "2026-06-20T10:00:00Z",
        updated_at: "2026-06-20T11:00:00Z"
      })
    ).toMatchObject({
      data: { kind: "Location", summary: "Summary", tags: ["runtime"], title: "Runtime Node" },
      position: { x: 12, y: 24 },
      width: 320
    });
    expect(
      runtimeNodeToFlowNode({
        id: "node-runtime-fallback",
        project_id: "project-runtime",
        type: "UnknownKind",
        title: "Fallback Node",
        summary: "Summary",
        body: "Body",
        status: "canon",
        metadata: {},
        created_at: "2026-06-20T10:00:00Z",
        updated_at: "2026-06-20T11:00:00Z"
      }).data.kind
    ).toBe("Scene");

    expect(
      runtimeNodeToFlowNode({
        id: "node-dialogue",
        project_id: "project-runtime",
        type: "Dialogue",
        title: "Runtime Dialogue",
        summary: "Summary",
        body: "Body",
        status: "canon",
        metadata: {
          dialogue_document: { dialogue_version: 1, elements: [], entry_element_id: null, participants: ["node-character"] }
        },
        created_at: "2026-06-20T10:00:00Z",
        updated_at: "2026-06-20T11:00:00Z"
      }).data.dialogueDocument
    ).toEqual({ dialogue_version: 1, elements: [], entry_element_id: null, participants: ["node-character"] });

    expect(
      runtimeEdgeToFlowEdge({
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
      })
    ).toMatchObject({
      data: { dialogueElementId: "line-result", label: "reveals", relationshipType: "reveals" },
      markerEnd: { type: MarkerType.ArrowClosed },
      source: "source",
      sourceHandle: "right",
      target: "target",
      targetHandle: "left"
    });
    expect(
      runtimeEdgeToFlowEdge({
        id: "membership-runtime",
        project_id: "project-runtime",
        source_node_id: "character",
        target_node_id: "faction",
        type: "member_of",
        label: "member of",
        condition: "",
        metadata: { canvas_visibility: "hidden", semantic_scope: "membership" },
        created_at: "2026-06-20T10:00:00Z",
        updated_at: "2026-06-20T11:00:00Z"
      })
    ).toMatchObject({ data: { canvasVisibility: "hidden", relationshipType: "member_of" } });
    expect(
      runtimeIssueToNarrativeIssue({
        id: "issue-runtime",
        project_id: "project-runtime",
        title: "Runtime issue",
        node_id: "node-runtime",
        edge_id: null,
        description: "Mapped issue",
        severity: "critical",
        status: "ignored",
        metadata: {
          message_key: "canon.issue.outcome.required-reachability.message",
          message_parameters: { owner: "dialogue" },
          recommendation_key: "canon.issue.outcome.required-reachability.recommendation",
          recommendation_parameters: { temporary: true },
          targets: [
            { owner_type: "dialogue_element", owner_id: "line-result", context_type: "node", context_id: "node-runtime" },
            { owner_type: "dialogue_option", owner_id: "answer-result", context_type: "dialogue_element", context_id: "choice-result" }
          ]
        },
        created_at: "2026-06-20T10:00:00Z",
        updated_at: "2026-06-20T11:00:00Z"
      })
    ).toMatchObject({
      id: "issue-runtime",
      nodeId: "node-runtime",
      title: "canon.issue.outcome.required-reachability.message",
      titleParameters: { owner: "dialogue" },
      description: "canon.issue.outcome.required-reachability.recommendation",
      descriptionParameters: { temporary: true },
      dialogueOwnerIds: ["line-result", "answer-result"],
      severity: "critical",
      status: "ignored"
    });
  });
});
