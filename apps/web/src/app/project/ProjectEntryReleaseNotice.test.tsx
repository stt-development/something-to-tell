import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { applyProjectLocale } from "../../localization/i18n";
import { useGraphStore } from "../../state/graphStore";
import { projectFixture } from "../../testFixtures/projectFixtures";
import { enterProjectSession, ProjectEntryReleaseError } from "./projectSessionEntry";
import { ProjectEntryReleaseProvider, useProjectEntryReleaseReporter } from "./ProjectEntryReleaseNotice";
import samples from "../../../../../services/runtime/tests/fixtures/remote_reconnect_v1.json";

function Caller({ id = "unused", reason = "offline" }: { id?: string; reason?: string }) {
  const report = useProjectEntryReleaseReporter();
  return <button onClick={() => report(new ProjectEntryReleaseError(id, `Project ${id}`, Error(reason)))}>Report {id}</button>;
}
const response = (status = 200, code = "") => new Response(JSON.stringify(status === 200 ? {} : { detail: { code, message: code } }), { status, headers: { "content-type": "application/json" } });
beforeEach(async () => {
  useGraphStore.setState(useGraphStore.getInitialState(), true);
  await applyProjectLocale("en");
});
afterEach(async () => { vi.unstubAllGlobals(); await applyProjectLocale("en"); });

it("retains a late acquisition Close failure after its caller unmounts, then retries only that id", async () => {
  const acquired = projectFixture("aurora").response;
  let resolve!: (value: typeof acquired) => void;
  const pending = new Promise<typeof acquired>((yes) => { resolve = yes; });
  const fetcher = vi.fn(async () => response()); vi.stubGlobal("fetch", fetcher);
  let finished!: Promise<unknown>;
  function EntryCaller() {
    const report = useProjectEntryReleaseReporter();
    return <button onClick={() => {
      finished = enterProjectSession({
        loadSnapshot: useGraphStore.getState().loadRuntimeSnapshot, acquire: () => pending,
        activeSessionId: () => useGraphStore.getState().activeSessionId,
        close: async () => { throw Error("connection lost"); }, onReleaseFailure: report
      }).catch((error: unknown) => error);
    }}>Open pending</button>;
  }
  const view = render(<ProjectEntryReleaseProvider><EntryCaller /></ProjectEntryReleaseProvider>);
  fireEvent.click(screen.getByText("Open pending"));
  act(() => useGraphStore.getState().closeActiveProject());
  view.rerender(<ProjectEntryReleaseProvider><p>Replacement workspace</p></ProjectEntryReleaseProvider>);
  await act(async () => { resolve(acquired); expect(await finished).toBeInstanceOf(ProjectEntryReleaseError); });
  expect(screen.getByRole("alert")).toHaveTextContent("connection lost");
  fireEvent.click(screen.getByRole("button", { name: "Retry Close" }));
  await waitFor(() => expect(screen.queryByRole("alert")).not.toBeInTheDocument());
  expect(fetcher).toHaveBeenCalledTimes(1);
  const [url, options] = fetcher.mock.calls[0] as unknown as [string, RequestInit];
  expect(new URL(url).pathname).toBe(`/api/project-sessions/${encodeURIComponent(acquired.session.session_id)}/close`);
  expect(options).toMatchObject({ method: "POST", body: "{}" });
  expect(useGraphStore.getState().activeSessionId).toBeNull();
});

it("suppresses duplicate retries, retains failures and accepts authoritative missing-session release", async () => {
  let resolve!: (value: Response) => void;
  const fetcher = vi.fn(() => new Promise<Response>((yes) => { resolve = yes; })); vi.stubGlobal("fetch", fetcher);
  render(<ProjectEntryReleaseProvider><Caller /></ProjectEntryReleaseProvider>);
  fireEvent.click(screen.getByText("Report unused"));
  fireEvent.click(screen.getByRole("button", { name: "Retry Close" }));
  const busy = screen.getByRole("button", { name: "Closing session..." });
  fireEvent.click(busy); expect(busy).toBeDisabled(); expect(fetcher).toHaveBeenCalledTimes(1);
  await act(async () => { resolve(response(409, "project_unsaved_changes")); });
  expect(screen.getByRole("alert")).toBeInTheDocument();
  fireEvent.click(screen.getByRole("button", { name: "Retry Close" }));
  await act(async () => { resolve(response(404, "other_error")); });
  expect(screen.getByRole("alert")).toBeInTheDocument();
  fireEvent.click(screen.getByRole("button", { name: "Retry Close" }));
  await act(async () => { resolve(response(404, "project_session_not_found")); });
  expect(screen.queryByRole("alert")).not.toBeInTheDocument();
  expect(fetcher).toHaveBeenCalledTimes(3);
});

