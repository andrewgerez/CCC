import { Check, ShieldCheck, X } from "lucide-react";
import { useMemo, useState } from "react";
import { Button } from "../../components/ui/button";
import { Input } from "../../components/ui/input";
import { Empty } from "../../components/ui/status";
import { api } from "../../lib/api";
import type { Approval, ApprovalDecision } from "../../lib/contract";
import { cn, errMessage, fmtRelative, truncate } from "../../lib/utils";
import { useData } from "../../store/data";

export function approvalSummary(a: Approval): string {
  const i = (a.input ?? {}) as Record<string, unknown>;
  if (typeof i.command === "string") return i.command;
  if (typeof i.file_path === "string") return i.file_path;
  if (typeof i.url === "string") return i.url;
  if (typeof i.pattern === "string") return i.pattern;
  if (a.description) return a.description;
  try { return JSON.stringify(a.input); } catch { return a.toolName; }
}

async function send(a: Approval, d: ApprovalDecision) {
  await api.respondApproval(a.account, a.sessionId, a.requestId, d);
}

export function ApprovalActions({ approval, compact }: { approval: Approval; compact?: boolean }) {
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [denyMsg, setDenyMsg] = useState("");
  const [denying, setDenying] = useState(false);
  const hasSuggestions = Array.isArray(approval.suggestions) && approval.suggestions.length > 0;
  const go = async (d: ApprovalDecision) => {
    setBusy(true); setErr(null);
    try { await send(approval, d); } catch (e) { setErr(errMessage(e)); setBusy(false); }
  };
  return (
    <div className="space-y-2">
      {denying ? (
        <form className="flex gap-1.5" onSubmit={(e) => { e.preventDefault(); void go({ behavior: "deny", message: denyMsg.trim() || "Negado pelo usuário" }); }}>
          <Input autoFocus value={denyMsg} onChange={(e) => setDenyMsg(e.target.value)} placeholder="Motivo (enviado ao Claude)" className="h-7 text-xs" />
          <Button type="submit" size="sm" variant="danger" disabled={busy}>Negar</Button>
          <Button size="sm" variant="ghost" onClick={() => setDenying(false)}>Cancelar</Button>
        </form>
      ) : (
        <div className="flex flex-wrap gap-1.5">
          <Button size={compact ? "xs" : "sm"} variant="success" disabled={busy} onClick={() => go({ behavior: "allow", updatedInput: approval.input })}>
            <Check /> Permitir
          </Button>
          {hasSuggestions && (
            <Button size={compact ? "xs" : "sm"} variant="outline" disabled={busy} onClick={() => go({ behavior: "allow", updatedInput: approval.input, remember: true })}>
              <ShieldCheck /> Permitir e lembrar
            </Button>
          )}
          <Button size={compact ? "xs" : "sm"} variant="danger" disabled={busy} onClick={() => setDenying(true)}>
            <X /> Negar
          </Button>
        </div>
      )}
      {err && <div role="alert" className="text-[11px] text-red">{err}</div>}
    </div>
  );
}

interface Question { question: string; header?: string; multiSelect?: boolean; options?: { label: string; description?: string }[] }

