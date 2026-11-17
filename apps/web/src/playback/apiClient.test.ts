import { describe, expect, it } from "vitest";
import { createRuntimeApiClient } from "../runtime/apiClient";
import type {
  PlaybackChooseCommand,
  PlaybackPrepareCommand,
  PlaybackRestartCommand,
  PlaybackRevisionCommand,
  PlaybackStartCommand
} from "./contracts";

describe("playback runtime client", () => {
  it("maps prepare, start, and restart commands to versioned endpoints", async () => {
    const requests: Array<{ input: string; init?: RequestInit }> = [];
    const client = createRuntimeApiClient({
      baseUrl: "http://runtime.test/api",
      fetcher: async (input, init) => {
        requests.push({ input, init });
        return new Response(JSON.stringify({ id: "session-1" }), {
          headers: { "Content-Type": "application/json" },
          status: 200
        });
      }
    });
    const prepare = { command_version: 1, source_revision: "revision-1" } as unknown as PlaybackPrepareCommand;
    const start = { command_version: 1, visit_threshold: 3 } as unknown as PlaybackStartCommand;
    const restart = { command_version: 1, visit_threshold: null } as unknown as PlaybackRestartCommand;

    await client.preparePlayback(prepare);
    await client.startPlayback(start);
    await client.restartPlayback("session/1", restart);

    expect(requests.map((request) => [request.input, request.init?.method])).toEqual([
      ["http://runtime.test/api/playback/prepare", "POST"],
      ["http://runtime.test/api/playback/sessions", "POST"],
      ["http://runtime.test/api/playback/sessions/session%2F1/restart", "POST"]
    ]);
    expect(JSON.parse(String(requests[0]?.init?.body))).toEqual(prepare);
    expect(JSON.parse(String(requests[1]?.init?.body))).toEqual(start);
    expect(JSON.parse(String(requests[2]?.init?.body))).toEqual(restart);
  });

  it("maps inspect, choose, back, and close without local traversal logic", async () => {
    const requests: Array<{ input: string; init?: RequestInit }> = [];
    const client = createRuntimeApiClient({
      baseUrl: "http://runtime.test/api",
      fetcher: async (input, init) => {
        requests.push({ input, init });
        return init?.method === "DELETE"
          ? new Response(null, { status: 204 })
          : new Response(JSON.stringify({ id: "session-1" }), {
              headers: { "Content-Type": "application/json" },
              status: 200
            });
      }
    });
    const revision: PlaybackRevisionCommand = {
      command_version: 1,
      source_revision: "revision/2"
    };
    const choice: PlaybackChooseCommand = {
      ...revision,
      transition_id: "transition-a",
      allow_visit_threshold: true
    };

    await client.inspectPlayback("session/1", "revision/2");
    await client.choosePlayback("session/1", choice);
    await client.backPlayback("session/1", revision);
    await client.closePlayback("session/1");

    expect(requests.map((request) => [request.input, request.init?.method ?? "GET"])).toEqual([
      ["http://runtime.test/api/playback/sessions/session%2F1?source_revision=revision%2F2", "GET"],
      ["http://runtime.test/api/playback/sessions/session%2F1/choices", "POST"],
      ["http://runtime.test/api/playback/sessions/session%2F1/back", "POST"],
      ["http://runtime.test/api/playback/sessions/session%2F1", "DELETE"]
    ]);
    expect(JSON.parse(String(requests[1]?.init?.body))).toEqual(choice);
    expect(JSON.parse(String(requests[2]?.init?.body))).toEqual(revision);
  });
});