it("keeps newer same-id notices and other ids when an older retry completes", async () => {
  let resolve!: (value: Response) => void;
  vi.stubGlobal("fetch", vi.fn(() => new Promise<Response>((yes) => { resolve = yes; })));
  const content = (reason: string) => <ProjectEntryReleaseProvider><Caller reason={reason} /><Caller id="other" /></ProjectEntryReleaseProvider>;
  const view = render(content("first failure"));
  fireEvent.click(screen.getByText("Report unused"));
  fireEvent.click(screen.getByRole("button", { name: "Retry Close" }));
  view.rerender(content("new failure"));
  fireEvent.click(screen.getByText("Report unused")); fireEvent.click(screen.getByText("Report other"));
  expect(screen.getAllByRole("alert")).toHaveLength(2);
  await act(async () => { resolve(response()); });
  expect(screen.getAllByRole("alert")).toHaveLength(2);
  expect(screen.getByText(/new failure/)).toBeInTheDocument();
  expect(screen.queryByText(/first failure/)).not.toBeInTheDocument();
});

it("refuses an adopted active id and localizes retained notices without dropping them", async () => {
  const fetcher = vi.fn(async () => response()); vi.stubGlobal("fetch", fetcher);
  render(<ProjectEntryReleaseProvider><Caller /></ProjectEntryReleaseProvider>);
  fireEvent.click(screen.getByText("Report unused"));
  act(() => useGraphStore.setState({ activeSessionId: "unused" }));
  const alert = screen.getByRole("alert");
  expect(within(alert).getByRole("button", { name: "Retry Close" })).toBeDisabled();
  fireEvent.click(within(alert).getByRole("button")); expect(fetcher).not.toHaveBeenCalled();
  expect(alert).toHaveTextContent("This session is now active");
  await act(async () => { await applyProjectLocale("ru"); });
  expect(screen.getByLabelText("Сессия неактивного проекта")).toBeInTheDocument();
  expect(within(alert).getByRole("button", { name: "Повторить закрытие" })).toBeDisabled();
  act(() => useGraphStore.setState({ activeSessionId: "another-active-session" }));
  fireEvent.click(within(alert).getByRole("button"));
  await waitFor(() => expect(screen.queryByRole("alert")).not.toBeInTheDocument());
  expect(useGraphStore.getState().activeSessionId).toBe("another-active-session");
});

function ReconnectCaller() {
  const report = useProjectEntryReleaseReporter();
  return <button onClick={() => report(new ProjectEntryReleaseError("session-old", "Reconnect project", Error("lost cleanup"), {
    sourceSessionId: "session-old", projectId: samples.begin.project_id,
    generation: samples.begin.storage_generation, attemptId: samples.begin.attempt_id
  }))}>Report reconnect</button>;
}

it.each(["released", "pending", "adopted"])("retains scoped reconnect cleanup metadata across caller retirement: %s", async status => {
  const fetcher = vi.fn(async (url: string, _init?: RequestInit) => Response.json(url.endsWith("/abandon")
    ? { ...samples.outcome, status, result_session_id: null } : samples.outcome));
  vi.stubGlobal("fetch", fetcher);
  render(<ProjectEntryReleaseProvider><ReconnectCaller /></ProjectEntryReleaseProvider>);
  fireEvent.click(screen.getByText("Report reconnect"));
  if (status === "adopted") act(() => useGraphStore.setState({ activeSessionId: samples.outcome.result_session_id }));
  fireEvent.click(screen.getByRole("button", { name: "Retry Close" }));
  if (status === "pending") await waitFor(() => expect(screen.getByRole("button", { name: "Retry Close" })).toBeEnabled());
  else await waitFor(() => expect(screen.queryByRole("alert")).not.toBeInTheDocument());
  expect(fetcher.mock.calls.some(([url]) => String(url).endsWith("/close"))).toBe(false);
  expect(fetcher.mock.calls.filter(([url]) => String(url).endsWith("/abandon"))).toHaveLength(status === "adopted" ? 0 : 1);
  if (status === "pending") expect(screen.getByRole("alert")).toBeInTheDocument();
});
