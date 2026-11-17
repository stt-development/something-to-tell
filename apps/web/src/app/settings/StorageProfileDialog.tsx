/** Shared explicit connection configuration; credentials stay in this local form. */
import { useState } from "react";
import type { TlsPolicy } from "@something-to-tell/contracts/storage";
import { localizeRuntimeError, tr } from "../../localization/i18n";
import { DialogShell, LabeledInput } from "../shared/DialogShell";
import type { StorageProfileDraft } from "../workspaceShared";

export function StorageProfileDialog({ onClose, onSubmit }: {
  onClose: () => void;
  onSubmit: (draft: StorageProfileDraft) => Promise<void> | void;
}) {
  const [draft, setDraft] = useState<StorageProfileDraft>({
    label: "", host: "127.0.0.1", port: 5432, database: "", username: "", password: "", tls_policy: "verify-full"
  });
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  async function createProfile() {
    if (busy || !draft.label.trim() || !draft.host.trim() || !draft.database.trim() || !draft.username.trim() || !draft.password) return;
    setBusy(true); setError(null);
    try {
      await onSubmit({ ...draft, label: draft.label.trim(), host: draft.host.trim(), database: draft.database.trim(), username: draft.username.trim() });
    } catch (caught) {
      setError(localizeRuntimeError(caught, "storage.storeFailed")); setBusy(false);
    }
  }
  return <DialogShell closeDisabled={busy} onClose={onClose} title={tr("storage.addTitle")}>
    <form className="space-y-3" onSubmit={event => { event.preventDefault(); void createProfile(); }}>
      <LabeledInput label={tr("storage.connectionName")} onChange={label => setDraft(value => ({ ...value, label }))} value={draft.label} />
      <div className="grid grid-cols-[1fr_7rem] gap-3">
        <LabeledInput label={tr("storage.host")} onChange={host => setDraft(value => ({ ...value, host }))} value={draft.host} />
        <label className="block text-sm font-semibold text-slate-700">{tr("storage.port")}
          <input className="mt-1 w-full rounded-md border border-slate-300 px-3 py-2 text-sm" min={1} max={65535} onChange={event => setDraft(value => ({ ...value, port: Number(event.target.value) }))} type="number" value={draft.port} />
        </label>
      </div>
      <LabeledInput label={tr("storage.database")} onChange={database => setDraft(value => ({ ...value, database }))} value={draft.database} />
      <LabeledInput label={tr("storage.username")} onChange={username => setDraft(value => ({ ...value, username }))} value={draft.username} />
      <label className="block text-sm font-semibold text-slate-700">{tr("storage.password")}
        <input autoComplete="new-password" className="mt-1 w-full rounded-md border border-slate-300 px-3 py-2 text-sm" onChange={event => setDraft(value => ({ ...value, password: event.target.value }))} type="password" value={draft.password} />
      </label>
      <label className="block text-sm font-semibold text-slate-700">{tr("storage.tlsPolicy")}
        <select className="mt-1 w-full rounded-md border border-slate-300 bg-white px-3 py-2 text-sm" onChange={event => setDraft(value => ({ ...value, tls_policy: event.target.value as TlsPolicy }))} value={draft.tls_policy}>
          <option value="verify-full">{tr("storage.tlsVerify")}</option>
          <option value="require">{tr("storage.tlsRequire")}</option>
          <option value="disable">{tr("storage.tlsDisable")}</option>
        </select>
      </label>
      <p className="text-xs text-slate-500">{tr("storage.encryptionNote")}</p>
      {error ? <p className="text-sm text-red-700" role="alert">{error}</p> : null}
      <div className="flex justify-end gap-2 border-t border-slate-200 pt-4">
        <button className="rounded-md border border-slate-300 bg-white px-4 py-2 text-sm font-semibold" disabled={busy} onClick={onClose} type="button">{tr("common.cancel")}</button>
        <button className="rounded-md bg-slate-900 px-4 py-2 text-sm font-semibold text-white disabled:opacity-50" disabled={busy || !draft.label.trim() || !draft.database.trim() || !draft.username.trim() || !draft.password} type="submit">
          {busy ? tr("storage.adding") : tr("storage.addConnection")}
        </button>
      </div>
    </form>
  </DialogShell>;
}
