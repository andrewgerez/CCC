import type {
  AccountId, AgentNode, Approval, AuthStatus, ChatItem, MetricsSnapshot, SessionSummary, UiEvent,
} from "../lib/contract";

export const CHAT_CAP = 2000;
export const NOTICE_CAP = 200;
export const AUTH_LOG_CAP = 300;

export interface Notice {
  id: number;
  level: "info" | "warn" | "error";
  text: string;
  account: AccountId | null;
  sessionId: string | null;
  ts: number;
}

export interface DataState {
  sessions: Record<string, SessionSummary>;
  /** sessionId -> agentId -> node */
  agents: Record<string, Record<string, AgentNode>>;
  /** sessionId -> ordered chat ring buffer (ascending seq) */
  chat: Record<string, ChatItem[]>;
  /** sessionId -> true when older items exist beyond the ring buffer */
  chatTruncated: Record<string, boolean>;
  /** sessionId -> messageId -> streamed text (cleared when final assistant_text arrives) */
  deltas: Record<string, Record<string, { text: string; agentId: string | null }>>;
  /** requestId -> pending approval */
  approvals: Record<string, Approval>;
  auth: Partial<Record<AccountId, AuthStatus>>;
  authLog: Record<AccountId, string[]>;
  metrics: MetricsSnapshot | null;
  notices: Notice[];
  noticeSeq: number;
}

export const initialData = (): DataState => ({
  sessions: {},
  agents: {},
  chat: {},
  chatTruncated: {},
  deltas: {},
  approvals: {},
  auth: {},
  authLog: { personal: [], work: [] },
  metrics: null,
  notices: [],
  noticeSeq: 0,
});

/** Inserts items into an ascending-by-seq array, de-duplicating by seq. Returns a new array. */
export function mergeChat(existing: ChatItem[], incoming: ChatItem[]): ChatItem[] {
  if (incoming.length === 0) return existing;
  const last = existing.length ? existing[existing.length - 1].seq : -Infinity;
  // Fast path: strictly appending.
  if (incoming.every((i, idx) => i.seq > last && (idx === 0 || i.seq > incoming[idx - 1].seq))) {
    return existing.concat(incoming);
  }
  const map = new Map<number, ChatItem>();
  for (const i of existing) map.set(i.seq, i);
  for (const i of incoming) map.set(i.seq, i);
  return Array.from(map.values()).sort((a, b) => a.seq - b.seq);
}

/** Applies a batch of UI events immutably. Only touched slices get new references,
 *  so selectors on unrelated sessions keep identity (no re-render). */
