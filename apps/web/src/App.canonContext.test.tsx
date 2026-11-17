import type { CanonIssueListResponse } from "@something-to-tell/contracts/canon-check";
import { fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { App } from "./App";
import * as workspaceView from "./app/shell/AppWorkspaceView";
import type { AppWorkspaceViewProps } from "./app/shell/AppWorkspaceView";
import * as canonActions from "./canon/CanonIssueActions";
import { applyProjectLocale } from "./localization/i18n";
import { createRuntimeApiClient } from "./runtime/apiClient";
import { useGraphStore } from "./state/graphStore";
import { createProjectFixtureRuntimeFetch, loadProjectFixturesForTests } from "./testFixtures/projectFixtures";

type CanonInputs = Pick<AppWorkspaceViewProps, "canonError" | "canonIssues" | "canonNotice" | "canonOperation"
  | "openCanonIssueTarget" | "repairCanonIssue" | "reviewCanonIssue">;
let issueList: CanonIssueListResponse;

beforeEach(async () => {
  window.localStorage.clear();
  await applyProjectLocale("en");
  useGraphStore.setState(useGraphStore.getInitialState(), true);
  loadProjectFixturesForTests();
  vi.stubGlobal("fetch", createProjectFixtureRuntimeFetch());
  // Reuse the typed in-memory runtime fixture, never a real provider/session.
  const client = createRuntimeApiClient();
  await client.startCanonRun({
    session_id: "test-context", observed_saved_revision: 1, expected_history_revision: 0,
    mode: "deterministic", remote_consent: false, scope: [], enabled_rule_overrides: {}, severity_overrides: {}
  });
  issueList = await client.listCanonIssues(useGraphStore.getState().activeProjectId);
});
afterEach(() => { vi.restoreAllMocks(); vi.unstubAllGlobals(); });

/** Control just Canon inputs; all other App/view/providers/renderers remain real. */
function renderCanonView(initial: Partial<CanonInputs> = {}) {
  let inputs: CanonInputs = {
    canonError: null, canonIssues: null, canonNotice: null, canonOperation: null,
    openCanonIssueTarget: vi.fn(), repairCanonIssue: vi.fn(), reviewCanonIssue: vi.fn(async () => {}),
    ...initial
  };
  const ActualView = workspaceView.AppWorkspaceView;
  vi.spyOn(workspaceView, "AppWorkspaceView").mockImplementation((props) => <ActualView {...props} {...inputs} />);
  const provider = vi.spyOn(canonActions, "CanonIssueActionProvider");
  const view = render(<App />);
  return {
    provider,
    value: () => provider.mock.calls.at(-1)![0].value,
    inputs: () => inputs,
    update: (next: Partial<CanonInputs>) => { inputs = { ...inputs, ...next }; view.rerender(<App />); }
  };
}

it.each(["empty", "populated"])("preserves %s context identity during rail and modal refreshes", (kind) => {
  const context = renderCanonView({ canonIssues: kind === "populated" ? issueList : null });
  const hero = screen.getByTestId("rf__node-node-hero");
  fireEvent.click(hero);
  const value = context.value();
  const invocations = context.provider.mock.calls.length;
  if (kind === "populated") expect(value.issues).toBe(issueList.issues);
  else expect(value.issues).toEqual([]);
  for (let index = 0; index < 2; index++) {
    fireEvent.click(screen.getByTitle("Projects"));
    expect(context.value()).toBe(value);
  }
  fireEvent.doubleClick(hero);
  expect(context.value()).toBe(value);
  fireEvent.click(screen.getByRole("button", { name: "Close dialog" }));
  expect(context.value()).toBe(value);
  expect(context.provider.mock.calls.length).toBeGreaterThan(invocations);
});

it("propagates operation, error, notice and issue changes without depending on unused list metadata", () => {
  const context = renderCanonView({ canonIssues: issueList });
  const initial = context.value();
  context.update({ canonIssues: { ...issueList, active_count: issueList.active_count + 1 } });
  expect(context.value()).toBe(initial);
  context.update({ canonOperation: "loading" });
  expect(context.value()).toBe(initial);
  context.update({ canonOperation: "running" });
  expect(context.value()).toBe(initial);
  context.update({ canonOperation: "reviewing" });
  expect(context.value()).not.toBe(initial);
  expect(context.value().busy).toBe(true);
  context.update({ canonOperation: "running" });
  expect(context.value().busy).toBe(false);
  context.update({ canonError: "Revision changed" });
  expect(context.value().error).toBe("Revision changed");
  context.update({ canonNotice: "Status updated" });
  expect(context.value().notice).toBe("Status updated");
  const issues = issueList.issues.map((issue) => ({ ...issue, status: "review" as const }));
  context.update({ canonIssues: { ...issueList, issues } });
  expect(context.value().issues).toBe(issues);
  context.update({ canonError: null });
  expect(context.value()).toMatchObject({ error: null, notice: "Status updated" });
  context.update({ canonNotice: null });
  expect(context.value().notice).toBeNull();
  context.update({ canonIssues: null, canonOperation: null });
  expect(context.value()).toMatchObject({ busy: false, error: null, notice: null, issues: [] });
  const empty = context.value();
  context.update({ canonIssues: { ...issueList, issues: [] } });
  expect(context.value()).not.toBe(empty);
  expect(context.value().issues).toEqual([]);
});

it.each(["openCanonIssueTarget", "repairCanonIssue", "reviewCanonIssue"] as const)("uses a replacement %s callback with current arguments", (key) => {
  const context = renderCanonView({ canonIssues: issueList });
  const previous = context.value();
  const oldCallback = context.inputs()[key];
  const next = vi.fn(async () => {});
  context.update({ ...context.inputs(), [key]: next });
  expect(context.value()).not.toBe(previous);
  const issue = issueList.issues[0]!;
  if (key === "openCanonIssueTarget") {
    const owner = issue.metadata.targets[0]!;
    context.value().onNavigate(owner, issue);
    expect(next).toHaveBeenCalledWith(owner, "source", issue);
  } else if (key === "repairCanonIssue") {
    context.value().onRepair(issue);
    expect(next).toHaveBeenCalledWith(issue);
  } else {
    expect(context.value().onReview(issue.id, "ignored")).toBeUndefined();
    expect(next).toHaveBeenCalledWith(issue.id, "ignored");
  }
  expect(oldCallback).not.toHaveBeenCalled();
});
