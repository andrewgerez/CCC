import { AlertTriangle, FolderOpen, Save, ShieldCheck, X } from "lucide-react";
import { useEffect, useState } from "react";
import { Button } from "../../components/ui/button";
import { Dialog, DialogContent } from "../../components/ui/dialog";
import { Input, Label, Select, Textarea } from "../../components/ui/input";
import { SectionTitle } from "../../components/ui/status";
import { api } from "../../lib/api";
import type { AccountConfig, BehaviorInfo, PermissionMode, Settings } from "../../lib/contract";
import { pickDirectories } from "../../lib/dialogs";
import { ACCOUNT_LABEL, cn, errMessage } from "../../lib/utils";
import { useData } from "../../store/data";
import { PermissionOptions } from "../shell/NewSessionDialog";
import { currentZoom, setZoom, stepZoom } from "../../lib/zoom";

export default function SettingsView() {
  const overview = useData((s) => s.overview);
  if (!overview) return <div className="p-6 text-xs text-muted">Carregando…</div>;
  return (
    <div className="h-full overflow-auto">
      <div className="mx-auto max-w-[920px] space-y-6 p-6">
        {overview.configError && (
          <div role="alert" className="flex items-start gap-2 rounded-xl border border-red/40 bg-red/10 p-3 text-xs text-red">
            <AlertTriangle className="mt-0.5 size-4 shrink-0" /><div><div className="font-semibold">Configuração inválida — execuções bloqueadas</div>{overview.configError}</div>
          </div>
        )}
        <div className="grid grid-cols-3 gap-3 text-xs">
          <Info label="Landlock ABI" value={overview.landlockAbi > 0 ? `v${overview.landlockAbi}` : "indisponível"} ok={overview.landlockAbi >= 1} />
          <Info label="Claude Code" value={overview.claudeVersion ?? "não encontrado"} ok={!!overview.claudeVersion} />
          <Info label="Sandbox" value={overview.settings.sandboxEnforce ? "ativo" : "DESATIVADO"} ok={overview.settings.sandboxEnforce} />
        </div>
        <GeneralSettings initial={overview.settings} />
        {overview.accounts.map((a) => <AccountEditor key={a.config.id} initial={a.config} warnings={a.warnings} />)}
      </div>
    </div>
  );
}

function Info({ label, value, ok }: { label: string; value: string; ok: boolean }) {
  return (
    <div className="rounded-xl border border-line bg-surface p-3">
      <div className="text-[10.5px] text-muted">{label}</div>
      <div className={cn("mt-0.5 font-mono text-[13px]", ok ? "text-fg" : "text-red")}>{value}</div>
    </div>
  );
}

