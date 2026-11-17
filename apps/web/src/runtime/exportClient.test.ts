import type { ExportOptionsV1 } from "@something-to-tell/contracts/export";
import { describe, expect, it, vi } from "vitest";
import { createRuntimeApiClient } from "./apiClient";
import { createExportRuntimeClient } from "./exportClient";
import type { RuntimeTransport } from "./transport";

const options: ExportOptionsV1 = {
  options_version: 1,
  format: "json",
  scope: "whole_project",
  story_flow_ids: [],
  engine_tag_target: "generic",
  preview_max_bytes: 65_536
};

describe("export runtime client", () => {
  it("uses only the session-scoped plan and write routes", async () => {
    const sendJson = vi.fn(async () => ({}));
    const transport = { sendJson } as unknown as RuntimeTransport;
    const client = createExportRuntimeClient(transport);

    await client.createExportPlan("session/one", { request_version: 1, options });
    await client.writeExportArtifact("session/one", {
      request_version: 1,
      options,
      expected_source_checksum: "a".repeat(64),
      expected_plan_fingerprint: "b".repeat(64),
      destination_directory: null,
      overwrite: false
    });

    expect(sendJson.mock.calls.map((call) => call.slice(0, 2))).toEqual([
      ["POST", "/exports/session%2Fone/plans"],
      ["POST", "/exports/session%2Fone/writes"]
    ]);
  });

  it("does not report export planning or writing as authoring mutations", async () => {
    const onMutation = vi.fn();
    const fetcher = vi.fn(async () => new Response("{}", {
      status: 200,
      headers: { "Content-Type": "application/json" }
    }));
    const client = createRuntimeApiClient({
      baseUrl: "http://runtime.test/api",
      fetcher,
      onMutation,
      projectSessionId: "session-one"
    });

    await client.createExportPlan("session-one", { request_version: 1, options });
    await client.writeExportArtifact("session-one", {
      request_version: 1,
      options,
      expected_source_checksum: "a".repeat(64),
      expected_plan_fingerprint: "b".repeat(64),
      destination_directory: "/exports",
      overwrite: false
    });

    expect(fetcher).toHaveBeenCalledTimes(2);
    expect(onMutation).not.toHaveBeenCalled();
  });
});
