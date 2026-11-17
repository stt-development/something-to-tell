import type { ProjectHistorySummary } from "@something-to-tell/contracts/project-history";
import {
createDefaultProjectSettings,
PROJECT_SETTINGS_VERSION
} from "@something-to-tell/contracts/project-manifest";
import { act,fireEvent,render,screen,waitFor,within } from "@testing-library/react";
import { afterEach,beforeEach,describe,expect,it,vi } from "vitest";
import {
analysisBlocksAutosave,
App,
impactCallerBlockAfterClose,
projectHistoryTooltip,
ProjectStartScreen
} from "./App";
import { applyProjectLocale } from "./localization/i18n";
import { useGraphStore } from "./state/graphStore";
import * as workspaceState from "./app/shell/useWorkspaceState";
import { createProjectFixtureRuntimeFetch,loadProjectFixturesForTests,projectFixture } from "./testFixtures/projectFixtures";
import { NARRATIVE_NODE_KINDS } from "./types";

const PROJECT_AURORA_STORY_FLOWS = projectFixture("aurora").storyFlows;

describe("App shell, sessions, and playback", () => {
beforeEach(async () => {
    window.localStorage.clear();
    await applyProjectLocale("en");
    useGraphStore.setState(useGraphStore.getInitialState(), true);
    loadProjectFixturesForTests();
    vi.stubGlobal("fetch", createProjectFixtureRuntimeFetch());
  });

afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

it("defers autosave while an Impact Resolution proposal is in flight", () => {
    expect(analysisBlocksAutosave(null, "starting", null)).toBe(true);
    expect(analysisBlocksAutosave(null, null, "queued")).toBe(true);
    expect(analysisBlocksAutosave(null, null, "running")).toBe(true);
    expect(analysisBlocksAutosave(null, null, "completed")).toBe(false);
  });

it("starts without a project and resolves the default project directory", async () => {
    useGraphStore.setState(useGraphStore.getInitialState(), true);
    render(<App />);

    expect(screen.getByRole("heading", { name: "Projects" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Create" })).toHaveFocus();
    fireEvent.click(screen.getByRole("button", { name: "Open" }));
    expect(screen.getByRole("heading", { name: "Open project" })).toBeInTheDocument();
    await waitFor(() => expect(screen.getByLabelText("Projects directory")).toHaveValue("/home/author/.narrative"));
    expect(within(screen.getByLabelText("Available projects")).getByRole("button", { name: /Project Aurora/ })).toBeInTheDocument();
  });

it("runs and reviews canon checks from the docked header workspace", async () => {
    const fixtureFetch = createProjectFixtureRuntimeFetch();
    const fetcher = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      const response = await fixtureFetch(input, init);
      if (!String(input).endsWith("/project-sessions/open")) return response;
      const legacy = await response.json();
      // Legacy runtime manifests did not expose Canon settings. Opening the
      // review workspace must remain safe while backend migration catches up.
      delete legacy.document.manifest.settings.canon_check;
      return jsonResponse(legacy);
    });
    vi.stubGlobal("fetch", fetcher);
    render(<App />);
    fireEvent.click(screen.getByRole("button", { name: "Open" }));
    fireEvent.click(await screen.findByRole("button", { name: /Project Aurora/ }));

    const analysisMenuButton = await screen.findByRole("button", { name: "Choose analysis tool" });
    expect(analysisMenuButton.closest(".tooltip-wrapper")).toHaveAttribute("data-tooltip", "Choose analysis tool");
    fireEvent.click(analysisMenuButton);
    const canonMenuItem = within(screen.getByRole("menu", { name: "Analysis tools" })).getByRole("menuitem", { name: /Canon check Not run 0/ });
    fireEvent.click(canonMenuItem);
    expect(screen.getByRole("complementary", { name: "Canon review" })).toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "Run" }));
    expect(await screen.findAllByText(/condition references state/i)).toHaveLength(3);
    await waitFor(() => expect(screen.getByRole("button", { name: "Open Canon check" })).toBeInTheDocument());
    const canonIssue = within(screen.getByRole("listbox", { name: "Canon issues" }))
      .getByRole("option", { name: /condition references state/i });
    fireEvent.click(canonIssue);
    expect(useGraphStore.getState().selection).toEqual({
      id: "project-aurora",
      type: "project"
    });
    fireEvent.doubleClick(canonIssue);
    await waitFor(() => expect(useGraphStore.getState().selection).toEqual({
      id: "node-smuggler-route",
      type: "node"
    }));
    expect(document.querySelector(".narrative-node-canon-critical")).toBeInTheDocument();
    const transitionTarget = screen.getByText("flow-transition-quest-blockade").closest("li");
    expect(transitionTarget).not.toBeNull();
    fireEvent.click(within(transitionTarget!).getByRole("button", { name: "Open source" }));
    await waitFor(() => expect(useGraphStore.getState().selection).toEqual({
      id: "story-flow:flow-transition-quest-blockade",
      type: "edge"
    }));
    expect(within(screen.getByRole("group", { name: "Workspace view" })).getByRole("button", { name: "Flow" }))
      .toHaveAttribute("aria-pressed", "true");
    const transitionPanel = await screen.findByLabelText("Story Flow transition details");
    expect(transitionPanel).toHaveAttribute("data-canon-owner-id", "flow-transition-quest-blockade");
    expect(within(transitionPanel).getByRole("status", { name: /condition references state/i })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Run" })).toBeInTheDocument();

    fireEvent.change(screen.getByLabelText("Status"), { target: { value: "all" } });
    fireEvent.doubleClick(within(screen.getByRole("listbox", { name: "Canon issues" })).getByRole("option", { name: /required Dialogue or Quest outcome/i }));
    const dialogueEditor = (await screen.findByRole("heading", { name: "Edit dialogue: Dockmaster Warning" })).closest("section")!;
    const canonDialogueTarget = dialogueEditor.querySelector<HTMLElement>('[data-canon-issue-target="true"]');
    expect(canonDialogueTarget).toHaveAttribute("data-canon-owner-id", "line-ilya-concedes");
    expect(within(canonDialogueTarget!).getByText("Canon issue")).toBeInTheDocument();
    fireEvent.click(within(canonDialogueTarget!).getByRole("textbox", { name: "Text" }));
    expect(canonDialogueTarget).toHaveClass("dialogue-canon-issue-target");
    fireEvent.click(within(dialogueEditor).getByRole("button", { name: "Close dialog" }));

    fireEvent.doubleClick(within(screen.getByRole("listbox", { name: "Canon issues" })).getByRole("option", { name: /outcome is not owned/i }));
    const questEditor = (await screen.findByRole("heading", { name: "Edit quest: Smuggler Route" })).closest("section")!;
    const questTarget = questEditor.querySelector<HTMLElement>('[data-canon-issue-target="true"]');
    expect(questTarget).toHaveAttribute("data-canon-owner-id", "branch-blockade-route");
    expect(within(questTarget!).getByRole("status", { name: /outcome is not owned/i })).toBeInTheDocument();
    const questDraftInput = within(questTarget!).getByLabelText("Branch label");
    fireEvent.change(questDraftInput, { target: { value: "Unsaved quest draft" } });
    const editorHost = questEditor.closest(".editor-dialog-host");
    fireEvent.click(within(questTarget!).getByRole("button", { name: "Explore solutions" }));
    const editorImpact = await screen.findByRole("complementary", { name: "Impact analysis" });
    expect(editorHost).toHaveAttribute("hidden");
    expect(questEditor).not.toBeVisible();
    fireEvent.click(within(editorImpact).getByRole("button", { name: "Return to Explore solutions" }));
    await waitFor(() => expect(editorHost).not.toHaveAttribute("hidden"));
    expect(questEditor).toBeVisible();
    expect(questDraftInput).toHaveValue("Unsaved quest draft");
    fireEvent.click(within(questEditor).getByRole("button", { name: "Close dialog" }));

    fireEvent.click(screen.getByRole("button", { name: "Explore solutions" }));
    const issueImpact = await screen.findByRole("complementary", { name: "Impact analysis" });
    expect(issueImpact).toHaveTextContent("Explore solutions");
    expect(screen.getByRole("complementary", { name: "Canon review" })).toBeInTheDocument();
    expect(issueImpact.closest(".workspace-stage")).toHaveClass("impact-workspace-open");
    expect(within(issueImpact).getByRole("button", { name: /Resolution review/ })).toHaveAttribute("aria-expanded", "true");
    expect(within(issueImpact).getByRole("button", { name: "Explain findings" })).toBeInTheDocument();
    const bridgeCall = fetcher.mock.calls.find(([input]) => String(input).includes("/canon-checks/issues/") && String(input).endsWith("/impact-analysis"));
    expect(JSON.parse(String(bridgeCall?.[1]?.body))).toMatchObject({
      session_id: "fixture-session:project-aurora",
      expected_history_revision: 0
    });
    fireEvent.click(within(issueImpact).getByRole("button", { name: "Return to Explore solutions" }));
    expect(screen.getByRole("complementary", { name: "Canon review" })).toBeInTheDocument();
    await waitFor(() => expect(screen.getByRole("button", { name: "Explore solutions" })).toHaveFocus());

    fireEvent.doubleClick(within(screen.getByRole("listbox", { name: "Canon issues" })).getByRole("option", { name: /domain integrity check/i }));
    const temporalEditor = (await screen.findByRole("heading", { name: "Edit dialogue: Dockmaster Warning" })).closest("section")!;
    await waitFor(() => expect(temporalEditor.querySelector('[data-canon-owner-id="effect-01-ledger-ilya-to-mara"]')).toHaveAttribute("data-canon-issue-target", "true"));
    expect(within(temporalEditor.querySelector<HTMLElement>('[data-canon-owner-id="effect-01-ledger-ilya-to-mara"]')!).getByRole("status", { name: /domain integrity check/i })).toBeInTheDocument();
    fireEvent.click(within(temporalEditor).getByRole("button", { name: "Close dialog" }));

    fireEvent.click(within(screen.getByRole("listbox", { name: "Canon issues" })).getByRole("option", { name: /condition references state/i }));

    fireEvent.doubleClick(screen.getByTestId("rf__node-node-smuggler-route"));
    const repairEditor = (await screen.findByRole("heading", { name: "Edit quest: Smuggler Route" })).closest("section")!;
    const repairEditorHost = repairEditor.closest(".editor-dialog-host");
    fireEvent.click(screen.getByRole("button", { name: "Request suggestion" }));
    const fixPreview = await screen.findByLabelText("Proposed forward changes");
    expect(repairEditorHost).toHaveAttribute("hidden");
    expect(repairEditor).not.toBeVisible();
    expect(fixPreview).toHaveTextContent("flow_transitions");
    fireEvent.click(within(fixPreview).getByText("flow_transitions"));
    expect(fixPreview).toHaveTextContent("flags.take_smuggler_route == true");
    fireEvent.click(within(fixPreview).getByRole("button", { name: "Analyze impact" }));
    const patchImpact = screen.getByRole("complementary", { name: "Impact analysis" });
    expect(patchImpact).toHaveTextContent("Proposed patch");
    fireEvent.click(within(patchImpact).getByRole("button", { name: "Analyze" }));
    await waitFor(() => expect(fetcher.mock.calls.some(([input]) => String(input).endsWith("/impact-analysis/runs"))).toBe(true));
    const patchImpactCall = fetcher.mock.calls.find(([input]) => String(input).endsWith("/impact-analysis/runs"));
    expect(JSON.parse(String(patchImpactCall?.[1]?.body)).scenario).toMatchObject({
      type: "patch",
      patch: { patch_id: "canon-patch-condition" }
    });
    fireEvent.click(within(patchImpact).getByRole("button", { name: "Return to Proposed forward changes" }));
    await waitFor(() => expect(within(fixPreview).getByRole("button", { name: "Analyze impact" })).toHaveFocus());
    fireEvent.click(within(fixPreview).getByRole("button", { name: "Approve" }));
    await waitFor(() => expect(fetcher.mock.calls.some(([input]) => String(input).endsWith("/canon-checks/suggestions/canon-fix-condition/approve"))).toBe(true));
    expect(await screen.findAllByText("Canon fix approved")).not.toHaveLength(0);

    fireEvent.click(screen.getByRole("button", { name: "Acknowledge" }));
    await waitFor(() => expect(screen.getByText("Acknowledged")).toBeInTheDocument());
    expect(fetcher.mock.calls.some(([input]) => String(input).endsWith("/status"))).toBe(true);

    fireEvent.click(screen.getByRole("button", { name: "Run" }));
    await waitFor(() => expect(fetcher.mock.calls.filter(([input]) => String(input).endsWith("/canon-checks/runs"))).toHaveLength(2));
    expect(fetcher.mock.calls.filter(([input]) => String(input).endsWith("/save"))).toHaveLength(0);
    fireEvent.click(screen.getByRole("button", { name: "Choose analysis tool" }));
    expect(within(screen.getByRole("menu", { name: "Analysis tools" })).getByRole("menuitem", { name: /Canon check Completed 3/ })).toBeInTheDocument();
  }, 15_000);

it("opens Impact Analysis from selection and context actions without obscuring the canvas", async () => {
    const fetcher = vi.fn(createProjectFixtureRuntimeFetch());
    vi.stubGlobal("fetch", fetcher);
    const { container } = render(<App />);
    fireEvent.click(screen.getByRole("button", { name: "Open" }));
    fireEvent.click(await screen.findByRole("button", { name: /Project Aurora/ }));

    const hero = await screen.findByTestId("rf__node-node-hero");
    fireEvent.click(hero);
    const selectionAction = screen.getByRole("button", { name: "Analyze current selection" });
    expect(selectionAction.closest(".tooltip-wrapper")).toHaveAttribute("data-tooltip", "Analyze current selection");
    const tagAction = screen.getByRole("button", { name: "Bind Export ID to selection" });
    expect(tagAction).toHaveAttribute("data-tooltip", "Bind Export ID to selection");
    expect(tagAction.closest(".impact-selection-action")).toBe(selectionAction.closest(".impact-selection-action"));
    fireEvent.click(selectionAction);
    expect(screen.getByRole("complementary", { name: "Impact analysis" })).toHaveTextContent("Mara Vale");
    fireEvent.click(screen.getByRole("button", { name: "Close" }));
    await waitFor(() => expect(selectionAction).toHaveFocus());
    const impactControl = screen.getByRole("button", { name: "Open Impact analysis" });
    fireEvent.click(screen.getByRole("button", { name: "Choose analysis tool" }));
    expect(within(screen.getByRole("menu", { name: "Analysis tools" })).getByRole("menuitem", { name: /Impact analysis Ready 1/ })).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Choose analysis tool" }));
    fireEvent.click(impactControl);

    const impactWorkspace = screen.getByRole("complementary", { name: "Impact analysis" });
    expect(impactWorkspace).toHaveTextContent("Mara Vale");
    expect(container.querySelector(".workspace-stage")).toHaveClass("impact-workspace-open");
    const harbor = screen.getByTestId("rf__node-node-harbor");
    fireEvent.click(harbor);
    expect(impactWorkspace).toHaveTextContent("Glass Harbor");
    expect(impactWorkspace).not.toHaveTextContent("Mara Vale");
    fireEvent.click(hero);
    expect(impactWorkspace).toHaveTextContent("Mara Vale");
    fireEvent.click(screen.getByRole("button", { name: "Analyze" }));
    expect(await screen.findAllByText("owns")).not.toHaveLength(0);
    expect(screen.getByText("Distance 1")).toBeInTheDocument();
    expect(within(impactWorkspace).getByRole("region", { name: "Resolution review" })).toBeInTheDocument();
    fireEvent.click(within(impactWorkspace).getByRole("button", { name: /Resolution review/ }));
    expect(within(impactWorkspace).getByText(/Configure an Impact Resolution provider/)).toBeInTheDocument();
    expect(within(hero).getByRole("img", { name: "Selected Impact Analysis seed." })).toBeInTheDocument();
    expect(fetcher.mock.calls.some(([input]) => String(input).endsWith("/impact-analysis/runs"))).toBe(true);
    expect(fetcher.mock.calls.filter(([input]) => String(input).endsWith("/save"))).toHaveLength(0);

    fireEvent.click(screen.getByRole("button", { name: "Open impact source: owns" }));
    expect(screen.queryByRole("complementary", { name: "Impact analysis" })).not.toBeInTheDocument();
    expect(useGraphStore.getState().selection).toEqual({ id: "edge-guild-ledger", type: "edge" });
    fireEvent.click(screen.getByRole("button", { name: "Open Impact analysis" }));

    fireEvent.click(screen.getByRole("button", { name: "Close" }));
    await waitFor(() => expect(impactControl).toHaveFocus());
    fireEvent.contextMenu(hero, { clientX: 420, clientY: 280 });
    fireEvent.click(screen.getByRole("button", { name: "Analyze selected dependencies" }));
    expect(screen.getByRole("complementary", { name: "Impact analysis" })).toHaveTextContent("Mara Vale");
  });

it("shows only active analysis tools and reopens the last selection", () => {
    render(<App />);
    const chooser = screen.getByRole("button", { name: "Choose analysis tool" });

    fireEvent.keyDown(chooser, { key: "ArrowDown" });
    const menu = screen.getByRole("menu", { name: "Analysis tools" });
    expect(within(menu).getByRole("menuitem", { name: /Impact analysis Ready 0/ })).toHaveFocus();
    expect(within(menu).queryByRole("menuitem", { name: /Scene analysis/ })).not.toBeInTheDocument();
    fireEvent.click(within(menu).getByRole("menuitem", { name: /Canon check Not run 0/ }));
    expect(screen.getByRole("complementary", { name: "Canon review" })).toBeInTheDocument();

    const primary = screen.getByRole("button", { name: "Open Canon check" });
    fireEvent.click(primary);
    expect(screen.queryByRole("complementary", { name: "Canon review" })).not.toBeInTheDocument();
    fireEvent.click(primary);
    expect(screen.getByRole("complementary", { name: "Canon review" })).toBeInTheDocument();
  });

it("localizes the next history command in both project languages", async () => {
    const command = {
      command_id: "update-gatekeeper",
      command_kind: "update_node",
      label_key: "history.command.updateNode",
      label_parameters: { title: "Gatekeeper" }
    };
    expect(projectHistoryTooltip("undo", command)).toBe("Undo Update node");
    await applyProjectLocale("ru");
    expect(projectHistoryTooltip("redo", command)).toBe("Повторить: Изменить узел");
  });

it("keeps stale callers blocked until the same change completes a retry", () => {
    expect(impactCallerBlockAfterClose(null, "delete:hero", "stale")).toBe("delete:hero");
    expect(impactCallerBlockAfterClose("delete:hero", "delete:hero", "cancelled")).toBe("delete:hero");
    expect(impactCallerBlockAfterClose("delete:hero", "delete:other", "completed")).toBe("delete:hero");
    expect(impactCallerBlockAfterClose("delete:hero", "delete:hero", "completed")).toBeNull();
  });

it("runs bounded history shortcuts while preserving native input undo", async () => {
    useGraphStore.setState(useGraphStore.getInitialState(), true);
    const project = cleanProjectSessionResponse();
    const command = {
      command_id: "update-gatekeeper",
      command_kind: "update_node",
      label_key: "history.command.updateNode",
      label_parameters: { title: "Gatekeeper" }
    };
    let history: ProjectHistorySummary = {
      history_version: 1,
      history_revision: 1,
      capacity: 10,
      undo_depth: 1,
      redo_depth: 0,
      next_undo: command,
      next_redo: null
    };
    const fetcher = vi.fn(async (input: string, init?: RequestInit) => {
      if (input.includes("/project-sessions/catalog")) return jsonResponse({
        directory: "/stories",
        is_default: true,
        projects: [{ project_id: "project-clean", name: "Clean Start", description: "", path: "/stories/CleanStart.narrative", format_version: 2, updated_at: project.session.opened_at }]
      });
      if (input.endsWith("/project-sessions/open")) return jsonResponse(project);
      if (input.endsWith("/history") && !init?.method) return jsonResponse(history);
      if (input.endsWith("/history/undo")) {
        history = { ...history, history_revision: 2, undo_depth: 0, redo_depth: 1, next_undo: null, next_redo: command };
        return jsonResponse({ project, history });
      }
      if (input.endsWith("/history/redo")) {
        history = { ...history, history_revision: 3, undo_depth: 1, redo_depth: 0, next_undo: command, next_redo: null };
        return jsonResponse({ project, history });
      }
      return new Response(null, { status: 404 });
    });
    vi.stubGlobal("fetch", fetcher);
    render(<App />);
    fireEvent.click(screen.getByRole("button", { name: "Open" }));
    fireEvent.click(await screen.findByRole("button", { name: /Clean Start/ }));
    const undo = await screen.findByRole("button", { name: "Undo Update node" });

    const input = document.createElement("input");
    document.body.append(input);
    input.focus();
    fireEvent.keyDown(input, { key: "z", ctrlKey: true });
    expect(fetcher.mock.calls.some(([url]) => String(url).endsWith("/history/undo"))).toBe(false);

    fireEvent.keyDown(window, { key: "z", ctrlKey: true });
    const redo = await screen.findByRole("button", { name: "Redo Update node" });
    await waitFor(() => expect(redo).toHaveFocus());
    fireEvent.keyDown(window, { key: "y", ctrlKey: true });
    await waitFor(() => expect(undo).toHaveFocus());
    fireEvent.keyDown(window, { key: "z", ctrlKey: true });
    await waitFor(() => expect(fetcher.mock.calls.filter(([url]) => /\/history\/(undo|redo)$/.test(String(url)))).toHaveLength(3));
    fireEvent.keyDown(window, { key: "z", ctrlKey: true, shiftKey: true });
    await waitFor(() => expect(fetcher.mock.calls.filter(([url]) => /\/history\/(undo|redo)$/.test(String(url)))).toHaveLength(4));

    fireEvent.click(screen.getByRole("button", { name: "Project settings" }));
    await screen.findByRole("heading", { name: "Project settings" });
    fireEvent.keyDown(window, { key: "z", ctrlKey: true });
    expect(fetcher.mock.calls.filter(([url]) => /\/history\/(undo|redo)$/.test(String(url)))).toHaveLength(4);
    fireEvent.keyDown(window, { key: "y", ctrlKey: true });
    fireEvent.keyDown(window, { key: "z", ctrlKey: true, shiftKey: true });
    expect(fetcher.mock.calls.filter(([url]) => /\/history\/(undo|redo)$/.test(String(url)))).toHaveLength(4);
    fireEvent.click(screen.getByRole("button", { name: "Close dialog" }));
    fireEvent.keyDown(window, { key: "z", ctrlKey: true });
    await waitFor(() => expect(fetcher.mock.calls.filter(([url]) => /\/history\/(undo|redo)$/.test(String(url)))).toHaveLength(5));
    await waitFor(() => expect(redo).toBeEnabled());
    fireEvent.click(screen.getByRole("button", { name: "Project settings" }));
    await screen.findByRole("heading", { name: "Project settings" });
    fireEvent.keyDown(window, { key: "y", ctrlKey: true });
    fireEvent.keyDown(window, { key: "z", ctrlKey: true, shiftKey: true });
    expect(fetcher.mock.calls.filter(([url]) => /\/history\/(undo|redo)$/.test(String(url)))).toHaveLength(5);
    fireEvent.click(screen.getByRole("button", { name: "Close dialog" }));
    fireEvent.keyDown(window, { key: "y", ctrlKey: true });
    await waitFor(() => expect(fetcher.mock.calls.filter(([url]) => /\/history\/(undo|redo)$/.test(String(url)))).toHaveLength(6));
    input.remove();
  });

it("restores boot locale after an English project closes", async () => {
    useGraphStore.setState(useGraphStore.getInitialState(), true);
    render(<App />);

    fireEvent.change(screen.getByLabelText("Interface language"), { target: { value: "ru" } });
    expect(await screen.findByRole("heading", { name: "Проекты" })).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Открыть" }));
    const openDialog = screen.getByRole("heading", { name: "Открытие проекта" }).closest("section")!;
    fireEvent.click(await within(openDialog).findByRole("button", { name: /Project Aurora/ }));

    await waitFor(() => expect(screen.getByRole("button", { name: "Project settings" })).toBeEnabled());
    fireEvent.click(screen.getByTitle("Close project"));
    expect(await screen.findByRole("heading", { name: "Проекты" })).toBeInTheDocument();
  });

it("loads projects from a directory entered in the open dialog", async () => {
    useGraphStore.setState(useGraphStore.getInitialState(), true);
    vi.stubGlobal("fetch", vi.fn(async (input: string) => {
      const url = new URL(input);
      const directory = url.searchParams.get("path") ?? "/home/author/.narrative";
      return new Response(JSON.stringify({
        directory,
        is_default: !url.searchParams.has("path"),
        projects: directory === "/mnt/shared-stories"
          ? [{
              project_id: "project-shared",
              name: "Shared Story",
              description: "Discovered outside the default directory",
              path: "/mnt/shared-stories/SharedStory.narrative",
              format_version: 2,
              updated_at: "2026-07-28T00:00:00Z"
            }]
          : []
      }), { headers: { "Content-Type": "application/json" }, status: 200 });
    }));
    render(<ProjectStartScreen />);

    fireEvent.click(screen.getByRole("button", { name: "Open" }));
    const directoryInput = screen.getByLabelText("Projects directory");
    await waitFor(() => expect(directoryInput).toHaveValue("/home/author/.narrative"));
    fireEvent.change(directoryInput, { target: { value: "/mnt/shared-stories" } });
    fireEvent.click(screen.getByRole("button", { name: "Refresh project list" }));

    expect(await screen.findByRole("button", { name: /Shared Story/ })).toBeInTheDocument();
    expect(vi.mocked(fetch)).toHaveBeenLastCalledWith(
      "http://127.0.0.1:8719/api/project-sessions/catalog?path=%2Fmnt%2Fshared-stories",
      undefined
    );
  });

it("selects an Open workspace from the browser directory tree", async () => {
    render(<ProjectStartScreen />);

    fireEvent.click(screen.getByRole("button", { name: "Open" }));
    await waitFor(() => expect(screen.getByLabelText("Projects directory")).toHaveValue("/home/author/.narrative"));
    fireEvent.click(screen.getByTitle("Choose projects directory"));
    await screen.findByRole("heading", { name: "Choose projects directory" });
    fireEvent.click(screen.getByTitle("Parent directory"));
    fireEvent.click(await screen.findByRole("button", { name: "Stories" }));
    fireEvent.click(screen.getByRole("button", { name: "Select folder" }));

    await waitFor(() => expect(screen.getByLabelText("Projects directory")).toHaveValue("/home/author/Stories"));
  });

it("selects a Create parent from the browser directory tree", async () => {
    render(<ProjectStartScreen />);

    await waitFor(() => expect(screen.getByRole("button", { name: "Create" })).toBeEnabled());
    fireEvent.click(screen.getByRole("button", { name: "Create" }));
    fireEvent.click(screen.getByTitle("Choose parent directory"));
    await screen.findByRole("heading", { name: "Choose parent directory" });
    fireEvent.click(screen.getByTitle("Parent directory"));
    fireEvent.click(await screen.findByRole("button", { name: "Stories" }));
    fireEvent.click(screen.getByRole("button", { name: "Select folder" }));

    expect(screen.getByLabelText("Parent directory")).toHaveValue("/home/author/Stories");
  });

it("creates a runtime-owned project with the keyboard and enters its empty workspace", async () => {
    useGraphStore.setState(useGraphStore.getInitialState(), true);
    const response = cleanProjectSessionResponse();
    vi.stubGlobal("fetch", vi.fn(async (input: string) => new Response(JSON.stringify(
      input.includes("/project-sessions/catalog")
        ? { directory: "/home/author/.narrative", is_default: true, projects: [] }
        : response
    ), {
      headers: { "Content-Type": "application/json" },
      status: input.includes("/project-sessions/create") ? 201 : 200
    })));
    render(<ProjectStartScreen />);

    await waitFor(() => expect(screen.getByRole("button", { name: "Create" })).toBeEnabled());
    fireEvent.click(screen.getByRole("button", { name: "Create" }));
    expect(screen.getByLabelText("Parent directory")).toHaveValue("/home/author/.narrative");
    fireEvent.change(screen.getByLabelText("Name"), { target: { value: "Clean Start" } });
    fireEvent.keyDown(screen.getByLabelText("Name"), { key: "Enter" });
    fireEvent.submit(screen.getByLabelText("Name").closest("form")!);

    await waitFor(() => expect(useGraphStore.getState().activeProjectId).toBe("project-clean"));
    expect(useGraphStore.getState()).toMatchObject({
      activeSessionId: "session-clean",
      selection: { type: "project", id: "project-clean" }
    });
    const createCall = vi.mocked(fetch).mock.calls.find(([input]) => String(input).endsWith("/project-sessions/create"));
    expect(JSON.parse(String(createCall?.[1]?.body))).toMatchObject({
      name: "Clean Start",
      path: "/home/author/.narrative/CleanStart.narrative"
    });
  });

it("creates a shared provider and selects independent agent models before creating a project", async () => {
    const fetcher = vi.fn(createProjectFixtureRuntimeFetch());
    vi.stubGlobal("fetch", fetcher);
    render(<ProjectStartScreen />);

    await waitFor(() => expect(screen.getByRole("button", { name: "Create" })).toBeEnabled());
    fireEvent.click(screen.getByRole("button", { name: "Create" }));
    const dialog = screen.getByRole("heading", { name: "Create project" }).closest("section")!;
    const defaultProvider = within(dialog).getByLabelText("Default agent provider settings");
    await waitFor(() => expect(within(defaultProvider).getByRole("button", { name: "Add provider profile" })).toBeEnabled());
    fireEvent.click(within(defaultProvider).getByRole("button", { name: "Add provider profile" }));
    fireEvent.change(within(defaultProvider).getByLabelText("Name", { selector: 'input[name="label"]' }), {
      target: { value: "Startup account" }
    });
    fireEvent.change(within(defaultProvider).getByLabelText("API key"), {
      target: { value: "sk-startup-secret" }
    });
    fireEvent.click(within(defaultProvider).getByRole("button", { name: "Connect and load models" }));

    await waitFor(() => expect(within(defaultProvider).getByLabelText("Default provider profile")).toHaveValue("fixture-provider-openai"));
    fireEvent.change(within(dialog).getByLabelText("Canon agent"), { target: { value: "configured" } });
    const canonProvider = within(dialog).getByLabelText("Canon agent provider settings");
    await within(canonProvider).findByRole("option", { name: "canon-model-v1" });
    expect(within(canonProvider).queryByRole("option", { name: "text-only-v1" })).not.toBeInTheDocument();
    fireEvent.change(within(canonProvider).getByLabelText("Canon model"), { target: { value: "canon-model-v1" } });
    await waitFor(() => expect(within(canonProvider).getByLabelText("Canon model")).toHaveValue("canon-model-v1"));
    fireEvent.change(within(dialog).getByLabelText("Impact Resolution agent"), { target: { value: "configured" } });
    const impactProvider = within(dialog).getByLabelText("Impact Resolution provider settings");
    await within(impactProvider).findByRole("option", { name: "canon-model-v1" });
    fireEvent.change(within(impactProvider).getByLabelText("Impact Resolution model"), { target: { value: "canon-model-v1" } });
    await waitFor(() => expect(within(impactProvider).getByLabelText("Impact Resolution model")).toHaveValue("canon-model-v1"));
    fireEvent.change(within(dialog).getByLabelText("Style Rewriter agent"), { target: { value: "configured" } });
    const styleProvider = within(dialog).getByLabelText("Style Rewriter provider settings");
    await within(styleProvider).findByRole("option", { name: "canon-model-v1" });
    expect(within(styleProvider).getByLabelText("Style Rewriter model")).toHaveValue("");
    fireEvent.change(within(styleProvider).getByLabelText("Style Rewriter model"), { target: { value: "canon-model-v1" } });

    fireEvent.change(within(dialog).getByLabelText("Name", { selector: 'input:not([name])' }), {
      target: { value: "Agent Project" }
    });
    fireEvent.click(within(dialog).getByRole("button", { name: "Create" }));

    await waitFor(() => expect(useGraphStore.getState().activeProjectManifest?.name).toBe("Agent Project"));
    expect(useGraphStore.getState().activeProjectManifest?.settings.canon_check).toMatchObject({
      agent_mode: "configured",
      content_policy: "evidence_only",
      provider_profile_id: "fixture-provider-openai",
      model_preference: "canon-model-v1"
    });
    expect(useGraphStore.getState().activeProjectManifest?.settings).toMatchObject({
      agent_providers: {
        default_provider_profile_id: "fixture-provider-openai",
        agents: {
          canon_checker: { provider_source: "project_default", model_id: "canon-model-v1" },
          impact_resolver: { provider_source: "project_default", model_id: "canon-model-v1" },
          style_rewriter: { provider_source: "project_default", model_id: "canon-model-v1" }
        }
      },
      impact_resolver: { agent_mode: "configured", content_policy: "bounded_evidence" },
      style_system: { agent_mode: "configured", content_policy: "explicit_consent" }
    });
    const profileCall = fetcher.mock.calls.find(([input, init]) => (
      String(input).endsWith("/canon-provider-profiles") && init?.method === "POST"
    ));
    expect(JSON.parse(String(profileCall?.[1]?.body))).toMatchObject({
      session_id: null,
      label: "Startup account",
      api_key: "sk-startup-secret"
    });
  });

it("opens a selected project path and closes back to the clean start screen", async () => {
    useGraphStore.setState(useGraphStore.getInitialState(), true);
    const response = cleanProjectSessionResponse();
    vi.stubGlobal("fetch", vi.fn(async (input: string) => {
      if (input.includes("/project-sessions/catalog")) {
        return new Response(JSON.stringify({
          directory: "/stories",
          is_default: true,
          projects: [{
            project_id: "project-clean",
            name: "Clean Start",
            description: "Loaded from runtime",
            path: "/stories/CleanStart.narrative",
            format_version: 2,
            updated_at: "2026-06-20T00:00:00Z"
          }]
        }), { headers: { "Content-Type": "application/json" }, status: 200 });
      }
      const lifecycle = input.endsWith("/close") ? "closed" : "open";
      return new Response(JSON.stringify({
        ...response,
        session: { ...response.session, lifecycle }
      }), { headers: { "Content-Type": "application/json" }, status: 200 });
    }));
    render(<App />);

    fireEvent.click(screen.getByRole("button", { name: "Open" }));
    const openDialog = screen.getByRole("heading", { name: "Open project" }).closest("section")!;
    fireEvent.click(await within(openDialog).findByRole("button", { name: /Clean Start/ }));

    await waitFor(() => expect(screen.getByRole("heading", { name: "Clean Start" })).toBeInTheDocument());
    expect(vi.mocked(fetch).mock.calls.some(([input]) => String(input).includes("/story-flows"))).toBe(false);
    fireEvent.click(screen.getByTitle("Close project"));
    await waitFor(() => expect(screen.getByRole("heading", { name: "Projects" })).toBeInTheDocument());
    expect(useGraphStore.getState()).toMatchObject({
      activeProjectId: "",
      activeSessionId: null,
      graphs: {},
      projects: [],
      selection: null
    });
    expect(vi.mocked(fetch).mock.calls.map(([input]) => String(input)).filter((input) => input.includes("project-sessions"))).toEqual([
      "http://127.0.0.1:8719/api/project-sessions/catalog",
      "http://127.0.0.1:8719/api/project-sessions/open",
      "http://127.0.0.1:8719/api/project-sessions/session-clean/history",
      "http://127.0.0.1:8719/api/project-sessions/session-clean/close",
      "http://127.0.0.1:8719/api/project-sessions/catalog"
    ]);
  });

it("releases the active session when a non-BFCache page exits", async () => {
    useGraphStore.setState(useGraphStore.getInitialState(), true);
    const response = cleanProjectSessionResponse();
    const fetcher = vi.fn(async (input: string) => {
      if (input.includes("/project-sessions/catalog")) {
        return jsonResponse({
          directory: "/stories",
          is_default: true,
          projects: [{
            project_id: "project-clean",
            name: "Clean Start",
            description: "",
            path: "/stories/CleanStart.narrative",
            format_version: 2,
            updated_at: response.session.opened_at
          }]
        });
      }
      if (input.endsWith("/project-sessions/open")) return jsonResponse(response);
      if (input.endsWith("/project-sessions/session-clean/exit")) {
        return jsonResponse({ ...response.session, lifecycle: "closed" });
      }
      return new Response(null, { status: 404 });
    });
    vi.stubGlobal("fetch", fetcher);
    render(<App />);
    fireEvent.click(screen.getByRole("button", { name: "Open" }));
    fireEvent.click(await screen.findByRole("button", { name: /Clean Start/ }));
    await screen.findByRole("heading", { name: "Clean Start" });

    fireEvent(window, new Event("pagehide"));

    await waitFor(() => expect(fetcher).toHaveBeenCalledWith(
      "http://127.0.0.1:8719/api/project-sessions/session-clean/exit",
      expect.objectContaining({
        body: JSON.stringify({ expected_revision: 0 }),
        keepalive: true,
        method: "POST"
      })
    ));
  });

it("saves manually, autosaves after the configured interval, and protects close", async () => {
    useGraphStore.setState(useGraphStore.getInitialState(), true);
    const initial = cleanProjectSessionResponse();
    let current = initial;
    const fetcher = vi.fn(async (input: string, init?: RequestInit) => {
      if (input.includes("/project-sessions/catalog")) {
        return jsonResponse({
          directory: "/stories",
          is_default: true,
          projects: [{
            project_id: "project-clean",
            name: "Clean Start",
            description: "",
            path: "/stories/CleanStart.narrative",
            format_version: 2,
            updated_at: initial.session.opened_at
          }]
        });
      }
      if (input.endsWith("/project-sessions/open")) return jsonResponse(current);
      if (input.endsWith("/save")) {
        const command = JSON.parse(String(init?.body)) as { expected_revision: number };
        current = {
          ...current,
          session: {
            ...current.session,
            loaded_revision: command.expected_revision + 1,
            saved_revision: command.expected_revision + 1,
            save_status: "clean"
          }
        };
        return jsonResponse(current);
      }
      if (input.endsWith("/discard")) {
        current = initial;
        return jsonResponse(current);
      }
      if (input.endsWith("/close")) {
        return jsonResponse({ ...current, session: { ...current.session, lifecycle: "closed" } });
      }
      return new Response(null, { status: 404 });
    });
    vi.stubGlobal("fetch", fetcher);
    render(<App />);

    fireEvent.click(screen.getByRole("button", { name: "Open" }));
    fireEvent.click(await screen.findByRole("button", { name: /Clean Start/ }));
    await screen.findByRole("heading", { name: "Clean Start" });
    expect(screen.queryByLabelText("Save status")).not.toBeInTheDocument();
    expect(within(screen.getByRole("banner")).queryByText("Saved")).not.toBeInTheDocument();

    const autosave = useGraphStore.getState().activeAutosave!;
    const autosaveConfigRender = vi.spyOn(workspaceState, "useWorkspaceState");
    act(() => useGraphStore.setState({ activeAutosave: { ...autosave, enabled: !autosave.enabled } }));
    act(() => useGraphStore.setState({ activeAutosave: autosave }));
    expect(autosaveConfigRender).not.toHaveBeenCalled();
    autosaveConfigRender.mockRestore();

    const dirtyRender = vi.spyOn(workspaceState, "useWorkspaceState");
    act(() => useGraphStore.getState().markProjectSessionDirty());
    expect(dirtyRender).not.toHaveBeenCalled();
    dirtyRender.mockRestore();
    expect(screen.queryByLabelText("Save status")).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Save project" })).toHaveClass("save-button-reminder");
    const dirtySession = useGraphStore.getState().activeProjectSession;
    const redundantDirtyRender = vi.spyOn(workspaceState, "useWorkspaceState");
    act(() => useGraphStore.getState().markProjectSessionDirty());
    expect(redundantDirtyRender).not.toHaveBeenCalled();
    expect(useGraphStore.getState().activeProjectSession).toBe(dirtySession);
    redundantDirtyRender.mockRestore();
    const timeoutSpy = vi.spyOn(window, "setTimeout");
    const savingRender = vi.spyOn(workspaceState, "useWorkspaceState");
    fireEvent.click(screen.getByRole("button", { name: "Save project" }));
    expect(screen.getByRole("button", { name: "Save project" })).toHaveAttribute("aria-busy", "true");
    expect(savingRender).not.toHaveBeenCalled();
    savingRender.mockRestore();
    await waitFor(() => expect(screen.getByLabelText("Save status")).toHaveTextContent("Saved"));
    const savedTimeout = timeoutSpy.mock.calls.find(([, delay]) => delay === 3_000)?.[0];
    expect(savedTimeout).toBeTypeOf("function");
    // Expiring feedback must not render the workspace or reconstruct canvas props.
    const workspaceRender = vi.spyOn(workspaceState, "useWorkspaceState");
    if (typeof savedTimeout === "function") act(() => savedTimeout());
    expect(screen.queryByLabelText("Save status")).not.toBeInTheDocument();
    expect(workspaceRender).not.toHaveBeenCalled();
    workspaceRender.mockRestore();
    timeoutSpy.mockRestore();

    act(() => useGraphStore.getState().markProjectSessionDirty());
    fireEvent.keyDown(window, { key: "s", ctrlKey: true });
    await waitFor(() => expect(screen.getByLabelText("Save status")).toHaveTextContent("Saved"));

    vi.useFakeTimers();
    act(() => useGraphStore.getState().markProjectSessionDirty());
    await act(async () => vi.advanceTimersByTimeAsync(300_000));
    expect(
      fetcher.mock.calls
        .filter(([input]) => String(input).endsWith("/save"))
        .map(([, init]) => JSON.parse(String(init?.body)).reason)
    ).toEqual(["manual", "manual", "autosave"]);
    vi.useRealTimers();

    act(() => useGraphStore.getState().markProjectSessionDirty());
    fireEvent.click(screen.getByTitle("Close project"));
    expect(screen.getByRole("heading", { name: "Unsaved changes" })).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Discard" }));
    await screen.findByRole("heading", { name: "Projects" });
    expect(fetcher.mock.calls.some(([input]) => String(input).endsWith("/discard"))).toBe(true);
  });

it("offers explicit recovery when the runtime reports an interrupted dirty session", async () => {
    useGraphStore.setState(useGraphStore.getInitialState(), true);
    const response = cleanProjectSessionResponse();
    const fetcher = vi.fn(async (input: string, init?: RequestInit) => {
      if (input.includes("/project-sessions/catalog")) {
        return jsonResponse({
          directory: "/stories",
          is_default: true,
          projects: [{
            project_id: "project-clean",
            name: "Clean Start",
            description: "",
            path: "/stories/CleanStart.narrative",
            format_version: 2,
            updated_at: response.session.opened_at
          }]
        });
      }
      if (input.endsWith("/project-sessions/open")) {
        const command = JSON.parse(String(init?.body)) as { recovery_mode?: string };
        if (!command.recovery_mode || command.recovery_mode === "cancel") {
          return jsonResponse({
            detail: {
              code: "project_recovery_required",
              message_key: "project_session.project_recovery_required",
              parameters: { saved_revision: 0 }
            }
          }, 409);
        }
        return jsonResponse({
          ...response,
          session: { ...response.session, save_status: "dirty" }
        });
      }
      return new Response(null, { status: 404 });
    });
    vi.stubGlobal("fetch", fetcher);
    render(<App />);

    fireEvent.click(screen.getByRole("button", { name: "Open" }));
    fireEvent.click(await screen.findByRole("button", { name: /Clean Start/ }));
    expect(await screen.findByRole("heading", { name: "Recover project" })).toBeInTheDocument();
    const recover = screen.getByRole("button", { name: "Recover changes" });
    await waitFor(() => expect(recover).toBeEnabled());
    fireEvent.click(recover);

    await screen.findByRole("heading", { name: "Clean Start" });
    expect(fetcher.mock.calls).toContainEqual([
      "http://127.0.0.1:8719/api/project-sessions/open",
      expect.objectContaining({ body: expect.stringContaining("\"recovery_mode\":\"recover\"") })
    ]);
  });

it("reports a failed save without advancing the observed revision", async () => {
    const fixture = projectFixture("aurora");
    const baseFetch = createProjectFixtureRuntimeFetch();
    useGraphStore.setState({
      activeAutosave: fixture.response.document.manifest.settings.autosave,
      activeProjectSession: {
        ...fixture.response.session,
        save_status: "dirty"
      },
      activeSessionId: fixture.response.session.session_id
    });
    vi.stubGlobal("fetch", vi.fn(async (input: string, init?: RequestInit) => {
      if (input.endsWith("/save")) {
        return jsonResponse({
          detail: {
            code: "project_save_failed",
            message_key: "project_session.project_save_failed",
            parameters: {}
          }
        }, 400);
      }
      return baseFetch(input, init);
    }));
    render(<App />);

    expect(screen.queryByLabelText("Save status")).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Save project" })).toHaveClass("save-button-reminder");
    // Initial history/Canon reads are unrelated to the isolated save-status window.
    await act(async () => { await Promise.resolve(); });
    const failedSaveRender = vi.spyOn(workspaceState, "useWorkspaceState");
    fireEvent.click(screen.getByRole("button", { name: "Save project" }));

    await waitFor(() => expect(screen.getByText("Save failed")).toBeInTheDocument());
    expect(failedSaveRender).not.toHaveBeenCalled();
    failedSaveRender.mockRestore();
    expect(useGraphStore.getState().activeProjectSession).toMatchObject({
      saved_revision: fixture.response.session.saved_revision,
      save_status: "error"
    });
    fireEvent.click(screen.getByTitle("Close project"));
    expect(screen.getByRole("heading", { name: "Unsaved changes" })).toBeInTheDocument();
    const workspaceRender = vi.spyOn(workspaceState, "useWorkspaceState");
    act(() => useGraphStore.getState().setProjectSessionState({
      ...useGraphStore.getState().activeProjectSession!, save_error: "Updated save failure detail"
    }));
    expect(screen.getByRole("alert")).toHaveTextContent("Updated save failure detail");
    expect(workspaceRender).not.toHaveBeenCalled();
    workspaceRender.mockRestore();
  });

it("deduplicates concurrent manual saves against one observed revision", async () => {
    const fixture = projectFixture("aurora");
    const baseFetch = createProjectFixtureRuntimeFetch();
    useGraphStore.setState({
      activeAutosave: fixture.response.document.manifest.settings.autosave,
      activeProjectSession: { ...fixture.response.session, save_status: "dirty" },
      activeSessionId: fixture.response.session.session_id
    });
    let resolveSave!: (response: Response) => void;
    const pendingSave = new Promise<Response>((resolve) => {
      resolveSave = resolve;
    });
    const fetcher = vi.fn(async (input: string, init?: RequestInit) => {
      if (input.endsWith("/save")) return pendingSave;
      return baseFetch(input, init);
    });
    vi.stubGlobal("fetch", fetcher);
    render(<App />);

    const saveButton = screen.getByRole("button", { name: "Save project" });
    fireEvent.click(saveButton);
    fireEvent.keyDown(window, { key: "s", ctrlKey: true });
    expect(fetcher.mock.calls.filter(([input]) => String(input).endsWith("/save"))).toHaveLength(1);

    resolveSave(jsonResponse({
      ...fixture.response,
      session: {
        ...fixture.response.session,
        loaded_revision: fixture.response.session.saved_revision + 1,
        saved_revision: fixture.response.session.saved_revision + 1,
        save_status: "clean"
      }
    }));
    await waitFor(() => expect(screen.getByLabelText("Save status")).toHaveTextContent("Saved"));
  });

it("reconciles a completed stale save and then closes the project", async () => {
    const fixture = projectFixture("aurora");
    const baseFetch = createProjectFixtureRuntimeFetch();
    const staleSession = {
      ...fixture.response.session,
      loaded_revision: 6,
      saved_revision: 6,
      save_status: "dirty" as const
    };
    const currentResponse = {
      ...fixture.response,
      session: {
        ...fixture.response.session,
        loaded_revision: 7,
        saved_revision: 7,
        save_status: "clean" as const
      }
    };
    useGraphStore.setState({
      activeAutosave: fixture.response.document.manifest.settings.autosave,
      activeProjectSession: staleSession,
      activeSessionId: fixture.response.session.session_id
    });
    const fetcher = vi.fn(async (input: string, init?: RequestInit) => {
      if (input.endsWith("/save")) {
        return jsonResponse({
          detail: {
            code: "project_save_revision_stale",
            message_key: "project_session.project_save_revision_stale",
            parameters: { expected_revision: 6, saved_revision: 7 }
          }
        }, 409);
      }
      if (input.endsWith(`/project-sessions/${encodeURIComponent(fixture.response.session.session_id)}`)) {
        return jsonResponse(currentResponse);
      }
      if (input.endsWith("/close")) {
        return jsonResponse({
          ...currentResponse,
          session: { ...currentResponse.session, lifecycle: "closed" }
        });
      }
      return baseFetch(input, init);
    });
    vi.stubGlobal("fetch", fetcher);
    render(<App />);

    fireEvent.click(screen.getByRole("button", { name: "Save project" }));
    await waitFor(() => expect(useGraphStore.getState().activeProjectSession).toMatchObject({
      saved_revision: 7,
      save_status: "clean"
    }));
    fireEvent.click(screen.getByTitle("Close project"));
    await screen.findByRole("heading", { name: "Projects" });
    expect(fetcher.mock.calls.filter(([input]) => String(input).endsWith("/save"))).toHaveLength(1);
    expect(fetcher.mock.calls.some(([input]) => String(input).endsWith("/close"))).toBe(true);
  });

it("renders the light canvas, project rail, and toolbar", () => {
    render(<App />);

    expect(screen.getAllByText("Project Aurora")).toHaveLength(2);
    expect(screen.getAllByRole("button", { name: "Open" })).toHaveLength(1);
    expect(screen.getByRole("button", { name: "Show graph filters" })).toBeInTheDocument();
    expect(screen.queryByLabelText("Search graph")).not.toBeInTheDocument();
    const sceneTool = screen.getByRole("button", { name: "Scene Frame" });
    expect(sceneTool).toBeInTheDocument();
    expect(sceneTool.closest(".tooltip-wrapper")).toHaveAttribute("data-tooltip", "Scene Frame");
    expect(screen.getByRole("button", { name: "Pan canvas" }).querySelector("svg")).toHaveClass("lucide-hand");
    expect(screen.queryByTitle("Connect by dragging handles")).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /Citadel Branch/ })).not.toBeInTheDocument();
    expect(screen.getByText("16 nodes / 10 relations / 5 transitions")).toBeInTheDocument();
    const dialogueCard = screen.getByTestId("rf__node-node-dock-dialogue");
    const characterCard = screen.getByTestId("rf__node-node-hero");
    const sceneFrame = screen.getByTestId("rf__node-node-opening");
    const locationFrame = screen.getByTestId("rf__node-node-harbor");
    const factionCard = screen.getByTestId("rf__node-node-trade-guild");
    const requirementCard = screen.getByTestId("rf__node-node-ledger-condition");
    const outcomeCard = screen.getByTestId("rf__node-node-route-consequence");
    const questCard = screen.getByTestId("rf__node-node-smuggler-route");
    const loreCard = screen.getByTestId("rf__node-node-embargo");
    const itemCard = screen.getByTestId("rf__node-node-sealed-ledger");
    const eventCard = screen.getByTestId("rf__node-node-inspection");
    const linkedDockmasterCard = screen.getByTestId("rf__node-placement:seed-ilya-opening");
    for (const kind of NARRATIVE_NODE_KINDS) {
      const cards = document.querySelectorAll(`.narrative-node[data-node-kind="${kind}"]`);
      expect(cards.length, `${kind} chrome`).toBeGreaterThan(0);
      for (const card of cards) {
        expect(card.querySelector(".narrative-node-title")).toBeInTheDocument();
        expect(card.querySelector(".narrative-node-title-meta")).toBeInTheDocument();
        expect(card.querySelector(".narrative-node-content")).toBeInTheDocument();
      }
    }
    expect(characterCard.querySelector(".narrative-node-title-meta .issue-badge")).toBeInTheDocument();
    expect(linkedDockmasterCard.querySelector(".narrative-node-title-meta .linked-instance-indicator")).toBeInTheDocument();
    expect(sceneFrame.querySelectorAll(".narrative-frame-actions > button")).toHaveLength(9);
    expect(within(sceneFrame).getByRole("button", { name: "Add linked node to Opening Dock" }).querySelector("svg")).toHaveClass("lucide-link2");
    expect(within(locationFrame).getByRole("button", { name: "Add linked node to Glass Harbor" }).querySelector("svg")).toHaveClass("lucide-link2");
    expect(within(sceneFrame).getByRole("button", { name: "Continue from Opening Dock" }).querySelector("svg")).toHaveClass("lucide-plus");
    expect(within(sceneFrame).getByRole("button", { name: "Call a Story Flow from Opening Dock" })).toHaveAttribute(
      "data-tooltip",
      "Call a Story Flow from Opening Dock"
    );
    expect(within(sceneFrame).getByRole("button", { name: "Create named exit from Opening Dock" })).toHaveAttribute(
      "data-tooltip",
      "Create named exit from Opening Dock"
    );
    expect(characterCard.querySelector(".narrative-node-title")).toHaveTextContent("Character: Mara Vale");
    expect(characterCard.querySelector(".narrative-node-title svg")).toBeInTheDocument();
    expect(sceneFrame.querySelector(".narrative-node-title")).toHaveTextContent("Scene Frame: Opening Dock");
    const sceneDescription = within(sceneFrame).getByLabelText("Description for Opening Dock");
    expect(sceneDescription).toHaveTextContent("First playable scene where the embargo is revealed.");
    expect(sceneDescription).not.toHaveAttribute("data-preview");
    expect(within(locationFrame).getByLabelText("Description for Glass Harbor")).not.toHaveAttribute("data-preview");
    expect(within(sceneFrame).getByRole("button", { name: "Show description for Opening Dock" })).toHaveAttribute("data-tooltip", "Show description");
    expect(within(factionCard).getByLabelText("1 faction member")).toHaveTextContent("Mara Vale");
    expect(requirementCard.querySelector(".narrative-node-title")).toHaveTextContent("Requirement: Ledger Acquired");
    expect(within(requirementCard).getByLabelText("Requirement details")).toHaveTextContent("RequirementEventMara Vale has acquired the Sealed Ledger");
    expect(outcomeCard.querySelector(".narrative-node-title")).toHaveTextContent("Outcome: Route Reopened");
    expect(within(outcomeCard).getByLabelText("Outcome details")).toHaveTextContent("EventOutcomeThe legal departure route through Glass Harbor becomes available.");
    expect(within(characterCard).getByLabelText("Character details")).toHaveTextContent("Role: Protagonist and smuggler captain2 relationships");
    expect(within(characterCard).getByLabelText("Tags for Mara Vale")).toHaveAttribute("data-preview", "crew, voice");
    expect(within(linkedDockmasterCard).getByLabelText("Character details")).toHaveTextContent("Role: Harbor authority and reluctant gatekeeper");
    expect(within(questCard).getByLabelText("Quest details")).toHaveTextContent("2 stages3 branches · 1 req · 1 reward");
    expect(within(questCard).getByLabelText("Tags for Smuggler Route")).toHaveAttribute("data-preview", "branch, travel");
    expect(within(loreCard).getByLabelText("Lore details")).toHaveTextContent("Canon fact1 relationship");
    expect(within(loreCard).getByLabelText("Tags for Silver Embargo")).toHaveAttribute("data-preview", "economy, constraint");
    expect(within(itemCard).getByLabelText("Item details")).toHaveTextContent("Purpose: Proof that the embargo order was manipulated2 placements");
    expect(within(eventCard).getByLabelText("Event details")).toHaveTextContent("Narrative event1 in / 1 out");
    fireEvent.mouseEnter(sceneDescription);
    expect(sceneFrame).not.toHaveClass("issue-tooltip-active");
    fireEvent.mouseLeave(sceneDescription);
    expect(sceneFrame).not.toHaveClass("issue-tooltip-active");
    const linkedMarker = within(linkedDockmasterCard).getByLabelText("Linked visual instance");
    fireEvent.mouseEnter(linkedMarker);
    expect(linkedDockmasterCard).toHaveClass("issue-tooltip-active");
    fireEvent.mouseLeave(linkedMarker);
    expect(linkedDockmasterCard).not.toHaveClass("issue-tooltip-active");
    expect(within(dialogueCard).getByTitle("2 participants")).toBeInTheDocument();
    expect(within(dialogueCard).getByTitle("4 lines")).toBeInTheDocument();
    expect(within(dialogueCard).getByTitle("1 choice")).toBeInTheDocument();
    expect(within(dialogueCard).getByTitle("1 ending")).toBeInTheDocument();
  });

