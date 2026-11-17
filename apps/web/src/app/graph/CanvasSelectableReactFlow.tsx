import type { Edge, Node, ReactFlowProps } from "@xyflow/react";
import { useLayoutEffect, useMemo, useRef, useState } from "react";
import { flushSync } from "react-dom";
import { CanvasDomReactFlow } from "./CanvasDomReactFlow";
import { projectTargetSelectable } from "./targetSelectionProjection";

// Approved P9.1 release default; conservative legacy fallback and Off remain available.
export const TARGET_SELECTABLE_EXPERIMENT_ENABLED = true;
type Target = { kind: "node" | "edge" | "unknown"; id: string } | null;
const emptyInput = { target: null as Target, shift: false };
type Props<N extends Node, E extends Edge> = ReactFlowProps<N, E> & {
  domVirtualizationSuspended?: boolean;
  selectionExperimentEnabled?: boolean;
  selectionControlInteractive?: boolean;
  selectionScopeKey?: string;
};

function targetOwner(target: EventTarget | null): Target {
  if (!(target instanceof Element)) return null;
  const wrapper = target.closest(".react-flow__node,.react-flow__edge");
  if (!wrapper) return null;
  const id = wrapper.getAttribute("data-id");
  return id ? { kind: wrapper.classList.contains("react-flow__node") ? "node" : "edge", id }
    : { kind: "unknown", id: "" };
}

/** Capture actual input targets before RF mutates selection; never intercept Escape/Space. */
export function CanvasSelectableReactFlow<N extends Node, E extends Edge>({
  selectionExperimentEnabled = TARGET_SELECTABLE_EXPERIMENT_ENABLED,
  selectionControlInteractive = true, selectionScopeKey, ...props
}: Props<N, E>) {
  const supportedKey = props.selectionKeyCode === undefined || props.selectionKeyCode === null || props.selectionKeyCode === "Shift";
  const active = Boolean(selectionExperimentEnabled && props.nodes && props.edges && supportedKey);
  const [input, setInput] = useState(emptyInput);
  const committedInput = useRef(input);
  useLayoutEffect(() => { committedInput.current = input; }, [input]);
  useLayoutEffect(() => { setInput(emptyInput); }, [active, selectionScopeKey]);
  const owner = input.target;
  const prevent = props.elementsSelectable === false;
  const nodes = useMemo(() => projectTargetSelectable(props.nodes,
    active && owner?.kind === "node" ? owner.id : null, prevent), [active, owner, props.nodes, prevent]);
  const edges = useMemo(() => projectTargetSelectable(props.edges,
    active && owner?.kind === "edge" ? owner.id : null, prevent), [active, owner, props.edges, prevent]);
  const known = owner?.kind !== "unknown" && nodes.known && edges.known;
  const legacy = !known || (props.selectionKeyCode !== null && input.shift);
  const publish = (target: EventTarget | null, immediate: boolean, shift?: boolean) => {
    const next = targetOwner(target), previous = committedInput.current;
    const nextShift = shift ?? previous.shift;
    if (next?.kind === previous.target?.kind && next?.id === previous.target?.id && nextShift === previous.shift) return;
    // Only discrete input needs synchronous adoption before its RF bubble handler.
    // Focus/blur may originate inside an existing layout effect: never flush there.
    const nextInput = { target: next, shift: nextShift };
    if (immediate) flushSync(() => setInput(nextInput)); else setInput(nextInput);
  };
  return <CanvasDomReactFlow {...props} nodes={nodes.rows} edges={edges.rows}
    elementsSelectable={active ? selectionControlInteractive && (legacy ? props.elementsSelectable !== false : true) : props.elementsSelectable}
    onFocusCapture={active ? event => { publish(event.target, false); props.onFocusCapture?.(event); } : props.onFocusCapture}
    onBlurCapture={active ? event => { publish(event.relatedTarget, false); props.onBlurCapture?.(event); } : props.onBlurCapture}
    onPointerDownCapture={active ? event => { publish(event.target, true, event.shiftKey); props.onPointerDownCapture?.(event); } : props.onPointerDownCapture}
    onMouseDownCapture={active ? event => { publish(event.target, true, event.shiftKey); props.onMouseDownCapture?.(event); } : props.onMouseDownCapture}
    onTouchStartCapture={active ? event => { publish(event.target, true, event.shiftKey); props.onTouchStartCapture?.(event); } : props.onTouchStartCapture}
    onClickCapture={active ? event => { publish(event.target, true, event.shiftKey); props.onClickCapture?.(event); } : props.onClickCapture}
    onKeyDownCapture={active ? event => { publish(event.target, true, event.key === "Shift" || event.shiftKey); props.onKeyDownCapture?.(event); } : props.onKeyDownCapture}
    onKeyUpCapture={active ? event => { publish(event.target, true, event.key !== "Shift" && event.shiftKey); props.onKeyUpCapture?.(event); } : props.onKeyUpCapture}
  />;
}
