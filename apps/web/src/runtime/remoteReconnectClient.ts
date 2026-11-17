import {
  assertRemoteReconnectBegin, assertRemoteReconnectAbandon, assertRemoteReconnectOutcome,
  type RemoteReconnectBeginV1, type RemoteReconnectAbandonV1, type RemoteReconnectScopeV1,
} from "@something-to-tell/contracts/remote-storage";
import { RuntimeApiError, type RuntimeTransport } from "./transport";

/** One request per explicit action. A lost reply is recovered by lookup, not begin. */
export function createTrackedReconnectClient(transport: RuntimeTransport) {
  const invalid = () => new RuntimeApiError("remote_contract_invalid", "remote_contract_invalid", 400);
  function validate(scope: RemoteReconnectScopeV1) {
    try { assertRemoteReconnectAbandon({ ...scope, confirmation: "leave_remote_working_data_unchanged" }); }
    catch { throw invalid(); }
  }
  function base(source: string) {
    if (!/^[A-Za-z0-9][A-Za-z0-9_.:-]{0,254}$/.test(source) || source.trim() !== source) throw invalid();
    return `/project-sessions/${encodeURIComponent(source)}/remote-storage/reconnect-attempts`;
  }
  async function request(source: string, scope: RemoteReconnectScopeV1, path: string, init: RequestInit, timeout: number) {
    let result: unknown;
    try { result = await transport.requestJsonWithTimeout<unknown>(path, init, timeout); }
    catch (error) {
      if (error instanceof RuntimeApiError) throw error;
      throw new RuntimeApiError("remote_storage_unavailable", "remote_storage_unavailable", 503);
    }
    try { assertRemoteReconnectOutcome(result); } catch { throw invalid(); }
    if (result.source_session_id !== source || ["project_id", "storage_generation", "attempt_id"].some(
      key => result[key as keyof typeof result] !== scope[key as keyof RemoteReconnectScopeV1])) throw invalid();
    return result;
  }
  const json = (body: unknown, keepalive = false): RequestInit => ({ method: "POST", keepalive,
    headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
  return {
    beginRemoteReconnect(source: string, command: RemoteReconnectBeginV1) {
      try { assertRemoteReconnectBegin(command); } catch { return Promise.reject(invalid()); }
      return request(source, command, base(source), json(command), 45000);
    },
    inspectRemoteReconnect(source: string, scope: RemoteReconnectScopeV1) {
      validate(scope);
      const query = new URLSearchParams({ project_id: scope.project_id, storage_generation: scope.storage_generation });
      return request(source, scope, `${base(source)}/${encodeURIComponent(scope.attempt_id)}?${query}`, { method: "GET" }, 15000);
    },
    abandonRemoteReconnect(source: string, command: RemoteReconnectAbandonV1, keepalive = false) {
      try { assertRemoteReconnectAbandon(command); } catch { return Promise.reject(invalid()); }
      return request(source, command, `${base(source)}/${encodeURIComponent(command.attempt_id)}/abandon`, json(command, keepalive), 45000);
    }
  };
}
