import type { Edge, Node } from "@xyflow/react";
import type { AccountId, AgentNode, SessionSummary } from "../../lib/contract";
import { isActiveAgent, isActiveSession } from "../../lib/utils";
import { layoutForest, type LayoutNode } from "./layout";
import { agentMascot, sessionMascot, type Activity, type MascotState } from "./ClaudeMascot";

export type { Activity };

/** How many agents per state are hidden behind a collapsed group. */
export type StateCounts = Record<MascotState, number>;

/** Collapse toggle shown on a card that has agents under it. */
export interface Fold {
  key: string;
  open: boolean;
  /** Agents under this card (all depths). */
  total: number;
}

export type SessionCardData = { kind: "session"; session: SessionSummary; subagents: number; activity: Activity | null; fold: Fold | null };
export type AgentCardData = { kind: "agent"; agent: AgentNode; account: AccountId; activity: Activity | null; fold: Fold | null };
/** Stand-in for hidden agents: a whole collapsed subtree, or the finished siblings of one parent. */
export type GroupCardData = { kind: "group"; key: string; reason: "collapsed" | "finished"; total: number; counts: StateCounts };
export type CardData = SessionCardData | AgentCardData | GroupCardData;

/** A working Claude is typing, unless it is waiting on one of its subagents. */
export function activityOf(working: boolean, childActive: boolean): Activity | null {
  if (!working) return null;
  if (childActive) return "waiting";
  return "typing";
}

export const CARD = {
  session: { w: 290, h: 150 },
  agent: { w: 224, h: 92 },
  group: { w: 224, h: 96 },
};

/** Defaults: a session opens collapsed above this many agents, an agent above this many descendants,
 *  and more than this many finished siblings fold into one card. */
export const FOLD = { session: 6, agent: 4, finished: 2 };

const DONE_WINDOW_MS = 24 * 60 * 60 * 1000;
const MAX_LIVE = 40;
const MAX_DONE = 8;

const ORDER: Record<MascotState, number> = { need: 0, error: 1, run: 2, idle: 3, done: 4 };

/** Which sessions of one account deserve a card: everything not archived, plus
 *  sessions archived in the last 24h (capped), ordered by "needs you" first. */
export function pickSessions(sessions: SessionSummary[], account: AccountId, now = Date.now()): SessionSummary[] {
  const mine = sessions.filter((s) => s.account === account);
  const rank = (s: SessionSummary) => ORDER[sessionMascot(s.status)];
  const sort = (a: SessionSummary, b: SessionSummary) => rank(a) - rank(b) || b.updatedAt - a.updatedAt;
  const live = mine.filter((s) => s.status !== "archived").sort(sort).slice(0, MAX_LIVE);
  const done = mine
    .filter((s) => s.status === "archived" && now - s.updatedAt < DONE_WINDOW_MS)
    .sort(sort)
    .slice(0, MAX_DONE);
  return [...live, ...done];
}

export interface BuiltCanvas {
  nodes: Node<CardData>[];
  edges: Edge[];
  structureKey: string;
  /** Every fold key with agents under it, for "collapse all". */
  foldKeys: string[];
}

const emptyCounts = (): StateCounts => ({ run: 0, need: 0, done: 0, idle: 0, error: 0 });

/** Left-to-right forest: each session card on the left, its subagents to the right.
 *  The orchestrator agent *is* the session, so it never gets its own card; its
 *  children hang off the session card. Deeper subagents keep their real parent.
 *  `expanded` overrides the default fold state per key (see FOLD). */
