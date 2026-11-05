import { create } from "zustand";
import { api } from "../lib/api";
import type { AgentNode, Approval, ChatItem, Overview, SessionSummary, UiEvent } from "../lib/contract";
import { listenEvents } from "../lib/ipc";
import { ACCOUNT_LABEL } from "../lib/utils";
import { applyBatch, initialData, prependHistory, type DataState } from "./reducer";

interface DataStore extends DataState {
  overview: Overview | null;
  bootError: string | null;
  setOverview: (o: Overview) => void;
  ingest: (events: UiEvent[]) => void;
  setSessions: (s: SessionSummary[]) => void;
  loadDetail: (s: SessionSummary) => Promise<void>;
  loadOlder: (s: SessionSummary) => Promise<number>;
}

export const PAGE = 200;
const detailLoaded = new Set<string>();

export const useData = create<DataStore>()((set, get) => ({
  ...initialData(),
  overview: null,
  bootError: null,
  setOverview: (overview) => {
    for (const a of overview.accounts) if (a.config.label.trim()) ACCOUNT_LABEL[a.config.id] = a.config.label.trim();
    set({ overview });
  },
  ingest: (events) => set((s) => applyBatch(s, events)),
  setSessions: (list) =>
    set((s) => {
      const sessions = { ...s.sessions };
      for (const x of list) sessions[x.id] = x;
      return { sessions };
    }),
  loadDetail: async (session) => {
    if (detailLoaded.has(session.id)) return;
    detailLoaded.add(session.id);
    try {
      const [detail, chat] = await Promise.all([
        api.getSession(session.account, session.id),
        api.getChat(session.account, session.id, null, PAGE),
      ]);
      set((s) => {
        const agents: Record<string, AgentNode> = { ...(s.agents[session.id] ?? {}) };
        for (const a of detail.agents) if (!agents[a.id]) agents[a.id] = a;
        const approvals: Record<string, Approval> = { ...s.approvals };
        for (const a of detail.approvals) approvals[a.requestId] = a;
        return {
          sessions: { ...s.sessions, [session.id]: s.sessions[session.id] ?? detail.session },
          agents: { ...s.agents, [session.id]: agents },
          approvals,
          ...prependHistory(s, session.id, chat as ChatItem[], chat.length >= PAGE),
        };
      });
    } catch (e) {
      detailLoaded.delete(session.id);
      throw e;
    }
  },
  loadOlder: async (session) => {
    const cur = get().chat[session.id] ?? [];
    const before = cur.length ? cur[0].seq : null;
    const items = await api.getChat(session.account, session.id, before, PAGE);
    set((s) => prependHistory(s, session.id, items, items.length >= PAGE));
    return items.length;
  },
}));

let started = false;
/** Boots the data layer once: subscribe first (no missed events), then hydrate. */
export async function startDataLayer() {
  if (started) return;
  started = true;
  await listenEvents((batch) => useData.getState().ingest(batch));
  try {
    const [overview, sessions, metrics] = await Promise.all([api.getOverview(), api.listSessions(null), api.getMetrics()]);
    const st = useData.getState();
    st.setOverview(overview);
    st.setSessions(sessions);
    const auth = { ...st.auth };
    for (const a of overview.accounts) auth[a.config.id] = a.auth;
    useData.setState({ metrics, auth });
    // Hydrate details (agents + pending approvals) for live sessions so the graph/bell are accurate.
    for (const s of sessions) {
      if (s.pendingApprovals > 0 || ["running", "starting", "awaiting_approval", "waiting_input"].includes(s.status)) {
        void st.loadDetail(s).catch(() => undefined);
      }
    }
  } catch (e) {
    useData.setState({ bootError: e && typeof e === "object" && "message" in e ? String((e as { message: unknown }).message) : String(e) });
  }
}

export async function refreshOverview() {
  const o = await api.getOverview();
  useData.getState().setOverview(o);
  return o;
}
