import { measureClippedMarkerOutset, type ClippedMarkerOutset } from "./clippedMarkerOutset";

export type SvgMarkerReferenceOutset = ClippedMarkerOutset | { readonly kind: "none" };
const unknown = Object.freeze({ kind: "unknown" as const }), none = Object.freeze({ kind: "none" as const });
const SVG = "http://www.w3.org/2000/svg";

function markerId(value: string, document: Document): string | null {
  // CSSOM's quoted url serialization only; escaped/other grammars stay unknown.
  if (!value.startsWith('url("') || !value.endsWith('")')) return null;
  const raw = value.slice(5, -2);
  if (!raw || raw.includes("\\") || raw.includes('"')) return null;
  const reference = new URL(raw, document.baseURI), current = new URL(document.URL), hash = reference.hash;
  reference.hash = ""; current.hash = "";
  return hash && reference.href === current.href ? decodeURIComponent(hash.slice(1)) : null;
}

/** Per-pass DOM index only; no graph records, cached radii, paths or published footprints. */
export function createSvgMarkerReferenceReader(root: HTMLElement) {
  const document = root.ownerDocument, markers = new Map<string, SVGMarkerElement | null>();
  let disposed = false;
  for (const marker of root.querySelectorAll<SVGMarkerElement>("marker[id]")) {
    markers.set(marker.id, markers.has(marker.id) ? null : marker);
  }
  const current = (owner: SVGGeometryElement) => !disposed && root.isConnected && root.ownerDocument === document
    && owner.isConnected && owner.ownerDocument === document && owner.namespaceURI === SVG && root.contains(owner);
  const resolve = (id: string): SVGMarkerElement | null => {
    const marker = markers.get(id);
    return marker?.isConnected && marker.ownerDocument === document && root.contains(marker)
      && document.getElementById(id)?.isSameNode(marker) ? marker : null;
  };
  return {
    measure(owner: SVGGeometryElement | null): SvgMarkerReferenceOutset {
      try {
        if (!owner || !current(owner) || !document.defaultView) return unknown;
        const properties = () => {
          const style = document.defaultView!.getComputedStyle(owner);
          return [style.markerStart, style.markerMid, style.markerEnd];
        };
        const before = properties(), used = new Map<string, SVGMarkerElement>();
        let radius = 0;
        for (const value of before) {
          if (value === "none") continue;
          const id = markerId(value, document);
          if (!id) return unknown;
          if (used.has(id)) continue;
          const marker = resolve(id);
          if (!marker) return unknown;
          const bound = measureClippedMarkerOutset(marker, owner);
          if (bound.kind !== "bounded") return unknown;
          used.set(id, marker); radius = Math.max(radius, bound.radius);
        }
        const after = properties();
        if (!current(owner) || before.some((value, index) => value !== after[index])
          || [...used].some(([id, marker]) => resolve(id) !== marker)) return unknown;
        return used.size ? Object.freeze({ kind: "bounded", coordinateSpace: "owner-local", radius }) : none;
      } catch {
        return unknown;
      }
    },
    dispose() { disposed = true; markers.clear(); }
  };
}