export function buildCanvas(
  account: AccountId,
  sessions: Record<string, SessionSummary>,
  agents: Record<string, Record<string, AgentNode>>,
  now = Date.now(),
  expanded: Record<string, boolean> = {},
): BuiltCanvas {
  const layout: LayoutNode[] = [];
  const nodes: Node<CardData>[] = [];
  const edges: Edge[] = [];
  const foldKeys: string[] = [];
  const isOpen = (key: string, byDefault: boolean) => expanded[key] ?? byDefault;
  // layoutForest is top-down; feed it swapped dimensions and swap the result back.
  const push = (id: string, parentId: string | null, size: { w: number; h: number }) =>
    layout.push({ id, parentId, width: size.h, height: size.w });

  for (const s of pickSessions(Object.values(sessions), account, now)) {
    const sid = `s:${s.id}`;
    const map = agents[s.id] ?? {};
    const subs = Object.values(map)
      .filter((a) => a.kind !== "orchestrator")
      .sort((a, b) => a.startedAt - b.startedAt);
    const parentOf = (a: AgentNode) => {
      const p = a.parentId ? map[a.parentId] : undefined;
      return p && p.kind !== "orchestrator" && a.parentId !== a.id ? p.id : null;
    };
    const kids = new Map<string | null, AgentNode[]>();
    for (const a of subs) {
      const p = parentOf(a);
      kids.set(p, [...(kids.get(p) ?? []), a]);
    }
    const descendants = (id: string | null, seen = new Set<string>()): AgentNode[] =>
      (kids.get(id) ?? []).flatMap((c) => (seen.has(c.id) ? [] : (seen.add(c.id), [c, ...descendants(c.id, seen)])));
    const anyActive = (list: AgentNode[]) => list.some((a) => isActiveAgent(a.status));
    const countStates = (list: AgentNode[]) => {
      const c = emptyCounts();
      for (const a of list) c[agentMascot(a.status)]++;
      return c;
    };
    const liveEdge = (a: AgentNode) => isActiveAgent(a.status) || (a.status === "unknown" && isActiveSession(s.status));
    const link = (parent: string, child: string, animated: boolean) =>
      edges.push({ id: `e:${parent}->${child}`, source: parent, target: child, type: "default", animated });
    const group = (parent: string, key: string, reason: GroupCardData["reason"], list: AgentNode[]) => {
      const id = `g:${key}`;
      push(id, parent, CARD.group);
      nodes.push({ id, type: "fold", position: { x: 0, y: 0 }, data: { kind: "group", key, reason, total: list.length, counts: countStates(list) } });
      link(parent, id, anyActive(list));
    };

    /** Places the children of `agentId` (null = the session) under node `parent`. */
    const place = (parent: string, agentId: string | null) => {
      const children = kids.get(agentId) ?? [];
      const finished = children.filter((a) => a.status === "done" && !anyActive(descendants(a.id)));
      const doneKey = `done:${parent}`;
      const foldDone = finished.length > FOLD.finished && !isOpen(doneKey, false);
      for (const a of children) {
        if (foldDone && finished.includes(a)) continue;
        const id = `a:${s.id}:${a.id}`;
        const below = descendants(a.id);
        const fold: Fold | null = below.length ? { key: id, open: isOpen(id, below.length <= FOLD.agent), total: below.length } : null;
        if (fold) foldKeys.push(id);
        push(id, parent, CARD.agent);
        const activity = activityOf(a.status === "running" || a.status === "tool", anyActive(kids.get(a.id) ?? []));
        nodes.push({ id, type: "agent", position: { x: 0, y: 0 }, data: { kind: "agent", agent: a, account: s.account, activity, fold } });
        link(parent, id, liveEdge(a));
        if (fold?.open) place(id, a.id);
        else if (fold) group(id, id, "collapsed", below);
      }
      if (foldDone) group(parent, doneKey, "finished", finished.flatMap((a) => [a, ...descendants(a.id)]));
    };

    const sessionFold: Fold | null = subs.length ? { key: sid, open: isOpen(sid, subs.length <= FOLD.session), total: subs.length } : null;
    if (sessionFold) foldKeys.push(sid);
    push(sid, null, CARD.session);
    const sessionActivity = activityOf(sessionMascot(s.status) === "run", anyActive(kids.get(null) ?? []));
    nodes.push({ id: sid, type: "session", position: { x: 0, y: 0 }, data: { kind: "session", session: s, subagents: subs.length, activity: sessionActivity, fold: sessionFold } });
    if (sessionFold?.open) place(sid, null);
    else if (sessionFold) group(sid, sid, "collapsed", subs);
  }

  const pos = layoutForest(layout, { gapX: 18, gapY: 96, rootGap: 44 });
  for (const n of nodes) {
    const p = pos.get(n.id);
    if (p) n.position = { x: p.y, y: p.x };
  }
  const structureKey = `${account}|${layout.map((n) => `${n.id}<${n.parentId ?? ""}`).join(",")}`;
  return { nodes, edges, structureKey, foldKeys };
}
