import { createContext, useContext, useMemo, type ReactNode } from "react";
import { useTranslation } from "react-i18next";
import type { DialogueDocument, DialogueElement } from "../../dialogue/contracts";
import { tr } from "../../localization/i18n";
import { useNativeSelectDisclosure } from "../shared/useNativeSelectDisclosure";

export function dialogueElementSummary(element: DialogueElement) {
  const text = element.kind === "line" ? element.text : element.prompt;
  return text.trim().slice(0, 48) || element.id;
}

/** One current immutable element-list projection, not a retained graph/draft cache. */
export function createDialogueNextTargets(elements: DialogueElement[]) {
  const ordered = elements.map((element, index) => ({ id: element.id, kind: element.kind, index, summary: dialogueElementSummary(element) }));
  const byId = new Map<string, typeof ordered[number]>();
  for (const target of ordered) if (!byId.has(target.id)) byId.set(target.id, target);
  return { elements, ordered, byId };
}

const NextTargets = createContext<ReturnType<typeof createDialogueNextTargets> | null>(null);

export function DialogueNextTargets({ document, children }: { document: DialogueDocument; children: ReactNode }) {
  const targets = useMemo(() => createDialogueNextTargets(document.elements), [document.elements]);
  return <NextTargets.Provider value={targets}>{children}</NextTargets.Provider>;
}

/** Keep a native select, materializing long option sets only for actual interaction. */
export function DialogueNextSelect({ document, label, onChange, value }: {
  document: DialogueDocument; label: string; onChange: (value: string | null) => void; value: string | null;
}) {
  useTranslation();
  const shared = useContext(NextTargets);
  const targets = useMemo(() => shared?.elements === document.elements ? shared : createDialogueNextTargets(document.elements), [shared, document.elements]);
  const large = targets.ordered.length > 80;
  const { expanded, ...interaction } = useNativeSelectDisclosure(large);
  const current = value === null ? undefined : targets.byId.get(value);
  const visible = large && !expanded ? current ? [current] : [] : targets.ordered;
  return <label className="block text-xs font-semibold text-slate-600">
    <span className="dialogue-field-heading">{label}</span>
    <select aria-label={label} className="dialogue-next-select mt-1 w-full rounded-md border border-slate-300 bg-white px-3 py-2 text-sm"
      data-next-target-mode={large && !expanded ? "compact" : "full"}
      {...interaction}
      onChange={(event) => onChange(event.currentTarget.value || null)} value={value ?? ""}>
      <option key="end" value="">{tr("dialogue.end")}</option>
      {visible.map((target) => <option key={`target-${target.index}`} value={target.id}>
        {target.index + 1}. {tr(target.kind === "line" ? "dialogue.line" : "dialogue.choice")}: {target.summary}
      </option>)}
    </select>
  </label>;
}
