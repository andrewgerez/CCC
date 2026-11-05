import type { Edge, Node } from "@xyflow/react";
import type { AccountId, AgentNode, SessionSummary } from "../../lib/contract";
import { isActiveAgent, isActiveSession } from "../../lib/utils";
import { layoutForest, type LayoutNode } from "./layout";
import { sessionMascot, type Activity, type MascotState } from "./ClaudeMascot";

export type { Activity };
export type SessionCardData = { kind: "session"; session: SessionSummary; subagents: number; activity: Activity | null };
export type AgentCardData = { kind: "agent"; agent: AgentNode; account: AccountId; activity: Activity | null };

/** A working Claude is typing, unless it is waiting on one of its subagents. */
export function activityOf(working: boolean, childActive: boolean): Activity | null {
  if (!working) return null;
  if (childActive) return "waiting";
  return "typing";
}
export type CardData = SessionCardData | AgentCardData;

export const CARD = {
  session: { w: 290, h: 150 },
  agent: { w: 224, h: 92 },
};

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
}

/** Left-to-right forest: each session card on the left, its subagents to the right.
 *  The orchestrator agent *is* the session, so it never gets its own card; its
 *  children hang off the session card. Deeper subagents keep their real parent. */
export function buildCanvas(
  account: AccountId,
  sessions: Record<string, SessionSummary>,
  agents: Record<string, Record<string, AgentNode>>,
  now = Date.now(),
): BuiltCanvas {
  const layout: LayoutNode[] = [];
  const nodes: Node<CardData>[] = [];
  const edges: Edge[] = [];
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
    const activeChild = (pid: string | null) => subs.some((c) => parentOf(c) === pid && isActiveAgent(c.status));
    const sessionActivity = activityOf(sessionMascot(s.status) === "run", activeChild(null));
    push(sid, null, CARD.session);
    nodes.push({ id: sid, type: "session", position: { x: 0, y: 0 }, data: { kind: "session", session: s, subagents: subs.length, activity: sessionActivity } });
    for (const a of subs) {
      const id = `a:${s.id}:${a.id}`;
      const pid = parentOf(a);
      const parent = pid ? `a:${s.id}:${pid}` : sid;
      push(id, parent, CARD.agent);
      const activity = activityOf(a.status === "running" || a.status === "tool", activeChild(a.id));
      nodes.push({ id, type: "agent", position: { x: 0, y: 0 }, data: { kind: "agent", agent: a, account: s.account, activity } });
      const live = isActiveAgent(a.status) || (a.status === "unknown" && isActiveSession(s.status));
      edges.push({ id: `e:${parent}->${id}`, source: parent, target: id, type: "default", animated: live });
    }
  }

  const pos = layoutForest(layout, { gapX: 18, gapY: 96, rootGap: 44 });
  for (const n of nodes) {
    const p = pos.get(n.id);
    if (p) n.position = { x: p.y, y: p.x };
  }
  const structureKey = `${account}|${layout.map((n) => `${n.id}<${n.parentId ?? ""}`).join(",")}`;
  return { nodes, edges, structureKey };
}
