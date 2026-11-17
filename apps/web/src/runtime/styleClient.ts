import {
  assertEffectiveStyleResolution,
  assertStyleProfile,
  STYLE_RESOLUTION_VERSION,
  type EffectiveStyleResolutionV1,
  type StyleCatalogV1,
  type StyleContextRefV1,
  type StyleProfileDeletionImpactV1,
  type StyleProfileV1,
  type SceneStyleAssignmentV1
} from "@something-to-tell/contracts/style-system";
import type { RuntimeProjectSessionResponse, RuntimeStylePersistence, RuntimeStyleRewriteApprovalResponse } from "./apiTypes";
import type { RuntimeTransport } from "./transport";
import {
  assertStyleRewriteResponse,
  assertStyleRewriteApprovalResponse,
  type StyleRewriteApprovalV1,
  type StyleRewriteRequestV1,
  type StyleRewriteResponseV1,
  type StyleRewriteRetryV1,
  type StyleRewriteRunV1
} from "@something-to-tell/contracts/style-rewrite";

/** Owns style records while their durable transport remains the project session document. */
export function createStyleRuntimeClient(transport: RuntimeTransport): RuntimeStylePersistence {
  return {
    async loadStyleCatalog(sessionId: string): Promise<StyleCatalogV1> {
      const response = await transport.getJson<RuntimeProjectSessionResponse>(
        `/project-sessions/${encodeURIComponent(sessionId)}`
      );
      return {
        catalog_version: 1,
        project_id: response.session.project_id,
        default_style_profile_id: response.document.manifest.settings.style_system.default_style_profile_id,
        profiles: response.document.style_profiles,
        scene_assignments: response.document.scene_style_assignments
      };
    },
    async createStyleProfile(profile: StyleProfileV1): Promise<StyleProfileV1> {
      const response = await transport.sendJson<unknown>("POST", "/styles/profiles", profile);
      assertStyleProfile(response);
      return response;
    },
    async updateStyleProfile(profile: StyleProfileV1): Promise<StyleProfileV1> {
      const response = await transport.sendJson<unknown>(
        "PUT",
        `/styles/profiles/${encodeURIComponent(profile.id)}`,
        profile
      );
      assertStyleProfile(response);
      return response;
    },
    inspectStyleProfileDeletionImpact(
      profileId: string,
      projectId: string,
      defaultStyleProfileId: string | null
    ): Promise<StyleProfileDeletionImpactV1> {
      const query = new URLSearchParams({ project_id: projectId });
      if (defaultStyleProfileId) query.set("default_style_profile_id", defaultStyleProfileId);
      return transport.getJson(
        `/styles/profiles/${encodeURIComponent(profileId)}/deletion-impact?${query}`
      );
    },
    deleteStyleProfile(profileId, command): Promise<void> {
      return transport.deleteJson(
        `/styles/profiles/${encodeURIComponent(profileId)}`,
        command
      );
    },
    async upsertSceneStyleAssignment(
      assignment: SceneStyleAssignmentV1
    ): Promise<SceneStyleAssignmentV1> {
      return transport.sendJson(
        "PUT",
        `/styles/scene-assignments/${encodeURIComponent(assignment.scene_node_id)}`,
        assignment
      );
    },
    clearSceneStyleAssignment(sceneNodeId: string, projectId: string): Promise<void> {
      const query = new URLSearchParams({ project_id: projectId });
      return transport.deleteResource(
        `/styles/scene-assignments/${encodeURIComponent(sceneNodeId)}?${query}`
      );
    },
    async resolveEffectiveStyle(
      sessionId: string,
      targetNodeId: string,
      context: StyleContextRefV1 | null = null
    ): Promise<EffectiveStyleResolutionV1> {
      const response = await transport.sendJson<unknown>("POST", "/style-resolution/resolve", {
        request_version: STYLE_RESOLUTION_VERSION,
        session_id: sessionId,
        target_node_id: targetNodeId,
        context
      });
      assertEffectiveStyleResolution(response);
      return response;
    },
    async startStyleRewrite(request: StyleRewriteRequestV1): Promise<StyleRewriteRunV1> {
      return sendStyleRun(transport, "POST", "/style-rewrites/runs", request);
    },
    async inspectStyleRewrite(sessionId: string, runId: string): Promise<StyleRewriteRunV1> {
      return sendStyleRun(
        transport,
        "GET",
        `/style-rewrites/runs/${encodeURIComponent(runId)}?session_id=${encodeURIComponent(sessionId)}`
      );
    },
    async cancelStyleRewrite(sessionId: string, runId: string): Promise<StyleRewriteRunV1> {
      return sendStyleRun(
        transport,
        "POST",
        `/style-rewrites/runs/${encodeURIComponent(runId)}/cancel?session_id=${encodeURIComponent(sessionId)}`,
        {}
      );
    },
    async retryStyleRewrite(
      sessionId: string,
      runId: string,
      request: StyleRewriteRetryV1
    ): Promise<StyleRewriteRunV1> {
      return sendStyleRun(
        transport,
        "POST",
        `/style-rewrites/runs/${encodeURIComponent(runId)}/retry?session_id=${encodeURIComponent(sessionId)}`,
        request
      );
    },
    async approveStyleRewrite(
      sessionId: string,
      runId: string,
      command: StyleRewriteApprovalV1
    ): Promise<RuntimeStyleRewriteApprovalResponse> {
      // Approval returns canonical project/history state; P6-009 will present it.
      const response = await transport.sendJson<unknown>(
        "POST",
        `/style-rewrites/runs/${encodeURIComponent(runId)}/approve?session_id=${encodeURIComponent(sessionId)}`,
        command
      );
      assertStyleRewriteApprovalResponse(response);
      return response as RuntimeStyleRewriteApprovalResponse;
    }
  };
}

async function sendStyleRun(
  transport: RuntimeTransport,
  method: "GET" | "POST",
  path: string,
  body?: unknown
): Promise<StyleRewriteRunV1> {
  /** Keep all lifecycle responses behind the same strict browser assertion. */
  const response = method === "GET"
    ? await transport.getJson<unknown>(path)
    : await transport.sendJson<unknown>("POST", path, body);
  assertStyleRewriteResponse(response);
  return (response as StyleRewriteResponseV1).run;
}
