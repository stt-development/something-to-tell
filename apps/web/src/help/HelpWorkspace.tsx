/** Categorized guide navigation/search and one article reader; no project state. */
import { useEffect, useRef, useState } from "react";
import { ArrowLeft, Search } from "lucide-react";
import { useTranslation } from "react-i18next";
import { i18next, tr } from "../localization/i18n";
import { guideArticles, guideCategories, guideLocale, loadGuide, searchGuides, type GuideArticle } from "./guideCatalog";
import { GuideReader } from "./GuideReader";

export function HelpWorkspace() {
  useTranslation();
  const locale = guideLocale(i18next.language);
  const [query, setQuery] = useState("");
  const [category, setCategory] = useState<string | null>(null);
  const [articleId, setArticleId] = useState<string | null>(null);
  const [hash, setHash] = useState("");
  const [results, setResults] = useState<readonly GuideArticle[]>(guideArticles);
  const [markdown, setMarkdown] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [searchBusy, setSearchBusy] = useState(false);
  const [searchFailed, setSearchFailed] = useState(false);
  const [failed, setFailed] = useState(false);
  const [retry, setRetry] = useState(0);
  const page = useRef<HTMLDivElement>(null);

  useEffect(() => {
    let current = true;
    setSearchBusy(true); setSearchFailed(false);
    void searchGuides(query, locale).then(found => { if (current) setResults(found); })
      .catch(() => { if (current) { setSearchFailed(true); setResults([]); } })
      .finally(() => { if (current) setSearchBusy(false); });
    return () => { current = false; };
  }, [query, locale, retry]);

  useEffect(() => {
    let current = true;
    setMarkdown(null); setFailed(false);
    if (!articleId) { setBusy(false); return; }
    setBusy(true);
    void loadGuide(articleId, locale).then(text => {
      if (!current) return;
      setMarkdown(text); setFailed(text === null);
    }).catch(() => { if (current) setFailed(true); })
      .finally(() => { if (current) setBusy(false); });
    return () => { current = false; };
  }, [articleId, locale, retry]);

  useEffect(() => {
    if (markdown) page.current?.focus({ preventScroll: true });
  }, [markdown]);

  function navigate(id: string, targetHash = "") {
    if (articleId !== id) page.current?.scrollTo?.({ top: 0 });
    setArticleId(id); setHash(targetHash);
  }

  const filtered = results.filter(article => !category || article.category === category);
  return <div className="help-workspace">
    <div className="help-tools">
      <button type="button" className="help-contents-button" onClick={() => { setArticleId(null); setCategory(null); setQuery(""); }}>
        <ArrowLeft size={15} aria-hidden="true" />{tr("help.contents")}
      </button>
      <label className="help-search"><Search size={16} aria-hidden="true" />
        <input aria-label={tr("help.search")} placeholder={tr("help.search")} value={query} onChange={event => {
          setQuery(event.target.value); setArticleId(null); setCategory(null);
        }} />
      </label>
    </div>
    <div className="help-body">
      <nav className="help-categories" aria-label={tr("help.contents")}>
        {guideCategories.map(item => <button type="button" key={item.id} aria-pressed={category === item.id}
          onClick={() => { setCategory(item.id); setArticleId(null); }}>
          <span>{item.title[locale]}</span><small>{results.filter(article => article.category === item.id).length}</small>
        </button>)}
      </nav>
      <div className="help-page" ref={page} tabIndex={-1}>
        {articleId ? busy ? <p role="status">{tr("help.loading")}</p> : failed ? <div role="alert">
          <p>{tr("help.unavailable")}</p><button type="button" className="help-contents-button" onClick={() => setRetry(value => value + 1)}>{tr("help.retry")}</button>
        </div> : markdown ? <GuideReader markdown={markdown} articleId={articleId} hash={hash} onNavigate={navigate} /> : null
        : searchBusy ? <p role="status">{tr("help.loading")}</p> : searchFailed ? <div role="alert"><p>{tr("help.unavailable")}</p>
          <button className="help-contents-button" type="button" onClick={() => setRetry(value => value + 1)}>{tr("help.retry")}</button></div>
        : filtered.length ? guideCategories.filter(item => filtered.some(article => article.category === item.id)).map(item => <section className="help-topic-group" key={item.id}>
          <h3>{item.title[locale]}</h3>
          {filtered.filter(article => article.category === item.id).map(article => <button className="help-topic" type="button" key={article.id} onClick={() => navigate(article.id)}>
            <strong>{article.title[locale]}</strong><span>{article.summary[locale]}</span>
          </button>)}
        </section>) : <p role="status">{tr("help.noResults")}</p>}
      </div>
    </div>
  </div>;
}
