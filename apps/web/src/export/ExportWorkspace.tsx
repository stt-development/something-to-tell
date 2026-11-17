/** Transient export intent; the runtime alone projects, validates, and writes. */
import { useEffect, useRef, useState, type ComponentType } from "react";
import { Download, FolderOpen, LoaderCircle, RefreshCw, X } from "lucide-react";
import { useTranslation } from "react-i18next";
import type { ExportArtifactV1, ExportFormatV1, ExportOptionsV1, ExportPlanV1 } from "@something-to-tell/contracts/export";
import { EXPORT_MAX_SELECTED_FLOWS } from "@something-to-tell/contracts/export";
import type { EngineTagProjectionTargetV1 } from "@something-to-tell/contracts/engine-tags";
import { ENGINE_TAG_AUTHORING_TARGETS_V1 } from "@something-to-tell/contracts/engine-tags";
import { localizeRuntimeText, tr } from "../localization/i18n";
import type { RuntimeExportPersistence } from "../runtime/apiTypes";
import { hasDesktopDirectoryPicker, openExportDirectory, pickExportDirectory } from "../runtime/desktopBridge";
import { ExportReview } from "./ExportReview";

interface ExportWorkspaceProps {
  persistence: RuntimeExportPersistence;
  projectName: string;
  projectPath: string;
  sessionId: string;
  sourceRevision: number;
  flows: Array<{ id: string; name: string; description: string }>;
  // The shell supplies its existing browser picker without reversing dependencies.
  DirectoryPicker: ComponentType<{ initialDirectory: string; onClose: () => void; onSelect: (path: string) => void; title: string }>;
  onClose: () => void;
}

function exportError(error: unknown): string {
  const code = error && typeof error === "object" && "code" in error ? String(error.code) : "";
  return localizeRuntimeText(`export.error.${code}`, {}, tr("errors.runtimeRequestFailed"));
}

