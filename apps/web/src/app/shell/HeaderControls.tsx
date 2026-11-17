import type {
CanonCheckRun
} from "@something-to-tell/contracts/canon-check";
import type {
ImpactAnalysisRun
} from "@something-to-tell/contracts/impact-analysis";
import type {
ProjectSessionState
} from "@something-to-tell/contracts/project-session";
import {
ChevronDown,
Copy,
Save,
ScanSearch,
ShieldCheck,
Sparkles,
type LucideIcon
} from "lucide-react";
import { useEffect,useRef,useState,type RefObject } from "react";
import {
tr
} from "../../localization/i18n";

import { AnalysisTool } from "../workspaceShared";

export function AnalysisControl({
  activeTool,
  canonIssueCount,
  canonStatus,
  impactSeedCount,
  impactStatus,
  lastTool,
  onSelect,
  primaryButtonRef,
  sceneTextImportEnabled,
  sceneStatus
}: {
  activeTool: AnalysisTool | null;
  canonIssueCount: number;
  canonStatus: CanonCheckRun["status"] | "loading" | "idle";
  impactSeedCount: number;
  impactStatus: ImpactAnalysisRun["status"] | "starting" | "cancelling" | "idle";
  lastTool: AnalysisTool;
  onSelect: (tool: AnalysisTool, toggle?: boolean) => void;
  primaryButtonRef: RefObject<HTMLButtonElement>;
  sceneTextImportEnabled: boolean;
  sceneStatus: "idle" | "running" | "completed" | "failed";
}) {
  const [menuOpen, setMenuOpen] = useState(false);
  const containerRef = useRef<HTMLDivElement | null>(null);
  const menuButtonRef = useRef<HTMLButtonElement | null>(null);
  const firstItemRef = useRef<HTMLButtonElement | null>(null);

  useEffect(() => {
    if (!menuOpen) return;
    firstItemRef.current?.focus();
    function closeFromOutside(event: PointerEvent) {
      if (!containerRef.current?.contains(event.target as globalThis.Node)) setMenuOpen(false);
    }
    function closeFromKeyboard(event: KeyboardEvent) {
      if (event.key !== "Escape") return;
      setMenuOpen(false);
      menuButtonRef.current?.focus();
    }
    document.addEventListener("pointerdown", closeFromOutside);
    document.addEventListener("keydown", closeFromKeyboard);
    return () => {
      document.removeEventListener("pointerdown", closeFromOutside);
      document.removeEventListener("keydown", closeFromKeyboard);
    };
  }, [menuOpen]);

  const tools: Array<{ count?: number; icon: LucideIcon; status: string; tool: AnalysisTool }> = [
    { count: impactSeedCount, icon: ScanSearch, status: tr(`impact.status.${impactStatus}`), tool: "impact" },
    { count: canonIssueCount, icon: ShieldCheck, status: tr(`canon.runStatus.${canonStatus}`), tool: "canon" }
  ];
  if (sceneTextImportEnabled) {
    tools.unshift({ icon: Sparkles, status: tr(`analysisHub.status.${sceneStatus}`), tool: "scene" });
  }
  const selected = tools.find((item) => item.tool === lastTool) ?? tools[0]!;
  const SelectedIcon = selected.icon;
  const toolName = tr(`analysisHub.tool.${selected.tool}`);

  return (
    <div className="analysis-split-button" ref={containerRef}>
      <span className="tooltip-wrapper" data-tooltip={tr("analysisHub.openLast", { tool: toolName })}>
        <button
          aria-label={tr("analysisHub.openLast", { tool: toolName })}
          className={`canon-header-control analysis-split-primary ${activeTool ? "tool-button-active" : ""}`}
          onClick={() => onSelect(selected.tool, true)}
          ref={primaryButtonRef}
          type="button"
        >
          <SelectedIcon size={17} aria-hidden="true" />
          <span>{tr("analysisHub.header")}</span>
        </button>
      </span>
      <span className="tooltip-wrapper" data-tooltip={tr("analysisHub.chooseTool")}>
        <button
          aria-expanded={menuOpen}
          aria-haspopup="menu"
          aria-label={tr("analysisHub.chooseTool")}
          className={`icon-button analysis-split-toggle ${menuOpen ? "tool-button-active" : ""}`}
          onClick={() => setMenuOpen((open) => !open)}
          onKeyDown={(event) => {
            if (event.key !== "ArrowDown") return;
            event.preventDefault();
            setMenuOpen(true);
          }}
          ref={menuButtonRef}
          type="button"
        >
          <ChevronDown size={14} aria-hidden="true" />
        </button>
      </span>
      {menuOpen ? (
        <div aria-label={tr("analysisHub.menu")} className="analysis-split-menu" role="menu">
          {tools.map((item, index) => {
            const Icon = item.icon;
            return (
              <button
                aria-current={activeTool === item.tool ? "page" : undefined}
                key={item.tool}
                onClick={() => {
                  setMenuOpen(false);
                  onSelect(item.tool);
                }}
                ref={index === 0 ? firstItemRef : undefined}
                role="menuitem"
                type="button"
              >
                <Icon size={16} aria-hidden="true" />
                <span><strong>{tr(`analysisHub.tool.${item.tool}`)}</strong><small>{item.status}</small></span>
                {typeof item.count === "number" ? <b>{item.count}</b> : null}
              </button>
            );
          })}
        </div>
      ) : null}
    </div>
  );
}

