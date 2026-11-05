import { cn } from "../../lib/utils";

export const MODELS: { id: string; label: string; hint: string }[] = [
  { id: "", label: "Padrão", hint: "Modelo padrão da conta / do Claude Code" },
  { id: "opus", label: "Opus", hint: "Mais capaz, para tarefas difíceis" },
  { id: "sonnet", label: "Sonnet", hint: "Equilíbrio entre qualidade e velocidade" },
  { id: "haiku", label: "Haiku", hint: "Mais rápido e econômico" },
];

/** Segmented model switch; "" = default. Unknown values (full model ids) show as a fifth pill. */
export function ModelPicker({ value, onChange, className }: { value: string | null; onChange: (m: string) => void; className?: string }) {
  const v = value ?? "";
  const options = MODELS.some((m) => m.id === v) ? MODELS : [...MODELS, { id: v, label: v, hint: v }];
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
