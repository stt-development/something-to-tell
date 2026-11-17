import type {
CanonIssueProjection,
CanonRunMode
} from "@something-to-tell/contracts/canon-check";
import {
IMPACT_RESOLUTION_DEFAULT_ALTERNATIVES,
IMPACT_RESOLUTION_MAX_CONTEXT_CHARACTERS,
IMPACT_RESOLUTION_MAX_CONTEXT_RESOURCES,
IMPACT_RESOLUTION_MAX_FINDINGS,
IMPACT_RESOLUTION_MAX_PATCH_OPERATIONS,
IMPACT_RESOLUTION_MAX_VISUAL_CHANGES,
type ImpactSolutionAlternative
} from "@something-to-tell/contracts/impact-resolution";
import type { ProjectHistorySummary } from "@something-to-tell/contracts/project-history";
import {
type ProjectManifestV2
} from "@something-to-tell/contracts/project-manifest";
import type { ProjectPatch } from "@something-to-tell/contracts/project-patch";
import type {
ProjectSessionState
} from "@something-to-tell/contracts/project-session";
import { type ImpactRunOptions } from "../../impact/ImpactWorkspace";
import {
i18next,
localizeRuntimeError,
tr
} from "../../localization/i18n";
import { createRuntimeApiClient,projectSessionToGraphSnapshot } from "../../runtime/apiClient";
import { useGraphStore } from "../../state/graphStore";


import { useWorkspaceState } from "../shell/useWorkspaceState";
import { impactResourceKey } from "../workspaceShared";

type AnalysisProviderState = Pick<ReturnType<typeof useWorkspaceState>, "canonIssues" | "canonMode" | "canonOperation" | "canonRun" | "canonSuggestion" | "impactCaller" | "impactOperation" | "impactOriginRef" | "impactResolutionOperation" | "impactResolutionRun" | "impactRun" | "impactSeeds" | "setCanonError" | "setCanonIssues" | "setCanonMode" | "setCanonNotice" | "setCanonOpen" | "setCanonOperation" | "setCanonRun" | "setCanonSuggestion" | "setImpactCaller" | "setImpactError" | "setImpactOpen" | "setImpactOperation" | "setImpactResolutionError" | "setImpactResolutionOperation" | "setImpactResolutionRun" | "setImpactResolutionVerificationPending" | "setImpactRun" | "setImpactSeeds" | "setLastAnalysisTool" | "setProjectHistory" | "setSceneAnalysisOpen" | "setSelectedCanonIssueId">;

export type AnalysisProviderControllerContext = AnalysisProviderState & {
  setContextMenu: (menu: null) => void;
  activeProjectId: string;
  activeProjectManifest: ProjectManifestV2 | null;
  activeProjectSession: Pick<ProjectSessionState, "session_id"> | null;
  activeSessionId: string | null;
  loadRuntimeSnapshot: ReturnType<typeof useGraphStore.getState>["loadRuntimeSnapshot"];
  projectHistory: ProjectHistorySummary | null;
  rehydrateHistoryProject: (response: Parameters<typeof projectSessionToGraphSnapshot>[0]) => Promise<void>;
  runtimePersistence: ReturnType<typeof createRuntimeApiClient>;
  setProjectSessionState: ReturnType<typeof useGraphStore.getState>["setProjectSessionState"];
};

