import { Check, FolderOpen, FolderPlus, Layers, Pencil, Play, Plus, Star, Trash2, X } from "lucide-react";
import { useEffect, useMemo, useState } from "react";
import { Button } from "../../components/ui/button";
import { Dialog, DialogContent } from "../../components/ui/dialog";
import { Input, Label, Select, Textarea } from "../../components/ui/input";
import { api } from "../../lib/api";
import type { AccountId, PermissionMode, Project, RepoInfo } from "../../lib/contract";
import { pickDirectories } from "../../lib/dialogs";
import { ACCOUNT_LABEL, cn, errMessage } from "../../lib/utils";
import { useData } from "../../store/data";
import { useUi } from "../../store/ui";
import { ModeToggle } from "./ModeToggle";
import { ModelPicker } from "./ModelPicker";
import { AttachmentStrip, PasteHint, usePastedImages } from "./Attachments";

const LOOSE = "__repo__";
const lastKey = (a: AccountId) => `ccc.lastProject.${a}`;
const readLast = (a: AccountId) => { try { return localStorage.getItem(lastKey(a)); } catch { return null; } };
const writeLast = (a: AccountId, v: string) => { try { localStorage.setItem(lastKey(a), v); } catch { /* ignore */ } };
const base = (p: string) => p.split("/").filter(Boolean).pop() ?? p;

