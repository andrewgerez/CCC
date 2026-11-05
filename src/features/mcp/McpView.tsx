import { Globe, KeyRound, Plug, Terminal, Trash2 } from "lucide-react";
import { useEffect, useState, type FormEvent } from "react";
import martelo from "../../assets/claudes/martelo.gif";
import { Input, Label, Textarea } from "../../components/ui/input";
import { api } from "../../lib/api";
import type { AccountId, McpServer } from "../../lib/contract";
import { ACCOUNT_LABEL, cn, errMessage } from "../../lib/utils";
import { useUi } from "../../store/ui";

type Kind = "stdio" | "http" | "sse";
const KINDS: { id: Kind; label: string }[] = [
  { id: "stdio", label: "Comando local" },
  { id: "http", label: "URL (HTTP)" },
  { id: "sse", label: "URL (SSE)" },
];

/** Splits a command line on whitespace, honouring simple "double" and 'single' quotes. */
export function splitCommand(line: string): string[] {
  const out: string[] = [];
  const re = /"([^"]*)"|'([^']*)'|(\S+)/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(line))) out.push(m[1] ?? m[2] ?? m[3]);
  return out;
}

/** KEY=value (or Key: value) per line; blank lines and # comments ignored. */
export function parsePairs(text: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const raw of text.split("\n")) {
    const l = raw.trim();
    if (!l || l.startsWith("#")) continue;
    const seps = [l.indexOf("="), l.indexOf(":")].filter((x) => x > 0);
    const i = seps.length ? Math.min(...seps) : -1;
    if (i <= 0) continue;
    out[l.slice(0, i).trim()] = l.slice(i + 1).trim();
  }
  return out;
}

export function buildConfig(kind: Kind, target: string, pairs: string): Record<string, unknown> {
  const kv = parsePairs(pairs);
  const has = Object.keys(kv).length > 0;
  if (kind === "stdio") {
    const [command, ...args] = splitCommand(target.trim());
    return { type: "stdio", command: command ?? "", args, ...(has ? { env: kv } : {}) };
  }
  return { type: kind, url: target.trim(), ...(has ? { headers: kv } : {}) };
}

function AccountTabs({ account, onChange }: { account: AccountId; onChange: (a: AccountId) => void }) {
  return (
    <div role="tablist" className="inline-flex rounded-full bg-surface-3 p-1">
      {(["work", "personal"] as AccountId[]).map((a) => (
        <button
          key={a}
          role="tab"
          aria-selected={a === account}
          onClick={() => onChange(a)}
          className={cn(
            "flex items-center gap-2 rounded-full px-4 py-1.5 text-[13px] font-medium transition-colors",
            a === account ? (a === "work" ? "bg-work text-white" : "bg-personal text-white") : "text-muted hover:text-fg-2",
          )}
        >
          {ACCOUNT_LABEL[a]}
        </button>
      ))}
    </div>
  );
}

function ServerRow({ s, onRemove }: { s: McpServer; onRemove: () => Promise<void> }) {
  const [confirm, setConfirm] = useState(false);
  const [busy, setBusy] = useState(false);
  const Icon = s.transport === "stdio" ? Terminal : Globe;
  return (
    <li className="flex items-center gap-3 rounded-2xl bg-surface px-4 py-3 shadow-[0_0_0_1px_var(--color-line)]">
      <div className="grid size-9 shrink-0 place-items-center rounded-xl bg-surface-3 text-fg-2"><Icon className="size-4" /></div>
      <div className="min-w-0 flex-1">
        <div className="flex items-center gap-2">
          <span className="font-semibold">{s.name}</span>
          <span className="rounded-full bg-surface-3 px-2 py-0.5 text-[11px] text-muted">{s.transport}</span>
        </div>
        <div className="truncate font-mono text-[12px] text-muted">{s.target}</div>
        {s.secrets.length > 0 && (
          <div className="mt-0.5 flex items-center gap-1 text-[11.5px] text-dim"><KeyRound className="size-3" />{s.secrets.join(", ")}</div>
        )}
      </div>
      {confirm ? (
        <button
          disabled={busy}
          autoFocus
          onBlur={() => !busy && setConfirm(false)}
          onClick={() => { setBusy(true); void onRemove().finally(() => { setBusy(false); setConfirm(false); }); }}
          className="rounded-full bg-red px-3 py-1.5 text-[12.5px] font-medium text-white disabled:opacity-50"
        >
          {busy ? "Removendo…" : "Remover?"}
        </button>
      ) : (
        <button aria-label={`Remover ${s.name}`} onClick={() => setConfirm(true)} className="grid size-8 place-items-center rounded-full text-muted hover:bg-surface-3 hover:text-red">
          <Trash2 className="size-4" />
        </button>
      )}
    </li>
  );
}

