/** Candidate review tests cover explicit consent and independent acceptance. */

import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import type { AgentMemoryCandidateRunV1 } from "@something-to-tell/contracts/agent-memory";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { i18next } from "../../localization/i18n";
import type { RuntimeAgentMemoryPersistence } from "../../runtime/apiTypes";
import { AgentMemoryCandidateReview } from "./AgentMemoryCandidateReview";

const checksum = "a".repeat(64);

function completedRun(status: "completed" | "rejected" | "accepted" = "completed"): AgentMemoryCandidateRunV1 {
  const request = {
    request_version: 1,
    session_id: "session-one",
    project_id: "project-one",
    agent_id: "canon_checker",
    namespace: "canon_checker",
    scope: { scope_version: 1, kind: "project" },
    content_locale: "en",
    observed_source_checksum: checksum,
    expected_history_revision: 3,
    guidance_request: "Keep ownership transitions explicit.",
    content_consent: true
  } as const;
  return {
    run_version: 1,
    id: "run-one",
    project_id: "project-one",
    request,
    source_checksum: checksum,
    history_revision: 3,
    status,
    progress: 100,
    predecessor_run_id: null,
    candidate: {
      candidate_version: 1,
      id: "candidate-one",
      project_id: "project-one",
      agent_id: "canon_checker",
      namespace: "canon_checker",
      scope: { scope_version: 1, kind: "project" },
      content_locale: "en",
      title: "Explicit ownership",
      instruction: "Represent every ownership transfer as an authored event.",
      rationale: "This keeps Canon checks temporal.",
      source_checksum: checksum,
      history_revision: 3,
      semantic_fingerprint: "b".repeat(64),
      created_at: "2026-09-17T10:00:00Z"
    },
    provider_disclosure: {
      provider: "openai",
      provider_profile_id: "provider-one",
      model_id: "model-one"
    },
    error_code: null,
    started_at: "2026-09-17T10:00:00Z",
    completed_at: "2026-09-17T10:00:01Z"
  };
}

function persistence(): RuntimeAgentMemoryPersistence {
  const run = completedRun();
  return {
    loadAgentMemoryWorkspace: vi.fn(),
    applyAgentMemoryCommand: vi.fn(),
    inspectAgentMemoryDeletionImpact: vi.fn(),
    resolveAgentMemory: vi.fn(),
    startAgentMemoryCandidate: vi.fn().mockResolvedValue(run),
    inspectAgentMemoryCandidate: vi.fn(),
    cancelAgentMemoryCandidate: vi.fn(),
    retryAgentMemoryCandidate: vi.fn().mockResolvedValue(run),
    rejectAgentMemoryCandidate: vi.fn().mockResolvedValue(completedRun("rejected")),
    acceptAgentMemoryCandidate: vi.fn().mockResolvedValue({
      response_version: 1,
      result: {},
      run: completedRun("accepted")
    })
  };
}

describe("AgentMemoryCandidateReview", () => {
  beforeEach(async () => {
    await i18next.changeLanguage("en");
  });

  it("requires consent, previews safe provider identity, and accepts exact output", async () => {
    const runtime = persistence();
    const onAccepted = vi.fn().mockResolvedValue(undefined);
    render(<AgentMemoryCandidateReview
      activeSessionId="session-one"
      historyRevision={3}
      identity={{
        agent_id: "canon_checker",
        content_locale: "en",
        scope: { scope_version: 1, kind: "project" }
      }}
      onAccepted={onAccepted}
      onClose={vi.fn()}
      persistence={runtime}
      projectId="project-one"
      sourceChecksum={checksum}
      supersedesId="memory-old"
    />);

    const request = screen.getByRole("button", { name: "Request suggestion" });
    expect(request).toBeDisabled();
    fireEvent.change(screen.getByLabelText("What should the agent remember?"), {
      target: { value: "Keep ownership transitions explicit." }
    });
    fireEvent.click(screen.getByLabelText("I consent to sending the selected target content for this request."));
    fireEvent.click(request);

    expect(await screen.findByText("Explicit ownership")).toBeInTheDocument();
    expect(screen.getByText("openai · model-one")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Accept" }));

    await waitFor(() => expect(runtime.acceptAgentMemoryCandidate).toHaveBeenCalledWith(
      "session-one",
      "run-one",
      expect.objectContaining({
        candidate_id: "candidate-one",
        semantic_fingerprint: "b".repeat(64),
        supersedes_id: "memory-old"
      })
    ));
    expect(onAccepted).toHaveBeenCalledOnce();
    expect(screen.getByText("Accepted")).toBeInTheDocument();
  });

  it("rejects without accepting and leaves a retryable reviewed candidate", async () => {
    const runtime = persistence();
    render(<AgentMemoryCandidateReview
      activeSessionId="session-one"
      historyRevision={3}
      identity={{ agent_id: "canon_checker", content_locale: "en", scope: { scope_version: 1, kind: "project" } }}
      onAccepted={vi.fn()}
      onClose={vi.fn()}
      persistence={runtime}
      projectId="project-one"
      sourceChecksum={checksum}
      supersedesId={null}
    />);
    fireEvent.change(screen.getByLabelText("What should the agent remember?"), { target: { value: "Keep ownership explicit." } });
    fireEvent.click(screen.getByLabelText("I consent to sending the selected target content for this request."));
    fireEvent.click(screen.getByRole("button", { name: "Request suggestion" }));
    fireEvent.click(await screen.findByRole("button", { name: "Reject" }));

    await waitFor(() => expect(runtime.rejectAgentMemoryCandidate).toHaveBeenCalledOnce());
    expect(runtime.acceptAgentMemoryCandidate).not.toHaveBeenCalled();
    expect(screen.getByRole("button", { name: "Request again" })).toBeEnabled();
  });
});
