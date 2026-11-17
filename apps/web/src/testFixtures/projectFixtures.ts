import type { PlaybackPrepareCommand, PlaybackSession, PlaybackTypedEffect } from "../playback/contracts";
import type { StoryFlowSnapshot } from "../story-flow/contracts";
import { projectSessionToGraphSnapshot, type RuntimeProjectSessionResponse } from "../runtime/apiClient";
import { useGraphStore } from "../state/graphStore";
import {
  advanceProjectAuroraPlayback,
  backProjectAuroraPlayback,
  restartProjectAuroraPlayback,
  startProjectAuroraPlayback
} from "./projectAuroraPlayback";
import auroraSource from "../../../../fixtures/projects/project-aurora.v1.json";
import citadelSource from "../../../../fixtures/projects/citadel-branch.v1.json";

interface ProjectFixtureSource {
  manifest: RuntimeProjectSessionResponse["document"]["manifest"];
  project_metadata: Record<string, unknown>;
  nodes: RuntimeProjectSessionResponse["document"]["nodes"];
  edges: RuntimeProjectSessionResponse["document"]["edges"];
  issues: RuntimeProjectSessionResponse["document"]["issues"];
  suggestions: RuntimeProjectSessionResponse["document"]["suggestions"];
  engine_tags: RuntimeProjectSessionResponse["document"]["engine_tags"];
  placements: RuntimeProjectSessionResponse["document"]["placements"];
  dialogues: RuntimeProjectSessionResponse["document"]["dialogues"];
  quests: RuntimeProjectSessionResponse["document"]["quests"];
  story_flows: RuntimeProjectSessionResponse["document"]["story_flows"];
  story_flow_nodes: RuntimeProjectSessionResponse["document"]["story_flow_nodes"];
  flow_transitions: RuntimeProjectSessionResponse["document"]["flow_transitions"];
  scene_flow_boundaries: RuntimeProjectSessionResponse["document"]["scene_flow_boundaries"];
  flow_invocations?: RuntimeProjectSessionResponse["document"]["flow_invocations"];
  flow_exits?: RuntimeProjectSessionResponse["document"]["flow_exits"];
  flow_exit_bindings?: RuntimeProjectSessionResponse["document"]["flow_exit_bindings"];
  flow_initial_states?: RuntimeProjectSessionResponse["document"]["flow_initial_states"];
  narrative_effects?: RuntimeProjectSessionResponse["document"]["narrative_effects"];
  narrative_effect_bindings?: RuntimeProjectSessionResponse["document"]["narrative_effect_bindings"];
  style_profiles?: RuntimeProjectSessionResponse["document"]["style_profiles"];
  scene_style_assignments?: RuntimeProjectSessionResponse["document"]["scene_style_assignments"];
  agent_memories?: RuntimeProjectSessionResponse["document"]["agent_memories"];
  playback_effects: PlaybackTypedEffect[];
}

export interface LoadedProjectFixture {
  effectsByFlow: Record<string, PlaybackTypedEffect[]>;
  response: RuntimeProjectSessionResponse;
  storyFlows: StoryFlowSnapshot[];
}

const SOURCES = {
  aurora: auroraSource,
  citadel: citadelSource
} as unknown as Record<"aurora" | "citadel", ProjectFixtureSource>;

/** Loads source JSON explicitly; production startup never imports this module. */
export function projectFixture(name: "aurora" | "citadel"): LoadedProjectFixture {
  const source = structuredClone(SOURCES[name]);
  const response = fixtureResponse(source);
  return {
    response,
    storyFlows: fixtureStoryFlows(source),
    effectsByFlow: source.playback_effects.reduce<Record<string, PlaybackTypedEffect[]>>((grouped, effect) => ({
      ...grouped,
      [effect.flow_id]: [...(grouped[effect.flow_id] ?? []), effect]
    }), {})
  };
}

/** Installs both visual-validation projects into Zustand for component tests. */
export function loadProjectFixturesForTests() {
  const aurora = projectFixture("aurora");
  const citadel = projectFixture("citadel");
  const auroraGraph = projectSessionToGraphSnapshot(aurora.response);
  const citadelGraph = projectSessionToGraphSnapshot(citadel.response);
  useGraphStore.setState({
    activeProjectId: aurora.response.session.project_id,
    activeSessionId: null,
    graphs: {
      [aurora.response.session.project_id]: {
        nodes: auroraGraph.nodes,
        edges: auroraGraph.edges,
        issues: auroraGraph.issues
      },
      [citadel.response.session.project_id]: {
        nodes: citadelGraph.nodes,
        edges: citadelGraph.edges,
        issues: citadelGraph.issues
      }
    },
    projects: [...auroraGraph.projects, ...citadelGraph.projects],
    playbackEffectsByFlow: aurora.effectsByFlow,
    selection: { type: "project", id: aurora.response.session.project_id },
    storyFlowsByProject: {
      [aurora.response.session.project_id]: aurora.storyFlows,
      [citadel.response.session.project_id]: citadel.storyFlows
    }
  });
  return aurora;
}

