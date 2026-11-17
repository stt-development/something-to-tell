import {
createDefaultProjectSettings
} from "@something-to-tell/contracts/project-manifest";
import type {
ProjectCatalogEntry
} from "@something-to-tell/contracts/project-session";
import {
FolderOpen,
Plus,
RotateCcw
} from "lucide-react";
import { useEffect,useMemo,useState } from "react";
import { ProjectOpenCards } from "./ProjectOpenCards";
import { HelpLauncher } from "../../help/HelpLauncher";
import {
i18next,
localizeRuntimeError,
readBootLocale,
setBootLocale,
tr
} from "../../localization/i18n";
import { createRuntimeApiClient,RuntimeApiError } from "../../runtime/apiClient";
import { enterProjectSession } from "./projectSessionEntry";
import { useProjectEntryReleaseReporter } from "./ProjectEntryReleaseNotice";
import { hasDesktopDirectoryPicker,pickProjectDirectory } from "../../runtime/desktopBridge";
import { DecorativeGraphBackground } from "../../startup/DecorativeGraphBackground";
import { useGraphStore } from "../../state/graphStore";
import {
type ProjectDraft
} from "../../types";


import { ProjectSettingsFields,StorageProfileDialog } from "../settings/ProjectSettingsDialogs";
import { emptyStyleProfileDraft, StyleProfileFields, type StyleProfileDraft } from "../settings/StyleProfileManager";
import { DialogShell,LabeledInput } from "../shared/DialogShell";
import { DEFAULT_WORKSPACE,projectFolder,type StorageProfileDraft } from "../workspaceShared";
import { DirectoryPickerDialog } from "./ProjectDialogs";
import { SchemaAdministrationDialog } from "../settings/SchemaAdministrationDialog";



/** Provisions a new project through the same tested migration path used by Settings. */
export async function configureNewProjectStorage(
  persistence: ReturnType<typeof createRuntimeApiClient>,
  created: Awaited<ReturnType<ReturnType<typeof createRuntimeApiClient>["createProjectSession"]>>,
  profileDraft: StorageProfileDraft | null
) {
  if (!profileDraft) return created;
  const profile = await persistence.createStorageProfile({
    ...profileDraft,
    session_id: created.session.session_id
  });
  await persistence.testStorageProfile(created.session.session_id, profile.profile_id);
  const migrated = await persistence.migrateStorage({
    session_id: created.session.session_id,
    expected_revision: created.session.saved_revision,
    target_mode: "postgresql",
    target_profile_id: profile.profile_id
  });
  return migrated.project;
}

/** Adds one project-owned initial profile only after the new storage authority is ready. */
export async function configureNewProjectStyle(
  created: Awaited<ReturnType<ReturnType<typeof createRuntimeApiClient>["createProjectSession"]>>,
  draft: StyleProfileDraft | null
) {
  if (!draft) return created;
  const persistence = createRuntimeApiClient({
    projectSessionId: created.session.session_id,
    remoteStorage: created.session.remote_storage,
    projectPath: created.session.project_path,
    projectRevision: created.session.saved_revision
  });
  const now = new Date().toISOString();
  const profile = await persistence.createStyleProfile({
    style_profile_version: 1,
    id: crypto.randomUUID(),
    project_id: created.session.project_id,
    ...draft,
    name: draft.name.trim(),
    description: draft.description.trim(),
    guidance: draft.guidance.trim(),
    positive_examples: draft.positive_examples.map((example) => example.trim()).filter(Boolean),
    created_at: now,
    updated_at: now
  });
  const history = await persistence.inspectProjectHistory(created.session.session_id);
  return persistence.updateProjectSettings(created.session.session_id, {
    name: created.document.manifest.name,
    description: created.document.manifest.description,
    settings: {
      ...created.document.manifest.settings,
      style_system: {
        ...created.document.manifest.settings.style_system,
        default_style_profile_id: profile.id
      }
    },
    expected_history_revision: history.history_revision
  });
}






