import { createContext, useCallback, useContext, useLayoutEffect, useMemo, useRef, useState,
  type Dispatch, type ReactNode, type SetStateAction } from "react";
import type { Dialog } from "../workspaceShared";

const DialogContext = createContext<Dialog | undefined>(undefined);
const CommandsContext = createContext<{
  setDialog: Dispatch<SetStateAction<Dialog>>;
  readDialog: () => Dialog;
} | null>(null);

/** Owns the one dialog discriminator, not editor drafts or pending authoring commands. */
export function WorkspaceDialogProvider({ children }: { children: ReactNode }) {
  const [dialog, setDialog] = useState<Dialog>(null);
  const committedDialog = useRef(dialog);
  // Keyboard events read committed modal state without subscribing their owner.
  useLayoutEffect(() => { committedDialog.current = dialog; }, [dialog]);
  const readDialog = useCallback(() => committedDialog.current, []);
  const commands = useMemo(() => ({ setDialog, readDialog }), [readDialog]);
  return <CommandsContext.Provider value={commands}>
    <DialogContext.Provider value={dialog}>{children}</DialogContext.Provider>
  </CommandsContext.Provider>;
}

export function useWorkspaceDialog() {
  const dialog = useContext(DialogContext);
  if (dialog === undefined) throw new Error("Workspace dialog requires its provider");
  return dialog;
}

/** Stable commands for controllers/history; only presentation subscribes to the discriminator. */
export function useWorkspaceDialogCommands() {
  const commands = useContext(CommandsContext);
  if (!commands) throw new Error("Workspace dialog commands require their provider");
  return commands;
}