it("plays Project Aurora as slides and returns focus to the authoring projection", async () => {
    render(<App />);

    const playButton = screen.getByRole("button", { name: "Play Main Story" });
    fireEvent.click(playButton);
    expect(screen.getByLabelText("Playback workspace")).toBeInTheDocument();
    expect(screen.getByText("Runtime")).toBeInTheDocument();
    expect(await screen.findByLabelText("Scene slide: Opening Dock")).toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: /Begin inspection/ }));
    expect(await screen.findByLabelText("Dialogue slide: Dockmaster Warning")).toBeInTheDocument();
    expect(screen.getByLabelText("Latest state changes")).toHaveTextContent("sealed ledger");
    expect(screen.getByRole("button", { name: /Order the crew to run the blockade/ })).toBeEnabled();
    expect(screen.getByRole("button", { name: /Show Ilya the sealed ledger/ })).toBeEnabled();

    await waitFor(() => expect(screen.getByRole("button", { name: /Show Ilya the sealed ledger/ })).toBeEnabled());
    fireEvent.click(screen.getByRole("button", { name: /Show Ilya the sealed ledger/ }));
    expect(await screen.findByText("Those seals are genuine. I will delay the patrol while you depart.")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: /Present the ledger/ }));
    expect(await screen.findByLabelText("Event slide: Harbor Inspection")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: /Embargo disproved/ }));
    expect(await screen.findByText("Ending reached")).toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "Exit Playback" }));
    expect(screen.getByRole("button", { name: "Graph" })).toHaveAttribute("aria-pressed", "true");
    await waitFor(() => expect(screen.getByRole("button", { name: "Play Main Story" })).toHaveFocus());
  });

