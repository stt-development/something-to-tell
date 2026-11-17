import type { RuntimeProjectSessionResponse } from "./apiTypes";
import { assertRemoteStorageHead, type RemoteStorageHeadV1 } from "@something-to-tell/contracts/remote-storage";
import { RemoteChannel, type RemoteSessionObservation } from "./remoteChannel";
import { authorizeRuntimeRequest, configuredRuntimeBaseUrl } from "./runtimeConnection";

const DEFAULT_RUNTIME_URL = "http://127.0.0.1:8719/api";

export type RuntimeFetcher = (input: string, init?: RequestInit) => Promise<Response>;

export interface RuntimeTransportOptions {
  baseUrl?: string;
  fetcher?: RuntimeFetcher;
  projectSessionId?: string | null;
  projectPath?: string | null;
  projectRevision?: number;
  remoteStorage?: RemoteStorageHeadV1 | null;
  onMutation?: () => void;
  onSessionRecovered?: (response: RuntimeProjectSessionResponse) => Promise<void> | void;
  onRemoteStorageObserved?: (observation: RemoteSessionObservation) => void;
  remoteObservationSignal?: AbortSignal;
}

export interface RuntimeTransport {
  getJson<T>(path: string): Promise<T>;
  requestJson<T>(path: string, init?: RequestInit): Promise<T>;
  requestJsonWithTimeout<T>(path: string, init: RequestInit, timeoutMs: number): Promise<T>;
  sendJson<T>(method: "POST" | "PUT", path: string, body: unknown): Promise<T>;
  deleteResource(path: string): Promise<void>;
  deleteJson(path: string, body: unknown): Promise<void>;
}

export class RuntimeApiError extends Error {
  /** Preserves the runtime's stable machine-readable failure code for UI mapping. */
  constructor(
    message: string,
    readonly code: string,
    readonly status: number,
    readonly messageKey: string | null = null,
    readonly parameters: Record<string, unknown> = {}
  ) {
    super(message);
    this.name = "RuntimeApiError";
  }
}

