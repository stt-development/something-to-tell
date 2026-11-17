import type {
  PlaybackChoice,
  PlaybackConditionResult,
  PlaybackDialoguePath,
  PlaybackDialogueStep,
  PlaybackFact,
  PlaybackSession,
  PlaybackState,
  PlaybackStateChange,
  PlaybackStep,
  PlaybackTypedEffect
} from "../playback/contracts";

const FIXTURE_TIME = "2026-07-27T15:30:00Z";

export const PROJECT_AURORA_PLAYBACK_EFFECTS_BY_FLOW: Record<string, PlaybackTypedEffect[]> = {
  "flow-main-story": [
    {
      effect_version: 1,
      id: "playback-effect-acquire-ledger",
      project_id: "project-aurora",
      flow_id: "flow-main-story",
      owner_node_id: null,
      owner_transition_id: "flow-transition-opening-dialogue",
      review_status: "accepted",
      repeatable: false,
      explanation: "Carry the sealed ledger into the dockmaster exchange.",
      operation: "add_inventory",
      payload: { node_id: "node-sealed-ledger" }
    }
  ],
  "flow-smuggler-route": [
    {
      effect_version: 1,
      id: "playback-effect-complete-smuggler-route",
      project_id: "project-aurora",
      flow_id: "flow-smuggler-route",
      owner_node_id: null,
      owner_transition_id: "flow-transition-quest-blockade",
      review_status: "accepted",
      repeatable: true,
      explanation: "Complete the Smuggler Route after committing to the blockade.",
      operation: "set_quest_status",
      payload: {
        quest_node_id: "node-smuggler-route",
        status: "completed"
      }
    }
  ]
};

interface FixtureTransition {
  changes?: PlaybackStateChange[];
  targetNodeId: string;
}

const MAIN_TRANSITIONS: Record<string, FixtureTransition> = {
  "flow-transition-opening-dialogue": {
    targetNodeId: "node-dock-dialogue",
    changes: [
      change(
        "playback-effect-acquire-ledger",
        "add_inventory",
        "inventory.node-sealed-ledger",
        false,
        true,
        "Carry the sealed ledger into the dockmaster exchange."
      )
    ]
  },
  "flow-transition-dialogue-inspection": {
    targetNodeId: "node-inspection"
  },
  "flow-transition-dialogue-blockade": {
    targetNodeId: "node-mara-runs-blockade"
  },
  "flow-transition-inspection-route": {
    targetNodeId: "node-route-consequence"
  }
};

const SMUGGLER_TRANSITIONS: Record<string, FixtureTransition> = {
  "flow-transition-quest-blockade": {
    targetNodeId: "node-mara-runs-blockade",
    changes: [
      change(
        "playback-effect-complete-smuggler-route",
        "set_quest_status",
        "quests.node-smuggler-route.status",
        "inactive",
        "completed",
        "Complete the Smuggler Route after committing to the blockade."
      )
    ]
  },
  "flow-transition-blockade-return": {
    targetNodeId: "node-route-consequence"
  },
  "flow-transition-blockade-cycle": {
    targetNodeId: "node-smuggler-route"
  }
};

/** Starts only the documented Project Aurora offline visual fixture. */
export function startProjectAuroraPlayback(
  flowId: string,
  sourceRevision = `fixture:${flowId}:1`
): PlaybackSession | null {
  const entryNodeId = flowId === "flow-main-story"
    ? "node-opening"
    : flowId === "flow-smuggler-route"
      ? "node-smuggler-route"
      : null;
  if (!entryNodeId) return null;
  const state = initialState(flowId, entryNodeId);
  const step = fixtureStep(flowId, entryNodeId, state, null);
  return {
    session_version: 1,
    id: `local-fixture:${flowId}`,
    project_id: "project-aurora",
    flow_id: flowId,
    source_revision: sourceRevision,
    visit_threshold: 3,
    status: step.choices.length ? "active" : "ended",
    current_node_id: entryNodeId,
    state,
    dialogue_path: null,
    step,
    trace: [],
    facts: step.facts
  };
}

