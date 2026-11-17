/** Read-only packaged guide catalog; independent of project/session state. */
import manifest from "../../../../docs/guides/catalog.json";
import { parseGuide } from "./guideMarkdown";

export type GuideLocale = "en" | "ru";
type LocalizedText = Record<GuideLocale, string>;
export interface GuideArticle { id: string; category: string; title: LocalizedText; summary: LocalizedText; }
export interface GuideCategory { id: string; title: LocalizedText; }
export const guideArticles: readonly GuideArticle[] = manifest.articles;
export const guideCategories: readonly GuideCategory[] = manifest.categories;

// Vite emits local chunks for these canonical sources; nothing is fetched from runtime.
const sources = import.meta.glob<string>([
  "../../../../docs/guides/*.en.md", "../../../../docs/guides/*.ru.md"
], { query: "?raw", import: "default" });
const assets = import.meta.glob<string>("../../../../docs/guides/assets/**/*.{png,jpg,jpeg,webp}", {
  query: "?url", import: "default", eager: true
});

export function guideLocale(language: string): GuideLocale { return language.split("-")[0] === "ru" ? "ru" : "en"; }

export async function loadGuide(id: string, locale: GuideLocale): Promise<string | null> {
  if (!guideArticles.some(article => article.id === id)) return null;
  const loader = sources[`../../../../docs/guides/${id}.${locale}.md`];
  return loader ? loader() : null;
}

export type GuideLink = { kind: "article"; id: string; hash: string } | { kind: "external"; url: string } | { kind: "blocked" };

/** Relative links may address a known article only, never an arbitrary app/file path. */
export function resolveGuideLink(href: string, currentId: string): GuideLink {
  if (/^https:\/\//i.test(href)) {
    try { const url = new URL(href); return url.username || url.password ? { kind: "blocked" } : { kind: "external", url: url.href }; }
    catch { return { kind: "blocked" }; }
  }
  if (href.startsWith("#")) return { kind: "article", id: currentId, hash: href.slice(1) };
  const match = /^([a-z0-9-]+)\.(en|ru)\.md(?:#([^?]*))?$/.exec(href);
  if (!match || !guideArticles.some(article => article.id === match[1])) return { kind: "blocked" };
  return { kind: "article", id: match[1]!, hash: match[3] ?? "" };
}

export function resolveGuideImage(src: string): string | null {
  if (!/^assets\/[a-z0-9-]+\/[a-zA-Z0-9_.-]+\.(png|jpe?g|webp)$/.test(src)) return null;
  return assets[`../../../../docs/guides/${src}`] ?? null;
}

// Only an opened Help surface builds the local full-text index, per UI language.
const indexes = new Map<GuideLocale, Promise<{ article: GuideArticle; text: string }[]>>();
export async function searchGuides(query: string, locale: GuideLocale): Promise<readonly GuideArticle[]> {
  const tokens = query.trim().toLocaleLowerCase(locale).split(/\s+/).filter(Boolean);
  if (!tokens.length) return guideArticles;
  let index = indexes.get(locale);
  if (!index) {
    index = Promise.all(guideArticles.map(async article => {
      const markdown = await loadGuide(article.id, locale);
      if (markdown === null) throw new Error("Guide content unavailable");
      return { article, text: `${article.title[locale]} ${article.summary[locale]} ${parseGuide(markdown).searchText}`.toLocaleLowerCase(locale) };
    }));
    indexes.set(locale, index);
    void index.catch(() => { if (indexes.get(locale) === index) indexes.delete(locale); });
  }
  return (await index).filter(entry => tokens.every(token => entry.text.includes(token))).map(entry => entry.article);
}
