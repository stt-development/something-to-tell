import type {
  PlaybackEffectApplication,
  PlaybackState
} from "./contracts";

const INITIAL_STATE: PlaybackState = {
  state_version: 1,
  flags: {},
  inventory_node_ids: [],
  item_holders: {},
  quest_states: { "quest-citadel": "active" },
  dialogue_choice_ids: { "dialogue-gate": [] },
  visited_node_ids: ["dialogue-gate"],
  applied_effect_ids: []
};

/**
 * Runtime-shaped Effect Application v1 boundaries for future playback UI tests.
 * The frontend presents these records and intentionally does not apply effects.
 */
export const effectApplicationFixtures: Record<"applied" | "rejected", PlaybackEffectApplication> = {
  applied: {
    application_version: 1,
    success: true,
    state_before: INITIAL_STATE,
    state_after: {
      ...INITIAL_STATE,
      flags: { gate_open: true },
      inventory_node_ids: ["item-citadel-key"],
      applied_effect_ids: ["effect-gate", "effect-key"]
    },
    applied_effect_ids: ["effect-gate", "effect-key"],
    changes: [
      {
        state_change_version: 1,
        effect_id: "effect-gate",
        operation: "set_flag",
        path: "flags.gate_open",
        before: null,
        after: true,
        explanation: "Open the citadel gate."
      },
      {
        state_change_version: 1,
        effect_id: "effect-key",
        operation: "add_inventory",
        path: "inventory.item-citadel-key",
        before: false,
        after: true,
        explanation: "Give the citadel key."
      }
    ],
    facts: []
  },
  rejected: {
    application_version: 1,
    success: false,
    state_before: INITIAL_STATE,
    state_after: INITIAL_STATE,
    applied_effect_ids: [],
    changes: [],
    facts: [
      {
        fact_version: 1,
        code: "conflicting_effects",
        level: "error",
        message: "Effects write different values to 'flags.gate_open'.",
        action: "Keep one deterministic write for this state path.",
        flow_id: "flow-main",
        node_id: null,
        transition_id: "transition-choice",
        effect_id: "effect-clear"
      }
    ]
  }
};
