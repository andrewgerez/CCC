import type { AccountId } from "../../lib/contract";
import { cn } from "../../lib/utils";
import { useData } from "../../store/data";

export const MODELS: { id: string; label: string; hint: string }[] = [
  { id: "", label: "Padrão", hint: "Modelo padrão da conta / do Claude Code" },
  { id: "opus", label: "Opus", hint: "Mais capaz, para tarefas difíceis" },
  { id: "sonnet", label: "Sonnet", hint: "Equilíbrio entre qualidade e velocidade" },
  { id: "haiku", label: "Haiku", hint: "Mais rápido e econômico" },
];

/** Human name for a model alias or id: "opus[1m]" → "Opus 1M", "claude-sonnet-4-5-20250929" → "Sonnet 4.5". */
export function modelLabel(m: string): string {
  const ctx = /\[1m\]$/i.test(m) ? " 1M" : "";
  const base = m.replace(/\[.*\]$/, "");
  const full = /^claude-(opus|sonnet|haiku)-(\d+)(?:-(\d))?(?:-\d{8})?$/.exec(base);
  const cap = (w: string) => w[0].toUpperCase() + w.slice(1);
  if (full) return `${cap(full[1])} ${full[2]}${full[3] ? `.${full[3]}` : ""}${ctx}`;
  if (/^(opus|sonnet|haiku|default|opusplan)$/i.test(base)) return `${cap(base)}${ctx}`;
  return m;
}

/** Segmented model switch; "" = default. Unknown values (full model ids) show as a fifth pill.
 *  With `account`, the "Padrão" pill names what the default resolves to. */
export function ModelPicker({ value, onChange, account, className }: { value: string | null; onChange: (m: string) => void; account?: AccountId; className?: string }) {
  const v = value ?? "";
  const def = useData((s) => (account ? s.overview?.accounts.find((a) => a.config.id === account)?.defaultModel ?? null : undefined));
  const base = MODELS.map((m) =>
    m.id !== "" || def === undefined
      ? m
      : def
        ? { ...m, label: `Padrão · ${modelLabel(def)}`, hint: `Padrão desta conta: ${def}` }
        : { ...m, hint: "Sem modelo fixo: o Claude Code escolhe conforme o plano da conta" },
  );
  const options = base.some((m) => m.id === v) ? base : [...base, { id: v, label: modelLabel(v), hint: v }];
  return (
    <div role="radiogroup" aria-label="Modelo" className={cn("inline-flex flex-wrap rounded-full bg-surface-3 p-0.5", className)}>
      {options.map((m) => {
        const on = v === m.id;
        return (
          <button
            key={m.id || "default"}
            type="button"
            role="radio"
            aria-checked={on}
            title={m.hint}
            onClick={() => !on && onChange(m.id)}
            className={cn(
              "rounded-full px-3 py-1 text-[12px] font-medium transition-colors",
              on ? "bg-surface text-fg shadow-[0_1px_2px_rgb(0_0_0/0.1)]" : "text-muted hover:text-fg-2",
            )}
          >
            {m.label}
          </button>
        );
      })}
    </div>
  );
}
