/** Minimal tidy-tree layout (top-down) for forests. O(n), no dependencies.
 *  Leaves are packed left-to-right; each parent is centred over its first/last child;
 *  roots are separated by `rootGap`. Cycles and dangling parents are tolerated
 *  (a node whose parent is absent is treated as a root). */
export interface LayoutNode {
  id: string;
  parentId: string | null;
  width?: number;
  height?: number;
}
export interface LayoutOptions {
  nodeWidth: number;
  nodeHeight: number;
  gapX: number;
  gapY: number;
  rootGap: number;
}
export interface Point { x: number; y: number }

export const DEFAULT_LAYOUT: LayoutOptions = { nodeWidth: 220, nodeHeight: 84, gapX: 24, gapY: 64, rootGap: 72 };

export function layoutForest(nodes: LayoutNode[], opts: Partial<LayoutOptions> = {}): Map<string, Point> {
  const o = { ...DEFAULT_LAYOUT, ...opts };
  const byId = new Map(nodes.map((n) => [n.id, n]));
  const children = new Map<string, LayoutNode[]>();
  const roots: LayoutNode[] = [];
  for (const n of nodes) {
    if (n.parentId && n.parentId !== n.id && byId.has(n.parentId)) {
      const arr = children.get(n.parentId) ?? [];
      arr.push(n);
      children.set(n.parentId, arr);
    } else {
      roots.push(n);
    }
  }
  const pos = new Map<string, Point>();
  const visited = new Set<string>();
  // Per-depth row heights so taller node types don't overlap the next row.
  const rowHeight: number[] = [];
  const collectHeights = (n: LayoutNode, depth: number, seen: Set<string>) => {
    if (seen.has(n.id)) return;
    seen.add(n.id);
    rowHeight[depth] = Math.max(rowHeight[depth] ?? 0, n.height ?? o.nodeHeight);
    for (const c of children.get(n.id) ?? []) collectHeights(c, depth + 1, seen);
  };
  const seenH = new Set<string>();
  for (const r of roots) collectHeights(r, 0, seenH);
  const rowY: number[] = [];
  let acc = 0;
  for (let d = 0; d < rowHeight.length; d++) {
    rowY[d] = acc;
    acc += (rowHeight[d] ?? o.nodeHeight) + o.gapY;
  }

  let cursor = 0;
  const place = (n: LayoutNode, depth: number): number /* centre x */ => {
    visited.add(n.id);
    const w = n.width ?? o.nodeWidth;
    const kids = (children.get(n.id) ?? []).filter((c) => !visited.has(c.id));
    let x: number;
    if (kids.length === 0) {
      x = cursor;
      cursor += w + o.gapX;
    } else {
      const centres = kids.map((k) => place(k, depth + 1));
      const centre = (centres[0] + centres[centres.length - 1]) / 2;
      x = centre - w / 2;
      if (x + w + o.gapX > cursor) cursor = x + w + o.gapX;
    }
    pos.set(n.id, { x, y: rowY[depth] ?? depth * (o.nodeHeight + o.gapY) });
    return x + w / 2;
  };
  roots.forEach((r, i) => {
    if (visited.has(r.id)) return;
    if (i > 0) cursor += o.rootGap - o.gapX;
    place(r, 0);
  });
  // Any node left unvisited (pure cycles) gets appended as its own root.
  for (const n of nodes) if (!visited.has(n.id)) { cursor += o.rootGap; place(n, 0); }
  return pos;
}
