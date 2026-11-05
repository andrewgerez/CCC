import { lazy, Suspense, useEffect } from "react";
import { useShallow } from "zustand/react/shallow";
import { TooltipProvider } from "./components/ui/tooltip";
import { api } from "./lib/api";
import { startDataLayer, useData } from "./store/data";
import { PANEL_WIDTH, useUi } from "./store/ui";
import { ArrowLeft } from "lucide-react";
import { DetailPanel } from "./features/detail/DetailPanel";
import AgentCanvas from "./features/canvas/AgentCanvas";
import { CommandPalette } from "./features/shell/CommandPalette";
import { LoginDialog } from "./features/shell/LoginDialog";
import { NewSessionDialog } from "./features/shell/NewSessionDialog";
import { ShortcutsHelp, useShortcuts } from "./features/shell/Shortcuts";
import { Toasts } from "./features/shell/Toasts";

const SettingsView = lazy(() => import("./features/settings/SettingsView"));
const McpView = lazy(() => import("./features/mcp/McpView"));

function useVisibility() {
  const setVisible = useUi((s) => s.setVisible);
  useEffect(() => {
    let last: boolean | null = null;
    const update = () => {
      const v = !document.hidden && document.hasFocus();
      if (v === last) return;
      last = v;
      setVisible(v);
      document.documentElement.classList.toggle("paused", !v);
      api.setUiVisible(v).catch(() => undefined);
    };
    update();
    document.addEventListener("visibilitychange", update);
    window.addEventListener("blur", update);
    window.addEventListener("focus", update);
    return () => {
      document.removeEventListener("visibilitychange", update);
      window.removeEventListener("blur", update);
      window.removeEventListener("focus", update);
    };
  }, [setVisible]);
}

/** Right-hand session panel: drag its left edge to resize; text size comes from the panel's A−/A+ (CSS zoom). */
function SidePanel() {
  const { width, zoom, setWidth } = useUi(useShallow((s) => ({ width: s.panelWidth, zoom: s.panelZoom, setWidth: s.setPanelWidth })));
  const max = Math.max(PANEL_WIDTH.min, window.innerWidth - 360);
  const w = Math.min(width, max);
  const startDrag = (e: React.PointerEvent<HTMLDivElement>) => {
    e.preventDefault();
    const el = e.currentTarget;
    el.setPointerCapture(e.pointerId);
    const x0 = e.clientX;
    const w0 = w;
    const move = (ev: PointerEvent) => setWidth(Math.min(max, w0 + (x0 - ev.clientX)));
    const up = () => { el.removeEventListener("pointermove", move); el.removeEventListener("pointerup", up); };
    el.addEventListener("pointermove", move);
    el.addEventListener("pointerup", up);
  };
  return (
    <div className="relative min-h-0 shrink-0 border-l border-line bg-surface" style={{ width: w }}>
      <div
        role="separator"
        aria-orientation="vertical"
        aria-label="Redimensionar painel"
        title="Arraste para redimensionar"
        onPointerDown={startDrag}
        onDoubleClick={() => setWidth(PANEL_WIDTH.def)}
        className="absolute inset-y-0 -left-1.5 z-20 w-3 cursor-col-resize after:absolute after:inset-y-0 after:left-1/2 after:w-px after:bg-transparent hover:after:bg-cyan/60"
      />
      <div className="h-full" style={{ zoom }}>
        <DetailPanel />
      </div>
    </div>
  );
}

function Main() {
  const view = useUi((s) => s.view);
  const setView = useUi((s) => s.setView);
  if (view === "settings" || view === "mcp") {
    return (
      <main className="flex min-h-0 flex-1 flex-col overflow-hidden">
        <div className="flex h-14 shrink-0 items-center gap-3 px-4">
          <button onClick={() => setView("canvas")} className="flex items-center gap-1.5 rounded-full px-3 py-1.5 text-[13px] font-medium text-fg-2 hover:bg-surface-3">
            <ArrowLeft className="size-4" /> Voltar ao quadro
          </button>
          {view === "settings" && <h1 className="text-[15px] font-semibold">Configurações</h1>}
        </div>
        <div className="min-h-0 flex-1 overflow-hidden">
          <Suspense fallback={null}>
            {view === "settings" ? <SettingsView /> : <McpView />}
          </Suspense>
        </div>
      </main>
    );
  }
  return (
    <main className="relative min-h-0 flex-1 overflow-hidden">
      <AgentCanvas />
    </main>
  );
}

export default function App() {
  useVisibility();
  useShortcuts();
  useEffect(() => {
    void startDataLayer();
  }, []);
  const { panelOpen } = useUi(useShallow((s) => ({ panelOpen: s.selectedSessionId !== null })));
  const bootError = useData((s) => s.bootError);
  return (
    <TooltipProvider delayDuration={250}>
      <div className="flex h-full flex-col">
        {bootError && (
          <div role="alert" className="border-b border-red/30 bg-red/10 px-4 py-2 text-xs text-red">
            Falha ao conectar ao backend: {bootError}
          </div>
        )}
        <div className="flex min-h-0 flex-1">
          <Main />
          {panelOpen && <SidePanel />}
        </div>
      </div>
      <CommandPalette />
      <ShortcutsHelp />
      <NewSessionDialog />
      <LoginDialog />
      <Toasts />
    </TooltipProvider>
  );
}
