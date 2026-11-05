import * as D from "@radix-ui/react-dialog";
import { FolderGit2, MessageSquare, Search } from "lucide-react";
import { useEffect, useMemo, useState } from "react";
import { StatusDot } from "../../components/ui/status";
import { api } from "../../lib/api";
import type { AccountId, RepoInfo } from "../../lib/contract";
import { ACCOUNT_LABEL, cn, isActiveSession, sessionTone, SESSION_STATUS_LABEL } from "../../lib/utils";
import { useData } from "../../store/data";
import { useUi } from "../../store/ui";

type Item =
  | { kind: "repo"; account: AccountId; repo: RepoInfo; key: string; text: string }
  | { kind: "session"; id: string; key: string; text: string };

const repoCache: Partial<Record<AccountId, RepoInfo[]>> = {};

export function CommandPalette() {
  const open = useUi((s) => s.paletteOpen);
  const setOpen = useUi((s) => s.setPalette);
  const sessions = useData((s) => s.sessions);
  const [q, setQ] = useState("");
  const [idx, setIdx] = useState(0);
  const [repos, setRepos] = useState<Partial<Record<AccountId, RepoInfo[]>>>(repoCache);

  useEffect(() => {
    if (!open) return;
    setQ("");
    setIdx(0);
    for (const acc of ["personal", "work"] as AccountId[]) {
      if (repoCache[acc]) continue;
      api.listRepos(acc).then((r) => { repoCache[acc] = r; setRepos({ ...repoCache }); }).catch(() => undefined);
    }
  }, [open]);

  const items = useMemo<Item[]>(() => {
    const all: Item[] = [];
    for (const s of Object.values(sessions).sort((a, b) => b.updatedAt - a.updatedAt)) {
      all.push({ kind: "session", id: s.id, key: `s:${s.id}`, text: `${s.title} ${s.repoName} ${s.id}`.toLowerCase() });
    }
    for (const acc of ["personal", "work"] as AccountId[]) {
      for (const r of repos[acc] ?? []) all.push({ kind: "repo", account: acc, repo: r, key: `r:${r.path}`, text: `${r.name} ${r.relPath}`.toLowerCase() });
    }
    const terms = q.toLowerCase().trim().split(/\s+/).filter(Boolean);
    return all.filter((i) => terms.every((t) => i.text.includes(t))).slice(0, 40);
  }, [sessions, repos, q]);

  const choose = (it: Item | undefined) => {
    if (!it) return;
    const ui = useUi.getState();
    if (it.kind === "session") {
      ui.openSession(it.id);
    } else {
      ui.setScope(it.account);
      ui.selectRepo(it.account, it.repo.path);
      ui.setView("canvas");
      ui.openComposer(it.account, it.repo.path);
    }
    setOpen(false);
  };

  return (
    <D.Root open={open} onOpenChange={setOpen}>
      <D.Portal>
        <D.Overlay className="fixed inset-0 z-40 bg-[#1d1c1a]/25 backdrop-blur-[2px]" />
        <D.Content aria-label="Paleta de comandos" className="glass fixed left-1/2 top-[14vh] z-50 w-[min(620px,92vw)] -translate-x-1/2 overflow-hidden rounded-2xl shadow-2xl enter focus:outline-none">
          <D.Title className="sr-only">Buscar</D.Title>
          <D.Description className="sr-only">Buscar projetos e sessões</D.Description>
          <div className="flex items-center gap-2 border-b border-line px-4">
            <Search className="size-4 text-muted" />
            <input
              autoFocus
              value={q}
              onChange={(e) => { setQ(e.target.value); setIdx(0); }}
              onKeyDown={(e) => {
                if (e.key === "ArrowDown") { e.preventDefault(); setIdx((i) => Math.min(items.length - 1, i + 1)); }
                if (e.key === "ArrowUp") { e.preventDefault(); setIdx((i) => Math.max(0, i - 1)); }
                if (e.key === "Enter") { e.preventDefault(); choose(items[idx]); }
              }}
              placeholder="Buscar sessões e repositórios…"
              aria-label="Buscar"
              className="h-12 flex-1 bg-transparent text-sm text-fg placeholder:text-dim focus:outline-none"
            />
          </div>
          <div className="max-h-[50vh] overflow-auto p-1.5" role="listbox">
            {items.length === 0 && <div className="px-3 py-6 text-center text-xs text-muted">Nada encontrado.</div>}
            {items.map((it, i) => (
              <button
                key={it.key}
                role="option"
                aria-selected={i === idx}
                onMouseEnter={() => setIdx(i)}
                onClick={() => choose(it)}
                className={cn("flex w-full items-center gap-3 rounded-lg px-3 py-2 text-left", i === idx ? "bg-surface-3" : "")}
              >
                {it.kind === "session" ? <SessionRow id={it.id} /> : (
                  <>
                    <FolderGit2 className="size-4 shrink-0 text-muted" />
                    <span className="min-w-0 flex-1">
                      <span className="block truncate text-[13px]">{it.repo.name}</span>
                      <span className="block truncate text-[11px] text-muted">{it.repo.relPath}</span>
                    </span>
                    <span className={cn("text-[11px]", it.account === "work" ? "text-work" : "text-personal")}>{ACCOUNT_LABEL[it.account]}</span>
                  </>
                )}
              </button>
            ))}
          </div>
        </D.Content>
      </D.Portal>
    </D.Root>
  );
}

function SessionRow({ id }: { id: string }) {
  const s = useData((st) => st.sessions[id]);
  if (!s) return null;
  return (
    <>
      <MessageSquare className="size-4 shrink-0 text-muted" />
      <span className="min-w-0 flex-1">
        <span className="block truncate text-[13px]">{s.title}</span>
        <span className="block truncate text-[11px] text-muted">{s.repoName} · {SESSION_STATUS_LABEL[s.status]}</span>
      </span>
      <StatusDot tone={sessionTone(s.status)} active={isActiveSession(s.status)} />
      <span className={cn("text-[11px]", s.account === "work" ? "text-work" : "text-personal")}>{ACCOUNT_LABEL[s.account]}</span>
    </>
  );
}
