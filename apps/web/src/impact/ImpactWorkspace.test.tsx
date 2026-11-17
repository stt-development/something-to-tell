import { fireEvent, render, screen, within } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import type { ImpactAnalysisRun, ImpactFinding, ImpactSeed } from "@something-to-tell/contracts/impact-analysis";
import { applyProjectLocale } from "../localization/i18n";
import { boundedResolutionFindingIds, impactMemoryTarget, ImpactWorkspace, type ImpactWorkspaceProps } from "./ImpactWorkspace";

const CHECKSUM = "a".repeat(64);
const SEEDS: ImpactSeed[] = [{
  seed_version: 1,
  resource: { owner_type: "node", owner_id: "gate", context_type: null, context_id: null }
}];

function finding(id: string, propagation: ImpactFinding["propagation"], distance: number): ImpactFinding {
  const target = { owner_type: "flow_transition", owner_id: id, context_type: null, context_id: null };
  return {
    finding_version: 1,
    id,
    seeds: SEEDS,
    target,
    domain: "flow",
    direction: "downstream",
    impact_type: "execution",
    propagation,
    distance,
    message_key: "impact.dependency.flowReachability",
    message_parameters: {},
    paths: [{
      path_version: 1,
      direction: "downstream",
      propagation,
      resources: [SEEDS[0]!.resource, target],
      dependencies: [{
        dependency_version: 1,
        source: SEEDS[0]!.resource,
        target,
        domain: "flow",
        kind: "flow_reachability",
        propagation,
        message_key: "impact.dependency.flowReachability",
        message_parameters: {},
        evidence: [{
          owner: target,
          field_path: "target_node_id",
          message_key: "impact.evidence.flowTransition",
          message_parameters: {},
          excerpt: "gate -> courtyard"
        }]
      }]
    }]
  };
}

const FINDINGS = [finding("required-route", "required", 1), finding("optional-route", "conditional", 2)];
const PLAYBACK_FINDING: ImpactFinding = {
  ...finding("playback-main", "required", 2),
  target: { owner_type: "playback_definition", owner_id: "main", context_type: "flow", context_id: "main" },
  domain: "playback",
  paths: [{
    ...finding("playback-main", "required", 2).paths[0]!,
    resources: [
      SEEDS[0]!.resource,
      { owner_type: "flow", owner_id: "main", context_type: null, context_id: null },
      { owner_type: "playback_definition", owner_id: "main", context_type: "flow", context_id: "main" }
    ]
  }]
};
const RUN: ImpactAnalysisRun = {
  run_version: 1,
  id: "impact-run",
  project_id: "project",
  saved_revision: 3,
  history_revision: 2,
  source_checksum: CHECKSUM,
  status: "completed",
  request: {
    request_version: 1,
    observed_saved_revision: 3,
    expected_history_revision: 2,
    source_checksum: CHECKSUM,
    scenario: { scenario_version: 1, type: "selection", intent: "modify", seeds: SEEDS },
    direction: "both",
    domains: ["graph", "flow"],
    limits: { limits_version: 1, max_depth: 3, max_paths_per_target: 3, max_targets: 500 }
  },
  findings: FINDINGS,
  summary: {
    summary_version: 1,
    finding_count: 2,
    direct_count: 1,
    transitive_count: 1,
    propagation: { required: 1, conditional: 1, contextual: 0 },
    truncated: false,
    omitted_count: 0
  },
  diagnostics: [],
  started_at: "2026-08-26T10:00:00Z",
  completed_at: "2026-08-26T10:00:01Z"
};

function props(overrides: Partial<ImpactWorkspaceProps> = {}): ImpactWorkspaceProps {
  return {
    error: null,
    operation: null,
    run: RUN,
    seeds: SEEDS,
    onCancel: vi.fn(),
    onClear: vi.fn(),
    onClose: vi.fn(),
    onNavigate: vi.fn(),
    onOpenStory: vi.fn(),
    onReproducePlayback: vi.fn(),
    onRun: vi.fn(),
    resourceLabel: (resource) => ({ gate: "Citadel Gate", "required-route": "Open courtyard", "optional-route": "Patrol detour" })[resource.owner_id] ?? resource.owner_id,
    storyFindingCount: 2,
    ...overrides
  };
}

