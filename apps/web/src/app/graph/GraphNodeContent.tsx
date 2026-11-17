import {
  ArrowRight,
  BookOpen,
  Calendar,
  CircleStop,
  FileText,
  GitBranch,
  MessageSquare,
  Package,
  User,
  X,
  type LucideIcon
} from "lucide-react";
import { useEffect, useId, useRef, useState } from "react";
import { createPortal } from "react-dom";
import type { DialogueCanvasMetrics } from "../../dialogue/presentation";
import { tr } from "../../localization/i18n";
import type { NarrativeNodeRenderData } from "../workspaceShared";
import { displayNodeKind } from "../workspaceShared";

/** Raises the React Flow wrapper because a pseudo-element cannot escape its stacking context. */
export function setIssueTooltipLayer(badge: HTMLElement, active: boolean) {
  badge.closest(".react-flow__node")?.classList.toggle("issue-tooltip-active", active);
}

/** Keeps descriptions compact on the graph while exposing their complete text without edit mode. */
export function NodeDescriptionPreview({ className, summary, title }: { className: string; summary: string; title: string }) {
  return (
    <p
      aria-label={tr("authoring.descriptionFor", { name: title })}
      className={`${className} node-description-preview`}
      data-preview={summary || undefined}
      onBlur={(event) => setIssueTooltipLayer(event.currentTarget, false)}
      onFocus={(event) => setIssueTooltipLayer(event.currentTarget, true)}
      onMouseEnter={(event) => setIssueTooltipLayer(event.currentTarget, true)}
      onMouseLeave={(event) => setIssueTooltipLayer(event.currentTarget, false)}
      tabIndex={summary ? 0 : undefined}
    >
      {summary}
    </p>
  );
}

export interface FrameDescriptionPosition {
  left: number;
  top: number;
  width: number;
}

/** Keeps the frame description inside the application viewport. */
export function frameDescriptionPosition(trigger: DOMRect): FrameDescriptionPosition {
  const margin = 12;
  const gap = 8;
  const width = Math.min(360, Math.max(220, window.innerWidth - margin * 2));
  const estimatedHeight = 260;
  const left = Math.min(Math.max(margin, trigger.right - width), window.innerWidth - width - margin);
  const below = trigger.bottom + gap;
  const top = below + estimatedHeight <= window.innerHeight
    ? below
    : Math.max(margin, trigger.top - estimatedHeight - gap);
  return { left, top, width };
}

/** Uses a body portal so the preview does not inherit the frame's canvas stacking context. */
export function FrameDescriptionControl({ summary, title }: { summary: string; title: string }) {
  const [open, setOpen] = useState(false);
  const [position, setPosition] = useState<FrameDescriptionPosition>({ left: 12, top: 12, width: 360 });
  const buttonRef = useRef<HTMLButtonElement>(null);
  const popoverRef = useRef<HTMLElement>(null);
  const titleId = useId();
  const popoverId = useId();

  function updatePosition() {
    if (buttonRef.current) setPosition(frameDescriptionPosition(buttonRef.current.getBoundingClientRect()));
  }

  function closeAndRestoreFocus() {
    setOpen(false);
    buttonRef.current?.focus();
  }

  useEffect(() => {
    if (!open) return;
    const onPointerDown = (event: PointerEvent) => {
      const target = event.target as globalThis.Node;
      if (!popoverRef.current?.contains(target) && !buttonRef.current?.contains(target)) setOpen(false);
    };
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        event.preventDefault();
        closeAndRestoreFocus();
      }
    };
    const onViewportChange = () => updatePosition();
    document.addEventListener("pointerdown", onPointerDown);
    document.addEventListener("keydown", onKeyDown);
    window.addEventListener("resize", onViewportChange);
    window.addEventListener("scroll", onViewportChange, true);
    return () => {
      document.removeEventListener("pointerdown", onPointerDown);
      document.removeEventListener("keydown", onKeyDown);
      window.removeEventListener("resize", onViewportChange);
      window.removeEventListener("scroll", onViewportChange, true);
    };
  }, [open]);

  return (
    <>
      <button
        aria-controls={open ? popoverId : undefined}
        aria-expanded={open}
        aria-label={tr("authoring.showDescriptionNamed", { name: title })}
        className="narrative-frame-action tooltip-wrapper tooltip-top"
        data-tooltip={tr("authoring.showDescription")}
        onClick={(event) => {
          event.stopPropagation();
          updatePosition();
          setOpen((current) => !current);
        }}
        ref={buttonRef}
        type="button"
      >
        <FileText size={14} aria-hidden="true" />
      </button>
      {open ? createPortal(
        <section
          aria-labelledby={titleId}
          className="frame-description-popover nodrag nowheel"
          id={popoverId}
          onClick={(event) => event.stopPropagation()}
          ref={popoverRef}
          role="dialog"
          style={position}
        >
          <header>
            <div>
              <span>{tr("common.description")}</span>
              <h3 id={titleId}>{title}</h3>
            </div>
            <button aria-label={tr("common.close")} onClick={closeAndRestoreFocus} title={tr("common.close")} type="button">
              <X size={16} aria-hidden="true" />
            </button>
          </header>
          <div className="frame-description-popover-body">
            {summary.trim() ? summary : <span className="frame-description-empty">{tr("authoring.noDescription")}</span>}
          </div>
        </section>,
        document.body
      ) : null}
    </>
  );
}

