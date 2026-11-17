import {
createDefaultProjectSettings
} from "@something-to-tell/contracts/project-manifest";
import type {
ProjectCatalogEntry,
ProjectDirectoryEntry,
ProjectDirectoryListingResponse,
ProjectSessionSaveAsResponse
} from "@something-to-tell/contracts/project-session";
import {
ArrowUp,
ChevronDown,
ChevronRight,
Copy,
Folder,
FolderOpen,
Home,
RotateCcw,
Sparkles
} from "lucide-react";
import { useEffect,useMemo,useState,type ReactNode } from "react";
import {
localizeRuntimeError,
readBootLocale,
tr
} from "../../localization/i18n";
import { createRuntimeApiClient } from "../../runtime/apiClient";
import { hasDesktopDirectoryPicker,pickProjectDirectory } from "../../runtime/desktopBridge";
import {
type ProjectDraft
} from "../../types";

import { ProjectSettingsFields,StorageProfileDialog } from "../settings/ProjectSettingsDialogs";
import { emptyStyleProfileDraft, StyleProfileFields, type StyleProfileDraft } from "../settings/StyleProfileManager";
import { DialogShell,LabeledInput } from "../shared/DialogShell";
import { ProjectOpenCards } from "./ProjectOpenCards";
import { SchemaAdministrationDialog } from "../settings/SchemaAdministrationDialog";
import { DEFAULT_WORKSPACE,ProjectCreationRequest,StorageProfileDraft,projectFolder,projectParentDirectory } from "../workspaceShared";