export function NewSessionDialog() {
  const composer = useUi((s) => s.composer);
  const close = useUi((s) => s.closeComposer);
  const openSession = useUi((s) => s.openSession);
  const selectedRepo = useUi((s) => s.selectedRepo);
  const [account, setAccount] = useState<AccountId>("personal");
  const [repos, setRepos] = useState<RepoInfo[]>([]);
  const [projects, setProjects] = useState<Project[]>([]);
  const [target, setTarget] = useState<string>(LOOSE); // project id or LOOSE
  const [editing, setEditing] = useState<Project | null>(null);
  const [repo, setRepo] = useState("");
  const [prompt, setPrompt] = useState("");
  const pasted = usePastedImages();
  const [title, setTitle] = useState("");
  const [model, setModel] = useState("");
  const [mode, setMode] = useState<PermissionMode>("auto");
  const [priority, setPriority] = useState(0);
  const [worktree, setWorktree] = useState("");
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const auth = useData((s) => s.auth[account]);
  const cfg = useData((s) => s.overview?.accounts.find((a) => a.config.id === account)?.config);

  useEffect(() => {
    if (!composer.open) return;
    const acc = composer.account ?? "personal";
    setAccount(acc);
    setRepo(composer.repo ?? selectedRepo[acc] ?? "");
    setWorktree(composer.worktree ?? "");
    setPrompt(""); setTitle(""); setErr(null); setPriority(0); setEditing(null); pasted.clear();
  }, [composer.open]); // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    if (!composer.open) return;
    setModel(cfg?.defaultModel ?? "");
    setMode(cfg?.defaultPermissionMode ?? "auto");
    setEditing(null);
    api.listRepos(account).then((r) => { setRepos(r); setRepo((cur) => (r.some((x) => x.path === cur) ? cur : r[0]?.path ?? "")); }).catch((e) => setErr(errMessage(e)));
    api.listProjects(account).then((ps) => {
      setProjects(ps);
      const last = readLast(account);
      // An explicit repo from the caller wins over the remembered project.
      if (composer.repo) setTarget(LOOSE);
      else setTarget(last && (last === LOOSE || ps.some((p) => p.id === last)) ? last : ps[0]?.id ?? LOOSE);
    }).catch((e) => setErr(errMessage(e)));
  }, [account, composer.open, cfg]); // eslint-disable-line react-hooks/exhaustive-deps

  const project = projects.find((p) => p.id === target) ?? null;
  const canSubmit = (!!prompt.trim() || pasted.images.length > 0) && !editing && (project ? project.dirs.length > 0 : !!repo);

  const choose = (id: string) => { setTarget(id); setEditing(null); writeLast(account, id); };

  const submit = async () => {
    if (!canSubmit) return;
    setBusy(true); setErr(null);
    try {
      const dirs = project?.dirs ?? [repo];
      const s = await api.createSession(account, {
        repoPath: dirs[0], extraDirs: dirs.slice(1), prompt: prompt.trim(), ...pasted.payload(),
        title: title.trim() || (project ? `${project.name}: ${prompt.trim().split("\n")[0].slice(0, 70)}` : null),
        model: model || null, permissionMode: mode, priority,
        worktreePath: project ? null : worktree.trim() || null,
      });
      useData.getState().setSessions([s]);
      openSession(s.id);
      close();
    } catch (e) { setErr(errMessage(e)); } finally { setBusy(false); }
  };

  const onSaved = (p: Project) => {
    setProjects((ps) => (ps.some((x) => x.id === p.id) ? ps.map((x) => (x.id === p.id ? p : x)) : [...ps, p]));
    setEditing(null);
    choose(p.id);
  };
  const onDeleted = (id: string) => {
    setProjects((ps) => ps.filter((x) => x.id !== id));
    setEditing(null);
    choose(LOOSE);
  };

  return (
    <Dialog open={composer.open} onOpenChange={(o) => { if (!o) close(); }}>
      <DialogContent title="Nova sessão" description="Escolha um projeto (um ou vários diretórios) e descreva a tarefa." className="w-[min(700px,94vw)]">
        <form className="space-y-4" onSubmit={(e) => { e.preventDefault(); void submit(); }}>
          <div className="grid grid-cols-[170px_1fr] items-end gap-3">
            <div>
              <Label htmlFor="ns-acc">Conta</Label>
              <Select id="ns-acc" value={account} onChange={(e) => setAccount(e.target.value as AccountId)} disabled={!!composer.account}>
                {(["personal", "work"] as AccountId[]).map((a) => <option key={a} value={a}>{ACCOUNT_LABEL[a]}</option>)}
              </Select>
            </div>
            <div className="text-[11.5px] text-muted">Projetos ficam salvos só nesta conta e só aceitam pastas dentro de <span className="text-fg-2">{cfg?.workspaceRoot ?? "…"}</span>.</div>
          </div>

          <div>
            <Label>Projeto</Label>
            <div className="flex flex-wrap gap-1.5">
              {projects.map((p) => (
                <Chip key={p.id} active={target === p.id && !editing} onClick={() => choose(p.id)}>
                  <Layers className="size-3.5" />{p.name}<span className="text-[11px] text-muted">{p.dirs.length}</span>
                </Chip>
              ))}
              <Chip active={target === LOOSE && !editing} onClick={() => choose(LOOSE)}><FolderOpen className="size-3.5" />Repositório avulso</Chip>
              <Chip active={!!editing && !editing.id} onClick={() => setEditing({ id: "", name: "", dirs: [], createdAt: 0 })} dashed><Plus className="size-3.5" />Novo projeto</Chip>
            </div>
          </div>

          {editing ? (
            <ProjectEditor key={editing.id || "new"} account={account} initial={editing} repos={repos} onCancel={() => setEditing(null)} onSaved={onSaved} onDeleted={onDeleted} />
          ) : project ? (
            <div className="rounded-xl border border-line bg-bg-2/70 p-3">
              <div className="mb-2 flex items-center justify-between">
                <div className="text-[13px] font-medium">{project.name}</div>
                <Button variant="ghost" size="sm" onClick={() => setEditing(project)}><Pencil /> Editar</Button>
              </div>
              <ul className="space-y-1">
                {project.dirs.map((d, i) => (
                  <li key={d} className="flex items-center gap-2 text-[12px]">
                    {i === 0 ? <Star className="size-3.5 text-cyan" /> : <FolderOpen className="size-3.5 text-muted" />}
                    <span className="font-medium text-fg-2">{base(d)}</span>
                    <span className="truncate text-muted">{d}</span>
                    {i === 0 && <span className="ml-auto shrink-0 text-[11px] text-cyan">principal</span>}
                  </li>
                ))}
              </ul>
            </div>
          ) : (
            <div>
              <Label htmlFor="ns-repo">Repositório</Label>
              <Select id="ns-repo" value={repo} onChange={(e) => setRepo(e.target.value)}>
                {repos.length === 0 && <option value="">Nenhum repositório encontrado</option>}
                {repos.map((r) => <option key={r.path} value={r.path}>{r.relPath || r.name}{r.branch ? ` (${r.branch})` : ""}</option>)}
              </Select>
            </div>
          )}

          <div>
            <Label htmlFor="ns-prompt">Tarefa</Label>
            <Textarea id="ns-prompt" autoFocus rows={5} value={prompt} onChange={(e) => setPrompt(e.target.value)} onPaste={pasted.onPaste} onKeyDown={(e) => { if (e.key === "Enter" && (e.ctrlKey || e.metaKey)) { e.preventDefault(); void submit(); } }}
              placeholder={project ? `O que fazer no ${project.name}? Ex.: corrija o bug do login no front e no back…` : "Descreva o que o Claude deve fazer…"} />
            <AttachmentStrip images={pasted.images} onRemove={pasted.remove} error={pasted.error} className="mt-2" />
            <div className="mt-1"><PasteHint /></div>
          </div>
          <div className="grid grid-cols-4 gap-3">
            <div className="col-span-2"><Label htmlFor="ns-title">Título (opcional)</Label><Input id="ns-title" value={title} onChange={(e) => setTitle(e.target.value)} /></div>
            <div className="col-span-2"><Label>Modelo</Label>
              <div className="flex h-8 items-center"><ModelPicker value={model} onChange={setModel} /></div>
            </div>
            <div><Label htmlFor="ns-prio">Prioridade</Label><Input id="ns-prio" type="number" min={0} max={9} value={priority} onChange={(e) => setPriority(Number(e.target.value) || 0)} /></div>
          </div>
          <div className="grid grid-cols-2 gap-3">
            <div><Label>Permissões</Label>
              <div className="flex h-8 items-center"><ModeToggle value={mode} onChange={setMode} /></div>
            </div>
            {!project && <div><Label htmlFor="ns-wt">Worktree (opcional)</Label><Input id="ns-wt" value={worktree} onChange={(e) => setWorktree(e.target.value)} placeholder="caminho de um worktree criado" /></div>}
          </div>
          {auth && auth.state !== "verified" && (
            <div className="rounded-lg border border-amber/35 bg-amber/10 px-3 py-2 text-xs text-amber">
              Conta {ACCOUNT_LABEL[account]} não verificada ({auth.state}). A execução será bloqueada até a autenticação correta.
            </div>
          )}
          {err && <div role="alert" className="text-xs text-red">{err}</div>}
          <div className="flex justify-end gap-2 pt-1">
            <Button variant="ghost" onClick={close}>Cancelar</Button>
            <Button type="submit" variant="primary" size="md" disabled={busy || !canSubmit}><Play /> Iniciar sessão</Button>
          </div>
        </form>
      </DialogContent>
    </Dialog>
  );
}

