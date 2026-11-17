import {
  PROJECT_SETTINGS_VERSION,
  createDefaultProjectSettings
} from "@something-to-tell/contracts/project-manifest";
import type { VisualPlacement } from "../composition/contracts";
import type { StoryFlow } from "../story-flow/contracts";
import type { RuntimeNode, RuntimeProjectSessionResponse } from "./apiClient";

/** Builds the minimal complete ProjectDocument accepted by every project client test. */
export function emptyProjectSession(): RuntimeProjectSessionResponse {
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

/** Builds one stable Story Flow record for route-level client tests. */
export function runtimeStoryFlow(): StoryFlow {
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

/** Returns a standards-compatible JSON response for injected fetch implementations. */
export function jsonResponse(payload: unknown, status = 200) {
  return new Response(JSON.stringify(payload), {
    headers: { "Content-Type": "application/json" },
    status
  });
}

/** Builds a canonical runtime node with frame metadata when its kind supports containment. */
export function runtimeNode(id: string, type: string): RuntimeNode {
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

/** Builds one visual placement without embedding test expectations in setup code. */
export function placement(
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
