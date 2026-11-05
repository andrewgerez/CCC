import "@xyflow/react/dist/style.css";
import { Background, BackgroundVariant, ReactFlow, ReactFlowProvider, useReactFlow, type Node } from "@xyflow/react";
import { ChevronsLeft, Lock, Maximize2, Minus, Plug, Plus, Search, Settings } from "lucide-react";
import phone from "../../assets/claudes/phone.gif";
import { useEffect, useMemo, useRef } from "react";
import { useShallow } from "zustand/react/shallow";
import type { AccountId } from "../../lib/contract";
import { ACCOUNT_LABEL, cn } from "../../lib/utils";
import { useData } from "../../store/data";
import { useUi } from "../../store/ui";
import { NotificationBell } from "../shell/NotificationBell";
import { buildCanvas, pickSessions, type CardData } from "./build";
import { cardTypes } from "./cards";
import { ClaudeGym } from "./ClaudeGym";
import { ClaudeMascot, sessionMascot } from "./ClaudeMascot";

const ACCOUNTS: AccountId[] = ["work", "personal"];
const DOT: Record<AccountId, string> = { work: "bg-work", personal: "bg-personal" };
const ON: Record<AccountId, string> = { work: "bg-work text-white", personal: "bg-personal text-white" };
const float = "glass shrink-0 whitespace-nowrap rounded-full";

export function useCanvasAccount(): AccountId {
  return useUi((s) => (s.scope === "global" ? "work" : s.scope));
}

function AccountSwitch({ account }: { account: AccountId }) {
  const setScope = useUi((s) => s.setScope);
  const sessions = useData((s) => s.sessions);
  const auth = useData((s) => s.auth);
  const counts = useMemo(() => {
    const c: Record<AccountId, number> = { work: 0, personal: 0 };
    for (const s of Object.values(sessions)) if (sessionMascot(s.status) === "need") c[s.account]++;
    return c;
  }, [sessions]);
  return (
    <div role="group" aria-label="Conta" className={cn(float, "flex items-center gap-0.5 p-1")}>
      {ACCOUNTS.map((a) => {
        const on = a === account;
        const locked = auth[a] && auth[a]?.state !== "verified";
        return (
          <button
            key={a}
            aria-pressed={on}
            onClick={() => setScope(a)}
            className={cn("flex h-9 items-center gap-2 rounded-full px-4 text-[13.5px] font-medium transition-colors", on ? ON[a] : "text-muted hover:text-fg-2")}
          >
            {locked ? <Lock className="size-3.5" /> : <span className={cn("size-2 rounded-full", on ? "bg-white" : DOT[a], !on && "opacity-60")} />}
            {ACCOUNT_LABEL[a]}
            {counts[a] > 0 && (
              <span className={cn("grid h-[18px] min-w-[18px] place-items-center rounded-full px-1.5 text-[11px] font-bold", on ? "bg-white/25" : "bg-claude text-white")}>
                {counts[a]}
              </span>
            )}
          </button>
        );
      })}
      <kbd className="px-2 font-mono text-[11px] text-dim">Tab</kbd>
    </div>
  );
}

function AccountLine({ account }: { account: AccountId }) {
  const view = useData((s) => s.overview?.accounts.find((a) => a.config.id === account));
  const auth = useData((s) => s.auth[account]);
  const setLogin = useUi((s) => s.setLogin);
  const verified = auth?.state === "verified";
  return (
    <div className="flex items-center gap-1.5 text-xs text-muted">
      {view?.config.workspaceRoot && <span className="font-mono">{view.config.workspaceRoot.replace(/^\/home\/[^/]+/, "~")}</span>}
      {view?.config.behaviorDir && (
        <>
          <span>·</span>
          <span title={view.config.behaviorDir}>comportamento: <span className="font-mono">{view.config.behaviorDir.split("/").filter(Boolean).pop()}</span></span>
        </>
      )}
      <span>·</span>
      {verified ? (
        <span>{auth?.email ?? "verificada"}</span>
      ) : (
        <button onClick={() => setLogin(account)} className="font-medium text-cyan underline-offset-2 hover:underline">
          {auth?.state === "mismatch" ? "identidade errada — entrar de novo" : "não autenticada — entrar"}
        </button>
      )}
    </div>
  );
}