export function PermissionOptions() {
  return (
    <>
      <option value="auto">Automático (sem pedir permissão)</option>
      <option value="acceptEdits">Aceitar edições</option>
      <option value="default">Pedir aprovação</option>
      <option value="plan">Somente planejar</option>
    </>
  );
}

function Chip({ active, dashed, onClick, children }: { active: boolean; dashed?: boolean; onClick: () => void; children: React.ReactNode }) {
  return (
    <button type="button" onClick={onClick}
      className={cn("flex h-8 items-center gap-1.5 rounded-full border px-3 text-[12.5px] transition-colors",
        active ? "border-cyan/60 bg-cyan/15 text-fg shadow-[0_0_0_3px_rgb(217_119_87/0.12)]" : "border-line-2 bg-bg-2 text-fg-2 hover:bg-surface-3 hover:text-fg",
        dashed && !active && "border-dashed")}>
      {children}
    </button>
  );
}

function ProjectEditor({ account, initial, repos, onCancel, onSaved, onDeleted }: {
  account: AccountId; initial: Project; repos: RepoInfo[];
  onCancel: () => void; onSaved: (p: Project) => void; onDeleted: (id: string) => void;
}) {
  const [name, setName] = useState(initial.name);
  const [dirs, setDirs] = useState<string[]>(initial.dirs);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const workspace = useData((s) => s.overview?.accounts.find((a) => a.config.id === account)?.config.workspaceRoot);
  const available = useMemo(() => repos.filter((r) => !dirs.includes(r.path)), [repos, dirs]);

  const add = (ps: string[]) => setDirs((d) => [...d, ...ps.filter((p) => p && !d.includes(p))]);
  const browse = async () => {
    setErr(null);
    try { add(await pickDirectories(workspace)); } catch (e) { setErr(errMessage(e)); }
  };
  const save = async () => {
    setBusy(true); setErr(null);
    try { onSaved(await api.saveProject(account, { ...initial, name: name.trim(), dirs })); } catch (e) { setErr(errMessage(e)); } finally { setBusy(false); }
  };
  const remove = async () => {
    if (!initial.id) return;
    setBusy(true);
    try { await api.deleteProject(account, initial.id); onDeleted(initial.id); } catch (e) { setErr(errMessage(e)); } finally { setBusy(false); }
  };

  return (
    <div className="space-y-3 rounded-xl border border-cyan/30 bg-bg-2/80 p-3 enter">
      <div>
        <Label htmlFor="pj-name">Nome do projeto</Label>
        <Input id="pj-name" autoFocus value={name} onChange={(e) => setName(e.target.value)} placeholder="Ex.: Acme" />
      </div>
      <div>
        <Label>Diretórios <span className="text-muted">(o primeiro é o principal, onde a sessão roda)</span></Label>
        {dirs.length === 0 && <div className="rounded-lg border border-dashed border-line-2 px-3 py-3 text-center text-[12px] text-muted">Nenhuma pasta ainda. Adicione abaixo.</div>}
        <ul className="space-y-1">
          {dirs.map((d, i) => (
            <li key={d} className="flex items-center gap-2 rounded-lg border border-line bg-surface px-2.5 py-1.5 text-[12px]">
              <button type="button" title={i === 0 ? "Principal" : "Tornar principal"} onClick={() => setDirs((x) => [d, ...x.filter((y) => y !== d)])}
                className={cn("shrink-0", i === 0 ? "text-cyan" : "text-dim hover:text-fg-2")}>
                <Star className="size-3.5" fill={i === 0 ? "currentColor" : "none"} />
              </button>
              <span className="font-medium">{base(d)}</span>
              <span className="truncate text-muted">{d}</span>
              <button type="button" aria-label="Remover" onClick={() => setDirs((x) => x.filter((y) => y !== d))} className="ml-auto shrink-0 rounded p-0.5 text-muted hover:text-red"><X className="size-3.5" /></button>
            </li>
          ))}
        </ul>
        <div className="mt-2 flex gap-2">
          <Button variant="secondary" size="sm" onClick={browse}><FolderPlus /> Selecionar pastas…</Button>
          <Select aria-label="Adicionar repositório detectado" value="" onChange={(e) => { if (e.target.value) add([e.target.value]); }} className="h-8 flex-1">
            <option value="">+ adicionar repositório detectado…</option>
            {available.map((r) => <option key={r.path} value={r.path}>{r.relPath || r.name}</option>)}
          </Select>
        </div>
      </div>
      {err && <div role="alert" className="text-xs text-red">{err}</div>}
      <div className="flex items-center gap-2">
        {initial.id && <Button variant="ghost" size="sm" onClick={remove} disabled={busy} className="text-red hover:text-red"><Trash2 /> Excluir projeto</Button>}
        <div className="flex-1" />
        <Button variant="ghost" size="sm" onClick={onCancel}>Cancelar</Button>
        <Button variant="primary" size="sm" onClick={save} disabled={busy || !name.trim() || dirs.length === 0}><Check /> Salvar projeto</Button>
      </div>
    </div>
  );
}
