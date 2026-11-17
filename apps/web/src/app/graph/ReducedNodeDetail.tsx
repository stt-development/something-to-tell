import { Link2, Maximize2 } from "lucide-react";
import { tr } from "../../localization/i18n";
import { NODE_META, displayNodeKind, type NarrativeNodeRenderData } from "../workspaceShared";
import type { NodePresentationRow } from "./nodePresentationStore";

/** Bound preview work before whitespace normalization, without cutting a surrogate pair. */
export function nodeDetailPreview(text: string) {
  let end = Math.min(text.length, 320);
  const last = text.charCodeAt(end - 1);
  if (last >= 0xd800 && last <= 0xdbff) end--;
  const preview = text.slice(0, end).replace(/\s+/g, " ").trim();
  return preview && end < text.length ? `${preview}...` : preview;
}

/** Lightweight body only; the owning NarrativeNode always retains real size and four ports. */
export function ReducedNodeDetail({ data, presentation, onReveal }: {
  data: Pick<NarrativeNodeRenderData, "title" | "summary" | "kind" | "isFrame" | "issueCount" | "isLinkedInstance">;
  presentation: NodePresentationRow;
  onReveal: () => void;
}) {
  const Icon = NODE_META[data.kind].Icon;
  const title = `${displayNodeKind(data.kind)}: ${data.title}`;
  const preview = nodeDetailPreview(data.summary);
  const open = tr(data.isFrame ? "authoring.focusNamed" : "canvasDetail.revealNamed", { name: data.title });
  return <><div className={`node-detail-header node-detail-${presentation.mode}`}>
    <Icon size={15} aria-hidden="true" />
    <span className="node-detail-title">{title}</span>
    {data.isLinkedInstance ? <span aria-label={tr("authoring.linkedInstance")} role="img" tabIndex={0}
      className="linked-instance-indicator tooltip-wrapper tooltip-top" data-tooltip={tr("authoring.linkedInstance")} data-node-focus="linked">
      <Link2 size={13} aria-hidden="true" /></span> : null}
    {data.issueCount ? <span className="node-detail-issues" aria-label={tr("authoring.issueCount", { count: data.issueCount })}>{data.issueCount}</span> : null}
    {presentation.foldedDescendants > 0 ? <span className="node-detail-folded tooltip-wrapper tooltip-top" tabIndex={0} data-node-focus="folded-count"
      aria-label={tr("canvasDetail.foldedCount", { direct: presentation.foldedDirect, count: presentation.foldedDescendants })}
      data-tooltip={tr("canvasDetail.foldedCount", { direct: presentation.foldedDirect, count: presentation.foldedDescendants })}>{presentation.foldedDescendants}</span> : null}
    <button aria-label={open} className="node-detail-open tooltip-wrapper tooltip-top nodrag" data-tooltip={open} data-node-focus="open"
      onMouseDown={(event) => event.preventDefault()}
      onClick={(event) => { event.stopPropagation(); onReveal(); }} type="button"><Maximize2 size={14} aria-hidden="true" /></button>
  </div>
    {preview ? <p className={`node-detail-preview${data.isFrame ? " node-detail-frame-preview" : ""}`}>{preview}</p> : null}
  </>;
}