/** Advances one pre-authored fixture transition without evaluating project code. */
export function advanceProjectAuroraPlayback(
  session: PlaybackSession,
  choiceId: string
): PlaybackSession {
  const dialogueOption = session.step?.dialogue?.options.find(
    (option) => option.option_id === choiceId
  );
  if (dialogueOption) {
    return advanceFixtureDialogue(session, dialogueOption.option_id);
  }
  const transitionId = choiceId;
  const selected = session.step?.choices.find((choice) => choice.transition_id === transitionId);
  if (!selected?.eligible) {
    throw new Error(`Project Aurora fixture choice is not eligible: ${transitionId}`);
  }
  const transition = fixtureTransitions(session.flow_id)[transitionId];
  if (!transition || !session.current_node_id) {
    throw new Error(`Project Aurora fixture transition is not defined: ${transitionId}`);
  }
  const nextVisit = fixtureVisitCount(session, transition.targetNodeId) + 1;
  if (nextVisit > session.visit_threshold) {
    return {
      ...session,
      status: "blocked",
      facts: [{
        fact_version: 1,
        code: "visit_threshold",
        level: "error",
        message: `Choosing '${transitionId}' would visit '${transition.targetNodeId}' ${nextVisit} times, above threshold ${session.visit_threshold}.`,
        action: "Go back or restart Playback.",
        flow_id: session.flow_id,
        node_id: transition.targetNodeId,
        transition_id: transitionId,
        effect_id: null
      }]
    };
  }
  const stateBefore = cloneState(session.state);
  const stateAfter = cloneState(session.state);
  const changes = fixtureChangesForState(session.state, transition.changes ?? []);
  applyFixtureChanges(stateAfter, changes);
  if (!stateAfter.visited_node_ids.includes(transition.targetNodeId)) {
    stateAfter.visited_node_ids.push(transition.targetNodeId);
  }
  const appliedEffectIds = changes.map((item) => item.effect_id);
  appliedEffectIds.forEach((effectId) => {
    if (!stateAfter.applied_effect_ids.includes(effectId)) {
      stateAfter.applied_effect_ids.push(effectId);
    }
  });
  const nextDialoguePath = transition.targetNodeId === "node-dock-dialogue"
    ? { path_version: 1 as const, dialogue_node_id: transition.targetNodeId, option_ids: [] }
    : null;
  const nextStep = fixtureStep(
    session.flow_id,
    transition.targetNodeId,
    stateAfter,
    nextDialoguePath
  );
  return {
    ...session,
    status: nextStep.choices.length || nextStep.dialogue?.options.length ? "active" : "ended",
    current_node_id: transition.targetNodeId,
    state: stateAfter,
    dialogue_path: nextDialoguePath,
    step: nextStep,
    trace: [
      ...session.trace,
      {
        trace_version: 1,
        sequence: session.trace.length,
        node_id: session.current_node_id,
        transition_id: transitionId,
        dialogue_option_id: null,
        dialogue_path_before: session.dialogue_path ?? null,
        dialogue_path_after: null,
        condition_results: (session.step?.choices ?? []).flatMap((choice) =>
          choice.condition_result ? [choice.condition_result] : []
        ),
        applied_effect_ids: appliedEffectIds,
        state_changes: changes,
        state_before: stateBefore,
        state_after: cloneState(stateAfter),
        timestamp: FIXTURE_TIME
      }
    ],
    facts: nextStep.facts
  };
}

/** Restores the complete boundary recorded before the latest fixture choice. */
export function backProjectAuroraPlayback(session: PlaybackSession): PlaybackSession {
  const previous = session.trace.at(-1);
  if (!previous) return session;
  const step = fixtureStep(
    session.flow_id,
    previous.node_id,
    previous.state_before,
    previous.dialogue_path_before ?? null
  );
  return {
    ...session,
    status: step.choices.length || step.dialogue?.options.length ? "active" : "ended",
    current_node_id: previous.node_id,
    state: cloneState(previous.state_before),
    dialogue_path: previous.dialogue_path_before ?? null,
    step,
    trace: session.trace.slice(0, -1),
    facts: step.facts
  };
}

/** Restarts the fixed visual route at its deterministic entry boundary. */
export function restartProjectAuroraPlayback(
  session: PlaybackSession,
  sourceRevision = session.source_revision
): PlaybackSession {
  return startProjectAuroraPlayback(session.flow_id, sourceRevision) ?? session;
}

