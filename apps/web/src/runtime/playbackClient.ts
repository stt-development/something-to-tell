/* Playback runtime endpoint ownership. */
import type { PlaybackPreparation, PlaybackSession } from "../playback/contracts";
import type { RuntimePlaybackPersistence } from "./apiTypes";
import type { RuntimeTransport } from "./transport";
export function createPlaybackRuntimeClient(transport: RuntimeTransport): RuntimePlaybackPersistence {
  const { deleteResource, getJson, sendJson } = transport;
  return {
    async preparePlayback(command): Promise<PlaybackPreparation> {
      return sendJson<PlaybackPreparation>("POST", "/playback/prepare", command);
    },
    async startPlayback(command): Promise<PlaybackSession> {
      return sendJson<PlaybackSession>("POST", "/playback/sessions", command);
    },
    async inspectPlayback(sessionId, sourceRevision): Promise<PlaybackSession> {
      return getJson<PlaybackSession>(`/playback/sessions/${encodeURIComponent(sessionId)}?source_revision=${encodeURIComponent(sourceRevision)}`);
    },
    async choosePlayback(sessionId, command): Promise<PlaybackSession> {
      return sendJson<PlaybackSession>("POST", `/playback/sessions/${encodeURIComponent(sessionId)}/choices`, command);
    },
    async backPlayback(sessionId, command): Promise<PlaybackSession> {
      return sendJson<PlaybackSession>("POST", `/playback/sessions/${encodeURIComponent(sessionId)}/back`, command);
    },
    async restartPlayback(sessionId, command): Promise<PlaybackSession> {
      return sendJson<PlaybackSession>("POST", `/playback/sessions/${encodeURIComponent(sessionId)}/restart`, command);
    },
    async closePlayback(sessionId): Promise<void> {
      await deleteResource(`/playback/sessions/${encodeURIComponent(sessionId)}`);
    }
  };
}
