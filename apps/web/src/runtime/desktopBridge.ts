interface TauriInternals {
  invoke(command: string, payload?: Record<string, unknown>): Promise<unknown>;
}

declare global {
  interface Window {
    __TAURI_INTERNALS__?: TauriInternals;
  }
}

/** Distinguishes a cancelled native dialog from the browser fallback path. */
export function hasDesktopDirectoryPicker(): boolean {
  return Boolean(window.__TAURI_INTERNALS__?.invoke);
}

/** Opens the desktop folder picker; browsers retain the editable path fallback. */
export async function pickProjectDirectory(initialDirectory: string): Promise<string | null> {
  const invoke = window.__TAURI_INTERNALS__?.invoke;
  if (!invoke) return null;
  return invoke("pick_project_directory", {
    initialDirectory
  }) as Promise<string | null>;
}

/** Selects one transient artifact directory; cancellation deliberately returns null. */
export async function pickExportDirectory(initialDirectory?: string): Promise<string | null> {
  const invoke = window.__TAURI_INTERNALS__?.invoke;
  if (!invoke) return null;
  return invoke("pick_export_directory", {
    initialDirectory: initialDirectory?.trim() || null
  }) as Promise<string | null>;
}

/** Opens an existing artifact parent in the OS file manager, never a shell string. */
export async function openExportDirectory(directory: string): Promise<void> {
  const invoke = window.__TAURI_INTERNALS__?.invoke;
  if (!invoke) throw new Error("Desktop directory opener is unavailable");
  await invoke("open_export_directory", { directory });
}
