import { useLayoutEffect, useState, type KeyboardEvent } from "react";

// Approved P9.1 release default; retain the literal gate for tested Off rollback.
export const STABLE_TOOL_INTERACTION_EXPERIMENT_ENABLED = true;

/** Reflect only the native Controls callback; ordinary mode changes retire its override. */
export function useExperimentalToolInteractivity(mode: string, enabled = STABLE_TOOL_INTERACTION_EXPERIMENT_ENABLED) {
  const [interactive, setInteractive] = useState(true);
  useLayoutEffect(() => {
    if (enabled) setInteractive(true);
  }, [mode, enabled]);
  return enabled
    ? { interactive, onInteractiveChange: setInteractive } : null;
}

/** Hand may not move a focused graph element; existing Escape/Space owners still run. */
export function blockHandNodeArrow(event: KeyboardEvent<HTMLDivElement>) {
  const target = event.target;
  if (!(target instanceof Element) || !["ArrowLeft", "ArrowRight", "ArrowUp", "ArrowDown"].includes(event.key)
    || target.closest("input,textarea,select,[contenteditable]:not([contenteditable=false])")
    || !target.closest(".react-flow__node,.react-flow__edge")) return;
  event.preventDefault();
  event.stopPropagation();
}