it("never mutates authored Graph or Story Flow records during Playback", async () => {
    const graphBefore = JSON.stringify(useGraphStore.getState().graphs["project-aurora"]);
    const flowsBefore = JSON.stringify(PROJECT_AURORA_STORY_FLOWS);
    render(<App />);

    fireEvent.click(screen.getByRole("button", { name: "Play Main Story" }));
    await screen.findByLabelText("Scene slide: Opening Dock");
    fireEvent.click(screen.getByRole("button", { name: /Begin inspection/ }));
    await screen.findByLabelText("Dialogue slide: Dockmaster Warning");
    fireEvent.click(screen.getByRole("button", { name: /Order the crew to run the blockade/ }));
    await screen.findByRole("button", { name: /Run the blockade/ });
    fireEvent.click(screen.getByRole("button", { name: /Run the blockade/ }));
    await screen.findByLabelText("Event slide: Run the Blockade");
    fireEvent.click(screen.getByRole("button", { name: "Back" }));
    await screen.findByRole("button", { name: /Run the blockade/ });
    fireEvent.click(screen.getByRole("button", { name: "Restart" }));
    await screen.findByLabelText("Scene slide: Opening Dock");
    fireEvent.click(screen.getByRole("button", { name: "Exit Playback" }));

    expect(JSON.stringify(useGraphStore.getState().graphs["project-aurora"])).toBe(graphBefore);
    expect(JSON.stringify(PROJECT_AURORA_STORY_FLOWS)).toBe(flowsBefore);
  });

