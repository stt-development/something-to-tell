/** Shared pre-consent disclosure for durable instructions sent to one agent. */

import type {
  AgentMemoryAgentId,
  AgentMemoryLocale,
  AgentMemoryResolutionV1,
  AgentMemoryScopeV1,
  ProjectMemoryScopeV1,
  SceneMemoryScopeV1,
  StoryFlowMemoryScopeV1
} from "@something-to-tell/contracts/agent-memory";
import { BookOpen, Plus, Settings } from "lucide-react";
import { useEffect, useState } from "react";
import { localizeRuntimeError, tr } from "../localization/i18n";
import type {
  AgentMemoryWorkspaceSnapshot,
  RuntimeAgentMemoryPersistence
} from "../runtime/apiTypes";

export interface AgentMemoryDisclosureTarget {
  agentId: AgentMemoryAgentId;
  contentLocale: AgentMemoryLocale;
  contextScope: ProjectMemoryScopeV1 | SceneMemoryScopeV1 | StoryFlowMemoryScopeV1;
  scope: AgentMemoryScopeV1;
}

export interface AgentMemoryDraftSeed {
  agent_id: AgentMemoryAgentId;
  content_locale: AgentMemoryLocale;
  scope: AgentMemoryScopeV1;
}

/** Resolves current memory before consent and blocks dispatch on unsafe state. */
export function AgentMemoryDisclosure({
  onAvailabilityChange,
  onCreate,
  onManage,
  persistence,
  sessionId,
  target
}: {
  onAvailabilityChange?: (available: boolean) => void;
  onCreate?: (seed: AgentMemoryDraftSeed) => void;
  onManage?: () => void;
  persistence: RuntimeAgentMemoryPersistence;
  sessionId: string;
  target: AgentMemoryDisclosureTarget;
}) {
  const [workspace, setWorkspace] = useState<AgentMemoryWorkspaceSnapshot | null>(null);
  const [resolution, setResolution] = useState<AgentMemoryResolutionV1 | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    let active = true;
    setLoading(true);
    setError(null);
    setResolution(null);
    onAvailabilityChange?.(false);
    void persistence.loadAgentMemoryWorkspace(sessionId)
      .then(async (current) => {
        const result = await persistence.resolveAgentMemory({
          resolution_version: 1,
          project_id: current.catalog.project_id,
          agent_id: target.agentId,
          namespace: target.agentId,
          scope: target.scope,
          content_locale: target.contentLocale,
          context_scope: target.contextScope,
          source_checksum: current.source_checksum,
          history_revision: current.history_revision
        });
        if (!active) return;
        setWorkspace(current);
        setResolution(result);
        onAvailabilityChange?.(result.status === "resolved");
      })
      .catch((caught) => {
        if (!active) return;
        setError(localizeRuntimeError(caught));
        onAvailabilityChange?.(false);
      })
      .finally(() => active && setLoading(false));
    return () => { active = false; };
  }, [persistence, sessionId, scopeIdentity(target.contextScope), scopeIdentity(target.scope), target.agentId, target.contentLocale]);

  const names = new Map(workspace?.catalog.entries.map((entry) => [entry.id, entry.title]) ?? []);
  const blocking = resolution?.omissions.filter((item) =>
    item.reason === "missing_owner" || item.reason === "stale_owner" || item.reason === "conflict"
  ) ?? [];
  return (
    <section aria-label={tr("agentMemory.disclosureTitle")} className="mt-3 rounded-md border border-slate-200 bg-white p-3 text-xs">
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          <strong className="flex items-center gap-2 text-slate-800"><BookOpen size={14} aria-hidden="true" />{tr("agentMemory.disclosureTitle")}</strong>
          <p className="mt-1 text-slate-500">{tr("agentMemory.disclosureDescription")}</p>
        </div>
        <div className="flex shrink-0 gap-1">
          {onManage ? <button aria-label={tr("agentMemory.manage")} className="icon-button" data-tooltip={tr("agentMemory.manage")} onClick={onManage} type="button"><Settings size={14} aria-hidden="true" /></button> : null}
          {onCreate ? <button aria-label={tr("agentMemory.createForContext")} className="icon-button" data-tooltip={tr("agentMemory.createForContext")} onClick={() => onCreate({ agent_id: target.agentId, content_locale: target.contentLocale, scope: target.scope })} type="button"><Plus size={14} aria-hidden="true" /></button> : null}
        </div>
      </div>
      {loading ? <p aria-live="polite" className="mt-2 text-slate-500">{tr("agentMemory.resolving")}</p> : null}
      {error ? <p className="mt-2 text-red-700" role="alert">{error}</p> : null}
      {resolution ? (
        <>
          <ul className="mt-2 space-y-1" aria-label={tr("agentMemory.includedEntries")}>
            {resolution.entries.map((entry) => (
              <li className="flex items-center justify-between gap-3 rounded bg-slate-50 px-2 py-1" key={entry.id}>
                <span className="truncate font-semibold text-slate-700">{entry.title}</span>
                <small className="shrink-0 text-slate-500">{tr(`agentMemory.precedence.${scopePrecedence(entry.scope, target)}`)}</small>
              </li>
            ))}
          </ul>
          {!resolution.entries.length && resolution.status === "resolved" ? <p className="mt-2 text-slate-500">{tr("agentMemory.noApplicable")}</p> : null}
          <p className="mt-2 text-slate-500">{tr("agentMemory.disclosureTotals", { characters: resolution.included_characters, omitted: resolution.omitted_entries })}</p>
          {resolution.status === "blocked" ? (
            <div className="mt-2 rounded border border-red-200 bg-red-50 p-2 text-red-800" role="alert">
              <strong>{tr("agentMemory.dispatchBlocked")}</strong>
              <p>{blocking.map((item) => names.get(item.memory_id) ?? item.memory_id).join(", ")}</p>
            </div>
          ) : null}
        </>
      ) : null}
    </section>
  );
}

function scopePrecedence(
  scope: AgentMemoryScopeV1,
  target: AgentMemoryDisclosureTarget
): "exact" | "context" | "project" {
  if (scopeIdentity(scope) === scopeIdentity(target.scope)) return "exact";
  if (scopeIdentity(scope) === scopeIdentity(target.contextScope)) return "context";
  return "project";
}

function scopeIdentity(scope: AgentMemoryScopeV1): string {
  return JSON.stringify(scope);
}
