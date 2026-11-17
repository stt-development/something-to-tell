import { Panel } from "@xyflow/react";
import { LayoutPanelTop } from "lucide-react";
import { createContext, useCallback, useContext, useMemo, useState, type ComponentProps, type ReactNode } from "react";
import { useTranslation } from "react-i18next";
import { tr } from "../../localization/i18n";
import { FlowViewSummary } from "../graph/GraphCanvasParts";

const VisibilityContext = createContext<{ open: boolean; toggle: () => void; close: () => void } | null>(null);

/** Owns only the summary's open flag across modes, not flow facts or graph data. */
export function FlowSummaryVisibilityProvider({ children }: { children: ReactNode }) {
  const [open, setOpen] = useState(true);
  const toggle = useCallback(() => setOpen((current) => !current), []);
  const close = useCallback(() => setOpen(false), []);
  const value = useMemo(() => ({ open, toggle, close }), [open, toggle, close]);
  return <VisibilityContext.Provider value={value}>{children}</VisibilityContext.Provider>;
}

function useVisibility() {
  const visibility = useContext(VisibilityContext);
  if (!visibility) throw new Error("Flow summary controls require their visibility provider");
  return visibility;
}

export function FlowSummaryToggle() {
  useTranslation();
  const { open, toggle } = useVisibility();
  const label = open ? tr("flow.hideSummary") : tr("flow.showSummary");
  return (
    <span className="tooltip-wrapper" data-tooltip={label}>
      <button aria-label={label} className={`icon-button ${open ? "tool-button-active" : ""}`}
        onClick={toggle} type="button"><LayoutPanelTop size={18} aria-hidden="true" /></button>
    </span>
  );
}

/** Keep the existing floating Panel geometry; only this leaf consumes visibility. */
export function VisibleFlowSummary(props: Omit<ComponentProps<typeof FlowViewSummary>, "onClose">) {
  useTranslation();
  const { open, close } = useVisibility();
  return open ? (
    <Panel className="flow-summary-panel" position="top-right">
      <FlowViewSummary {...props} onClose={close} />
    </Panel>
  ) : null;
}
