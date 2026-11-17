import { Search } from "lucide-react";
import { createContext, useCallback, useContext, useMemo, useState, type ComponentProps, type ReactNode } from "react";
import { useTranslation } from "react-i18next";
import { tr } from "../../localization/i18n";
import { GraphFilterBar } from "../graph/GraphCanvasParts";

const VisibilityContext = createContext<{ open: boolean; toggle: () => void } | null>(null);

/** Owns only panel visibility; filter criteria and graph authority stay in workspace. */
export function GraphFilterVisibilityProvider({ children }: { children: ReactNode }) {
  const [open, setOpen] = useState(false);
  const toggle = useCallback(() => setOpen((current) => !current), []);
  const value = useMemo(() => ({ open, toggle }), [open, toggle]);
  return <VisibilityContext.Provider value={value}>{children}</VisibilityContext.Provider>;
}

function useVisibility() {
  const visibility = useContext(VisibilityContext);
  if (!visibility) throw new Error("Graph filter controls require their visibility provider");
  return visibility;
}

export function GraphFilterToggle() {
  useTranslation();
  const { open, toggle } = useVisibility();
  return (
    <span className="tooltip-wrapper" data-tooltip={open ? tr("workspace.hideFilters") : tr("workspace.showFilters")}>
      <button
        aria-label={open ? tr("workspace.hideGraphFilters") : tr("workspace.showGraphFilters")}
        className={`icon-button ${open ? "tool-button-active" : ""}`}
        onClick={toggle}
        type="button"
      >
        <Search size={18} aria-hidden="true" />
      </button>
    </span>
  );
}

export function VisibleGraphFilterBar(props: ComponentProps<typeof GraphFilterBar>) {
  useTranslation();
  const { open } = useVisibility();
  return open ? <GraphFilterBar {...props} /> : null;
}

/** Summary suppression is local too, so the React Flow owner need not consume context. */
export function HiddenWhileGraphFiltersOpen({ children }: { children: ReactNode }) {
  return useVisibility().open ? null : <>{children}</>;
}
