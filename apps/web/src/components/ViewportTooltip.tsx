import { useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";

type TooltipSide = "bottom" | "left" | "right" | "top";

interface ActiveTooltip {
  side: TooltipSide;
  target: HTMLElement;
  text: string;
}

interface TooltipPosition {
  left: number;
  top: number;
  visible: boolean;
}

const TOOLTIP_GAP = 8;
const VIEWPORT_MARGIN = 8;

/** Renders delegated data-tooltip content above every app stacking context. */
export function ViewportTooltip() {
  const [active, setActive] = useState<ActiveTooltip | null>(null);
  const [position, setPosition] = useState<TooltipPosition>({ left: 0, top: 0, visible: false });
  const tooltipRef = useRef<HTMLDivElement | null>(null);

  const updatePosition = useCallback(() => {
    if (!active || !tooltipRef.current || !active.target.isConnected) return;
    const targetRect = active.target.getBoundingClientRect();
    const tooltipRect = tooltipRef.current.getBoundingClientRect();
    const viewportWidth = document.documentElement.clientWidth || window.innerWidth;
    const viewportHeight = document.documentElement.clientHeight || window.innerHeight;
    const side = fittingSide(active.side, targetRect, tooltipRect, viewportWidth, viewportHeight);
    const candidate = positionForSide(side, targetRect, tooltipRect);
    setPosition({
      left: clamp(candidate.left, VIEWPORT_MARGIN, Math.max(VIEWPORT_MARGIN, viewportWidth - tooltipRect.width - VIEWPORT_MARGIN)),
      top: clamp(candidate.top, VIEWPORT_MARGIN, Math.max(VIEWPORT_MARGIN, viewportHeight - tooltipRect.height - VIEWPORT_MARGIN)),
      visible: true
    });
  }, [active]);

  useLayoutEffect(() => {
    setPosition((current) => ({ ...current, visible: false }));
    updatePosition();
  }, [active, updatePosition]);

  useEffect(() => {
    const show = (event: Event) => {
      const target = tooltipTarget(event.target);
      const text = (target?.dataset.tooltip ?? target?.dataset.preview)?.trim();
      if (!target || !text) return;
      setActive({ side: preferredSide(target), target, text });
    };
    const hide = (event: Event) => {
      const relatedTarget = (event as Event & { relatedTarget?: EventTarget | null }).relatedTarget ?? null;
      const nextTarget = tooltipTarget(relatedTarget);
      setActive((current) => current && nextTarget === current.target ? current : null);
    };
    const reposition = () => updatePosition();
    document.addEventListener("pointerover", show);
    document.addEventListener("pointerout", hide);
    document.addEventListener("focusin", show);
    document.addEventListener("focusout", hide);
    window.addEventListener("resize", reposition);
    window.addEventListener("scroll", reposition, true);
    return () => {
      document.removeEventListener("pointerover", show);
      document.removeEventListener("pointerout", hide);
      document.removeEventListener("focusin", show);
      document.removeEventListener("focusout", hide);
      window.removeEventListener("resize", reposition);
      window.removeEventListener("scroll", reposition, true);
    };
  }, [updatePosition]);

  if (!active) return null;
  return createPortal(
    <div
      className="viewport-tooltip"
      data-side={active.side}
      ref={tooltipRef}
      role="tooltip"
      style={{ left: position.left, top: position.top, visibility: position.visible ? "visible" : "hidden" }}
    >
      {active.text}
    </div>,
    document.body
  );
}

/** Picks an opposite side when the preferred direction cannot fit. */
export function fittingSide(
  preferred: TooltipSide,
  target: DOMRect,
  tooltip: DOMRect,
  viewportWidth: number,
  viewportHeight: number
): TooltipSide {
  const room = {
    bottom: viewportHeight - target.bottom,
    left: target.left,
    right: viewportWidth - target.right,
    top: target.top
  };
  const required = preferred === "left" || preferred === "right" ? tooltip.width + TOOLTIP_GAP : tooltip.height + TOOLTIP_GAP;
  if (room[preferred] >= required) return preferred;
  const opposite: Record<TooltipSide, TooltipSide> = { bottom: "top", left: "right", right: "left", top: "bottom" };
  return room[opposite[preferred]] > room[preferred] ? opposite[preferred] : preferred;
}

function tooltipTarget(value: EventTarget | null): HTMLElement | null {
  return value instanceof Element ? value.closest<HTMLElement>("[data-tooltip], [data-preview]") : null;
}

function preferredSide(target: HTMLElement): TooltipSide {
  if (target.classList.contains("tooltip-top") || target.classList.contains("issue-badge")) return "top";
  if (target.classList.contains("tooltip-right")) return "right";
  return "bottom";
}

function positionForSide(side: TooltipSide, target: DOMRect, tooltip: DOMRect) {
  if (side === "top") return { left: target.left + (target.width - tooltip.width) / 2, top: target.top - tooltip.height - TOOLTIP_GAP };
  if (side === "right") return { left: target.right + TOOLTIP_GAP, top: target.top + (target.height - tooltip.height) / 2 };
  if (side === "left") return { left: target.left - tooltip.width - TOOLTIP_GAP, top: target.top + (target.height - tooltip.height) / 2 };
  return { left: target.left + (target.width - tooltip.width) / 2, top: target.bottom + TOOLTIP_GAP };
}

function clamp(value: number, minimum: number, maximum: number) {
  return Math.min(Math.max(value, minimum), maximum);
}
