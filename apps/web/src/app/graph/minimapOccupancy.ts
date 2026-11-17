import policy from "../../../performance/rendering-policy.v1.json";

export interface MiniMapRect { x: number; y: number; width: number; height: number }
export interface MiniMapNode {
  id: string; parentId?: string; position: { x: number; y: number };
  width?: number; height?: number; measured?: { width?: number; height?: number };
  origin?: readonly [number, number]; selected?: boolean;
}
export interface MiniMapOccupancy {
  bounds: MiniMapRect; cells: Uint8Array; columns: number; rows: number;
  nodeCount: number; occupiedCells: number; contributions: number;
}
export interface MiniMapTransform { scale: number; x: number; y: number }
const validRect = (r: MiniMapRect) => [r.x, r.y, r.width, r.height, r.x + r.width, r.y + r.height].every(Number.isFinite) && r.width > 0 && r.height > 0;

/** Whole visual projection only. Ambiguous geometry returns null for the legacy fallback. */
export function minimapOccupancy(nodes: readonly MiniMapNode[], origin: readonly [number, number] = [0, 0]): MiniMapOccupancy | null {
  const byId = new Map(nodes.map((node) => [node.id, node]));
  if (byId.size !== nodes.length) return null;
  const rectangles = new Map<string, MiniMapRect>();
  // Iterative memoized ancestry is linear even for a reversed 10,000-deep chain.
  for (const node of nodes) {
    if (rectangles.has(node.id)) continue;
    const path: MiniMapNode[] = [], visiting = new Set<string>();
    let current: MiniMapNode | undefined = node;
    while (current && !rectangles.has(current.id)) {
      if (visiting.has(current.id)) return null;
      visiting.add(current.id); path.push(current);
      if (current.parentId && !byId.has(current.parentId)) return null;
      current = current.parentId ? byId.get(current.parentId) : undefined;
    }
    for (let i = path.length - 1; i >= 0; i--) {
      const entry = path[i]!, parent = entry.parentId ? rectangles.get(entry.parentId) : undefined;
      const width = entry.measured?.width ?? entry.width, height = entry.measured?.height ?? entry.height;
      const anchor = entry.origin ?? origin;
      if (width == null || height == null || ![...anchor, entry.position.x, entry.position.y].every(Number.isFinite)) return null;
      const rect = { x: (parent?.x ?? 0) + entry.position.x - width * anchor[0],
        y: (parent?.y ?? 0) + entry.position.y - height * anchor[1], width, height };
      if (!validRect(rect)) return null;
      rectangles.set(entry.id, rect);
    }
  }
  const columns = policy.minimap_columns, rows = policy.minimap_rows;
  const cells = new Uint8Array(columns * rows);
  if (!nodes.length) return { bounds: { x: 0, y: 0, width: 1, height: 1 }, cells, columns, rows, nodeCount: 0, occupiedCells: 0, contributions: 0 };
  let left = Infinity, top = Infinity, right = -Infinity, bottom = -Infinity;
  for (const r of rectangles.values()) { left = Math.min(left, r.x); top = Math.min(top, r.y); right = Math.max(right, r.x + r.width); bottom = Math.max(bottom, r.y + r.height); }
  const bounds = { x: left, y: top, width: right - left, height: bottom - top };
  if (!validRect(bounds)) return null;
  let contributions = 0, occupiedCells = 0;
  for (const node of nodes) {
    const r = rectangles.get(node.id)!;
    const x0 = Math.min(columns - 1, Math.max(0, Math.floor((r.x - left) / bounds.width * columns)));
    const x1 = Math.min(columns - 1, Math.ceil((r.x + r.width - left) / bounds.width * columns) - 1);
    const y0 = Math.min(rows - 1, Math.max(0, Math.floor((r.y - top) / bounds.height * rows)));
    const y1 = Math.min(rows - 1, Math.ceil((r.y + r.height - top) / bounds.height * rows) - 1);
    for (let y = y0; y <= Math.max(y0, y1); y++) for (let x = x0; x <= Math.max(x0, x1); x++) {
      const index = y * columns + x;
      if (!cells[index]) occupiedCells++;
      cells[index] = cells[index]! | (node.selected ? 3 : 1); contributions++;
    }
  }
  return { bounds, cells, columns, rows, nodeCount: nodes.length, occupiedCells, contributions };
}

/** Exact letterbox transform shared by raster, viewport and inverse navigation. */
export function minimapTransform(bounds: MiniMapRect, width: number, height: number, padding = 8): MiniMapTransform {
  const scale = Math.min((width - padding * 2) / bounds.width, (height - padding * 2) / bounds.height);
  return { scale, x: (width - bounds.width * scale) / 2 - bounds.x * scale, y: (height - bounds.height * scale) / 2 - bounds.y * scale };
}
export function minimapWorldPoint(transform: MiniMapTransform, point: { x: number; y: number }) {
  return { x: (point.x - transform.x) / transform.scale, y: (point.y - transform.y) / transform.scale };
}
export function minimapViewport(transform: MiniMapTransform, camera: { x: number; y: number; zoom: number }, width: number, height: number): MiniMapRect {
  return { x: transform.x - camera.x / camera.zoom * transform.scale, y: transform.y - camera.y / camera.zoom * transform.scale,
    width: width / camera.zoom * transform.scale, height: height / camera.zoom * transform.scale };
}
