import { openDeepStoryFixture } from "./projectFixture";
import { expect, test } from "./temporaryProject";

const viewports = [
  { width: 1024, height: 720 },
  { width: 1280, height: 800 },
  { width: 1440, height: 900 }
] as const;

for (const viewport of viewports) {
  test(`keeps ten Story branch levels flat at ${viewport.width}x${viewport.height}`, async ({ page }) => {
    await page.setViewportSize(viewport);
    await openDeepStoryFixture(page);
    await page.getByRole("button", { name: "Story", exact: true }).click();

    const story = page.getByLabel("Story document");
    const beats = story.locator(".story-document-beat");
    await expect(beats).toHaveCount(11);
    await expect(story.getByLabel("Branch depth 10")).toBeVisible();
    await expect(beats.last()).toContainText("Narrative text remains full width at branch depth 10.");
    await expect(beats.last().locator(".story-temporal-effects")).toContainText("The deepest branch becomes reachable.");

    const geometry = await story.evaluate((workspace) => {
      const documentElement = workspace.querySelector<HTMLElement>(".story-document");
      const beatElements = [...workspace.querySelectorAll<HTMLElement>(".story-document-beat")];
      if (!documentElement || beatElements.length === 0) throw new Error("Story document geometry is unavailable");
      const boxes = beatElements.map((beat) => beat.getBoundingClientRect());
      return {
        beatStarts: boxes.map((box) => Math.round(box.left)),
        beatWidths: boxes.map((box) => Math.round(box.width)),
        documentFits: documentElement.scrollWidth <= documentElement.clientWidth,
        workspaceFits: workspace.scrollWidth <= workspace.clientWidth
      };
    });

    expect(new Set(geometry.beatStarts).size).toBe(1);
    expect(Math.max(...geometry.beatWidths) - Math.min(...geometry.beatWidths)).toBeLessThanOrEqual(1);
    expect(Math.min(...geometry.beatWidths)).toBeGreaterThan(400);
    expect(geometry.documentFits).toBe(true);
    expect(geometry.workspaceFits).toBe(true);
    if (viewport.width === 1024) {
      const deepestBeat = beats.last();
      await deepestBeat.getByRole("button", { name: "Edit Depth 10: A deliberately readable story beat inline" }).click();
      const editor = deepestBeat.locator(".story-node-inline");
      await expect(editor).toBeVisible();
      const editorFits = await deepestBeat.evaluate((beat) => {
        const panel = beat.querySelector<HTMLElement>(".story-node-inline");
        if (!panel) throw new Error("Story inline editor is unavailable");
        const beatBox = beat.getBoundingClientRect();
        const panelBox = panel.getBoundingClientRect();
        return panelBox.left >= beatBox.left && panelBox.right <= beatBox.right;
      });
      expect(editorFits).toBe(true);
      await page.screenshot({ path: "/tmp/p39-story-inline-editor.png", fullPage: true });
    }
    if (viewport.width === 1440) {
      await page.screenshot({ path: "/tmp/p39-flat-deep-story.png", fullPage: true });
    }
  });
}
