import { assertRemoteCounter, assertRemoteStorageHead, assertRemoteUuid, type RemoteStorageHeadV1 } from "@something-to-tell/contracts/remote-storage";

const failures = new Set([
  "remote_project_busy", "remote_schema_busy", "remote_storage_unavailable", "remote_storage_timeout",
  "remote_auth_failed", "remote_tls_failed", "remote_writer_lost", "remote_generation_mismatch",
  "remote_revision_stale", "remote_commit_unknown", "remote_local_publication_required", "remote_contract_invalid",
  "remote_storage_protocol_unsupported", "remote_schema_upgrade_required", "remote_schema_future",
  "remote_schema_unknown", "remote_schema_partial", "remote_server_version_unsupported",
  "remote_storage_binding_required", "remote_project_not_provisioned", "project_session_not_found",
  "remote_project_scope_mismatch", "remote_revision_exhausted", "remote_command_reused"
]);

/** Presentation projection, not another mutable session or command authority. */
export interface RemoteSessionObservation {
  readonly sessionId: string;
  readonly head: Readonly<RemoteStorageHeadV1>;
  readonly blocked: boolean;
  readonly errorCode: string | null;
  readonly unresolvedCommandId: string | null;
}

/** Per-client/session command serialization; never automatically replay an uncertain write. */
export class RemoteChannel {
  head: RemoteStorageHeadV1;
  pendingCommandId: string | null = null;
  blocked = false;
  private errorCode: string | null = null;
  private tail: Promise<unknown> = Promise.resolve();

  constructor(head: RemoteStorageHeadV1) {
    assertRemoteStorageHead(head);
    this.head = { ...head };
  }

  noteFailure(code: string, commandId?: string | null): boolean {
    if (!failures.has(code)) return false;
    this.errorCode = code;
    if (!["remote_project_busy", "remote_schema_busy"].includes(code)) this.blocked = true;
    if (this.blocked && commandId && !this.pendingCommandId) this.pendingCommandId = commandId;
    return true;
  }

  snapshot(sessionId: string): RemoteSessionObservation {
    const blocked = this.blocked || this.head.state !== "ready";
    return Object.freeze({ sessionId, head: Object.freeze({ ...this.head }), blocked,
      errorCode: this.errorCode, unresolvedCommandId: blocked ? this.pendingCommandId : null });
  }

  run<T>(operation: () => Promise<T>): Promise<T> {
    const next = this.tail.then(operation, operation);
    this.tail = next.catch(() => undefined);
    return next;
  }

  headers(headers: Headers): void {
    if (this.blocked || this.head.state !== "ready") throw new Error("remote_commit_unknown");
    this.pendingCommandId = crypto.randomUUID();
    headers.set("X-Remote-Storage-Generation", this.head.storage_generation);
    headers.set("X-Remote-Writer-Epoch", this.head.writer_epoch);
    headers.set("X-Remote-Expected-Revision", this.head.authoring_revision);
    headers.set("X-Remote-Command-Id", this.pendingCommandId);
  }

  accept(response: Response): void {
    const revision = response.headers.get("X-Remote-Result-Revision");
    if (revision === null) return;
    assertRemoteCounter(revision);
    const generation = response.headers.get("X-Remote-Storage-Generation");
    assertRemoteUuid(generation);
    const commandId = response.headers.get("X-Remote-Command-Id");
    const checksum = response.headers.get("X-Remote-Document-Checksum");
    if (generation !== this.head.storage_generation || commandId !== this.pendingCommandId
        || !checksum || !/^[0-9a-f]{64}$/.test(checksum) || BigInt(revision) < BigInt(this.head.authoring_revision)) {
      this.blocked = true;
      throw new Error("remote_contract_invalid");
    }
    this.head = { ...this.head, authoring_revision: revision, document_checksum: checksum };
    this.pendingCommandId = null;
    this.errorCode = null;
  }
}
