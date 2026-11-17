import type { PlaybackConditionResult } from "./contracts";

/**
 * Runtime-shaped Condition Language v1 results used by frontend presentation
 * tests. The frontend consumes these trees and intentionally has no evaluator.
 */
export const conditionResultFixtures: Record<"eligible" | "unknownQuest", PlaybackConditionResult> = {
  eligible: {
    condition_result_version: 1,
    expression: 'flags.route_open and "show_key" in dialogue.dialogue-gate.choices',
    status: "true",
    value: true,
    message: "AND condition evaluated to true.",
    diagnostic_code: null,
    children: [
      {
        condition_result_version: 1,
        expression: "flags.route_open",
        status: "true",
        value: true,
        message: "State path flags.route_open resolved to true.",
        diagnostic_code: null,
        children: []
      },
      {
        condition_result_version: 1,
        expression: '"show_key" in dialogue.dialogue-gate.choices',
        status: "true",
        value: true,
        message: "Membership in evaluated to true.",
        diagnostic_code: null,
        children: []
      }
    ]
  },
  unknownQuest: {
    condition_result_version: 1,
    expression: 'quests.quest-missing.status == "active"',
    status: "invalid",
    value: null,
    message: "Unknown playback state path: quests.quest-missing.status.",
    diagnostic_code: "unknown_condition_path",
    children: []
  }
};
