import type { FlowTransition } from "./contracts";

/** Invocation-local explicit transitions in raw order, including parallel/duplicate records. */
export function buildIncomingTransitionLookup(
  transitions: readonly FlowTransition[]
): ReadonlyMap<string, readonly FlowTransition[]> {
  const incoming = new Map<string, FlowTransition[]>();
  for (const transition of transitions) {
    const targetId = transition.target_node_id;
    let group = incoming.get(targetId);
    if (!group) {
      group = [];
      incoming.set(targetId, group);
    }
    group.push(transition);
  }
  return incoming;
}