describe("ImpactWorkspace", () => {
  it("retains explicit Flow and Scene context when deriving memory disclosure", () => {
    expect(impactMemoryTarget([{
      seed_version: 1,
      resource: { owner_type: "node", owner_id: "gate", context_type: "flow", context_id: "flow-main" }
    }], "en")).toEqual({
      agentId: "impact_resolver",
      contentLocale: "en",
      scope: { scope_version: 1, kind: "node", node_id: "gate" },
      contextScope: { scope_version: 1, kind: "story_flow", flow_id: "flow-main" }
    });
    expect(impactMemoryTarget([{
      seed_version: 1,
      resource: { owner_type: "node", owner_id: "gate", context_type: "scene", context_id: "scene-harbor" }
    }], "ru").contextScope).toEqual({
      scope_version: 1,
      kind: "scene",
      scene_node_id: "scene-harbor"
    });
  });
  it("bounds agent findings by serialized context while preserving closest order", () => {
    const largeFindings = Array.from({ length: 50 }, (_, index) => ({
      ...finding(`finding-${String(index).padStart(2, "0")}`, "required", 1),
      message_parameters: { detail: "x".repeat(4_000) }
    }));

    const selected = boundedResolutionFindingIds(largeFindings);

    expect(selected.length).toBeGreaterThan(1);
    expect(selected.length).toBeLessThan(50);
    expect(selected).toEqual(largeFindings.slice(0, selected.length).map((item) => item.id));
  });

  it("runs selected seeds with explicit intent, direction, depth, and domains", () => {
    const onRun = vi.fn();
    render(<ImpactWorkspace {...props({ onRun })} />);

    fireEvent.click(screen.getByRole("button", { name: "Delete" }));
    fireEvent.click(screen.getByRole("button", { name: "Upstream" }));
    fireEvent.change(screen.getByLabelText("Depth"), { target: { value: "5" } });
    fireEvent.click(screen.getByLabelText("Canon"));
    fireEvent.click(screen.getByRole("button", { name: "Analyze" }));

    expect(onRun).toHaveBeenCalledWith(expect.objectContaining({
      depth: 5,
      direction: "upstream",
      intent: "delete",
      domains: expect.not.arrayContaining(["canon"])
    }));
  });

  it("runs a reviewed patch without requiring selection seeds", () => {
    const onRun = vi.fn();
    render(<ImpactWorkspace {...props({
      initialIntent: "modify",
      onRun,
      originLabel: "Canon suggestion",
      scenarioType: "patch",
      seeds: []
    })} />);

    expect(screen.getByText("Proposed patch")).toBeInTheDocument();
    expect(screen.getByText("Canon suggestion")).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Delete" })).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Analyze" }));

    expect(onRun).toHaveBeenCalledWith(expect.objectContaining({ intent: "modify" }));
  });

  it("returns to a caller but blocks apply-through navigation for stale results", () => {
    const onReturn = vi.fn();
    const { rerender } = render(<ImpactWorkspace {...props({ onReturn, originLabel: "Delete selection" })} />);

    fireEvent.click(screen.getByRole("button", { name: "Return to Delete selection" }));
    expect(onReturn).toHaveBeenCalledOnce();

    rerender(<ImpactWorkspace {...props({ onReturn, originLabel: "Delete selection", run: { ...RUN, status: "stale" } })} />);
    const returnButton = screen.getByRole("button", { name: "Return to Delete selection" });
    expect(returnButton).toBeDisabled();
    expect(returnButton).toHaveAttribute("title", expect.stringMatching(/again/i));
  });

  it("groups findings with non-color labels and expands path evidence", () => {
    render(<ImpactWorkspace {...props()} />);

    expect(screen.getByRole("heading", { name: /Required/ })).toBeInTheDocument();
    expect(screen.getByRole("heading", { name: /Conditional/ })).toBeInTheDocument();
    const requiredFinding = screen.getAllByText("Open courtyard")[0]!.closest("details")!;
    fireEvent.click(requiredFinding.querySelector("summary")!);

    expect(within(requiredFinding).getByText("Dependency paths")).toBeInTheDocument();
    expect(within(requiredFinding).getByText("Authored Story Flow transition.")).toBeInTheDocument();
    expect(within(requiredFinding).getByText("target_node_id")).toBeInTheDocument();
    expect(within(requiredFinding).getByText("gate -> courtyard")).toBeInTheDocument();
  });

  it("navigates to the exact finding source without toggling path details", () => {
    const onNavigate = vi.fn();
    render(<ImpactWorkspace {...props({ onNavigate })} />);

    fireEvent.click(screen.getByRole("button", { name: "Open impact source: Open courtyard" }));
    expect(onNavigate).toHaveBeenCalledWith(RUN.findings[0]);
  });

  it("opens the derived Story projection and reproduces an exact Playback consequence", () => {
    const onOpenStory = vi.fn();
    const onReproducePlayback = vi.fn();
    const run = {
      ...RUN,
      findings: [...RUN.findings, PLAYBACK_FINDING],
      summary: { ...RUN.summary, finding_count: 3, transitive_count: 2 }
    };
    render(<ImpactWorkspace {...props({ onOpenStory, onReproducePlayback, run })} />);

    expect(screen.getByText("2 affected findings")).toBeInTheDocument();
    expect(screen.getByText("1 executable consequence")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Open story" }));
    fireEvent.click(screen.getByRole("button", { name: "Reproduce" }));

    expect(onOpenStory).toHaveBeenCalledOnce();
    expect(onReproducePlayback).toHaveBeenCalledWith(PLAYBACK_FINDING);
  });

  it("filters propagation categories and preserves backend summary totals", () => {
    render(<ImpactWorkspace {...props()} />);

    fireEvent.click(screen.getByRole("button", { name: /Conditional 1/ }));
    expect(screen.queryByText("Patrol detour")).not.toBeInTheDocument();
    expect(screen.getAllByText("Open courtyard")[0]).toBeInTheDocument();
    expect(screen.getByText("2")).toBeInTheDocument();
  });

  it("shows stable progress and cancellation controls", () => {
    const onCancel = vi.fn();
    render(<ImpactWorkspace {...props({ onCancel, operation: "starting", run: { ...RUN, status: "running" } })} />);

    expect(screen.getByRole("status")).toHaveTextContent("Tracing project dependencies");
    fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
    expect(onCancel).toHaveBeenCalledOnce();
  });

  it("discloses when agent review uses a bounded subset of deterministic findings", () => {
    const findings = Array.from({ length: 50 }, (_, index) => ({
      ...finding(`large-${String(index).padStart(2, "0")}`, "required", 1),
      message_parameters: { detail: "x".repeat(4_000) }
    }));
    render(<ImpactWorkspace {...props({
      resolutionInitiallyExpanded: true,
      run: { ...RUN, findings, summary: { ...RUN.summary, finding_count: 50, direct_count: 50, transitive_count: 0, propagation: { required: 50, conditional: 0, contextual: 0 } } }
    })} />);

    expect(screen.getByText(/closest findings out of 50/i)).toBeInTheDocument();
  });

  it("distinguishes empty, truncated, stale, and failed states", () => {
    const { rerender } = render(<ImpactWorkspace {...props({ run: { ...RUN, findings: [], summary: { ...RUN.summary, finding_count: 0, direct_count: 0, transitive_count: 0 } } })} />);
    expect(screen.getByText("No affected resources")).toBeInTheDocument();

    rerender(<ImpactWorkspace {...props({ run: { ...RUN, summary: { ...RUN.summary, truncated: true, omitted_count: 7 } } })} />);
    expect(screen.getByText(/7 additional findings were omitted/)).toBeInTheDocument();

    rerender(<ImpactWorkspace {...props({ run: { ...RUN, status: "stale" } })} />);
    expect(screen.getByText(/project changed during analysis/i)).toBeInTheDocument();

    rerender(<ImpactWorkspace {...props({ error: "Runtime unavailable", run: null })} />);
    expect(screen.getByRole("alert")).toHaveTextContent("Runtime unavailable");
  });

  it("supports result arrow navigation and focuses close on open", () => {
    render(<ImpactWorkspace {...props()} />);
    expect(screen.getByRole("button", { name: "Close" })).toHaveFocus();

    const first = screen.getAllByText("Open courtyard")[0]!.closest("summary")!;
    first.focus();
    fireEvent.keyDown(first, { key: "ArrowDown" });
    expect(screen.getAllByText("Patrol detour")[0]!.closest("summary")).toHaveFocus();
  });

  it("renders controls and propagation labels in Russian", async () => {
    await applyProjectLocale("ru");
    render(<ImpactWorkspace {...props()} />);

    expect(screen.getByRole("complementary", { name: "Анализ влияния" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Анализировать" })).toBeInTheDocument();
    expect(screen.getByRole("heading", { name: /Обязательные/ })).toBeInTheDocument();
    await applyProjectLocale("en");
  });
});
