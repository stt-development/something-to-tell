import { createContext, useContext, useMemo, type ReactNode } from "react";
import { useTranslation } from "react-i18next";
import type { QuestStage } from "../../quest/contracts";
import { tr } from "../../localization/i18n";
import { useNativeSelectDisclosure } from "../shared/useNativeSelectDisclosure";

/** Current ordered stages and first-match identity; never another Quest draft owner. */
export function createQuestStageTargets(stages: QuestStage[]) {
  const byId = new Map<string, QuestStage>();
  for (const stage of stages) if (!byId.has(stage.id)) byId.set(stage.id, stage);
  return { stages, byId };
}
const Targets = createContext<ReturnType<typeof createQuestStageTargets> | null>(null);

export function QuestStageTargets({ stages, children }: { stages: QuestStage[]; children: ReactNode }) {
  const value = useMemo(() => createQuestStageTargets(stages), [stages]);
  return <Targets.Provider value={value}>{children}</Targets.Provider>;
}

export function QuestStageTargetSelect({ stages, ownerId, value, onChange }: {
  stages: QuestStage[]; ownerId: string; value: string | null; onChange: (value: string | null) => void;
}) {
  useTranslation();
  const shared = useContext(Targets);
  const targets = useMemo(() => shared?.stages === stages ? shared : createQuestStageTargets(stages), [shared, stages]);
  const large = stages.length > 80;
  const { expanded, ...interaction } = useNativeSelectDisclosure(large);
  const current = value === null || value === ownerId ? undefined : targets.byId.get(value);
  const visible = large && !expanded ? current ? [current] : [] : stages.filter((stage) => stage.id !== ownerId);
  return <label className="block text-xs font-semibold text-slate-600">{tr("quest.internalTarget")}
    <select {...interaction} aria-label={tr("quest.internalTarget")} data-quest-stage-target
      className="mt-1 w-full rounded-md border border-slate-300 bg-white px-2 py-1.5 text-sm"
      onChange={(event) => onChange(event.currentTarget.value || null)} value={value ?? ""}>
      <option key="external" value="">{tr("quest.externalOutcome")}</option>
      {visible.map((stage) => <option key={stage.id} value={stage.id}>{stage.title}</option>)}
    </select>
  </label>;
}