/** Provides explicit fixture-backed Playback endpoints for component/browser tests. */
export function createProjectFixtureRuntimeFetch() {
  const sessions = new Map<string, PlaybackSession>();
  let prepared: { flowId: string; sourceRevision: string } | null = null;
  let activeProjectPath = projectFixture("aurora").response.session.project_path;
  let createdProject: RuntimeProjectSessionResponse | null = null;
  let canonIssues: Array<Record<string, unknown>> = [];
  let canonSuggestion: Record<string, unknown> | null = null;
  let canonProviderProfiles: Array<{
    profile_id: string;
    label: string;
    provider: "openai" | "google_gemini" | "anthropic";
  }> = [];
  let canonDirty = false;
  let runtimeRevision = projectFixture("aurora").response.session.saved_revision;

  return async (input: string | URL | Request, init?: RequestInit): Promise<Response> => {
    const url = String(input);
    const method = init?.method ?? "GET";
    if (url.includes("/project-sessions/directories") && method === "GET") {
      const directory = new URL(url).searchParams.get("path") ?? "/home/author";
      const parent = directory === "/" ? null : directory.split("/").slice(0, -1).join("/") || "/";
      return jsonResponse({
        directory,
        parent,
        directories: directory === "/home/author"
          ? [
              { name: ".narrative", path: "/home/author/.narrative" },
              { name: "Stories", path: "/home/author/Stories" }
            ]
          : []
      });
    }
    if (url.includes("/project-sessions/catalog") && method === "GET") {
      const directory = new URL(url).searchParams.get("path") ?? "/home/author/.narrative";
      return jsonResponse({
        directory,
        is_default: !new URL(url).searchParams.has("path"),
        projects: (["aurora", "citadel"] as const).map((name) => {
          const source = SOURCES[name];
          return {
            project_id: source.manifest.project_id,
            name: source.manifest.name,
            description: source.manifest.description,
            path: `${directory}/${source.manifest.name.replace(/\s+/g, "")}.narrative`,
            format_version: source.manifest.format_version,
            updated_at: source.manifest.updated_at
          };
        })
      });
    }
    if (/\/project-sessions\/[^/]+\/history$/.test(url) && method === "GET") {
      return jsonResponse(emptyProjectHistory());
    }
    // Keep fixture tests on the same explicit state-owner projection as the runtime.
    if (/\/narrative-state\/projects\/[^/?]+$/.test(url) && method === "GET") {
      const fixture = createdProject
        ?? projectFixture(activeProjectPath.includes("Citadel") ? "citadel" : "aurora").response;
      return jsonResponse({
        project_id: fixture.session.project_id,
        initial_states: fixture.document.flow_initial_states,
        effects: fixture.document.narrative_effects,
        bindings: fixture.document.narrative_effect_bindings.map((binding) => ({
          binding_version: binding.binding_version,
          id: binding.id,
          project_id: binding.project_id,
          effect_id: binding.effect_id,
          owner: {
            owner_version: 1,
            owner_kind: binding.owner_kind,
            owner_id: binding.owner_id,
            ...(binding.context_node_id ? { context_node_id: binding.context_node_id } : {})
          },
          application_order: binding.application_order,
          created_at: binding.created_at,
          updated_at: binding.updated_at
        })),
        integrity: { project_id: fixture.session.project_id, facts: [] }
      });
    }
    if ((url.endsWith("/canon-provider-profiles") || url.includes("/canon-provider-profiles?")) && method === "GET") {
      return jsonResponse({ profiles: canonProviderProfiles });
    }
    if (url.endsWith("/canon-provider-profiles") && method === "POST") {
      const command = JSON.parse(String(init?.body)) as {
        label: string;
        provider: "openai" | "google_gemini" | "anthropic";
      };
      const profile = {
          profile_id: `fixture-provider-${command.provider}`,
          label: command.label,
          provider: command.provider
      };
      canonProviderProfiles = [
        ...canonProviderProfiles.filter((item) => item.profile_id !== profile.profile_id),
        profile
      ];
      return jsonResponse({
        profile,
        models: [
          { id: "canon-model-v1", label: "canon-model-v1", owned_by: command.provider, capabilities: ["text_generation", "structured_output"] },
          { id: "text-only-v1", label: "text-only-v1", owned_by: command.provider, capabilities: ["text_generation"] }
        ]
      }, 201);
    }
    if (/\/canon-provider-profiles\/[^/?]+$/.test(url) && method === "PUT") {
      const profileId = decodeURIComponent(url.split("/canon-provider-profiles/")[1]!);
      const command = JSON.parse(String(init?.body)) as {
        label: string;
        provider: "openai" | "google_gemini" | "anthropic";
      };
      const profile = { profile_id: profileId, label: command.label, provider: command.provider };
      canonProviderProfiles = [
        ...canonProviderProfiles.filter((item) => item.profile_id !== profileId),
        profile
      ];
      return jsonResponse({
        profile,
        models: [{ id: "canon-model-v2", label: "canon-model-v2", owned_by: command.provider, capabilities: ["text_generation", "structured_output"] }]
      });
    }
    if (/\/canon-provider-profiles\/[^/?]+\?session_id=/.test(url) && method === "DELETE") {
      const profileId = decodeURIComponent(url.split("/canon-provider-profiles/")[1]!.split("?")[0]!);
      canonProviderProfiles = canonProviderProfiles.filter((profile) => profile.profile_id !== profileId);
      return jsonResponse({ deleted_profile_id: profileId });
    }
    if (/\/canon-provider-profiles\/[^/]+\/models(?:\?|$)/.test(url) && method === "GET") {
      const profileId = decodeURIComponent(url.split("/canon-provider-profiles/")[1]!.split("/")[0]!);
      const profile = canonProviderProfiles.find((item) => item.profile_id === profileId)
        ?? { profile_id: profileId, label: "Writing account", provider: "openai" as const };
      return jsonResponse({
        profile,
        models: [
          { id: "canon-model-v1", label: "canon-model-v1", owned_by: profile.provider, capabilities: ["text_generation", "structured_output"] },
          { id: "text-only-v1", label: "text-only-v1", owned_by: profile.provider, capabilities: ["text_generation"] }
        ]
      });
    }
    if (/\/canon-checks\/projects\/[^/]+\/issues$/.test(url) && method === "GET") {
      const active = canonIssues.filter((issue) => issue.status === "open" || issue.status === "review");
      return jsonResponse({
        project_id: projectFixture("aurora").response.session.project_id,
        issues: canonIssues,
        active_count: active.length,
        severity: {
          info: active.filter((issue) => issue.severity === "info").length,
          warning: active.filter((issue) => issue.severity === "warning").length,
          critical: active.filter((issue) => issue.severity === "critical").length
        }
      });
    }
    if (url.endsWith("/canon-checks/runs") && method === "POST") {
      const command = JSON.parse(String(init?.body)) as { mode: "deterministic" | "configured_agent"; observed_saved_revision: number };
      if (command.mode === "configured_agent") {
        return jsonResponse(fixtureCanonRun(command.observed_saved_revision, "failed", 0), 201);
      }
      canonIssues = fixtureCanonIssues(command.observed_saved_revision);
      canonDirty = true;
      return jsonResponse(fixtureCanonRun(command.observed_saved_revision, "completed", canonIssues.length), 201);
    }
    if (/\/canon-checks\/runs\/[^/]+\/cancel$/.test(url) && method === "POST") {
      return jsonResponse(fixtureCanonRun(runtimeRevision, "cancelled", 0));
    }
    if (/\/canon-checks\/runs\/[^/]+$/.test(url) && method === "GET") {
      return jsonResponse(fixtureCanonRun(runtimeRevision, "completed", canonIssues.length));
    }
    if (/\/canon-checks\/issues\/[^/]+\/impact-analysis$/.test(url) && method === "POST") {
      const issueId = decodeURIComponent(url.split("/").at(-2) ?? "");
      const issue = canonIssues.find((candidate) => candidate.id === issueId)!;
      const metadata = issue.metadata as {
        targets: Array<Record<string, unknown>>;
        evidence: Array<{ owner: Record<string, unknown> }>;
      };
      const resources = [...metadata.targets, ...metadata.evidence.map((item) => item.owner)];
      const unique = new Map(resources.map((resource) => [JSON.stringify(resource), resource]));
      const command = JSON.parse(String(init?.body)) as {
        expected_history_revision: number;
        source_checksum: string;
      };
      return jsonResponse(fixtureImpactRun({
        request_version: 1,
        observed_saved_revision: runtimeRevision,
        expected_history_revision: command.expected_history_revision,
        source_checksum: command.source_checksum,
        scenario: {
          scenario_version: 1,
          type: "selection",
          intent: "modify",
          seeds: [...unique.values()].map((resource) => ({ seed_version: 1, resource }))
        },
        direction: "both",
        domains: ["graph", "composition", "flow", "dialogue", "quest", "temporal", "playback", "canon"],
        limits: { limits_version: 1, max_depth: 3, max_paths_per_target: 3, max_targets: 500 }
      }), 201);
    }
    if (/\/project-sessions\/[^/]+\/impact-analysis\/runs$/.test(url) && method === "POST") {
      return jsonResponse(fixtureImpactRun(JSON.parse(String(init?.body))), 201);
    }
    if (/\/project-sessions\/[^/]+\/impact-analysis\/runs\/[^/]+\/cancel$/.test(url) && method === "POST") {
      const run = fixtureImpactRun(null);
      return jsonResponse({ ...run, run: { ...run.run, status: "cancelled", findings: [] } });
    }
    if (/\/project-sessions\/[^/]+\/impact-analysis\/runs\/[^/]+$/.test(url) && method === "GET") {
      return jsonResponse(fixtureImpactRun(null));
    }
    if (/\/canon-checks\/issues\/[^/]+\/status$/.test(url) && method === "POST") {
      const issueId = decodeURIComponent(url.split("/").at(-2) ?? "");
      const command = JSON.parse(String(init?.body)) as { status: string };
      canonIssues = canonIssues.map((issue) => issue.id === issueId ? { ...issue, status: command.status } : issue);
      canonDirty = true;
      return jsonResponse(canonIssues.find((issue) => issue.id === issueId));
    }
    if (/\/canon-checks\/issues\/[^/]+\/suggest$/.test(url) && method === "POST") {
      const issueId = decodeURIComponent(url.split("/").at(-2) ?? "");
      if (issueId !== "canon-fixture-condition") {
        return jsonResponse({ issue_id: issueId, status: "unavailable", suggestion_id: null, message_key: "canon.suggestion.unavailable", suggestion: null });
      }
      const fixture = projectFixture("aurora").response;
      const transition = fixture.document.flow_transitions.find((item) => item.id === "flow-transition-quest-blockade")!;
      canonSuggestion = {
        suggestion_version: 1,
        id: "canon-fix-condition",
        issue_id: issueId,
        project_id: fixture.session.project_id,
        status: "pending",
        why: "The condition cannot be reached from the current story state.",
        how: "Use a state flag that an earlier transition actually produces.",
        patch: {
          patch_version: 1,
          patch_id: "canon-patch-condition",
          project_id: fixture.session.project_id,
          source_checksum: fixture.document.checksum,
          target_checksum: "b".repeat(64),
          operations: [{
            op: "put_record",
            collection: "flow_transitions",
            record_id: transition.id,
            record: { ...transition, condition: "flags.take_smuggler_route == true" }
          }]
        }
      };
      return jsonResponse({ issue_id: issueId, status: "created", suggestion_id: "canon-fix-condition", message_key: "canon.suggestion.created", suggestion: canonSuggestion });
    }
    if (/\/canon-checks\/suggestions\/[^/]+\/(approve|reject)$/.test(url) && method === "POST") {
      const approved = url.endsWith("/approve");
      canonSuggestion = canonSuggestion ? { ...canonSuggestion, status: approved ? "approved" : "rejected" } : null;
      canonDirty = true;
      const fixture = projectFixture("aurora").response;
      return jsonResponse({
        suggestion: canonSuggestion,
        project: {
          ...fixture,
          session: { ...fixture.session, project_path: activeProjectPath, save_status: "dirty" }
        },
        history: {
          ...emptyProjectHistory(),
          history_revision: 1,
          undo_depth: 1,
          next_undo: {
            command_id: "canon-fix-command",
            command_kind: approved ? "approve_canon_fix" : "reject_canon_fix",
            label_key: approved ? "history.command.approveCanonFix" : "history.command.rejectCanonFix",
            label_parameters: {}
          }
        }
      });
    }
    if (url.includes("/storage-profiles?session_id=") && method === "GET") {
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
    if (url.endsWith("/storage-profiles") && method === "POST") {
      const command = JSON.parse(String(init?.body));
      const { password: _password, session_id: _sessionId, ...profile } = command;
      return jsonResponse({ profile_id: "profile-project", ...profile }, 201);
    }
    if (url.endsWith("/storage-profiles/test") && method === "POST") {
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
    if (url.endsWith("/storage-migrations") && method === "POST") {
      const command = JSON.parse(String(init?.body)) as {
        session_id: string;
        target_mode: "local_sqlite" | "postgresql";
        target_profile_id: string | null;
      };
      const fixture = createdProject?.session.session_id === command.session_id
        ? createdProject
        : projectFixture("aurora").response;
      const project = withRemoteSession({
        ...fixture,
        session: {
          ...fixture.session,
          session_id: command.session_id,
          project_path: activeProjectPath,
          storage_mode: command.target_mode
        },
        document: {
          ...fixture.document,
          manifest: {
            ...fixture.document.manifest,
            settings: {
              ...fixture.document.manifest.settings,
              storage: {
                mode: command.target_mode,
                connection_profile_id: command.target_profile_id
              }
            }
          }
        }
      });
      return jsonResponse({
        source_mode: command.target_mode === "postgresql" ? "local_sqlite" : "postgresql",
        target_mode: command.target_mode,
        verified_checksum: project.document.checksum,
        record_count: 42,
        project
      });
    }
    if (url.endsWith("/project-sessions/open") && method === "POST") {
      const path = String((JSON.parse(String(init?.body)) as { path: string }).path);
      activeProjectPath = path;
      const fixture = projectFixture(path.includes("Citadel") ? "citadel" : "aurora").response;
      canonIssues = [];
      canonSuggestion = null;
      canonDirty = false;
      runtimeRevision = fixture.session.saved_revision;
      return jsonResponse({
        ...fixture,
        session: { ...fixture.session, project_path: path }
      });
    }
    if (/\/project-sessions\/[^/]+$/.test(url) && method === "GET") {
      const fixture = createdProject ?? projectFixture(activeProjectPath.includes("Citadel") ? "citadel" : "aurora").response;
      return jsonResponse({
        ...fixture,
        session: {
          ...fixture.session,
          project_path: activeProjectPath,
          saved_revision: runtimeRevision,
          save_status: canonDirty ? "dirty" : "clean"
        }
      });
    }
    if (/\/project-sessions\/[^/]+\/save$/.test(url) && method === "POST") {
      runtimeRevision += 1;
      canonDirty = false;
      const fixture = createdProject ?? projectFixture("aurora").response;
      return jsonResponse({
        ...fixture,
        session: { ...fixture.session, project_path: activeProjectPath, saved_revision: runtimeRevision, save_status: "clean" }
      });
    }
    if (url.endsWith("/project-sessions/create") && method === "POST") {
      const command = JSON.parse(String(init?.body)) as {
        description: string;
        name: string;
        path: string;
        settings: ProjectFixtureSource["manifest"]["settings"];
      };
      const empty = projectFixture("citadel").response;
      activeProjectPath = command.path;
      const projectId = `project-${command.name.toLocaleLowerCase().replace(/[^a-z0-9]+/g, "-")}`;
      const response = withRemoteSession({
        ...empty,
        session: {
          ...empty.session,
          session_id: `fixture-session:${projectId}`,
          project_id: projectId,
          project_path: command.path
        },
        document: {
          ...empty.document,
          manifest: {
            ...empty.document.manifest,
            project_id: projectId,
            name: command.name,
            description: command.description,
            settings: command.settings
          }
        }
      });
      createdProject = response;
      return jsonResponse(response, 201);
    }
    if (/\/project-sessions\/[^/]+\/save-as$/.test(url) && method === "POST") {
      const command = JSON.parse(String(init?.body)) as {
        expected_revision: number;
        identity: "preserve" | "regenerate";
        path: string;
        replace_existing: boolean;
      };
      const fixture = createdProject ?? projectFixture("aurora").response;
      return jsonResponse({
        source_session: {
          ...fixture.session,
          project_path: activeProjectPath,
          save_status: "clean",
          saved_revision: command.expected_revision + 1
        },
        destination_path: command.path,
        project_id: command.identity === "preserve"
          ? fixture.session.project_id
          : "fixture-independent-copy",
        saved_revision: command.expected_revision + 1,
        backup_path: command.replace_existing ? `${command.path}.backup-fixture` : null
      });
    }
    if (/\/project-sessions\/[^/]+\/settings$/.test(url) && method === "PUT") {
      const command = JSON.parse(String(init?.body)) as {
        description: string;
        expected_history_revision: number;
        name: string;
        settings: ProjectFixtureSource["manifest"]["settings"];
      };
      const fixture = projectFixture("aurora").response;
      const sessionId = decodeURIComponent(url.split("/").at(-2) ?? fixture.session.session_id);
      return jsonResponse({
        ...fixture,
        session: {
          ...fixture.session,
          session_id: sessionId,
          project_path: activeProjectPath
        },
        document: {
          ...fixture.document,
          manifest: {
            ...fixture.document.manifest,
            description: command.description,
            name: command.name,
            settings: command.settings
          }
        }
      });
    }
    if (url.endsWith("/story-flows/bootstrap") && method === "POST") {
      const command = JSON.parse(String(init?.body)) as {
        project_id: string;
        flow_name: string;
        flow_description: string;
        node: {
          type: "Scene" | "Event";
          title: string;
          summary: string;
          metadata: Record<string, unknown>;
        };
        position: { x: number; y: number };
        size: { height: number; width: number };
      };
      return jsonResponse(fixtureBootstrapResponse(command), 201);
    }
    if (/\/project-sessions\/[^/]+\/close$/.test(url) && method === "POST") {
      const fixture = projectFixture("aurora").response;
      const sessionId = decodeURIComponent(url.split("/").at(-2) ?? fixture.session.session_id);
      return jsonResponse({
        ...fixture,
        session: {
          ...fixture.session,
          session_id: sessionId,
          lifecycle: "closed"
        }
      });
    }
    if (url.endsWith("/playback/prepare") && method === "POST") {
      const command = JSON.parse(String(init?.body)) as PlaybackPrepareCommand;
      prepared = {
        flowId: command.snapshot.flow.id,
        sourceRevision: command.source_revision
      };
      return jsonResponse({
        preparation_version: 1,
        definition: {
          definition_version: 1,
          fixture_flow_id: command.snapshot.flow.id,
          source_revision: command.source_revision
        },
        facts: []
      });
    }
    if (url.endsWith("/playback/sessions") && method === "POST" && prepared) {
      const session = startProjectAuroraPlayback(prepared.flowId, prepared.sourceRevision)!;
      sessions.set(session.id, session);
      return jsonResponse(session, 201);
    }
    const sessionId = decodeURIComponent(url.match(/playback\/sessions\/([^/?]+)/)?.[1] ?? "");
    const current = sessions.get(sessionId);
    if (current && url.includes("/choices") && method === "POST") {
      const command = JSON.parse(String(init?.body)) as {
        transition_id: string | null;
        dialogue_option_id: string | null;
      };
      const next = advanceProjectAuroraPlayback(
        current,
        command.transition_id ?? command.dialogue_option_id ?? ""
      );
      sessions.set(sessionId, next);
      return jsonResponse(next);
    }
    if (current && url.endsWith("/back") && method === "POST") {
      const next = backProjectAuroraPlayback(current);
      sessions.set(sessionId, next);
      return jsonResponse(next);
    }
    if (current && url.endsWith("/restart") && method === "POST") {
      const next = restartProjectAuroraPlayback(current);
      sessions.set(sessionId, next);
      return jsonResponse(next);
    }
    if (current && method === "GET") {
      const observedRevision = new URL(url).searchParams.get("source_revision");
      return jsonResponse(observedRevision === current.source_revision ? current : stalePlaybackSession(current));
    }
    if (current && method === "DELETE") {
      sessions.delete(sessionId);
      return new Response(null, { status: 204 });
    }
    return new Response(JSON.stringify({ detail: { code: "test_route_missing", message: url } }), {
      headers: { "Content-Type": "application/json" },
      status: 404
    });
  };
}

/** Fixture sessions start with the same process-local empty history as runtime sessions. */
function emptyProjectHistory() {
  return {
    history_version: 1,
    history_revision: 0,
    capacity: 10,
    undo_depth: 0,
    redo_depth: 0,
    next_undo: null,
    next_redo: null
  };
}

/** Mirrors the runtime's atomic empty-project bootstrap contract in UI tests. */
function fixtureBootstrapResponse(command: {
  project_id: string;
  flow_name: string;
  flow_description: string;
  node: {
    type: "Scene" | "Event";
    title: string;
    summary: string;
    metadata: Record<string, unknown>;
  };
  position: { x: number; y: number };
  size: { height: number; width: number };
}) {
  const timestamp = "2026-01-01T00:00:00Z";
  const suffix = command.node.type.toLocaleLowerCase();
  const nodeId = `fixture-bootstrap-${suffix}`;
  const flowId = "fixture-main-story";
  const node = {
    id: nodeId,
    project_id: command.project_id,
    type: command.node.type,
    title: command.node.title,
    summary: command.node.summary,
    body: "",
    status: "draft",
    metadata: {
      ...command.node.metadata,
      position: command.position,
      width: command.size.width,
      height: command.size.height,
      root_placement_id: `fixture-placement-${suffix}`,
      ...(command.node.type === "Scene" ? { composition_frame: true } : {})
    },
    created_at: timestamp,
    updated_at: timestamp
  };
  const placement = {
    placement_version: 1,
    id: `fixture-placement-${suffix}`,
    project_id: command.project_id,
    canonical_node_id: nodeId,
    container_node_id: null,
    position: command.position,
    size: command.size,
    is_primary: true,
    presentation_state: "expanded",
    metadata: {},
    created_at: timestamp,
    updated_at: timestamp
  };
  const membership = {
    flow_node_version: 1,
    id: `fixture-membership-${suffix}`,
    project_id: command.project_id,
    flow_id: flowId,
    node_id: nodeId,
    presentation_order: 0,
    metadata: {},
    created_at: timestamp,
    updated_at: timestamp
  };
  const flow = {
    flow_version: 1,
    id: flowId,
    project_id: command.project_id,
    name: command.flow_name,
    description: command.flow_description,
    kind: "main",
    status: "active",
    entry_node_id: nodeId,
    metadata: {},
    created_at: timestamp,
    updated_at: timestamp
  };
  return {
    node,
    placement,
    membership,
    snapshot: {
      snapshot_version: 1,
      flow,
      nodes: [membership],
      transitions: [],
      scene_boundaries: [],
      scene_children: {}
    }
  };
}

/** Keep UI fixtures subject to the same remote session contract as production. */
function withRemoteSession(response: RuntimeProjectSessionResponse): RuntimeProjectSessionResponse {
  if (response.document.manifest.settings.storage.mode !== "postgresql") return response;
  return { ...response, session: { ...response.session, storage_mode: "postgresql",
    session_version: 2, remote_state: "ready", remote_storage: {
      protocol_version: 1, project_id: response.session.project_id,
      storage_generation: "00000000-0000-4000-8000-000000000001",
      authoring_revision: "0", saved_authoring_revision: "0",
      saved_revision: String(response.session.saved_revision), writer_epoch: "1",
      document_checksum: response.document.checksum, state: "ready"
    }
  } };
}

function fixtureResponse(source: ProjectFixtureSource): RuntimeProjectSessionResponse {
  return {
    session: {
      session_version: 1,
      session_id: `fixture-session:${source.manifest.project_id}`,
      project_id: source.manifest.project_id,
      project_path: `/fixtures/${source.manifest.name.replace(/\s+/g, "")}.narrative`,
      storage_mode: source.manifest.settings.storage.mode,
      loaded_revision: source.manifest.saved_revision,
      saved_revision: source.manifest.saved_revision,
      save_status: "clean",
      lifecycle: "open",
      opened_at: source.manifest.updated_at,
      last_saved_at: source.manifest.updated_at,
      save_error: null
    },
    document: {
      document_version: 5,
      checksum: "0".repeat(64),
      manifest: source.manifest,
      project_metadata: source.project_metadata,
      nodes: source.nodes,
      edges: source.edges,
      issues: source.issues,
      suggestions: source.suggestions,
      engine_tags: source.engine_tags,
      placements: source.placements,
      dialogues: source.dialogues,
      quests: source.quests,
      story_flows: source.story_flows,
      story_flow_nodes: source.story_flow_nodes,
      flow_transitions: source.flow_transitions,
      scene_flow_boundaries: source.scene_flow_boundaries,
      flow_invocations: source.flow_invocations ?? [],
      flow_exits: source.flow_exits ?? [],
      flow_exit_bindings: source.flow_exit_bindings ?? [],
      flow_initial_states: source.flow_initial_states ?? [],
      narrative_effects: source.narrative_effects ?? [],
      narrative_effect_bindings: source.narrative_effect_bindings ?? [],
      style_profiles: source.style_profiles ?? [],
      scene_style_assignments: source.scene_style_assignments ?? [],
      agent_memories: source.agent_memories ?? []
    }
  };
}

function fixtureStoryFlows(source: ProjectFixtureSource): StoryFlowSnapshot[] {
  return source.story_flows.map((flow) => {
    const invocations = (source.flow_invocations ?? []).filter((item) => item.source_flow_id === flow.id);
    const invocationIds = new Set(invocations.map((item) => item.id));
    return {
      snapshot_version: 1,
      flow: {
        flow_version: 1,
        id: flow.id,
        project_id: flow.project_id,
        name: flow.name,
        description: flow.description,
        kind: flow.kind === "side" || flow.kind === "standalone" ? flow.kind : "main",
        status: flow.status === "active" || flow.status === "archived" ? flow.status : "draft",
        entry_node_id: flow.entry_node_id,
        metadata: flow.metadata,
        created_at: flow.created_at,
        updated_at: flow.updated_at
      },
      nodes: source.story_flow_nodes.filter((node) => node.flow_id === flow.id)
        .sort((left, right) => left.presentation_order - right.presentation_order)
        .map((node) => ({
          flow_node_version: 1,
          ...node
        })),
      transitions: source.flow_transitions.filter((transition) => transition.flow_id === flow.id)
        .sort((left, right) =>
          left.source_node_id.localeCompare(right.source_node_id)
          || left.priority - right.priority
        )
        .map((transition) => ({
          transition_version: 1,
          ...transition,
          kind: transition.kind as "next" | "branch" | "optional" | "return"
        })),
      scene_boundaries: source.scene_flow_boundaries
        .filter((boundary) => boundary.flow_id === flow.id)
        .map((boundary) => ({
          boundary_version: 1,
          ...boundary
        })),
      scene_children: Object.fromEntries(
        source.scene_flow_boundaries
          .filter((boundary) => boundary.flow_id === flow.id)
          .map((boundary) => [boundary.scene_node_id, [boundary.entry_node_id]])
      ),
      invocations: invocations.map((item) => ({ invocation_version: 1, ...item })),
      exits: (source.flow_exits ?? [])
        .filter((item) => item.flow_id === flow.id)
        .map((item) => ({ exit_version: 1, ...item })),
      bindings: (source.flow_exit_bindings ?? [])
        .filter((item) => invocationIds.has(item.invocation_id))
        .map((item) => ({ binding_version: 1, ...item }))
    };
  });
}

function stalePlaybackSession(session: PlaybackSession): PlaybackSession {
  return {
    ...session,
    status: "blocked",
    facts: [{
      fact_version: 1,
      code: "stale_source_revision",
      level: "error",
      message: "Authored source changed after this Playback session started.",
      action: "Restart Playback with a freshly prepared definition.",
      flow_id: session.flow_id,
      node_id: session.current_node_id,
      transition_id: null,
      effect_id: null
    }]
  };
}

/** Provides visible P4 review examples without embedding them in production state. */
function fixtureCanonIssues(savedRevision: number): Array<Record<string, unknown>> {
  const projectId = projectFixture("aurora").response.session.project_id;
  const observedAt = "2026-08-21T10:00:00Z";
  const definitions = [
    {
      id: "canon-fixture-condition",
      severity: "critical",
      status: "open",
      ruleId: "condition.unresolved-path",
      category: "conditions",
      targets: [
        { owner_type: "node", owner_id: "node-smuggler-route", context_type: null, context_id: null },
        { owner_type: "flow_transition", owner_id: "flow-transition-quest-blockade", context_type: "flow", context_id: "flow-smuggler-route" }
      ],
      excerpt: "flags.take_smuggler_route"
    },
    {
      id: "canon-fixture-custody",
      severity: "warning",
      status: "open",
      ruleId: "ownership.custody-disagreement",
      category: "continuity",
      targets: [
        { owner_type: "edge", owner_id: "edge-guild-ledger", context_type: null, context_id: null },
        { owner_type: "node", owner_id: "node-sealed-ledger", context_type: null, context_id: null },
        { owner_type: "node", owner_id: "node-trade-guild", context_type: null, context_id: null }
      ],
      excerpt: "initial holder: Gatekeeper"
    },
    {
      id: "canon-fixture-dialogue",
      severity: "warning",
      status: "resolved",
      ruleId: "outcome.required-reachability",
      category: "dialogue",
      targets: [{ owner_type: "dialogue_element", owner_id: "line-ilya-concedes", context_type: "node", context_id: "node-dock-dialogue" }],
      excerpt: "Present the ledger"
    },
    {
      id: "canon-fixture-quest",
      severity: "info",
      status: "open",
      ruleId: "outcome.specialized-ownership",
      category: "quest",
      targets: [{ owner_type: "quest_branch", owner_id: "branch-blockade-route", context_type: "quest_stage", context_id: "stage-choose-route" }],
      excerpt: "Take the covert route"
    },
    {
      id: "canon-fixture-temporal",
      severity: "info",
      status: "ignored",
      ruleId: "integrity.error-fact",
      category: "temporal",
      targets: [{ owner_type: "effect", owner_id: "effect-01-ledger-ilya-to-mara", context_type: null, context_id: null }],
      excerpt: "Ledger custody changes after Ilya concedes"
    }
  ];
  return definitions.map((definition) => {
    const target = definition.targets[0]!;
    const active = definition.status === "open" || definition.status === "review";
    const deterministic = active && [
      "condition.unresolved-path",
      "outcome.required-reachability"
    ].includes(definition.ruleId);
    return {
      id: definition.id,
      project_id: projectId,
      title: `canon.issue.${definition.ruleId}.message`,
      description: `canon.issue.${definition.ruleId}.recommendation`,
      severity: definition.severity,
      status: definition.status,
      repair: deterministic ? {
        capability_version: 1,
        kind: "deterministic_patch",
        action: "request_fix",
        available: true,
        unavailable_reason: null,
        source_checksum: "a".repeat(64)
      } : active ? {
        capability_version: 1,
        kind: "agent_review",
        action: "explore_solutions",
        available: true,
        unavailable_reason: null,
        source_checksum: "a".repeat(64)
      } : {
        capability_version: 1,
        kind: "none",
        action: "none",
        available: false,
        unavailable_reason: "canon.repair.unavailable.issue_inactive",
        source_checksum: "a".repeat(64)
      },
      metadata: {
        issue_version: 1,
        origin: "canon_rule",
        rule_id: definition.ruleId,
        rule_version: 1,
        fingerprint: definition.id.padEnd(64, "0"),
        category: definition.category,
        scope: { owner_type: "project", owner_id: projectId, context_type: null, context_id: null },
        message_key: `canon.issue.${definition.ruleId}.message`,
        message_parameters: {},
        recommendation_key: `canon.issue.${definition.ruleId}.recommendation`,
        recommendation_parameters: {},
        targets: definition.targets,
        evidence: [{
          owner: target,
          field_path: "metadata",
          message_key: "canon.evidence.authored-value",
          message_parameters: {},
          excerpt: definition.excerpt
        }],
        agent_explanation: null,
        agent_recommendation: null,
        saved_revision: savedRevision,
        source_checksum: "a".repeat(64),
        first_seen_at: observedAt,
        last_seen_at: observedAt,
        resolved_at: definition.status === "resolved" ? observedAt : null,
        resolution_reason: definition.status === "resolved" ? "candidate_absent" : null
      }
    };
  });
}

function fixtureCanonRun(savedRevision: number, status: "completed" | "failed" | "cancelled", count: number) {
  const observedAt = "2026-08-21T10:00:00Z";
  return {
    run_version: 1,
    id: "canon-fixture-run",
    project_id: projectFixture("aurora").response.session.project_id,
    saved_revision: savedRevision,
    source_checksum: "a".repeat(64),
    rule_pack_version: 1,
    mode: status === "failed" ? "configured_agent" : "deterministic",
    scope: [],
    status,
    started_at: observedAt,
    completed_at: observedAt,
    summary: {
      fact_count: 24,
      candidate_count: count,
      opened_count: count,
      retained_count: 0,
      resolved_count: 0,
      severity: count === 5
        ? { info: 2, warning: 2, critical: 1 }
        : { info: 0, warning: count > 1 ? 1 : 0, critical: count > 0 ? 1 : 0 }
    },
    diagnostics: status === "failed" ? [{
      code: "canon_provider_disabled",
      message_key: "canon.error.canon_provider_disabled",
      parameters: {}
    }] : []
  };
}

/** Supplies one complete Project Aurora dependency path for UI validation. */
function fixtureImpactRun(command: Record<string, unknown> | null) {
  const fixture = projectFixture("aurora").response;
  const source = { owner_type: "node", owner_id: "node-hero", context_type: null, context_id: null };
  const target = { owner_type: "edge", owner_id: "edge-guild-ledger", context_type: null, context_id: null };
  const request = command ?? {
    request_version: 1,
    observed_saved_revision: fixture.session.saved_revision,
    expected_history_revision: 0,
    source_checksum: fixture.document.checksum,
    scenario: { scenario_version: 1, type: "selection", intent: "modify", seeds: [{ seed_version: 1, resource: source }] },
    direction: "both",
    domains: ["graph"],
    limits: { limits_version: 1, max_depth: 3, max_paths_per_target: 3, max_targets: 500 }
  };
  const seeds = (request.scenario as { seeds?: unknown[] }).seeds ?? [{ seed_version: 1, resource: source }];
  return {
    response_version: 1,
    run: {
      run_version: 1,
      id: "impact-fixture-run",
      project_id: fixture.session.project_id,
      saved_revision: fixture.session.saved_revision,
      history_revision: 0,
      source_checksum: fixture.document.checksum,
      status: "completed",
      request,
      findings: [{
        finding_version: 1,
        id: "impact-fixture-finding",
        seeds,
        target,
        domain: "graph",
        direction: "downstream",
        impact_type: "structural",
        propagation: "required",
        distance: 1,
        message_key: "impact.dependency.graphEndpoint",
        message_parameters: { endpoint: "source" },
        paths: [{
          path_version: 1,
          direction: "downstream",
          propagation: "required",
          resources: [source, target],
          dependencies: [{
            dependency_version: 1,
            source,
            target,
            domain: "graph",
            kind: "graph.source-endpoint",
            propagation: "required",
            message_key: "impact.dependency.graphEndpoint",
            message_parameters: { endpoint: "source" },
            evidence: [{
              owner: target,
              field_path: "source_node_id",
              message_key: "impact.evidence.relationship",
              message_parameters: { relationship_type: "owns" },
              excerpt: "The Trade Guild owns the sealed ledger"
            }]
          }]
        }]
      }],
      summary: {
        summary_version: 1,
        finding_count: 1,
        direct_count: 1,
        transitive_count: 0,
        propagation: { required: 1, conditional: 0, contextual: 0 },
        truncated: false,
        omitted_count: 0
      },
      diagnostics: [],
      started_at: "2026-08-26T10:00:00Z",
      completed_at: "2026-08-26T10:00:01Z"
    }
  };
}

function jsonResponse(payload: unknown, status = 200) {
  return new Response(JSON.stringify(payload), {
    headers: { "Content-Type": "application/json" },
    status
  });
}
