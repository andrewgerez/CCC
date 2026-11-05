import type { PermissionMode } from "../../lib/contract";
import { cn } from "../../lib/utils";

const OPTIONS: { mode: PermissionMode; label: string; hint: string }[] = [
  { mode: "auto", label: "Auto", hint: "Claude decide sozinho as ações de rotina" },
  { mode: "default", label: "Perguntar", hint: "Pede sua aprovação antes de editar ou rodar comandos" },
];

/** Two-way switch between Claude Code auto mode and ask-before-acting. */
export function ModeToggle({ value, onChange, className }: { value: PermissionMode; onChange: (m: PermissionMode) => void; className?: string }) {
  return (
    <div role="radiogroup" aria-label="Modo de permissão" className={cn("inline-flex rounded-full bg-surface-3 p-0.5", className)}>
      {OPTIONS.map((o) => {
        const on = value === o.mode;
        return (
          <button
            key={o.mode}
            type="button"
            role="radio"
            aria-checked={on}
            title={o.hint}
            onClick={() => !on && onChange(o.mode)}
            className={cn(
              "rounded-full px-3 py-1 text-[12px] font-medium transition-colors",
              on ? "bg-surface text-fg shadow-[0_1px_2px_rgb(0_0_0/0.1)]" : "text-muted hover:text-fg-2",
            )}
          >
            {o.label}
          </button>
        );
      })}
    </div>
  );
}
