import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { useState } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { applyProjectLocale, tr } from "../../localization/i18n";
import { ISSUE_SEVERITIES, NODE_KINDS, type GraphFilterState } from "../workspaceShared";
import { GraphFilterToggle, GraphFilterVisibilityProvider, HiddenWhileGraphFiltersOpen, VisibleGraphFilterBar } from "./GraphFilterVisibility";

const defaultFilters: GraphFilterState = {
  query: "", kinds: NODE_KINDS, issueSeverities: ISSUE_SEVERITIES, issueStatuses: ["open", "review"]
};

function Slots({ filters = defaultFilters, onChange = () => {} }: {
  filters?: GraphFilterState;
  onChange?: (filters: GraphFilterState) => void;
}) {
  return <>
    <GraphFilterToggle />
    <VisibleGraphFilterBar filters={filters} leftOffset={344} onChange={onChange} resultCount={1} totalCount={1} />
    <HiddenWhileGraphFiltersOpen><p>Flow summary</p></HiddenWhileGraphFiltersOpen>
  </>;
}

describe("local graph filter visibility", () => {
  beforeEach(async () => { await applyProjectLocale("en"); });
  afterEach(cleanup);

  it("toggles panel and summary without rendering workspace/canvas siblings or changing filters", () => {
    const workspaceRender = vi.fn();
    const canvasRender = vi.fn();
    const onChange = vi.fn();
    function Canvas() { canvasRender(); return <div>Canvas</div>; }
    function Workspace() { workspaceRender(); return <><Slots onChange={onChange} /><Canvas /></>; }
    render(<GraphFilterVisibilityProvider><Workspace /></GraphFilterVisibilityProvider>);
    const toggle = screen.getByRole("button", { name: "Show graph filters" });
    toggle.focus();
    expect(screen.queryByLabelText("Search graph")).not.toBeInTheDocument();
    expect(screen.getByText("Flow summary")).toBeInTheDocument();
    fireEvent.click(toggle);
    expect(toggle).toHaveFocus();
    expect(toggle).toHaveAttribute("aria-label", "Hide graph filters");
    expect(toggle.closest(".tooltip-wrapper")).toHaveAttribute("data-tooltip", tr("workspace.hideFilters"));
    expect(screen.getByLabelText("Search graph").closest("section")).toHaveStyle({ left: "344px" });
    expect(screen.queryByText("Flow summary")).not.toBeInTheDocument();
    fireEvent.click(toggle);
    expect(screen.queryByLabelText("Search graph")).not.toBeInTheDocument();
    expect(screen.getByText("Flow summary")).toBeInTheDocument();
    expect(workspaceRender).toHaveBeenCalledOnce();
    expect(canvasRender).toHaveBeenCalledOnce();
    expect(onChange).not.toHaveBeenCalled();
  });

  it("retains controlled criteria while hidden and delivers edits to the current callback", () => {
    const firstChange = vi.fn();
    const latestChange = vi.fn();
    function Workspace({ onChange }: { onChange: (filters: GraphFilterState) => void }) {
      const [filters, setFilters] = useState(defaultFilters);
      return <Slots filters={filters} onChange={(next) => { setFilters(next); onChange(next); }} />;
    }
    const view = render(<GraphFilterVisibilityProvider><Workspace onChange={firstChange} /></GraphFilterVisibilityProvider>);
    fireEvent.click(screen.getByRole("button", { name: "Show graph filters" }));
    fireEvent.change(screen.getByLabelText("Search graph"), { target: { value: "ledger" } });
    fireEvent.click(screen.getByRole("button", { name: "Hide graph filters" }));
    fireEvent.click(screen.getByRole("button", { name: "Show graph filters" }));
    expect(screen.getByLabelText("Search graph")).toHaveValue("ledger");
    expect(firstChange).toHaveBeenCalledOnce();
    view.rerender(<GraphFilterVisibilityProvider><Workspace onChange={latestChange} /></GraphFilterVisibilityProvider>);
    fireEvent.change(screen.getByLabelText("Search graph"), { target: { value: "harbor" } });
    expect(firstChange).toHaveBeenCalledOnce();
    expect(latestChange).toHaveBeenCalledWith({ ...defaultFilters, query: "harbor" });
  });

  it("retains visibility while authoring controls are unmounted for Story/Playback, then resets on workspace close", () => {
    const view = render(<GraphFilterVisibilityProvider><Slots /></GraphFilterVisibilityProvider>);
    fireEvent.click(screen.getByRole("button", { name: "Show graph filters" }));
    view.rerender(<GraphFilterVisibilityProvider><section>Playback</section></GraphFilterVisibilityProvider>);
    expect(screen.queryByLabelText("Search graph")).not.toBeInTheDocument();
    view.rerender(<GraphFilterVisibilityProvider><Slots /></GraphFilterVisibilityProvider>);
    expect(screen.getByRole("button", { name: "Hide graph filters" })).toBeInTheDocument();
    expect(screen.getByLabelText("Search graph")).toBeInTheDocument();
    view.unmount();
    render(<GraphFilterVisibilityProvider><Slots /></GraphFilterVisibilityProvider>);
    expect(screen.getByRole("button", { name: "Show graph filters" })).toBeInTheDocument();
    expect(screen.queryByLabelText("Search graph")).not.toBeInTheDocument();
  });

  it("updates labels and panel language without resetting visibility", async () => {
    render(<GraphFilterVisibilityProvider><Slots /></GraphFilterVisibilityProvider>);
    fireEvent.click(screen.getByRole("button", { name: "Show graph filters" }));
    await act(async () => { await applyProjectLocale("ru"); });
    expect(screen.getByRole("button", { name: tr("workspace.hideGraphFilters") })).toBeInTheDocument();
    expect(screen.getByLabelText(tr("filters.searchGraph"))).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Hide graph filters" })).not.toBeInTheDocument();
    expect(screen.queryByText("Flow summary")).not.toBeInTheDocument();
  });
});
