import { Handle, Position, type NodeProps } from "@xyflow/react";
import { ChevronLeft, ChevronRight, Layers, X } from "lucide-react";
import { memo, useState, type MouseEvent } from "react";
import { api } from "../../lib/api";
import type { SessionSummary } from "../../lib/contract";
import { AGENT_STATUS_LABEL, SESSION_STATUS_LABEL, cn, errMessage, fmtRelative } from "../../lib/utils";
import { useUi, type PanelTab } from "../../store/ui";
import { CARD, type AgentCardData, type Fold, type GroupCardData, type SessionCardData } from "./build";
import { ACTIVITY_LABEL, ClaudeMascot, agentMascot, sessionMascot } from "./ClaudeMascot";

const DELETABLE: SessionSummary["status"][] = ["archived", "idle", "error", "interrupted", "blocked"];

const handles = (
  <>
    <Handle type="target" position={Position.Left} isConnectable={false} />
    <Handle type="source" position={Position.Right} isConnectable={false} />
  </>
);

function Action({ label, tab, sessionId, primary }: { label: string; tab: PanelTab; sessionId: string; primary?: boolean }) {
  const open = (e: MouseEvent) => {
    e.stopPropagation();
    useUi.getState().openSession(sessionId, tab);
  };
  return (
    <button
      onClick={open}
      className={cn(
        "nodrag rounded-full px-3 py-1.5 text-[12.5px] font-medium transition-colors",
        primary ? "bg-fg text-white hover:bg-[#3a3833]" : "bg-surface-3 text-fg-2 hover:bg-line",
      )}
    >
      {label}
    </button>
  );
}

/** Pill on a card to fold/unfold the agents under it. */
function FoldButton({ fold }: { fold: Fold }) {
  const toggle = (e: MouseEvent) => {
    e.stopPropagation();
    useUi.getState().setExpanded(fold.key, !fold.open);
  };
  return (
    <button
      onClick={toggle}
      title={fold.open ? "Recolher agentes" : "Mostrar agentes"}
      className="nodrag absolute -bottom-3 right-4 z-10 flex h-6 items-center gap-0.5 rounded-full bg-surface pl-1.5 pr-2 text-[11px] font-semibold text-fg-2 shadow-[0_0_0_1px_var(--color-line-2),0_2px_6px_-2px_rgb(40_30_10/0.2)] hover:text-fg"
    >
      {fold.open ? <ChevronLeft className="size-3.5" /> : <ChevronRight className="size-3.5" />}
      {fold.total}
    </button>
  );
}

const COUNT_LABEL: [keyof GroupCardData["counts"], string, string][] = [
  ["need", "precisam de você", "bg-fg"],
  ["error", "com erro", "bg-red"],
  ["run", "trabalhando", "bg-claude"],
  ["idle", "parados", "bg-dim"],
  ["done", "concluídos", "bg-green"],
];

/** Stack standing in for hidden agents; clicking it unfolds them. */
export const GroupCard = memo(function GroupCard({ data }: NodeProps & { data: GroupCardData }) {
  const open = (e: MouseEvent) => {
    e.stopPropagation();
    useUi.getState().setExpanded(data.key, true);
  };
  const parts = COUNT_LABEL.filter(([k]) => data.counts[k] > 0);
  return (
    <div style={{ width: CARD.group.w }} className="relative cursor-pointer" onClick={open}>
      {handles}
      <div aria-hidden className="absolute inset-x-3 -bottom-2 h-full rounded-[15px] bg-surface shadow-[0_0_0_1px_var(--color-line)]" />
      <div aria-hidden className="absolute inset-x-1.5 -bottom-1 h-full rounded-[15px] bg-surface shadow-[0_0_0_1px_var(--color-line)]" />
      <div className="canvas-card relative rounded-[15px] bg-surface px-3 py-2.5">
        <div className="flex items-center gap-2.5">
          <div className="grid size-[34px] shrink-0 place-items-center rounded-[11px] bg-surface-3 text-fg-2"><Layers className="size-4" /></div>
          <div className="min-w-0">
            <div className="text-[13px] font-semibold">{data.total} {data.reason === "finished" ? (data.total === 1 ? "concluído" : "concluídos") : data.total === 1 ? "agente" : "agentes"}</div>
            <div className="text-xs text-muted">{data.reason === "finished" ? "recolhidos" : "recolhidos · clique para abrir"}</div>
          </div>
        </div>
        <div className="mt-2 flex flex-wrap gap-x-2.5 gap-y-1 text-[11.5px] text-fg-2">
          {parts.map(([k, label, dot]) => (
            <span key={k} className="flex items-center gap-1"><span className={cn("size-1.5 rounded-full", dot)} />{data.counts[k]} {label}</span>
          ))}
        </div>
      </div>
    </div>
  );
});

