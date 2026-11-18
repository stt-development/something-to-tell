import { openAuroraFixture, openRussianAuroraFixture } from "./projectFixture";
import { expect, test } from "./temporaryProject";

test("reviews Canon evidence, navigation, highlighting, and a fix at 1440x900", async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  await delayCanonRuns(page);
  await openAuroraFixture(page);

  const chooser = page.getByRole("button", { name: "Choose analysis tool" });
  const tooltip = chooser.locator("..");
  await tooltip.hover();
  await expect(tooltip).toHaveAttribute("data-tooltip", "Choose analysis tool");
  await expect(page.getByRole("tooltip")).toHaveText("Choose analysis tool");

  await chooser.click();
  await page.getByRole("menuitem", { name: /Canon check Not run 1/ }).click();
  const workspace = page.getByRole("complementary", { name: "Canon review" });
  await expect(workspace).toBeVisible();
  await expect(workspace.getByRole("button", { name: "Close" })).toBeFocused();
  const issueList = workspace.getByRole("listbox", { name: "Canon issues" });
  const unknownIssue = issueList.getByRole("option", { name: /unknown integrity fact.*graph\.trade-law-source/i });
  await unknownIssue.click();
  await expect(workspace).toContainText("Open the cited owner and inspect the stable fact code");
  const openUnknownSource = workspace
    .getByLabel("Review actions")
    .getByRole("button", { name: "Open source" });
  await openUnknownSource.hover();
  await expect(page.getByRole("tooltip")).toHaveText("Open source");
  await openUnknownSource.click();
  await expect(
    page.getByTestId("rf__node-node-embargo").locator(".narrative-node")
  ).toHaveClass(/narrative-node-canon-info/);
  await page.getByTestId("rf__node-node-embargo").dblclick();
  const embargoEditor = page.getByRole("heading", { name: "Edit node" }).locator("xpath=ancestor::section[1]");
  await expect(embargoEditor).toBeVisible();
  await expect(embargoEditor).toContainText("graph.trade-law-source");
  await embargoEditor.getByRole("button", { name: "Close dialog" }).click();
  await workspace.getByRole("button", { name: "Run" }).click();
  await expect(workspace.getByRole("status")).toContainText("Checking the current story");
  await expect(page.getByRole("button", { name: "Open Canon check" })).toBeVisible();

  const conditionIssues = issueList.getByRole("option", { name: /condition references state/i });
  await conditionIssues.first().dblclick();
  await expect(
    page.getByTestId("rf__node-node-smuggler-route").locator(".narrative-node")
  ).toHaveClass(/narrative-node-canon-warning/);
  await expect(workspace).toContainText(/ledger_(verified|acquired)/);
  const questEditor = page.getByRole("heading", { name: "Edit quest: Smuggler Route" });
  await expect(questEditor).toBeVisible();
  const questDialog = questEditor.locator("xpath=ancestor::section[1]");
  const questDiagnostic = questDialog.locator(".canon-owner-diagnostic-control").first();
  await questDiagnostic.locator("summary").click();
  await expect(questDiagnostic.getByRole("button", { name: "Request suggestion" })).toBeEnabled();
  await questEditor.locator("..").getByRole("button", { name: "Close dialog" }).click();

  await issueList.getByRole("option", { name: /semantic ownership disagrees/i }).first().click();
  const itemTarget = workspace.locator(".canon-owner-list li").filter({
    hasText: "node-sealed-ledger"
  });
  await itemTarget.getByRole("button", { name: "Flow", exact: true }).click();
  await expect(
    page.getByRole("group", { name: "Workspace view" }).getByRole("button", { name: "Flow", exact: true })
  ).toHaveAttribute("aria-pressed", "true");

  await workspace.getByLabel("Filter by target").fill("line-ilya-concedes");
  await expect(issueList.getByRole("option", { name: /dialogue branch has no continuation/i })).toHaveCount(1);
  const dialogueOwner = workspace.locator(".canon-owner-list li").filter({ hasText: "line-ilya-concedes" });
  await dialogueOwner.getByRole("button", { name: "Open source" }).click();
  const dialogueEditor = page.getByRole("heading", { name: "Edit dialogue: Dockmaster Warning" }).locator("xpath=ancestor::section[1]");
  const dialogueTarget = dialogueEditor.locator('[data-canon-issue-target="true"]');
  await expect(dialogueTarget).toHaveAttribute("data-canon-owner-id", "line-ilya-concedes");
  await expect(dialogueTarget.getByText("Canon issue")).toBeVisible();
  const dialogueIssueDetails = dialogueTarget.getByLabel("Issue details");
  await expect(dialogueIssueDetails).toContainText("A dialogue branch has no continuation or external outcome.");
  await expect(dialogueIssueDetails).toContainText("Open the highlighted dialogue element");
  await dialogueIssueDetails.getByRole("button", { name: "Acknowledge" }).click();
  await expect(dialogueIssueDetails).toContainText("Acknowledged");
  await expect(issueList.getByRole("option", { name: /dialogue branch has no continuation/i })).toContainText("Acknowledged");
  await dialogueTarget.locator(".canon-owner-diagnostic-marker").hover();
  const modalTooltip = page.getByRole("tooltip");
  await expect(modalTooltip).toBeVisible();
  const modalTooltipBounds = await modalTooltip.boundingBox();
  expect(modalTooltipBounds).not.toBeNull();
  expect(modalTooltipBounds!.x).toBeGreaterThanOrEqual(8);
  expect(modalTooltipBounds!.x + modalTooltipBounds!.width).toBeLessThanOrEqual(1432);
  expect(modalTooltipBounds!.y).toBeGreaterThanOrEqual(8);
  expect(modalTooltipBounds!.y + modalTooltipBounds!.height).toBeLessThanOrEqual(892);
  expect(await modalTooltip.evaluate((element) => Number(getComputedStyle(element).zIndex))).toBe(2147483647);
  await dialogueTarget.getByRole("textbox").click();
  await expect(dialogueTarget).toHaveClass(/dialogue-canon-issue-target/);
  await page.screenshot({ path: "/tmp/p5-dialogue-canon-target-1440x900.png" });
  await dialogueEditor.getByRole("button", { name: "Close dialog" }).click();
  await expect(dialogueOwner.getByRole("button", { name: "Open source" })).toBeFocused();
  await workspace.getByLabel("Filter by target").fill("");
  await conditionIssues.first().dblclick();
  const currentQuestDialog = page.getByRole("heading", { name: "Edit quest: Smuggler Route", includeHidden: true }).locator("xpath=ancestor::section[1]");
  const currentQuestDiagnostic = currentQuestDialog.locator(".canon-owner-diagnostic-control").first();
  await currentQuestDiagnostic.locator("summary").click();
  await currentQuestDiagnostic.getByRole("button", { name: "Request suggestion" }).click();
  // Canon keeps the draft mounted but hides its editor when the proposal arrives.
  // Clicking Close here raced that handoff and timed out on faster responses.
  await expect(page.locator(".editor-dialog-host")).toHaveAttribute("hidden", "");
  await expect(currentQuestDialog).toHaveCount(1);
  await expect(currentQuestDialog).toBeHidden();
  const proposal = workspace.getByLabel("Proposed forward changes");
  await expect(proposal).toContainText("Declare the referenced state path or revise the condition");
  await expect(proposal).toContainText("quests");
  const impactRequest = page.waitForRequest((request) => request.url().endsWith("/impact-analysis/runs") && request.method() === "POST");
  await proposal.getByRole("button", { name: "Analyze impact" }).click();
  const impact = page.getByRole("complementary", { name: "Impact analysis" });
  await impact.getByRole("button", { name: "Analyze" }).click();
  const request = await impactRequest;
  expect(request.postDataJSON()).toMatchObject({
    scenario: {
      type: "patch",
      patch: { patch_version: 1, source_checksum: expect.any(String) }
    }
  });
  const returnToProposal = impact.getByRole("button", { name: "Return to Proposed forward changes" });
  await expect(returnToProposal).toBeEnabled();
  await returnToProposal.click();
  await expect(proposal.getByRole("button", { name: "Analyze impact" })).toBeFocused();
  await proposal.getByRole("button", { name: "Approve" }).click();
  await expect(workspace).toContainText("Canon fix approved");

  const bounds = await workspace.boundingBox();
  expect(bounds).not.toBeNull();
  expect(bounds!.x).toBeGreaterThanOrEqual(0);
  expect(bounds!.x + bounds!.width).toBeLessThanOrEqual(1440);
  await page.screenshot({ path: "/tmp/p4-canon-workspace-1440x900.png" });
});

