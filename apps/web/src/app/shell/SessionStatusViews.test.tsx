import { act, cleanup, fireEvent, render, renderHook, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { applyProjectLocale } from "../../localization/i18n";
import { createRuntimeApiClient } from "../../runtime/apiClient";
import { useGraphStore } from "../../state/graphStore";
import { projectFixture } from "../../testFixtures/projectFixtures";
import { SessionCloseDialog, SessionSaveControl, SessionSaveIndicator, SessionStorageMigrationDialog } from "./SessionStatusViews";
import { useWorkspaceStore } from "./workspaceStore";

vi.mock("../settings/ProjectSettingsDialogs", () => ({
  StorageMigrationDialog: ({ isClean }: { isClean: boolean }) => <span data-testid="migration-clean">{String(isClean)}</span>
}));

function setStatus(save_status: "clean" | "dirty" | "saving" | "error") {
  useGraphStore.getState().setProjectSessionState({
    ...useGraphStore.getState().activeProjectSession!, save_status,
    save_error: save_status === "error" ? "Save detail" : null
  });
}

describe("local session status views", () => {
  beforeEach(async () => {
    await applyProjectLocale("en");
    useGraphStore.setState(useGraphStore.getInitialState(), true);
    useGraphStore.getState().setProjectSessionState(projectFixture("aurora").response.session);
  });
  afterEach(() => {
    cleanup();
    useGraphStore.setState(useGraphStore.getInitialState(), true);
  });

  it("updates header actions and status indicator without rendering the workspace", () => {
    let renders = 0;
    renderHook(() => { renders += 1; return useWorkspaceStore(); });
    const onSave = vi.fn();
    const onSaveAs = vi.fn();
    render(<><SessionSaveControl onSave={onSave} onSaveAs={onSaveAs} /><SessionSaveIndicator /></>);
    expect(screen.getByRole("button", { name: "Save project" })).toBeDisabled();
    for (const status of ["dirty", "saving", "error", "clean"] as const) {
      act(() => setStatus(status));
      const save = screen.getByRole("button", { name: "Save project" });
      expect(save).toHaveAttribute("aria-busy", String(status === "saving"));
      if (status === "clean" || status === "saving") expect(save).toBeDisabled();
      else expect(save).toBeEnabled();
      if (status === "dirty") {
        expect(save).toHaveClass("save-button-reminder");
        fireEvent.click(save);
      }
      if (status === "saving" || status === "error") expect(screen.getByRole("status")).toBeInTheDocument();
      else expect(screen.queryByRole("status")).not.toBeInTheDocument();
      expect(renders).toBe(1);
    }
    expect(onSave).toHaveBeenCalledOnce();
    fireEvent.click(screen.getByRole("button", { name: "More save actions" }));
    fireEvent.click(screen.getByRole("menuitem", { name: "Save project as" }));
    expect(onSaveAs).toHaveBeenCalledOnce();
    act(() => useGraphStore.getState().closeActiveProject());
    expect(screen.getByRole("button", { name: "Save project" })).toBeDisabled();
  });

  it("updates Close guards and error text locally while preserving callbacks", () => {
    const onCancel = vi.fn();
    const onResolve = vi.fn();
    let renders = 0;
    renderHook(() => { renders += 1; return useWorkspaceStore(); });
    render(<SessionCloseDialog action={{ kind: "close" }} onCancel={onCancel} onResolve={onResolve} />);
    act(() => setStatus("saving"));
    expect(screen.getByRole("button", { name: "Save" })).toBeDisabled();
    expect(screen.getByRole("button", { name: "Discard" })).toBeDisabled();
    act(() => setStatus("error"));
    expect(screen.getByRole("alert")).toHaveTextContent("Save detail");
    fireEvent.click(screen.getByRole("button", { name: "Save" }));
    fireEvent.click(screen.getByRole("button", { name: "Discard" }));
    fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
    expect(onResolve.mock.calls).toEqual([["save"], ["discard"]]);
    expect(onCancel).toHaveBeenCalledOnce();
    expect(renders).toBe(1);
  });

  it("keeps the migration cleanliness precondition live without a workspace render", () => {
    let renders = 0;
    renderHook(() => { renders += 1; return useWorkspaceStore(); });
    render(<SessionStorageMigrationDialog activeSessionId={useGraphStore.getState().activeSessionId}
      currentMode="local_sqlite" currentProfileId={null} onClose={vi.fn()} onMigrate={vi.fn()}
      persistence={createRuntimeApiClient()} />);
    expect(screen.getByTestId("migration-clean")).toHaveTextContent("true");
    act(() => setStatus("dirty"));
    expect(screen.getByTestId("migration-clean")).toHaveTextContent("false");
    act(() => setStatus("clean"));
    expect(screen.getByTestId("migration-clean")).toHaveTextContent("true");
    expect(renders).toBe(1);
  });
});
