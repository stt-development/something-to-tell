import { beforeEach, describe, expect, it } from "vitest";
import { useGraphStore } from "../state/graphStore";
import { loadProjectFixturesForTests, projectFixture } from "../testFixtures/projectFixtures";
import { buildPlaybackPrepareCommand, narrativeOwnerForPlaybackEffect } from "./prepare";
import type { NarrativeStateSnapshot } from "../narrative-state/contracts";
import type { PlaybackTypedEffect } from "./contracts";

const fixture = projectFixture("aurora");
const PROJECT_AURORA_STORY_FLOWS = fixture.storyFlows;
const PROJECT_AURORA_PLAYBACK_EFFECTS_BY_FLOW = fixture.effectsByFlow;
const PROJECT_AURORA_NARRATIVE_STATE = narrativeStateFixture();

describe("buildPlaybackPrepareCommand", () => {
  beforeEach(() => {
    useGraphStore.setState(useGraphStore.getInitialState(), true);
    loadProjectFixturesForTests();
  });

  it("removes storage-only Story Flow fields before runtime validation", () => {
    expect(PROJECT_AURORA_STORY_FLOWS[0]!.flow).not.toHaveProperty("normalized_name");
  });

  it("projects only canonical flow members and their typed documents", () => {
    const snapshot = structuredClone(PROJECT_AURORA_STORY_FLOWS[0]!);
    const nodes = useGraphStore.getState().graphs["project-aurora"]!.nodes;
    const command = buildPlaybackPrepareCommand(
      snapshot,
      nodes,
      [],
      [snapshot],
      PROJECT_AURORA_NARRATIVE_STATE
    );

    expect(command.source_revision).toMatch(/^flow-main-story:[0-9a-f]{16}$/);
    expect(command.canonical_nodes.slice(0, snapshot.nodes.length).map((node) => node.id)).toEqual(snapshot.nodes.map((member) => member.node_id));
    expect(command.canonical_nodes.slice(snapshot.nodes.length).map((node) => node.id)).toEqual([
      "node-dockmaster",
      "node-smuggler-route",
      "node-hero"
    ]);
    expect(command.canonical_nodes.length).toBeGreaterThanOrEqual(5);
    expect(command.dialogue_documents["node-dock-dialogue"]?.participants).toHaveLength(2);
    expect(command.quest_documents["node-smuggler-route"]?.reward_node_ids).toEqual(["node-sealed-ledger"]);
    expect(command.typed_effects.map((effect) => effect.id)).toEqual([
      "binding-01-dialogue-ledger-to-mara"
    ]);
    expect(command.initial_state.item_holders["node-sealed-ledger"]?.node_id).toBe("node-dockmaster");
  });

  it("prefers a canonical root over linked visual instances", () => {
    const snapshot = structuredClone(PROJECT_AURORA_STORY_FLOWS[0]!);
    const nodes = useGraphStore.getState().graphs["project-aurora"]!.nodes;
    const command = buildPlaybackPrepareCommand(snapshot, nodes);

    expect(command.canonical_nodes.find((node) => node.id === "node-dock-dialogue")).toMatchObject({
      title: "Dockmaster Warning",
      type: "Dialogue"
    });
    expect(command.canonical_nodes.filter((node) => node.id === "node-dock-dialogue")).toHaveLength(1);
  });

  it("projects the reachable call graph and includes side-flow effects in the revision", () => {
    const flows = structuredClone(PROJECT_AURORA_STORY_FLOWS);
    const nodes = structuredClone(useGraphStore.getState().graphs["project-aurora"]!.nodes);
    const effects: PlaybackTypedEffect[] = [];

    const command = buildPlaybackPrepareCommand(flows[0]!, nodes, effects, flows, PROJECT_AURORA_NARRATIVE_STATE);

    expect(command.snapshots?.map((snapshot) => snapshot.flow.id)).toEqual([
      "flow-main-story",
      "flow-z-blockade-outcome",
      "flow-smuggler-route"
    ]);
    expect(command.canonical_nodes.map((node) => node.id)).toContain("node-smuggler-route");
    expect(command.quest_documents["node-smuggler-route"]).toBeDefined();
    expect(command.typed_effects.map((effect) => effect.id)).toEqual([
      "binding-01-dialogue-ledger-to-mara",
      "binding-02-quest-complete",
      "binding-04-exit-ledger-to-player",
      "binding-03-quest-reward"
    ]);
    const initialRevision = command.source_revision;
    nodes.find((node) => node.id === "node-smuggler-route")!.data.summary = "Changed side-flow source.";
    expect(buildPlaybackPrepareCommand(flows[0]!, nodes, effects, flows).source_revision).not.toBe(initialRevision);
  });

  it("projects authored bindings with exact temporal owners and application order", () => {
    const flows = structuredClone(PROJECT_AURORA_STORY_FLOWS);
    const nodes = useGraphStore.getState().graphs["project-aurora"]!.nodes;
    const transition = flows[0]!.transitions[0]!;
    const invocation = flows.flatMap((flow) => flow.invocations ?? [])[0]!;
    const timestamp = "2026-08-07T12:00:00Z";
    const narrativeState: NarrativeStateSnapshot = {
      project_id: "project-aurora",
      initial_states: [],
      effects: [
        { effect_version: 1, id: "authored-flag", project_id: "project-aurora", repeat_policy: "once", explanation: "Remember the route.", operation: "set_flag", payload: { flag: "route_seen" } },
        { effect_version: 1, id: "authored-call", project_id: "project-aurora", repeat_policy: "per_visit", explanation: "Remember the call.", operation: "set_flag", payload: { flag: "side_flow_called" } }
      ],
      bindings: [
        { binding_version: 1, id: "binding-late", project_id: "project-aurora", effect_id: "authored-flag", owner: { owner_version: 1, owner_kind: "flow_transition", owner_id: transition.id }, application_order: 4, created_at: timestamp, updated_at: timestamp },
        { binding_version: 1, id: "binding-call", project_id: "project-aurora", effect_id: "authored-call", owner: { owner_version: 1, owner_kind: "flow_invocation", owner_id: invocation.id }, application_order: 1, created_at: timestamp, updated_at: timestamp }
      ],
      integrity: { project_id: "project-aurora", facts: [] }
    };

    const command = buildPlaybackPrepareCommand(flows[0]!, nodes, [], flows, narrativeState);

    expect(command.typed_effects).toEqual(expect.arrayContaining([
      expect.objectContaining({ id: "binding-late", authored_effect_id: "authored-flag", owner_kind: "flow_transition", owner_id: transition.id, application_order: 4 }),
      expect.objectContaining({ id: "binding-call", authored_effect_id: "authored-call", owner_kind: "flow_invocation", owner_id: invocation.id, application_order: 1, repeatable: true })
    ]));
    expect(command.typed_effects.map((effect) => effect.id)).toEqual(["binding-call", "binding-late"]);
    expect(command.typed_effects[0]).toMatchObject({ explanation: "Remember the call." });
    expect(command.typed_effects[0]).not.toHaveProperty("repeat_policy");
    expect(command.typed_effects[0]).not.toHaveProperty("created_at");
  });

  it("projects Dialogue and Quest owners into their canonical Flow context", () => {
    const flows = structuredClone(PROJECT_AURORA_STORY_FLOWS);
    const nodes = useGraphStore.getState().graphs["project-aurora"]!.nodes;
    const timestamp = "2026-08-07T12:00:00Z";
    const narrativeState: NarrativeStateSnapshot = {
      project_id: "project-aurora",
      initial_states: [],
      effects: [
        { effect_version: 1, id: "effect-dialogue", project_id: "project-aurora", repeat_policy: "once", explanation: "Resolve the reply.", operation: "set_flag", payload: { flag: "dialogue_resolved" } },
        { effect_version: 1, id: "effect-quest", project_id: "project-aurora", repeat_policy: "once", explanation: "Complete the route.", operation: "set_quest_status", payload: { quest_node_id: "node-smuggler-route", status: "completed" } }
      ],
      bindings: [
        { binding_version: 1, id: "binding-dialogue", project_id: "project-aurora", effect_id: "effect-dialogue", owner: { owner_version: 1, owner_kind: "dialogue_element", owner_id: "line-ilya-concedes", context_node_id: "node-dock-dialogue" }, application_order: 0, created_at: timestamp, updated_at: timestamp },
        { binding_version: 1, id: "binding-quest", project_id: "project-aurora", effect_id: "effect-quest", owner: { owner_version: 1, owner_kind: "quest_outcome", owner_id: "branch-blockade-route", context_node_id: "node-smuggler-route" }, application_order: 0, created_at: timestamp, updated_at: timestamp }
      ],
      integrity: { project_id: "project-aurora", facts: [] }
    };

    const command = buildPlaybackPrepareCommand(flows[0]!, nodes, [], flows, narrativeState);

    expect(command.typed_effects).toEqual(expect.arrayContaining([
      expect.objectContaining({ id: "binding-dialogue", flow_id: "flow-main-story", owner_node_id: "node-dock-dialogue", owner_transition_id: null, owner_kind: "dialogue_element", context_node_id: "node-dock-dialogue" }),
      expect.objectContaining({ id: "binding-quest", flow_id: "flow-smuggler-route", owner_node_id: "node-smuggler-route", owner_transition_id: null, owner_kind: "quest_outcome", context_node_id: "node-smuggler-route" })
    ]));
    expect(narrativeOwnerForPlaybackEffect(narrativeState, "binding-quest")).toEqual(
      narrativeState.bindings[1]!.owner
    );
    expect(narrativeOwnerForPlaybackEffect(narrativeState, "binding-quest:flow-smuggler-route")).toEqual(
      narrativeState.bindings[1]!.owner
    );
    expect(narrativeOwnerForPlaybackEffect(narrativeState, "binding-missing")).toBeNull();
  });

  it("changes revision for canonical and specialized content but stays deterministic", () => {
    const snapshot = structuredClone(PROJECT_AURORA_STORY_FLOWS[0]!);
    const nodes = structuredClone(useGraphStore.getState().graphs["project-aurora"]!.nodes);
    const initial = buildPlaybackPrepareCommand(snapshot, nodes);
    const repeated = buildPlaybackPrepareCommand(structuredClone(snapshot), structuredClone(nodes));

    expect(repeated.source_revision).toBe(initial.source_revision);
    nodes.find((node) => node.id === "node-opening")!.data.summary = "Revised opening.";
    const canonicalRevision = buildPlaybackPrepareCommand(snapshot, nodes).source_revision;
    expect(canonicalRevision).not.toBe(initial.source_revision);
    const firstDialogueElement = nodes.find((node) => node.id === "node-dock-dialogue")!
      .data.dialogueDocument!.elements[0]!;
    if (firstDialogueElement.kind !== "line") throw new Error("Expected Project Aurora dialogue line.");
    nodes.find((node) => node.id === "node-dock-dialogue")!.data.dialogueDocument!.elements[0] = {
      ...firstDialogueElement,
      text: "Revised line."
    };
    expect(buildPlaybackPrepareCommand(snapshot, nodes).source_revision).not.toBe(canonicalRevision);
  });
});

/** Mirrors the public narrative-state API projection for the source fixture. */
function narrativeStateFixture(): NarrativeStateSnapshot {
  const document = fixture.response.document;
  return {
    project_id: "project-aurora",
    initial_states: structuredClone(document.flow_initial_states) as unknown as NarrativeStateSnapshot["initial_states"],
    effects: structuredClone(document.narrative_effects) as unknown as NarrativeStateSnapshot["effects"],
    bindings: document.narrative_effect_bindings.map((binding) => ({
      binding_version: binding.binding_version,
      id: binding.id,
      project_id: binding.project_id,
      effect_id: binding.effect_id,
      owner: {
        owner_version: 1,
        owner_kind: binding.owner_kind,
        owner_id: binding.owner_id,
        ...(binding.context_node_id ? { context_node_id: binding.context_node_id } : {})
      } as NarrativeStateSnapshot["bindings"][number]["owner"],
      application_order: binding.application_order,
      created_at: binding.created_at,
      updated_at: binding.updated_at
    })),
    integrity: { project_id: "project-aurora", facts: [] }
  };
}
