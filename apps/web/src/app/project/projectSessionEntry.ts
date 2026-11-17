import type { RuntimeGraphSnapshot, RuntimeProjectSessionResponse } from "../../runtime/apiTypes";
import { projectSessionToGraphSnapshot } from "../../runtime/projections";
import { RuntimeApiError } from "../../runtime/transport";
import { localizeRuntimeError, tr } from "../../localization/i18n";

type SnapshotLoader = (load: (isCurrent: () => boolean) => Promise<RuntimeGraphSnapshot>) => Promise<boolean>;
interface AcquisitionScope {
  isCurrent: () => boolean;
  retain: (response: RuntimeProjectSessionResponse) => RuntimeProjectSessionResponse;
}
class SupersededEntry extends Error {}

export interface ReconnectReleaseScope {
  sourceSessionId: string;
  projectId: string;
  generation: string;
  attemptId: string;
}

/** Preserve actionable ownership metadata, not a whole rejected project document. */
export class ProjectEntryReleaseError extends Error {
  constructor(readonly sessionId: string, readonly projectName: string, readonly releaseError: unknown,
    readonly reconnectScope?: ReconnectReleaseScope) {
    super(tr("projects.unusedSessionCloseFailed", { name: projectName, reason: localizeRuntimeError(releaseError) }));
    this.name = "ProjectEntryReleaseError";
  }
}

/** Only an authoritative missing-session response proves an earlier Close already completed. */
export async function closeAcquiredSession(close: (id: string) => Promise<unknown>, id: string) {
  try { await close(id); }
  catch (error) {
    if (!(error instanceof RuntimeApiError && error.status === 404 && error.code === "project_session_not_found")) throw error;
  }
}

/** Spans HTTP/setup with the store's single publication guard; never owns canonical state. */
export async function enterProjectSession({ loadSnapshot, acquire, beforeInstall, close, activeSessionId, onReleaseFailure }: {
  loadSnapshot: SnapshotLoader;
  acquire: (scope: AcquisitionScope) => Promise<RuntimeProjectSessionResponse>;
  beforeInstall?: (isCurrent: () => boolean) => Promise<void>;
  close: (id: string) => Promise<unknown>;
  activeSessionId: () => string | null;
  onReleaseFailure?: (error: ProjectEntryReleaseError) => void;
}): Promise<RuntimeProjectSessionResponse | null> {
  let retained: RuntimeProjectSessionResponse | null = null, failure: unknown = null;
  let current = () => true, accepted = false;
  const retain = (response: RuntimeProjectSessionResponse) => { retained = response; return response; };
  try {
    accepted = await loadSnapshot(async (isCurrent) => {
      current = isCurrent;
      try {
        const response = retain(await acquire({ retain, isCurrent }));
        if (!isCurrent()) throw new SupersededEntry();
        await beforeInstall?.(isCurrent);
        if (!isCurrent()) throw new SupersededEntry();
        return projectSessionToGraphSnapshot(response);
      } catch (error) { failure = error; throw error; }
    });
  } catch (error) { failure = error; }
  const response = retained as RuntimeProjectSessionResponse | null;
  if (accepted && response && activeSessionId() === response.session.session_id) return response;
  // An old request must never close a session that another path has already adopted.
  if (response && activeSessionId() !== response.session.session_id) {
    try { await closeAcquiredSession(close, response.session.session_id); }
    catch (error) {
      const name = typeof response.document?.manifest?.name === "string" ? response.document.manifest.name : response.session.project_id;
      const failure = new ProjectEntryReleaseError(response.session.session_id, name, error);
      onReleaseFailure?.(failure);
      throw failure;
    }
  }
  if (failure && !(failure instanceof SupersededEntry) && current()) throw failure;
  return null;
}