function fixtureStep(
  flowId: string,
  nodeId: string,
  state: PlaybackState,
  dialoguePath: PlaybackDialoguePath | null
): PlaybackStep {
  const dialogue = flowId === "flow-main-story" && nodeId === "node-dock-dialogue"
    ? fixtureDialogueStep(state, dialoguePath ?? {
        path_version: 1,
        dialogue_node_id: nodeId,
        option_ids: []
      })
    : null;
  const choices = fixtureChoices(flowId, nodeId, dialoguePath);
  const ending = choices.length === 0 && (!dialogue || dialogue.complete);
  return {
    step_version: 1,
    node_id: nodeId,
    node_kind: fixtureNodeKind(nodeId),
    title: fixtureTitle(nodeId),
    summary: "",
    dialogue,
    choices,
    facts: ending ? [endingFact(flowId, nodeId)] : []
  };
}

function fixtureChoices(
  flowId: string,
  nodeId: string,
  dialoguePath: PlaybackDialoguePath | null
): PlaybackChoice[] {
  if (flowId === "flow-main-story" && nodeId === "node-opening") {
    return [choice(
      "flow-transition-opening-dialogue",
      nodeId,
      "node-dock-dialogue",
      "next",
      "Begin inspection",
      0,
      true
    )];
  }
  if (flowId === "flow-main-story" && nodeId === "node-dock-dialogue") {
    const selected = dialoguePath?.option_ids.at(-1);
    if (!selected) return [];
    const result = trueCondition("inventory.node-sealed-ledger");
    if (selected === "answer-show-ledger") return [
      {
        ...choice(
          "flow-transition-dialogue-inspection",
          nodeId,
          "node-inspection",
          "branch",
          "Present the ledger",
          0,
          true
        ),
        condition: result.expression,
        condition_result: result,
        effect_ids: []
      }
    ];
    return [{
      ...choice(
        "flow-transition-dialogue-blockade",
        nodeId,
        "node-mara-runs-blockade",
        "branch",
        "Run the blockade",
        1,
        true
      ),
      is_default: true
    }];
  }
  if (flowId === "flow-main-story" && nodeId === "node-inspection") {
    return [choice(
      "flow-transition-inspection-route",
      nodeId,
      "node-route-consequence",
      "next",
      "Embargo disproved",
      0,
      true
    )];
  }
  if (flowId === "flow-smuggler-route" && nodeId === "node-smuggler-route") {
    return [choice(
      "flow-transition-quest-blockade",
      nodeId,
      "node-mara-runs-blockade",
      "optional",
      "Take the covert route",
      0,
      true
    )];
  }
  if (flowId === "flow-smuggler-route" && nodeId === "node-mara-runs-blockade") {
    return [
      choice(
        "flow-transition-blockade-return",
        nodeId,
        "node-route-consequence",
        "return",
        "Rejoin the harbor outcome",
        0,
        true
      ),
      choice(
        "flow-transition-blockade-cycle",
        nodeId,
        "node-smuggler-route",
        "return",
        "Circle back past the patrol",
        1,
        true
      )
    ];
  }
  return [];
}

function advanceFixtureDialogue(
  session: PlaybackSession,
  optionId: string
): PlaybackSession {
  if (!session.current_node_id || !session.dialogue_path) return session;
  const stateBefore = cloneState(session.state);
  const stateAfter = cloneState(session.state);
  const recorded = stateAfter.dialogue_choice_ids[session.current_node_id] ?? [];
  if (!recorded.includes(optionId)) recorded.push(optionId);
  stateAfter.dialogue_choice_ids[session.current_node_id] = recorded;
  const nextPath: PlaybackDialoguePath = {
    ...session.dialogue_path,
    option_ids: [...session.dialogue_path.option_ids, optionId]
  };
  const nextStep = fixtureStep(
    session.flow_id,
    session.current_node_id,
    stateAfter,
    nextPath
  );
  return {
    ...session,
    status: nextStep.choices.length || nextStep.dialogue?.options.length ? "active" : "ended",
    state: stateAfter,
    dialogue_path: nextPath,
    step: nextStep,
    trace: [
      ...session.trace,
      {
        trace_version: 1,
        sequence: session.trace.length,
        node_id: session.current_node_id,
        transition_id: null,
        dialogue_option_id: optionId,
        dialogue_path_before: session.dialogue_path,
        dialogue_path_after: nextPath,
        condition_results: [],
        applied_effect_ids: [],
        state_changes: [],
        state_before: stateBefore,
        state_after: cloneState(stateAfter),
        timestamp: FIXTURE_TIME
      }
    ],
    facts: nextStep.facts
  };
}