it("inspects Playback state and restores deterministic boundaries with Back and Restart", async () => {
    render(<App />);
    fireEvent.click(screen.getByRole("button", { name: "Play Main Story" }));
    await screen.findByLabelText("Scene slide: Opening Dock");
    expect(screen.getByRole("button", { name: "Back" })).toBeDisabled();

    fireEvent.click(screen.getByRole("button", { name: /Begin inspection/ }));
    await screen.findByLabelText("Dialogue slide: Dockmaster Warning");
    fireEvent.click(screen.getByRole("button", { name: "Diagnostics" }));
    expect(screen.getByLabelText("Playback trace")).toHaveTextContent("Step 1Opening DockBegin inspection");
    fireEvent.click(screen.getByRole("tab", { name: "State" }));
    expect(screen.getByLabelText("Playback state")).toHaveTextContent("Sealed Ledger");
    fireEvent.click(screen.getByRole("button", { name: "Close diagnostics" }));

    fireEvent.click(screen.getByRole("button", { name: /Show Ilya the sealed ledger/ }));
    await screen.findByText("Those seals are genuine. I will delay the patrol while you depart.");
    fireEvent.click(screen.getByRole("button", { name: /Present the ledger/ }));
    expect(await screen.findByLabelText("Event slide: Harbor Inspection")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Back" }));
    expect(await screen.findByLabelText("Dialogue slide: Dockmaster Warning")).toBeInTheDocument();
    expect(screen.getByText("Returned to Dockmaster Warning.")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Back" }));
    expect(await screen.findByRole("button", { name: /Show Ilya the sealed ledger/ })).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Back" }));
    expect(await screen.findByLabelText("Scene slide: Opening Dock")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Back" })).toBeDisabled();

    fireEvent.click(screen.getByRole("button", { name: /Begin inspection/ }));
    await screen.findByLabelText("Dialogue slide: Dockmaster Warning");
    fireEvent.click(screen.getByRole("button", { name: "Restart" }));
    expect(await screen.findByLabelText("Scene slide: Opening Dock")).toBeInTheDocument();
    expect(screen.getByText("Restarted at Opening Dock.")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Back" })).toBeDisabled();
  });

it("round-trips Playback sources through Flow, Story, and specialized editors", async () => {
    render(<App />);
    fireEvent.click(screen.getByRole("button", { name: "Play Main Story" }));
    await screen.findByLabelText("Scene slide: Opening Dock");
    fireEvent.click(screen.getByRole("button", { name: /Begin inspection/ }));
    await screen.findByLabelText("Dialogue slide: Dockmaster Warning");
    fireEvent.click(screen.getByRole("button", { name: "Diagnostics" }));
    fireEvent.click(within(screen.getByLabelText("Playback trace")).getByRole("button", { name: "Transition" }));

    expect(screen.getByRole("button", { name: /^Flow$/ })).toHaveAttribute("aria-pressed", "true");
    expect(screen.getByLabelText("Story Flow transition details")).toHaveTextContent("Begin inspection");
    fireEvent.click(screen.getByRole("button", { name: "Return to Playback" }));
    expect(screen.getByLabelText("Dialogue slide: Dockmaster Warning")).toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "Open source in Story" }));
    expect(screen.getByRole("button", { name: /^Story$/ })).toHaveAttribute("aria-pressed", "true");
    await waitFor(() => {
      expect(screen.getAllByLabelText("Dialogue: Dockmaster Warning").some((element) => element === document.activeElement)).toBe(true);
    });
    fireEvent.click(screen.getByRole("button", { name: "Return to Playback" }));

    fireEvent.click(screen.getByRole("button", { name: "Open source in Edit" }));
    expect(screen.getByRole("heading", { name: "Edit dialogue: Dockmaster Warning" })).toBeInTheDocument();
    fireEvent.click(screen.getByTitle("Close dialog"));
    fireEvent.click(screen.getByRole("button", { name: "Return to Playback" }));
    expect(screen.getByLabelText("Dialogue slide: Dockmaster Warning")).toBeInTheDocument();
  });

it("blocks a changed authoring definition until an explicit Playback restart", async () => {
    render(<App />);
    fireEvent.click(screen.getByRole("button", { name: "Play Main Story" }));
    await screen.findByLabelText("Scene slide: Opening Dock");
    fireEvent.click(screen.getByRole("button", { name: /Begin inspection/ }));
    await screen.findByLabelText("Dialogue slide: Dockmaster Warning");
    fireEvent.click(screen.getByRole("button", { name: "Open source in Graph" }));

    fireEvent.doubleClick(screen.getByTestId("rf__node-node-opening"));
    const dialog = screen.getByRole("heading", { name: "Edit node" }).closest("section")!;
    fireEvent.change(within(dialog).getByLabelText("Text"), {
      target: { value: "Revised while the Playback session is suspended." }
    });
    fireEvent.click(within(dialog).getByRole("button", { name: "Save" }));
    fireEvent.click(screen.getByRole("button", { name: "Return to Playback" }));

    expect(await screen.findByLabelText("Playback blocked")).toHaveTextContent("Authored source changed");
    expect(screen.getByRole("button", { name: /^Back$/ })).toBeDisabled();
    fireEvent.click(screen.getByRole("button", { name: "Restart" }));
    expect(await screen.findByLabelText("Scene slide: Opening Dock")).toHaveTextContent(
      "Revised while the Playback session is suspended."
    );
    expect(screen.getByRole("button", { name: /^Back$/ })).toBeDisabled();
  });

it("opens Dialogue, Quest, effect, and ending-fact owners in their exact authoring surfaces", async () => {
    render(<App />);
    fireEvent.click(screen.getByRole("button", { name: "Play Main Story" }));
    await screen.findByLabelText("Scene slide: Opening Dock");
    fireEvent.click(screen.getByRole("button", { name: /Begin inspection/ }));
    await screen.findByLabelText("Dialogue slide: Dockmaster Warning");
    fireEvent.click(screen.getByRole("button", { name: "Diagnostics" }));
    fireEvent.click(within(screen.getByLabelText("Playback trace")).getByRole("button", {
      name: /Open effect source/
    }));
    expect(screen.getByLabelText("Story Flow transition details")).toHaveTextContent("Begin inspection");
    fireEvent.click(screen.getByRole("button", { name: "Return to Playback" }));

    await waitFor(() => expect(screen.getByRole("button", { name: /Show Ilya the sealed ledger/ })).toBeEnabled());
    fireEvent.click(screen.getByRole("button", { name: /Show Ilya the sealed ledger/ }));
    await screen.findByText("Those seals are genuine. I will delay the patrol while you depart.");
    fireEvent.click(screen.getByRole("button", { name: /Present the ledger/ }));
    await screen.findByLabelText("Event slide: Harbor Inspection");
    fireEvent.click(screen.getByRole("button", { name: /Embargo disproved/ }));
    await screen.findByText("Ending reached");
    fireEvent.click(screen.getByRole("button", { name: "Diagnostics" }));
    fireEvent.click(screen.getByRole("tab", { name: "Facts" }));
    fireEvent.click(within(screen.getByLabelText("Playback facts")).getByRole("button", { name: "Open source" }));
    expect(screen.getByRole("heading", { name: "Edit node" })).toBeInTheDocument();
    expect(screen.getByLabelText("Label")).toHaveValue("Route Reopened");
    fireEvent.click(screen.getByTitle("Close dialog"));
    fireEvent.click(screen.getByRole("button", { name: "Return to Playback" }));
    fireEvent.click(screen.getByRole("button", { name: "Exit Playback" }));

    fireEvent.click(screen.getByRole("button", { name: "Open Story Flow Smuggler Route" }));
    fireEvent.click(screen.getByRole("button", { name: "Play Smuggler Route" }));
    await screen.findByLabelText("Quest slide: Smuggler Route");
    fireEvent.click(screen.getByRole("button", { name: "Open source in Edit" }));
    expect(screen.getByRole("heading", { name: "Edit quest: Smuggler Route" })).toBeInTheDocument();
  });

it("switches between immutable Graph, Story, and Flow projections", async () => {
    const graphBefore = useGraphStore.getState().getActiveGraph();
    render(<App />);

    const flowButton = screen.getByRole("button", { name: "Flow" });
    const storyButton = screen.getByRole("button", { name: "Story" });
    const relationshipsButton = screen.getByRole("button", { name: "Graph" });
    expect(relationshipsButton).toHaveAttribute("aria-pressed", "true");
    expect(screen.queryByRole("button", { name: "Composition" })).not.toBeInTheDocument();

    fireEvent.click(flowButton);
    expect(flowButton).toHaveAttribute("aria-pressed", "true");
    expect(screen.getByText("7 members / 5 transitions")).toBeInTheDocument();
    expect(screen.getByLabelText("Flow summary")).toHaveTextContent("Main Story");
    fireEvent.click(screen.getByRole("button", { name: "Show graph filters" }));
    expect(screen.queryByLabelText("Flow summary")).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Hide graph filters" }));
    expect(screen.getByLabelText("Flow summary")).toHaveTextContent("Main Story");
    expect(screen.getByTestId("rf__node-node-opening")).toBeInTheDocument();
    expect(screen.queryByTestId("rf__node-node-hero")).not.toBeInTheDocument();
    expect(screen.queryByRole("spinbutton", { name: "Canvas zoom percentage" })).not.toBeInTheDocument();
    expect(document.querySelector(".canvas-zoom-control output")).toHaveTextContent(/^\d+%$/);
    const summaryRender = vi.spyOn(workspaceState, "useWorkspaceState");
    const originalFlowNode = screen.getByTestId("rf__node-node-opening");
    fireEvent.click(within(screen.getByLabelText("Flow summary")).getByRole("button", { name: "Hide Flow summary" }));
    expect(summaryRender).not.toHaveBeenCalled();
    expect(screen.getByTestId("rf__node-node-opening")).toBe(originalFlowNode);
    expect(screen.queryByLabelText("Flow summary")).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Show graph filters" }));
    fireEvent.click(screen.getByRole("button", { name: "Hide graph filters" }));
    expect(screen.queryByLabelText("Flow summary")).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Show Flow summary" }));
    expect(screen.getByLabelText("Flow summary")).toHaveTextContent("Main Story");
    expect(summaryRender).not.toHaveBeenCalled();
    summaryRender.mockRestore();

    fireEvent.click(storyButton);
    expect(storyButton).toHaveAttribute("aria-pressed", "true");
    expect(screen.getByLabelText("Story document")).toHaveTextContent("Opening Dock");
    expect(screen.getAllByLabelText("Branch depth 1").length).toBeGreaterThan(0);
    expect(screen.getByText("11 beats / 3 transitions")).toBeInTheDocument();
    const calledFlow = screen.getByLabelText("Called Story Flow: Smuggler Route");
    expect(calledFlow).toHaveTextContent("Main StorySmuggler Route");
    expect(screen.getByLabelText("Named exit: Patrol evaded")).toHaveTextContent("Returns to Route Reopened");
    const collapseCall = within(calledFlow).getByRole("button", { name: "Collapse called flow Smuggler Route" });
    fireEvent.click(collapseCall);
    expect(screen.queryByLabelText("Quest: Smuggler Route")).not.toBeInTheDocument();
    fireEvent.click(within(calledFlow).getByRole("button", { name: "Expand called flow Smuggler Route" }));
    expect(screen.getAllByLabelText("Quest: Smuggler Route").length).toBeGreaterThan(0);
    expect(screen.queryByRole("button", { name: "Show graph filters" })).not.toBeInTheDocument();
    expect(screen.queryByTestId("rf__node-node-opening")).not.toBeInTheDocument();

    fireEvent.click(relationshipsButton);
    expect(screen.getByText("16 nodes / 10 relations / 5 transitions")).toBeInTheDocument();
    expect(useGraphStore.getState().getActiveGraph()).toEqual(graphBefore);
    await waitFor(() => expect(window.localStorage.getItem("stt.workspace.preferences.v1")).toContain('"mode":"relationships"'));
  });

it("migrates a removed Composition workspace preference back to Graph", () => {
    window.localStorage.setItem(
      "stt.workspace.preferences.v1",
      JSON.stringify({ "project-aurora": { mode: "composition", activeFlowId: "flow-main-story" } })
    );

    render(<App />);

    expect(screen.getByRole("button", { name: "Graph" })).toHaveAttribute("aria-pressed", "true");
    expect(screen.queryByRole("button", { name: "Composition" })).not.toBeInTheDocument();
  });

it("edits canonical text and transition labels from the Story document", () => {
    render(<App />);
    fireEvent.click(screen.getByRole("button", { name: "Story" }));

    const opening = screen.getByRole("article", { name: "Scene: Opening Dock" });
    fireEvent.click(within(opening).getByRole("button", { name: "Edit Opening Dock inline" }));
    fireEvent.change(within(opening).getByLabelText("Title"), { target: { value: "Opening Dock Revised" } });
    fireEvent.change(within(opening).getByLabelText("Description"), { target: { value: "Revised opening prose." } });
    fireEvent.click(within(opening).getByRole("button", { name: "Save text" }));
    expect(useGraphStore.getState().getActiveGraph().nodes.find((node) => node.id === "node-opening")?.data).toMatchObject({
      title: "Opening Dock Revised",
      summary: "Revised opening prose."
    });

    const dialogue = screen.getAllByRole("article", { name: "Dialogue: Dockmaster Warning" })[0]!;
    fireEvent.click(within(dialogue).getByRole("button", { name: "Edit transition to Dockmaster Warning" }));
    fireEvent.change(within(dialogue).getByLabelText("Transition label"), { target: { value: "Enter the revised inspection" } });
    fireEvent.click(within(dialogue).getByRole("button", { name: "Save transition" }));
    expect(within(dialogue).getByText("Enter the revised inspection")).toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "Graph" }));
    expect(screen.getByTestId("rf__node-node-opening")).toHaveTextContent("Opening Dock Revised");
  });
});

