import { describe, expect, it } from "vitest";
import { layoutForest, type LayoutNode } from "./layout";

const W = 100;
const opts = { nodeWidth: W, nodeHeight: 50, gapX: 10, gapY: 30, rootGap: 40 };

function overlaps(pos: Map<string, { x: number; y: number }>) {
  const arr = [...pos.values()];
  for (let i = 0; i < arr.length; i++)
    for (let j = i + 1; j < arr.length; j++)
      if (arr[i].y === arr[j].y && Math.abs(arr[i].x - arr[j].x) < W) return true;
  return false;
}

describe("layoutForest", () => {
  it("centres a parent over its children", () => {
    const n: LayoutNode[] = [{ id: "r", parentId: null }, { id: "a", parentId: "r" }, { id: "b", parentId: "r" }, { id: "c", parentId: "r" }];
    const p = layoutForest(n, opts);
    const centre = (id: string) => p.get(id)!.x + W / 2;
    expect(centre("r")).toBeCloseTo((centre("a") + centre("c")) / 2);
    expect(p.get("a")!.y).toBeGreaterThan(p.get("r")!.y);
    expect(p.get("a")!.x).toBeLessThan(p.get("b")!.x);
  });

  it("never overlaps nodes on the same row", () => {
    const n: LayoutNode[] = [{ id: "r", parentId: null }];
    for (let i = 0; i < 6; i++) {
      n.push({ id: `c${i}`, parentId: "r" });
      for (let j = 0; j < i; j++) n.push({ id: `c${i}-${j}`, parentId: `c${i}` });
    }
    n.push({ id: "r2", parentId: null }, { id: "r2a", parentId: "r2" });
    expect(overlaps(layoutForest(n, opts))).toBe(false);
  });

  it("treats dangling parents as roots and survives cycles", () => {
    const n: LayoutNode[] = [
      { id: "x", parentId: "missing" },
      { id: "p", parentId: "q" },
      { id: "q", parentId: "p" },
      { id: "self", parentId: "self" },
    ];
    const p = layoutForest(n, opts);
    expect(p.size).toBe(4);
    expect(p.get("x")!.y).toBe(0);
    expect(overlaps(p)).toBe(false);
  });

  it("separates roots by rootGap", () => {
    const p = layoutForest([{ id: "a", parentId: null }, { id: "b", parentId: null }], opts);
    expect(p.get("b")!.x - p.get("a")!.x).toBe(W + opts.rootGap);
  });

  it("uses per-row heights for mixed node sizes", () => {
    const p = layoutForest([{ id: "h", parentId: null, height: 120 }, { id: "c", parentId: "h" }], opts);
    expect(p.get("c")!.y).toBe(120 + opts.gapY);
  });
});