function AskUserQuestionForm({ approval }: { approval: Approval }) {
  const input = (approval.input ?? {}) as { questions?: Question[] };
  const questions = input.questions ?? [];
  const [answers, setAnswers] = useState<Record<string, string[]>>({});
  const [other, setOther] = useState<Record<string, string>>({});
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const complete = questions.every((q) => (answers[q.question]?.length ?? 0) > 0 || (other[q.question] ?? "").trim());
  const toggle = (q: Question, label: string) =>
    setAnswers((a) => {
      const cur = a[q.question] ?? [];
      const next = q.multiSelect ? (cur.includes(label) ? cur.filter((x) => x !== label) : [...cur, label]) : [label];
      return { ...a, [q.question]: next };
    });
  const submit = async () => {
    const out: Record<string, string> = {};
    for (const q of questions) {
      const parts = [...(answers[q.question] ?? [])];
      const o = (other[q.question] ?? "").trim();
      if (o) parts.push(o);
      out[q.question] = parts.join(", ");
    }
    setBusy(true); setErr(null);
    try {
      await send(approval, { behavior: "allow", updatedInput: { ...(approval.input as object), answers: out } });
    } catch (e) { setErr(errMessage(e)); setBusy(false); }
  };
  return (
    <div className="space-y-4">
      {questions.map((q) => (
        <fieldset key={q.question} className="space-y-2">
          <legend className="mb-1.5 text-[13px] font-medium">
            {q.header && <span className="mr-2 rounded bg-surface-3 px-1.5 py-0.5 text-[10.5px] text-muted">{q.header}</span>}
            {q.question}
          </legend>
          <div className="grid gap-1.5">
            {(q.options ?? []).map((o) => {
              const on = answers[q.question]?.includes(o.label);
              return (
                <button
                  key={o.label}
                  type="button"
                  role={q.multiSelect ? "checkbox" : "radio"}
                  aria-checked={on}
                  onClick={() => toggle(q, o.label)}
                  className={cn("rounded-lg border px-3 py-2 text-left transition-colors", on ? "border-cyan/50 bg-cyan/10" : "border-line-2 bg-bg-2 hover:border-dim")}
                >
                  <div className="text-[12.5px] font-medium">{o.label}</div>
                  {o.description && <div className="mt-0.5 text-[11.5px] text-muted">{o.description}</div>}
                </button>
              );
            })}
            <Input value={other[q.question] ?? ""} onChange={(e) => setOther((s) => ({ ...s, [q.question]: e.target.value }))} placeholder="Outro (resposta livre)" className="h-8 text-xs" />
          </div>
        </fieldset>
      ))}
      <div className="flex gap-1.5">
        <Button variant="primary" disabled={!complete || busy} onClick={submit}><Check /> Responder</Button>
        <Button variant="danger" disabled={busy} onClick={() => send(approval, { behavior: "deny", message: "Usuário recusou responder" }).catch((e) => setErr(errMessage(e)))}><X /> Recusar</Button>
      </div>
      {err && <div role="alert" className="text-[11px] text-red">{err}</div>}
    </div>
  );
}

export function ApprovalCard({ approval }: { approval: Approval }) {
  const agentName = useData((s) => (approval.agentId ? s.agents[approval.sessionId]?.[approval.agentId]?.name : undefined));
  const pretty = useMemo(() => {
    try { return truncate(JSON.stringify(approval.input, null, 2), 4000); } catch { return String(approval.input); }
  }, [approval.input]);
  const isQuestion = approval.toolName === "AskUserQuestion";
  return (
    <div className="attention rounded-xl border border-amber/45 bg-amber/[0.04] p-3.5 enter">
      <div className="mb-2.5 flex items-center justify-between gap-2">
        <div className="flex items-center gap-2">
          <span className="rounded-md bg-amber/15 px-1.5 py-0.5 font-mono text-[11.5px] font-semibold text-amber">{approval.toolName}</span>
          {agentName && <span className="text-[11px] text-muted">por {agentName}</span>}
        </div>
        <span className="text-[11px] text-muted">{fmtRelative(approval.createdAt)}</span>
      </div>
      {approval.description && <div className="mb-2 text-[12.5px] text-fg-2">{approval.description}</div>}
      {isQuestion ? (
        <AskUserQuestionForm approval={approval} />
      ) : (
        <>
          <pre className="selectable mb-3 max-h-56 overflow-auto rounded-lg border border-line bg-surface-3 p-2.5 font-mono text-[11px] leading-relaxed text-fg-2">{pretty}</pre>
          <ApprovalActions approval={approval} />
        </>
      )}
    </div>
  );
}

export function ApprovalsTab({ sessionId }: { sessionId: string }) {
  const approvals = useData((s) => s.approvals);
  const list = useMemo(() => Object.values(approvals).filter((a) => a.sessionId === sessionId).sort((a, b) => a.createdAt - b.createdAt), [approvals, sessionId]);
  if (!list.length) return <Empty icon={<ShieldCheck />} title="Nenhuma aprovação pendente" hint="Pedidos de permissão do Claude e dos subagentes aparecem aqui em tempo real." />;
  return (
    <div className="space-y-3 overflow-auto p-4">
      {list.map((a) => <ApprovalCard key={a.requestId} approval={a} />)}
    </div>
  );
}