function Summary({ account }: { account: AccountId }) {
  const sessions = useData((s) => s.sessions);
  const { need, run } = useMemo(() => {
    const mine = Object.values(sessions).filter((s) => s.account === account);
    return {
      need: mine.filter((s) => sessionMascot(s.status) === "need").length,
      run: mine.filter((s) => sessionMascot(s.status) === "run").length,
    };
  }, [sessions, account]);
  return (
    <div className={cn(float, "flex h-11 items-center gap-3.5 px-4 text-[13px] text-fg-2")}>
      <span className="flex items-center gap-1.5"><span className="size-2 rounded-full bg-claude" />{need} esperando</span>
      <span className="flex items-center gap-1.5"><span className="size-2 rounded-full bg-claude/50" />{run} trabalhando</span>
    </div>
  );
}

function ZoomControls({ foldKeys }: { foldKeys: string[] }) {
  const rf = useReactFlow();
  const collapseAll = useUi((s) => s.collapseAll);
  const btn = "grid size-8 place-items-center rounded-full text-fg-2 hover:bg-surface-3";
  return (
    <div className={cn(float, "absolute bottom-4 right-4 z-10 flex items-center gap-0.5 p-1")}>
      <button className={btn} aria-label="Afastar" onClick={() => void rf.zoomOut({ duration: 200 })}><Minus className="size-4" /></button>
      <button className={btn} aria-label="Aproximar" onClick={() => void rf.zoomIn({ duration: 200 })}><Plus className="size-4" /></button>
      <button className={btn} aria-label="Enquadrar" onClick={() => void rf.fitView({ padding: 0.15, duration: 250, maxZoom: 1 })}><Maximize2 className="size-3.5" /></button>
      {foldKeys.length > 0 && (
        <button className="flex h-8 items-center gap-1.5 whitespace-nowrap rounded-full px-3 text-[12.5px] font-medium text-fg-2 hover:bg-surface-3" title="Recolher os agentes de todas as sessões" onClick={() => collapseAll(foldKeys)}>
          <ChevronsLeft className="size-4" />Recolher tudo
        </button>
      )}
    </div>
  );
}

function EmptyState({ account }: { account: AccountId }) {
  const auth = useData((s) => s.auth[account]);
  const { setLogin, openComposer } = useUi(useShallow((s) => ({ setLogin: s.setLogin, openComposer: s.openComposer })));
  const verified = auth?.state === "verified";
  return (
    <div className="absolute inset-0 grid place-items-center">
      <div className="flex max-w-sm flex-col items-center text-center">
        {verified ? (
          <div className="grid size-40 place-items-center rounded-[32px] bg-[#fbefe7] shadow-[0_12px_30px_-16px_rgb(40_30_10/0.3)]">
            <ClaudeGym className="w-32" />
          </div>
        ) : (
          <ClaudeMascot state="idle" size="lg" className="shadow-[0_12px_30px_-16px_rgb(40_30_10/0.3)]" />
        )}
        <h2 className="mt-5 text-lg font-semibold">
          {verified ? "Nenhum Claude trabalhando aqui" : `${ACCOUNT_LABEL[account]} ainda não está conectada`}
        </h2>
        <p className="mt-1.5 text-[13px] text-muted">
          {verified ? "Comece uma tarefa e ela aparece como um card neste quadro." : "Entre com a conta certa para liberar as sessões desta área."}
        </p>
        <button
          onClick={() => (verified ? openComposer(account) : setLogin(account))}
          className="mt-5 rounded-full bg-fg px-5 py-2.5 text-[13.5px] font-medium text-white hover:bg-[#3a3833]"
        >
          {verified ? "Nova tarefa" : "Entrar"}
        </button>
      </div>
    </div>
  );
}