export function ExportWorkspace({ persistence, projectName, projectPath, sessionId, sourceRevision, flows, DirectoryPicker, onClose }: ExportWorkspaceProps) {
  useTranslation();
  const [format, setFormat] = useState<ExportFormatV1>("json");
  const [scope, setScope] = useState<ExportOptionsV1["scope"]>("whole_project");
  const [target, setTarget] = useState<EngineTagProjectionTargetV1>("generic");
  const [selectedIds, setSelectedIds] = useState<string[]>([]);
  const [query, setQuery] = useState("");
  const [destination, setDestination] = useState<string | null>(null);
  const [directoryPicker, setDirectoryPicker] = useState(false);
  const [overwrite, setOverwrite] = useState(false);
  const [busy, setBusy] = useState<"planning" | "writing" | "choosing" | null>(null);
  const [plan, setPlan] = useState<ExportPlanV1 | null>(null);
  const [artifact, setArtifact] = useState<ExportArtifactV1 | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [stale, setStale] = useState(false);
  const requestRef = useRef(0);
  const dialogRef = useRef<HTMLElement>(null);
  const revisionRef = useRef(sourceRevision);
  const planRevisionRef = useRef(sourceRevision);
  const launcherRef = useRef(document.activeElement instanceof HTMLElement ? document.activeElement : null);
  revisionRef.current = sourceRevision;
  const locked = busy !== null;
  const executable = format === "ink" || format === "yarn_spinner";
  const effectiveTarget = executable ? format : target;
  const availableIds = new Set(flows.map((flow) => flow.id));
  const missingFlow = selectedIds.some((id) => !availableIds.has(id));
  const outdated = stale || Boolean(plan && planRevisionRef.current !== sourceRevision);
  const options: ExportOptionsV1 = {
    options_version: 1, format, scope, engine_tag_target: effectiveTarget,
    story_flow_ids: scope === "story_flows" ? [...selectedIds].sort() : [], preview_max_bytes: 65_536
  };
  const optionsKey = JSON.stringify(options);

  useEffect(() => {
    dialogRef.current?.querySelector<HTMLSelectElement>("select")?.focus();
    return () => { requestRef.current += 1; launcherRef.current?.focus(); };
  }, []);
  useEffect(() => {
    setPlan(null); setArtifact(null); setStale(false); setError(null);
  }, [optionsKey]);

  async function refresh() {
    if (locked || missingFlow || (scope === "story_flows" && !selectedIds.length)) return;
    const request = ++requestRef.current;
    const revision = sourceRevision;
    setBusy("planning"); setError(null); setArtifact(null); setPlan(null);
    try {
      const result = await persistence.createExportPlan(sessionId, { request_version: 1, options });
      if (request !== requestRef.current) return;
      planRevisionRef.current = revision;
      setPlan(result); setStale(revision !== revisionRef.current);
    } catch (caught) {
      if (request === requestRef.current) setError(exportError(caught));
    } finally { if (request === requestRef.current) setBusy(null); }
  }

  async function write() {
    if (!plan?.can_write || outdated || locked || artifact || missingFlow) return;
    setBusy("writing"); setError(null);
    try {
      const result = await persistence.writeExportArtifact(sessionId, {
        request_version: 1, options: plan.options,
        expected_source_checksum: plan.source.source_checksum,
        expected_plan_fingerprint: plan.plan_fingerprint, destination_directory: destination, overwrite
      });
      setArtifact(result.artifact);
    } catch (caught) {
      setError(exportError(caught));
      if (caught && typeof caught === "object" && "code" in caught &&
          ["export_source_stale", "export_plan_stale"].includes(String(caught.code))) setStale(true);
    } finally { setBusy(null); }
  }

  async function chooseDirectory() {
    if (!hasDesktopDirectoryPicker()) { setDirectoryPicker(true); return; }
    setBusy("choosing"); setError(null);
    try {
      const directory = await pickExportDirectory(destination ?? projectPath);
      if (directory !== null) { setDestination(directory); setOverwrite(false); }
    } catch (caught) { setError(exportError(caught)); }
    finally { setBusy(null); }
  }

  function close() {
    // Once installation starts, a dismissed UI cannot promise rollback or cancel.
    if (busy === "writing" || busy === "choosing") return;
    requestRef.current += 1;
    onClose();
  }

  return <div className="export-overlay" onKeyDown={(event) => {
    if (directoryPicker) return;
    if (event.key === "Escape") { event.preventDefault(); event.stopPropagation(); close(); }
    if (event.key === "Tab") {
      const items = [...dialogRef.current!.querySelectorAll<HTMLElement>(
        'button:not(:disabled), input:not(:disabled), select:not(:disabled), textarea:not(:disabled), summary, [tabindex="0"]'
      )].filter((element) => !element.hidden);
      const first = items[0], last = items.at(-1);
      if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last?.focus(); }
      else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first?.focus(); }
    }
  }}>
    <section aria-labelledby="export-title" aria-modal="true" className="export-workspace" ref={dialogRef} role="dialog">
      <header className="export-header"><div><h2 id="export-title">{tr("export.workspace")}</h2><p>{projectName}</p></div>
        <button aria-label={tr("common.closeDialog")} className="icon-button" data-tooltip={tr("common.closeDialog")}
          disabled={busy === "writing" || busy === "choosing"} onClick={close} type="button"><X size={18} /></button>
      </header>
      <div className="export-body">
        <aside className="export-options" aria-label={tr("export.options")}>
          <label>{tr("export.format")}<select disabled={locked} onChange={(event) => setFormat(event.target.value as ExportFormatV1)} value={format}>
            <option value="json">JSON</option><option value="yaml">YAML</option><option value="yarn_spinner">Yarn Spinner</option><option value="ink">Ink</option>
          </select></label>
          <label>{tr("export.scope")}<select disabled={locked} onChange={(event) => setScope(event.target.value as typeof scope)} value={scope}>
            <option value="whole_project">{tr("export.scope.whole_project")}</option><option value="story_flows">{tr("export.scope.story_flows")}</option>
          </select></label>
          <label>{tr("export.target")}<select disabled={locked || executable} onChange={(event) => setTarget(event.target.value as typeof target)} value={effectiveTarget}>
            {["generic", ...ENGINE_TAG_AUTHORING_TARGETS_V1].map((value) => <option key={value} value={value}>{tr(`engineTags.target.${value}` as "engineTags.target.generic")}</option>)}
          </select></label>
          {scope === "story_flows" ? <fieldset disabled={locked} className="export-flow-picker"><legend>{tr("export.flows", { count: selectedIds.length })}</legend>
            <input aria-label={tr("export.searchFlows")} onChange={(event) => setQuery(event.target.value)} value={query} type="search" />
            <div className="export-flow-list">{flows.filter((flow) => `${flow.name} ${flow.description}`.toLocaleLowerCase().includes(query.toLocaleLowerCase())).map((flow) =>
              <label key={flow.id}><input type="checkbox" checked={selectedIds.includes(flow.id)}
                disabled={!selectedIds.includes(flow.id) && selectedIds.length >= EXPORT_MAX_SELECTED_FLOWS}
                onChange={(event) => setSelectedIds((current) => event.target.checked ? [...current, flow.id] : current.filter((id) => id !== flow.id))} />
                <span>{flow.name}</span></label>)}{!flows.length ? <p>{tr("export.noFlows")}</p> : null}</div>
          </fieldset> : null}
          <button className="export-command" data-tooltip={tr("export.refresh")} disabled={locked || missingFlow || (scope === "story_flows" && !selectedIds.length)} onClick={() => void refresh()} type="button">
            <RefreshCw size={16} />{tr("export.refresh")}</button>
          {plan ? <ExportReview plan={plan} /> : null}
        </aside>
        <section aria-label={tr("export.preview")} className="export-preview">
          <div className="export-section-heading"><h3>{tr("export.preview")}</h3>{plan ? <span>{plan.suggested_filename} · {plan.preview.total_bytes.toLocaleString()} B</span> : null}</div>
          {outdated || missingFlow ? <p className="export-notice" role="status">{tr("export.stale")}</p> : null}
          {error ? <p className="export-error" role="alert">{error}</p> : null}
          {busy ? <p className="export-progress" role="status"><LoaderCircle className="animate-spin" size={16} />{tr(`export.busy.${busy}`)}</p> : null}
          {plan?.preview.truncated ? <p className="export-notice">{tr("export.truncated", { bytes: plan.preview.preview_bytes })}</p> : null}
          {plan ? <pre tabIndex={0} aria-label={tr("export.source")}>{plan.preview.text || tr("export.blocked")}</pre> : !busy ? <p>{tr("export.noPreview")}</p> : null}
        </section>
      </div>
      <footer className="export-footer">
        <div className="export-destination"><span>{tr("export.destination")}</span><code>{destination ?? `${projectPath}/exports`}</code>
          <button aria-label={tr("export.chooseDirectory")} className="icon-button" data-tooltip={tr("export.chooseDirectory")} disabled={locked} onClick={() => void chooseDirectory()} type="button"><FolderOpen size={17} /></button>
          {destination ? <button aria-label={tr("export.defaultDirectory")} className="icon-button" data-tooltip={tr("export.defaultDirectory")} disabled={locked} onClick={() => { setDestination(null); setOverwrite(false); }} type="button"><X size={16} /></button> : null}
        </div>
        <div className="export-footer-actions"><label className="export-overwrite" data-tooltip={tr("export.overwrite")}><input type="checkbox" checked={overwrite} disabled={locked} onChange={(event) => setOverwrite(event.target.checked)} />{tr("export.overwrite")}</label>
          <button className="export-command" data-tooltip={tr("common.cancel")} disabled={busy === "writing" || busy === "choosing"} onClick={close} type="button"><X size={16} />{tr("common.cancel")}</button>
          <button className="export-command export-primary" data-tooltip={tr("export.write")} disabled={locked || !plan?.can_write || outdated || Boolean(artifact) || missingFlow} onClick={() => void write()} type="button"><Download size={16} />{tr("export.write")}</button>
        </div>
        {artifact ? <div className="export-completion" role="status"><span>{tr("export.completed", { filename: artifact.filename, bytes: artifact.bytes_written })}</span>
          <button className="export-command" disabled={!hasDesktopDirectoryPicker()} data-tooltip={tr("export.openFolder")} onClick={() => {
            const index = Math.max(artifact.installed_path.lastIndexOf("/"), artifact.installed_path.lastIndexOf("\\"));
            void openExportDirectory(artifact.installed_path.slice(0, index)).catch(() => setError(tr("export.openFailed")));
          }} type="button"><FolderOpen size={16} />{tr("export.openFolder")}</button></div> : null}
      </footer>
    </section>
    {directoryPicker ? <DirectoryPicker initialDirectory={destination ?? projectPath} onClose={() => setDirectoryPicker(false)} title={tr("export.chooseDirectory")}
      onSelect={(path) => { setDestination(path); setOverwrite(false); setDirectoryPicker(false); }} /> : null}
  </div>;
}