/** Owns startup lifecycle without persisting canonical project content in the browser. */
export function ProjectStartScreen() {
  const reportEntryReleaseFailure = useProjectEntryReleaseReporter();
  // Startup owns its local dialogs; graph/session publications need not redraw it.
  const attachProjectSession = useGraphStore((state) => state.attachProjectSession);
  const loadRuntimeSnapshot = useGraphStore((state) => state.loadRuntimeSnapshot);
  const setFreshProjectId = useGraphStore((state) => state.setFreshProjectId);
  const client = useMemo(() => createRuntimeApiClient(), []);
  const [dialog, setDialog] = useState<"create" | "create-storage" | "open" | "recovery" | null>(null);
  const [recoveryProjectPath, setRecoveryProjectPath] = useState<string | null>(null);
  const [directoryPickerMode, setDirectoryPickerMode] = useState<"create" | "open" | null>(null);
  const [createDraft, setCreateDraft] = useState<ProjectDraft>({
    description: "",
    name: "",
    path: DEFAULT_WORKSPACE,
    settings: { ...createDefaultProjectSettings(), ui_locale: readBootLocale() }
  });
  const [createStorageProfile, setCreateStorageProfile] = useState<StorageProfileDraft | null>(null);
  const [createStyle, setCreateStyle] = useState<StyleProfileDraft | null>(null);
  const [openDirectory, setOpenDirectory] = useState(DEFAULT_WORKSPACE);
  const [catalogProjects, setCatalogProjects] = useState<ProjectCatalogEntry[]>([]);
  const [catalogLoading, setCatalogLoading] = useState(true);
  const [schemaPath, setSchemaPath] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function loadCatalog(directory?: string) {
    setCatalogLoading(true);
    setError(null);
    try {
      const catalog = await client.listProjectCatalog(directory);
      setOpenDirectory(catalog.directory);
      setCatalogProjects(catalog.projects);
      if (!directory) {
        setCreateDraft((draft) => ({
          ...draft,
          path: draft.path === DEFAULT_WORKSPACE ? catalog.directory : draft.path
        }));
      }
    } catch (caught) {
      setCatalogProjects([]);
      setError(localizeRuntimeError(caught, "projects.directoryFailed"));
    } finally {
      setCatalogLoading(false);
    }
  }

  useEffect(() => {
    void loadCatalog();
  }, []);

  async function chooseDirectory(mode: "create" | "open") {
    const current = mode === "create" ? createDraft.path ?? DEFAULT_WORKSPACE : openDirectory;
    if (!hasDesktopDirectoryPicker()) {
      setDirectoryPickerMode(mode);
      return;
    }
    const selected = await pickProjectDirectory(current);
    if (!selected) return;
    applySelectedDirectory(mode, selected);
  }

  function applySelectedDirectory(mode: "create" | "open", selected: string) {
    setDirectoryPickerMode(null);
    if (mode === "create") setCreateDraft((draft) => ({ ...draft, path: selected }));
    else void loadCatalog(selected);
  }

  async function enterWorkspace(acquire: Parameters<typeof enterProjectSession>[0]["acquire"]) {
    const response = await enterProjectSession({ loadSnapshot: loadRuntimeSnapshot, acquire,
      close: client.closeProjectSession, activeSessionId: () => useGraphStore.getState().activeSessionId,
      onReleaseFailure: reportEntryReleaseFailure });
    if (response && useGraphStore.getState().activeSessionId === response.session.session_id) attachProjectSession(response.session.session_id);
    return response;
  }

  async function createProjectSession() {
    if (!createDraft.name.trim() || busy) return;
    setBusy(true);
    setError(null);
    let created: Awaited<ReturnType<typeof client.createProjectSession>> | null = null;
    try {
      const parentDirectory = createDraft.path?.trim() || DEFAULT_WORKSPACE;
      const response = await enterWorkspace(async ({ retain, isCurrent }) => {
        created = retain(await client.createProjectSession({
          description: createDraft.description.trim(), name: createDraft.name.trim(),
          path: projectFolder(parentDirectory, createDraft.name), settings: createDraft.settings
        }));
        if (!isCurrent()) return created;
        const stored = retain(await configureNewProjectStorage(client, created, createStorageProfile));
        if (!isCurrent()) return stored;
        return retain(await configureNewProjectStyle(stored, createStyle));
      });
      if (response && useGraphStore.getState().activeSessionId === response.session.session_id) setFreshProjectId(response.document.manifest.project_id);
    } catch (caught) {
      setError(
        caught instanceof Error
          ? `${caught.message}${created ? ` ${tr("projects.createdBeforeSetupFailure")}` : ""}`
          : "Project creation failed"
      );
    } finally {
      setBusy(false);
    }
  }

  async function openProjectSession(
    projectPath: string,
    recoveryMode: "cancel" | "recover" | "last_saved" = "cancel"
  ) {
    if (!projectPath.trim() || busy) return;
    setBusy(true);
    setError(null);
    try {
      await enterWorkspace(async () => client.openProjectSession({
        path: projectPath.trim(),
        recover_stale_lock: false,
        recovery_mode: recoveryMode
      }));
    } catch (caught) {
      if (caught instanceof RuntimeApiError && caught.code === "project_recovery_required") {
        setRecoveryProjectPath(projectPath);
        setDialog("recovery");
        return;
      }
      setError(localizeRuntimeError(caught, "projects.openingFailed"));
    } finally {
      setBusy(false);
    }
  }

  return (
    <main className="flex h-screen flex-col bg-slate-50 text-slate-900">
      <header className="flex h-14 items-center justify-between border-b border-slate-200 bg-white px-5">
        <h1 className="text-sm font-semibold">{tr("app.name")}</h1>
        <label className="flex items-center gap-2 text-xs font-semibold text-slate-600">
          {tr("projects.interfaceLanguage")}
          <select
            aria-label={tr("projects.interfaceLanguage")}
            className="rounded-md border border-slate-300 bg-white px-2 py-1.5 text-sm text-slate-900"
            onChange={(event) => void setBootLocale(event.target.value as "en" | "ru")}
            value={i18next.language === "ru" ? "ru" : "en"}
          >
            <option value="en">{tr("locale.english")}</option>
            <option value="ru">{tr("locale.russian")}</option>
          </select>
        </label>
      </header>
      <section className="clean-start-stage flex flex-1 items-center justify-center overflow-hidden px-6">
        <DecorativeGraphBackground />
        <div className="clean-start-content w-full max-w-xl" data-testid="empty-project-start">
          <h2 className="text-2xl font-semibold">{tr("projects.title")}</h2>
          <p className="mt-2 text-sm text-slate-600">{tr("projects.intro")}</p>
          <div className="mt-7 grid grid-cols-2 gap-3">
            <button
              autoFocus
              className="inline-flex items-center justify-center gap-2 rounded-md bg-slate-900 px-5 py-3 text-sm font-semibold text-white"
              onClick={() => { setError(null); setDialog("create"); }}
              type="button"
            >
              <Plus size={18} aria-hidden="true" />
              {tr("common.create")}
            </button>
            <button
              className="inline-flex items-center justify-center gap-2 rounded-md border border-slate-300 bg-white px-5 py-3 text-sm font-semibold"
              onClick={() => { setError(null); setDialog("open"); }}
              type="button"
            >
              <FolderOpen size={18} aria-hidden="true" />
              {tr("common.open")}
            </button>
          </div>
          <HelpLauncher link />
          {error && !dialog ? <p className="mt-4 text-sm text-red-700" role="alert">{error}</p> : null}
        </div>
      </section>

      {dialog === "create" ? (
        <DialogShell onClose={() => setDialog(null)} title={tr("projects.create")}>
          <form className="space-y-3" onSubmit={(event) => { event.preventDefault(); void createProjectSession(); }}>
            <LabeledInput label={tr("common.name")} onChange={(name) => setCreateDraft((draft) => ({ ...draft, name }))} value={createDraft.name} />
            <label className="block text-sm font-semibold text-slate-700">
              {tr("projects.parentDirectory")}
              <div className="mt-1 flex gap-2">
                <input
                  className="min-w-0 flex-1 rounded-md border border-slate-300 px-3 py-2 text-sm"
                  onChange={(event) => setCreateDraft((draft) => ({ ...draft, path: event.target.value }))}
                  value={createDraft.path}
                />
                <button className="icon-button" onClick={() => void chooseDirectory("create")} title={tr("projects.chooseParentDirectory")} type="button">
                  <FolderOpen size={18} aria-hidden="true" />
                </button>
              </div>
            </label>
            <ProjectSettingsFields
              agentPersistence={client}
              onChange={(settings) => setCreateDraft((draft) => ({ ...draft, settings }))}
              onConfigureStorage={() => setDialog("create-storage")}
              onUseLocalStorage={() => setCreateStorageProfile(null)}
              settings={createDraft.settings}
              storageDraftLabel={createStorageProfile?.label ?? null}
            />
            <fieldset className="space-y-3 border-t border-slate-200 pt-3">
              <legend className="pr-2 text-sm font-semibold text-slate-700">{tr("style.initialStyle")}</legend>
              <label className="flex items-center gap-2 text-sm font-semibold text-slate-700">
                <input checked={createStyle !== null} onChange={(event) => setCreateStyle(event.target.checked ? emptyStyleProfileDraft() : null)} type="checkbox" />
                {tr("style.createInitialProfile")}
              </label>
              {createStyle ? <StyleProfileFields contentLocale={createDraft.settings.content_locale} draft={createStyle} onChange={setCreateStyle} /> : <p className="text-xs text-slate-500">{tr("style.configureLater")}</p>}
            </fieldset>
            <label className="block text-sm font-semibold text-slate-700">
              {tr("common.description")}
              <textarea className="mt-1 min-h-14 w-full rounded-md border border-slate-300 px-3 py-2 text-sm" onChange={(event) => setCreateDraft((draft) => ({ ...draft, description: event.target.value }))} value={createDraft.description} />
            </label>
            <p className="text-xs text-slate-500">{tr("projects.folder", { path: projectFolder(createDraft.path || DEFAULT_WORKSPACE, createDraft.name) })}</p>
            {error ? <p className="text-sm text-red-700" role="alert">{error}</p> : null}
            <button className="rounded-md bg-slate-900 px-4 py-2 text-sm font-semibold text-white disabled:opacity-50" disabled={busy || !createDraft.name.trim()} type="submit">
              {busy ? tr("common.creating") : tr("common.create")}
            </button>
          </form>
        </DialogShell>
      ) : null}

      {dialog === "create-storage" ? (
        <StorageProfileDialog
          onClose={() => setDialog("create")}
          onSubmit={(profile) => {
            setCreateStorageProfile(profile);
            setDialog("create");
          }}
        />
      ) : null}

      {dialog === "open" ? (
        <DialogShell hidden={schemaPath !== null} onClose={() => setDialog(null)} title={tr("projects.open")}>
          <div className="space-y-4">
            <label className="block text-sm font-semibold text-slate-700">
              {tr("projects.projectsDirectory")}
              <div className="mt-1 flex gap-2">
                <input
                  autoFocus
                  className="min-w-0 flex-1 rounded-md border border-slate-300 px-3 py-2 text-sm"
                  onChange={(event) => setOpenDirectory(event.target.value)}
                  value={openDirectory}
                />
                <button className="icon-button" onClick={() => void chooseDirectory("open")} title={tr("projects.chooseProjectsDirectory")} type="button">
                  <FolderOpen size={18} aria-hidden="true" />
                </button>
                <button
                  aria-label={tr("projects.refreshList")}
                  className="icon-button"
                  disabled={catalogLoading || !openDirectory.trim()}
                  onClick={() => void loadCatalog(openDirectory)}
                  title={tr("projects.loadFromDirectory")}
                  type="button"
                >
                  <RotateCcw size={18} aria-hidden="true" />
                </button>
              </div>
            </label>
            {error ? <p className="text-sm text-red-700" role="alert">{error}</p> : null}
            <div aria-label={tr("projects.available")} className="max-h-80 space-y-2 overflow-y-auto">
              {catalogLoading ? <p className="py-6 text-center text-sm text-slate-500">{tr("projects.loading")}</p> : null}
              {!catalogLoading && catalogProjects.length === 0 ? (
                <p className="rounded-md border border-dashed border-slate-300 px-4 py-6 text-center text-sm text-slate-500">
                  {tr("projects.noneFound")}
                </p>
              ) : null}
              <ProjectOpenCards disabled={busy || catalogLoading} onAdminister={setSchemaPath} onError={setError} onOpen={openProjectSession} projects={catalogProjects} />
            </div>
          </div>
        </DialogShell>
      ) : null}
      {schemaPath ? <SchemaAdministrationDialog onClose={() => setSchemaPath(null)} projectPath={schemaPath} /> : null}
      {dialog === "recovery" && recoveryProjectPath ? (
        <DialogShell
          onClose={() => {
            setRecoveryProjectPath(null);
            setDialog(null);
          }}
          title={tr("projects.recover")}
        >
          <p className="text-sm text-slate-600">
            {tr("projects.recoverPrompt")}
          </p>
          {error ? <p className="mt-3 text-sm text-red-700" role="alert">{error}</p> : null}
          <div className="mt-5 flex justify-end gap-2">
            <button
              className="rounded-md border border-slate-300 bg-white px-3 py-2 text-sm font-semibold"
              onClick={() => {
                setRecoveryProjectPath(null);
                setDialog(null);
              }}
              type="button"
            >
              {tr("common.cancel")}
            </button>
            <button
              className="rounded-md border border-slate-300 bg-white px-3 py-2 text-sm font-semibold"
              disabled={busy}
              onClick={() => void openProjectSession(recoveryProjectPath, "last_saved")}
              type="button"
            >
              {tr("projects.openLastSaved")}
            </button>
            <button
              autoFocus
              className="rounded-md bg-slate-900 px-3 py-2 text-sm font-semibold text-white"
              disabled={busy}
              onClick={() => void openProjectSession(recoveryProjectPath, "recover")}
              type="button"
            >
              {tr("projects.recoverChanges")}
            </button>
          </div>
        </DialogShell>
      ) : null}
      {directoryPickerMode ? (
        <DirectoryPickerDialog
          initialDirectory={directoryPickerMode === "create" ? createDraft.path ?? DEFAULT_WORKSPACE : openDirectory}
          onClose={() => setDirectoryPickerMode(null)}
          onSelect={(path) => applySelectedDirectory(directoryPickerMode, path)}
          title={directoryPickerMode === "create" ? "Choose parent directory" : "Choose projects directory"}
        />
      ) : null}
    </main>
  );
}
