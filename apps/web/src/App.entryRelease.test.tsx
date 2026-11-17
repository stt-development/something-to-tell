import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { App } from "./App";
import { applyProjectLocale } from "./localization/i18n";
import { projectSessionToGraphSnapshot } from "./runtime/projections";
import { useGraphStore } from "./state/graphStore";
import { createProjectFixtureRuntimeFetch, projectFixture } from "./testFixtures/projectFixtures";

beforeEach(async () => {
  useGraphStore.setState(useGraphStore.getInitialState(), true);
  localStorage.clear(); await applyProjectLocale("en");
});
afterEach(() => vi.unstubAllGlobals());

it("shows failed stale Open cleanup over the replacement workspace and retries without touching its session", async () => {
  const fallback = createProjectFixtureRuntimeFetch();
  const aurora = projectFixture("aurora").response, citadel = projectFixture("citadel").response;
  let complete!: (response: Response) => void, closeAttempts = 0;
  const fetcher = vi.fn((input: string | URL | Request, init?: RequestInit) => {
    const url = String(input);
    if (url.endsWith("/project-sessions/open")) return new Promise<Response>((yes) => { complete = yes; });
    if (url.endsWith(`/project-sessions/${encodeURIComponent(aurora.session.session_id)}/close`)) {
      closeAttempts++;
      return closeAttempts === 1 ? Promise.reject(Error("inactive cleanup offline"))
        : Promise.resolve(new Response("{}", { status: 200, headers: { "content-type": "application/json" } }));
    }
    return fallback(input, init);
  });
  vi.stubGlobal("fetch", fetcher); render(<App />);
  fireEvent.click(screen.getByRole("button", { name: "Open" }));
  fireEvent.click(await screen.findByRole("button", { name: /Project Aurora/ }));
  await waitFor(() => expect(complete).toBeDefined());
  await act(async () => {
    await useGraphStore.getState().loadRuntimeSnapshot(async () => projectSessionToGraphSnapshot(citadel));
  });
  expect(screen.getByRole("heading", { name: citadel.document.manifest.name })).toBeInTheDocument();
  await act(async () => { complete(new Response(JSON.stringify(aurora), { status: 200, headers: { "content-type": "application/json" } })); });
  expect(await screen.findByRole("alert")).toHaveTextContent("inactive cleanup offline");
  fireEvent.click(screen.getByRole("button", { name: "Retry Close" }));
  await waitFor(() => expect(screen.queryByText(/inactive cleanup offline/)).not.toBeInTheDocument());
  expect(closeAttempts).toBe(2);
  expect(useGraphStore.getState().activeSessionId).toBe(citadel.session.session_id);
  expect(fetcher.mock.calls.filter(([url]) => String(url).endsWith("/close"))).toHaveLength(2);
  expect(fetcher.mock.calls.some(([url]) => /\/(save|discard|exit)$/.test(String(url)))).toBe(false);
});
