import { create } from "zustand";
import type { AccountId } from "../lib/contract";

const PANEL_KEY = "ccc.panel";
export const PANEL_WIDTH = { min: 420, def: 620 };
export const PANEL_ZOOM = { min: 0.9, max: 1.6, def: 1.15, step: 0.1 };
function loadPanel(): { width: number; zoom: number } {
  try {
    const v = JSON.parse(localStorage.getItem(PANEL_KEY) ?? "{}");
    return { width: Number(v.width) || PANEL_WIDTH.def, zoom: Number(v.zoom) || PANEL_ZOOM.def };
  } catch {
    return { width: PANEL_WIDTH.def, zoom: PANEL_ZOOM.def };
  }
}
function savePanel(p: { width: number; zoom: number }) {
  try { localStorage.setItem(PANEL_KEY, JSON.stringify(p)); } catch { /* storage unavailable */ }
}

export type Scope = "global" | AccountId;
export type View = "canvas" | "settings" | "mcp";
export type PanelTab = "chat" | "agents" | "tools" | "files" | "logs" | "approvals";

interface UiStore {
  scope: Scope;
  view: View;
  selectedSessionId: string | null;
  selectedAgentId: string | null;
  panelTab: PanelTab;
  selectedRepo: Partial<Record<AccountId, string>>;
  paletteOpen: boolean;
  helpOpen: boolean;
  composer: { open: boolean; account: AccountId | null; repo: string | null; worktree: string | null };
  loginAccount: AccountId | null;
  visible: boolean;
  panelWidth: number;
  panelZoom: number;
  setScope: (s: Scope) => void;
  setView: (v: View) => void;
  openSession: (id: string, tab?: PanelTab, agentId?: string | null) => void;
  closePanel: () => void;
  setPanelTab: (t: PanelTab) => void;
  selectRepo: (a: AccountId, repo: string | null) => void;
  setPalette: (o: boolean) => void;
  setHelp: (o: boolean) => void;
  openComposer: (account?: AccountId | null, repo?: string | null, worktree?: string | null) => void;
  closeComposer: () => void;
  setLogin: (a: AccountId | null) => void;
  setVisible: (v: boolean) => void;
  setPanelWidth: (w: number) => void;
  setPanelZoom: (z: number) => void;
}

export const useUi = create<UiStore>()((set) => ({
  scope: "work",
  view: "canvas",
  selectedSessionId: null,
  selectedAgentId: null,
  panelTab: "chat",
  selectedRepo: {},
  paletteOpen: false,
  helpOpen: false,
  composer: { open: false, account: null, repo: null, worktree: null },
  loginAccount: null,
  visible: true,
  panelWidth: loadPanel().width,
  panelZoom: loadPanel().zoom,
  setScope: (scope) => set({ scope }),
  setView: (view) => set({ view }),
  openSession: (id, tab, agentId = null) =>
    set((s) => ({ selectedSessionId: id, selectedAgentId: agentId, panelTab: tab ?? (s.selectedSessionId === id ? s.panelTab : "chat") })),
  closePanel: () => set({ selectedSessionId: null, selectedAgentId: null }),
  setPanelTab: (panelTab) => set({ panelTab }),
  selectRepo: (a, repo) => set((s) => ({ selectedRepo: { ...s.selectedRepo, [a]: repo ?? undefined } })),
  setPalette: (paletteOpen) => set({ paletteOpen }),
  setHelp: (helpOpen) => set({ helpOpen }),
  openComposer: (account = null, repo = null, worktree = null) => set({ composer: { open: true, account, repo, worktree } }),
  closeComposer: () => set((s) => ({ composer: { ...s.composer, open: false } })),
  setLogin: (loginAccount) => set({ loginAccount }),
  setVisible: (visible) => set({ visible }),
  setPanelWidth: (w) => set((s) => {
    const panelWidth = Math.round(Math.max(PANEL_WIDTH.min, w));
    savePanel({ width: panelWidth, zoom: s.panelZoom });
    return { panelWidth };
  }),
  setPanelZoom: (z) => set((s) => {
    const panelZoom = Math.round(Math.min(PANEL_ZOOM.max, Math.max(PANEL_ZOOM.min, z)) * 100) / 100;
    savePanel({ width: s.panelWidth, zoom: panelZoom });
    return { panelZoom };
  }),
}));
