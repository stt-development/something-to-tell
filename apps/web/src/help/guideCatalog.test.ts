import { describe, expect, it } from "vitest";
import { guideArticles, guideCategories, guideLocale, loadGuide, resolveGuideImage, resolveGuideLink, searchGuides } from "./guideCatalog";
import { parseGuide } from "./guideMarkdown";

describe("packaged user guide catalog", () => {
  it("loads every allowed topic in EN/RU with unique ids, complete metadata and valid internal links", async () => {
    expect(new Set(guideArticles.map(article => article.id)).size).toBe(18);
    for (const article of guideArticles) {
      expect(guideCategories.some(category => category.id === article.category)).toBe(true);
      for (const locale of ["en", "ru"] as const) {
        expect(article.title[locale]).toBeTruthy(); expect(article.summary[locale]).toBeTruthy();
        const content = await loadGuide(article.id, locale);
        expect(content).toMatch(/^# /);
        const parsed = parseGuide(content!);
        expect(parsed.headings.length).toBeGreaterThan(1);
        for (const href of parsed.links) {
          const link = resolveGuideLink(href, article.id);
          expect(link.kind).not.toBe("blocked");
          if (link.kind === "article") {
            const target = await loadGuide(link.id, locale);
            expect(target).not.toBeNull();
            if (link.hash) expect(parseGuide(target!).headings.map(heading => heading.id)).toContain(decodeURIComponent(link.hash));
          }
        }
        for (const image of parsed.images) { expect(image.alt).toBeTruthy(); expect(resolveGuideImage(image.url)).not.toBeNull(); }
      }
    }
  });

  it("searches localized body text and metadata without a project", async () => {
    expect(guideLocale("ru-RU")).toBe("ru"); expect(guideLocale("en-US")).toBe("en");
    expect(await searchGuides("", "en")).toHaveLength(18);
    expect((await searchGuides("guard agrees", "en")).map(article => article.id)).toContain("narrative-state");
    expect((await searchGuides("переподключения", "ru")).map(article => article.id)).toContain("storage-recovery");
    expect(await searchGuides("zzzz-no-such-text", "ru")).toEqual([]);
  });

  it("rejects unknown sources, unsafe schemes, traversal and unbundled images", async () => {
    expect(await loadGuide("../../examples/README", "en")).toBeNull();
    for (const href of ["javascript:alert(1)", "data:text/html,x", "file:///tmp/a", "//evil.example/x", "../examples/x.en.md", "https://user:pass@example.com", "getting-started.en.md?x"]) {
      expect(resolveGuideLink(href, "canvas").kind).toBe("blocked");
    }
    expect(resolveGuideLink("#a", "canvas")).toEqual({ kind: "article", id: "canvas", hash: "a" });
    expect(resolveGuideLink("https://example.com/help", "canvas").kind).toBe("external");
    for (const src of ["https://example.com/a.png", "assets/../../a.png", "data:image/png,x", "assets/canvas/missing.en.png"]) expect(resolveGuideImage(src)).toBeNull();
  });

  it("uses Markdown parsing and duplicate-safe Unicode heading ids", () => {
    const parsed = parseGuide("# Привет\n\n## Привет\n\n**Strong** and `code`.\n\n| A | B |\n|---|---|\n| x | y |\n");
    expect(parsed.headings.map(heading => heading.id)).toEqual(["привет", "привет-1"]);
    expect(parsed.searchText).toMatch(/Strong\s+and\s+code/);
  });
});
