import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { StrictMode } from "react";
import { afterEach, expect, it, vi } from "vitest";
import { ProjectRailLayoutProvider, useProjectRailLayout, useProjectRailVisibilityReader } from "./ProjectRailLayout";

afterEach(cleanup);

function Layout({ onRender = () => {} }: { onRender?: () => void }) {
  const { projectRailOpen, setProjectRailOpen } = useProjectRailLayout();
  onRender();
  return <button onClick={() => setProjectRailOpen((open) => !open)}>{projectRailOpen ? "Hide rail" : "Show rail"}</button>;
}

it("redraws layout while retaining the command reader and computation owner", () => {
  const compute = vi.fn();
  const layout = vi.fn();
  const read = vi.fn();
  function Workspace() {
    compute();
    const reader = useProjectRailVisibilityReader();
    return <><Layout onRender={layout} /><button onClick={() => read(reader, reader())}>Read anchor</button></>;
  }
  render(<ProjectRailLayoutProvider><Workspace /></ProjectRailLayoutProvider>);
  fireEvent.click(screen.getByText("Read anchor"));
  const reader = read.mock.calls[0]![0];
  fireEvent.click(screen.getByText("Hide rail"));
  fireEvent.click(screen.getByText("Read anchor"));
  expect(read).toHaveBeenLastCalledWith(reader, false);
  fireEvent.click(screen.getByText("Show rail"));
  fireEvent.click(screen.getByText("Read anchor"));
  expect(read).toHaveBeenLastCalledWith(reader, true);
  expect(compute).toHaveBeenCalledOnce();
  expect(layout).toHaveBeenCalledTimes(3);
});

it("retains layout across mode/Playback-like replacement, resetting on workspace unmount", () => {
  const view = render(<ProjectRailLayoutProvider><Layout /></ProjectRailLayoutProvider>);
  fireEvent.click(screen.getByText("Hide rail"));
  view.rerender(<ProjectRailLayoutProvider><section>Playback</section></ProjectRailLayoutProvider>);
  view.rerender(<ProjectRailLayoutProvider><Layout /></ProjectRailLayoutProvider>);
  expect(screen.getByText("Show rail")).toBeInTheDocument();
  view.unmount();
  render(<ProjectRailLayoutProvider><Layout /></ProjectRailLayoutProvider>);
  expect(screen.getByText("Hide rail")).toBeInTheDocument();
});

it("publishes current committed visibility with StrictMode effect replay", () => {
  const read = vi.fn();
  function Command() {
    const reader = useProjectRailVisibilityReader();
    return <button onClick={() => read(reader())}>Read</button>;
  }
  render(<StrictMode><ProjectRailLayoutProvider><Layout /><Command /></ProjectRailLayoutProvider></StrictMode>);
  fireEvent.click(screen.getByText("Hide rail"));
  fireEvent.click(screen.getByText("Read"));
  expect(read).toHaveBeenLastCalledWith(false);
  fireEvent.click(screen.getByText("Show rail"));
  fireEvent.click(screen.getByText("Read"));
  expect(read).toHaveBeenLastCalledWith(true);
});
