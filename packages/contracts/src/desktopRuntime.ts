/** Private desktop/runtime bootstrap. Tokens are process-local, never project data. */
export const DESKTOP_PROTOCOL_VERSION = 1 as const;
export const DESKTOP_MAX_FRAME_BYTES = 4096;
export const DESKTOP_BOOTSTRAP_TIMEOUT_SECONDS = 5;
export const DESKTOP_READY_TIMEOUT_SECONDS = 15;
export const DESKTOP_SHUTDOWN_TIMEOUT_SECONDS = 10;

export interface DesktopBootstrapV1 {
  protocol_version: typeof DESKTOP_PROTOCOL_VERSION;
  type: "bootstrap";
  token: string;
}
export interface DesktopShutdownV1 {
  protocol_version: typeof DESKTOP_PROTOCOL_VERSION;
  type: "shutdown";
}
export interface DesktopReadyV1 {
  protocol_version: typeof DESKTOP_PROTOCOL_VERSION;
  type: "ready";
  port: number;
  pid: number;
  runtime_version: string;
}
export interface DesktopErrorV1 {
  protocol_version: typeof DESKTOP_PROTOCOL_VERSION;
  type: "error";
  code: "desktop_bootstrap_invalid" | "desktop_startup_failed" | "desktop_control_invalid";
}

/** Rust has already checked child identity/version; this credential never persists. */
export interface DesktopRuntimeConnection {
  origin: string;
  token: string;
}
