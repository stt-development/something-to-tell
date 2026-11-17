import type { StyleCatalogV1 } from "@something-to-tell/contracts/style-system";
import { Palette } from "lucide-react";
import { useEffect, useState } from "react";
import { localizeRuntimeError, tr } from "../../localization/i18n";
import type { RuntimeStylePersistence } from "../../runtime/apiTypes";

/** Persists only a profile reference; Scene content never duplicates style fields. */
export function SceneStyleSelector({
  persistence,
  projectId,
  sceneNodeId,
  sessionId
}: {
  persistence: RuntimeStylePersistence;
  projectId: string;
  sceneNodeId: string;
  sessionId: string;
}) {
  const [catalog, setCatalog] = useState<StyleCatalogV1 | null>(null);
  const [busy, setBusy] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const assignment = catalog?.scene_assignments.find((item) => item.scene_node_id === sceneNodeId) ?? null;
  const selectedId = assignment?.style_profile_id ?? "";
  const effectiveId = selectedId || catalog?.default_style_profile_id || "";
  const effective = catalog?.profiles.find((profile) => profile.id === effectiveId) ?? null;
  const missingReference = Boolean(effectiveId && !effective);

  async function reload() {
    setCatalog(await persistence.loadStyleCatalog(sessionId));
  }

  useEffect(() => {
    setBusy(true);
    void reload().catch((caught) => setError(localizeRuntimeError(caught))).finally(() => setBusy(false));
  }, [sessionId, sceneNodeId]);

  async function select(profileId: string) {
    setBusy(true);
    setError(null);
    try {
      if (!profileId) {
        await persistence.clearSceneStyleAssignment(sceneNodeId, projectId);
      } else {
        const now = new Date().toISOString();
        await persistence.upsertSceneStyleAssignment({
          assignment_version: 1,
          id: assignment?.id ?? crypto.randomUUID(),
          project_id: projectId,
          scene_node_id: sceneNodeId,
          style_profile_id: profileId,
          created_at: assignment?.created_at ?? now,
          updated_at: now
        });
      }
      await reload();
    } catch (caught) {
      setError(localizeRuntimeError(caught));
    } finally {
      setBusy(false);
    }
  }

  return (
    <section className="rounded-md border border-slate-200 bg-slate-50 p-3" aria-label={tr("style.sceneStyle") }>
      <div className="flex items-center gap-2">
        <Palette className="text-sky-700" size={16} aria-hidden="true" />
        <h3 className="text-sm font-semibold text-slate-800">{tr("style.sceneStyle")}</h3>
      </div>
      <label className="style-profile-field mt-2">
        {tr("style.sceneSelection")}
        <select disabled={busy} onChange={(event) => void select(event.target.value)} value={selectedId}>
          <option value="">{tr("style.inheritProjectStyle")}</option>
          {catalog?.profiles.map((profile) => <option key={profile.id} value={profile.id}>{profile.name}</option>)}
        </select>
      </label>
      <p className="mt-2 text-xs text-slate-600">
        {effective
          ? tr("style.effectiveStyle", { name: effective.name })
          : tr("style.noEffectiveStyle")}
      </p>
      {effective?.description ? <p className="mt-1 text-xs text-slate-500">{effective.description}</p> : null}
      {missingReference ? <p className="mt-1 text-xs font-medium text-red-700" role="alert">{tr("style.missingReference")}</p> : null}
      {error ? <p className="mt-1 text-xs font-medium text-red-700" role="alert">{error}</p> : null}
    </section>
  );
}