function Inner() {
  const account = useCanvasAccount();
  const { sessions, agents } = useData(useShallow((s) => ({ sessions: s.sessions, agents: s.agents })));
  const { openSession, openComposer, setPalette, setView, setScope, selectedSessionId } = useUi(
    useShallow((s) => ({
      openSession: s.openSession, openComposer: s.openComposer, setPalette: s.setPalette, setView: s.setView,
      setScope: s.setScope, selectedSessionId: s.selectedSessionId,
    })),
  );
  const narrow = useUi((s) => s.selectedSessionId !== null
  );
  const loadDetail = useData((s) => s.loadDetail);

  // Opening a session from the bell/palette jumps to that session's account.
  useEffect(() => {
    const s = selectedSessionId ? sessions[selectedSessionId] : null;
    if (s && s.account !== account) setScope(s.account);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selectedSessionId]);

  // Subagent cards need agent details; hydrate visible live sessions once (loadDetail dedupes).
  useEffect(() => {
    for (const s of pickSessions(Object.values(sessions), account)) {
      if (s.status !== "archived" && !agents[s.id]) void loadDetail(s).catch(() => undefined);
    }
  }, [account, sessions, agents, loadDetail]);

  const expanded = useUi((s) => s.expanded);
  const graph = useMemo(() => buildCanvas(account, sessions, agents, Date.now(), expanded), [account, sessions, agents, expanded]);

  const rf = useReactFlow();
  const lastKey = useRef("");
  useEffect(() => {
    if (graph.structureKey === lastKey.current) return;
    lastKey.current = graph.structureKey;
    const t = requestAnimationFrame(() => void rf.fitView({ padding: 0.15, duration: 250, maxZoom: 1 }));
    return () => cancelAnimationFrame(t);
  }, [graph.structureKey, rf]);

  const onNodeClick = (_: unknown, n: Node<CardData>) => {
    const d = n.data;
    if (d.kind === "session") openSession(d.session.id, "chat");
    else if (d.kind === "agent") openSession(d.agent.sessionId, "agents", d.agent.id);
    else useUi.getState().setExpanded(d.key, true);
  };

  return (
    <div className="canvas-root relative h-full w-full" data-acct={account}>
      <div className="pointer-events-none absolute inset-x-0 top-0 z-10 flex items-start justify-between gap-3 p-4">
        <div className={cn(float, "pointer-events-auto flex h-[68px] items-center gap-2 pl-1.5 pr-2")}>
          <div className="size-14 shrink-0 overflow-hidden rounded-full bg-[#fbefe7]">
            <img src={phone} alt="ccc" className="size-full object-contain mix-blend-multiply" style={{ transform: "translate(0, -2.8%) scale(1.3)" }} draggable={false} />
          </div>
          {!narrow && <span className="mr-1 text-[17px] font-bold tracking-tight">ccc</span>}
          <button onClick={() => openComposer(account)} className="rounded-full bg-claude px-5 py-3 text-[15px] font-semibold text-white hover:brightness-95" aria-label="Nova tarefa (N)">
            + Tarefa
          </button>
        </div>
        <div className="pointer-events-auto flex flex-col items-center gap-2">
          <AccountSwitch account={account} />
          <AccountLine account={account} />
        </div>
        <div className="pointer-events-auto flex items-center gap-2">
          {!narrow && <Summary account={account} />}
          <div className={cn(float, "flex h-11 items-center gap-0.5 px-1.5")}>
            <button aria-label="Buscar (Ctrl K)" onClick={() => setPalette(true)} className="grid size-8 place-items-center rounded-full text-fg-2 hover:bg-surface-3"><Search className="size-4" /></button>
            <NotificationBell />
            <button aria-label="Conexões MCP" title="Conexões MCP" onClick={() => setView("mcp")} className="grid size-8 place-items-center rounded-full text-fg-2 hover:bg-surface-3"><Plug className="size-4" /></button>
            <button aria-label="Configurações" onClick={() => setView("settings")} className="grid size-8 place-items-center rounded-full text-fg-2 hover:bg-surface-3"><Settings className="size-4" /></button>
          </div>
        </div>
      </div>

      {graph.nodes.length === 0 ? (
        <>
          <div className="grid-bg absolute inset-0" />
          <EmptyState account={account} />
        </>
      ) : (
        <ReactFlow
          key={account}
          nodes={graph.nodes}
          edges={graph.edges}
          nodeTypes={cardTypes}
          onNodeClick={onNodeClick}
          nodesDraggable={false}
          nodesConnectable={false}
          elementsSelectable={false}
          onlyRenderVisibleElements
          minZoom={0.25}
          maxZoom={1.6}
          proOptions={{ hideAttribution: true }}
          fitView
          fitViewOptions={{ padding: 0.15, maxZoom: 1 }}
          className="enter"
        >
          <Background variant={BackgroundVariant.Dots} gap={22} size={1.2} color={account === "personal" ? "#cdd6c8" : "#d6d1c5"} />
          <ZoomControls foldKeys={graph.foldKeys} />
        </ReactFlow>
      )}
    </div>
  );
}

export default function AgentCanvas() {
  return (
    <ReactFlowProvider>
      <Inner />
    </ReactFlowProvider>
  );
}
