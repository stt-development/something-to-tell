/** One scoped review lifecycle; runtime owns plans, credentials and all SQL mutations. */
import type { RemoteSchemaExecutionV1, RemoteSchemaPlanV1, RemoteStorageInspectionV1 } from "@something-to-tell/contracts/remote-storage";
import { REMOTE_SUPPORTED_POSTGRES_MAJORS } from "@something-to-tell/contracts/remote-storage";
import type { StorageProfileSummary } from "@something-to-tell/contracts/storage";
import { Check, ClipboardCheck, Database, LoaderCircle, Play, Plus, RefreshCw } from "lucide-react";
import { useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { formatUiDate, localizeRuntimeError, tr } from "../../localization/i18n";
import { createSchemaAdministrationClient, type RuntimeSchemaAdministration } from "../../runtime/schemaAdministrationClient";
import { createRuntimeTransport } from "../../runtime/transport";
import { DialogShell } from "../shared/DialogShell";
import type { StorageProfileDraft } from "../workspaceShared";
import { StorageProfileDialog } from "./StorageProfileDialog";

type Busy = "profiles" | "inspect" | "prepare" | "execute" | "configuration" | null;
const commandBase = "inline-flex h-9 items-center justify-center gap-2 rounded border px-3 text-sm font-semibold disabled:opacity-50";
const commandClass = `${commandBase} border-slate-300 bg-white`;

export function SchemaAdministrationDialog({ projectPath, activeSessionId = null, remoteProjectOpen = false, persistence, onClose }: {
  projectPath: string; activeSessionId?: string | null; remoteProjectOpen?: boolean;
  persistence?: RuntimeSchemaAdministration; onClose: () => void;
}) {
  const client = useMemo(() => persistence ?? createSchemaAdministrationClient(createRuntimeTransport({ projectSessionId: activeSessionId })), [persistence, activeSessionId]);
  const [profiles, setProfiles] = useState<StorageProfileSummary[]>([]);
  const [profileId, setProfileId] = useState("");
  const [inspection, setInspection] = useState<RemoteStorageInspectionV1 | null>(null);
  const [plan, setPlan] = useState<RemoteSchemaPlanV1 | null>(null);
  const [result, setResult] = useState<RemoteSchemaExecutionV1 | null>(null);
  const [writersConfirmed, setWritersConfirmed] = useState(false);
  const [backupConfirmed, setBackupConfirmed] = useState(false);
  const [busy, setBusy] = useState<Busy>("profiles");
  const [error, setError] = useState<string | null>(null);
  const [needsInspection, setNeedsInspection] = useState(false);
  const [adding, setAdding] = useState(false);
  const epoch = useRef(0), pending = useRef(false), focusNeeded = useRef(true);
  const selectRef = useRef<HTMLSelectElement>(null);

  function clearReview() {
    setInspection(null); setPlan(null); setResult(null); setError(null);
    setWritersConfirmed(false); setBackupConfirmed(false); setNeedsInspection(false);
  }

  useEffect(() => {
    const scope = ++epoch.current;
    pending.current = true; focusNeeded.current = true;
    setBusy("profiles"); setProfileId(""); setProfiles([]); setAdding(false); clearReview();
    void client.listProfiles(projectPath).then(value => {
      if (epoch.current === scope) setProfiles(value.profiles);
    }).catch(reason => {
      if (epoch.current === scope) {
        setError(localizeRuntimeError(reason));
      }
    }).finally(() => {
      if (epoch.current === scope) { pending.current = false; setBusy(null); }
    });
    return () => { ++epoch.current; };
  }, [client, projectPath]);

  useLayoutEffect(() => {
    if (!busy && !adding && focusNeeded.current) { selectRef.current?.focus(); focusNeeded.current = false; }
  }, [busy, adding]);

  async function perform<T>(stage: Exclude<Busy, null>, work: () => Promise<T>, publish: (value: T) => void) {
    if (pending.current) return;
    const scope = epoch.current;
    pending.current = true; setBusy(stage); setError(null);
    try {
      const value = await work();
      if (epoch.current === scope) publish(value);
    } catch (reason) {
      if (epoch.current === scope) {
        setError(localizeRuntimeError(reason));
        if (stage === "prepare") setInspection(null);
      }
    } finally {
      if (epoch.current === scope) { pending.current = false; setBusy(null); }
    }
  }

  const scope = { protocol_version: 1 as const, project_path: projectPath, profile_id: profileId };
  const eligible = inspection && REMOTE_SUPPORTED_POSTGRES_MAJORS.some(major => major === inspection.server_major)
    && inspection.privileges === "administrator" && ["empty", "older"].includes(inspection.schema_status);

  function inspectProfile() {
    if (!profileId || pending.current) return;
    clearReview();
    void perform("inspect", () => client.inspect(scope), setInspection);
  }

  function review() {
    if (!eligible || !inspection || pending.current) return;
    setPlan(null); setResult(null); setWritersConfirmed(false); setBackupConfirmed(false);
    void perform("prepare", () => client.prepare({ ...scope,
      action: inspection.schema_status === "empty" ? "provision" : "upgrade",
      expected_schema_revision: inspection.schema_revision }), setPlan);
  }

  function execute() {
    if (!plan || !writersConfirmed || (plan.backup_required && !backupConfirmed) || remoteProjectOpen || pending.current) return;
    const reviewed = plan;
    // A failed/lost response never leaves a one-click replay path in local state.
    setPlan(null); setInspection(null); setNeedsInspection(true);
    void perform("execute", async () => {
      const identity = { ...scope, plan_id: reviewed.plan_id, plan_fingerprint: reviewed.plan_fingerprint };
      const ack = reviewed.backup_required ? await client.attest({ ...identity, confirmation: "backup_and_restore_verified" }) : null;
      return client.execute({ ...identity, backup_attestation_id: ack?.backup_attestation_id ?? null }, reviewed);
    }, value => { setResult(value); setNeedsInspection(false); });
  }

  async function configure(draft: StorageProfileDraft) {
    if (pending.current) return;
    const token = epoch.current;
    pending.current = true; setBusy("configuration");
    try {
      const created = await client.addProfile({ ...draft, protocol_version: 1, project_path: projectPath });
      if (epoch.current === token) {
        setProfiles(current => [...current, created]); setProfileId(created.profile_id);
        clearReview(); setAdding(false); focusNeeded.current = true;
      }
    } finally {
      if (epoch.current === token) { pending.current = false; setBusy(null); }
    }
  }

  const blocking = busy === "execute" || busy === "configuration";
  const close = () => { if (!blocking) onClose(); };
  const selected = profiles.find(profile => profile.profile_id === profileId);
  return <>
    <DialogShell closeDisabled={blocking} hidden={adding} onClose={close} title={tr("storageAdmin.title")}>
      <div aria-busy={Boolean(busy)} className="space-y-4">
        <p className="break-all text-xs text-slate-500">{projectPath}</p>
        <div className="flex flex-wrap items-end gap-2">
          <label className="min-w-0 flex-1 text-sm font-semibold text-slate-700">{tr("storageAdmin.profile")}
            <select autoFocus ref={selectRef} disabled={Boolean(busy)} className="mt-1 h-9 w-full rounded border border-slate-300 bg-white px-2 text-sm text-slate-900"
              value={profileId} onChange={event => { if (!pending.current) { setProfileId(event.target.value); clearReview(); } }}>
              <option value="">{tr("storage.selectProfile")}</option>
              {profiles.map(profile => <option key={profile.profile_id} value={profile.profile_id}>{profile.label} · {profile.username}</option>)}
            </select>
          </label>
          <button className={commandClass} disabled={Boolean(busy)} onClick={() => setAdding(true)} type="button"><Plus size={15} aria-hidden="true" />{tr("storage.addConnection")}</button>
        </div>
        {!busy && profiles.length === 0 ? <p className="text-sm text-slate-500">{tr("storage.noProfiles")}</p> : null}
        {selected ? <p className="break-all text-xs text-slate-600">{selected.host}:{selected.port} / {selected.database} / {selected.username} / TLS {selected.tls_policy}</p> : null}
        <div className="flex flex-wrap gap-2">
          <button className={commandClass} disabled={!profileId || Boolean(busy)} onClick={inspectProfile} type="button"><RefreshCw size={15} aria-hidden="true" />{tr("storageAdmin.inspect")}</button>
          <button className={commandClass} disabled={!eligible || Boolean(busy)} onClick={review} type="button"><ClipboardCheck size={15} aria-hidden="true" />{tr("storageAdmin.review")}</button>
        </div>
        {busy ? <p className="flex items-center gap-2 text-sm text-teal-700" role="status"><LoaderCircle className="animate-spin" size={16} aria-hidden="true" />{tr("storageAdmin.running")}</p> : null}
        {inspection ? <div className="space-y-1 border-y border-slate-200 py-3 text-sm">
          <p><Database className="mr-2 inline-block" size={15} aria-hidden="true" />PostgreSQL {inspection.server_major} · {tr(`storageAdmin.schema.${inspection.schema_status}`)}</p>
          <p className="break-all font-mono text-xs">{inspection.schema_revision ?? tr("storageAdmin.noRevision")}</p>
          <p>{tr(`storageAdmin.privileges.${inspection.privileges}`)}</p>
          {!inspection.identity_verified ? <p className="text-amber-800">{tr("storageAdmin.tlsWarning")}</p> : null}
        </div> : null}
        {remoteProjectOpen ? <p className="text-sm text-amber-800" role="note">{tr("storageAdmin.closeRemote")}</p> : null}
        {plan ? <section aria-label={tr("storageAdmin.review")} className="space-y-3 border-t border-slate-200 pt-3">
          <h3 className="flex items-center gap-2 text-sm font-semibold"><ClipboardCheck size={16} aria-hidden="true" />{tr(plan.action === "upgrade" ? "storageAdmin.upgrade" : "storageAdmin.provision")}</h3>
          <p className="break-all font-mono text-xs">{plan.source_schema_revision ?? tr("storageAdmin.noRevision")} → {plan.target_schema_revision}</p>
          <ol className="list-inside list-decimal space-y-1 break-all text-xs">{plan.migration_revisions.map(revision => <li key={revision}>{revision}</li>)}</ol>
          <p className="text-xs text-slate-500">{tr("storageAdmin.expires", { date: formatUiDate(plan.expires_at) })}</p>
          <label className="flex items-start gap-2 text-sm"><input checked={writersConfirmed} disabled={Boolean(busy)} onChange={event => setWritersConfirmed(event.target.checked)} type="checkbox" /><span>{tr("storageAdmin.writersConsent")}</span></label>
          {plan.backup_required ? <label className="flex items-start gap-2 text-sm"><input checked={backupConfirmed} disabled={Boolean(busy)} onChange={event => setBackupConfirmed(event.target.checked)} type="checkbox" /><span>{tr("storageAdmin.backupConsent")}</span></label> : null}
          <button className={`${commandBase} border-teal-700 bg-teal-700 text-white`} disabled={Boolean(busy) || !writersConfirmed || (plan.backup_required && !backupConfirmed) || remoteProjectOpen} onClick={execute} type="button"><Play size={15} aria-hidden="true" />{tr("storageAdmin.execute")}</button>
        </section> : null}
        {result ? <p className="flex items-start gap-2 text-sm text-emerald-800" role="status"><Check size={16} aria-hidden="true" /><span>{tr("storageAdmin.completed", { revision: result.schema_revision })}</span></p> : null}
        {error ? <p className="text-sm text-red-700" role="alert">{error}</p> : null}
        {needsInspection && !busy ? <p className="text-sm text-amber-800">{tr("storageAdmin.inspectBeforeRetry")}</p> : null}
        <div className="flex justify-end border-t border-slate-200 pt-3"><button className={commandClass} disabled={blocking} onClick={close} type="button">{tr("common.close")}</button></div>
      </div>
    </DialogShell>
    {adding ? <StorageProfileDialog onClose={() => setAdding(false)} onSubmit={configure} /> : null}
  </>;
}
