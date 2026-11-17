import { compareFlowGeometry } from "./protected-flow-contract.mjs";

export const NODE_DETAIL_SUITE = "node_detail_depth_zoom_v1";
export const DETAIL_VARIANT = "deep_detail_v1";
export const APPROVED_NODE_DETAIL_DEFAULT = true;
const modulePath = "/src/app/graph/CanvasNodePresentation.tsx";

/** Exact build-only source-default override; device Off and Graph/Flow boundaries remain real. */
export function nodeDetailGatePlugin(enabled) {
  let transformed = 0;
  return { name: "node-detail-browser-gate",
    transform(code, id) {
      if (!id.endsWith(modulePath)) return null;
      const declaration = `export const NODE_DETAIL_PRESENTATION_ENABLED = ${APPROVED_NODE_DETAIL_DEFAULT};`;
      if (code.split(declaration).length !== 2) throw Error("node_detail_gate_changed");
      transformed++; return code.replace(declaration, `export const NODE_DETAIL_PRESENTATION_ENABLED = ${enabled};`);
    },
    buildEnd(error) { if (!error && transformed !== 1) throw Error("node_detail_gate_not_verified"); }
  };
}

/** Named pinned-copy roles use public ids/ancestry, never repeated authored titles. */
export function detailFixtureTargets(document) {
  const offices = document.nodes.filter((node) => node.type === "Location" && node.id.endsWith("-node-customs-office"))
    .sort((a, b) => a.id.localeCompare(b.id)).slice(0, 5);
  const primary = new Map(document.placements.filter((row) => row.is_primary).map((row) => [row.canonical_node_id, row]));
  if (offices.length !== 5 || offices.some((node, index) => !primary.has(node.id)
    || (index > 0 && primary.get(node.id).container_node_id !== offices[index - 1].id))) throw Error("node_detail_fixture_shape_failed");
  const harbor = primary.get(primary.get(offices[0].id).container_node_id);
  const scene = document.nodes.find((node) => node.id === harbor?.container_node_id && node.type === "Scene");
  const leaf = document.nodes.find((node) => node.type === "Lore" && primary.get(node.id)?.container_node_id === offices[4].id);
  if (!scene || !leaf) throw Error("node_detail_fixture_shape_failed");
  return { scene, offices, leaf };
}

export function compareDetailLayouts(reference, candidate) {
  const names = ["root_fit", "scene_nominal", "root_restored"];
  return Object.fromEntries(names.map((name) => [name, compareFlowGeometry(reference?.[name], candidate?.[name])]));
}

/** Counts presentation work separately from the complete immutable geometry/edge inputs. */
export function readDetailCounts() {
  const counts = { full: 0, shell: 0, overview: 0, compact: 0, folded: 0 };
  for (const node of document.querySelectorAll("article[data-node-presentation]")) {
    const mode = node.getAttribute("data-node-presentation");
    if (!Object.hasOwn(counts, mode)) throw Error("node_detail_mode_unknown");
    counts[mode]++;
  }
  return counts;
}
