/** One renderer-lifetime connection owner; no storage, project mutation or implicit restart. */
import type { DesktopRuntimeConnection } from "@something-to-tell/contracts/desktop-runtime";

let state: "browser" | "pending" | "ready" | "lost" = "browser";
let connection: Readonly<DesktopRuntimeConnection> | null = null;
let establishedBase: string | null = null;
let developmentBase: string | null = null;

export class DesktopConnectionError extends Error {
  readonly code = "desktop_runtime_unavailable";
  constructor() { super("desktop_runtime_unavailable"); }
}

/** Called before any packaged-app client is imported, so no 8719 fallback can race. */
export function requireBundledRuntime(): void {
  if (state === "lost") throw new DesktopConnectionError();
  if (state !== "ready") state = "pending";
}

export function installRuntimeConnection(value: unknown): void {
  try {
    if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error();
    const record = value as Record<string, unknown>;
    if (Object.keys(record).sort().join(",") !== "origin,token" || typeof record.origin !== "string"
      || typeof record.token !== "string" || !/^[A-Za-z0-9_-]{43,128}$/.test(record.token)) throw new Error();
    const url = new URL(record.origin);
    if (url.protocol !== "http:" || url.hostname !== "127.0.0.1" || !url.port
      || url.username || url.password || url.origin !== record.origin) throw new Error();
    if (state === "lost" || (connection && (connection.origin !== record.origin || connection.token !== record.token))) throw new Error();
    connection = Object.freeze({ origin: record.origin, token: record.token });
    establishedBase = `${record.origin}/api`;
    state = "ready";
  } catch {
    // Never reflect native payloads, which may contain credentials or invalid URLs.
    throw new DesktopConnectionError();
  }
}

/** A running project's authority cannot be silently replaced after child failure. */
export function markRuntimeUnavailable(): void {
  state = "lost";
  connection = null;
}

export function configureDevelopmentRuntime(value: unknown): void {
  try {
    if (state !== "browser" || typeof value !== "string") throw new Error();
    const url = new URL(value);
    if (!["http:", "https:"].includes(url.protocol) || url.username || url.password || url.search || url.hash
      || !["/", "/api", "/api/"].includes(url.pathname)) throw new Error();
    developmentBase = `${url.origin}/api`;
  } catch { throw new DesktopConnectionError(); }
}

export function configuredRuntimeBaseUrl(): string | null {
  if (state === "pending" || (state === "lost" && !establishedBase)) throw new DesktopConnectionError();
  // A read-only snapshot may still render after failure; no request can pass the fence.
  if (state === "lost") return establishedBase;
  return connection ? `${connection.origin}/api` : developmentBase;
}

/** All requests, including recovery and keepalive exit, use this same header boundary. */
export function authorizeRuntimeRequest(input: string, init?: RequestInit): RequestInit | undefined {
  if (state === "pending" || state === "lost") throw new DesktopConnectionError();
  if (!connection) return init;
  let url: URL;
  try { url = new URL(input); } catch { throw new DesktopConnectionError(); }
  if (url.origin !== connection.origin || url.username || url.password
    || !(url.pathname === "/api" || url.pathname.startsWith("/api/"))) throw new DesktopConnectionError();
  const headers = new Headers(init?.headers);
  headers.set("Authorization", `Bearer ${connection.token}`);
  return { ...init, headers, credentials: "omit", redirect: "error" };
}
