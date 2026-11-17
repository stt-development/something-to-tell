/** Read-only review of runtime-owned inventory and owner-specific diagnostics. */
import { useState } from "react";
import type { ExportPlanV1 } from "@something-to-tell/contracts/export";
import { localizeRuntimeText, tr } from "../localization/i18n";

const INVENTORY_FIELDS = [
  "node_count", "relationship_count", "dialogue_count", "quest_count", "story_flow_count",
  "flow_transition_count", "flow_invocation_count", "flow_exit_count", "initial_state_count",
  "narrative_effect_count", "engine_tag_count", "record_count"
] as const;

export function ExportReview({ plan }: { plan: ExportPlanV1 }) {
  const [severity, setSeverity] = useState("all");
  const diagnostics = plan.diagnostics.filter((item) => severity === "all" || item.severity === severity);
  return <>
    <section aria-label={tr("export.inventory")} className="export-inventory">
      <h3>{tr("export.inventory")}</h3>
      <dl>{INVENTORY_FIELDS.map((field) => <div key={field}>
        <dt>{tr(`export.inventory.${field}`)}</dt><dd>{plan.inventory[field]}</dd>
      </div>)}</dl>
      {plan.inventory.resolved_story_flow_ids.length ? <p className="export-resolved">
        {tr("export.resolvedFlows", { count: plan.inventory.resolved_story_flow_ids.length })}
      </p> : null}
    </section>
    <section aria-label={tr("export.diagnostics")} className="export-diagnostics">
      <div className="export-section-heading"><h3>{tr("export.diagnostics")} ({plan.diagnostics.length})</h3>
        <select aria-label={tr("export.severity")} value={severity} onChange={(event) => setSeverity(event.target.value)}>
          {["all", "error", "warning", "info"].map((value) => <option key={value} value={value}>
            {tr(`export.severity.${value}` as "export.severity.all")}</option>)}
        </select>
      </div>
      <div className="export-diagnostic-list">
        {diagnostics.length ? diagnostics.map((item, index) => <article className={`export-diagnostic export-${item.severity}`} key={`${item.code}-${index}`}>
          <strong>{tr(`export.severity.${item.severity}`)}</strong>
          <p>{localizeRuntimeText(item.message_key, item.parameters, tr("export.diagnostic.unrecognized"))}</p>
          {item.owner ? <p className="export-owner"><span>{tr(`export.owner.${item.owner.kind}`)}</span>
            <code>{[item.owner.context_id, item.owner.id].filter(Boolean).join(" / ")}</code></p> : null}
          <details><summary>{tr("export.details")}</summary><code>{item.code}</code>
            <pre>{JSON.stringify(item.parameters, null, 2)}</pre></details>
        </article>) : <p>{tr("export.noDiagnostics")}</p>}
      </div>
    </section>
  </>;
}
