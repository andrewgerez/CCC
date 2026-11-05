import { describe, expect, it } from "vitest";
import type { AgentNode, SessionSummary } from "../../lib/contract";
import { activityOf, buildCanvas, pickSessions } from "./build";

const NOW = 1_800_000_000_000;
function session(id: string, over: Partial<SessionSummary> = {}): SessionSummary {
  return {
    id, account: "work", repoPath: "/r", repoName: "r", worktreePath: null, title: id, status: "running", model: null,
    permissionMode: "default", priority: 0, createdAt: NOW, updatedAt: NOW, lastActivity: null, totalCostUsd: 0,
    inputTokens: 0, outputTokens: 0, turns: 0, pendingApprovals: 0, lastError: null, pid: null, resumable: false, ...over,
  };
}
function agent(id: string, sessionId: string, over: Partial<AgentNode> = {}): AgentNode {
  return {
    id, sessionId, parentId: null, kind: "subagent", name: id, description: null, status: "running", currentTool: null,
    activity: null, startedAt: NOW, endedAt: null, toolUses: 0, tokens: null, toolUseId: null, ...over,
  };
}

describe("pickSessions", () => {
  it("keeps one account, puts sessions that need you first, drops old archived ones", () => {
    const list = [
      session("run", { updatedAt: NOW }),
      session("need", { status: "awaiting_approval", updatedAt: NOW - 1000 }),
      session("other", { account: "personal" }),
      session("old", { status: "archived", updatedAt: NOW - 2 * 86_400_000 }),
      session("recent", { status: "archived", updatedAt: NOW - 1000 }),
    ];
    expect(pickSessions(list, "work", NOW).map((s) => s.id)).toEqual(["need", "run", "recent"]);
  });
});

describe("buildCanvas", () => {
  it("hangs subagents off the session card, skips the orchestrator, lays out left to right", () => {
    const sessions = { s1: session("s1") };
    const agents = {
      s1: {
        o: agent("o", "s1", { kind: "orchestrator" }),
        a: agent("a", "s1", { parentId: "o" }),
        b: agent("b", "s1", { parentId: "a", status: "done" }),
      },
    };
    const g = buildCanvas("work", sessions, agents, NOW);
    expect(g.nodes.map((n) => n.id)).toEqual(["s:s1", "a:s1:a", "a:s1:b"]);
    expect(g.edges.map((e) => [e.source, e.target, e.animated])).toEqual([
      ["s:s1", "a:s1:a", true],
      ["a:s1:a", "a:s1:b", false],
    ]);
    const x = Object.fromEntries(g.nodes.map((n) => [n.id, n.position.x]));
    expect(x["s:s1"]).toBeLessThan(x["a:s1:a"]);
    expect(x["a:s1:a"]).toBeLessThan(x["a:s1:b"]);
  });
});

describe("activity gifs", () => {
  it("is typing while working, waiting while a subagent works, nothing otherwise", () => {
    expect(activityOf(false, true)).toBeNull();
    expect(activityOf(true, true)).toBe("waiting");
    expect(activityOf(true, false)).toBe("typing");
  });

  it("marks a running session waiting while a subagent works; an agent using a tool still types", () => {
    const sessions = { s1: session("s1") };
    const agents = { s1: { o: agent("o", "s1", { kind: "orchestrator", status: "running" }), a: agent("a", "s1", { parentId: "o", status: "tool" }) } };
    const g = buildCanvas("work", sessions, agents, NOW);
    const d = Object.fromEntries(g.nodes.map((n) => [n.id, n.data.activity]));
    expect(d).toEqual({ "s:s1": "waiting", "a:s1:a": "typing" });
  });
});

describe("folding big agent trees", () => {
  const many = (n: number, over: (i: number) => Partial<AgentNode> = () => ({})) => {
    const m: Record<string, AgentNode> = { o: agent("o", "s1", { kind: "orchestrator" }) };
    for (let i = 0; i < n; i++) m[`a${i}`] = agent(`a${i}`, "s1", { parentId: "o", startedAt: NOW + i, ...over(i) });
    return { s1: m };
  };
  const sessions = { s1: session("s1") };

  it("collapses a session with many agents into one group card, and unfolds on demand", () => {
    const agents = many(30, (i) => ({ status: i < 5 ? "running" : "done" }));
    const g = buildCanvas("work", sessions, agents, NOW);
    expect(g.nodes.map((n) => n.type)).toEqual(["session", "fold"]);
    const grp = g.nodes[1].data as { total: number; counts: Record<string, number> };
    expect(grp.total).toBe(30);
    expect(grp.counts).toMatchObject({ run: 5, done: 25 });
    expect(g.foldKeys).toEqual(["s:s1"]);

    const open = buildCanvas("work", sessions, agents, NOW, { "s:s1": true });
    // 5 running stay visible, 25 finished fold into one card
    expect(open.nodes.filter((n) => n.type === "agent")).toHaveLength(5);
    const done = open.nodes.find((n) => n.type === "fold")!.data as { reason: string; total: number };
    expect(done).toMatchObject({ reason: "finished", total: 25 });

    const all = buildCanvas("work", sessions, agents, NOW, { "s:s1": true, "done:s:s1": true });
    expect(all.nodes.filter((n) => n.type === "agent")).toHaveLength(30);
  });

  it("keeps small trees open and folds deep subtrees of a single agent", () => {
    const m: Record<string, AgentNode> = { o: agent("o", "s1", { kind: "orchestrator" }), p: agent("p", "s1", { parentId: "o" }) };
    for (let i = 0; i < 5; i++) m[`c${i}`] = agent(`c${i}`, "s1", { parentId: "p", status: "running" });
    const g = buildCanvas("work", sessions, { s1: m }, NOW);
    expect(g.nodes.map((n) => n.id)).toEqual(["s:s1", "a:s1:p", "g:a:s1:p"]);
    const opened = buildCanvas("work", sessions, { s1: m }, NOW, { "a:s1:p": true });
    expect(opened.nodes.filter((n) => n.type === "agent")).toHaveLength(6);
  });
});
