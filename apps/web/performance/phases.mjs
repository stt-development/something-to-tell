/** Transient probe aggregates only; never receives document values or React props. */
export const PHASE_NAMES = ["snapshot_projection", "store_prepare", "workspace_projection", "view_filter", "frame_projection"];

export function createPhaseCollector(now = () => performance.now()) {
  let active = false;
  let generation = 0;
  let phases;
  let react;
  const reset = () => {
    phases = Object.fromEntries(PHASE_NAMES.map((name) => [name, { count: 0, total_ms: 0, max_ms: 0 }]));
    react = { commits: 0, render_actual_ms: 0, render_max_ms: 0, by_phase: { mount: 0, update: 0, "nested-update": 0 } };
  };
  reset();
  return {
    start() { generation++; reset(); active = true; },
    begin(name) {
      if (!PHASE_NAMES.includes(name)) throw new Error("unknown_probe_phase");
      if (!active) return () => {};
      const current = generation;
      const start = now();
      let finished = false;
      return () => {
        // Do not charge a late completion to the next action or close twice.
        if (finished || !active || current !== generation) return;
        finished = true;
        const elapsed = now() - start;
        if (!Number.isFinite(elapsed) || elapsed < 0) throw new Error("invalid_probe_clock");
        const row = phases[name];
        row.count++;
        row.total_ms += elapsed;
        row.max_ms = Math.max(row.max_ms, elapsed);
      };
    },
    onRender(_id, phase, actualDuration) {
      if (!active) return;
      if (!Object.hasOwn(react.by_phase, phase) || !Number.isFinite(actualDuration) || actualDuration < 0) {
        throw new Error("invalid_probe_commit");
      }
      react.commits++;
      react.by_phase[phase]++;
      react.render_actual_ms += actualDuration;
      react.render_max_ms = Math.max(react.render_max_ms, actualDuration);
    },
    stop() {
      active = false;
      return structuredClone({ phases, react, client_document_validation: "not_present_in_open_path" });
    }
  };
}