function AddForm({ account, onAdded }: { account: AccountId; onAdded: (l: McpServer[]) => void }) {
  const [name, setName] = useState("");
  const [kind, setKind] = useState<Kind>("stdio");
  const [target, setTarget] = useState("");
  const [pairs, setPairs] = useState("");
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const submit = async (e: FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setErr(null);
    try {
      onAdded(await api.mcpAdd(account, name.trim(), buildConfig(kind, target, pairs)));
      setName(""); setTarget(""); setPairs("");
    } catch (x) {
      setErr(errMessage(x));
    } finally {
      setBusy(false);
    }
  };
  return (
    <form onSubmit={submit} className="space-y-3 rounded-2xl bg-surface p-4 shadow-[0_0_0_1px_var(--color-line)]">
      <div className="flex items-center gap-2 text-[14px] font-semibold"><Plug className="size-4" /> Conectar novo MCP em {ACCOUNT_LABEL[account]}</div>
      <div className="grid grid-cols-[1fr_auto] gap-3">
        <div>
          <Label htmlFor="mcp-name">Nome</Label>
          <Input id="mcp-name" value={name} onChange={(e) => setName(e.target.value)} placeholder="github" pattern="[A-Za-z0-9_\-]{1,64}" required />
        </div>
        <div>
          <Label>Tipo</Label>
          <div className="inline-flex h-8 items-center rounded-full bg-surface-3 p-0.5">
            {KINDS.map((k) => (
              <button key={k.id} type="button" onClick={() => setKind(k.id)} className={cn("rounded-full px-3 py-1 text-[12px] font-medium", kind === k.id ? "bg-surface text-fg shadow-[0_1px_2px_rgb(0_0_0/0.1)]" : "text-muted")}>
                {k.label}
              </button>
            ))}
          </div>
        </div>
      </div>
      <div>
        <Label htmlFor="mcp-target">{kind === "stdio" ? "Comando" : "URL"}</Label>
        <Input
          id="mcp-target"
          className="font-mono"
          value={target}
          onChange={(e) => setTarget(e.target.value)}
          placeholder={kind === "stdio" ? "npx -y @modelcontextprotocol/server-github" : "https://api.githubcopilot.com/mcp/"}
          required
        />
      </div>
      <div>
        <Label htmlFor="mcp-pairs">{kind === "stdio" ? "Variáveis de ambiente" : "Headers"} <span className="font-normal text-dim">(opcional, uma por linha)</span></Label>
        <Textarea id="mcp-pairs" className="font-mono" rows={3} value={pairs} onChange={(e) => setPairs(e.target.value)} placeholder={kind === "stdio" ? "GITHUB_TOKEN=ghp_…" : "Authorization=Bearer …"} />
        <p className="mt-1 text-[11.5px] text-dim">Os valores ficam só no config da conta; aqui aparecem apenas os nomes.</p>
      </div>
      {err && <div role="alert" className="rounded-lg bg-red/10 px-3 py-2 text-[12.5px] text-red">{err}</div>}
      <div className="flex justify-end">
        <button type="submit" disabled={busy || !name.trim() || !target.trim()} className="rounded-full bg-fg px-4 py-2 text-[13px] font-medium text-white hover:bg-[#3a3833] disabled:opacity-45">
          {busy ? "Conectando…" : "Conectar"}
        </button>
      </div>
    </form>
  );
}

export default function McpView() {
  const scope = useUi((s) => s.scope);
  const [account, setAccount] = useState<AccountId>(scope === "personal" ? "personal" : "work");
  const [list, setList] = useState<McpServer[] | null>(null);
  const [err, setErr] = useState<string | null>(null);
  useEffect(() => {
    let alive = true;
    setList(null);
    setErr(null);
    api.mcpList(account).then((l) => alive && setList(l)).catch((e) => alive && setErr(errMessage(e)));
    return () => { alive = false; };
  }, [account]);
  return (
    <div className="h-full overflow-auto">
      <div className="mx-auto max-w-2xl space-y-5 px-6 pb-12 pt-2">
        <div className="flex items-center gap-4">
          <div className="size-16 shrink-0 overflow-hidden rounded-2xl bg-[#fbefe7]">
            <img src={martelo} alt="" className="size-full scale-[1.6] object-cover mix-blend-multiply" />
          </div>
          <div>
            <h2 className="text-[22px] font-semibold tracking-tight">Conexões MCP</h2>
            <p className="text-[13px] text-muted">Ferramentas extras para o Claude, separadas por conta. Valem para as próximas sessões.</p>
          </div>
        </div>
        <AccountTabs account={account} onChange={setAccount} />
        {err && <div role="alert" className="rounded-lg bg-red/10 px-3 py-2 text-[12.5px] text-red">{err}</div>}
        {list === null && !err ? (
          <div className="text-[13px] text-muted">Carregando…</div>
        ) : (
          <ul className="space-y-2">
            {list?.length === 0 && <li className="rounded-2xl border border-dashed border-line-2 px-4 py-6 text-center text-[13px] text-muted">Nenhum MCP conectado em {ACCOUNT_LABEL[account]}.</li>}
            {list?.map((s) => (
              <ServerRow key={s.name} s={s} onRemove={() => api.mcpRemove(account, s.name).then(setList).catch((e) => setErr(errMessage(e)))} />
            ))}
          </ul>
        )}
        <AddForm account={account} onAdded={setList} />
      </div>
    </div>
  );
}
