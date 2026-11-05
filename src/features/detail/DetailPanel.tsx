import { Archive, Bot, Check, Copy, FileDiff, MessageSquare, Pause, ScrollText, ShieldQuestion, Square, Trash2, Wrench, X } from "lucide-react";
import { useEffect, useMemo, useState } from "react";
import { Badge } from "../../components/ui/badge";
import { Button } from "../../components/ui/button";
import { StatusDot } from "../../components/ui/status";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "../../components/ui/tabs";
import { Tip } from "../../components/ui/tooltip";
import { api } from "../../lib/api";
import type { SessionSummary } from "../../lib/contract";
import { ACCOUNT_LABEL, cn, errMessage, fmtBytes, fmtCost, fmtDuration, fmtRelative, fmtTokens, isActiveSession, sessionTone, SESSION_STATUS_LABEL } from "../../lib/utils";
import { useData } from "../../store/data";
import { PANEL_ZOOM, useUi, type PanelTab } from "../../store/ui";
import { ModeToggle } from "../shell/ModeToggle";
import { ModelPicker } from "../shell/ModelPicker";
import { ApprovalsTab } from "./Approvals";
import { ChatTab } from "./ChatTab";
import { AgentsTab, FilesTab, LogsTab, ToolsTab } from "./Tabs";

export function DetailPanel() {
  const id = useUi((s) => s.selectedSessionId)!;
  const session = useData((s) => s.sessions[id]);
  const loadDetail = useData((s) => s.loadDetail);
  const [err, setErr] = useState<string | null>(null);
  useEffect(() => {
    if (session) loadDetail(session).catch((e) => setErr(errMessage(e)));
  }, [id, session?.account]); // eslint-disable-line react-hooks/exhaustive-deps
  if (!session) return <div className="p-6 text-xs text-muted">Sessão não encontrada.</div>;
  return (
    <aside aria-label="Detalhes da sessão" className="flex h-full min-h-0 flex-col enter">
      <PanelHeader session={session} />
      {err && <div role="alert" className="border-b border-red/30 bg-red/10 px-4 py-1.5 text-[11.5px] text-red">{err}</div>}
      <PanelTabs session={session} />
    </aside>
  );
}

function PanelTabs({ session }: { session: SessionSummary }) {
  const tab = useUi((s) => s.panelTab);
  const setTab = useUi((s) => s.setPanelTab);
  const approvals = useData((s) => s.approvals);
  const pending = useMemo(() => Object.values(approvals).filter((a) => a.sessionId === session.id).length, [approvals, session.id]);
  const agentCount = useData((s) => Object.keys(s.agents[session.id] ?? {}).length);
  return (
    <Tabs value={tab} onValueChange={(v) => setTab(v as PanelTab)} className="flex min-h-0 flex-1 flex-col">
      <TabsList>
        <TabsTrigger value="chat"><MessageSquare className="size-3.5" />Chat</TabsTrigger>
        <TabsTrigger value="agents"><Bot className="size-3.5" />Agentes{agentCount > 0 && <span className="text-muted">{agentCount}</span>}</TabsTrigger>
        <TabsTrigger value="tools"><Wrench className="size-3.5" />Ferramentas</TabsTrigger>
        <TabsTrigger value="files"><FileDiff className="size-3.5" />Arquivos</TabsTrigger>
        <TabsTrigger value="logs"><ScrollText className="size-3.5" />Logs</TabsTrigger>
        <TabsTrigger value="approvals" className={pending ? "text-amber" : ""}>
          <ShieldQuestion className="size-3.5" />Aprovações
          {pending > 0 && <span className="grid h-4 min-w-4 place-items-center rounded-full bg-amber px-1 text-[10px] font-bold text-white">{pending}</span>}
        </TabsTrigger>
      </TabsList>
      <TabsContent value="chat" className="flex flex-col">{tab === "chat" && <ChatTab session={session} />}</TabsContent>
      <TabsContent value="agents">{tab === "agents" && <AgentsTab session={session} />}</TabsContent>
      <TabsContent value="tools">{tab === "tools" && <ToolsTab session={session} />}</TabsContent>
      <TabsContent value="files">{tab === "files" && <FilesTab session={session} />}</TabsContent>
      <TabsContent value="logs">{tab === "logs" && <LogsTab session={session} />}</TabsContent>
      <TabsContent value="approvals" className="overflow-auto">{tab === "approvals" && <ApprovalsTab sessionId={session.id} />}</TabsContent>
    </Tabs>
  );
}

