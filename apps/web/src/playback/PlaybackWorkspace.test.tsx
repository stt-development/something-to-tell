import type { Node } from "@xyflow/react";
import { fireEvent, render, screen, within } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import type { NarrativeNodeData, NarrativeNodeKind } from "../types";
import { findFactTraceSequence, PlaybackSlideContent, PlaybackWorkspace } from "./PlaybackWorkspace";
import { advanceProjectAuroraPlayback, startProjectAuroraPlayback } from "../testFixtures/projectAuroraPlayback";
import type { CanonIssueProjection } from "@something-to-tell/contracts/canon-check";

function node(kind: NarrativeNodeKind): Node<NarrativeNodeData> {
  return {
    id: `node-${kind.toLowerCase()}`,
    position: { x: 0, y: 0 },
    data: {
      kind,
      label: kind,
      title: kind,
      summary: `${kind} summary`,
      tags: ["fixture"]
    }
  };
}

describe("PlaybackWorkspace", () => {
  it.each([
    ["Character", "Character slide content"],
    ["Quest", "Quest slide content"],
    ["Scene", "Scene slide content"],
    ["Lore", "Lore slide content"],
    ["Location", "Location slide content"],
    ["Dialogue", "Dialogue slide content"],
    ["Faction", "Faction slide content"],
    ["Item", "Item slide content"],
    ["Event", "Event slide content"],
    ["Condition", "Requirement slide content"],
    ["Consequence", "Outcome slide content"]
  ] as const)("renders type-aware content for %s", (kind, label) => {
    render(<PlaybackSlideContent node={node(kind)} stepKind={kind} />);
    expect(screen.getByLabelText(label)).toBeInTheDocument();
  });

  it("shows eligible choices, disabled explanations, and guards busy choices", () => {
    const onChoose = vi.fn();
    const session = startProjectAuroraPlayback("flow-main-story")!;
    render(
      <PlaybackWorkspace
        announcement=""
        busy
        error={null}
        flowName="Main Story"
        localFixture
        loading={false}
        node={node("Scene")}
        nodeLabels={{}}
        onBack={vi.fn()}
        onChoose={onChoose}
        onExit={vi.fn()}
        onOpenSource={vi.fn()}
        onRestart={vi.fn()}
        onRetry={vi.fn()}
        preparationFacts={[]}
        session={session}
        transitionLabels={{}}
      />
    );

    const choice = screen.getByRole("button", { name: /Begin inspection/ });
    expect(choice).toBeDisabled();
    fireEvent.click(choice);
    expect(onChoose).not.toHaveBeenCalled();
    expect(screen.getByText("Updating Playback.")).toBeInTheDocument();
  });

  it("keeps the exact Canon diagnostic visible over Playback", () => {
    const owner = { owner_type: "flow", owner_id: "flow-main-story", context_type: null, context_id: null } as const;
    const issue = {
      id: "playback-issue",
      project_id: "project-aurora",
      title: "Playback definition is invalid",
      description: "Review the highlighted Flow.",
      severity: "critical",
      status: "open",
      metadata: {
        issue_version: 1,
        message_key: "unknown.playback.problem",
        message_parameters: {},
        recommendation_key: "unknown.playback.repair",
        recommendation_parameters: {},
        targets: [owner]
      }
    } as CanonIssueProjection;

    render(
      <PlaybackWorkspace
        announcement=""
        busy={false}
        canonFocus={{ issue, owner }}
        error={null}
        flowName="Main Story"
        localFixture
        loading={false}
        node={node("Scene")}
        nodeLabels={{}}
        onBack={vi.fn()}
        onChoose={vi.fn()}
        onExit={vi.fn()}
        onOpenSource={vi.fn()}
        onRestart={vi.fn()}
        onRetry={vi.fn()}
        preparationFacts={[]}
        session={startProjectAuroraPlayback("flow-main-story")}
        transitionLabels={{}}
      />
    );

    expect(screen.getByRole("status", { name: /Playback definition is invalid/ }))
      .toBeInTheDocument();
    expect(document.querySelector(".playback-canon-diagnostic"))
      .toHaveAttribute("data-canon-owner-id", "flow-main-story");
  });

  it("renders Dialogue transcript and submits an internal reply before Flow", () => {
    const onChoose = vi.fn();
    const opening = startProjectAuroraPlayback("flow-main-story")!;
    const dialogue = advanceProjectAuroraPlayback(opening, "flow-transition-opening-dialogue");
    render(
      <PlaybackWorkspace
        announcement=""
        busy={false}
        error={null}
        flowName="Main Story"
        localFixture
        loading={false}
        node={{ ...node("Dialogue"), id: "node-dock-dialogue" }}
        nodeLabels={{ "node-dockmaster": "Ilya Voss", "node-hero": "Mara Vale" }}
        onBack={vi.fn()}
        onChoose={onChoose}
        onExit={vi.fn()}
        onOpenSource={vi.fn()}
        onRestart={vi.fn()}
        onRetry={vi.fn()}
        preparationFacts={[]}
        session={dialogue}
        transitionLabels={{}}
      />
    );

    expect(screen.getByLabelText("Dialogue slide content")).toHaveTextContent(
      "Ilya VossNo vessel leaves"
    );
    expect(screen.getByText("Choose a reply")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: /Order the crew to run the blockade/ }));
    expect(onChoose).toHaveBeenCalledWith({
      id: "answer-run-blockade",
      kind: "dialogue"
    });
  });

  it("renders actionable loading, runtime failure, blocked, and ending states", () => {
    const props = {
      announcement: "",
      busy: false,
      flowName: "Main Story",
      localFixture: false,
      node: node("Scene"),
      nodeLabels: {},
      onBack: vi.fn(),
      onChoose: vi.fn(),
      onExit: vi.fn(),
      onOpenSource: vi.fn(),
      onRestart: vi.fn(),
      onRetry: vi.fn(),
      preparationFacts: [],
      transitionLabels: {}
    };
    const { rerender } = render(
      <PlaybackWorkspace {...props} error={null} loading session={null} />
    );
    expect(screen.getByRole("status")).toHaveTextContent("Preparing Playback");

    rerender(
      <PlaybackWorkspace
        {...props}
        error={{ kind: "runtime", message: "Definition rejected." }}
        loading={false}
        session={null}
      />
    );
    expect(screen.getByRole("button", { name: "Try again" })).toBeInTheDocument();

    const blocked = startProjectAuroraPlayback("flow-main-story")!;
    blocked.status = "blocked";
    blocked.facts = [{
      fact_version: 1,
      code: "no_eligible_transition",
      level: "error",
      message: "No transition is eligible.",
      action: "Review transition conditions.",
      flow_id: blocked.flow_id,
      node_id: blocked.current_node_id,
      transition_id: null,
      effect_id: null
    }];
    rerender(
      <PlaybackWorkspace {...props} error={null} loading={false} session={blocked} />
    );
    expect(screen.getByLabelText("Playback blocked")).toHaveTextContent("No transition is eligible.");

    const ending = startProjectAuroraPlayback("flow-main-story")!;
    ending.status = "ended";
    ending.step = { ...ending.step!, choices: [] };
    rerender(
      <PlaybackWorkspace {...props} error={null} loading={false} session={ending} />
    );
    expect(screen.getByText("Ending reached")).toBeInTheDocument();
    expect(screen.getByText("Route complete")).toBeInTheDocument();
  });

  it("shows an empty trace then inspects long labels and complete state", () => {
    const opening = startProjectAuroraPlayback("flow-main-story")!;
    const { rerender } = render(
      <PlaybackWorkspace
        announcement="Opening Dock is ready."
        busy={false}
        error={null}
        flowName="Main Story"
        localFixture
        loading={false}
        node={node("Scene")}
        nodeLabels={{ "node-opening": "Opening Dock" }}
        onBack={vi.fn()}
        onChoose={vi.fn()}
        onExit={vi.fn()}
        onOpenSource={vi.fn()}
        onRestart={vi.fn()}
        onRetry={vi.fn()}
        preparationFacts={[]}
        session={opening}
        transitionLabels={{}}
      />
    );

    fireEvent.click(screen.getByRole("button", { name: "Diagnostics" }));
    expect(screen.getByText("No trace steps yet")).toBeInTheDocument();

    const dialogue = advanceProjectAuroraPlayback(opening, "flow-transition-opening-dialogue");
    dialogue.state.flags.harbor_open = true;
    dialogue.state.item_holders["node-sealed-ledger"] = { holder_version: 1, kind: "character", node_id: "node-dockmaster-ilya" };
    dialogue.state.quest_states["node-smuggler-route"] = "active";
    dialogue.state.dialogue_choice_ids["node-dock-dialogue"] = ["answer-show-ledger"];
    rerender(
      <PlaybackWorkspace
        announcement="Advanced to Dockmaster Warning. 1 state change applied."
        busy={false}
        error={null}
        flowName="Main Story"
        localFixture
        loading={false}
        node={node("Dialogue")}
        nodeLabels={{
          "node-opening": "Opening Dock with a deliberately long diagnostic owner label",
          "node-dock-dialogue": "Dockmaster Warning",
          "node-smuggler-route": "Smuggler Route",
          "node-sealed-ledger": "Sealed Ledger",
          "node-dockmaster-ilya": "Dockmaster Ilya"
        }}
        onBack={vi.fn()}
        onChoose={vi.fn()}
        onExit={vi.fn()}
        onOpenSource={vi.fn()}
        onRestart={vi.fn()}
        onRetry={vi.fn()}
        preparationFacts={[]}
        session={dialogue}
        transitionLabels={{
          "flow-transition-opening-dialogue": "Begin a deliberately long harbor inspection transition"
        }}
      />
    );

    expect(screen.getByLabelText("Playback trace")).toHaveTextContent("Opening Dock with a deliberately long diagnostic owner label");
    expect(screen.getByLabelText("Playback trace")).toHaveTextContent("Begin a deliberately long harbor inspection transition");
    expect(screen.getByLabelText("Playback trace")).toHaveTextContent("false → true");
    fireEvent.click(screen.getByRole("tab", { name: "State" }));
    expect(screen.getByLabelText("Playback state")).toHaveTextContent("Sealed Ledger");
    expect(screen.getByLabelText("Playback state")).toHaveTextContent("Character: Dockmaster Ilya");
    expect(screen.getByLabelText("Playback state")).toHaveTextContent("playback-effect-acquire-ledger");
    expect(screen.getByLabelText("Playback state")).toHaveTextContent("harbor_opentrue");
    expect(screen.getByLabelText("Playback state")).toHaveTextContent("Smuggler Routeactive");
    expect(screen.getByLabelText("Playback state")).toHaveTextContent("Dockmaster Warninganswer-show-ledger");
    expect(screen.getByLabelText("Playback state")).toHaveTextContent("2. Dockmaster Warning");
  });

  it("exposes clear back and restart commands and links blocked facts to trace", () => {
    const onBack = vi.fn();
    const onRestart = vi.fn();
    const opening = startProjectAuroraPlayback("flow-main-story")!;
    const blocked = advanceProjectAuroraPlayback(opening, "flow-transition-opening-dialogue");
    blocked.status = "blocked";
    blocked.facts = [{
      fact_version: 1,
      code: "repeated_effect",
      level: "error",
      message: "The ledger effect was already applied.",
      action: "Go back or restart.",
      flow_id: blocked.flow_id,
      node_id: null,
      transition_id: null,
      effect_id: "playback-effect-acquire-ledger"
    }];
    render(
      <PlaybackWorkspace
        announcement="Playback is blocked."
        busy={false}
        error={null}
        flowName="Main Story"
        localFixture
        loading={false}
        node={node("Dialogue")}
        nodeLabels={{ "node-opening": "Opening Dock" }}
        onBack={onBack}
        onChoose={vi.fn()}
        onExit={vi.fn()}
        onOpenSource={vi.fn()}
        onRestart={onRestart}
        onRetry={vi.fn()}
        preparationFacts={[]}
        session={blocked}
        transitionLabels={{ "flow-transition-opening-dialogue": "Begin inspection" }}
      />
    );

    fireEvent.click(screen.getByRole("button", { name: "Back" }));
    fireEvent.click(screen.getByRole("button", { name: "Restart" }));
    expect(onBack).toHaveBeenCalledOnce();
    expect(onRestart).toHaveBeenCalledOnce();

    fireEvent.click(screen.getByRole("button", { name: "View trace step 1" }));
    expect(screen.getByLabelText("Playback diagnostics")).toBeInTheDocument();
    expect(screen.getByText("Step 1").closest("li")).toHaveAttribute("aria-current", "step");
  });

  it("resolves visit-threshold facts to the latest matching cycle transition", () => {
    const opening = startProjectAuroraPlayback("flow-main-story")!;
    const dialogue = advanceProjectAuroraPlayback(opening, "flow-transition-opening-dialogue");
    const fact = {
      fact_version: 1 as const,
      code: "visit_threshold" as const,
      level: "error" as const,
      message: "The visit threshold was reached.",
      action: "Go back.",
      flow_id: dialogue.flow_id,
      node_id: "node-dock-dialogue",
      transition_id: "flow-transition-opening-dialogue",
      effect_id: null
    };

    expect(findFactTraceSequence(fact, dialogue)).toBe(0);
  });

  it("resolves authored effect facts through their execution binding", () => {
    const session = advanceProjectAuroraPlayback(
      startProjectAuroraPlayback("flow-main-story")!,
      "flow-transition-opening-dialogue"
    );
    session.trace[0]!.state_changes[0]!.authored_effect_id = "authored-ledger-effect";
    const fact = {
      fact_version: 1 as const,
      code: "stale_item_holder" as const,
      level: "error" as const,
      message: "Holder changed.",
      action: "Review the transfer.",
      flow_id: session.flow_id,
      node_id: null,
      transition_id: null,
      effect_id: "authored-ledger-effect"
    };

    expect(findFactTraceSequence(fact, session)).toBe(0);
  });

  it("routes slide, trace, transition, condition, effect, and fact owners", () => {
    const onOpenSource = vi.fn();
    const opening = startProjectAuroraPlayback("flow-main-story")!;
    const dialogue = advanceProjectAuroraPlayback(opening, "flow-transition-opening-dialogue");
    const { rerender } = render(
      <PlaybackWorkspace
        announcement=""
        busy={false}
        error={null}
        flowName="Main Story"
        localFixture
        loading={false}
        node={{ ...node("Dialogue"), id: "node-dock-dialogue" }}
        nodeLabels={{ "node-opening": "Opening Dock" }}
        onBack={vi.fn()}
        onChoose={vi.fn()}
        onExit={vi.fn()}
        onOpenSource={onOpenSource}
        onRestart={vi.fn()}
        onRetry={vi.fn()}
        preparationFacts={[]}
        session={dialogue}
        transitionLabels={{ "flow-transition-opening-dialogue": "Begin inspection" }}
      />
    );

    fireEvent.click(screen.getByRole("button", { name: "Open source in Graph" }));
    fireEvent.click(screen.getByRole("button", { name: "Open source in Flow" }));
    fireEvent.click(screen.getByRole("button", { name: "Open source in Story" }));
    fireEvent.click(screen.getByRole("button", { name: "Open source in Edit" }));
    expect(onOpenSource.mock.calls.slice(0, 4).map(([target]) => target)).toEqual([
      { kind: "node", mode: "relationships", nodeId: "node-dock-dialogue" },
      { kind: "node", mode: "flow", nodeId: "node-dock-dialogue" },
      { kind: "node", mode: "story", nodeId: "node-dock-dialogue" },
      { kind: "node", mode: "edit", nodeId: "node-dock-dialogue" }
    ]);

    fireEvent.click(screen.getByRole("button", { name: "Diagnostics" }));
    const trace = screen.getByLabelText("Playback trace");
    fireEvent.click(within(trace).getByRole("button", { name: "Open source in Graph" }));
    fireEvent.click(within(trace).getByRole("button", { name: "Transition" }));
    fireEvent.click(within(trace).getByRole("button", { name: /Open effect source/ }));
    expect(onOpenSource).toHaveBeenCalledWith({ kind: "node", mode: "relationships", nodeId: "node-opening" });
    expect(onOpenSource).toHaveBeenCalledWith({
      kind: "transition",
      transitionId: "flow-transition-opening-dialogue"
    });
    expect(onOpenSource).toHaveBeenCalledWith({
      effectId: "playback-effect-acquire-ledger",
      kind: "effect"
    });

    const ending = advanceProjectAuroraPlayback(
      advanceProjectAuroraPlayback(
        advanceProjectAuroraPlayback(dialogue, "answer-show-ledger"),
        "flow-transition-dialogue-inspection"
      ),
      "flow-transition-inspection-route"
    );
    rerender(
      <PlaybackWorkspace
        announcement=""
        busy={false}
        error={null}
        flowName="Main Story"
        localFixture
        loading={false}
        node={{ ...node("Consequence"), id: "node-route-consequence" }}
        nodeLabels={{}}
        onBack={vi.fn()}
        onChoose={vi.fn()}
        onExit={vi.fn()}
        onOpenSource={onOpenSource}
        onRestart={vi.fn()}
        onRetry={vi.fn()}
        preparationFacts={[]}
        session={ending}
        transitionLabels={{}}
      />
    );
    fireEvent.click(screen.getByRole("tab", { name: "Facts" }));
    expect(screen.getByLabelText("Playback facts")).toHaveTextContent("ending reached");
    fireEvent.click(within(screen.getByLabelText("Playback facts")).getByRole("button", { name: "Open source" }));
    expect(onOpenSource).toHaveBeenCalledWith({
      fact: ending.facts[0],
      kind: "fact"
    });
  });

  it("presents the complete author-facing Playback fact catalog", () => {
    const session = startProjectAuroraPlayback("flow-main-story")!;
    const codes = [
      "missing_entry",
      "no_eligible_transition",
      "malformed_condition",
      "missing_default_branch",
      "conflicting_effects",
      "visit_threshold",
      "ending_reached",
      "stale_source_revision"
    ] as const;
    session.status = "blocked";
    session.facts = codes.map((code) => ({
      fact_version: 1,
      code,
      level: code === "ending_reached" ? "info" : "error",
      message: `${code} diagnostic message`,
      action: `${code} author action`,
      flow_id: session.flow_id,
      node_id: code === "missing_entry" ? null : session.current_node_id,
      transition_id: code === "visit_threshold" ? "flow-transition-opening-dialogue" : null,
      effect_id: code === "conflicting_effects" ? "playback-effect-acquire-ledger" : null
    }));
    render(
      <PlaybackWorkspace
        announcement=""
        busy={false}
        error={null}
        flowName="Main Story"
        localFixture
        loading={false}
        node={node("Scene")}
        nodeLabels={{}}
        onBack={vi.fn()}
        onChoose={vi.fn()}
        onExit={vi.fn()}
        onOpenSource={vi.fn()}
        onRestart={vi.fn()}
        onRetry={vi.fn()}
        preparationFacts={[]}
        session={session}
        transitionLabels={{}}
      />
    );

    fireEvent.click(screen.getByRole("button", { name: "Diagnostics" }));
    fireEvent.click(screen.getByRole("tab", { name: "Facts" }));
    const facts = screen.getByLabelText("Playback facts");
    codes.forEach((code) => {
      expect(facts).toHaveTextContent(code.replace(/_/g, " "));
      expect(facts).toHaveTextContent(`${code} author action`);
    });
    expect(within(facts).getAllByRole("button", { name: "Open source" })).toHaveLength(codes.length);
  });

  it("shows composed Flow depth, terminal result, and trace operations", () => {
    const session = startProjectAuroraPlayback("flow-smuggler-route")!;
    session.current_flow_id = "flow-smuggler-route";
    session.call_stack = [{
      frame_version: 1,
      invocation_id: "call-main-side",
      caller_flow_id: "flow-main-story",
      caller_source_node_id: "node-inspection",
      callee_flow_id: "flow-smuggler-route",
      exit_bindings: []
    }];
    session.status = "ended";
    session.terminal_exit = { result_version: 1, exit_id: "exit-success", flow_id: "flow-smuggler-route", key: "success", label: "Patrol evaded", source_node_id: "node-route-consequence" };
    session.trace = [{
      trace_version: 1,
      sequence: 0,
      node_id: "node-inspection",
      transition_id: "call-main-side",
      condition_results: [],
      applied_effect_ids: [],
      state_changes: [],
      state_before: structuredClone(session.state),
      state_after: structuredClone(session.state),
      timestamp: "2026-08-04T10:00:00Z",
      events: [
        { event_version: 1, operation: "call", flow_id: "flow-main-story", node_id: "node-inspection", invocation_id: "call-main-side", exit_id: null, message: "Called Smuggler Route." },
        { event_version: 1, operation: "exit", flow_id: "flow-smuggler-route", node_id: "node-route-consequence", invocation_id: null, exit_id: "exit-success", message: "Reached Patrol evaded." }
      ]
    }];
    render(
      <PlaybackWorkspace
        announcement=""
        busy={false}
        error={null}
        flowName="Main Story"
        flowNames={{ "flow-main-story": "Main Story", "flow-smuggler-route": "Smuggler Route" }}
        localFixture
        loading={false}
        node={node("Quest")}
        nodeLabels={{ "node-inspection": "Harbor Inspection" }}
        onBack={vi.fn()}
        onChoose={vi.fn()}
        onExit={vi.fn()}
        onOpenSource={vi.fn()}
        onRestart={vi.fn()}
        onRetry={vi.fn()}
        preparationFacts={[]}
        session={session}
        transitionLabels={{ "call-main-side": "Call the covert harbor route" }}
      />
    );

    expect(screen.getByLabelText("Call depth 1")).toHaveTextContent("Inside Smuggler Route");
    expect(screen.getByText("Exit reached: Patrol evaded")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: /^Diagnostics$/ }));
    expect(screen.getByLabelText("Composed Flow operations")).toHaveTextContent("Called Smuggler Route");
    expect(screen.getByLabelText("Composed Flow operations")).toHaveTextContent("Reached Patrol evaded");
  });

  it("keeps preparation facts actionable when no session can be created", () => {
    const onOpenSource = vi.fn();
    const fact = {
      fact_version: 1 as const,
      code: "missing_entry" as const,
      level: "error" as const,
      message: "Story Flow has no Playback entry.",
      action: "Choose one flow member as entry.",
      flow_id: "flow-main-story",
      node_id: null,
      transition_id: null,
      effect_id: null
    };
    render(
      <PlaybackWorkspace
        announcement=""
        busy={false}
        error={{ kind: "empty", message: "Choose an entry beat before starting Playback." }}
        flowName="Main Story"
        localFixture
        loading={false}
        node={null}
        nodeLabels={{}}
        onBack={vi.fn()}
        onChoose={vi.fn()}
        onExit={vi.fn()}
        onOpenSource={onOpenSource}
        onRestart={vi.fn()}
        onRetry={vi.fn()}
        preparationFacts={[fact]}
        session={null}
        transitionLabels={{}}
      />
    );

    expect(screen.getByLabelText("Playback preparation facts")).toHaveTextContent("missing entry");
    fireEvent.click(screen.getByRole("button", { name: "Open source" }));
    expect(onOpenSource).toHaveBeenCalledWith({ fact, kind: "fact" });
  });
});
