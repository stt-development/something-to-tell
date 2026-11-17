import { forwardRef, type ComponentProps } from "react";
import { useGraphStore } from "../../state/graphStore";
import { tr } from "../../localization/i18n";
import { StorageMigrationDialog } from "../settings/ProjectSettingsDialogs";
import { DialogShell } from "../shared/DialogShell";
import type { PendingProjectAction } from "../workspaceShared";
import { SaveControl } from "./HeaderControls";
import { ProjectSaveError } from "./ProjectSaveError";
import { SaveStatusIndicator, type SavedConfirmationHandle } from "./SaveStatusIndicator";
import { RemoteRecoveryLauncher } from "../project/RemoteRecoveryContext";

/** Status consumers subscribe locally; session metadata stays with the workspace. */
function useSaveStatus() {
  return useGraphStore((state) => state.activeProjectSession?.save_status ?? null);
}

export function SessionSaveControl(props: Omit<ComponentProps<typeof SaveControl>, "session">) {
  const status = useSaveStatus();
  return <><SaveControl {...props} session={status ? { save_status: status } : null} /><RemoteRecoveryLauncher /></>;
}

export const SessionSaveIndicator = forwardRef<SavedConfirmationHandle>(function SessionSaveIndicator(_, ref) {
  const status = useSaveStatus();
  return <SaveStatusIndicator ref={ref} session={status ? { save_status: status } : null} />;
});

export function SessionStorageMigrationDialog(props: Omit<ComponentProps<typeof StorageMigrationDialog>, "isClean">) {
  const status = useSaveStatus();
  return <StorageMigrationDialog {...props} isClean={status === "clean"} />;
}

export function SessionCloseDialog({ action, onCancel, onResolve }: {
  action: PendingProjectAction;
  onCancel: () => void;
  onResolve: (decision: "save" | "discard") => void;
}) {
  const status = useSaveStatus();
  const busy = status === "saving";
  return (
    <DialogShell closeDisabled={busy} onClose={onCancel} title={tr("projects.unsavedTitle")}>
      <p className="text-sm text-slate-600">
        {tr("projects.unsavedPrompt", {
          action: action.kind === "close" ? tr("projects.closing") : tr("projects.switching")
        })}
      </p>
      <ProjectSaveError />
      <div className="mt-5 flex justify-end gap-2">
        <button className="rounded-md border border-slate-300 bg-white px-3 py-2 text-sm font-semibold"
          disabled={busy} onClick={onCancel} type="button">{tr("common.cancel")}</button>
        <button className="rounded-md border border-red-300 bg-white px-3 py-2 text-sm font-semibold text-red-700"
          disabled={status === "saving"} onClick={() => onResolve("discard")} type="button">{tr("projects.discard")}</button>
        <button autoFocus className="rounded-md bg-slate-900 px-3 py-2 text-sm font-semibold text-white"
          disabled={status === "saving"} onClick={() => onResolve("save")} type="button">{tr("common.save")}</button>
      </div>
    </DialogShell>
  );
}