export function DirectoryPickerDialog({
  initialDirectory,
  onClose,
  onSelect,
  title
}: {
  initialDirectory: string;
  onClose: () => void;
  onSelect: (path: string) => void;
  title: string;
}) {
  const client = useMemo(() => createRuntimeApiClient(), []);
  const [root, setRoot] = useState<ProjectDirectoryListingResponse | null>(null);
  const [listings, setListings] = useState<Record<string, ProjectDirectoryListingResponse>>({});
  const [expanded, setExpanded] = useState<Set<string>>(new Set());
  const [selected, setSelected] = useState(initialDirectory);
  const [loadingPath, setLoadingPath] = useState<string | null>(initialDirectory);
  const [error, setError] = useState<string | null>(null);

  async function loadRoot(path?: string) {
    setLoadingPath(path ?? "~");
    setError(null);
    try {
      const listing = await client.listProjectDirectories(path);
      setRoot(listing);
      setListings({ [listing.directory]: listing });
      setExpanded(new Set([listing.directory]));
      setSelected(listing.directory);
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "Directory could not be loaded");
    } finally {
      setLoadingPath(null);
    }
  }

  useEffect(() => {
    void loadRoot(initialDirectory);
  }, [initialDirectory]);

  async function toggle(entry: ProjectDirectoryEntry) {
    if (expanded.has(entry.path)) {
      setExpanded((current) => {
        const next = new Set(current);
        next.delete(entry.path);
        return next;
      });
      return;
    }
    if (!listings[entry.path]) {
      setLoadingPath(entry.path);
      setError(null);
      try {
        const listing = await client.listProjectDirectories(entry.path);
        setListings((current) => ({ ...current, [entry.path]: listing }));
      } catch (caught) {
        setError(caught instanceof Error ? caught.message : "Directory could not be loaded");
        setLoadingPath(null);
        return;
      }
      setLoadingPath(null);
    }
    setExpanded((current) => new Set([...current, entry.path]));
  }

  function renderEntry(entry: ProjectDirectoryEntry, depth: number): ReactNode {
    const isExpanded = expanded.has(entry.path);
    const children = listings[entry.path]?.directories ?? [];
    const isLoading = loadingPath === entry.path;
    return (
      <div key={entry.path} role="treeitem" aria-expanded={isExpanded} aria-selected={selected === entry.path}>
        <div
          className={`flex h-9 items-center rounded-sm ${selected === entry.path ? "bg-sky-50 text-sky-900" : "hover:bg-slate-50"}`}
          style={{ paddingLeft: `${depth * 18 + 4}px` }}
        >
          <button
            aria-label={`${isExpanded ? "Collapse" : "Expand"} ${entry.name}`}
            className="flex h-7 w-7 items-center justify-center text-slate-500"
            disabled={isLoading}
            onClick={() => void toggle(entry)}
            type="button"
          >
            {isLoading ? <RotateCcw className="animate-spin" size={15} aria-hidden="true" /> : isExpanded ? <ChevronDown size={15} aria-hidden="true" /> : <ChevronRight size={15} aria-hidden="true" />}
          </button>
          <button
            className="flex min-w-0 flex-1 items-center gap-2 py-1 pr-2 text-left text-sm"
            onClick={() => setSelected(entry.path)}
            onDoubleClick={() => void loadRoot(entry.path)}
            title={entry.path}
            type="button"
          >
            <Folder className="shrink-0 text-sky-700" size={16} aria-hidden="true" />
            <span className="truncate">{entry.name}</span>
          </button>
        </div>
        {isExpanded ? children.map((child) => renderEntry(child, depth + 1)) : null}
      </div>
    );
  }

  return (
    <DialogShell onClose={onClose} title={title}>
      <div className="flex items-center gap-2 border-b border-slate-200 pb-3">
        <button className="icon-button" disabled={!root?.parent || loadingPath !== null} onClick={() => void loadRoot(root?.parent ?? undefined)} title={tr("projects.parentDirectory")} type="button">
          <ArrowUp size={18} aria-hidden="true" />
        </button>
        <button className="icon-button" disabled={loadingPath !== null} onClick={() => void loadRoot()} title={tr("projects.homeDirectory")} type="button">
          <Home size={18} aria-hidden="true" />
        </button>
        <div className="min-w-0 flex-1 truncate rounded-md border border-slate-200 bg-slate-50 px-3 py-2 text-sm" title={selected}>
          {selected}
        </div>
      </div>
      {error ? <p className="mt-3 text-sm text-red-700" role="alert">{error}</p> : null}
      <div aria-label={tr("projects.directoryTree")} className="mt-3 h-80 overflow-auto rounded-md border border-slate-200 p-1" role="tree">
        {root ? (
          <div role="treeitem" aria-expanded="true" aria-selected={selected === root.directory}>
            <button
              className={`flex h-9 w-full items-center gap-2 rounded-sm px-3 text-left text-sm font-semibold ${selected === root.directory ? "bg-sky-50 text-sky-900" : "hover:bg-slate-50"}`}
              onClick={() => setSelected(root.directory)}
              type="button"
            >
              <FolderOpen className="shrink-0 text-sky-700" size={17} aria-hidden="true" />
              <span className="truncate">{root.directory}</span>
            </button>
            {root.directories.map((entry) => renderEntry(entry, 1))}
          </div>
        ) : (
          <p className="py-12 text-center text-sm text-slate-500">{tr("projects.loadingDirectories")}</p>
        )}
      </div>
      <div className="mt-4 flex justify-end gap-2">
        <button className="rounded-md border border-slate-300 bg-white px-4 py-2 text-sm font-semibold" onClick={onClose} type="button">{tr("common.cancel")}</button>
        <button className="rounded-md bg-slate-900 px-4 py-2 text-sm font-semibold text-white disabled:opacity-50" disabled={!root || loadingPath !== null} onClick={() => onSelect(selected)} type="button">
          {tr("projects.selectFolder")}
        </button>
      </div>
    </DialogShell>
  );
}

