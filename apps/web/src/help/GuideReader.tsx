/** Safe read-only Markdown presentation; article navigation stays in Help. */
import { useEffect, useMemo, useRef, useState } from "react";
import Markdown from "react-markdown";
import remarkGfm from "remark-gfm";
import { Copy, X } from "lucide-react";
import { tr } from "../localization/i18n";
import { resolveGuideImage, resolveGuideLink } from "./guideCatalog";
import { parseGuide, remarkGuideHeadings } from "./guideMarkdown";
import "./help.css";

export interface GuideReaderProps {
  markdown: string;
  articleId: string;
  hash?: string;
  onNavigate: (id: string, hash: string) => void;
}

function GuideLink({ href, children, articleId, onNavigate }: {
  href: string; children: React.ReactNode; articleId: string; onNavigate: GuideReaderProps["onNavigate"];
}) {
  const [notice, setNotice] = useState("");
  const link = resolveGuideLink(href, articleId);
  if (link.kind === "blocked") return <span title={tr("help.blockedLink")}>{children}</span>;
  if (link.kind === "article") return <a href={`#guide-${link.hash}`} onClick={(event) => {
    event.preventDefault(); onNavigate(link.id, link.hash);
  }}>{children}</a>;
  // No native URL opener exists in this shell: copying is explicit and never navigates the webview.
  return <span className="help-external-link">{children} <button type="button" title={link.url} aria-label={tr("help.copyLink")}
    onClick={() => {
      if (!navigator.clipboard) { setNotice(tr("help.copyFailed")); return; }
      void navigator.clipboard.writeText(link.url).then(() => setNotice(tr("help.linkCopied"))).catch(() => setNotice(tr("help.copyFailed")));
    }}>
    <Copy size={13} aria-hidden="true" />
  </button>{notice ? <small role="status">{notice}</small> : null}</span>;
}

function GuideImage({ src, alt }: { src: string; alt: string }) {
  const [expanded, setExpanded] = useState(false);
  const [failed, setFailed] = useState(false);
  const origin = useRef<HTMLButtonElement>(null);
  const close = useRef<HTMLButtonElement>(null);
  const image = resolveGuideImage(src);
  useEffect(() => {
    if (!expanded) return;
    close.current?.focus();
    return () => origin.current?.focus();
  }, [expanded]);
  if (!image || failed) return <span className="help-image-unavailable">{alt}: {tr("help.imageUnavailable")}</span>;
  return <>
    <button className="help-image-button" ref={origin} type="button" aria-label={tr("help.enlargeImage", { alt })} onClick={() => setExpanded(true)}>
      <img src={image} alt={alt} loading="lazy" onError={() => setFailed(true)} />
    </button>
    {expanded ? <span className="help-image-expanded" role="group" aria-label={alt} onKeyDown={(event) => {
      if (event.key === "Escape") { event.preventDefault(); event.stopPropagation(); setExpanded(false); }
      if (event.key === "Tab") { event.preventDefault(); close.current?.focus(); }
    }}>
      <button type="button" className="icon-button" ref={close} onClick={() => setExpanded(false)} aria-label={tr("help.closeImage")}><X size={18} aria-hidden="true" /></button>
      <img src={image} alt={alt} />
    </span> : null}
  </>;
}

export function GuideReader({ markdown, articleId, hash = "", onNavigate }: GuideReaderProps) {
  const content = useRef<HTMLElement>(null);
  const headings = useMemo(() => parseGuide(markdown).headings, [markdown]);
  useEffect(() => {
    if (!hash) { content.current?.scrollTo?.({ top: 0 }); return; }
    try { document.getElementById(`guide-${decodeURIComponent(hash)}`)?.scrollIntoView?.({ block: "start" }); }
    catch { /* A malformed authored anchor must not crash the reader. */ }
  }, [hash, markdown]);
  return <div className="help-reader-layout">
    <nav className="help-page-contents" aria-label={tr("help.onThisPage")}>
      <h3>{tr("help.onThisPage")}</h3>
      {headings.filter(heading => heading.depth > 1).map(heading => <a key={heading.id} href={`#guide-${heading.id}`}
        onClick={(event) => { event.preventDefault(); onNavigate(articleId, heading.id); }}>{heading.text}</a>)}
    </nav>
    <article className="help-markdown" ref={content}>
      <Markdown skipHtml remarkPlugins={[remarkGfm, remarkGuideHeadings]} urlTransform={url => url} components={{
        a: ({ href, children }) => <GuideLink href={href ?? ""} articleId={articleId} onNavigate={onNavigate}>{children}</GuideLink>,
        img: ({ src, alt }) => <GuideImage src={src ?? ""} alt={alt ?? ""} />,
        table: ({ children }) => <div className="help-table-scroll" tabIndex={0}><table>{children}</table></div>
      }}>{markdown}</Markdown>
    </article>
  </div>;
}
