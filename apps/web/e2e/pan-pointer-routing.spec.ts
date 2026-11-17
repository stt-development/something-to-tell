import { expect, test } from "@playwright/test";
import { readFileSync } from "node:fs";

const css = readFileSync(new URL("../src/styles/base.css", import.meta.url), "utf8");
test("Hand mode routes pointers past inline-enabled nodes, SVG hits and portal buttons, then restores Select controls", async ({ page }) => {
  await page.setContent(`<style>${css} .react-flow{position:absolute;inset:0}.react-flow__pane{position:absolute;inset:0}
    .react-flow__node,.react-flow__edge,.react-flow__edgelabel-renderer{position:absolute;z-index:1;left:100px;width:200px;height:60px}
    .react-flow__node{top:100px}.react-flow__edge{top:200px}.react-flow__edgelabel-renderer{top:300px}
    button{width:200px;height:60px}</style><div class="react-flow pan-canvas"><div class="react-flow__pane"></div>
    <div class="react-flow__node" style="pointer-events:all"><article tabindex="-1"><button id="node" style="pointer-events:auto">Node</button></article></div>
    <svg class="react-flow__edge" style="pointer-events:all"><path id="edge" d="M0 30L200 30" stroke="black" stroke-width="40" style="pointer-events:stroke"/></svg>
    <div class="react-flow__edgelabel-renderer" style="pointer-events:none"><button id="label" style="pointer-events:auto">Label</button></div></div>`);
  // These are native hit tests against the real stylesheet, not jsdom computed-style stubs.
  for (const y of [130, 230, 330]) {
    expect(await page.evaluate((y) => document.elementFromPoint(200, y)?.className, y)).toBe("react-flow__pane");
    await page.mouse.click(200, y);
    expect(await page.evaluate(() => document.activeElement?.closest(".react-flow__node,.react-flow__edgelabel-renderer"))).toBeNull();
  }
  await page.locator(".react-flow").evaluate((root) => root.classList.remove("pan-canvas"));
  expect(await page.evaluate(() => document.elementFromPoint(200, 130)?.id)).toBe("node");
  expect(await page.evaluate(() => document.elementFromPoint(200, 230)?.id)).toBe("edge");
  expect(await page.evaluate(() => document.elementFromPoint(200, 330)?.id)).toBe("label");
  await page.getByRole("button", { name: "Node", exact: true }).click(); await expect(page.locator("#node")).toBeFocused();
});
