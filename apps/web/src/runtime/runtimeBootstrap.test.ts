import { afterEach, expect, it, vi } from "vitest";

afterEach(() => vi.resetModules());

it("does not invoke native commands in the browser", async () => {
  const { connectRuntime } = await import("./runtimeBootstrap");
  const invoke = vi.fn();
  await expect(connectRuntime({ desktop: false, invoke })).resolves.toBe("browser");
  expect(invoke).not.toHaveBeenCalled();
});

it("uses explicit external native development without starting a child", async () => {
  const { connectRuntime } = await import("./runtimeBootstrap");
  const { configuredRuntimeBaseUrl } = await import("./runtimeConnection");
  const invoke = vi.fn(async () => "http://127.0.0.1:8720");
  await expect(connectRuntime({ desktop: true, development: true, invoke })).resolves.toBe("external");
  expect(invoke).toHaveBeenCalledTimes(1);
  expect(invoke).toHaveBeenCalledWith("runtime_url");
  expect(configuredRuntimeBaseUrl()).toBe("http://127.0.0.1:8720/api");
});

it("fences requests before native readiness and allows explicit retry after startup failure", async () => {
  const { connectRuntime } = await import("./runtimeBootstrap");
  const owner = await import("./runtimeConnection");
  const invoke = vi.fn(async () => {
    expect(() => owner.configuredRuntimeBaseUrl()).toThrow("desktop_runtime_unavailable");
    throw new Error("private native payload");
  });
  await expect(connectRuntime({ desktop: true, development: false, invoke })).rejects.toThrow("desktop_runtime_unavailable");
  expect(invoke).toHaveBeenCalledTimes(1);
  expect(invoke).toHaveBeenCalledWith("start_bundled_runtime");
  const retry = vi.fn(async () => ({ origin: "http://127.0.0.1:51234", token: "A".repeat(43) }));
  await expect(connectRuntime({ desktop: true, development: false, invoke: retry })).resolves.toBe("bundled");
  expect(owner.configuredRuntimeBaseUrl()).toBe("http://127.0.0.1:51234/api");
});
