import { Bot, FileDiff, RefreshCw, ScrollText, Wrench } from "lucide-react";
import { lazy, Suspense, useCallback, useEffect, useMemo, useState } from "react";
import { Badge } from "../../components/ui/badge";
import { Button } from "../../components/ui/button";
import { Empty, StatusDot } from "../../components/ui/status";
import { api } from "../../lib/api";
import type { ChatItem, RepoStatus, SessionSummary } from "../../lib/contract";
import { AGENT_STATUS_LABEL, agentTone, cn, errMessage, fmtDuration, fmtTime, fmtTokens, isActiveAgent, truncate } from "../../lib/utils";
import { useData } from "../../store/data";
import { useUi } from "../../store/ui";

const DiffView = lazy(() => import("./DiffView"));
const EMPTY: ChatItem[] = [];

function useNow(active: boolean, ms = 1000) {
  const [now, setNow] = useState(Date.now());
  useEffect(() => {
    if (!active) return;
    const t = setInterval(() => { if (!document.hidden) setNow(Date.now()); }, ms);
    return () => clearInterval(t);
  }, [active, ms]);
  return now;
}

export function AgentsTab({ session }: { session: SessionSummary }) {
  const agents = useData((s) => s.agents[session.id]);
  const chat = useData((s) => s.chat[session.id] ?? EMPTY);
  const selected = useUi((s) => s.selectedAgentId);
  const openSession = useUi((s) => s.openSession);
  const list = useMemo(() => Object.values(agents ?? {}).sort((a, b) => a.startedAt - b.startedAt), [agents]);
  const anyActive = list.some((a) => isActiveAgent(a.status));
  const now = useNow(anyActive);
  const sel = list.find((a) => a.id === selected) ?? null;
  const selItems = useMemo(() => (sel ? chat.filter((c) => c.agentId === sel.id).slice(-30) : []), [chat, sel]);
  if (!list.length) return <Empty icon={<Bot />} title="Nenhum agente observado" hint="O orquestrador e os subagentes aparecem a partir dos eventos SubagentStart/task_started do Claude Code." />;
  return (
    <div className="flex h-full min-h-0 flex-col">
      <div className="min-h-0 flex-1 overflow-auto p-3">
        <table className="w-full text-left text-[12px]">
          <thead className="text-[10.5px] text-muted">
            <tr><th className="px-2 py-1.5 font-medium">Agente</th><th className="px-2 font-medium">Estado</th><th className="px-2 text-right font-medium">Tempo</th><th className="px-2 text-right font-medium">Ferr.</th><th className="px-2 text-right font-medium">Tokens</th></tr>
          </thead>
          <tbody>
            {list.map((a) => {
              const depth = a.parentId ? (list.find((p) => p.id === a.parentId)?.parentId ? 2 : 1) : 0;
              return (
                <tr
                  key={a.id}
                  onClick={() => openSession(session.id, "agents", a.id)}
                  className={cn("cursor-default border-t border-line hover:bg-surface-2", selected === a.id && "bg-surface-3")}
                >
                  <td className="px-2 py-2">
                    <div className="flex items-center gap-2" style={{ paddingLeft: depth * 14 }}>
                      {depth > 0 && <span className="text-dim">└</span>}
                      <span className="font-medium">{a.name}</span>
                      {a.kind === "orchestrator" && <Badge tone="cyan">orquestrador</Badge>}
                    </div>
                    {a.description && <div className="truncate text-[11px] text-muted" style={{ paddingLeft: depth * 14 + (depth ? 16 : 0) }}>{truncate(a.description, 60)}</div>}
                  </td>
                  <td className="px-2">
                    <span className="inline-flex items-center gap-1.5">
                      <StatusDot tone={agentTone(a.status)} active={isActiveAgent(a.status)} />
                      <span className={a.status === "unknown" ? "italic text-muted" : ""}>{AGENT_STATUS_LABEL[a.status]}</span>
                    </span>
                    {a.currentTool && <div className="font-mono text-[10.5px] text-blue">{a.currentTool}</div>}
                  </td>
                  <td className="px-2 text-right font-mono text-[11px] text-fg-2">{fmtDuration((a.endedAt ?? now) - a.startedAt)}</td>
                  <td className="px-2 text-right font-mono text-[11px]">{a.toolUses}</td>
                  <td className="px-2 text-right font-mono text-[11px]">{fmtTokens(a.tokens)}</td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
      {sel && (
        <div className="max-h-[45%] min-h-0 overflow-auto border-t border-line bg-bg-2 p-3">
          <div className="mb-2 flex items-center gap-2 text-xs">
            <span className="font-semibold">{sel.name}</span>
            <span className="font-mono text-[10.5px] text-muted">{sel.id}</span>
            {sel.activity && <span className="truncate text-muted">· {sel.activity}</span>}
          </div>
          {selItems.length === 0 ? <div className="text-[11.5px] text-muted">Sem eventos atribuídos a este agente.</div> : (
            <ul className="space-y-1 font-mono text-[11px]">
              {selItems.map((c) => <li key={c.seq} className="truncate text-fg-2"><span className="text-dim">{fmtTime(c.ts)} </span>{describe(c)}</li>)}
            </ul>
          )}
        </div>
      )}
    </div>
  );
}

function describe(c: ChatItem): string {
  const b = c.body;
  switch (b.kind) {
    case "tool_use": return `→ ${b.name} ${b.input.replace(/\s+/g, " ")}`;
    case "tool_result": return `${b.isError ? "✗" : "✓"} ${b.content.replace(/\s+/g, " ")}`;
    case "assistant_text": return `“${b.text.replace(/\s+/g, " ")}”`;
    case "approval": return `? ${b.toolName} ${b.summary}`;
    default: return b.kind;
  }
}

export function ToolsTab({ session }: { session: SessionSummary }) {
  const chat = useData((s) => s.chat[session.id] ?? EMPTY);
  const agents = useData((s) => s.agents[session.id]);
  const rows = useMemo(() => {
    const results = new Map<string, ChatItem>();
    for (const c of chat) if (c.body.kind === "tool_result") results.set(c.body.toolUseId, c);
    return chat.filter((c) => c.body.kind === "tool_use").map((c) => ({ use: c, result: c.body.kind === "tool_use" ? results.get(c.body.toolUseId) : undefined })).reverse();
  }, [chat]);
  if (!rows.length) return <Empty icon={<Wrench />} title="Nenhuma ferramenta usada ainda" />;
  return (
    <div className="h-full overflow-auto p-3">
      <ol className="relative space-y-1 border-l border-line pl-4">
        {rows.map(({ use, result }) => {
          if (use.body.kind !== "tool_use") return null;
          const err = result?.body.kind === "tool_result" && result.body.isError;
          const pending = !result;
          return (
            <li key={use.seq} className="relative">
              <span className={cn("absolute -left-[21px] top-2 size-2 rounded-full ring-4 ring-bg-2", pending ? "bg-blue pulse-ring text-blue" : err ? "bg-red" : "bg-green")} />
              <div className="flex items-center gap-2 rounded-lg px-2 py-1.5 hover:bg-surface-2">
                <span className="font-mono text-[11.5px] font-semibold">{use.body.name}</span>
                <span className="min-w-0 flex-1 truncate font-mono text-[11px] text-muted">{use.body.input.replace(/\s+/g, " ")}</span>
                {use.agentId && agents?.[use.agentId] && agents[use.agentId].kind !== "orchestrator" && <Badge tone="neutral">{agents[use.agentId].name}</Badge>}
                <span className="font-mono text-[10.5px] text-dim">{fmtTime(use.ts)}</span>
                {result && <span className="font-mono text-[10.5px] text-muted">{fmtDuration(result.ts - use.ts)}</span>}
                <Badge tone={pending ? "blue" : err ? "red" : "green"}>{pending ? "executando" : err ? "erro" : "ok"}</Badge>
              </div>
            </li>
          );
        })}
      </ol>
    </div>
  );
}

const STATUS_LABEL: Record<string, string> = { M: "modificado", A: "adicionado", D: "removido", R: "renomeado", "?": "novo", U: "conflito", C: "copiado" };

export function FilesTab({ session }: { session: SessionSummary }) {
  const repo = session.worktreePath ?? session.repoPath;
  return <RepoChanges account={session.account} repo={repo} />;
}

export function RepoChanges({ account, repo }: { account: SessionSummary["account"]; repo: string }) {
  const [status, setStatus] = useState<RepoStatus | null>(null);
  const [file, setFile] = useState<string | null>(null);
  const [diff, setDiff] = useState<string | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const load = useCallback(async () => {
    setLoading(true); setErr(null);
    try { setStatus(await api.repoStatus(account, repo)); } catch (e) { setErr(errMessage(e)); } finally { setLoading(false); }
  }, [account, repo]);
  useEffect(() => { setFile(null); setDiff(null); void load(); }, [load]);
  useEffect(() => {
    setDiff(null);
    api.repoDiff(account, repo, file).then(setDiff).catch((e) => setErr(errMessage(e)));
  }, [account, repo, file, status]);
  return (
    <div className="flex h-full min-h-0 flex-col">
      <div className="flex items-center gap-2 border-b border-line px-3 py-2 text-xs">
        <FileDiff className="size-3.5 text-muted" />
        <span className="font-mono text-fg-2">{status?.branch ?? "…"}</span>
        {status?.upstream && <span className="text-muted">→ {status.upstream}</span>}
        {status && (status.ahead > 0 || status.behind > 0) && <span className="font-mono text-muted">↑{status.ahead} ↓{status.behind}</span>}
        <span className="ml-auto text-muted">{status?.files.length ?? 0} arquivos</span>
        <Button size="icon-sm" variant="ghost" aria-label="Atualizar" onClick={() => void load()}><RefreshCw className={loading ? "animate-spin" : ""} /></Button>
      </div>
      {err && <div role="alert" className="border-b border-red/30 bg-red/10 px-3 py-1.5 text-[11.5px] text-red">{err}</div>}
      <div className="max-h-[38%] shrink-0 overflow-auto border-b border-line py-1">
        <button onClick={() => setFile(null)} className={cn("flex w-full items-center gap-2 px-3 py-1 text-left text-[12px] hover:bg-surface-2", file === null && "bg-surface-3")}>
          <span className="text-fg-2">Todas as alterações</span>
        </button>
        {status?.files.map((f) => {
          const code = (f.index.trim() || f.worktree.trim() || "?")[0];
          return (
            <button key={f.path} onClick={() => setFile(f.path)} className={cn("flex w-full items-center gap-2 px-3 py-1 text-left hover:bg-surface-2", file === f.path && "bg-surface-3")}>
              <span className={cn("w-4 font-mono text-[11px] font-bold", code === "A" || code === "?" ? "text-green" : code === "D" ? "text-red" : code === "U" ? "text-amber" : "text-blue")} title={STATUS_LABEL[code]}>{code}</span>
              <span className="min-w-0 flex-1 truncate font-mono text-[11.5px]">{f.path}</span>
            </button>
          );
        })}
        {status && status.files.length === 0 && <div className="px-3 py-2 text-[11.5px] text-muted">Árvore de trabalho limpa.</div>}
      </div>
      <Suspense fallback={<div className="p-4 text-xs text-muted">Carregando diff…</div>}>
        {diff === null ? <div className="p-4 text-xs text-muted">Carregando diff…</div> : <DiffView diff={diff} className="flex-1" />}
      </Suspense>
    </div>
  );
}

export function LogsTab({ session }: { session: SessionSummary }) {
  const chat = useData((s) => s.chat[session.id] ?? EMPTY);
  const notices = useData((s) => s.notices);
  const rows = useMemo(() => {
    const out: { ts: number; level: string; text: string; key: string }[] = [];
    for (const c of chat) if (c.body.kind === "system") out.push({ ts: c.ts, level: c.body.level, text: c.body.text, key: `c${c.seq}` });
    for (const n of notices) if (n.sessionId === session.id) out.push({ ts: n.ts, level: n.level, text: n.text, key: `n${n.id}` });
    return out.sort((a, b) => a.ts - b.ts);
  }, [chat, notices, session.id]);
  if (!rows.length) return <Empty icon={<ScrollText />} title="Sem logs para esta sessão" />;
  return (
    <div className="selectable h-full overflow-auto bg-surface-3 p-3 font-mono text-[11px] leading-relaxed">
      {rows.map((r) => (
        <div key={r.key} className="flex gap-2">
          <span className="text-dim">{fmtTime(r.ts)}</span>
          <span className={cn("w-11 shrink-0 uppercase", r.level === "error" ? "text-red" : r.level === "warn" ? "text-amber" : "text-blue")}>{r.level}</span>
          <span className="text-fg-2">{r.text}</span>
        </div>
      ))}
    </div>
  );
}
