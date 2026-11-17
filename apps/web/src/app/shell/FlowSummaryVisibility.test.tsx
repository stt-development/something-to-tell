import { ReactFlowProvider } from "@xyflow/react";
import { act, cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import type { ComponentProps, ReactNode } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { applyProjectLocale, tr } from "../../localization/i18n";
import { projectFixture } from "../../testFixtures/projectFixtures";
import { FlowSummaryToggle, FlowSummaryVisibilityProvider, VisibleFlowSummary } from "./FlowSummaryVisibility";
import { GraphFilterToggle, GraphFilterVisibilityProvider, HiddenWhileGraphFiltersOpen } from "./GraphFilterVisibility";

const flow = projectFixture("aurora").storyFlows[0]!;
const defaultProps: ComponentProps<typeof VisibleFlowSummary> = { flow, facts: [], onFocusFact: () => {} };

function Providers({ children }: { children: ReactNode }) {
  return <ReactFlowProvider><GraphFilterVisibilityProvider><FlowSummaryVisibilityProvider>
    {children}
  </FlowSummaryVisibilityProvider></GraphFilterVisibilityProvider></ReactFlowProvider>;
}

function Slots(props: ComponentProps<typeof VisibleFlowSummary>) {
  return <><FlowSummaryToggle /><GraphFilterToggle />
    <HiddenWhileGraphFiltersOpen><VisibleFlowSummary {...props} /></HiddenWhileGraphFiltersOpen>
  </>;
}

describe("local Flow summary visibility", () => {
  beforeEach(async () => { await applyProjectLocale("en"); });
  afterEach(cleanup);

  it("defaults open and closes/reopens without rendering workspace or canvas siblings", () => {
    const workspaceRender = vi.fn();
    const canvasRender = vi.fn();
    function Canvas() { canvasRender(); return <div>Canvas</div>; }
    function Workspace() { workspaceRender(); return <><Slots {...defaultProps} /><Canvas /></>; }
    render(<Providers><Workspace /></Providers>);
    const summary = screen.getByLabelText("Flow summary");
    expect(summary.closest(".flow-summary-panel")).toHaveClass("top", "right");
    fireEvent.click(within(summary).getByRole("button", { name: "Hide Flow summary" }));
    expect(screen.queryByLabelText("Flow summary")).not.toBeInTheDocument();
    const toggle = screen.getByRole("button", { name: "Show Flow summary" });
    toggle.focus();
    fireEvent.click(toggle);
    expect(toggle).toHaveFocus();
    expect(toggle.closest(".tooltip-wrapper")).toHaveAttribute("data-tooltip", "Hide Flow summary");
    expect(screen.getByLabelText("Flow summary")).toHaveTextContent(flow.flow.name);
    fireEvent.click(toggle);
    expect(screen.queryByLabelText("Flow summary")).not.toBeInTheDocument();
    expect(workspaceRender).toHaveBeenCalledOnce();
    expect(canvasRender).toHaveBeenCalledOnce();
  });

  it("keeps explicit summary state separate from temporary search suppression", () => {
    const workspaceRender = vi.fn();
    function Workspace() { workspaceRender(); return <Slots {...defaultProps} />; }
    render(<Providers><Workspace /></Providers>);
    fireEvent.click(screen.getByRole("button", { name: "Show graph filters" }));
    expect(screen.queryByLabelText("Flow summary")).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Hide graph filters" }));
    expect(screen.getByLabelText("Flow summary")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Show graph filters" }));
    fireEvent.click(screen.getByRole("button", { name: "Hide Flow summary" }));
    fireEvent.click(screen.getByRole("button", { name: "Hide graph filters" }));
    expect(screen.queryByLabelText("Flow summary")).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Show Flow summary" }));
    expect(screen.getByLabelText("Flow summary")).toBeInTheDocument();
    expect(workspaceRender).toHaveBeenCalledOnce();
  });

  it("shows current flow/facts and uses the current focus callback after reopening", () => {
    const oldFocus = vi.fn();
    const nextFocus = vi.fn();
    const view = render(<Providers><Slots {...defaultProps} onFocusFact={oldFocus} /></Providers>);
    fireEvent.click(within(screen.getByLabelText("Flow summary")).getByRole("button", { name: "Hide Flow summary" }));
    const nextFlow = { ...flow, flow: { ...flow.flow, name: "Updated flow" } };
    view.rerender(<Providers><Slots flow={nextFlow} onFocusFact={nextFocus} facts={[{
      code: "ending", level: "info", message: "Focus ending", action: "Inspect target",
      flow_id: flow.flow.id, node_id: "ending-target", transition_id: null, scene_node_id: null,
      container_node_id: null, placement_id: null, relationship_id: null
    }]} /></Providers>);
    expect(screen.queryByLabelText("Flow summary")).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Show Flow summary" }));
    expect(screen.getByLabelText("Flow summary")).toHaveTextContent("Updated flow");
    fireEvent.click(screen.getByTitle("Inspect target"));
    expect(nextFocus).toHaveBeenCalledWith("ending-target");
    expect(oldFocus).not.toHaveBeenCalled();
  });

  it("retains the flag across mode/Playback-like replacement, then resets with a new workspace", () => {
    const view = render(<Providers><Slots {...defaultProps} /></Providers>);
    fireEvent.click(within(screen.getByLabelText("Flow summary")).getByRole("button", { name: "Hide Flow summary" }));
    view.rerender(<Providers><section>Playback</section></Providers>);
    view.rerender(<Providers><Slots {...defaultProps} /></Providers>);
    expect(screen.queryByLabelText("Flow summary")).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Show Flow summary" })).toBeInTheDocument();
    view.unmount();
    render(<Providers><Slots {...defaultProps} /></Providers>);
    expect(screen.getByLabelText("Flow summary")).toBeInTheDocument();
  });

  it("updates EN/RU labels without resetting visibility", async () => {
    render(<Providers><Slots {...defaultProps} /></Providers>);
    await act(async () => { await applyProjectLocale("ru"); });
    expect(screen.getByLabelText(tr("flow.summary"))).toBeInTheDocument();
    fireEvent.click(within(screen.getByLabelText(tr("flow.summary"))).getByRole("button", { name: tr("flow.hideSummary") }));
    expect(screen.getByRole("button", { name: tr("flow.showSummary") })).toBeInTheDocument();
    await act(async () => { await applyProjectLocale("en"); });
    expect(screen.queryByLabelText("Flow summary")).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Show Flow summary" })).toBeInTheDocument();
  });
});
