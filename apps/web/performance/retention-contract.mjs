export const RETENTION_SUITE = "closed_workspace_retention_v1";

/** Permit only owned acquisition/release, never authoring or a user catalog project. */
export function allowedRetentionWrite(path, method, body, projectPaths, sessionIds) {
  if (method !== "POST") return false;
  if (path === "/api/project-sessions/open") return projectPaths.has(body?.path);
  const close = path.match(/^\/api\/project-sessions\/([^/]+)\/close$/);
  return Boolean(close && sessionIds.has(decodeURIComponent(close[1])));
}

/** Numeric equivalent-state observations, not a new heap latency/support threshold. */
export function summarizeRetention(samples) {
  if (samples.length !== 7 || samples.some((row, index) => row.checkpoint !== index
    || [row.heap_used, row.dom_nodes, row.documents, row.listeners].some((value) => !Number.isFinite(value) || value < 0)
    || row.canvas_nodes !== 0 || row.canvas_edges !== 0 || row.story_beats !== 0 || row.navigation_lists !== 0)) {
    throw Error("retention_checkpoint_incomplete");
  }
  const changes = {};
  for (const key of ["heap_used", "dom_nodes", "documents", "listeners"]) {
    const values = samples.map((row) => row[key]);
    changes[key] = { first: values[0], last: values.at(-1), range: Math.max(...values) - Math.min(...values), delta: values.at(-1) - values[0] };
  }
  return changes;
}
