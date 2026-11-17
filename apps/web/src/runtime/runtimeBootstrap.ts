/** Desktop startup adapter; application modules load only after this completes. */
import { hasDesktopDirectoryPicker } from "./desktopBridge";
import { configureDevelopmentRuntime, DesktopConnectionError, installRuntimeConnection, requireBundledRuntime } from "./runtimeConnection";

type Invoke = (command: string) => Promise<unknown>;
export type RuntimeMode = "browser" | "external" | "bundled";

function invokeNative(command: string): Promise<unknown> {
  const invoke = window.__TAURI_INTERNALS__?.invoke;
  if (!invoke) return Promise.reject(new DesktopConnectionError());
  return invoke(command);
}

export async function connectRuntime({
  desktop = hasDesktopDirectoryPicker(), development = import.meta.env.DEV, invoke = invokeNative
}: { desktop?: boolean; development?: boolean; invoke?: Invoke } = {}): Promise<RuntimeMode> {
  if (!desktop) return "browser";
  try {
    if (development) {
      configureDevelopmentRuntime(await invoke("runtime_url"));
      return "external";
    }
    requireBundledRuntime();
    installRuntimeConnection(await invoke("start_bundled_runtime"));
    return "bundled";
  } catch { throw new DesktopConnectionError(); }
}

/** Native liveness is not an HTTP poll or an implicit start/retry command. */
export async function bundledRuntimeIsRunning(): Promise<boolean> {
  const value = await invokeNative("bundled_runtime_running");
  if (typeof value !== "boolean") throw new DesktopConnectionError();
  return value;
}