export function OpenProjectDialog({
  onClose,
  onOpen
}: {
  onClose: () => void;
  onOpen: (path: string) => Promise<void>;
}) {
  const client = useMemo(() => createRuntimeApiClient(), []);
  const [directory, setDirectory] = useState(DEFAULT_WORKSPACE);
  const [projects, setProjects] = useState<ProjectCatalogEntry[]>([]);
  const [loading, setLoading] = useState(true);
  const [pickerOpen, setPickerOpen] = useState(false);
  const [schemaPath, setSchemaPath] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  async function load(directoryPath?: string) {
    setLoading(true);
    setError(null);
    try {
      const catalog = await client.listProjectCatalog(directoryPath);
      setDirectory(catalog.directory);
      setProjects(catalog.projects);
    } catch (caught) {
      setProjects([]);
      setError(caught instanceof Error ? caught.message : tr("projects.directoryFailed"));
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    void load();
  }, []);

  async function chooseDirectory() {
    if (!hasDesktopDirectoryPicker()) {
      setPickerOpen(true);
      return;
    }
    const selected = await pickProjectDirectory(directory);
    if (selected) await load(selected);
  }

  return (
    <>
      <DialogShell hidden={schemaPath !== null} onClose={onClose} title={tr("projects.open")}>
        <div className="space-y-4">
        <label className="block text-sm font-semibold text-slate-700">
          {tr("projects.projectsDirectory")}
          <div className="mt-1 flex gap-2">
            <input
              className="min-w-0 flex-1 rounded-md border border-slate-300 px-3 py-2 text-sm"
              onChange={(event) => setDirectory(event.target.value)}
              value={directory}
            />
            <button className="icon-button" onClick={() => void chooseDirectory()} title={tr("projects.chooseProjectsDirectory")} type="button">
              <FolderOpen size={18} aria-hidden="true" />
            </button>
            <button
              aria-label={tr("projects.refreshList")}
              className="icon-button"
              disabled={loading || !directory.trim()}
              onClick={() => void load(directory)}
              title={tr("projects.loadFromDirectory")}
              type="button"
            >
              <RotateCcw size={18} aria-hidden="true" />
            </button>
          </div>
        </label>
        {error ? <p className="text-sm text-red-700" role="alert">{error}</p> : null}
        <div aria-label={tr("projects.available")} className="max-h-80 space-y-2 overflow-y-auto">
          {loading ? <p className="py-6 text-center text-sm text-slate-500">{tr("projects.loading")}</p> : null}
          {!loading && projects.length === 0 ? (
            <p className="rounded-md border border-dashed border-slate-300 px-4 py-6 text-center text-sm text-slate-500">
              {tr("projects.noneFound")}
            </p>
          ) : null}
        <ProjectOpenCards disabled={loading} onAdminister={setSchemaPath} onError={setError} onOpen={onOpen} projects={projects} />
        </div>
        </div>
      </DialogShell>
      {schemaPath ? <SchemaAdministrationDialog onClose={() => setSchemaPath(null)} projectPath={schemaPath} /> : null}
      {pickerOpen ? (
        <DirectoryPickerDialog
          initialDirectory={directory}
          onClose={() => setPickerOpen(false)}
          onSelect={(path) => {
            setPickerOpen(false);
            void load(path);
          }}
          title={tr("projects.chooseProjectsDirectory")}
        />
      ) : null}
    </>
  );
}