/** Owns request headers, recovery, decoding, cancellation, and error conversion. */
export function createRuntimeTransport(options: RuntimeTransportOptions = {}): RuntimeTransport {
  const {
    baseUrl = runtimeBaseUrl(),
    fetcher: rawFetcher = fetch,
    projectSessionId = null,
    projectPath = null,
    onMutation,
    onSessionRecovered
  } = options;
  const fetcher: RuntimeFetcher = (input, init) => rawFetcher(input, authorizeRuntimeRequest(input, init));
  const apiBase = baseUrl.replace(/\/+$/g, "");
  let currentProjectSessionId = projectSessionId;
  let sessionRecovery: Promise<void> | null = null;
  const remoteChannels = new Map<string, RemoteChannel>();
  if (projectSessionId && options.remoteStorage) remoteChannels.set(projectSessionId, new RemoteChannel(options.remoteStorage));

  function publishRemote(channel: RemoteChannel | undefined, id: string | undefined) {
    if (!channel || !id || options.remoteObservationSignal?.aborted) return;
    try { options.onRemoteStorageObserved?.(channel.snapshot(id)); }
    catch { /* Presentation observers cannot change a committed request outcome. */ }
  }

  function withProjectSession(init?: RequestInit): RequestInit | undefined {
    if (!currentProjectSessionId && !init?.method) return init;
    const headers = new Headers(init?.headers);
    headers.set("X-Remote-Storage-Version", "1");
    if (currentProjectSessionId) headers.set("X-Project-Session-Id", currentProjectSessionId);
    return { ...init, headers };
  }

  /** Keeps session, playback, provider, and storage administration out of dirty tracking. */
  function isAuthoringMutation(path: string): boolean {
    return !path.includes("/project-sessions/")
      && !path.startsWith("/playback/")
      && !path.startsWith("/canon-checks/")
      && !path.startsWith("/canon-provider-profiles")
      && !path.startsWith("/style-resolution")
      && !path.startsWith("/style-rewrites/")
      && (!path.startsWith("/agent-memory/candidate-runs") || path.includes("/accept"))
      && path !== "/agent-memory/resolve"
      && !path.startsWith("/storage-profiles")
      && !path.startsWith("/storage-migrations")
      && !path.startsWith("/exports/");
  }

  async function recoverProjectSession(): Promise<void> {
    if (!sessionRecovery) {
      sessionRecovery = (async () => {
        const response = await fetcher(`${apiBase}/project-sessions/open`, {
          body: JSON.stringify({
            path: projectPath,
            recover_stale_lock: true,
            recovery_mode: "recover",
            expected_lock_session_id: currentProjectSessionId
          }),
          headers: { "Content-Type": "application/json", "X-Remote-Storage-Version": "1" },
          method: "POST"
        });
        if (!response.ok) throw await runtimeApiError(response);
        const recovered = await decodeJson<RuntimeProjectSessionResponse>(response);
        currentProjectSessionId = recovered.session.session_id;
        await onSessionRecovered?.(recovered);
      })().finally(() => {
        sessionRecovery = null;
      });
    }
    await sessionRecovery;
  }

  async function requestJson<T>(path: string, init?: RequestInit, allowRecovery = true): Promise<T> {
    let bodySession: string | undefined;
    try {
      if (typeof init?.body === "string") bodySession = (JSON.parse(init.body) as { session_id?: string }).session_id;
    } catch { /* Request validation remains owned by the runtime. */ }
    const id = currentProjectSessionId ?? path.match(/^\/project-sessions\/([^/]+)\//)?.[1] ?? bodySession;
    const channel = id ? remoteChannels.get(id) : undefined;
    const mutating = Boolean(init?.method && !["GET", "HEAD"].includes(init.method));
    if (channel && mutating && !path.endsWith("/remote-storage/reconnect")
      && !/\/remote-storage\/reconnect-attempts(?:\/[^/]+\/abandon)?$/.test(path)
      && !path.endsWith("/remote-storage/release") && !path.endsWith("/close")) {
      return channel.run(() => performRequest<T>(path, init, false, channel, id));
    }
    return performRequest<T>(path, init, allowRecovery, undefined, id);
  }

  async function performRequest<T>(path: string, init?: RequestInit, allowRecovery = true, channel?: RemoteChannel, sessionId?: string): Promise<T> {
    const observed = channel ?? (sessionId ? remoteChannels.get(sessionId) : undefined);
    const guarded = withProjectSession(init);
    if (channel) {
      if (sessionId) (guarded!.headers as Headers).set("X-Project-Session-Id", sessionId);
      try { channel.headers(guarded!.headers as Headers); }
      catch { publishRemote(channel, sessionId); throw new RuntimeApiError("remote_commit_unknown", "remote_commit_unknown", 503); }
    }
    const commandId = channel?.pendingCommandId;
    let response: Response;
    try {
      response = await fetcher(`${apiBase}${path}`, guarded);
    } catch (error) {
      if (channel) {
        channel.noteFailure("remote_commit_unknown", commandId);
        publishRemote(channel, sessionId);
        throw new RuntimeApiError("remote_commit_unknown", "remote_commit_unknown", 503,
          "remote_storage.error.remote_commit_unknown", { command_id: channel.pendingCommandId,
            storage_generation: channel.head.storage_generation });
      }
      if (observed) {
        observed.noteFailure("remote_storage_unavailable"); publishRemote(observed, sessionId);
        throw new RuntimeApiError("remote_storage_unavailable", "remote_storage_unavailable", 503);
      }
      throw error;
    }
    if (channel) {
      try { channel.accept(response); }
      catch { channel.noteFailure("remote_contract_invalid", commandId); publishRemote(channel, sessionId);
        throw new RuntimeApiError("remote_contract_invalid", "remote_contract_invalid", 400); }
    }
    if (!response.ok) {
      const error = await runtimeApiError(response);
      if (observed?.noteFailure(error.code, commandId)) publishRemote(observed, sessionId);
      if (
        allowRecovery
        && !channel
        && error.code === "project_session_not_found"
        && Boolean(projectPath)
        && Boolean(init?.method)
        && isAuthoringMutation(path)
      ) {
        await recoverProjectSession();
        return requestJson<T>(path, init, false);
      }
      throw error;
    }
    let payload: T;
    try {
      payload = await decodeJson<T>(response);
    } catch (error) {
      if (!channel) {
        if (observed) {
          observed.noteFailure("remote_contract_invalid"); publishRemote(observed, sessionId);
          throw new RuntimeApiError("remote_contract_invalid", "remote_contract_invalid", 400);
        }
        throw error;
      }
      // Even a valid receipt cannot make a truncated domain response usable.
      // Keep its command identity for explicit resolution, never replay it.
      channel.noteFailure("remote_contract_invalid", commandId); publishRemote(channel, sessionId);
      throw new RuntimeApiError("remote_contract_invalid", "remote_contract_invalid", 400,
        "remote_storage.error.remote_contract_invalid", { command_id: channel.pendingCommandId,
          storage_generation: channel.head.storage_generation });
    }
    // A receipt is not a cached old domain response. Explicit recovery refetches
    // the current snapshot instead of treating it as a second successful effect.
    if (response.headers.get("X-Remote-Replayed") === "1") {
      if (observed) { observed.noteFailure("remote_revision_stale", commandId); publishRemote(observed, sessionId); }
      throw new RuntimeApiError("remote_revision_stale", "remote_revision_stale", 409);
    }
    try {
      const changesSession = path.endsWith("/remote-storage/reconnect")
        || path === "/project-sessions/open" || path === "/project-sessions/create";
      observeRemote(payload, path === "/storage-migrations" || path.endsWith("/remote-storage/reconnect"),
        observed && !changesSession ? sessionId : undefined);
    } catch (error) {
      if (observed) {
        observed.noteFailure(error instanceof RuntimeApiError ? error.code : "remote_contract_invalid", commandId);
        publishRemote(observed, sessionId);
      }
      if (error instanceof RuntimeApiError) throw error;
      throw new RuntimeApiError("remote_contract_invalid", "remote_contract_invalid", 400);
    }
    if (path.endsWith("/remote-storage/reconnect") && payload && typeof payload === "object" && "session" in payload) {
      const session = payload.session;
      if (session && typeof session === "object" && "session_id" in session && typeof session.session_id === "string") {
        currentProjectSessionId = session.session_id;
      }
    }
    publishRemote(observed, sessionId);
    if (!options.remoteObservationSignal?.aborted && currentProjectSessionId && init?.method && isAuthoringMutation(path)) onMutation?.();
    return payload;
  }

  function observeRemote(value: unknown, allowGenerationChange = false, expectedSessionId?: string): void {
    if (!value || typeof value !== "object") return;
    const record = value as Record<string, unknown>;
    const session = record.session as Record<string, unknown> | undefined;
    if (session?.storage_mode === "local_sqlite" && allowGenerationChange) remoteChannels.delete(String(session.session_id));
    if (session?.storage_mode === "postgresql") {
      if (expectedSessionId && session.session_id !== expectedSessionId) {
        throw new RuntimeApiError("remote_project_scope_mismatch", "remote_project_scope_mismatch", 409);
      }
      if (session.session_version !== 2) throw new RuntimeApiError("remote_contract_invalid", "remote_contract_invalid", 400);
      assertRemoteStorageHead(session.remote_storage);
      if (session.remote_storage.project_id !== session.project_id || session.remote_storage.state !== session.remote_state) {
        throw new RuntimeApiError("remote_contract_invalid", "remote_contract_invalid", 400);
      }
      const id = String(session.session_id);
      const existing = remoteChannels.get(id);
      if (existing) {
        if (existing.head.project_id !== session.remote_storage.project_id) {
          throw new RuntimeApiError("remote_project_scope_mismatch", "remote_project_scope_mismatch", 409);
        }
        if (existing.head.storage_generation !== session.remote_storage.storage_generation && !allowGenerationChange) {
          existing.blocked = true;
          throw new RuntimeApiError("remote_generation_mismatch", "remote_generation_mismatch", 409);
        }
        if (existing.head.storage_generation === session.remote_storage.storage_generation
            && (BigInt(session.remote_storage.authoring_revision) < BigInt(existing.head.authoring_revision)
              || BigInt(session.remote_storage.writer_epoch) < BigInt(existing.head.writer_epoch))) {
          throw new RuntimeApiError("remote_revision_stale", "remote_revision_stale", 409);
        }
        if (existing.head.storage_generation !== session.remote_storage.storage_generation
            || BigInt(session.remote_storage.authoring_revision) >= BigInt(existing.head.authoring_revision)) {
          existing.head = { ...session.remote_storage };
        }
      }
      else remoteChannels.set(id, new RemoteChannel(session.remote_storage));
    }
    if (record.project) observeRemote(record.project, allowGenerationChange, expectedSessionId);
  }

  return {
    getJson: <T>(path: string) => requestJson<T>(path),
    requestJson,
    async requestJsonWithTimeout<T>(path: string, init: RequestInit, timeoutMs: number): Promise<T> {
      const controller = new AbortController();
      const timeout = globalThis.setTimeout(() => controller.abort(), timeoutMs);
      try {
        return await requestJson<T>(path, { ...init, signal: controller.signal });
      } finally {
        globalThis.clearTimeout(timeout);
      }
    },
    sendJson: <T>(method: "POST" | "PUT", path: string, body: unknown) =>
      requestJson<T>(path, {
        body: JSON.stringify(body),
        headers: { "Content-Type": "application/json" },
        method
      }),
    async deleteResource(path: string): Promise<void> {
      await requestJson<void>(path, { method: "DELETE" });
    },
    async deleteJson(path: string, body: unknown): Promise<void> {
      await requestJson<void>(path, {
        body: JSON.stringify(body),
        headers: { "Content-Type": "application/json" },
        method: "DELETE"
      });
    }
  };
}

async function decodeJson<T>(response: Response): Promise<T> {
  if (response.status === 204) return undefined as T;
  return await response.json() as T;
}

async function runtimeApiError(response: Response): Promise<RuntimeApiError> {
  try {
    const payload = await decodeJson<{
      detail?: { code?: unknown; message?: unknown; message_key?: unknown; parameters?: unknown };
    }>(response);
    const detail = payload.detail;
    if (detail && typeof detail.code === "string") {
      const message = typeof detail.message === "string"
        ? detail.message
        : typeof detail.message_key === "string"
          ? detail.message_key
          : detail.code;
      const parameters = detail.parameters && typeof detail.parameters === "object" && !Array.isArray(detail.parameters)
        ? detail.parameters as Record<string, unknown>
        : {};
      return new RuntimeApiError(
        message,
        detail.code,
        response.status,
        typeof detail.message_key === "string" ? detail.message_key : null,
        parameters
      );
    }
  } catch {
    // A non-JSON response still receives a stable transport-level error below.
  }
  return new RuntimeApiError(
    `Runtime request failed: ${response.status} ${response.statusText}`,
    "runtime_request_failed",
    response.status
  );
}

function runtimeBaseUrl(): string {
  return configuredRuntimeBaseUrl() ?? import.meta.env.VITE_RUNTIME_URL ?? DEFAULT_RUNTIME_URL;
}
