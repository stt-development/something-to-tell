import { afterEach, describe, expect, it, vi } from "vitest";
import { hasDesktopDirectoryPicker, openExportDirectory, pickExportDirectory, pickProjectDirectory } from "./desktopBridge";

describe("desktop project directory bridge", () => {
  afterEach(() => {
    delete window.__TAURI_INTERNALS__;
  });

  it("keeps an editable browser fallback when no desktop bridge exists", async () => {
    expect(hasDesktopDirectoryPicker()).toBe(false);
    await expect(pickProjectDirectory("~/Stories")).resolves.toBeNull();
  });

  it("delegates pointer directory selection to the Tauri command", async () => {
    const invoke = vi.fn(async () => "/stories/Selected.narrative");
    window.__TAURI_INTERNALS__ = { invoke };

    expect(hasDesktopDirectoryPicker()).toBe(true);
    await expect(pickProjectDirectory("/stories")).resolves.toBe("/stories/Selected.narrative");
    expect(invoke).toHaveBeenCalledWith("pick_project_directory", {
      initialDirectory: "/stories"
    });
  });

  it("keeps export chooser cancellation transient", async () => {
    localStorage.clear();
    const invoke = vi.fn(async () => null);
    window.__TAURI_INTERNALS__ = { invoke };

    await expect(pickExportDirectory("/stories/exports")).resolves.toBeNull();
    expect(invoke).toHaveBeenCalledWith("pick_export_directory", {
      initialDirectory: "/stories/exports"
    });
    expect(localStorage.length).toBe(0);
  });

  it("opens only the explicitly requested directory through the desktop command", async () => {
    const invoke = vi.fn(async () => undefined);
    window.__TAURI_INTERNALS__ = { invoke };
    await openExportDirectory("/stories/exports");
    expect(invoke).toHaveBeenCalledWith("open_export_directory", { directory: "/stories/exports" });
  });
});
