import type { ProjectSessionState } from "@something-to-tell/contracts/project-session";
import { act, cleanup, render, screen } from "@testing-library/react";
import { createRef } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { applyProjectLocale } from "../../localization/i18n";
import { projectFixture } from "../../testFixtures/projectFixtures";
import { SaveStatusIndicator, type SavedConfirmationHandle } from "./SaveStatusIndicator";

function session(save_status: ProjectSessionState["save_status"] = "clean"): ProjectSessionState {
  return { ...projectFixture("aurora").response.session, save_status };
}

describe("local save feedback lifetime", () => {
  beforeEach(async () => {
    await applyProjectLocale("en");
    vi.useFakeTimers();
  });

  afterEach(() => {
    cleanup();
    vi.useRealTimers();
  });

  it("shows confirmation for three seconds without rendering its parent or canvas sibling", () => {
    const ref = createRef<SavedConfirmationHandle>();
    const canvasRender = vi.fn();
    const parentRender = vi.fn();
    function Canvas() { canvasRender(); return <div>Canvas</div>; }
    function Host() {
      parentRender();
      return <><Canvas /><SaveStatusIndicator ref={ref} session={session()} /></>;
    }
    render(<Host />);
    expect(screen.queryByRole("status")).not.toBeInTheDocument();

    act(() => ref.current!.show());
    expect(screen.getByLabelText("Save status")).toHaveTextContent("Saved");
    act(() => vi.advanceTimersByTime(2999));
    expect(screen.getByRole("status")).toBeInTheDocument();
    act(() => vi.advanceTimersByTime(1));
    expect(screen.queryByRole("status")).not.toBeInTheDocument();
    expect(parentRender).toHaveBeenCalledOnce();
    expect(canvasRender).toHaveBeenCalledOnce();
  });

  it("restarts the expiry on a second successful save", () => {
    const ref = createRef<SavedConfirmationHandle>();
    render(<SaveStatusIndicator ref={ref} session={session()} />);
    act(() => ref.current!.show());
    act(() => vi.advanceTimersByTime(2000));
    act(() => ref.current!.show());
    expect(vi.getTimerCount()).toBe(1);
    act(() => vi.advanceTimersByTime(1000));
    expect(screen.getByRole("status")).toBeInTheDocument();
    act(() => vi.advanceTimersByTime(2000));
    expect(screen.queryByRole("status")).not.toBeInTheDocument();
  });

  it.each(["saving", "error"] as const)("keeps %s visible after confirmation expires", (status) => {
    const ref = createRef<SavedConfirmationHandle>();
    const view = render(<SaveStatusIndicator ref={ref} session={session()} />);
    act(() => ref.current!.show());
    view.rerender(<SaveStatusIndicator ref={ref} session={session(status)} />);
    act(() => vi.advanceTimersByTime(3000));
    expect(screen.getByRole("status")).toHaveClass(`save-status-${status}`);
    expect(screen.getByRole("status")).toHaveTextContent(status === "saving" ? "Saving" : "Save failed");
  });

  it("does not invent a success confirmation for clean, dirty or absent sessions", () => {
    const view = render(<SaveStatusIndicator session={session()} />);
    expect(screen.queryByRole("status")).not.toBeInTheDocument();
    view.rerender(<SaveStatusIndicator session={session("dirty")} />);
    expect(screen.queryByRole("status")).not.toBeInTheDocument();
    view.rerender(<SaveStatusIndicator session={null} />);
    expect(screen.queryByRole("status")).not.toBeInTheDocument();
  });

  it("cancels feedback and its old timer on keyed session replacement", () => {
    const ref = createRef<SavedConfirmationHandle>();
    const view = render(<SaveStatusIndicator key="first" ref={ref} session={session()} />);
    act(() => ref.current!.show());
    const firstHandle = ref.current;
    const secondSession = { ...session(), session_id: "second" };
    view.rerender(<SaveStatusIndicator key="second" ref={ref} session={secondSession} />);
    expect(screen.queryByRole("status")).not.toBeInTheDocument();
    expect(ref.current).not.toBe(firstHandle);
    expect(vi.getTimerCount()).toBe(0);
    act(() => ref.current!.show());
    expect(screen.getByRole("status")).toBeInTheDocument();
    view.unmount();
    expect(vi.getTimerCount()).toBe(0);
    expect(ref.current).toBeNull();
  });

  it("updates the visible confirmation language without a new save or timer", async () => {
    const ref = createRef<SavedConfirmationHandle>();
    render(<SaveStatusIndicator ref={ref} session={session()} />);
    act(() => ref.current!.show());
    await act(async () => { await applyProjectLocale("ru"); });
    expect(screen.getByRole("status")).not.toHaveTextContent("Saved");
    expect(screen.getByRole("status").textContent).not.toContain("save.clean");
    expect(vi.getTimerCount()).toBe(1);
    act(() => vi.advanceTimersByTime(3000));
    expect(screen.queryByRole("status")).not.toBeInTheDocument();
  });
});
