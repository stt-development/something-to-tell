/** Recovery preserves editor drafts until explicitly accepted scoped publication. */
import { StrictMode, useState } from "react";
import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import type { RemoteStorageHeadV1 } from "@something-to-tell/contracts/remote-storage";
import { useGraphStore } from "../../state/graphStore";
import { projectFixture } from "../../testFixtures/projectFixtures";
import { projectSessionToGraphSnapshot } from "../../runtime/projections";
import { applyProjectLocale, tr } from "../../localization/i18n";
import samples from "../../../../../services/runtime/tests/fixtures/remote_storage_v1.json";
import { WorkspaceDialogProvider } from "../shell/WorkspaceDialog";
import { DialogShell } from "../shared/DialogShell";
import { RemoteRecoveryProvider } from "./RemoteRecoveryProvider";
import { useRemoteRecovery } from "./RemoteRecoveryContext";
import type { RemoteRecoveryMonitor } from "./remoteRecoveryMonitor";

let monitor: RemoteRecoveryMonitor;
let head: RemoteStorageHeadV1;
let response: ReturnType<typeof projectFixture>["response"];
let fetcher: ReturnType<typeof vi.fn>;
const canvasRender = vi.fn();
function Editor() {
  const [draft, setDraft] = useState("unsent words");
  const context = useRemoteRecovery(); monitor = context.monitor!;
  canvasRender();
  return <DialogShell title="Editor" onClose={() => {}}><input aria-label="Draft" value={draft} onChange={event => setDraft(event.target.value)} /></DialogShell>;
}
async function setup(locale: "en" | "ru" = "en") {
  await applyProjectLocale(locale);
  response = structuredClone(projectFixture("aurora").response);
  head = { ...samples.head, project_id: response.session.project_id, protocol_version: 1, state: "ready" } as RemoteStorageHeadV1;
  response.session = { ...response.session, session_version: 2, storage_mode: "postgresql", remote_state: "ready", remote_storage: head };
  await useGraphStore.getState().loadRuntimeSnapshot(async () => projectSessionToGraphSnapshot(response));
  fetcher = vi.fn(async (url: string, init?: RequestInit) => {
    const base = { protocol_version: 1, project_id: head.project_id, storage_generation: head.storage_generation,
      source_session_id: response.session.session_id, attempt_id: "", status: "ready", result_session_id: "session-new", error_code: null };
    if (url.endsWith("/remote-storage")) return Response.json(head);
    if (url.endsWith("/reconnect-attempts")) return Response.json({ ...base, attempt_id: JSON.parse(init!.body as string).attempt_id });
    if (url.includes("/reconnect-attempts/")) {
      const id = url.split("/reconnect-attempts/")[1]!.split(/[/?]/)[0]!;
      return Response.json({ ...base, attempt_id: id, ...(url.endsWith("/abandon") ? { status: "released", result_session_id: null } : {}) });
    }
    if (url.endsWith("/remote-storage/release")) return Response.json({ protocol_version: 1,
      session_id: response.session.session_id, project_id: head.project_id, storage_generation: head.storage_generation, status: "local_session_released" });
    if (url.endsWith("/project-sessions/session-new")) return Response.json({ ...response,
      session: { ...response.session, session_id: "session-new", remote_storage: { ...head, writer_epoch: "2" } } });
    throw Error(`Unexpected test route: ${url}`);
  });
  vi.stubGlobal("fetch", fetcher);
  const view = render(<StrictMode><WorkspaceDialogProvider><RemoteRecoveryProvider><Editor /></RemoteRecoveryProvider></WorkspaceDialogProvider></StrictMode>);
  const launch = screen.getByRole("button", { name: tr("remoteRecovery.open") });
  launch.focus();
  fireEvent.click(launch);
  return { ...view, launch };
}
const dialog = () => within(screen.getByRole("dialog", { name: tr("remoteRecovery.title") }));
function consent(key: "remoteRecovery.reloadConsent" | "remoteRecovery.releaseConsent") { fireEvent.click(dialog().getByRole("checkbox", { name: tr(key) })); }
async function begin() {
  consent("remoteRecovery.reloadConsent");
  fireEvent.click(dialog().getByRole("button", { name: tr("remoteRecovery.reconnect") }));
  await waitFor(() => expect(dialog().getByRole("button", { name: tr("remoteRecovery.lookup") })).toBeEnabled());
}
beforeEach(() => { useGraphStore.getState().closeActiveProject(); useGraphStore.setState(useGraphStore.getInitialState(), true); canvasRender.mockClear(); });
afterEach(async () => { vi.unstubAllGlobals(); await applyProjectLocale("en"); });

