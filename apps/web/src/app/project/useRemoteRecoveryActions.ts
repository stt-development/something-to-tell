import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { RemoteCommandOutcomeV1, RemoteReconnectBeginV1, RemoteReconnectOutcomeV1, RemoteStorageHeadV1 } from "@something-to-tell/contracts/remote-storage";
import { assertRemoteStorageHead } from "@something-to-tell/contracts/remote-storage";
import { createRemoteStorageClient } from "../../runtime/remoteClient";
import { createRuntimeTransport, RuntimeApiError } from "../../runtime/transport";
import type { RuntimeProjectSessionResponse } from "../../runtime/apiTypes";
import { useGraphStore } from "../../state/graphStore";
import { closeAcquiredSession, enterProjectSession, ProjectEntryReleaseError } from "./projectSessionEntry";
import { useProjectEntryReleaseReporter } from "./ProjectEntryReleaseNotice";
import type { RemoteRecoveryMonitor } from "./remoteRecoveryMonitor";

const invalid = () => new RuntimeApiError("remote_contract_invalid", "remote_contract_invalid", 400);

/** UI lifecycle coordination only: registry owns sessions, graph store owns publication. */
export function useRemoteRecoveryActions(monitor: RemoteRecoveryMonitor, installed: () => void) {
  const report = useProjectEntryReleaseReporter();
  const client = useMemo(() => createRemoteStorageClient(createRuntimeTransport({ projectSessionId: monitor.sessionId })), [monitor]);
  const [operation, setOperation] = useState<string | null>(null);
  const [error, setError] = useState<unknown>(null);
  const [head, setHead] = useState<RemoteStorageHeadV1 | null>(null);
  const [command, setCommand] = useState<RemoteCommandOutcomeV1 | null>(null);
  const [outcome, setOutcome] = useState<RemoteReconnectOutcomeV1 | null>(null);
  const attempt = useRef<RemoteReconnectBeginV1 | null>(null);
  const busy = useRef(false);
  const nonce = useRef(0);
  const scope = useCallback(() => ({ protocol_version: 1 as const, project_id: monitor.projectId,
    storage_generation: monitor.generation, attempt_id: attempt.current!.attempt_id }), [monitor]);
  const abandon = useCallback((keepalive = false) => client.abandonRemoteReconnect(monitor.sessionId,
    { ...scope(), confirmation: "leave_remote_working_data_unchanged" }, keepalive), [client, monitor, scope]);

  useEffect(() => {
    monitor.setMounted(true);
    const retire = () => {
      // A successfully installed candidate belongs to the new workspace; never
      // release it from the retiring source's effect or a late callback.
      const currentId = useGraphStore.getState().activeSessionId;
      if (attempt.current && currentId !== outcomeRef.current?.result_session_id) {
        const attemptId = attempt.current.attempt_id;
        const failed = (error: unknown) => report(new ProjectEntryReleaseError(
          outcomeRef.current?.result_session_id ?? monitor.sessionId, monitor.projectId, error,
          { sourceSessionId: monitor.sessionId, projectId: monitor.projectId, generation: monitor.generation, attemptId }));
        void abandon(true).then(result => {
          if (!["released", "failed"].includes(result.status)) failed(new RuntimeApiError("remote_commit_unknown", "remote_commit_unknown", 503));
        }).catch(failed);
      }
    };
    const pagehide = () => { retire(); monitor.setMounted(false); ++nonce.current; };
    const pageshow = () => { monitor.setMounted(true); busy.current = false; setOperation(null); };
    window.addEventListener("pagehide", pagehide);
    window.addEventListener("pageshow", pageshow);
    return () => { retire(); monitor.setMounted(false); ++nonce.current; window.removeEventListener("pagehide", pagehide); window.removeEventListener("pageshow", pageshow); };
  }, [abandon, monitor, report]);
  const outcomeRef = useRef(outcome);
  outcomeRef.current = outcome;

  async function run(name: string, action: (valid: () => boolean) => Promise<void>) {
    if (busy.current || !monitor.current()) return;
    busy.current = true; setOperation(name); setError(null);
    const token = ++nonce.current;
    const valid = () => monitor.current() && nonce.current === token;
    try { await action(valid); }
    catch (failure) { if (monitor.current() && nonce.current === token) setError(failure); }
    finally { if (nonce.current === token) { busy.current = false; if (monitor.current()) setOperation(null); } }
  }
  function accept(value: RemoteReconnectOutcomeV1, valid: () => boolean) {
    if (valid()) { outcomeRef.current = value; setOutcome(value); }
  }
  async function inspectHead(valid: () => boolean) {
    const value = await client.inspectRemoteStorage(monitor.sessionId);
    if (value.project_id !== monitor.projectId || value.storage_generation !== monitor.generation) throw invalid();
    if (valid()) setHead(value);
    return value;
  }
  return {
    operation, error, head, command, outcome, hasAttempt: Boolean(attempt.current),
    inspect: () => run("inspect", async valid => { await inspectHead(valid); }),
    resolve: () => run("resolve", async valid => {
      const id = monitor.getSnapshot().unresolvedCommandId;
      if (!id) throw invalid();
      const value = await client.resolveRemoteCommand(monitor.sessionId, id, monitor.generation);
      if (value.project_id !== monitor.projectId || value.storage_generation !== monitor.generation || value.command_id !== id) throw invalid();
      if (valid()) setCommand(value);
    }),
    begin: () => run("begin", async valid => {
      if (attempt.current) throw invalid();
      const pending = monitor.getSnapshot().unresolvedCommandId;
      if (pending && (command?.command_id !== pending || command.status === "unknown")) throw invalid();
      const fresh = await inspectHead(valid);
      if (!valid()) return;
      const request: RemoteReconnectBeginV1 = { protocol_version: 1, project_id: monitor.projectId,
        storage_generation: monitor.generation, attempt_id: crypto.randomUUID(), observed_revision: fresh.authoring_revision,
        unresolved_command_id: pending, confirmation: "reload_remote_working_data" };
      attempt.current = request; // Retain identity before dispatch, including lost replies.
      accept(await client.beginRemoteReconnect(monitor.sessionId, request), valid);
    }),
    lookup: () => run("lookup", async valid => {
      if (attempt.current) accept(await client.inspectRemoteReconnect(monitor.sessionId, scope()), valid);
    }),
    cancelAttempt: () => run("abandon", async valid => { if (attempt.current) accept(await abandon(), valid); }),
    install: () => run("install", async valid => {
      if (!attempt.current) throw invalid();
      const found = await client.inspectRemoteReconnect(monitor.sessionId, scope()); accept(found, valid);
      if (found.status !== "ready" || !found.result_session_id || !valid()) return;
      const candidateId = found.result_session_id;
      const transport = createRuntimeTransport({ projectSessionId: candidateId });
      const response = await enterProjectSession({
        loadSnapshot: useGraphStore.getState().loadRuntimeSnapshot,
        activeSessionId: () => useGraphStore.getState().activeSessionId,
        acquire: async ({ retain }) => {
          const value = await transport.requestJsonWithTimeout<RuntimeProjectSessionResponse>(`/project-sessions/${encodeURIComponent(candidateId)}`, { method: "GET" }, 45000);
          const remote = value?.session?.remote_storage;
          try { assertRemoteStorageHead(remote); } catch { throw invalid(); }
          if (value.session.session_id !== candidateId || value.session.project_id !== monitor.projectId
              || remote.project_id !== monitor.projectId || remote.storage_generation !== monitor.generation) throw invalid();
          return retain(value);
        },
        beforeInstall: async () => { if (!valid()) throw invalid(); },
        close: async id => {
          if (id !== candidateId) throw invalid();
          const released = await abandon();
          if (released.status !== "released") throw new RuntimeApiError("remote_commit_unknown", "remote_commit_unknown", 503);
        }
      });
      if (response) installed();
    }),
    close: () => run("close", async valid => {
      if (attempt.current) {
        const released = await abandon(); accept(released, valid);
        if (!["released", "failed", "unknown"].includes(released.status)) throw new RuntimeApiError("remote_commit_unknown", "remote_commit_unknown", 503);
      }
      await closeAcquiredSession(id => client.releaseRemoteStorage(id, monitor.projectId, {
        protocol_version: 1, storage_generation: monitor.generation, confirmation: "leave_remote_working_data_unchanged"
      }), monitor.sessionId);
      if (valid()) useGraphStore.getState().closeActiveProject();
    })
  };
}