/** Owns Canon, Impact Analysis, and Impact Resolution provider execution and review. */
export function createAnalysisProviderController(context: AnalysisProviderControllerContext) {
  const {
    activeProjectId, activeProjectManifest, activeProjectSession, activeSessionId,
    canonIssues, canonMode, canonOperation, canonRun, canonSuggestion, impactCaller,
    impactOperation, impactOriginRef, impactResolutionOperation, impactResolutionRun,
    impactRun, impactSeeds, loadRuntimeSnapshot, projectHistory, rehydrateHistoryProject,
    runtimePersistence, setCanonError, setCanonIssues, setCanonMode, setCanonNotice,
    setCanonOpen, setCanonOperation, setCanonRun, setCanonSuggestion, setContextMenu,
    setImpactCaller, setImpactError, setImpactOpen, setImpactOperation,
    setImpactResolutionError, setImpactResolutionOperation, setImpactResolutionRun,
    setImpactResolutionVerificationPending, setImpactRun, setImpactSeeds,
    setLastAnalysisTool, setProjectHistory, setProjectSessionState,
    setSceneAnalysisOpen, setSelectedCanonIssueId
  } = context;


  async function runCanonCheck(remoteConsent = false, requestedMode: CanonRunMode = canonMode) {
    if (!activeSessionId || !activeProjectSession || canonOperation) return;
    setCanonError(null);
    setCanonNotice(null);
    setCanonOperation("running");
    try {
      // Capture both concurrency tokens immediately before analyzing the working document.
      const [authoritative, authoritativeHistory] = await Promise.all([
        runtimePersistence.inspectProjectSession(activeSessionId),
        runtimePersistence.inspectProjectHistory(activeSessionId)
      ]);
      setProjectSessionState(authoritative.session);
      setProjectHistory(authoritativeHistory);
      setCanonSuggestion(null);
      const result = await runtimePersistence.startCanonRun({
        session_id: activeSessionId,
        observed_saved_revision: authoritative.session.saved_revision,
        expected_history_revision: authoritativeHistory.history_revision,
        mode: requestedMode,
        remote_consent: remoteConsent,
        scope: [],
        enabled_rule_overrides: {},
        severity_overrides: {}
      });
      setCanonRun(result);
      if (result.status === "completed") {
        await loadRuntimeSnapshot(() => runtimePersistence.loadProjectSessionSnapshot(activeSessionId));
        const [issuesProjection, history] = await Promise.all([
          runtimePersistence.listCanonIssues(activeProjectId),
          runtimePersistence.inspectProjectHistory(activeSessionId)
        ]);
        setCanonIssues(issuesProjection);
        setProjectHistory(history);
      }
    } catch (error) {
      setCanonError(localizeRuntimeError(error));
    } finally {
      setCanonOperation(null);
    }
  }



  async function cancelCanonCheck() {
    if (!canonRun || canonOperation === "cancelling") return;
    setCanonError(null);
    setCanonOperation("cancelling");
    try {
      setCanonRun(await runtimePersistence.cancelCanonRun(canonRun.id));
    } catch (error) {
      setCanonError(localizeRuntimeError(error));
    } finally {
      setCanonOperation(null);
    }
  }



  async function runImpactAnalysis(options: ImpactRunOptions) {
    if (!activeSessionId || !activeProjectSession || impactOperation || (!impactCaller?.patch && !impactSeeds.length)) return;
    setImpactOperation("starting");
    setImpactError(null);
    setImpactResolutionRun(null);
    setImpactResolutionError(null);
    setImpactResolutionVerificationPending(false);
    try {
      // The complete response supplies the authoritative working checksum;
      // history is captured alongside it immediately before the run starts.
      const [authoritative, authoritativeHistory] = await Promise.all([
        runtimePersistence.inspectProjectSession(activeSessionId),
        runtimePersistence.inspectProjectHistory(activeSessionId)
      ]);
      setProjectSessionState(authoritative.session);
      setProjectHistory(authoritativeHistory);
      const response = await runtimePersistence.startImpactRun(activeSessionId, {
        request_version: 1,
        observed_saved_revision: authoritative.session.saved_revision,
        expected_history_revision: authoritativeHistory.history_revision,
        source_checksum: authoritative.document.checksum,
        scenario: impactCaller?.patch ? {
          scenario_version: 1,
          type: "patch",
          patch: impactCaller.patch
        } : {
          scenario_version: 1,
          type: "selection",
          intent: options.intent,
          seeds: impactSeeds
        },
        direction: options.direction,
        domains: options.domains,
        limits: {
          limits_version: 1,
          max_depth: options.depth,
          max_paths_per_target: 3,
          max_targets: 500
        }
      });
      setImpactRun(response.run);
    } catch (error) {
      setImpactError(localizeRuntimeError(error));
    } finally {
      setImpactOperation(null);
    }
  }



  async function cancelImpactAnalysis() {
    if (!activeSessionId || !impactRun || impactOperation === "cancelling") return;
    setImpactOperation("cancelling");
    setImpactError(null);
    try {
      const response = await runtimePersistence.cancelImpactRun(activeSessionId, impactRun.id);
      setImpactRun(response.run);
    } catch (error) {
      setImpactError(localizeRuntimeError(error));
    } finally {
      setImpactOperation(null);
    }
  }



  /** Starts optional provider assistance against the exact completed deterministic snapshot. */
  async function runImpactResolution(findingIds: string[], includeRejected = false) {
    if (!activeSessionId || !impactRun || impactRun.status !== "completed" || impactResolutionOperation) return;
    const settings = activeProjectManifest?.settings;
    const assignment = settings?.agent_providers?.agents?.impact_resolver;
    const profileId = assignment?.provider_source === "override"
      ? assignment.provider_profile_override_id
      : settings?.agent_providers?.default_provider_profile_id;
    if (!settings || settings.impact_resolver?.agent_mode !== "configured"
      || settings.impact_resolver?.content_policy !== "bounded_evidence"
      || !assignment?.model_id || !profileId) return;
    setImpactResolutionOperation("starting");
    setImpactResolutionError(null);
    try {
      const response = await runtimePersistence.startImpactResolutionRun(activeSessionId, {
        request_version: 1,
        impact_run_id: impactRun.id,
        finding_ids: findingIds,
        source_checksum: impactRun.source_checksum,
        provider_source: assignment.provider_source,
        provider_profile_id: assignment.provider_source === "override" ? profileId : null,
        model_id: assignment.model_id,
        content_consent: true,
        include_rejected: includeRejected,
        requested_alternative_count: IMPACT_RESOLUTION_DEFAULT_ALTERNATIVES,
        limits: {
          limits_version: 1,
          max_findings: IMPACT_RESOLUTION_MAX_FINDINGS,
          max_context_resources: IMPACT_RESOLUTION_MAX_CONTEXT_RESOURCES,
          max_context_characters: IMPACT_RESOLUTION_MAX_CONTEXT_CHARACTERS,
          max_patch_operations: IMPACT_RESOLUTION_MAX_PATCH_OPERATIONS,
          max_visual_changes: IMPACT_RESOLUTION_MAX_VISUAL_CHANGES
        }
      });
      setImpactResolutionRun(response.run);
    } catch (error) {
      setImpactResolutionError(localizeRuntimeError(error));
    } finally {
      setImpactResolutionOperation(null);
    }
  }



  async function cancelImpactResolution() {
    if (!activeSessionId || !impactResolutionRun || impactResolutionOperation === "cancelling") return;
    setImpactResolutionOperation("cancelling");
    setImpactResolutionError(null);
    try {
      const response = await runtimePersistence.cancelImpactResolutionRun(activeSessionId, impactResolutionRun.id);
      setImpactResolutionRun(response.run);
    } catch (error) {
      setImpactResolutionError(localizeRuntimeError(error));
    } finally {
      setImpactResolutionOperation(null);
    }
  }



  /** Reviews one exact validated alternative against current document and history tokens. */
  async function decideImpactResolution(
    alternative: ImpactSolutionAlternative,
    decision: "approved" | "rejected"
  ) {
    if (
      !activeSessionId
      || !impactResolutionRun
      || !alternative.semantic_fingerprint
      || !projectHistory
      || impactResolutionOperation
    ) return;
    setImpactResolutionOperation(decision === "approved" ? "approving" : "rejecting");
    setImpactResolutionError(null);
    try {
      const command = {
        command_version: 1 as const,
        alternative_id: alternative.id,
        proposal_semantic_fingerprint: alternative.semantic_fingerprint,
        source_checksum: impactResolutionRun.source_checksum,
        expected_history_revision: projectHistory.history_revision
      };
      const response = decision === "approved"
        ? await runtimePersistence.approveImpactResolutionAlternative(activeSessionId, impactResolutionRun.id, command)
        : await runtimePersistence.rejectImpactResolutionAlternative(activeSessionId, impactResolutionRun.id, command);
      setImpactResolutionRun(response.run);
      if (decision === "approved") {
        const [current, history, issues] = await Promise.all([
          runtimePersistence.inspectProjectSession(activeSessionId),
          runtimePersistence.inspectProjectHistory(activeSessionId),
          activeProjectId
            ? runtimePersistence.listCanonIssues(activeProjectId)
            : Promise.resolve(null)
        ]);
        setProjectSessionState(current.session);
        setProjectHistory(history);
        await loadRuntimeSnapshot(() => runtimePersistence.loadProjectSessionSnapshot(activeSessionId));
        if (issues) setCanonIssues(issues);
        setImpactResolutionVerificationPending(true);
      }
    } catch (error) {
      setImpactResolutionError(localizeRuntimeError(error));
    } finally {
      setImpactResolutionOperation(null);
    }
  }



  /** Rechecks the approved proposal's original evidence with current authoring tokens. */
  async function verifyApprovedImpactResolution() {
    if (!activeSessionId || !activeProjectSession || !impactRun || impactOperation) return;
    const originalRequest = impactRun.request;
    const scenario = originalRequest.scenario.type === "selection"
      ? originalRequest.scenario
      : {
          scenario_version: 1 as const,
          type: "selection" as const,
          intent: "modify" as const,
          seeds: [...new Map(
            impactRun.findings.flatMap((finding) => finding.seeds)
              .map((seed) => [impactResourceKey(seed.resource), seed])
          ).values()]
        };
    if (!scenario.seeds.length) return;
    setImpactOperation("starting");
    setImpactError(null);
    try {
      const [authoritative, authoritativeHistory] = await Promise.all([
        runtimePersistence.inspectProjectSession(activeSessionId),
        runtimePersistence.inspectProjectHistory(activeSessionId)
      ]);
      const response = await runtimePersistence.startImpactRun(activeSessionId, {
        ...originalRequest,
        observed_saved_revision: authoritative.session.saved_revision,
        expected_history_revision: authoritativeHistory.history_revision,
        source_checksum: authoritative.document.checksum,
        scenario
      });
      setProjectSessionState(authoritative.session);
      setProjectHistory(authoritativeHistory);
      setImpactRun(response.run);
      setImpactResolutionRun(null);
      setImpactResolutionVerificationPending(false);
    } catch (error) {
      setImpactError(localizeRuntimeError(error));
    } finally {
      setImpactOperation(null);
    }
  }



  /** Opens Canon and runs its deterministic rules against the applied document. */
  function verifyApprovedImpactResolutionCanon() {
    setImpactResolutionVerificationPending(false);
    setImpactOpen(false);
    setCanonMode("deterministic");
    setCanonOpen(true);
    setLastAnalysisTool("canon");
    void runCanonCheck(false, "deterministic");
  }



  /** Sends a local patch draft through the same deterministic validator as provider output. */
  async function editImpactResolution(
    alternative: ImpactSolutionAlternative,
    patch: ProjectPatch
  ) {
    if (!activeSessionId || !impactResolutionRun || impactResolutionOperation) return;
    setImpactResolutionOperation("editing");
    setImpactResolutionError(null);
    try {
      const response = await runtimePersistence.editImpactResolutionAlternative(
        activeSessionId,
        impactResolutionRun.id,
        { edit_version: 1, alternative_id: alternative.id, patch }
      );
      setImpactResolutionRun(response.run);
    } catch (error) {
      setImpactResolutionError(localizeRuntimeError(error));
    } finally {
      setImpactResolutionOperation(null);
    }
  }



  async function reviewCanonIssue(
    issueId: string,
    status: "open" | "review" | "ignored"
  ) {
    if (!activeSessionId || canonOperation) return;
    setCanonError(null);
    setCanonNotice(null);
    setCanonOperation("reviewing");
    try {
      const updated = await runtimePersistence.changeCanonIssueStatus(issueId, {
        session_id: activeSessionId,
        expected_history_revision: projectHistory?.history_revision ?? 0,
        status
      });
      setCanonSuggestion((current) => current?.issue_id === issueId ? null : current);
      await loadRuntimeSnapshot(() => runtimePersistence.loadProjectSessionSnapshot(activeSessionId));
      const [history, issues] = await Promise.all([
        runtimePersistence.inspectProjectHistory(activeSessionId),
        activeProjectId
          ? runtimePersistence.listCanonIssues(activeProjectId)
          : Promise.resolve(null)
      ]);
      setProjectHistory(history);
      // A review command changes the project checksum, so every repair capability must
      // be re-projected rather than only replacing the status-changed issue.
      if (issues) setCanonIssues(issues);
      else {
        setCanonIssues((current) => current
          ? { ...current, issues: current.issues.map((issue) => issue.id === updated.id ? updated : issue) }
          : current);
      }
    } catch (error) {
      setCanonError(localizeRuntimeError(error));
    } finally {
      setCanonOperation(null);
    }
  }



  async function requestCanonSuggestion(issueId: string) {
    if (!activeSessionId || canonOperation) return;
    const issue = canonIssues?.issues.find((candidate) => candidate.id === issueId);
    if (!issue?.repair.available || issue.repair.action !== "request_fix") return;
    setCanonError(null);
    setCanonNotice(null);
    setCanonOperation("reviewing");
    try {
      const response = await runtimePersistence.requestCanonIssueSuggestion(issueId, {
        session_id: activeSessionId,
        source_checksum: issue.repair.source_checksum
      });
      setCanonSuggestion(response.suggestion);
      setCanonNotice(i18next.t(response.message_key));
      if (response.suggestion) {
        // Inline repair enters the existing review surface; requesting never applies the patch.
        setSelectedCanonIssueId(issueId);
        setCanonOpen(true);
        setLastAnalysisTool("canon");
      }
    } catch (error) {
      setCanonError(localizeRuntimeError(error));
    } finally {
      setCanonOperation(null);
    }
  }



  /** Opens ordinary Impact Analysis from exact server-owned Issue targets and evidence. */
  async function exploreCanonIssue(issueId: string) {
    if (!activeSessionId || !projectHistory || canonOperation || impactOperation) return;
    const issue = canonIssues?.issues.find((candidate) => candidate.id === issueId);
    if (!issue?.repair.available || issue.repair.action !== "explore_solutions") return;
    const origin = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    setCanonError(null);
    setCanonNotice(null);
    setCanonOperation("reviewing");
    setImpactOperation("starting");
    try {
      const response = await runtimePersistence.startCanonIssueImpact(issueId, {
        session_id: activeSessionId,
        expected_history_revision: projectHistory.history_revision,
        source_checksum: issue.repair.source_checksum
      });
      const seeds = response.run.request.scenario.type === "selection"
        ? response.run.request.scenario.seeds
        : [];
      setImpactSeeds(seeds);
      setImpactRun(response.run);
      setImpactError(null);
      setImpactResolutionRun(null);
      setImpactResolutionError(null);
      setImpactResolutionVerificationPending(false);
      impactOriginRef.current = origin;
      setImpactCaller({
        key: `canon-issue:${issue.id}`,
        kind: "canon-issue",
        label: tr("canon.exploreSolutions")
      });
      setSelectedCanonIssueId(issue.id);
      setLastAnalysisTool("impact");
      setSceneAnalysisOpen(false);
      setImpactOpen(true);
      setContextMenu(null);
    } catch (error) {
      setCanonError(localizeRuntimeError(error));
    } finally {
      setImpactOperation(null);
      setCanonOperation(null);
    }
  }



  function repairCanonIssue(issue: CanonIssueProjection) {
    if (issue.repair.action === "request_fix") void requestCanonSuggestion(issue.id);
    if (issue.repair.action === "explore_solutions") void exploreCanonIssue(issue.id);
  }



  async function decideCanonSuggestion(decision: "approved" | "rejected") {
    if (!activeSessionId || !canonSuggestion || !projectHistory || canonOperation) return;
    setCanonError(null);
    setCanonNotice(null);
    setCanonOperation("reviewing");
    try {
      const command = {
        session_id: activeSessionId,
        expected_history_revision: projectHistory.history_revision
      };
      const response = decision === "approved"
        ? await runtimePersistence.approveCanonFixSuggestion(canonSuggestion.id, command)
        : await runtimePersistence.rejectCanonFixSuggestion(canonSuggestion.id, command);
      setProjectHistory(response.history);
      await rehydrateHistoryProject(response.project);
      setCanonSuggestion(response.suggestion);
      if (decision === "approved" && activeProjectId) {
        setCanonIssues(await runtimePersistence.listCanonIssues(activeProjectId));
      }
      setCanonNotice(tr(decision === "approved" ? "canon.suggestion.approved" : "canon.suggestion.rejected"));
    } catch (error) {
      setCanonError(localizeRuntimeError(error));
    } finally {
      setCanonOperation(null);
    }
  }

  return { runCanonCheck, cancelCanonCheck, runImpactAnalysis, cancelImpactAnalysis, runImpactResolution, cancelImpactResolution, decideImpactResolution, verifyApprovedImpactResolution, verifyApprovedImpactResolutionCanon, editImpactResolution, reviewCanonIssue, requestCanonSuggestion, exploreCanonIssue, repairCanonIssue, decideCanonSuggestion };
}
