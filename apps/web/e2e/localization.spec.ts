import { expect, test } from "./temporaryProject";

test.use({ viewport: { width: 1280, height: 800 } });

/** Uses a unique durable folder so locale persistence is exercised across Close and Open. */
test("persists Russian project UI locale and exposes an immediate localized tooltip", async ({ page, projectDirectory }) => {
  const projectName = `Russian Locale ${Date.now()} ${Math.random().toString(16).slice(2, 8)}`;
  await page.addInitScript(() => localStorage.setItem("stt.ui_locale.v1", "ru"));
  await page.goto("http://127.0.0.1:1420");

  await expect(page.getByRole("heading", { name: "Проекты" })).toBeVisible();
  await page.getByRole("button", { name: "Создать", exact: true }).click();
  const createDialog = page.getByRole("heading", { name: "Создание проекта" }).locator("..").locator("..");
  await createDialog.getByLabel("Родительская папка").fill(projectDirectory);
  await createDialog.getByLabel("Название").fill(projectName);
  await createDialog.getByRole("button", { name: "Создать", exact: true }).click();

  await expect(page.getByRole("heading", { name: projectName })).toBeVisible();
  const searchButton = page.getByRole("button", { name: "Показать фильтры графа" });
  const tooltip = searchButton.locator("..");
  await tooltip.hover();
  await expect(tooltip).toHaveAttribute("data-tooltip", "Показать поиск и фильтры графа");
  const visibleTooltip = page.getByRole("tooltip");
  await expect(visibleTooltip).toHaveText("Показать поиск и фильтры графа");
  const tooltipBounds = await visibleTooltip.boundingBox();
  expect(tooltipBounds).not.toBeNull();
  expect(tooltipBounds!.x).toBeGreaterThanOrEqual(8);
  expect(tooltipBounds!.x + tooltipBounds!.width).toBeLessThanOrEqual(1272);
  expect(tooltipBounds!.y).toBeGreaterThanOrEqual(8);
  expect(tooltipBounds!.y + tooltipBounds!.height).toBeLessThanOrEqual(792);
  expect(await visibleTooltip.evaluate((element) => Number(getComputedStyle(element).zIndex))).toBe(2147483647);

  await searchButton.click();
  await expect(page.getByRole("textbox", { name: "Поиск по графу" })).toBeVisible();
  await expect(page.getByRole("button", { name: "Сбросить фильтры графа" })).toBeVisible();

  await page.getByRole("button", { name: "История", exact: true }).click();
  await expect(page.getByLabel("Документ истории")).toBeVisible();
  await page.getByRole("button", { name: "Граф", exact: true }).click();
  await page.getByRole("button", { name: "Создать первую сцену" }).click();
  await expect(page.getByTestId(/rf__node-/).first()).toBeVisible();
  // Bootstrap completes in Flow; test canonical node creation in an explicit Graph view.
  await expect(page.getByRole("button", { name: "Поток", exact: true })).toHaveAttribute("aria-pressed", "true");
  await page.getByRole("button", { name: "Граф", exact: true }).click();
  await expect(page.locator(".workspace-stage > .react-flow")).not.toHaveClass(/flow-canvas/);

  // The context menu is the shortest real-UI assertion that covers every
  // canonical node kind, including the two translated frame variants.
  const pane = page.locator(".workspace-stage > .react-flow .react-flow__pane");
  // Frames move during Fit; a fixed coordinate can open the node's impact menu.
  const emptyPoint = await pane.evaluate((element) => {
    const bounds = element.getBoundingClientRect();
    for (const y of [16, bounds.height - 16, bounds.height / 2]) {
      for (const x of [bounds.width - 16, bounds.width * 0.75, bounds.width / 2]) {
        if (document.elementFromPoint(bounds.left + x, bounds.top + y) === element) return { x, y };
      }
    }
    return null;
  });
  expect(emptyPoint, "Node creation must right-click empty canvas, not a Scene or overlay").not.toBeNull();
  await pane.click({ button: "right", position: emptyPoint! });
  const nodeMenu = page.getByRole("menu", { name: "Создать узел" });
  await expect(nodeMenu).toBeVisible();
  for (const label of [
    "Персонаж", "Требование", "Результат", "Диалог", "Событие", "Фракция",
    "Предмет", "Факт мира", "Квест", "Контейнер сцены", "Контейнер локации"
  ]) {
    await expect(nodeMenu.getByText(label, { exact: true })).toBeVisible();
  }
  await page
    .getByRole("button", { name: "Сохранить проект", exact: true })
    .click();
  await expect(page.getByText("Сохранено", { exact: true })).toBeVisible();

  await page.getByTitle("Закрыть проект").click();
  await expect(page.getByRole("heading", { name: "Проекты" })).toBeVisible();
  await page.getByRole("button", { name: "Открыть", exact: true }).click();
  const openDialog = page.getByRole("heading", { name: "Открытие проекта" }).locator("..").locator("..");
  await openDialog.getByLabel("Папка проектов").fill(projectDirectory);
  await openDialog.getByRole("button", { name: "Обновить список проектов" }).click();
  await page.getByRole("button", { name: new RegExp(projectName) }).click();

  await expect(page.getByRole("heading", { name: projectName })).toBeVisible();
  await expect(page.getByRole("button", { name: "Показать фильтры графа" })).toBeVisible();
});