function fixtureDialogueStep(
  state: PlaybackState,
  path: PlaybackDialoguePath
): PlaybackDialogueStep {
  const turns: PlaybackDialogueStep["turns"] = [
    {
      line_version: 1,
      element_id: "line-dockmaster-warning",
      speaker_node_id: "node-dockmaster",
      text: "No vessel leaves Glass Harbor while the silver embargo is in force."
    },
    {
      line_version: 1,
      element_id: "line-mara-challenge",
      speaker_node_id: "node-hero",
      text: "Your guild forged that order. I can prove it or sail through it."
    }
  ];
  const selected = path.option_ids.at(-1);
  if (!selected) {
    const ledgerAvailable = state.inventory_node_ids.includes("node-sealed-ledger");
    return {
      dialogue_step_version: 1,
      dialogue_node_id: path.dialogue_node_id,
      prompt: "How does Mara answer the dockmaster?",
      turns,
      options: [
        {
          option_version: 1,
          choice_element_id: "choice-mara-response",
          option_id: "answer-show-ledger",
          text: "Show Ilya the sealed ledger.",
          condition: "inventory.node-sealed-ledger",
          eligible: ledgerAvailable,
          disabled_reason: ledgerAvailable ? null : "The sealed ledger is not in inventory.",
          condition_result: ledgerAvailable
            ? trueCondition("inventory.node-sealed-ledger")
            : {
                ...trueCondition("inventory.node-sealed-ledger"),
                status: "false",
                value: false,
                message: "State path inventory.node-sealed-ledger resolved to false."
              }
        },
        {
          option_version: 1,
          choice_element_id: "choice-mara-response",
          option_id: "answer-run-blockade",
          text: "Order the crew to run the blockade.",
          condition: "",
          eligible: true,
          disabled_reason: null,
          condition_result: null
        }
      ],
      complete: false,
      outcome_element_id: null
    };
  }
  const showLedger = selected === "answer-show-ledger";
  turns.push(
    {
      selection_version: 1,
      choice_element_id: "choice-mara-response",
      option_id: selected,
      text: showLedger
        ? "Show Ilya the sealed ledger."
        : "Order the crew to run the blockade."
    },
    {
      line_version: 1,
      element_id: showLedger ? "line-ilya-concedes" : "line-mara-orders-run",
      speaker_node_id: showLedger ? "node-dockmaster" : "node-hero",
      text: showLedger
        ? "Those seals are genuine. I will delay the patrol while you depart."
        : "Cast off. Full power, and keep the inspection boats in our wake."
    }
  );
  return {
    dialogue_step_version: 1,
    dialogue_node_id: path.dialogue_node_id,
    prompt: "",
    turns,
    options: [],
    complete: true,
    outcome_element_id: showLedger ? "line-ilya-concedes" : "line-mara-orders-run"
  };
}

function choice(
  transitionId: string,
  sourceNodeId: string,
  targetNodeId: string,
  kind: PlaybackChoice["kind"],
  label: string,
  priority: number,
  eligible: boolean
): PlaybackChoice {
  return {
    choice_version: 1,
    transition_id: transitionId,
    source_node_id: sourceNodeId,
    target_node_id: targetNodeId,
    kind,
    label,
    condition: "",
    priority,
    is_default: false,
    eligible,
    disabled_reason: eligible ? null : "Choice is unavailable.",
    condition_result: null,
    effect_ids: transitionId === "flow-transition-opening-dialogue"
      ? ["playback-effect-acquire-ledger"]
      : []
  };
}

function trueCondition(expression: string): PlaybackConditionResult {
  return {
    condition_result_version: 1,
    expression,
    status: "true",
    value: true,
    message: `State path ${expression} resolved to true.`,
    diagnostic_code: null,
    children: []
  };
}