export function CreateProjectDialog({ onClose, onCreate }: { onClose: () => void; onCreate: (request: ProjectCreationRequest) => Promise<void> }) {
  const client = useMemo(() => createRuntimeApiClient(), []);
  const [draft, setDraft] = useState<ProjectDraft>({
    description: "",
    name: "",
    path: DEFAULT_WORKSPACE,
    settings: { ...createDefaultProjectSettings(), ui_locale: readBootLocale() }
  });
  const [storageProfile, setStorageProfile] = useState<StorageProfileDraft | null>(null);
  const [initialStyle, setInitialStyle] = useState<StyleProfileDraft | null>(null);
  const [busy, setBusy] = useState(false);
  const [pickerOpen, setPickerOpen] = useState(false);
  const [storageDialogOpen, setStorageDialogOpen] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    void client.listProjectCatalog().then((catalog) => {
      setDraft((current) => ({ ...current, path: catalog.directory }));
    }).catch((caught) => {
      setError(caught instanceof Error ? caught.message : tr("projects.defaultDirectoryFailed"));
    });
  }, [client]);

  async function chooseDirectory() {
    if (!hasDesktopDirectoryPicker()) {
      setPickerOpen(true);
      return;
    }
    const selected = await pickProjectDirectory(draft.path ?? DEFAULT_WORKSPACE);
    if (selected) setDraft((current) => ({ ...current, path: selected }));
  }

  return (
    <>
      <DialogShell onClose={onClose} title={tr("projects.create")}>
        <form
        className="space-y-3"
        onSubmit={(event) => {
          event.preventDefault();
          if (!draft.name.trim() || busy) return;
          setBusy(true);
          setError(null);
          void onCreate({
            draft: {
              description: draft.description.trim(),
              name: draft.name.trim(),
              path: draft.path || DEFAULT_WORKSPACE,
              settings: draft.settings
            },
            storageProfile,
            initialStyle
          }).catch((caught) => {
            setError(caught instanceof Error ? caught.message : tr("projects.creationFailed"));
          }).finally(() => setBusy(false));
        }}
      >
        <LabeledInput label={tr("common.name")} onChange={(value) => setDraft((current) => ({ ...current, name: value }))} value={draft.name} />
        <label className="block text-sm font-semibold text-slate-700">
          {tr("projects.parentDirectory")}
          <div className="mt-1 flex gap-2">
            <input
              className="min-w-0 flex-1 rounded-md border border-slate-300 px-3 py-2 text-sm"
              onChange={(event) => setDraft((current) => ({ ...current, path: event.target.value }))}
              value={draft.path ?? DEFAULT_WORKSPACE}
            />
            <button className="icon-button" onClick={() => void chooseDirectory()} title={tr("projects.chooseParentDirectory")} type="button">
              <FolderOpen size={18} aria-hidden="true" />
            </button>
          </div>
        </label>
        <ProjectSettingsFields
          agentPersistence={client}
          onChange={(settings) => setDraft((current) => ({ ...current, settings }))}
          onConfigureStorage={() => setStorageDialogOpen(true)}
          onUseLocalStorage={() => setStorageProfile(null)}
          settings={draft.settings}
          storageDraftLabel={storageProfile?.label ?? null}
        />
        <fieldset className="space-y-3 border-t border-slate-200 pt-3">
          <legend className="pr-2 text-sm font-semibold text-slate-700">{tr("style.initialStyle")}</legend>
          <label className="flex items-center gap-2 text-sm font-semibold text-slate-700">
            <input checked={initialStyle !== null} onChange={(event) => setInitialStyle(event.target.checked ? emptyStyleProfileDraft() : null)} type="checkbox" />
            {tr("style.createInitialProfile")}
          </label>
          {initialStyle ? <StyleProfileFields contentLocale={draft.settings.content_locale} draft={initialStyle} onChange={setInitialStyle} /> : (
            <p className="text-xs text-slate-500">{tr("style.configureLater")}</p>
          )}
        </fieldset>
        <label className="block text-sm font-semibold text-slate-700">
          {tr("common.description")}
          <textarea className="mt-1 min-h-14 w-full rounded-md border border-slate-300 px-3 py-2 text-sm" onChange={(event) => setDraft((current) => ({ ...current, description: event.target.value }))} value={draft.description} />
        </label>
        <p className="text-xs text-slate-500">{tr("projects.folder", { path: projectFolder(draft.path || DEFAULT_WORKSPACE, draft.name) })}</p>
        {error ? <p className="text-sm text-red-700" role="alert">{error}</p> : null}
        <button className="inline-flex items-center gap-2 rounded-md bg-slate-900 px-4 py-2 text-sm font-semibold text-white disabled:opacity-50" disabled={busy || !draft.name.trim()} type="submit">
          <Sparkles size={16} aria-hidden="true" />
          {busy ? tr("common.creating") : tr("common.create")}
        </button>
        </form>
      </DialogShell>
      {pickerOpen ? (
        <DirectoryPickerDialog
          initialDirectory={draft.path ?? DEFAULT_WORKSPACE}
          onClose={() => setPickerOpen(false)}
          onSelect={(path) => {
            setDraft((current) => ({ ...current, path }));
            setPickerOpen(false);
          }}
          title={tr("projects.chooseParentDirectory")}
        />
      ) : null}
      {storageDialogOpen ? (
        <StorageProfileDialog
          onClose={() => setStorageDialogOpen(false)}
          onSubmit={(profile) => {
            setStorageProfile(profile);
            setStorageDialogOpen(false);
          }}
        />
      ) : null}
    </>
  );
}

