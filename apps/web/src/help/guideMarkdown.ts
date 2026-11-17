/** Markdown syntax belongs to remark; this owner extracts reader/search metadata. */
import Slugger from "github-slugger";
import { toString } from "mdast-util-to-string";
import remarkGfm from "remark-gfm";
import remarkParse from "remark-parse";
import { unified } from "unified";
import { visit } from "unist-util-visit";
import type { Root } from "mdast";

const parser = unified().use(remarkParse).use(remarkGfm);

export function parseGuide(markdown: string) {
  const tree = parser.parse(markdown);
  const slugger = new Slugger();
  const headings: { id: string; text: string; depth: number }[] = [];
  const links: string[] = [], images: { url: string; alt: string }[] = [];
  const text: string[] = [];
  visit(tree, (node) => {
    if (node.type === "heading") headings.push({ id: slugger.slug(toString(node)), text: toString(node), depth: node.depth });
    if (node.type === "link" || node.type === "definition") links.push(node.url);
    if (node.type === "image") images.push({ url: node.url, alt: node.alt ?? "" });
    if (node.type === "text" || node.type === "inlineCode" || node.type === "code") text.push(node.value);
  });
  return { headings, links, images, searchText: text.join(" ") };
}

/** Reader heading ids share the same slugger as the contents/link validator. */
export function remarkGuideHeadings() {
  return (tree: Root) => {
    const slugger = new Slugger();
    visit(tree, "heading", (node) => {
      node.data = { ...node.data, hProperties: { id: `guide-${slugger.slug(toString(node))}` } };
    });
  };
}
