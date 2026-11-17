import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { applyProjectLocale } from "../../localization/i18n";
import { useGraphStore } from "../../state/graphStore";
import { createProjectFixtureRuntimeFetch, projectFixture } from "../../testFixtures/projectFixtures";
import { ProjectStartScreen } from "./ProjectStartScreen";

beforeEach(async () => {
  useGraphStore.getState().closeActiveProject(); useGraphStore.setState(useGraphStore.getInitialState(), true);
  window.localStorage.clear(); await applyProjectLocale("en");
});
afterEach(() => { cleanup(); vi.unstubAllGlobals(); });
const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });

it.each([false, true])("a retired delayed startup Open never attaches; cleanup error is visible: %s", async (cleanupFails) => {
  const fallback = createProjectFixtureRuntimeFetch(), attach = vi.fn(useGraphStore.getState().attachProjectSession);
  useGraphStore.setState({ attachProjectSession: attach });
  let complete!: (response: Response) => void;
  const fetcher = vi.fn((input: string | URL | Request, init?: RequestInit) => {
    const url = String(input);
    if (url.endsWith("/project-sessions/open")) return new Promise<Response>((resolve) => { complete = resolve; });
    if (url.endsWith("/close") && cleanupFails) return Promise.reject(Error("cleanup unavailable"));
    return fallback(input, init);
  });
  vi.stubGlobal("fetch", fetcher); render(<ProjectStartScreen />);
  fireEvent.click(screen.getByRole("button", { name: "Open" }));
  fireEvent.click(await screen.findByRole("button", { name: /Project Aurora/ }));
  await waitFor(() => expect(complete).toBeDefined()); expect(useGraphStore.getState().runtimeStatus).toBe("loading");
  act(() => useGraphStore.getState().closeActiveProject());
  await act(async () => complete(json(projectFixture("aurora").response)));
  await waitFor(() => expect(fetcher.mock.calls.some(([url]) => String(url).endsWith("/close"))).toBe(true));
  expect(attach).not.toHaveBeenCalled(); expect(useGraphStore.getState().activeProjectId).toBe("");
  if (cleanupFails) await waitFor(() => expect(screen.getByRole("alert")).toHaveTextContent("Its session has not been released"));
  else expect(screen.queryByRole("alert")).not.toBeInTheDocument();
});

it("current startup Open failure remains visible instead of returning successful attachment", async () => {
  const fallback = createProjectFixtureRuntimeFetch();
  vi.stubGlobal("fetch", (input: string | URL | Request, init?: RequestInit) => String(input).endsWith("/project-sessions/open")
    ? Promise.reject(Error("open unavailable")) : fallback(input, init));
  render(<ProjectStartScreen />); fireEvent.click(screen.getByRole("button", { name: "Open" }));
  fireEvent.click(await screen.findByRole("button", { name: /Project Aurora/ }));
  await waitFor(() => expect(screen.getByRole("alert")).toHaveTextContent("open unavailable"));
  expect(useGraphStore.getState().activeSessionId).toBeNull(); expect(useGraphStore.getState().getActiveGraph().nodes).toHaveLength(0);
});