function GeneralSettings({ initial }: { initial: Settings }) {
  const [s, setS] = useState(initial);
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<string | null>(null);
  const [confirmOff, setConfirmOff] = useState(false);
  useEffect(() => setS(initial), [initial]);
  const save = async (next = s) => {
    setBusy(true); setMsg(null);
    try { useData.getState().setOverview(await api.updateSettings(next)); setMsg("Salvo."); } catch (e) { setMsg(errMessage(e)); } finally { setBusy(false); }
  };
  return (
    <section className="rounded-2xl border border-line bg-surface/70 p-4">
      <SectionTitle>Execução e recursos</SectionTitle>
      <div className="grid grid-cols-2 gap-4">
        <div>
          <Label htmlFor="st-max">Execuções simultâneas (global): {s.maxConcurrent}</Label>
          <input id="st-max" type="range" min={1} max={8} value={s.maxConcurrent} onChange={(e) => setS({ ...s, maxConcurrent: Number(e.target.value) })} className="w-full accent-cyan" />
        </div>
        <div><Label htmlFor="st-idle">Encerrar processo ocioso após (s)</Label><Input id="st-idle" type="number" min={5} max={3600} value={s.idleTimeoutSecs} onChange={(e) => setS({ ...s, idleTimeoutSecs: Number(e.target.value) || 45 })} /></div>
        <div><Label htmlFor="st-ret">Eventos retidos por sessão</Label><Input id="st-ret" type="number" min={500} max={100000} value={s.eventRetentionPerSession} onChange={(e) => setS({ ...s, eventRetentionPerSession: Number(e.target.value) || 5000 })} /></div>
        <div><Label>Zoom da interface <span className="text-muted">(Ctrl + / Ctrl − / Ctrl 0)</span></Label><ZoomControl /></div>
        <label className="flex items-center gap-2 self-end pb-2 text-[13px]"><input type="checkbox" className="accent-cyan" checked={s.includePartialMessages} onChange={(e) => setS({ ...s, includePartialMessages: e.target.checked })} />Streaming token a token (mais IPC)</label>
      </div>
      <div className={cn("mt-4 flex items-center gap-3 rounded-xl border p-3", s.sandboxEnforce ? "border-green/30 bg-green/5" : "border-red/45 bg-red/10")}>
        {s.sandboxEnforce ? <ShieldCheck className="size-4 text-green" /> : <AlertTriangle className="size-4 text-red" />}
        <div className="flex-1 text-xs">
          <div className="font-medium">Sandbox Landlock {s.sandboxEnforce ? "ativo" : "desativado"}</div>
          <div className="text-muted">Restringe o acesso a arquivos de cada execução ao repositório, à config da conta e a caminhos permitidos.</div>
        </div>
        <Button size="sm" variant={s.sandboxEnforce ? "danger" : "success"} onClick={() => (s.sandboxEnforce ? setConfirmOff(true) : setS({ ...s, sandboxEnforce: true }))}>
          {s.sandboxEnforce ? "Desativar" : "Reativar"}
        </Button>
      </div>
      <div className="mt-4 flex items-center justify-end gap-3">
        {msg && <span className="text-xs text-muted">{msg}</span>}
        <Button variant="primary" disabled={busy} onClick={() => void save()}><Save /> Salvar</Button>
      </div>
      <Dialog open={confirmOff} onOpenChange={setConfirmOff}>
        <DialogContent title="Desativar o sandbox?" description="Sem o sandbox, um agente pode ler e escrever qualquer arquivo do seu usuário — incluindo o workspace e as credenciais da outra conta.">
          <div className="space-y-3">
            <div className="rounded-lg border border-red/45 bg-red/10 p-3 text-xs text-red">O isolamento entre as contas Pessoal e Empresarial passa a depender apenas de CLAUDE_CONFIG_DIR e do diretório de trabalho, o que não é uma garantia de segurança.</div>
            <div className="flex justify-end gap-2">
              <Button variant="ghost" onClick={() => setConfirmOff(false)}>Manter ativo</Button>
              <Button variant="danger" onClick={() => { const next = { ...s, sandboxEnforce: false }; setS(next); setConfirmOff(false); void save(next); }}>Desativar mesmo assim</Button>
            </div>
          </div>
        </DialogContent>
      </Dialog>
    </section>
  );
}

const lines = (v: string) => v.split("\n").map((x) => x.trim()).filter(Boolean);

/** Folder of skills / CLAUDE.md / plugin that every session of the account loads. */
function BehaviorField({ value, onChange }: { value: string; onChange: (v: string) => void }) {
  const [info, setInfo] = useState<BehaviorInfo | null>(null);
  useEffect(() => {
    if (!value.trim()) { setInfo(null); return; }
    let alive = true;
    const t = setTimeout(() => { api.inspectBehaviorDir(value.trim()).then((i) => alive && setInfo(i)).catch(() => alive && setInfo(null)); }, 250);
    return () => { alive = false; clearTimeout(t); };
  }, [value]);
  const pick = async () => {
    const [dir] = await pickDirectories(value || undefined, { multiple: false, title: "Pasta de comportamento (skills e CLAUDE.md)" });
    if (dir) onChange(dir);
  };
  return (
    <div className="col-span-2">
      <Label>Pasta de comportamento <span className="font-normal text-dim">(skills, CLAUDE.md, plugin — carregada em todas as sessões desta conta)</span></Label>
      <div className="flex gap-2">
        <Input className="flex-1 font-mono text-xs" value={value} onChange={(e) => onChange(e.target.value)} placeholder="nenhuma" />
        <Button size="md" variant="secondary" onClick={() => void pick()}><FolderOpen /> Escolher</Button>
        {value && <Button size="md" variant="ghost" aria-label="Remover pasta" onClick={() => onChange("")}><X /></Button>}
      </div>
      {value && info && (
        info.exists ? (
          <div className="mt-1.5 flex flex-wrap items-center gap-1.5 text-[11.5px] text-muted">
            {info.skills.length > 0
              ? info.skills.map((s) => <span key={s} className="rounded-full bg-surface-3 px-2 py-0.5 font-mono text-fg-2">/{s}</span>)
              : <span>nenhuma skill em .claude/skills</span>}
            <span>· CLAUDE.md {info.hasClaudeMd ? "✓" : "—"}</span>
            {info.isPlugin
              ? <span>· plugin: {info.agents} agentes, {info.commands} comandos</span>
              : (info.agents > 0 || info.commands > 0) && <span className="text-amber">· {info.agents} agentes e {info.commands} comandos só carregam se a pasta for um plugin (.claude-plugin/plugin.json)</span>}
          </div>
        ) : <div className="mt-1.5 text-[11.5px] text-amber">Pasta não encontrada.</div>
      )}
    </div>
  );
}

