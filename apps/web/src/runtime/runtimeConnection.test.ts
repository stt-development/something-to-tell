import { afterEach, expect, it, vi } from "vitest";

const value = { origin: "http://127.0.0.1:51234", token: "A".repeat(43) };
afterEach(() => { vi.resetModules(); });

it.each([
  { ...value, origin: "https://127.0.0.1:51234" }, { ...value, origin: "http://elsewhere.example:51234" },
  { ...value, origin: "http://127.0.0.1:51234/api" }, { ...value, origin: "http://user@127.0.0.1:51234" },
  { ...value, origin: "http://127.0.0.1" }, { ...value, token: "short" }, { ...value, extra: true },
])("rejects invalid native connection without echoing its token: %j", async input => {
  const owner = await import("./runtimeConnection");
  expect(() => owner.installRuntimeConnection(input)).toThrow("desktop_runtime_unavailable");
  try { owner.installRuntimeConnection(input); } catch (error) { expect(String(error)).not.toContain(value.token); }
});

it("blocks pending requests and never falls back while a bundled runtime is starting", async () => {
  const owner = await import("./runtimeConnection");
  const { createRuntimeTransport } = await import("./transport");
  owner.requireBundledRuntime();
  expect(() => createRuntimeTransport()).toThrow("desktop_runtime_unavailable");
  const fetcher = vi.fn();
  await expect(createRuntimeTransport({ baseUrl: "http://127.0.0.1:8719/api", fetcher }).getJson("/health"))
    .rejects.toThrow("desktop_runtime_unavailable");
  expect(fetcher).not.toHaveBeenCalled();
});

it("authenticates reads, mutations and keepalive exit without modifying caller headers", async () => {
  const owner = await import("./runtimeConnection");
  const { createRuntimeTransport } = await import("./transport");
  owner.installRuntimeConnection(value);
  const fetcher = vi.fn(async (_input: string, _init?: RequestInit) => new Response("{}"));
  const client = createRuntimeTransport({ fetcher, projectSessionId: "owned" });
  const headers = new Headers({ "Content-Type": "application/json" });
  await client.getJson("/health");
  await client.sendJson("POST", "/nodes", {});
  await client.requestJson("/project-sessions/owned/exit", { method: "POST", headers, keepalive: true });
  for (const [input, init] of fetcher.mock.calls as unknown as [string, RequestInit][]) {
    expect(input).toContain(value.origin + "/api/");
    expect(new Headers(init.headers).get("Authorization")).toBe("Bearer " + value.token);
    expect(init.redirect).toBe("error");
    expect(init.credentials).toBe("omit");
  }
  expect(headers.has("Authorization")).toBe(false);
  expect(fetcher.mock.calls[2]?.[1]).toMatchObject({ keepalive: true });
});

it("includes auth on the separate session-recovery request", async () => {
  const owner = await import("./runtimeConnection");
  const { createRuntimeTransport } = await import("./transport");
  owner.installRuntimeConnection(value);
  let calls = 0;
  const fetcher = vi.fn(async (_input: string, init?: RequestInit) => {
    calls += 1;
    expect(new Headers(init?.headers).get("Authorization")).toBe("Bearer " + value.token);
    return new Response(JSON.stringify(calls === 1
      ? { detail: { code: "project_session_not_found" } }
      : calls === 2 ? { session: { session_id: "recovered" } } : { id: "node" }),
    { status: calls === 1 ? 404 : 200 });
  });
  const client = createRuntimeTransport({ fetcher, projectSessionId: "missing", projectPath: "/owned.narrative" });
  await expect(client.sendJson("POST", "/nodes", {})).resolves.toEqual({ id: "node" });
  expect(fetcher).toHaveBeenCalledTimes(3);
});

it("rejects off-origin credential forwarding and replacement after runtime loss", async () => {
  const owner = await import("./runtimeConnection");
  const { createRuntimeTransport } = await import("./transport");
  owner.installRuntimeConnection(value);
  const fetcher = vi.fn(async () => new Response("{}"));
  const client = createRuntimeTransport({ fetcher });
  await expect(createRuntimeTransport({ baseUrl: "http://untrusted.example/api", fetcher }).getJson("/health"))
    .rejects.toThrow("desktop_runtime_unavailable");
  expect(fetcher).not.toHaveBeenCalled();
  owner.markRuntimeUnavailable();
  expect(owner.configuredRuntimeBaseUrl()).toBe(value.origin + "/api");
  await expect(client.getJson("/health")).rejects.toThrow("desktop_runtime_unavailable");
  await expect(createRuntimeTransport({ fetcher }).getJson("/health")).rejects.toThrow("desktop_runtime_unavailable");
  expect(() => owner.installRuntimeConnection(value)).toThrow("desktop_runtime_unavailable");
  expect(fetcher).not.toHaveBeenCalled();
});

it("preserves browser defaults and explicit native development configuration without bearer auth", async () => {
  const owner = await import("./runtimeConnection");
  expect(owner.configuredRuntimeBaseUrl()).toBeNull();
  expect(owner.authorizeRuntimeRequest("http://runtime.test/api/health")).toBeUndefined();
  owner.configureDevelopmentRuntime("http://127.0.0.1:8720/");
  expect(owner.configuredRuntimeBaseUrl()).toBe("http://127.0.0.1:8720/api");
  expect(owner.authorizeRuntimeRequest("http://127.0.0.1:8720/api/health")).toBeUndefined();
});

it("keeps the connection out of browser persistence and rejects hidden authority replacement", async () => {
  const owner = await import("./runtimeConnection");
  const persist = vi.spyOn(Storage.prototype, "setItem");
  try {
    owner.installRuntimeConnection(value);
    expect(persist).not.toHaveBeenCalled();
    expect(() => owner.installRuntimeConnection({ ...value, token: "B".repeat(43) })).toThrow("desktop_runtime_unavailable");
    expect(() => owner.authorizeRuntimeRequest("not-a-valid-url")).toThrow("desktop_runtime_unavailable");
    expect(() => owner.configureDevelopmentRuntime("http://127.0.0.1:8719")).toThrow("desktop_runtime_unavailable");
  } finally { persist.mockRestore(); }
});