it.each(["en", "ru"] as const)("preserves drafts, focus, consent and isolated observation in %s", async locale => {
  const { launch } = await setup(locale);
  expect(fetcher).not.toHaveBeenCalled();
  expect(dialog().getByRole("button", { name: tr("remoteRecovery.reconnect") })).toBeDisabled();
  const renders = canvasRender.mock.calls.length;
  act(() => monitor.observe({ sessionId: monitor.sessionId, head, blocked: true, errorCode: "remote_tls_failed", unresolvedCommandId: null }));
  expect(canvasRender).toHaveBeenCalledTimes(renders);
  expect(screen.getByLabelText("Draft")).toHaveValue("unsent words");
  fireEvent.keyDown(screen.getByRole("dialog"), { key: "Escape" });
  expect(screen.queryByRole("dialog")).not.toBeInTheDocument(); expect(launch).toHaveFocus();
});

it("recovers a lost response by explicit lookup without another begin or draft replacement", async () => {
  await setup(); const actual = fetcher.getMockImplementation()!;
  fetcher.mockImplementation(async (url: string, init?: RequestInit) => {
    if (url.endsWith("/reconnect-attempts")) throw TypeError("lost reply");
    return actual(url, init);
  });
  await begin();
  expect(screen.getByLabelText("Draft")).toHaveValue("unsent words");
  fireEvent.click(dialog().getByRole("button", { name: tr("remoteRecovery.lookup") }));
  await waitFor(() => expect(dialog().getByRole("button", { name: tr("remoteRecovery.install") })).toBeEnabled());
  expect(fetcher.mock.calls.filter(([url]) => String(url).endsWith("/reconnect-attempts"))).toHaveLength(1);
  expect(useGraphStore.getState().activeSessionId).toBe(response.session.session_id);
  expect(screen.getByLabelText("Draft")).toHaveValue("unsent words");
});

it("installs only a confirmed new scoped session and never releases the adopted candidate", async () => {
  const view = await setup(); await begin();
  await waitFor(() => expect(dialog().getByRole("button", { name: tr("remoteRecovery.install") })).toBeEnabled());
  fireEvent.click(dialog().getByRole("button", { name: tr("remoteRecovery.install") }));
  await waitFor(() => expect(useGraphStore.getState().activeSessionId).toBe("session-new"));
  view.unmount();
  expect(fetcher.mock.calls.filter(([url]) => String(url).endsWith("/abandon"))).toHaveLength(0);
  expect(fetcher.mock.calls.some(([url]) => /\/save|\/discard/.test(String(url)))).toBe(false);
});

it("does not install a foreign candidate snapshot or clear drafts", async () => {
  await setup(); const actual = fetcher.getMockImplementation()!;
  fetcher.mockImplementation(async (url: string, init?: RequestInit) => url.endsWith("/project-sessions/session-new")
    ? Response.json({ ...response, session: { ...response.session, session_id: "foreign" } }) : actual(url, init));
  await begin(); fireEvent.click(dialog().getByRole("button", { name: tr("remoteRecovery.install") }));
  await waitFor(() => expect(dialog().getByRole("alert")).toBeInTheDocument());
  expect(useGraphStore.getState().activeSessionId).toBe(response.session.session_id);
  expect(screen.getByLabelText("Draft")).toHaveValue("unsent words");
});

it("requires exact pending-command resolution before reconnect", async () => {
  await setup();
  act(() => monitor.observe({ sessionId: monitor.sessionId, head, blocked: true, errorCode: "remote_commit_unknown", unresolvedCommandId: samples.guard.command_id }));
  consent("remoteRecovery.reloadConsent");
  expect(dialog().getByRole("button", { name: tr("remoteRecovery.reconnect") })).toBeDisabled();
  const actual = fetcher.getMockImplementation()!;
  fetcher.mockImplementation(async (url: string, init?: RequestInit) => url.includes("/remote-commands/")
    ? Response.json({ protocol_version: 1, project_id: head.project_id, storage_generation: head.storage_generation,
      command_id: samples.guard.command_id, status: "not_committed", receipt: null }) : actual(url, init));
  fireEvent.click(dialog().getByRole("button", { name: tr("remoteRecovery.resolve") }));
  await waitFor(() => expect(dialog().getByRole("button", { name: tr("remoteRecovery.reconnect") })).toBeEnabled());
  expect(fetcher.mock.calls.some(([url]) => String(url).endsWith("/reconnect-attempts"))).toBe(false);
});