test("keeps the complete Canon workflow localized at 1024x720", async ({ page }) => {
  await page.setViewportSize({ width: 1024, height: 720 });
  await delayCanonRuns(page);
  await openRussianAuroraFixture(page);

  await page.getByRole("button", { name: "Выбрать инструмент анализа" }).click();
  await page.getByRole("menuitem", { name: /Проверка канона Не запускалась 1/ }).click();
  const workspace = page.getByRole("complementary", { name: "Проверка канона" });
  await expect(workspace.getByRole("button", { name: "Запустить" })).toBeVisible();
  await expect(workspace).toContainText("graph.trade-law-source");
  await expect(workspace).toContainText("неизвестный факт целостности");
  await workspace.getByRole("button", { name: "Запустить" }).click();
  await expect(workspace.getByRole("status")).toContainText("Проверка текущей истории");
  await expect(workspace).toContainText("Обязательный результат диалога или квеста недостижим");
  await expect(workspace).not.toContainText("canon.issue.");
  await expect(workspace).not.toContainText("{{");
  await expect(workspace.getByLabel("Фильтры замечаний канона")).toBeVisible();

  const bounds = await workspace.boundingBox();
  expect(bounds).not.toBeNull();
  expect(bounds!.x).toBeGreaterThanOrEqual(0);
  expect(bounds!.x + bounds!.width).toBeLessThanOrEqual(1024);
  expect(bounds!.y + bounds!.height).toBeLessThanOrEqual(720);

  await workspace.getByRole("button", { name: "Закрыть" }).click();
  await page.getByTestId("rf__node-node-sealed-ledger").dblclick();
  const editor = page.getByRole("heading", { name: "Изменение узла" }).locator("xpath=ancestor::section[1]");
  await expect(editor).toContainText("Семантическое владение расходится");
  await expect(editor).toContainText("Уточните владение или добавьте временную передачу");
  await expect(editor).not.toContainText("canon.issue.");

  await page.screenshot({ path: "/tmp/p4-canon-workspace-ru-1024x720.png" });
});

/** Keeps the synchronous runtime call observable without replacing its real response. */
async function delayCanonRuns(page: import("@playwright/test").Page): Promise<void> {
  await page.route("**/api/canon-checks/runs", async (route) => {
    await new Promise((resolve) => setTimeout(resolve, 500));
    await route.continue();
  });
}