/** Summarizes Dialogue structure without rendering the full branch editor. */
export function DialogueNodeCanvasSummary({ metrics, summary, title }: { metrics: DialogueCanvasMetrics; summary: string; title: string }) {
  const items = [
    { Icon: User, key: "authoring.participantsCount" as const, value: metrics.participants },
    { Icon: MessageSquare, key: "authoring.linesCount" as const, value: metrics.lines },
    { Icon: GitBranch, key: "authoring.choicesCount" as const, value: metrics.choices },
    { Icon: CircleStop, key: "authoring.endingsCount" as const, value: metrics.endings }
  ];
  return (
    <div>
      <NodeDescriptionPreview className="dialogue-node-summary" summary={summary} title={title} />
      <div className="dialogue-node-metrics" aria-label={tr("authoring.dialogueSummary")}>
        {items.map(({ Icon, key, value }) => (
          <div className="dialogue-node-metric" key={key} title={tr(key, { count: value })}>
            <Icon size={13} aria-hidden="true" />
            <strong>{value}</strong>
            <span>{tr(key, { count: value }).replace(String(value), "").trim()}</span>
          </div>
        ))}
      </div>
    </div>
  );
}

/** Renders type-specific facts for generic canonical nodes at compact card size. */
export function SemanticNodePreview({ data }: { data: NarrativeNodeRenderData }) {
  const metrics = data.presentationMetrics ?? { incoming: 0, instances: 1, outgoing: 0 };
  const details: Record<"Character" | "Event" | "Item" | "Lore" | "Quest", { Icon: LucideIcon; primary: string; secondary: string }> = {
    Character: { Icon: User, primary: `${tr("authoring.role")}: ${data.characterRole || tr("authoring.notSet")}`, secondary: tr("authoring.relationshipCount", { count: metrics.incoming + metrics.outgoing }) },
    Quest: { Icon: GitBranch, primary: tr("authoring.stagesCount", { count: data.questMetrics?.stages ?? 0 }), secondary: tr("authoring.questMetrics", { branches: tr("authoring.branchesCount", { count: data.questMetrics?.branches ?? metrics.outgoing }), requirements: tr("authoring.requirementCount", { count: data.questMetrics?.prerequisites ?? 0 }), rewards: tr("authoring.rewardCount", { count: data.questMetrics?.rewards ?? 0 }) }) },
    Lore: { Icon: BookOpen, primary: tr("authoring.canonFact"), secondary: tr("authoring.relationshipCount", { count: metrics.incoming + metrics.outgoing }) },
    Item: { Icon: Package, primary: `${tr("authoring.purpose")}: ${data.itemPurpose || tr("authoring.notSet")}`, secondary: tr("authoring.placementCount", { count: metrics.instances }) },
    Event: { Icon: Calendar, primary: tr("authoring.narrativeEvent"), secondary: tr("authoring.eventLinks", { incoming: metrics.incoming, outgoing: metrics.outgoing }) }
  };
  const detail = details[data.kind as keyof typeof details];
  if (!detail) return null;
  const DetailIcon = detail.Icon;
  return (
    <section aria-label={`${displayNodeKind(data.kind)} details`} className="semantic-node-preview">
      <div className="semantic-node-facts"><DetailIcon size={14} aria-hidden="true" /><span><strong>{detail.primary}</strong><small>{detail.secondary}</small></span></div>
      <div aria-label={tr("authoring.tagsFor", { name: data.title })} className="semantic-tag-preview" data-preview={data.tags.join(", ") || tr("authoring.noTags")} onBlur={(event) => setIssueTooltipLayer(event.currentTarget, false)} onFocus={(event) => setIssueTooltipLayer(event.currentTarget, true)} onMouseEnter={(event) => setIssueTooltipLayer(event.currentTarget, true)} onMouseLeave={(event) => setIssueTooltipLayer(event.currentTarget, false)} tabIndex={0}>
        {data.tags.slice(0, 2).map((tag) => <span key={tag}>{tag}</span>)}
        {data.tags.length > 2 ? <span>+{data.tags.length - 2}</span> : null}
        {data.tags.length === 0 ? <span>{tr("authoring.noTags")}</span> : null}
      </div>
    </section>
  );
}

/** Provides a scan-friendly membership summary directly on a Faction card. */
export function FactionMemberPreview({ members }: { members: string[] }) {
  return <div aria-label={tr("authoring.factionMemberCount", { count: members.length })} className="faction-member-preview" title={members.join(", ") || tr("authoring.noMembers")}><User size={13} aria-hidden="true" /><strong>{members.length}</strong><span>{members.slice(0, 2).join(", ") || tr("authoring.noMembers")}{members.length > 2 ? ` +${members.length - 2}` : ""}</span></div>;
}

/** Distinguishes prerequisite and resulting-state semantics without changing canonical kinds. */
export function CausalRolePreview({ data }: { data: NarrativeNodeRenderData }) {
  if (data.kind === "Condition") {
    const requirement = data.requirement ?? { subject: data.title, predicate: data.summary, expression: "" };
    return <div aria-label={tr("authoring.requirementDetails")} className="causal-role-preview causal-role-requirement"><div className="causal-flow-label"><strong>{tr("node.condition")}</strong><ArrowRight size={13} aria-hidden="true" /><span>{tr("node.event")}</span></div><span className="causal-role-detail"><strong>{requirement.subject}</strong> {requirement.predicate}</span>{requirement.expression ? <code>{requirement.expression}</code> : null}</div>;
  }
  const outcome = data.outcome ?? { effect: data.summary, targetNodeIds: [] };
  return <div aria-label={tr("authoring.outcomeDetails")} className="causal-role-preview causal-role-outcome"><div className="causal-flow-label"><span>{tr("node.event")}</span><ArrowRight size={13} aria-hidden="true" /><strong>{tr("node.consequence")}</strong></div><span className="causal-role-detail">{outcome.effect}</span>{data.outcomeTargets?.length ? <small>{data.outcomeTargets.slice(0, 2).join(", ")}{data.outcomeTargets.length > 2 ? ` +${data.outcomeTargets.length - 2}` : ""}</small> : null}</div>;
}