it("page exit abandons a pending attempt with keepalive and never installs its late reply", async () => {
  const view = await setup(); const actual = fetcher.getMockImplementation()!;
  let finish!: (response: Response) => void;
  fetcher.mockImplementation(async (url: string, init?: RequestInit) => url.endsWith("/reconnect-attempts")
    ? new Promise<Response>(resolve => { finish = resolve; }) : actual(url, init));
  consent("remoteRecovery.reloadConsent");
  fireEvent.click(dialog().getByRole("button", { name: tr("remoteRecovery.reconnect") }));
  await waitFor(() => expect(finish).toBeTypeOf("function"));
  act(() => window.dispatchEvent(new Event("pagehide")));
  await waitFor(() => expect(fetcher.mock.calls.some(([url, init]) => String(url).endsWith("/abandon") && init?.keepalive)).toBe(true));
  const [, init] = fetcher.mock.calls.find(([url]) => String(url).endsWith("/reconnect-attempts"))!;
  const request = JSON.parse(init!.body as string);
  await act(async () => finish(Response.json({ ...request, confirmation: undefined, observed_revision: undefined, unresolved_command_id: undefined,
    source_session_id: monitor.sessionId, status: "ready", result_session_id: "session-new", error_code: null })));
  expect(useGraphStore.getState().activeSessionId).toBe(response.session.session_id);
  view.unmount();
});

it("explicit local close requires separate consent and never saves or discards", async () => {
  await setup();
  expect(dialog().getByRole("button", { name: tr("remoteRecovery.close") })).toBeDisabled();
  consent("remoteRecovery.releaseConsent");
  fireEvent.click(dialog().getByRole("button", { name: tr("remoteRecovery.close") }));
  await waitFor(() => expect(useGraphStore.getState().activeSessionId).toBeNull());
  expect(fetcher.mock.calls.filter(([url]) => String(url).endsWith("/release"))).toHaveLength(1);
  expect(fetcher.mock.calls.some(([url]) => /\/save|\/discard/.test(String(url)))).toBe(false);
});

it.each(["remote_storage_unavailable", "remote_storage_timeout", "remote_auth_failed", "remote_tls_failed",
  "remote_project_busy", "remote_revision_stale", "remote_writer_lost", "remote_schema_future", "remote_commit_unknown"])(
  "presents %s without automatic requests, empty data or draft replacement", async errorCode => {
    await setup();
    act(() => monitor.observe({ sessionId: monitor.sessionId, head, blocked: true, errorCode, unresolvedCommandId: null }));
    expect(dialog().getByRole("status")).not.toHaveTextContent("remote_");
    expect(fetcher).not.toHaveBeenCalled();
    expect(screen.getByLabelText("Draft")).toHaveValue("unsent words");
    expect(useGraphStore.getState().getActiveGraph().nodes.length).toBeGreaterThan(0);
  });

it("keeps the current workspace and draft after failed explicit close", async () => {
  await setup(); const actual = fetcher.getMockImplementation()!;
  fetcher.mockImplementation(async (url: string, init?: RequestInit) => url.endsWith("/release")
    ? Response.json({ detail: { code: "remote_storage_unavailable" } }, { status: 503 }) : actual(url, init));
  consent("remoteRecovery.releaseConsent");
  fireEvent.click(dialog().getByRole("button", { name: tr("remoteRecovery.close") }));
  await waitFor(() => expect(dialog().getByRole("alert")).toBeInTheDocument());
  expect(useGraphStore.getState().activeSessionId).toBe(response.session.session_id);
  expect(screen.getByLabelText("Draft")).toHaveValue("unsent words");
});

it("ignores a retired begin reply after page restoration and a newer lookup", async () => {
  await setup(); const actual = fetcher.getMockImplementation()!;
  let finish!: (value: Response) => void;
  let request: Record<string, unknown>;
  fetcher.mockImplementation(async (url: string, init?: RequestInit) => {
    if (url.endsWith("/reconnect-attempts")) {
      request = JSON.parse(init!.body as string);
      return new Promise<Response>(resolve => { finish = resolve; });
    }
    if (url.includes("/reconnect-attempts/")) return Response.json({ protocol_version: 1, project_id: head.project_id,
      storage_generation: head.storage_generation, source_session_id: monitor.sessionId, attempt_id: request.attempt_id,
      status: "released", result_session_id: null, error_code: null });
    return actual(url, init);
  });
  consent("remoteRecovery.reloadConsent");
  fireEvent.click(dialog().getByRole("button", { name: tr("remoteRecovery.reconnect") }));
  await waitFor(() => expect(finish).toBeTypeOf("function"));
  fireEvent.keyDown(screen.getByRole("dialog"), { key: "Escape" });
  expect(screen.getByRole("dialog")).toBeInTheDocument();
  act(() => { window.dispatchEvent(new Event("pagehide")); window.dispatchEvent(new Event("pageshow")); });
  fireEvent.click(dialog().getByRole("button", { name: tr("remoteRecovery.lookup") }));
  await screen.findByText(tr("remoteRecovery.attempt.released"));
  await act(async () => finish(Response.json({ protocol_version: 1, project_id: head.project_id, storage_generation: head.storage_generation,
    source_session_id: monitor.sessionId, attempt_id: request.attempt_id, status: "ready", result_session_id: "session-new", error_code: null })));
  expect(screen.getByText(tr("remoteRecovery.attempt.released"))).toBeInTheDocument();
  expect(dialog().getByRole("button", { name: tr("remoteRecovery.install") })).toBeDisabled();
});
