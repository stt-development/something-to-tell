import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { beforeEach, afterEach, describe, expect, it, vi } from "vitest";
import type { ExportPlanV1 } from "@something-to-tell/contracts/export";
import type { RuntimeExportPersistence } from "../runtime/apiTypes";
import { i18next } from "../localization/i18n";
import { ExportWorkspace } from "./ExportWorkspace";
import { ViewportTooltip } from "../components/ViewportTooltip";

function plan(changes: Partial<ExportPlanV1> = {}): ExportPlanV1 {
  return {
    plan_version: 1,
    options: { options_version: 1, format: "json", scope: "whole_project", story_flow_ids: [], engine_tag_target: "generic", preview_max_bytes: 65_536 },
    source: { identity_version: 1, project_id: "aurora", project_name: "Project Aurora", content_locale: "ru", document_version: 6, source_checksum: "a".repeat(64) },
    inventory: {
      inventory_version: 1, node_count: 10, relationship_count: 4, dialogue_count: 1, quest_count: 1,
      story_flow_count: 3, flow_membership_count: 10, flow_transition_count: 5, scene_boundary_count: 1,
      flow_invocation_count: 2, flow_exit_count: 3, flow_exit_binding_count: 3, initial_state_count: 1,
      narrative_effect_count: 4, narrative_effect_binding_count: 4, engine_tag_count: 5, diagnostic_count: 0,
      record_count: 30, resolved_story_flow_ids: ["main", "side"]
    },
    diagnostics: [], preview: { preview_version: 1, media_type: "application/json", text: '{"story":"Aurora"}\n', preview_bytes: 19, total_bytes: 19, truncated: false },
    suggested_filename: "project-aurora.json", plan_fingerprint: "b".repeat(64), can_write: true,
    ...changes
  };
}

function runtime(): RuntimeExportPersistence {
  return {
    createExportPlan: vi.fn().mockResolvedValue(plan()),
    writeExportArtifact: vi.fn().mockResolvedValue({ result_version: 1, artifact: {
      artifact_version: 1, format: "json", filename: "project-aurora.json", installed_path: "/stories/Aurora.narrative/exports/project-aurora.json",
      artifact_checksum: "c".repeat(64), source_checksum: "a".repeat(64), bytes_written: 19
    } })
  };
}
const props = {
  DirectoryPicker: () => null,
  projectName: "Project Aurora", projectPath: "/stories/Aurora.narrative", sessionId: "session-one", sourceRevision: 3,
  flows: [{ id: "main", name: "Main Story", description: "Opening" }, { id: "side", name: "Smuggler Route", description: "Optional" }], onClose: vi.fn()
};
async function refresh() {
  fireEvent.click(screen.getByRole("button", { name: "Refresh preview" }));
  await screen.findByRole("region", { name: "Inventory" });
}

