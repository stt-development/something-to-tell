const stable = (value) => JSON.stringify(value, (_, item) => item && typeof item === "object" && !Array.isArray(item)
  ? Object.fromEntries(Object.keys(item).sort().map((key) => [key, item[key]])) : item);

/** Fixture JSON values: key order is irrelevant, authored array order is not. */
export const sameFixtureValue = (a, b) => stable(a) === stable(b);

/** Shared read-only baseline invariant for Graph canary scenarios, not graph state. */
export function preservesBaselineDocument(before, current, growingCollections = []) {
  if (!before?.manifest || !current?.manifest || current.manifest.project_id !== before.manifest.project_id
    || !sameFixtureValue(current.manifest.settings, before.manifest.settings)) return false;
  const growing = new Set(growingCollections);
  for (const [key, records] of Object.entries(before)) {
    if (!Array.isArray(records)) continue;
    if (!Array.isArray(current[key])) return false;
    const actual = new Set(current[key].map(stable));
    if (!records.every((record) => actual.has(stable(record)))) return false;
    if (!growing.has(key) && current[key].length !== records.length) return false;
  }
  return true;
}
