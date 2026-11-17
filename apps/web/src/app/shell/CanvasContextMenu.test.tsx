import { act, cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import type { ComponentProps } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { applyProjectLocale, tr } from "../../localization/i18n";
import { CanvasContextMenu, CanvasContextMenuProvider, useCanvasContextMenuDispatch } from "./CanvasContextMenu";

const pane = { x: 560, y: 760, flowX: 0, flowY: 0 };

function Controls(props: ComponentProps<typeof CanvasContextMenu>) {
  const dispatch = useCanvasContextMenuDispatch();
  return <>
    <button onClick={() => dispatch(pane)}>Open test menu</button>
    <button onClick={() => dispatch((menu) => menu ? { ...menu, x: 400, y: 100 } : null)}>Move test menu</button>
    <button onClick={() => dispatch(null)}>Close test menu</button>
    <CanvasContextMenu {...props} />
  </>;
}

describe("local canvas context menu", () => {
  beforeEach(async () => { await applyProjectLocale("en"); });
  afterEach(cleanup);

  it("opens, repositions and command-closes without rendering dispatch-only workspace/canvas siblings", () => {
    const workspaceRender = vi.fn();
    const canvasRender = vi.fn();
    const onCreate = vi.fn();
    const onAnalyze = vi.fn();
    function Canvas() { canvasRender(); return <div>Canvas</div>; }
    function Workspace() { workspaceRender(); return <><Controls onCreate={onCreate} onAnalyze={onAnalyze} /><Canvas /></>; }
    render(<CanvasContextMenuProvider><Workspace /></CanvasContextMenuProvider>);
    expect(screen.queryByRole("menu")).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Open test menu" }));
    expect(screen.getByRole("menu")).toHaveStyle({ left: "560px", top: `${window.innerHeight - 424}px` });
    fireEvent.click(screen.getByRole("button", { name: "Move test menu" }));
    expect(screen.getByRole("menu")).toHaveStyle({ left: "400px", top: "100px" });
    fireEvent.click(screen.getByRole("button", { name: "Close test menu" }));
    expect(screen.queryByRole("menu")).not.toBeInTheDocument();
    expect(workspaceRender).toHaveBeenCalledOnce();
    expect(canvasRender).toHaveBeenCalledOnce();
    expect(onCreate).not.toHaveBeenCalled();
    expect(onAnalyze).not.toHaveBeenCalled();
  });

  it.each(["Character", "Scene", "Location"] as const)("forwards %s creation at zero flow coordinates then closes", (kind) => {
    const onCreate = vi.fn();
    render(<CanvasContextMenuProvider><Controls onCreate={onCreate} onAnalyze={vi.fn()} /></CanvasContextMenuProvider>);
    fireEvent.click(screen.getByRole("button", { name: "Open test menu" }));
    const label = kind === "Scene" ? tr("tool.sceneFrame") : kind === "Location" ? tr("tool.locationFrame") : "Character";
    fireEvent.click(within(screen.getByRole("menu")).getByRole("button", { name: label }));
    expect(onCreate).toHaveBeenCalledWith(kind, { x: 0, y: 0 });
    expect(screen.queryByRole("menu")).not.toBeInTheDocument();
  });

  it.each(["node", "relationship"] as const)("forwards the exact %s analysis target without exposing creation actions", (owner_type) => {
    const resource = { owner_type, owner_id: "target", context_type: null, context_id: null };
    const onAnalyze = vi.fn();
    const onCreate = vi.fn();
    function Workspace() {
      const dispatch = useCanvasContextMenuDispatch();
      return <>
        <button onClick={() => dispatch({ x: 80, y: 90, impactResource: resource })}>Open target menu</button>
        <CanvasContextMenu onCreate={onCreate} onAnalyze={(target) => { onAnalyze(target); dispatch(null); }} />
      </>;
    }
    render(<CanvasContextMenuProvider><Workspace /></CanvasContextMenuProvider>);
    fireEvent.click(screen.getByRole("button", { name: "Open target menu" }));
    const menu = screen.getByRole("menu");
    expect(within(menu).queryByRole("button", { name: "Character" })).not.toBeInTheDocument();
    fireEvent.click(within(menu).getByRole("button", { name: tr("impact.openWorkspace") }));
    expect(onAnalyze).toHaveBeenCalledWith(resource);
    expect(onCreate).not.toHaveBeenCalled();
    expect(screen.queryByRole("menu")).not.toBeInTheDocument();
  });

  it("uses the current callback when menu coordinates were captured before parent refresh", () => {
    const first = vi.fn();
    const latest = vi.fn();
    const onAnalyze = vi.fn();
    const view = render(<CanvasContextMenuProvider><Controls onCreate={first} onAnalyze={onAnalyze} /></CanvasContextMenuProvider>);
    fireEvent.click(screen.getByRole("button", { name: "Open test menu" }));
    view.rerender(<CanvasContextMenuProvider><Controls onCreate={latest} onAnalyze={onAnalyze} /></CanvasContextMenuProvider>);
    fireEvent.click(within(screen.getByRole("menu")).getByRole("button", { name: "Character" }));
    expect(latest).toHaveBeenCalledWith("Character", { x: 0, y: 0 });
    expect(first).not.toHaveBeenCalled();
  });

  it("updates localized menu labels without replacing its captured coordinates", async () => {
    render(<CanvasContextMenuProvider><Controls onCreate={vi.fn()} onAnalyze={vi.fn()} /></CanvasContextMenuProvider>);
    fireEvent.click(screen.getByRole("button", { name: "Open test menu" }));
    await act(async () => { await applyProjectLocale("ru"); });
    const menu = screen.getByRole("menu", { name: tr("authoring.createNode") });
    expect(within(menu).getByRole("button", { name: tr("tool.sceneFrame") })).toBeInTheDocument();
    expect(menu).toHaveStyle({ left: "560px" });
  });

  it("retains menu state across mode-like child replacement and resets when workspace unmounts", () => {
    const props = { onCreate: vi.fn(), onAnalyze: vi.fn() };
    const view = render(<CanvasContextMenuProvider><Controls {...props} /></CanvasContextMenuProvider>);
    fireEvent.click(screen.getByRole("button", { name: "Open test menu" }));
    view.rerender(<CanvasContextMenuProvider><section>Playback</section></CanvasContextMenuProvider>);
    view.rerender(<CanvasContextMenuProvider><Controls {...props} /></CanvasContextMenuProvider>);
    expect(screen.getByRole("menu")).toBeInTheDocument();
    view.unmount();
    render(<CanvasContextMenuProvider><Controls {...props} /></CanvasContextMenuProvider>);
    expect(screen.queryByRole("menu")).not.toBeInTheDocument();
  });
});
