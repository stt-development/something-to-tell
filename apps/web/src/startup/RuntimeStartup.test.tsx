import { StrictMode } from "react";
import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { applyProjectLocale } from "../localization/i18n";
import { RuntimeStartup } from "./RuntimeStartup";

beforeEach(async () => {
  await applyProjectLocale("en");
  // JSDOM has no native dialog top layer; browser tests cover actual inertness.
  vi.spyOn(HTMLDialogElement.prototype, "focus").mockImplementation(function (this: HTMLDialogElement) {
    HTMLElement.prototype.focus.call(this);
  });
  Object.defineProperty(HTMLDialogElement.prototype, "showModal", { configurable: true, value: function (this: HTMLDialogElement) { this.setAttribute("open", ""); } });
});
afterEach(() => {
  vi.restoreAllMocks();
  delete window.__TAURI_INTERNALS__;
  delete (HTMLDialogElement.prototype as unknown as Record<string, unknown>).showModal;
});

it("does not import/mount application clients before readiness, even in StrictMode", async () => {
  let ready!: (value: "bundled") => void;
  const connect = vi.fn(() => new Promise<"bundled">(resolve => { ready = resolve; }));
  const load = vi.fn(async () => ({ App: () => <p>Ready editor</p> }));
  render(<StrictMode><RuntimeStartup connect={connect} loadApplication={load} isRunning={async () => true} /></StrictMode>);
  expect(screen.getByRole("progressbar")).toBeInTheDocument();
  expect(load).not.toHaveBeenCalled();
  expect(connect).toHaveBeenCalledTimes(1);
  await act(async () => ready("bundled"));
  expect(await screen.findByText("Ready editor")).toBeInTheDocument();
  expect(load).toHaveBeenCalledTimes(1);
});

it("shows a localized failure with deliberate retry and never reflects native errors", async () => {
  await applyProjectLocale("ru");
  const connect = vi.fn().mockRejectedValueOnce(new Error("private-token" )).mockResolvedValueOnce("external");
  const load = vi.fn(async () => ({ App: () => <p>Ready editor</p> }));
  render(<RuntimeStartup connect={connect} loadApplication={load} />);
  expect(await screen.findByRole("alert")).toHaveTextContent("Не удалось запустить приложение.");
  expect(screen.queryByText("private-token")).not.toBeInTheDocument();
  expect(load).not.toHaveBeenCalled();
  fireEvent.click(screen.getByRole("button", { name: "Повторить" }));
  expect(await screen.findByText("Ready editor")).toBeInTheDocument();
  expect(connect).toHaveBeenCalledTimes(2);
});

it("retains editor drafts but fences shortcuts after child loss without reconnecting", async () => {
  const connect = vi.fn(async () => "bundled" as const);
  const isRunning = vi.fn(async () => false);
  const load = vi.fn(async () => ({ App: () => <input aria-label="Draft" defaultValue="unsaved" /> }));
  render(<RuntimeStartup connect={connect} loadApplication={load} isRunning={isRunning} pollInterval={10} />);
  const draft = await screen.findByRole("textbox", { name: "Draft" });
  fireEvent.change(draft, { target: { value: "retained draft" } });
  const dialog = await screen.findByRole("alertdialog");
  expect(dialog).toHaveAttribute("open");
  expect(draft).toHaveValue("retained draft");
  const background = vi.fn();
  window.addEventListener("keydown", background);
  fireEvent.keyDown(window, { key: "Delete" });
  window.removeEventListener("keydown", background);
  expect(background).not.toHaveBeenCalled();
  expect(connect).toHaveBeenCalledTimes(1);
  expect(screen.queryByRole("button", { name: "Try again" })).not.toBeInTheDocument();
  await waitFor(() => expect(isRunning).toHaveBeenCalledTimes(1));
});

it("requires explicit close confirmation after runtime loss and keeps Cancel available", async () => {
  let request: number | null = null;
  const invoke = vi.fn(async (command: string, payload?: Record<string, unknown>) => {
    if (command === "native_close_request") return request;
    if (command === "resolve_native_close") { request = null; return payload; }
    throw new Error("unexpected command");
  });
  window.__TAURI_INTERNALS__ = { invoke };
  render(<RuntimeStartup connect={async () => "bundled"} isRunning={async () => false}
    pollInterval={5} loadApplication={async () => ({ App: () => <input aria-label="Draft" defaultValue="retained" /> })} />);
  await screen.findByRole("alertdialog");
  request = 1;
  fireEvent.click(await screen.findByRole("button", { name: "Cancel" }));
  await waitFor(() => expect(invoke).toHaveBeenCalledWith("resolve_native_close", { requestId: 1, approve: false }));
  expect(screen.getByLabelText("Draft")).toHaveValue("retained");
  expect(invoke).not.toHaveBeenCalledWith("resolve_native_close", { requestId: 1, approve: true });
  request = 2;
  fireEvent.click(await screen.findByRole("button", { name: "Close application" }));
  await waitFor(() => expect(invoke).toHaveBeenCalledWith("resolve_native_close", { requestId: 2, approve: true }));
});
