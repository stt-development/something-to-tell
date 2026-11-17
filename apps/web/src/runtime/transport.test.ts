import { afterEach, describe, expect, it, vi } from "vitest";
import { createRuntimeTransport, RuntimeApiError } from "./transport";

afterEach(() => {
  vi.useRealTimers();
});

describe("runtime transport", () => {
  it("owns session headers, JSON decoding, and authoring mutation tracking", async () => {
    const onMutation = vi.fn();
    const fetcher = vi.fn(async (_input: string, init?: RequestInit) => {
      expect(new Headers(init?.headers).get("X-Project-Session-Id")).toBe("session-active");
      return new Response(JSON.stringify({ id: "node-1" }), {
        headers: { "Content-Type": "application/json" },
        status: 200
      });
    });
    const transport = createRuntimeTransport({
      baseUrl: "http://runtime.test/api/",
      fetcher,
      projectSessionId: "session-active",
      onMutation
    });

    await expect(transport.sendJson("POST", "/nodes", { title: "Gate" })).resolves.toEqual({ id: "node-1" });
    expect(fetcher).toHaveBeenCalledWith(
      "http://runtime.test/api/nodes",
      expect.objectContaining({ body: JSON.stringify({ title: "Gate" }), method: "POST" })
    );
    expect(onMutation).toHaveBeenCalledOnce();
  });

  it("decodes stable runtime errors in one shared boundary", async () => {
    const transport = createRuntimeTransport({
      baseUrl: "http://runtime.test/api",
      fetcher: vi.fn(async () => new Response(JSON.stringify({
        detail: {
          code: "project_revision_stale",
          message_key: "project.revision_stale",
          parameters: { expected_revision: 4 }
        }
      }), { status: 409 }))
    });

    await expect(transport.getJson("/nodes")).rejects.toEqual(expect.objectContaining<Partial<RuntimeApiError>>({
      code: "project_revision_stale",
      messageKey: "project.revision_stale",
      parameters: { expected_revision: 4 },
      status: 409
    }));
  });

  it("does not mark read-only Style resolution as an authoring mutation", async () => {
    const onMutation = vi.fn();
    const transport = createRuntimeTransport({
      baseUrl: "http://runtime.test/api",
      fetcher: vi.fn(async () => new Response(JSON.stringify({ status: "unconfigured" }), {
        headers: { "Content-Type": "application/json" },
        status: 200
      })),
      onMutation
    });

    await transport.sendJson("POST", "/style-resolution/resolve", {});

    expect(onMutation).not.toHaveBeenCalled();
  });

  it("marks only candidate acceptance as an authoring mutation", async () => {
    const onMutation = vi.fn();
    const transport = createRuntimeTransport({
      baseUrl: "http://runtime.test/api",
      fetcher: vi.fn(async () => new Response(JSON.stringify({}), {
        headers: { "Content-Type": "application/json" },
        status: 200
      })),
      onMutation,
      projectSessionId: "session-active"
    });

    await transport.sendJson("POST", "/agent-memory/candidate-runs", {});
    await transport.sendJson("POST", "/agent-memory/candidate-runs/run-one/reject?session_id=session-active", {});
    expect(onMutation).not.toHaveBeenCalled();

    await transport.sendJson("POST", "/agent-memory/candidate-runs/run-one/accept?session_id=session-active", {});
    expect(onMutation).toHaveBeenCalledOnce();
  });

  it("cancels bounded requests through the transport-owned timeout", async () => {
    vi.useFakeTimers();
    const transport = createRuntimeTransport({
      baseUrl: "http://runtime.test/api",
      fetcher: vi.fn((_input: string, init?: RequestInit) => new Promise<Response>((_resolve, reject) => {
        init?.signal?.addEventListener("abort", () => reject(new DOMException("Aborted", "AbortError")));
      }))
    });

    const assertion = expect(transport.requestJsonWithTimeout("/slow", {}, 25)).rejects.toMatchObject({
      name: "AbortError"
    });
    await vi.advanceTimersByTimeAsync(25);
    await assertion;
  });
});
