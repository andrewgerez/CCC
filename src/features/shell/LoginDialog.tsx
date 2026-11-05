import { LogIn, RefreshCw, Send, ShieldAlert, ShieldCheck } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { Badge } from "../../components/ui/badge";
import { Button } from "../../components/ui/button";
import { Dialog, DialogContent } from "../../components/ui/dialog";
import { Input } from "../../components/ui/input";
import { api } from "../../lib/api";
import { ACCOUNT_LABEL, errMessage, fmtRelative } from "../../lib/utils";
import { useData } from "../../store/data";
import { useUi } from "../../store/ui";

export function LoginDialog() {
  const account = useUi((s) => s.loginAccount);
  const setLogin = useUi((s) => s.setLogin);
  const status = useData((s) => (account ? s.auth[account] : undefined));
  const logs = useData((s) => (account ? s.authLog[account] : undefined));
  const config = useData((s) => s.overview?.accounts.find((a) => a.config.id === account)?.config);
  const [code, setCode] = useState("");
  const [busy, setBusy] = useState<string | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [started, setStarted] = useState(false);
  const logRef = useRef<HTMLPreElement>(null);

  useEffect(() => { setErr(null); setCode(""); setStarted(false); }, [account]);
  useEffect(() => { logRef.current?.scrollTo({ top: 1e9 }); }, [logs]);

  if (!account) return null;
  const run = async (label: string, fn: () => Promise<unknown>) => {
    setBusy(label); setErr(null);
    try { await fn(); } catch (e) { setErr(errMessage(e)); } finally { setBusy(null); }
  };
  const verified = status?.state === "verified";

  return (
    <Dialog open onOpenChange={(o) => { if (!o) { if (started) void api.cancelLogin(account).catch(() => undefined); setLogin(null); } }}>
      <DialogContent title={`Conta ${ACCOUNT_LABEL[account]}`} description="A identidade é verificada com `claude auth status` no diretório de configuração isolado desta conta.">
        <div className="space-y-4">
          <div className="grid grid-cols-[110px_1fr] gap-y-1.5 rounded-xl border border-line bg-bg-2 p-3 text-xs">
            <span className="text-muted">Estado</span>
            <span>{verified ? <Badge tone="green"><ShieldCheck className="size-3" />Verificada</Badge> : <Badge tone={status?.state === "mismatch" ? "red" : "amber"}><ShieldAlert className="size-3" />{status?.state ?? "desconhecido"}</Badge>}</span>
            <span className="text-muted">Esperado</span><span className="font-mono">{(status?.expectedEmail ?? config?.email) || "qualquer conta (vincula no primeiro login)"}</span>
            <span className="text-muted">Autenticado</span><span className="font-mono">{status?.email ?? "—"}</span>
            <span className="text-muted">Organização</span><span>{status?.orgName ?? "—"}</span>
            <span className="text-muted">Plano</span><span>{status?.subscription ?? "—"}</span>
            <span className="text-muted">Config dir</span><span className="truncate font-mono">{config?.configDir}</span>
            <span className="text-muted">Verificado</span><span>{status?.checkedAt ? fmtRelative(status.checkedAt) : "—"}</span>
          </div>
          {status?.message && <div className="rounded-lg border border-amber/30 bg-amber/10 px-3 py-2 text-xs text-amber">{status.message}</div>}
          {status?.state === "mismatch" && (
            <div className="rounded-lg border border-red/35 bg-red/10 px-3 py-2 text-xs text-red">
              Execuções desta conta estão bloqueadas: a identidade autenticada não corresponde ao email esperado. Faça login com a conta correta.
            </div>
          )}
          <div className="flex gap-2">
            <Button variant="secondary" disabled={!!busy} onClick={() => run("refresh", () => api.refreshAuth(account))}>
              <RefreshCw className={busy === "refresh" ? "animate-spin" : ""} /> Verificar agora
            </Button>
            <Button variant="primary" disabled={!!busy} onClick={() => run("login", async () => { await api.startLogin(account); setStarted(true); })}>
              <LogIn /> {verified ? "Refazer login" : "Fazer login"}
            </Button>
          </div>
          {(started || (logs && logs.length > 0)) && (
            <div className="space-y-2">
              <pre ref={logRef} className="selectable max-h-48 overflow-auto rounded-lg border border-line bg-surface-3 p-3 font-mono text-[11px] leading-relaxed text-fg-2">
                {(logs ?? []).join("\n") || "Aguardando saída do `claude auth login`…"}
              </pre>
              <form className="flex gap-2" onSubmit={(e) => { e.preventDefault(); if (code.trim()) void run("code", async () => { await api.loginInput(account, code.trim()); setCode(""); }); }}>
                <Input value={code} onChange={(e) => setCode(e.target.value)} placeholder="Cole aqui o código exibido no navegador" aria-label="Código de login" />
                <Button type="submit" disabled={!code.trim() || !!busy}><Send /> Enviar</Button>
              </form>
            </div>
          )}
          {err && <div role="alert" className="text-xs text-red">{err}</div>}
        </div>
      </DialogContent>
    </Dialog>
  );
}
