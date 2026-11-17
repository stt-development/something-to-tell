import { describe, expect, it } from "vitest";
import {
  advanceProjectAuroraPlayback,
  backProjectAuroraPlayback,
  restartProjectAuroraPlayback,
  startProjectAuroraPlayback
} from "../testFixtures/projectAuroraPlayback";

describe("Project Aurora playback fixture", () => {
  it("plays the main branch through an internal Dialogue reply", () => {
    const opening = startProjectAuroraPlayback("flow-main-story")!;
    const dialogue = advanceProjectAuroraPlayback(opening, "flow-transition-opening-dialogue");

    expect(dialogue.current_node_id).toBe("node-dock-dialogue");
    expect(dialogue.state.inventory_node_ids).toEqual(["node-sealed-ledger"]);
    expect(dialogue.trace.at(-1)?.state_changes[0]?.explanation).toContain("sealed ledger");
    expect(dialogue.step?.choices).toEqual([]);
    expect(dialogue.step?.dialogue?.options.map((option) => option.option_id)).toEqual([
      "answer-show-ledger",
      "answer-run-blockade"
    ]);

    const answered = advanceProjectAuroraPlayback(dialogue, "answer-show-ledger");
    expect(answered.step?.dialogue).toMatchObject({
      complete: true,
      outcome_element_id: "line-ilya-concedes"
    });
    expect(answered.step?.choices.map((choice) => choice.transition_id)).toEqual([
      "flow-transition-dialogue-inspection"
    ]);

    const inspection = advanceProjectAuroraPlayback(answered, "flow-transition-dialogue-inspection");
    const ending = advanceProjectAuroraPlayback(inspection, "flow-transition-inspection-route");
    expect(ending.status).toBe("ended");
    expect(ending.current_node_id).toBe("node-route-consequence");
    expect(ending.state.dialogue_choice_ids["node-dock-dialogue"]).toEqual(["answer-show-ledger"]);
    expect(ending.facts[0]?.code).toBe("ending_reached");
  });

  it("plays the linear smuggler route to its ending", () => {
    const quest = startProjectAuroraPlayback("flow-smuggler-route")!;
    const event = advanceProjectAuroraPlayback(quest, "flow-transition-quest-blockade");
    const ending = advanceProjectAuroraPlayback(event, "flow-transition-blockade-return");

    expect(quest.step?.node_kind).toBe("Quest");
    expect(event.current_node_id).toBe("node-mara-runs-blockade");
    expect(event.state.quest_states["node-smuggler-route"]).toBe("completed");
    expect(event.trace[0]?.state_changes[0]?.operation).toBe("set_quest_status");
    expect(ending.status).toBe("ended");
  });

  it("keeps the default Flow exit selectable after choosing its Dialogue reply", () => {
    const opening = startProjectAuroraPlayback("flow-main-story")!;
    const dialogue = advanceProjectAuroraPlayback(opening, "flow-transition-opening-dialogue");

    const answered = advanceProjectAuroraPlayback(dialogue, "answer-run-blockade");
    expect(answered.step?.choices[0]).toMatchObject({
      transition_id: "flow-transition-dialogue-blockade",
      eligible: true,
      is_default: true
    });
    expect(advanceProjectAuroraPlayback(
      answered,
      "flow-transition-dialogue-blockade"
    ).current_node_id).toBe("node-mara-runs-blockade");
    expect(startProjectAuroraPlayback("flow-unknown")).toBeNull();
  });

  it("restores complete boundaries across repeated back and restart commands", () => {
    const opening = startProjectAuroraPlayback("flow-main-story")!;
    const dialogue = advanceProjectAuroraPlayback(opening, "flow-transition-opening-dialogue");
    const answered = advanceProjectAuroraPlayback(dialogue, "answer-show-ledger");
    const inspection = advanceProjectAuroraPlayback(answered, "flow-transition-dialogue-inspection");

    const backToDialogue = backProjectAuroraPlayback(inspection);
    expect(backToDialogue.current_node_id).toBe("node-dock-dialogue");
    expect(backToDialogue.trace).toHaveLength(2);
    expect(backToDialogue.state.dialogue_choice_ids["node-dock-dialogue"]).toEqual(["answer-show-ledger"]);
    expect(backToDialogue.state.inventory_node_ids).toEqual(["node-sealed-ledger"]);

    const backToChoice = backProjectAuroraPlayback(backToDialogue);
    expect(backToChoice.step?.dialogue?.complete).toBe(false);
    expect(backToChoice.state.dialogue_choice_ids["node-dock-dialogue"]).toEqual([]);

    const backToOpening = backProjectAuroraPlayback(backToChoice);
    expect(backToOpening.current_node_id).toBe("node-opening");
    expect(backToOpening.trace).toEqual([]);
    expect(backToOpening.state.inventory_node_ids).toEqual([]);
    expect(backProjectAuroraPlayback(backToOpening)).toBe(backToOpening);

    const replayedDialogue = advanceProjectAuroraPlayback(backToOpening, "flow-transition-opening-dialogue");
    expect(replayedDialogue.trace).toHaveLength(1);
    expect(restartProjectAuroraPlayback(replayedDialogue)).toMatchObject({
      current_node_id: "node-opening",
      status: "active",
      trace: []
    });
  });

  it("blocks the authored Smuggler Route return cycle at its visit threshold", () => {
    let session = startProjectAuroraPlayback("flow-smuggler-route")!;
    for (let visit = 0; visit < 3; visit += 1) {
      session = advanceProjectAuroraPlayback(session, "flow-transition-quest-blockade");
      if (visit < 2) {
        session = advanceProjectAuroraPlayback(session, "flow-transition-blockade-cycle");
      }
    }

    const blocked = advanceProjectAuroraPlayback(session, "flow-transition-blockade-cycle");
    expect(blocked.status).toBe("blocked");
    expect(blocked.trace).toHaveLength(5);
    expect(blocked.facts[0]).toMatchObject({
      code: "visit_threshold",
      node_id: "node-smuggler-route",
      transition_id: "flow-transition-blockade-cycle"
    });
  });

  it("repeats the same immutable Project Aurora revision deterministically", () => {
    const playMainRoute = () => {
      let session = startProjectAuroraPlayback("flow-main-story", "fixture:verified-revision")!;
      session = advanceProjectAuroraPlayback(session, "flow-transition-opening-dialogue");
      session = advanceProjectAuroraPlayback(session, "answer-show-ledger");
      session = advanceProjectAuroraPlayback(session, "flow-transition-dialogue-inspection");
      return advanceProjectAuroraPlayback(session, "flow-transition-inspection-route");
    };

    const first = playMainRoute();
    const second = playMainRoute();
    const replayedAfterRestart = (() => {
      let session = restartProjectAuroraPlayback(first, "fixture:verified-revision");
      session = advanceProjectAuroraPlayback(session, "flow-transition-opening-dialogue");
      session = advanceProjectAuroraPlayback(session, "answer-show-ledger");
      session = advanceProjectAuroraPlayback(session, "flow-transition-dialogue-inspection");
      return advanceProjectAuroraPlayback(session, "flow-transition-inspection-route");
    })();

    expect(second).toEqual(first);
    expect(replayedAfterRestart).toEqual(first);
  });
});
