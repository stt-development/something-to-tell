import type { ProjectSessionState } from "@something-to-tell/contracts/project-session";
import { forwardRef, useEffect, useImperativeHandle, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { tr } from "../../localization/i18n";
import { SAVED_CONFIRMATION_MS } from "../workspaceShared";

export interface SavedConfirmationHandle {
  show: () => void;
}

/** Converts transient runtime save states into stable canvas status labels. */
export function projectSaveStatusLabel(status: ProjectSessionState["save_status"] | undefined) {
  if (status === "saving") return tr("save.saving");
  if (status === "error") return tr("save.error");
  return tr("save.clean");
}

/** Owns only feedback lifetime, never save commands or session authority. */
export const SaveStatusIndicator = forwardRef<SavedConfirmationHandle, {
  session: Pick<ProjectSessionState, "save_status"> | null;
}>(function SaveStatusIndicator({ session }, ref) {
  useTranslation();
  const [confirmationVisible, setConfirmationVisible] = useState(false);
  const timeoutRef = useRef<number | null>(null);

  useImperativeHandle(ref, () => ({
    show() {
      if (timeoutRef.current !== null) window.clearTimeout(timeoutRef.current);
      setConfirmationVisible(true);
      timeoutRef.current = window.setTimeout(() => {
        setConfirmationVisible(false);
        timeoutRef.current = null;
      }, SAVED_CONFIRMATION_MS);
    }
  }), []);

  useEffect(() => () => {
    if (timeoutRef.current !== null) window.clearTimeout(timeoutRef.current);
  }, []);

  if (!session || !(session.save_status === "saving" || session.save_status === "error" || confirmationVisible)) {
    return null;
  }
  return (
    <div
      aria-label={tr("save.status")}
      className={`save-status-indicator save-status-${session.save_status}`}
      role="status"
    >
      {projectSaveStatusLabel(session.save_status)}
    </div>
  );
});
