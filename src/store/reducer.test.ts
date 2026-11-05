import { describe, expect, it } from "vitest";
import type { Approval, ChatItem, SessionSummary, UiEvent } from "../lib/contract";
import { applyBatch, CHAT_CAP, initialData, prependHistory, type DataState } from "./reducer";

const apply = (s: DataState, ev: UiEvent[]) => ({ ...s, ...applyBatch(s, ev) });
const chat = (seq: number, sessionId = "A", body: ChatItem["body"] = { kind: "user_text", text: `m${seq}` }): UiEvent => ({
  type: "chat", account: "personal", item: { seq, sessionId, ts: seq, agentId: null, body },
});
const session = (id: string): SessionSummary => ({
  id, account: "personal", repoPath: "/r", repoName: "r", worktreePath: null, title: id, status: "running", model: null,
  permissionMode: "default", priority: 0, createdAt: 0, updatedAt: 0, lastActivity: null, totalCostUsd: 0, inputTokens: 0,
  outputTokens: 0, turns: 0, pendingApprovals: 0, lastError: null, pid: null, resumable: true,
});

describe("applyBatch", () => {
  it("merges deltas per message and clears them on final assistant_text", () => {
    let s = initialData();
    s = apply(s, [
      { type: "delta", account: "personal", sessionId: "A", agentId: null, messageId: "m1", text: "Hel" },
      { type: "delta", account: "personal", sessionId: "A", agentId: null, messageId: "m1", text: "lo" },
      { type: "delta", account: "personal", sessionId: "A", agentId: null, messageId: "m2", text: "x" },
    ]);
    expect(s.deltas.A.m1.text).toBe("Hello");
    s = apply(s, [chat(1, "A", { kind: "assistant_text", messageId: "m1", text: "Hello" })]);
    expect(s.deltas.A.m1).toBeUndefined();
    expect(s.deltas.A.m2.text).toBe("x");
    s = apply(s, [chat(2, "A", { kind: "turn_result", costUsd: 0, durationMs: 0, inputTokens: 0, outputTokens: 0, cacheRead: 0, cacheWrite: 0, isError: false, numTurns: 1, subtype: "success" })]);
    expect(s.deltas.A).toBeUndefined();
  });

  it("keeps references of untouched sessions stable (no cross-session re-render)", () => {
    let s = initialData();
    s = apply(s, [
      { type: "sessionUpsert", session: session("A") },
      { type: "sessionUpsert", session: session("B") },
      { type: "delta", account: "personal", sessionId: "B", agentId: null, messageId: "b1", text: "b" },
      chat(1, "B"),
    ]);
    const bDeltas = s.deltas.B;
    const bChat = s.chat.B;
    const sessions = s.sessions;
    const next = apply(s, [{ type: "delta", account: "personal", sessionId: "A", agentId: null, messageId: "a1", text: "a" }]);
    expect(next.deltas.B).toBe(bDeltas);
    expect(next.chat.B).toBe(bChat);
    expect(next.sessions).toBe(sessions);
    expect(next.chat).toBe(s.chat);
  });

  it("caps the chat ring buffer and marks truncation", () => {
    let s = initialData();
    const evs: UiEvent[] = [];
    for (let i = 1; i <= CHAT_CAP + 50; i++) evs.push(chat(i));
    s = apply(s, evs);
    expect(s.chat.A.length).toBe(CHAT_CAP);
    expect(s.chat.A[0].seq).toBe(51);
    expect(s.chatTruncated.A).toBe(true);
  });

  it("dedupes and orders chat items, and prepends history", () => {
    let s = initialData();
    s = apply(s, [chat(5), chat(6)]);
    s = apply(s, [chat(6), chat(7)]);
    expect(s.chat.A.map((c) => c.seq)).toEqual([5, 6, 7]);
    s = { ...s, ...prependHistory(s, "A", [chat(3).type === "chat" ? (chat(3) as Extract<UiEvent, { type: "chat" }>).item : (null as never)], false) };
    expect(s.chat.A.map((c) => c.seq)).toEqual([3, 5, 6, 7]);
  });

  it("adds and resolves approvals", () => {
    const ap: Approval = { requestId: "r1", sessionId: "A", account: "work", agentId: null, toolName: "Bash", toolUseId: null, input: {}, description: null, suggestions: [], createdAt: 0 };
    let s = apply(initialData(), [{ type: "approval", approval: ap }]);
    expect(s.approvals.r1).toBeDefined();
    const before = s.approvals;
    s = apply(s, [{ type: "approvalResolved", account: "work", sessionId: "A", requestId: "nope", decision: "allow" }]);
    expect(s.approvals).toBe(before);
    s = apply(s, [{ type: "approvalResolved", account: "work", sessionId: "A", requestId: "r1", decision: "allow" }]);
    expect(s.approvals.r1).toBeUndefined();
  });

  it("caps auth logs and notices", () => {
    const evs: UiEvent[] = [];
    for (let i = 0; i < 400; i++) evs.push({ type: "authLog", account: "work", line: `l${i}` });
    for (let i = 0; i < 250; i++) evs.push({ type: "notice", level: "info", text: `n${i}`, account: null, sessionId: null });
    const s = apply(initialData(), evs);
    expect(s.authLog.work.length).toBe(300);
    expect(s.authLog.work.at(-1)).toBe("l399");
    expect(s.notices.length).toBe(200);
    expect(s.authLog.personal).toEqual([]);
  });
});

describe("sessionRemoved", () => {
  it("drops the session with its chat, agents and pending approvals, leaving others alone", () => {
    const appr = (requestId: string, sessionId: string): Approval => ({
      requestId, sessionId, account: "personal", agentId: null, toolName: "Bash", toolUseId: null, input: {}, description: null, suggestions: null, createdAt: 0,
    });
    let s = initialData();
    s = apply(s, [
      { type: "sessionUpsert", session: session("A") },
      { type: "sessionUpsert", session: session("B") },
      chat(1, "A"),
      chat(2, "B"),
      { type: "approval", approval: appr("r1", "A") },
      { type: "approval", approval: appr("r2", "B") },
    ]);
    s = apply(s, [{ type: "sessionRemoved", account: "personal", sessionId: "A" }]);
    expect(Object.keys(s.sessions)).toEqual(["B"]);
    expect(s.chat.A).toBeUndefined();
    expect(s.chat.B).toHaveLength(1);
    expect(Object.keys(s.approvals)).toEqual(["r2"]);
  });
});
