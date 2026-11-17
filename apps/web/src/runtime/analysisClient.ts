/* Analysis runtime endpoint ownership. */
import type { CanonCheckRun, CanonFixSuggestionDecisionResponse, CanonIssueImpactRequest, CanonIssueListResponse, CanonIssueProjection, CanonIssueStatusChange, CanonIssueSuggestionRequest, CanonIssueSuggestionResponse, CanonRunStart } from "@something-to-tell/contracts/canon-check";
import type { ImpactAnalysisRequest, ImpactAnalysisResponse } from "@something-to-tell/contracts/impact-analysis";
import type { ImpactResolutionContextPackage, ImpactResolutionDecisionResponse, ImpactResolutionRequest, ImpactResolutionResponse } from "@something-to-tell/contracts/impact-resolution";
import type { DialogueDocument } from "../dialogue/contracts";
import type { QuestDocument } from "../quest/contracts";
import { type SceneAnalysisResponse } from "../types";
import type { RuntimeAnalysisPersistence, RuntimeSuggestion } from "./apiTypes";
import type { RuntimeTransport } from "./transport";
export function createAnalysisRuntimeClient(transport: RuntimeTransport): RuntimeAnalysisPersistence {
  const { getJson, sendJson } = transport;
  return {
    /** Starts immutable analysis against the current session concurrency tokens. */
    async startImpactRun(sessionId: string, command: ImpactAnalysisRequest): Promise<ImpactAnalysisResponse> {
      return sendJson<ImpactAnalysisResponse>("POST", `/project-sessions/${encodeURIComponent(sessionId)}/impact-analysis/runs`, command);
    },
    /** Polls one process-local Impact run without touching project persistence. */
    async inspectImpactRun(sessionId: string, runId: string): Promise<ImpactAnalysisResponse> {
      return getJson<ImpactAnalysisResponse>(`/project-sessions/${encodeURIComponent(sessionId)}/impact-analysis/runs/${encodeURIComponent(runId)}`);
    },
    /** Requests cooperative cancellation and returns the latest complete run shape. */
    async cancelImpactRun(sessionId: string, runId: string): Promise<ImpactAnalysisResponse> {
      return sendJson<ImpactAnalysisResponse>("POST", `/project-sessions/${encodeURIComponent(sessionId)}/impact-analysis/runs/${encodeURIComponent(runId)}/cancel`, {});
    },
    /** Reads the bounded, inspectable provider payload without mutating project state. */
    async buildImpactResolutionContext(sessionId: string, runId: string, command: ImpactResolutionRequest): Promise<ImpactResolutionContextPackage> {
      return sendJson<ImpactResolutionContextPackage>("POST", `/project-sessions/${encodeURIComponent(sessionId)}/impact-analysis/runs/${encodeURIComponent(runId)}/resolution-context`, command);
    },
    /** Starts optional provider prose while deterministic findings remain authoritative. */
    async startImpactResolutionRun(sessionId: string, command: ImpactResolutionRequest): Promise<ImpactResolutionResponse> {
      return sendJson<ImpactResolutionResponse>("POST", `/project-sessions/${encodeURIComponent(sessionId)}/impact-analysis/resolution-runs`, command);
    },
    /** Polls one process-local provider explanation run. */
    async inspectImpactResolutionRun(sessionId: string, runId: string): Promise<ImpactResolutionResponse> {
      return getJson<ImpactResolutionResponse>(`/project-sessions/${encodeURIComponent(sessionId)}/impact-analysis/resolution-runs/${encodeURIComponent(runId)}`);
    },
    /** Requests cancellation without changing the source Impact run or project. */
    async cancelImpactResolutionRun(sessionId: string, runId: string): Promise<ImpactResolutionResponse> {
      return sendJson<ImpactResolutionResponse>("POST", `/project-sessions/${encodeURIComponent(sessionId)}/impact-analysis/resolution-runs/${encodeURIComponent(runId)}/cancel`, {});
    },
    /** Revalidates one locally edited patch without touching project state. */
    async editImpactResolutionAlternative(sessionId, runId, command) {
      return sendJson<ImpactResolutionResponse>("POST", `/project-sessions/${encodeURIComponent(sessionId)}/impact-analysis/resolution-runs/${encodeURIComponent(runId)}/edit`, command);
    },
    /** Applies the exact reviewed patch through one runtime history command. */
    async approveImpactResolutionAlternative(sessionId, runId, command) {
      return sendJson<ImpactResolutionDecisionResponse>("POST", `/project-sessions/${encodeURIComponent(sessionId)}/impact-analysis/resolution-runs/${encodeURIComponent(runId)}/approve`, command);
    },
    /** Persists only rejection identity and leaves authoring state untouched. */
    async rejectImpactResolutionAlternative(sessionId, runId, command) {
      return sendJson<ImpactResolutionDecisionResponse>("POST", `/project-sessions/${encodeURIComponent(sessionId)}/impact-analysis/resolution-runs/${encodeURIComponent(runId)}/reject`, command);
    },
    /** Starts one explicit saved-revision check; the returned state may already be terminal. */
    async startCanonRun(command: CanonRunStart): Promise<CanonCheckRun> {
      return sendJson<CanonCheckRun>("POST", "/canon-checks/runs", command);
    },
    /** Reads process-local run state while durable Issues remain project-owned. */
    async inspectCanonRun(runId: string): Promise<CanonCheckRun> {
      return getJson<CanonCheckRun>(`/canon-checks/runs/${encodeURIComponent(runId)}`);
    },
    /** Cooperatively cancels evaluation before atomic reconciliation begins. */
    async cancelCanonRun(runId: string): Promise<CanonCheckRun> {
      return sendJson<CanonCheckRun>("POST", `/canon-checks/runs/${encodeURIComponent(runId)}/cancel`, {});
    },
    /** Lists only typed generated canon Issues for the open project. */
    async listCanonIssues(projectId: string): Promise<CanonIssueListResponse> {
      return getJson<CanonIssueListResponse>(`/canon-checks/projects/${encodeURIComponent(projectId)}/issues`);
    },
    /** Records one human review state through bounded authoring history. */
    async changeCanonIssueStatus(issueId: string, command: CanonIssueStatusChange): Promise<CanonIssueProjection> {
      return sendJson<CanonIssueProjection>("POST", `/canon-checks/issues/${encodeURIComponent(issueId)}/status`, command);
    },
    /** Requests fixer availability without applying or approving any change. */
    async requestCanonIssueSuggestion(issueId: string, command: CanonIssueSuggestionRequest): Promise<CanonIssueSuggestionResponse> {
      return sendJson<CanonIssueSuggestionResponse>("POST", `/canon-checks/issues/${encodeURIComponent(issueId)}/suggest`, command);
    },
    /** Starts normal deterministic Impact Analysis from runtime-owned Issue evidence. */
    async startCanonIssueImpact(issueId: string, command: CanonIssueImpactRequest): Promise<ImpactAnalysisResponse> {
      return sendJson<ImpactAnalysisResponse>("POST", `/canon-checks/issues/${encodeURIComponent(issueId)}/impact-analysis`, command);
    },
    /** Applies one reviewed checksum-bound Canon patch through project history. */
    async approveCanonFixSuggestion(suggestionId, command) {
      return sendJson<CanonFixSuggestionDecisionResponse<DialogueDocument, QuestDocument>>("POST", `/canon-checks/suggestions/${encodeURIComponent(suggestionId)}/approve`, command);
    },
    /** Persists a rejection audit without applying the proposed records. */
    async rejectCanonFixSuggestion(suggestionId, command) {
      return sendJson<CanonFixSuggestionDecisionResponse<DialogueDocument, QuestDocument>>("POST", `/canon-checks/suggestions/${encodeURIComponent(suggestionId)}/reject`, command);
    },
    async analyzeScene(projectId: string, title: string, sceneText: string): Promise<SceneAnalysisResponse> {
      return sendJson<SceneAnalysisResponse>("POST", "/analysis/scenes", {
        metadata: {},
        project_id: projectId,
        provider: "deterministic",
        scene_text: sceneText,
        title
      });
    },
    async approveSuggestion(suggestionId: string): Promise<RuntimeSuggestion> {
      return sendJson<RuntimeSuggestion>("POST", `/suggestions/${encodeURIComponent(suggestionId)}/approve`, {});
    },
    async rejectSuggestion(suggestionId: string): Promise<RuntimeSuggestion> {
      return sendJson<RuntimeSuggestion>("POST", `/suggestions/${encodeURIComponent(suggestionId)}/reject`, {});
    },
    async approveSuggestionOperation(suggestionId: string, operationIndex: number): Promise<RuntimeSuggestion> {
      return sendJson<RuntimeSuggestion>("POST", `/suggestions/${encodeURIComponent(suggestionId)}/operations/${operationIndex}/approve`, {});
    },
    async rejectSuggestionOperation(suggestionId: string, operationIndex: number): Promise<RuntimeSuggestion> {
      return sendJson<RuntimeSuggestion>("POST", `/suggestions/${encodeURIComponent(suggestionId)}/operations/${operationIndex}/reject`, {});
    }
  };
}