function endingFact(flowId: string, nodeId: string): PlaybackFact {
  return {
    fact_version: 1,
    code: "ending_reached",
    level: "info",
    message: "This route has reached an authored ending.",
    action: "Exit Playback or return to authoring.",
    flow_id: flowId,
    node_id: nodeId,
    transition_id: null,
    effect_id: null
  };
}

function initialState(flowId: string, entryNodeId: string): PlaybackState {
  return {
    state_version: 1,
    flags: {},
    inventory_node_ids: [],
    item_holders: {},
    quest_states: flowId === "flow-smuggler-route"
      ? { "node-smuggler-route": "inactive" }
      : {},
    dialogue_choice_ids: flowId === "flow-main-story"
      ? { "node-dock-dialogue": [] }
      : {},
    visited_node_ids: [entryNodeId],
    applied_effect_ids: []
  };
}

function applyFixtureChanges(
  state: PlaybackState,
  changes: PlaybackStateChange[]
) {
  changes.forEach((item) => {
    if (item.operation === "add_inventory" && typeof item.after === "boolean" && item.after) {
      const nodeId = item.path.replace("inventory.", "");
      if (!state.inventory_node_ids.includes(nodeId)) state.inventory_node_ids.push(nodeId);
    }
    if (item.operation === "record_dialogue_choice" && Array.isArray(item.after)) {
      state.dialogue_choice_ids["node-dock-dialogue"] = [...item.after];
    }
    if (item.operation === "set_quest_status" && typeof item.after === "string") {
      state.quest_states["node-smuggler-route"] = item.after as PlaybackState["quest_states"][string];
    }
  });
}

function fixtureChangesForState(
  state: PlaybackState,
  changes: PlaybackStateChange[]
): PlaybackStateChange[] {
  return changes.map((item) => {
    if (item.operation === "set_quest_status") {
      return {
        ...item,
        before: state.quest_states["node-smuggler-route"] ?? null
      };
    }
    return { ...item };
  });
}

function fixtureTransitions(flowId: string): Record<string, FixtureTransition> {
  return flowId === "flow-main-story" ? MAIN_TRANSITIONS : SMUGGLER_TRANSITIONS;
}

function fixtureVisitCount(session: PlaybackSession, nodeId: string): number {
  const entryNodeId = session.flow_id === "flow-main-story" ? "node-opening" : "node-smuggler-route";
  return (entryNodeId === nodeId ? 1 : 0) + session.trace.filter((entry) => {
    if (!entry.transition_id) return false;
    return fixtureTransitions(session.flow_id)[entry.transition_id]?.targetNodeId === nodeId;
  }).length;
}

function cloneState(state: PlaybackState): PlaybackState {
  return {
    ...state,
    flags: { ...state.flags },
    inventory_node_ids: [...state.inventory_node_ids],
    quest_states: { ...state.quest_states },
    dialogue_choice_ids: Object.fromEntries(
      Object.entries(state.dialogue_choice_ids).map(([key, value]) => [key, [...value]])
    ),
    visited_node_ids: [...state.visited_node_ids],
    applied_effect_ids: [...state.applied_effect_ids]
  };
}

function change(
  effectId: string,
  operation: PlaybackStateChange["operation"],
  path: string,
  before: PlaybackStateChange["before"],
  after: PlaybackStateChange["after"],
  explanation: string
): PlaybackStateChange {
  return {
    state_change_version: 1,
    effect_id: effectId,
    operation,
    path,
    before,
    after,
    explanation
  };
}

function fixtureNodeKind(nodeId: string): string {
  return {
    "node-opening": "Scene",
    "node-dock-dialogue": "Dialogue",
    "node-inspection": "Event",
    "node-route-consequence": "Consequence",
    "node-mara-runs-blockade": "Event",
    "node-smuggler-route": "Quest"
  }[nodeId] ?? "Event";
}

function fixtureTitle(nodeId: string): string {
  return {
    "node-opening": "Opening Dock",
    "node-dock-dialogue": "Dockmaster Warning",
    "node-inspection": "Harbor Inspection",
    "node-route-consequence": "Route Reopened",
    "node-mara-runs-blockade": "Run the Blockade",
    "node-smuggler-route": "Smuggler Route"
  }[nodeId] ?? nodeId;
}