export function SaveAsDialog({
  onClose,
  onOpenCopy,
  onSave,
  projectName,
  projectPath
}: {
  onClose: () => void;
  onOpenCopy: (path: string) => Promise<void>;
  onSave: (command: {
    identity: "preserve" | "regenerate";
    path: string;
    replace_existing: boolean;
  }) => Promise<ProjectSessionSaveAsResponse>;
  projectName: string;
  projectPath: string;
}) {
  const [directory, setDirectory] = useState(projectParentDirectory(projectPath));
  const [folderName, setFolderName] = useState(`${projectName} Copy`);
  const [identity, setIdentity] = useState<"preserve" | "regenerate">("regenerate");
  const [replaceExisting, setReplaceExisting] = useState(false);
  const [pickerOpen, setPickerOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [result, setResult] = useState<ProjectSessionSaveAsResponse | null>(null);
  const destination = projectFolder(directory, folderName);

  async function chooseDirectory() {
    if (!hasDesktopDirectoryPicker()) {
      setPickerOpen(true);
      return;
    }
    const selected = await pickProjectDirectory(directory);
    if (selected) setDirectory(selected);
  }

  return (
    <>
      <DialogShell onClose={onClose} title={tr("save.as")}>
        {result ? (
          <div className="space-y-4">
            <div className="rounded-md border border-emerald-200 bg-emerald-50 p-3 text-sm text-emerald-900">
              <strong className="block">{tr("save.copyCreated")}</strong>
              <span className="mt-1 block break-all">{result.destination_path}</span>
            </div>
            {result.backup_path ? (
              <p className="text-sm text-slate-600">{tr("save.backupCreated", { path: result.backup_path })}</p>
            ) : null}
            <div className="flex justify-end gap-2">
              <button className="rounded-md border border-slate-300 bg-white px-4 py-2 text-sm font-semibold" onClick={onClose} type="button">{tr("common.close")}</button>
              <button className="inline-flex items-center gap-2 rounded-md bg-slate-900 px-4 py-2 text-sm font-semibold text-white" onClick={() => void onOpenCopy(result.destination_path)} type="button">
                <FolderOpen size={16} aria-hidden="true" />
                {tr("save.openCopy")}
              </button>
            </div>
          </div>
        ) : (
          <form
            className="space-y-4"
            onSubmit={(event) => {
              event.preventDefault();
              if (!folderName.trim() || busy) return;
              setBusy(true);
              setError(null);
              void onSave({
                identity,
                path: destination,
                replace_existing: replaceExisting
              }).then(setResult).catch((caught) => {
                setError(localizeRuntimeError(caught, "save.copyFailed"));
              }).finally(() => setBusy(false));
            }}
          >
            <LabeledInput label={tr("save.folderName")} onChange={setFolderName} value={folderName} />
            <label className="block text-sm font-semibold text-slate-700">
              {tr("projects.parentDirectory")}
              <div className="mt-1 flex gap-2">
                <input className="min-w-0 flex-1 rounded-md border border-slate-300 px-3 py-2 text-sm" onChange={(event) => setDirectory(event.target.value)} value={directory} />
                <button className="icon-button" onClick={() => void chooseDirectory()} title={tr("projects.chooseParentDirectory")} type="button">
                  <FolderOpen size={18} aria-hidden="true" />
                </button>
              </div>
            </label>
            <fieldset>
              <legend className="mb-2 text-sm font-semibold text-slate-700">{tr("save.identity")}</legend>
              <div className="grid grid-cols-2 rounded-md border border-slate-300 bg-slate-100 p-1">
                {(["regenerate", "preserve"] as const).map((option) => (
                  <label className={`cursor-pointer rounded px-3 py-2 text-center text-sm font-semibold ${identity === option ? "bg-white text-slate-900 shadow-sm" : "text-slate-600"}`} key={option}>
                    <input className="sr-only" checked={identity === option} name="save-as-identity" onChange={() => setIdentity(option)} type="radio" />
                    {tr(option === "regenerate" ? "save.independentCopy" : "save.preserveIdentity")}
                  </label>
                ))}
              </div>
              <p className="mt-2 text-xs text-slate-500">{tr(identity === "regenerate" ? "save.independentHint" : "save.preserveHint")}</p>
            </fieldset>
            <label className="flex items-start gap-2 rounded-md border border-amber-200 bg-amber-50 p-3 text-sm text-amber-950">
              <input checked={replaceExisting} className="mt-0.5" onChange={(event) => setReplaceExisting(event.target.checked)} type="checkbox" />
              <span><strong className="block">{tr("save.replaceExisting")}</strong>{tr("save.replaceHint")}</span>
            </label>
            <p className="break-all text-xs text-slate-500">{tr("projects.folder", { path: destination })}</p>
            <p className="text-xs text-slate-500">{tr("save.portableHint")}</p>
            {error ? <p className="text-sm text-red-700" role="alert">{error}</p> : null}
            <div className="flex justify-end gap-2">
              <button className="rounded-md border border-slate-300 bg-white px-4 py-2 text-sm font-semibold" onClick={onClose} type="button">{tr("common.cancel")}</button>
              <button className="inline-flex items-center gap-2 rounded-md bg-slate-900 px-4 py-2 text-sm font-semibold text-white disabled:opacity-50" disabled={busy || !folderName.trim()} type="submit">
                <Copy size={16} aria-hidden="true" />
                {busy ? tr("common.saving") : tr("save.createCopy")}
              </button>
            </div>
          </form>
        )}
      </DialogShell>
      {pickerOpen ? (
        <DirectoryPickerDialog
          initialDirectory={directory}
          onClose={() => setPickerOpen(false)}
          onSelect={(path) => {
            setDirectory(path);
            setPickerOpen(false);
          }}
          title={tr("projects.chooseParentDirectory")}
        />
      ) : null}
    </>
  );
}
