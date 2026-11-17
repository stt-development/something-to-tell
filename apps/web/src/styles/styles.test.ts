// @ts-expect-error Vitest supplies Node at runtime; production web types intentionally omit it.
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

// Read authored CSS rather than Vite's transformed module export so this test
// guards ownership and cascade declarations before build-time processing.
const readStyle = (relativePath: string) =>
  readFileSync(new URL(relativePath, import.meta.url), "utf8");

const stylesheetIndex = readStyle("../styles.css");
const engineTagsStyles = readStyle("engine-tags.css");

const orderedModules = [
  "base.css",
  "story.css",
  "story-flow.css",
  "shell-controls.css",
  "scene-analysis.css",
  "canvas-nodes.css",
  "editors.css",
  "canvas-frames.css",
  "playback.css",
  "canon.css",
  "impact.css"
] as const;

const ownedModules = orderedModules.map((fileName) => [fileName, readStyle(fileName)] as const);

describe("frontend style ownership", () => {
  it("declares the stable cascade order before importing owned modules", () => {
    expect(stylesheetIndex).toContain(
      "@layer tailwind-base, tailwind-components, tailwind-utilities, stt-app;"
    );

    const importOffsets = orderedModules.map((fileName) =>
      stylesheetIndex.indexOf(`@import "./styles/${fileName}" layer(stt-app);`)
    );
    expect(importOffsets.every((offset) => offset >= 0)).toBe(true);
    expect(importOffsets).toEqual([...importOffsets].sort((left, right) => left - right));
  });

  it("keeps each feature stylesheet owned and below the hard source limit", () => {
    for (const [fileName, contents] of ownedModules) {
      expect(contents, `${fileName} must declare its owner`).toMatch(/^\/\* .+ \*\//);
      expect(contents.split("\n").length, `${fileName} exceeds 2,000 lines`).toBeLessThanOrEqual(2000);
      expect(contents, `${fileName} must not create an implicit cascade`).not.toContain("@import ");
      expect(contents, `${fileName} must not own Tailwind setup`).not.toContain("@tailwind ");
    }
  });

  it("stretches contextual Engine Tags controls across every entity editor", () => {
    expect(engineTagsStyles).toMatch(
      /\.editor-dialog-host \.engine-tag-picker \{[^}]*width: 100%;[^}]*max-width: none;/
    );
  });

  it("keeps Engine Tags workspace commands aligned to one stable height", () => {
    expect(engineTagsStyles).toMatch(
      /\.engine-tags-command \{[^}]*height: 34px;[^}]*align-items: center;[^}]*line-height: 1;/
    );
    expect(engineTagsStyles).toContain(".engine-tags-command svg { display: block; flex: none; }");
  });

  it("contains long Engine Tag definition keys inside the editor title", () => {
    expect(engineTagsStyles).toMatch(
      /\.engine-tags-definition-key \{[^}]*overflow: hidden;[^}]*text-overflow: ellipsis;[^}]*white-space: nowrap;/
    );
    expect(engineTagsStyles).toContain(".engine-tags-editor-title > div { min-width: 0; flex: 1; }");
  });

  it("sizes the Engine Tags registry against its dialog content, not the viewport", () => {
    expect(engineTagsStyles).toMatch(/\.engine-tags-workspace \{ width: 100%; max-width: 1120px; min-width: 0;/);
    expect(engineTagsStyles).toContain(".engine-tags-layout > * { min-width: 0; }");
    expect(engineTagsStyles).toMatch(/\.engine-tags-binding code \{ overflow-wrap: anywhere;/);
  });
});