function AccountEditor({ initial, warnings }: { initial: AccountConfig; warnings: string[] }) {
  const [c, setC] = useState(initial);
  const [read, setRead] = useState(initial.extraReadPaths.join("\n"));
  const [write, setWrite] = useState(initial.extraWritePaths.join("\n"));
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null);
  useEffect(() => { setC(initial); setRead(initial.extraReadPaths.join("\n")); setWrite(initial.extraWritePaths.join("\n")); }, [initial]);
  const save = async () => {
    setBusy(true); setMsg(null);
    try {
      useData.getState().setOverview(await api.updateAccount({ ...c, extraReadPaths: lines(read), extraWritePaths: lines(write) }));
      setMsg({ ok: true, text: "Salvo e validado." });
    } catch (e) { setMsg({ ok: false, text: errMessage(e) }); } finally { setBusy(false); }
  };
  const f = (k: keyof AccountConfig) => (e: React.ChangeEvent<HTMLInputElement>) => setC({ ...c, [k]: e.target.value });
  return (
    <section className={cn("rounded-2xl border bg-surface/70 p-4", c.id === "work" ? "border-work/25" : "border-personal/25")}>
      <SectionTitle><span className={c.id === "work" ? "text-work" : "text-personal"}>Conta {ACCOUNT_LABEL[c.id]}</span></SectionTitle>
      {warnings.map((w) => <div key={w} className="mb-3 flex items-center gap-2 rounded-lg border border-amber/35 bg-amber/10 px-3 py-2 text-xs text-amber"><AlertTriangle className="size-3.5" />{w}</div>)}
      <div className="grid grid-cols-2 gap-3">
        <div><Label>Nome</Label><Input value={c.label} onChange={f("label")} /></div>
        <div><Label>Email esperado</Label><Input value={c.email} onChange={f("email")} placeholder="vazio: vincula no primeiro login" /></div>
        <div><Label>Workspace</Label><Input className="font-mono text-xs" value={c.workspaceRoot} onChange={f("workspaceRoot")} /></div>
        <BehaviorField value={c.behaviorDir ?? ""} onChange={(v) => setC({ ...c, behaviorDir: v || null })} />
        <div><Label>Diretório de configuração (CLAUDE_CONFIG_DIR)</Label><Input className="font-mono text-xs" value={c.configDir} onChange={f("configDir")} /></div>
        <div><Label>Leitura extra no sandbox (1 por linha)</Label><Textarea rows={4} className="font-mono text-xs" value={read} onChange={(e) => setRead(e.target.value)} /></div>
        <div><Label>Escrita extra no sandbox (1 por linha)</Label><Textarea rows={4} className="font-mono text-xs" value={write} onChange={(e) => setWrite(e.target.value)} /></div>
        <div><Label>Modelo padrão</Label>
          <Select value={c.defaultModel ?? ""} onChange={(e) => setC({ ...c, defaultModel: e.target.value || null })}>
            <option value="">Padrão do CLI</option><option value="sonnet">Sonnet</option><option value="opus">Opus</option><option value="haiku">Haiku</option>
          </Select>
        </div>
        <div><Label>Permissões padrão</Label>
          <Select value={c.defaultPermissionMode} onChange={(e) => setC({ ...c, defaultPermissionMode: e.target.value as PermissionMode })}>
            <PermissionOptions />
          </Select>
        </div>
      </div>
      <div className="mt-4 flex items-center justify-end gap-3">
        {msg && <span className={cn("text-xs", msg.ok ? "text-green" : "text-red")}>{msg.text}</span>}
        <Button variant="primary" disabled={busy} onClick={() => void save()}><Save /> Salvar conta</Button>
      </div>
    </section>
  );
}

function ZoomControl() {
  const [z, setZ] = useState(currentZoom());
  useEffect(() => {
    const on = (e: Event) => setZ((e as CustomEvent<number>).detail);
    window.addEventListener("ccc-zoom", on);
    return () => window.removeEventListener("ccc-zoom", on);
  }, []);
  return (
    <div className="flex items-center gap-2">
      <Button variant="outline" size="sm" onClick={() => void stepZoom(-1)} aria-label="Diminuir zoom">−</Button>
      <button type="button" onClick={() => void setZoom(1)} className="w-14 rounded-md py-1 text-center text-[13px] tabular-nums hover:bg-surface-3" title="Voltar para 100%">{Math.round(z * 100)}%</button>
      <Button variant="outline" size="sm" onClick={() => void stepZoom(1)} aria-label="Aumentar zoom">+</Button>
    </div>
  );
}