describe("ExportWorkspace", () => {
  beforeEach(async () => { await i18next.changeLanguage("en"); props.onClose.mockClear(); });
  afterEach(() => { delete window.__TAURI_INTERNALS__; });

  it("previews and writes only through checksum-bound export APIs, then consumes the plan", async () => {
    const persistence = runtime();
    render(<ExportWorkspace {...props} persistence={persistence} />);
    expect(screen.getByRole("button", { name: "Export" })).toBeDisabled();
    expect([...screen.getByLabelText<HTMLSelectElement>("Identifier target").options].map((option) => option.value)).toEqual(["generic", "ink", "yarn_spinner"]);
    await refresh();
    expect(screen.getByLabelText("Generated source")).toHaveTextContent('"Aurora"');
    fireEvent.click(screen.getByRole("button", { name: "Export" }));
    await waitFor(() => expect(persistence.writeExportArtifact).toHaveBeenCalledWith("session-one", {
      request_version: 1, options: plan().options, expected_source_checksum: "a".repeat(64),
      expected_plan_fingerprint: "b".repeat(64), destination_directory: null, overwrite: false
    }));
    expect(await screen.findByText("Exported project-aurora.json (19 bytes)")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Export" })).toBeDisabled();
  });

  it.each(["json", "yaml", "ink", "yarn_spinner"])("sends the correct target for %s", async (format) => {
    const persistence = runtime();
    render(<ExportWorkspace {...props} persistence={persistence} />);
    fireEvent.change(screen.getByLabelText("Format"), { target: { value: format } });
    await refresh();
    expect(persistence.createExportPlan).toHaveBeenCalledWith("session-one", expect.objectContaining({
      options: expect.objectContaining({ format, engine_tag_target: ["ink", "yarn_spinner"].includes(format) ? format : "generic" })
    }));
    expect(screen.getByLabelText("Identifier target").hasAttribute("disabled")).toBe(["ink", "yarn_spinner"].includes(format));
  });

  it("filters long flow names without losing selection and invalidates changed options", async () => {
    const persistence = runtime();
    render(<ExportWorkspace {...props} persistence={persistence} flows={[...props.flows,
      { id: "long", name: "VeryLongFlowName".repeat(25), description: "Harbor" }]} />);
    fireEvent.change(screen.getByLabelText("Scope"), { target: { value: "story_flows" } });
    expect(screen.getByRole("button", { name: "Refresh preview" })).toBeDisabled();
    fireEvent.click(screen.getByLabelText("Main Story"));
    fireEvent.change(screen.getByLabelText("Search Story Flows"), { target: { value: "harbor" } });
    expect(screen.queryByLabelText("Main Story")).not.toBeInTheDocument();
    fireEvent.click(screen.getByLabelText("VeryLongFlowName".repeat(25)));
    await refresh();
    expect(persistence.createExportPlan).toHaveBeenCalledWith("session-one", expect.objectContaining({
      options: expect.objectContaining({ story_flow_ids: ["long", "main"] })
    }));
    fireEvent.change(screen.getByLabelText("Format"), { target: { value: "yaml" } });
    expect(screen.queryByLabelText("Generated source")).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Export" })).toBeDisabled();
  });

  it("blocks an outdated source revision and allows refreshing it", async () => {
    const persistence = runtime();
    const view = render(<ExportWorkspace {...props} persistence={persistence} />);
    await refresh();
    view.rerender(<ExportWorkspace {...props} sourceRevision={4} persistence={persistence} />);
    expect(screen.getByText(/Preview is outdated/)).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Export" })).toBeDisabled();
    await refresh();
    expect(screen.getByRole("button", { name: "Export" })).toBeEnabled();
  });

  it("shows blocking diagnostics and omissions without raw message keys", async () => {
    const persistence = runtime();
    vi.mocked(persistence.createExportPlan).mockResolvedValue(plan({ can_write: false, diagnostics: [
      { diagnostic_version: 1, code: "export.ink.missing-entry", severity: "error", message_key: "export.diagnostic.ink-missing-entry", owner: { owner_version: 1, kind: "story_flow", id: "main", context_id: null }, parameters: {} },
      { diagnostic_version: 1, code: "export.relationship-omitted", severity: "warning", message_key: "export.diagnostic.relationship-omitted", owner: null, parameters: {} }
    ] }));
    render(<ExportWorkspace {...props} persistence={persistence} />);
    await refresh();
    expect(screen.getByText(/Set a valid entry point/)).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Export" })).toBeDisabled();
    fireEvent.change(screen.getByLabelText("Severity"), { target: { value: "warning" } });
    expect(screen.queryByText(/Set a valid entry point/)).not.toBeInTheDocument();
    expect(screen.getByRole("region", { name: "Diagnostics and omissions" })).not.toHaveTextContent("export.diagnostic.");
  });

  it("preserves native chooser cancellation, retries conflict with explicit overwrite, and opens the folder", async () => {
    const persistence = runtime();
    const invoke = vi.fn().mockResolvedValueOnce(null).mockResolvedValueOnce("/selected").mockResolvedValue(undefined);
    window.__TAURI_INTERNALS__ = { invoke };
    vi.mocked(persistence.writeExportArtifact).mockRejectedValueOnce({ code: "export_destination_conflict" }).mockResolvedValueOnce(await runtime().writeExportArtifact("", {} as never));
    render(<ExportWorkspace {...props} persistence={persistence} />);
    fireEvent.click(screen.getByRole("button", { name: "Choose export directory" }));
    await waitFor(() => expect(screen.getByRole("button", { name: "Choose export directory" })).toBeEnabled());
    expect(screen.getByText("/stories/Aurora.narrative/exports")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Choose export directory" }));
    await screen.findByText("/selected");
    await refresh();
    fireEvent.click(screen.getByRole("button", { name: "Export" }));
    await screen.findByRole("alert");
    expect(screen.getByRole("button", { name: "Export" })).toBeEnabled();
    fireEvent.click(screen.getByLabelText("Replace existing file"));
    fireEvent.click(screen.getByRole("button", { name: "Export" }));
    await screen.findByText("Exported project-aurora.json (19 bytes)");
    expect(persistence.writeExportArtifact).toHaveBeenLastCalledWith("session-one", expect.objectContaining({ destination_directory: "/selected", overwrite: true }));
    fireEvent.click(screen.getByRole("button", { name: "Open folder" }));
    await waitFor(() => expect(invoke).toHaveBeenLastCalledWith("open_export_directory", { directory: "/stories/Aurora.narrative/exports" }));
  });

  it("requires a fresh plan after runtime detects staleness", async () => {
    const persistence = runtime();
    vi.mocked(persistence.writeExportArtifact).mockRejectedValue({ code: "export_source_stale" });
    render(<ExportWorkspace {...props} persistence={persistence} />);
    await refresh();
    fireEvent.click(screen.getByRole("button", { name: "Export" }));
    await screen.findByRole("alert");
    expect(screen.getByRole("button", { name: "Export" })).toBeDisabled();
    expect(screen.getByText(/Preview is outdated/)).toBeInTheDocument();
  });

  it("does not dismiss an active write", async () => {
    const persistence = runtime();
    let complete!: (result: Awaited<ReturnType<RuntimeExportPersistence["writeExportArtifact"]>>) => void;
    vi.mocked(persistence.writeExportArtifact).mockReturnValue(new Promise((resolve) => { complete = resolve; }));
    render(<ExportWorkspace {...props} persistence={persistence} />);
    await refresh();
    fireEvent.click(screen.getByRole("button", { name: "Export" }));
    fireEvent.keyDown(screen.getByRole("dialog"), { key: "Escape" });
    expect(props.onClose).not.toHaveBeenCalled();
    expect(screen.getByRole("button", { name: "Cancel" })).toBeDisabled();
    complete(await runtime().writeExportArtifact("", {} as never));
    await screen.findByText("Exported project-aurora.json (19 bytes)");
    fireEvent.keyDown(screen.getByRole("dialog"), { key: "Escape" });
    expect(props.onClose).toHaveBeenCalledOnce();
  });

  it("handles empty flows and large diagnostic collections without enabling invalid selection", async () => {
    const persistence = runtime();
    vi.mocked(persistence.createExportPlan).mockResolvedValue(plan({ diagnostics: Array.from({ length: 2000 }, (_, index) => ({
      diagnostic_version: 1, code: `export.warning-${index}`, severity: "warning", message_key: "export.diagnostic.relationship-omitted", owner: null, parameters: {}
    })) }));
    render(<ExportWorkspace {...props} flows={[]} persistence={persistence} />);
    await refresh();
    expect(screen.getByRole("region", { name: "Diagnostics and omissions" }).querySelectorAll("article")).toHaveLength(2000);
    fireEvent.change(screen.getByLabelText("Scope"), { target: { value: "story_flows" } });
    expect(screen.getByText("No Story Flows")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Refresh preview" })).toBeDisabled();
  });

  it("traps keyboard focus, cancels planning without a write, and restores the launcher", async () => {
    const persistence = runtime();
    let complete!: (result: ExportPlanV1) => void;
    vi.mocked(persistence.createExportPlan).mockReturnValue(new Promise((resolve) => { complete = resolve; }));
    const launcher = document.createElement("button");
    document.body.append(launcher);
    launcher.focus();
    const view = render(<ExportWorkspace {...props} persistence={persistence} />);
    const first = screen.getByRole("button", { name: "Close dialog" });
    first.focus();
    fireEvent.keyDown(first, { key: "Tab", shiftKey: true });
    expect(screen.getByRole("button", { name: "Cancel" })).toHaveFocus();
    fireEvent.keyDown(document.activeElement!, { key: "Tab" });
    expect(first).toHaveFocus();
    fireEvent.click(screen.getByRole("button", { name: "Refresh preview" }));
    fireEvent.keyDown(screen.getByRole("dialog"), { key: "Escape" });
    expect(props.onClose).toHaveBeenCalledOnce();
    view.unmount();
    complete(plan());
    await Promise.resolve();
    expect(persistence.writeExportArtifact).not.toHaveBeenCalled();
    expect(launcher).toHaveFocus();
    launcher.remove();
  });

  it("localizes the workspace and renders immediate delegated tooltips", async () => {
    await i18next.changeLanguage("ru");
    render(<><ExportWorkspace {...props} persistence={runtime()} /><ViewportTooltip /></>);
    expect(screen.getByRole("dialog", { name: "Экспорт" })).toBeInTheDocument();
    const refreshButton = screen.getByRole("button", { name: "Обновить предпросмотр" });
    fireEvent.pointerOver(refreshButton);
    expect(screen.getByRole("tooltip")).toHaveTextContent("Обновить предпросмотр");
    fireEvent.click(refreshButton);
    expect(await screen.findByRole("region", { name: "Состав экспорта" })).toBeInTheDocument();
    expect(within(screen.getByRole("region", { name: "Состав экспорта" })).getByText("Потоки истории")).toBeInTheDocument();
  });
});