export function applyBatch(state: DataState, events: UiEvent[]): Partial<DataState> {
  if (events.length === 0) return {};
  const out: Partial<DataState> = {};
  const touched = new Set<string>();
  const copyTop = <K extends keyof DataState>(k: K): DataState[K] => {
    if (!touched.has(k)) {
      touched.add(k);
      const v = state[k];
      (out as Record<string, unknown>)[k] = Array.isArray(v) ? [...v] : { ...(v as object) };
    }
    return out[k] as DataState[K];
  };
  const innerTouched = new Set<string>();
  const copyInner = <T extends object>(k: "agents" | "deltas", sid: string): T => {
    const top = copyTop(k) as Record<string, T>;
    const key = `${k}:${sid}`;
    if (!innerTouched.has(key)) {
      innerTouched.add(key);
      top[sid] = { ...(top[sid] ?? ({} as T)) };
    }
    return top[sid];
  };
  const pendingChat = new Map<string, ChatItem[]>();
  let noticeSeq = state.noticeSeq;

  for (const ev of events) {
    switch (ev.type) {
      case "sessionUpsert": {
        copyTop("sessions")[ev.session.id] = ev.session;
        break;
      }
      case "sessionRemoved": {
        const sid = ev.sessionId;
        for (const k of ["sessions", "agents", "chat", "chatTruncated", "deltas"] as const) {
          const cur = (touched.has(k) ? out[k] : state[k]) as Record<string, unknown> | undefined;
          if (cur && sid in cur) {
            delete (copyTop(k) as Record<string, unknown>)[sid];
            innerTouched.delete(`${k}:${sid}`);
          }
        }
        pendingChat.delete(sid);
        const appr = touched.has("approvals") ? out.approvals! : state.approvals;
        for (const [rid, a] of Object.entries(appr)) if (a.sessionId === sid) delete copyTop("approvals")[rid];
        break;
      }
      case "agentUpsert": {
        const m = copyInner<Record<string, AgentNode>>("agents", ev.agent.sessionId);
        m[ev.agent.id] = ev.agent;
        break;
      }
      case "delta": {
        const m = copyInner<Record<string, { text: string; agentId: string | null }>>("deltas", ev.sessionId);
        const prev = m[ev.messageId];
        m[ev.messageId] = { text: (prev?.text ?? "") + ev.text, agentId: ev.agentId };
        break;
      }
      case "chat": {
        const sid = ev.item.sessionId;
        const arr = pendingChat.get(sid) ?? [];
        arr.push(ev.item);
        pendingChat.set(sid, arr);
        const b = ev.item.body;
        if (b.kind === "assistant_text") {
          const cur = (touched.has("deltas") ? out.deltas : state.deltas)?.[sid];
          if (cur && b.messageId in cur) {
            const m = copyInner<Record<string, { text: string; agentId: string | null }>>("deltas", sid);
            delete m[b.messageId];
          }
        } else if (b.kind === "turn_result") {
          const cur = (touched.has("deltas") ? out.deltas : state.deltas)?.[sid];
          if (cur && Object.keys(cur).length) {
            const top = copyTop("deltas");
            delete top[sid];
            innerTouched.delete(`deltas:${sid}`);
          }
        }
        break;
      }
      case "approval": {
        copyTop("approvals")[ev.approval.requestId] = ev.approval;
        break;
      }
      case "approvalResolved": {
        const cur = touched.has("approvals") ? out.approvals! : state.approvals;
        if (ev.requestId in cur) delete copyTop("approvals")[ev.requestId];
        break;
      }
      case "auth": {
        copyTop("auth")[ev.status.account] = ev.status;
        break;
      }
      case "authLog": {
        const logs = copyTop("authLog");
        const next = [...(logs[ev.account] ?? []), ev.line];
        logs[ev.account] = next.length > AUTH_LOG_CAP ? next.slice(-AUTH_LOG_CAP) : next;
        break;
      }
      case "metrics": {
        out.metrics = ev.snapshot;
        break;
      }
      case "notice": {
        const n = copyTop("notices");
        noticeSeq += 1;
        n.push({ id: noticeSeq, level: ev.level, text: ev.text, account: ev.account, sessionId: ev.sessionId, ts: Date.now() });
        if (n.length > NOTICE_CAP) n.splice(0, n.length - NOTICE_CAP);
        out.noticeSeq = noticeSeq;
        break;
      }
    }
  }

  if (pendingChat.size) {
    const chat = copyTop("chat");
    for (const [sid, items] of pendingChat) {
      let merged = mergeChat(chat[sid] ?? [], items);
      if (merged.length > CHAT_CAP) {
        merged = merged.slice(merged.length - CHAT_CAP);
        copyTop("chatTruncated")[sid] = true;
      }
      chat[sid] = merged;
    }
  }
  return out;
}

/** Prepends an older page (from api.getChat) without exceeding the cap from the top. */
export function prependHistory(state: DataState, sessionId: string, items: ChatItem[], hasMore: boolean): Partial<DataState> {
  const merged = mergeChat(state.chat[sessionId] ?? [], items);
  return {
    chat: { ...state.chat, [sessionId]: merged },
    chatTruncated: { ...state.chatTruncated, [sessionId]: hasMore },
  };
}
