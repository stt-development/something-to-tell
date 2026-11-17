import type { ProjectCatalogEntry } from "@something-to-tell/contracts/project-session";
import { Database } from "lucide-react";
import { useRef, useState } from "react";
import { tr } from "../../localization/i18n";

/** One pending card across both Open surfaces; progress is not a fake percentage. */
export function ProjectOpenCards({ projects, disabled = false, onOpen, onError, onAdminister }: {
  projects: ProjectCatalogEntry[];
  disabled?: boolean;
  onOpen: (path: string) => Promise<void>;
  onError: (message: string) => void;
  onAdminister?: (path: string) => void;
}) {
  const [openingPath, setOpeningPath] = useState<string | null>(null);
  const opening = useRef(false);

  async function open(path: string) {
    if (disabled || opening.current) return;
    opening.current = true;
    setOpeningPath(path);
    try {
      await onOpen(path);
    } catch (caught) {
      onError(caught instanceof Error ? caught.message : tr("projects.openingFailed"));
    } finally {
      opening.current = false;
      setOpeningPath(null);
    }
  }

  return <>{projects.map((project) => (
    <div className="relative" key={project.path}>
    <button
      aria-busy={openingPath === project.path}
      className={`project-open-card w-full rounded-md border border-slate-200 bg-white p-3 text-left hover:border-slate-400 disabled:cursor-wait ${onAdminister ? "pr-14" : ""}`}
      disabled={disabled || openingPath !== null}
      onClick={() => void open(project.path)}
      type="button"
    >
      <span className="block font-semibold">{project.name}</span>
      <span className="mt-1 block text-sm text-slate-600">{project.description || tr("projects.noDescription")}</span>
      <span className="mt-2 block break-words text-xs text-slate-500">
        {project.path}{" \u00b7 "}{tr("projects.updated", { date: project.updated_at.slice(0, 10) })}
      </span>
      {openingPath === project.path ? (
        <span aria-label={tr("projects.openingProject", { name: project.name })} className="project-open-progress" role="progressbar">
          <span />
        </span>
      ) : null}
    </button>
    {onAdminister ? <span className="absolute right-3 top-3" data-tooltip={tr("storageAdmin.manageProject", { name: project.name })}>
      <button aria-label={tr("storageAdmin.title")} className="icon-button" disabled={disabled || openingPath !== null}
        onClick={() => onAdminister(project.path)} type="button"><Database size={16} aria-hidden="true" /></button>
    </span> : null}
    </div>
  ))}</>;
}
