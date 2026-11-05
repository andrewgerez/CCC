import { useVirtualizer } from "@tanstack/react-virtual";
import { AlertTriangle, ArrowDown, Bot, ChevronRight, CircleCheck, CircleX, Info, Pause, Send, ShieldQuestion, Square, Wrench } from "lucide-react";
import { lazy, memo, Suspense, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { useShallow } from "zustand/react/shallow";
import { Button } from "../../components/ui/button";
import { Textarea } from "../../components/ui/input";
import { api } from "../../lib/api";
import type { ChatItem, SessionSummary } from "../../lib/contract";
import { cn, errMessage, fmtCost, fmtDuration, fmtTime, fmtTokens, truncate } from "../../lib/utils";
import { useData } from "../../store/data";
import { AttachmentStrip, PasteHint, usePastedImages } from "../shell/Attachments";

const Markdown = lazy(() => import("./Markdown"));

type Row =
  | { key: string; kind: "item"; item: ChatItem }
  | { key: string; kind: "stream"; messageId: string }
  | { key: string; kind: "older" };

export function ChatTab({ session }: { session: SessionSummary }) {
  const items = useData((s) => s.chat[session.id]);
  const truncated = useData((s) => s.chatTruncated[session.id]);
  const streamIds = useData(useShallow((s) => Object.keys(s.deltas[session.id] ?? {})));
  const loadOlder = useData((s) => s.loadOlder);
  const rows = useMemo<Row[]>(() => {
    const r: Row[] = [];
    if (truncated) r.push({ key: "older", kind: "older" });
    for (const it of items ?? []) r.push({ key: `i${it.seq}`, kind: "item", item: it });
    for (const m of streamIds) r.push({ key: `d${m}`, kind: "stream", messageId: m });
    return r;
  }, [items, streamIds, truncated]);

  const parentRef = useRef<HTMLDivElement>(null);
  const atBottom = useRef(true);
  const [showJump, setShowJump] = useState(false);
  const v = useVirtualizer({
    count: rows.length,
    getScrollElement: () => parentRef.current,
    estimateSize: () => 72,
    overscan: 6,
    getItemKey: (i) => rows[i].key,
  });

  useLayoutEffect(() => {
    if (atBottom.current && rows.length) v.scrollToIndex(rows.length - 1, { align: "end" });
  }, [rows.length, v]);

  // Streaming text grows the last row; keep pinned to bottom while streaming.
  const streamTick = useData((s) => {
    const d = s.deltas[session.id];
    if (!d) return 0;
    let n = 0;
    for (const k in d) n += d[k].text.length;
    return n;
  });
  useEffect(() => {
    if (atBottom.current && parentRef.current) parentRef.current.scrollTop = parentRef.current.scrollHeight;
  }, [streamTick]);

  const onScroll = () => {
    const el = parentRef.current;
    if (!el) return;
    const near = el.scrollHeight - el.scrollTop - el.clientHeight < 80;
    atBottom.current = near;
    if (near === showJump) setShowJump(!near);
  };

  return (
    <div className="flex h-full min-h-0 flex-col">
      <div ref={parentRef} onScroll={onScroll} className="relative min-h-0 flex-1 overflow-auto px-4" role="log" aria-label="Conversa">
        {rows.length === 0 && <div className="py-16 text-center text-xs text-muted">Sem mensagens ainda.</div>}
        <div style={{ height: v.getTotalSize(), position: "relative" }}>
          {v.getVirtualItems().map((vi) => {
            const row = rows[vi.index];
            return (
              <div key={vi.key} data-index={vi.index} ref={v.measureElement} className="absolute left-0 right-0 py-1.5" style={{ transform: `translateY(${vi.start}px)` }}>
                {row.kind === "older" ? (
                  <div className="flex justify-center py-1">
                    <Button size="xs" variant="ghost" onClick={() => void loadOlder(session)}>Carregar mensagens anteriores</Button>
                  </div>
                ) : row.kind === "stream" ? (
                  <StreamRow sessionId={session.id} messageId={row.messageId} />
                ) : (
                  <ChatRow item={row.item} sessionId={session.id} />
                )}
              </div>
            );
          })}
        </div>
      </div>
      {showJump && (
        <button
          onClick={() => { atBottom.current = true; v.scrollToIndex(rows.length - 1, { align: "end" }); setShowJump(false); }}
          className="mx-auto -mt-10 mb-2 flex items-center gap-1 rounded-full border border-line-2 bg-surface-3 px-3 py-1 text-[11px] text-fg-2 shadow-lg"
        >
          <ArrowDown className="size-3" /> Mais recentes
        </button>
      )}
      <Composer session={session} />
    </div>
  );
}

const AgentTag = memo(function AgentTag({ sessionId, agentId }: { sessionId: string; agentId: string | null }) {
  const a = useData((s) => (agentId ? s.agents[sessionId]?.[agentId] : undefined));
  if (!a || a.kind === "orchestrator") return null;
  return <span className="inline-flex items-center gap-1 rounded bg-surface-3 px-1.5 py-px text-[10.5px] text-fg-2"><Bot className="size-3" />{a.name}</span>;
});

const StreamRow = memo(function StreamRow({ sessionId, messageId }: { sessionId: string; messageId: string }) {
  const d = useData((s) => s.deltas[sessionId]?.[messageId]);
  if (!d) return null;
  return (
    <div className="space-y-1">
      <AgentTag sessionId={sessionId} agentId={d.agentId} />
      <div className="caret selectable whitespace-pre-wrap text-[13px] leading-relaxed text-fg">{d.text}</div>
    </div>
  );
});

function Collapsible({ head, children, defaultOpen = false, tone }: { head: React.ReactNode; children: React.ReactNode; defaultOpen?: boolean; tone?: "error" }) {
  const [open, setOpen] = useState(defaultOpen);
  return (
    <div className={cn("overflow-hidden rounded-lg border bg-surface", tone === "error" ? "border-red/35" : "border-line")}>
      <button aria-expanded={open} onClick={() => setOpen((o) => !o)} className="flex w-full items-center gap-2 px-2.5 py-1.5 text-left text-[11.5px] hover:bg-surface-2">
        <ChevronRight className={cn("size-3 shrink-0 text-muted transition-transform", open && "rotate-90")} />
        {head}
      </button>
      {open && <div className="border-t border-line">{children}</div>}
    </div>
  );
}

const pre = "selectable max-h-72 overflow-auto bg-surface-3 px-3 py-2 font-mono text-[11px] leading-relaxed text-fg-2 whitespace-pre-wrap break-all";

const ChatRow = memo(function ChatRow({ item, sessionId }: { item: ChatItem; sessionId: string }) {
  const b = item.body;
  switch (b.kind) {
    case "user_text":
      return (
        <div className="flex justify-end">
          <div className="selectable max-w-[85%] whitespace-pre-wrap rounded-2xl rounded-br-md border border-blue/25 bg-blue/10 px-3 py-2 text-[13px] leading-relaxed">
            {!!b.images?.length && (
              <div className={cn("flex flex-wrap gap-1.5", b.text && "mb-2")}>
                {b.images.map((src, i) => <img key={i} src={src} alt="imagem enviada" className="max-h-40 max-w-[220px] rounded-lg object-cover" />)}
              </div>
            )}
            {b.text}
          </div>
        </div>
      );
    case "assistant_text":
      return (
        <div className="space-y-1">
          <AgentTag sessionId={sessionId} agentId={item.agentId} />
          <Suspense fallback={<div className="selectable whitespace-pre-wrap text-[13px]">{b.text}</div>}>
            <Markdown text={b.text} />
          </Suspense>
        </div>
      );
    case "tool_use":
      return (
        <Collapsible head={<><Wrench className="size-3 text-blue" /><span className="font-mono font-medium text-fg">{b.name}</span><span className="min-w-0 flex-1 truncate font-mono text-muted">{truncate(b.input.replace(/\s+/g, " "), 90)}</span><AgentTag sessionId={sessionId} agentId={item.agentId} /></>}>
          <pre className={pre}>{truncate(b.input, 6000)}</pre>
        </Collapsible>
      );
    case "tool_result":
      return (
        <Collapsible tone={b.isError ? "error" : undefined} head={<>{b.isError ? <CircleX className="size-3 text-red" /> : <CircleCheck className="size-3 text-green" />}<span className="text-fg-2">{b.isError ? "Erro da ferramenta" : "Resultado"}</span><span className="min-w-0 flex-1 truncate font-mono text-muted">{truncate(b.content.replace(/\s+/g, " "), 90)}</span></>}>
          <pre className={pre}>{truncate(b.content, 8000)}</pre>
        </Collapsible>
      );
    case "turn_result":
      return (
        <div className={cn("flex items-center gap-3 rounded-lg border border-dashed px-3 py-1.5 font-mono text-[10.5px]", b.isError ? "border-red/40 text-red" : "border-line-2 text-muted")}>
          {b.isError ? <AlertTriangle className="size-3" /> : <CircleCheck className="size-3 text-green" />}
          <span>{b.subtype}</span>
          <span>{fmtCost(b.costUsd)}</span>
          <span>{fmtTokens(b.inputTokens)} in · {fmtTokens(b.outputTokens)} out</span>
          <span>cache {fmtTokens(b.cacheRead)}</span>
          <span>{fmtDuration(b.durationMs)}</span>
          <span className="ml-auto">{b.numTurns} turnos</span>
        </div>
      );
    case "system":
      return (
        <div className={cn("flex items-center justify-center gap-1.5 text-[11px]", b.level === "error" ? "text-red" : b.level === "warn" ? "text-amber" : "text-muted")}>
          <Info className="size-3" /><span className="selectable">{b.text}</span><span className="text-dim">· {fmtTime(item.ts)}</span>
        </div>
      );
    case "approval":
      return (
        <div className="flex items-center gap-2 rounded-lg border border-amber/30 bg-amber/5 px-3 py-1.5 text-[11.5px]">
          <ShieldQuestion className="size-3.5 text-amber" />
          <span className="font-mono text-amber">{b.toolName}</span>
          <span className="min-w-0 flex-1 truncate text-fg-2">{b.summary}</span>
          <span className="text-muted">{b.decision ? (b.decision === "allow" ? "permitido" : "negado") : "aguardando"}</span>
        </div>
      );
  }
});

function Composer({ session }: { session: SessionSummary }) {
  const [text, setText] = useState("");
  const pasted = usePastedImages();
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const blocked = session.status === "blocked" || session.status === "archived";
  const running = ["running", "starting", "awaiting_approval"].includes(session.status);
  const hint =
    session.status === "idle" || session.status === "interrupted" || session.status === "error"
      ? session.resumable ? "Enviar retomará a sessão (--resume)" : "Sessão sem transcrição persistida; uma nova execução será iniciada"
      : session.status === "queued" ? "Na fila: a mensagem será enviada quando houver vaga"
      : session.status === "blocked" ? "Bloqueada: verifique a autenticação desta conta"
      : null;
  const send = async () => {
    const t = text.trim();
    if ((!t && !pasted.images.length) || busy) return;
    setBusy(true); setErr(null);
    const { images, thumbs } = pasted.payload();
    try {
      await api.sendMessage(session.account, session.id, t, images, thumbs);
      setText("");
      pasted.clear();
    } catch (e) { setErr(errMessage(e)); } finally { setBusy(false); }
  };
  return (
    <div className="border-t border-line p-3">
      <div className="rounded-xl border border-line-2 bg-bg-2 focus-within:border-cyan/50 focus-within:ring-2 focus-within:ring-cyan/10">
        <Textarea
          value={text}
          onChange={(e) => setText(e.target.value)}
          onPaste={pasted.onPaste}
          onKeyDown={(e) => { if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); void send(); } }}
          placeholder={blocked ? "Sessão indisponível" : "Mensagem para o Claude…  (Enter envia · Shift+Enter quebra linha)"}
          disabled={blocked}
          rows={3}
          aria-label="Mensagem"
          className="border-0 bg-transparent focus:ring-0"
        />
        <AttachmentStrip images={pasted.images} onRemove={pasted.remove} error={pasted.error} className="px-3 pb-2" />
        <div className="flex items-center gap-2 px-2 pb-2">
          <span className="min-w-0 flex-1 truncate text-[11px] text-muted">{err ? <span className="text-red">{err}</span> : hint ?? <PasteHint />}</span>
          {running && (
            <Button size="xs" variant="warn" onClick={() => api.interruptSession(session.account, session.id).catch((e) => setErr(errMessage(e)))}>
              <Pause /> Interromper
            </Button>
          )}
          {session.pid != null && (
            <Button size="xs" variant="ghost" onClick={() => api.stopSession(session.account, session.id).catch((e) => setErr(errMessage(e)))}>
              <Square /> Encerrar processo
            </Button>
          )}
          <Button size="xs" variant="primary" disabled={(!text.trim() && !pasted.images.length) || busy || blocked} onClick={() => void send()} aria-label="Enviar mensagem">
            <Send /> Enviar
          </Button>
        </div>
      </div>
    </div>
  );
}