function cleanProjectSessionResponse() {
  const timestamp = "2026-07-28T10:00:00Z";
  return {
    session: {
      session_version: 1,
      session_id: "session-clean",
      project_id: "project-clean",
      project_path: "/stories/CleanStart.narrative",
      storage_mode: "local_sqlite",
      loaded_revision: 0,
      saved_revision: 0,
      save_status: "clean",
      lifecycle: "open",
      opened_at: timestamp,
      last_saved_at: timestamp,
      save_error: null
    },
    document: {
      document_version: 5,
      checksum: "checksum",
      manifest: {
        format_version: 2,
        project_id: "project-clean",
        name: "Clean Start",
        description: "",
        created_at: timestamp,
        updated_at: timestamp,
        saved_revision: 0,
        settings_version: PROJECT_SETTINGS_VERSION,
        settings: createDefaultProjectSettings(),
        asset_paths: []
      },
      project_metadata: {},
      nodes: [],
      edges: [],
      issues: [],
      suggestions: [],
      engine_tags: [],
      placements: [],
      dialogues: [],
      quests: [],
      story_flows: [],
      story_flow_nodes: [],
      flow_transitions: [],
      scene_flow_boundaries: [],
      flow_invocations: [],
      flow_exits: [],
      flow_exit_bindings: [],
      flow_initial_states: [],
      narrative_effects: [],
      narrative_effect_bindings: []
    }
  };
}

function jsonResponse(payload: unknown, status = 200) {
  return new Response(JSON.stringify(payload), {
    headers: { "Content-Type": "application/json" },
    status
  });
}
