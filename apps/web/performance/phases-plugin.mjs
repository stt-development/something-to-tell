import ts from "typescript";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

const virtual = "virtual:stt-phase-probe";
const resolved = "\0" + virtual;
export const PHASE_TARGETS = {
  "runtime/projections.ts": { projectSessionToGraphSnapshot: "snapshot_projection" },
  "state/graphStore.ts": { runtimeSnapshotState: "store_prepare" },
  "story-flow/workspace.ts": { projectGraphForWorkspace: "workspace_projection" },
  "app/graph/graphProjection.tsx": { filterGraphForView: "view_filter", projectFrameWorkspace: "frame_projection" }
};

/** Parse TS/TSX to locate bodies, retaining original source outside those spans. */
export function instrumentPhaseSource(source, owner) {
  const targets = PHASE_TARGETS[owner];
  if (!targets && owner !== "main.tsx") return null;
  const ast = ts.createSourceFile(owner, source, ts.ScriptTarget.Latest, true,
    owner.endsWith(".tsx") ? ts.ScriptKind.TSX : ts.ScriptKind.TS);
  if (ast.parseDiagnostics.length) throw new Error("invalid_phase_target_source:" + owner);
  const edits = [];
  const found = new Set();
  function visit(node) {
    if (targets && ts.isFunctionDeclaration(node) && node.name && Object.hasOwn(targets, node.name.text)) {
      const name = node.name.text;
      if (!node.body || found.has(name) || node.asteriskToken
          || node.modifiers?.some((modifier) => modifier.kind === ts.SyntaxKind.AsyncKeyword)) {
        throw new Error("unsupported_phase_target:" + owner + ":" + name);
      }
      found.add(name);
      // Same body/this/return/throw behavior; finally also records failed calls.
      edits.push({ start: node.body.getStart(ast) + 1, end: node.body.getStart(ast) + 1,
        text: `\nconst __sttPhaseEnd = __sttPhaseProbe.begin(${JSON.stringify(targets[name])}); try {\n` });
      edits.push({ start: node.body.end - 1, end: node.body.end - 1, text: "\n} finally { __sttPhaseEnd(); }\n" });
    }
    if (owner === "main.tsx" && ts.isJsxSelfClosingElement(node) && node.tagName.getText(ast) === "App") {
      if (found.has("App")) throw new Error("duplicate_phase_root");
      found.add("App");
      edits.push({ start: node.getStart(ast), end: node.end,
        text: `<__sttProfiler id="app" onRender={__sttPhaseProbe.onRender}>${node.getText(ast)}</__sttProfiler>` });
    }
    ts.forEachChild(node, visit);
  }
  visit(ast);
  const expected = targets ? Object.keys(targets) : ["App"];
  if (expected.some((name) => !found.has(name))) throw new Error("missing_phase_target:" + owner);
  let code = source;
  for (const edit of edits.sort((a, b) => b.start - a.start)) code = code.slice(0, edit.start) + edit.text + code.slice(edit.end);
  return `import { probe as __sttPhaseProbe } from ${JSON.stringify(virtual)};\n`
    + (owner === "main.tsx" ? 'import { Profiler as __sttProfiler } from "react";\n' : "") + code;
}

/** Installed exclusively by perf:baseline --phases, never normal Vite config. */
export function phaseProbePlugin() {
  const seen = new Set();
  const expected = [...Object.keys(PHASE_TARGETS), "main.tsx"];
  return {
    name: "stt-diagnostic-phases", enforce: "pre", apply: "build",
    resolveId(id) { if (id === virtual) return resolved; },
    load(id) {
      if (id !== resolved) return null;
      return readFileSync(fileURLToPath(new URL("./phases.mjs", import.meta.url)), "utf8")
        + "\nexport const probe = createPhaseCollector(); window.__sttPhaseProbe = probe;\n";
    },
    transform(source, id) {
      const path = id.split("?")[0].replaceAll("\\", "/");
      const owner = expected.find((name) => path.endsWith("/apps/web/src/" + name));
      if (!owner) return null;
      seen.add(owner);
      return { code: instrumentPhaseSource(source, owner), map: null };
    },
    buildEnd(error) {
      if (!error && expected.some((owner) => !seen.has(owner))) throw new Error("missing_phase_module");
    }
  };
}