function DeleteButton({ s }: { s: SessionSummary }) {
  const [confirm, setConfirm] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const stop = (e: MouseEvent) => e.stopPropagation();
  if (!DELETABLE.includes(s.status) || s.pid != null) return null;
  return confirm ? (
    <button
      autoFocus
      onClick={(e) => {
        stop(e);
        api.deleteSession(s.account, s.id).then(() => {
          if (useUi.getState().selectedSessionId === s.id) useUi.getState().closePanel();
        }).catch((x) => setErr(errMessage(x)));
      }}
      onBlur={() => setConfirm(false)}
      title={err ?? undefined}
      className="nodrag absolute -right-2 -top-2 z-10 rounded-full bg-red px-2.5 py-1 text-[11.5px] font-semibold text-white shadow"
    >
      {err ? "Erro" : "Apagar?"}
    </button>
  ) : (
    <button
      aria-label="Apagar card"
      title="Apagar do quadro"
      onClick={(e) => { stop(e); setConfirm(true); }}
      className="nodrag absolute -right-2 -top-2 z-10 grid size-6 place-items-center rounded-full bg-surface text-muted opacity-0 shadow-[0_0_0_1px_var(--color-line-2)] transition-opacity hover:text-red group-hover:opacity-100 focus-visible:opacity-100"
    >
      <X className="size-3.5" />
    </button>
  );
}

export const SessionCard = memo(function SessionCard({ data }: NodeProps & { data: SessionCardData }) {
  const s = data.session;
  const state = sessionMascot(s.status);
  const selected = useUi((u) => u.selectedSessionId === s.id && !u.selectedAgentId);
  const line = s.status === "error" || s.status === "blocked"
    ? s.lastError ?? SESSION_STATUS_LABEL[s.status]
    : s.lastActivity ?? SESSION_STATUS_LABEL[s.status];
  return (
    <div
      style={{ width: CARD.session.w, minHeight: 118 }}
      className={cn("canvas-card group relative cursor-pointer rounded-[18px] bg-surface p-3.5", state, selected && "sel", (state === "done" || state === "idle") && "opacity-[.86]")}
    >
      {handles}
      {data.fold && <FoldButton fold={data.fold} />}
      <DeleteButton s={s} />
      <div className="flex items-center gap-3">
        <ClaudeMascot state={state} activity={data.activity} />
        <div className="min-w-0">
          <div className="line-clamp-2 text-[14px] font-semibold leading-tight">{s.title}</div>
          <div className="truncate text-xs text-muted">
            {s.repoName}
            {data.subagents > 0 && <span> · {data.subagents} {data.subagents === 1 ? "agente" : "agentes"}</span>}
            {s.model && <span> · {s.model}</span>}
            <span> · {s.permissionMode === "auto" ? "auto" : "pergunta"}</span>
          </div>
        </div>
      </div>
      <div className="mt-3 flex items-center gap-2 text-[12.5px] text-fg-2">
        <span className={cn("truncate font-mono text-[12px]", state === "error" && "text-red")}>
          {data.activity === "waiting" ? "esperando subagentes…" : line}
        </span>
        <span className="ml-auto shrink-0 text-[11.5px] text-dim">{fmtRelative(s.updatedAt)}</span>
      </div>
      {state === "need" && (
        <div className="mt-3 flex gap-1.5">
          {s.pendingApprovals > 0 || s.status === "awaiting_approval" ? (
            <Action label={s.pendingApprovals > 1 ? `Revisar ${s.pendingApprovals} pedidos` : "Revisar pedido"} tab="approvals" sessionId={s.id} primary />
          ) : (
            <Action label="Responder" tab="chat" sessionId={s.id} primary />
          )}
          <Action label="Abrir" tab="chat" sessionId={s.id} />
        </div>
      )}
      {state === "error" && (
        <div className="mt-3 flex gap-1.5"><Action label="Ver o que houve" tab="logs" sessionId={s.id} primary /></div>
      )}
      {state === "run" && <div className="canvas-progress mt-3"><i /></div>}
    </div>
  );
});

export const AgentCard = memo(function AgentCard({ data }: NodeProps & { data: AgentCardData }) {
  const a = data.agent;
  const state = agentMascot(a.status);
  const selected = useUi((u) => u.selectedSessionId === a.sessionId && u.selectedAgentId === a.id);
  const line = a.currentTool ?? a.activity ?? a.description ?? AGENT_STATUS_LABEL[a.status];
  const label = data.activity ? ACTIVITY_LABEL[data.activity] : AGENT_STATUS_LABEL[a.status].toLowerCase();
  return (
    <div
      style={{ width: CARD.agent.w, minHeight: 80 }}
      className={cn("canvas-card relative cursor-pointer rounded-[15px] bg-surface px-3 py-2.5", state, selected && "sel", state === "done" && "opacity-[.86]")}
    >
      {handles}
      <div className="flex items-center gap-2.5">
        <ClaudeMascot state={state} activity={data.activity} size="sm" />
        <div className="min-w-0">
          <div className="truncate text-[13px] font-semibold">{a.name}</div>
          <div className="truncate text-xs text-muted">{label}</div>
        </div>
      </div>
      <div className="mt-2 truncate font-mono text-[12px] text-fg-2">{line}</div>
      {data.fold && <FoldButton fold={data.fold} />}
    </div>
  );
});

export const cardTypes = { session: SessionCard, agent: AgentCard, fold: GroupCard };