function PanelHeader({ session: s }: { session: SessionSummary }) {
  const close = useUi((st) => st.closePanel);
  const proc = useData((st) => st.metrics?.sessions.find((p) => p.sessionId === s.id)?.stat);
  const [copied, setCopied] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const tone = sessionTone(s.status);
  const act = (fn: () => Promise<unknown>) => fn().catch((e) => setErr(errMessage(e)));
  const copy = () => { void navigator.clipboard?.writeText(s.id).then(() => { setCopied(true); setTimeout(() => setCopied(false), 1200); }); };
  const live = s.pid != null;
  const [confirmDel, setConfirmDel] = useState(false);
  const deletable = !live && ["archived", "idle", "error", "interrupted", "blocked"].includes(s.status);
  return (
    <div className="border-b border-line bg-surface/60 px-4 pb-3 pt-3.5">
      <div className="flex items-start gap-2">
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-2">
            <StatusDot tone={tone} active={isActiveSession(s.status)} />
            <h2 className="truncate text-[14px] font-semibold tracking-tight">{s.title}</h2>
          </div>
          <div className="mt-1 flex flex-wrap items-center gap-x-2 gap-y-1 text-[11.5px] text-muted">
            <span className={s.account === "work" ? "text-work" : "text-personal"}>{ACCOUNT_LABEL[s.account]}</span>
            <span className="text-dim">/</span>
            <span className="text-fg-2">{s.repoName}</span>
            {s.worktreePath && <Badge tone="violet">worktree</Badge>}
            <Badge tone={tone === "unknown" ? "unknown" : tone === "slate" ? "slate" : tone}>{SESSION_STATUS_LABEL[s.status]}</Badge>
          </div>
        </div>
        <div className="flex items-center gap-1">
          {isActiveSession(s.status) && (
            <Tip content="Interromper turno atual"><Button size="icon" variant="ghost" aria-label="Interromper" onClick={() => act(() => api.interruptSession(s.account, s.id))}><Pause /></Button></Tip>
          )}
          {live && <Tip content="Encerrar processo (sessão fica retomável)"><Button size="icon" variant="ghost" aria-label="Encerrar" onClick={() => act(() => api.stopSession(s.account, s.id))}><Square /></Button></Tip>}
          {deletable && (confirmDel ? (
            <Button size="sm" variant="danger" onClick={() => act(() => api.deleteSession(s.account, s.id).then(close))} onBlur={() => setConfirmDel(false)} autoFocus>Apagar de vez?</Button>
          ) : (
            <Tip content="Apagar do quadro (histórico desta sessão some do app)"><Button size="icon" variant="ghost" aria-label="Apagar sessão" onClick={() => setConfirmDel(true)}><Trash2 /></Button></Tip>
          ))}
          {s.status !== "archived" && !live && <Tip content="Marcar como concluída"><Button size="icon" variant="ghost" aria-label="Concluir" onClick={() => act(() => api.archiveSession(s.account, s.id))}><Archive /></Button></Tip>}
          <TextSize />
          <Tip content="Fechar · Esc"><Button size="icon" variant="ghost" aria-label="Fechar painel" onClick={close}><X /></Button></Tip>
        </div>
      </div>
      <div className="mt-3 flex flex-wrap items-center gap-2 text-[12px] text-muted">
        <span>Modelo</span>
        <ModelPicker value={s.model} onChange={(m) => act(() => api.setSessionModel(s.account, s.id, m || null))} />
      </div>
      <div className="mt-2 flex items-center gap-2 text-[12px] text-muted">
        <span>Permissões</span>
        <ModeToggle value={s.permissionMode} onChange={(m) => act(() => api.setPermissionMode(s.account, s.id, m))} />
        {s.permissionMode !== "auto" && s.permissionMode !== "default" && <span className="text-dim">({s.permissionMode})</span>}
      </div>
      <dl className="mt-3 grid grid-cols-4 gap-2 text-[11px]">
        <Stat label="Custo" value={fmtCost(s.totalCostUsd)} />
        <Stat label="Tokens" value={`${fmtTokens(s.inputTokens)} / ${fmtTokens(s.outputTokens)}`} />
        <Stat label="Duração" value={fmtDuration(s.updatedAt - s.createdAt)} />
        <Stat label={proc ? `PID ${proc.pid}` : "Processo"} value={proc ? `${fmtBytes(proc.rssBytes)} · ${proc.cpuPercent.toFixed(0)}%` : s.pid ? `PID ${s.pid}` : "nenhum"} />
      </dl>
      <div className="mt-2 flex items-center gap-2 text-[10.5px] text-muted">
        <button onClick={copy} className="inline-flex items-center gap-1 font-mono hover:text-fg-2" aria-label="Copiar ID da sessão">
          {copied ? <Check className="size-3 text-green" /> : <Copy className="size-3" />}{s.id}
        </button>
        <span className="text-dim">·</span>
        <span>{fmtRelative(s.updatedAt)}</span>
      </div>
      {s.worktreePath && <div className="mt-1 truncate font-mono text-[10.5px] text-muted">{s.worktreePath}</div>}
      {(s.lastError || err) && <div role="alert" className="mt-2 rounded-md border border-red/30 bg-red/10 px-2 py-1 text-[11px] text-red">{err ?? s.lastError}</div>}
    </div>
  );
}

function TextSize() {
  const zoom = useUi((s) => s.panelZoom);
  const setZoom = useUi((s) => s.setPanelZoom);
  const btn = "grid h-7 min-w-7 place-items-center rounded-full px-1.5 text-[12px] font-semibold text-fg-2 hover:bg-surface-3 disabled:opacity-35";
  return (
    <div className="mr-1 flex items-center rounded-full bg-surface-3/60" role="group" aria-label="Tamanho do texto">
      <button className={btn} aria-label="Diminuir texto" disabled={zoom <= PANEL_ZOOM.min} onClick={() => setZoom(zoom - PANEL_ZOOM.step)}>A−</button>
      <span className="w-9 text-center font-mono text-[10.5px] text-muted">{Math.round(zoom * 100)}%</span>
      <button className={btn} aria-label="Aumentar texto" disabled={zoom >= PANEL_ZOOM.max} onClick={() => setZoom(zoom + PANEL_ZOOM.step)}>A+</button>
    </div>
  );
}

function Stat({ label, value }: { label: string; value: string }) {
  return (
    <div className="rounded-lg border border-line bg-bg-2 px-2 py-1.5">
      <dt className="truncate text-[10px] text-muted">{label}</dt>
      <dd className={cn("truncate font-mono text-[11.5px] text-fg")}>{value}</dd>
    </div>
  );
}
