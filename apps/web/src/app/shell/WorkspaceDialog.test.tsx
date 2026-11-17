import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { StrictMode } from "react";
import { afterEach, expect, it, vi } from "vitest";
import { WorkspaceDialogProvider, useWorkspaceDialog, useWorkspaceDialogCommands } from "./WorkspaceDialog";

afterEach(cleanup);

function DialogView() {
  const dialog = useWorkspaceDialog();
  return <output data-testid="dialog">{dialog ?? "none"}</output>;
}

function Controls({ onHistory = () => {} }: { onHistory?: () => void }) {
  const { setDialog, readDialog } = useWorkspaceDialogCommands();
  return <>
    <button onClick={() => setDialog("edit-node")}>Open</button>
    <button onClick={() => setDialog("edit-quest")}>Replace</button>
    <button onClick={() => setDialog(null)}>Close</button>
    <button onClick={() => { if (!readDialog()) onHistory(); }}>History</button>
  </>;
}

it("updates the single dialog and current history guard without rerendering command-only owners", () => {
  const compute = vi.fn();
  const history = vi.fn();
  const commandValues: ReturnType<typeof useWorkspaceDialogCommands>[] = [];
  function Workspace() {
    compute();
    commandValues.push(useWorkspaceDialogCommands());
    return <><Controls onHistory={history} /><DialogView /></>;
  }
  render(<WorkspaceDialogProvider><Workspace /></WorkspaceDialogProvider>);
  expect(screen.getByTestId("dialog")).toHaveTextContent("none");
  fireEvent.click(screen.getByText("History"));
  fireEvent.click(screen.getByText("Open"));
  expect(screen.getByTestId("dialog")).toHaveTextContent("edit-node");
  expect(commandValues[0]!.readDialog()).toBe("edit-node");
  fireEvent.click(screen.getByText("History"));
  fireEvent.click(screen.getByText("Replace"));
  expect(screen.getByTestId("dialog")).toHaveTextContent("edit-quest");
  expect(commandValues[0]!.readDialog()).toBe("edit-quest");
  fireEvent.click(screen.getByText("History"));
  expect(history).toHaveBeenCalledOnce();
  fireEvent.click(screen.getByText("Close"));
  fireEvent.click(screen.getByText("History"));
  expect(history).toHaveBeenCalledTimes(2);
  expect(compute).toHaveBeenCalledOnce();
  expect(commandValues).toHaveLength(1);
  expect(commandValues[0]!.readDialog()).toBeNull();
});

it("keeps queued functional replacements ordered without a second modal stack", () => {
  function Commands() {
    const { setDialog } = useWorkspaceDialogCommands();
    return <button onClick={() => {
      setDialog("edit-node");
      setDialog((current) => current === "edit-node" ? "edit-edge" : "edit-quest");
    }}>Batch</button>;
  }
  render(<WorkspaceDialogProvider><Commands /><DialogView /></WorkspaceDialogProvider>);
  fireEvent.click(screen.getByText("Batch"));
  expect(screen.getByTestId("dialog")).toHaveTextContent("edit-edge");
});

it("retains the discriminator across mode/Playback replacement and resets on workspace unmount", () => {
  const view = render(<WorkspaceDialogProvider><Controls /><DialogView /></WorkspaceDialogProvider>);
  fireEvent.click(screen.getByText("Open"));
  view.rerender(<WorkspaceDialogProvider><section>Playback</section></WorkspaceDialogProvider>);
  view.rerender(<WorkspaceDialogProvider><Controls /><DialogView /></WorkspaceDialogProvider>);
  expect(screen.getByTestId("dialog")).toHaveTextContent("edit-node");
  view.unmount();
  render(<WorkspaceDialogProvider><DialogView /></WorkspaceDialogProvider>);
  expect(screen.getByTestId("dialog")).toHaveTextContent("none");
});

it("keeps current caller callbacks and stable commands when its parent refreshes", () => {
  const oldHistory = vi.fn();
  const nextHistory = vi.fn();
  const commands: ReturnType<typeof useWorkspaceDialogCommands>[] = [];
  function Caller({ onHistory }: { onHistory: () => void }) {
    commands.push(useWorkspaceDialogCommands());
    return <Controls onHistory={onHistory} />;
  }
  const view = render(<WorkspaceDialogProvider><Caller onHistory={oldHistory} /></WorkspaceDialogProvider>);
  view.rerender(<WorkspaceDialogProvider><Caller onHistory={nextHistory} /></WorkspaceDialogProvider>);
  expect(commands[1]).toBe(commands[0]);
  fireEvent.click(screen.getByText("Open"));
  fireEvent.click(screen.getByText("History"));
  expect(nextHistory).not.toHaveBeenCalled();
  fireEvent.click(screen.getByText("Close"));
  fireEvent.click(screen.getByText("History"));
  expect(nextHistory).toHaveBeenCalledOnce();
  expect(oldHistory).not.toHaveBeenCalled();
});

it("reads committed open/closed state under StrictMode effect replay", () => {
  const history = vi.fn();
  render(<StrictMode><WorkspaceDialogProvider><Controls onHistory={history} /><DialogView /></WorkspaceDialogProvider></StrictMode>);
  fireEvent.click(screen.getByText("Open"));
  fireEvent.click(screen.getByText("History"));
  expect(history).not.toHaveBeenCalled();
  fireEvent.click(screen.getByText("Close"));
  fireEvent.click(screen.getByText("History"));
  expect(history).toHaveBeenCalledOnce();
});