export function SaveControl({
  onSave,
  onSaveAs,
  session
}: {
  onSave: () => void;
  onSaveAs: () => void;
  session: Pick<ProjectSessionState, "save_status"> | null;
}) {
  const [menuOpen, setMenuOpen] = useState(false);
  const containerRef = useRef<HTMLDivElement | null>(null);
  const menuButtonRef = useRef<HTMLButtonElement | null>(null);

  useEffect(() => {
    if (!menuOpen) return;

    // Header menus must release focus and close consistently without depending
    // on canvas pointer handlers underneath the fixed application header.
    function closeFromOutside(event: PointerEvent) {
      if (!containerRef.current?.contains(event.target as globalThis.Node)) {
        setMenuOpen(false);
      }
    }

    function closeFromKeyboard(event: KeyboardEvent) {
      if (event.key !== "Escape") return;
      setMenuOpen(false);
      menuButtonRef.current?.focus();
    }

    document.addEventListener("pointerdown", closeFromOutside);
    document.addEventListener("keydown", closeFromKeyboard);
    return () => {
      document.removeEventListener("pointerdown", closeFromOutside);
      document.removeEventListener("keydown", closeFromKeyboard);
    };
  }, [menuOpen]);

  const saving = session?.save_status === "saving";
  const menuDisabled = !session || saving;

  return (
    <div className="save-split-button" ref={containerRef}>
      <span className="tooltip-wrapper" data-tooltip={tr("save.project")}>
        <button
          aria-busy={saving}
          aria-label={tr("save.project")}
          className={`icon-button save-split-primary ${session?.save_status === "dirty" ? "save-button-reminder" : ""} ${session?.save_status === "error" ? "save-button-error" : ""}`}
          disabled={!session || session.save_status === "clean" || saving}
          onClick={onSave}
          type="button"
        >
          <Save size={18} aria-hidden="true" />
        </button>
      </span>
      <span className="tooltip-wrapper" data-tooltip={tr("save.moreActions")}>
        <button
          aria-expanded={menuOpen}
          aria-haspopup="menu"
          aria-label={tr("save.moreActions")}
          className={`icon-button save-split-toggle ${menuOpen ? "tool-button-active" : ""}`}
          disabled={menuDisabled}
          onClick={() => setMenuOpen((open) => !open)}
          ref={menuButtonRef}
          type="button"
        >
          <ChevronDown size={14} aria-hidden="true" />
        </button>
      </span>
      {menuOpen ? (
        <div className="save-split-menu" role="menu">
          <button
            onClick={() => {
              setMenuOpen(false);
              onSaveAs();
            }}
            role="menuitem"
            type="button"
          >
            <Copy size={16} aria-hidden="true" />
            <span>{tr("save.as")}</span>
          </button>
        </div>
      ) : null}
    </div>
  );
}
