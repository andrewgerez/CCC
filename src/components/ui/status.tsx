import { memo, type ReactNode } from "react";
import { cn, TONE_BG, TONE_TEXT, type Tone } from "../../lib/utils";

/** Status dot; pulses only when `active`. */
export const StatusDot = memo(function StatusDot({ tone, active, className }: { tone: Tone; active?: boolean; className?: string }) {
  return (
    <span className={cn("relative inline-flex size-2 shrink-0 rounded-full", TONE_TEXT[tone], active && "pulse-ring", className)}>
      <span className={cn("relative z-[1] size-2 rounded-full", tone === "unknown" ? "border border-dashed border-muted" : TONE_BG[tone])} />
    </span>
  );
});

export function Empty({ icon, title, hint, className }: { icon?: ReactNode; title: string; hint?: ReactNode; className?: string }) {
  return (
    <div className={cn("flex flex-col items-center justify-center gap-2 px-6 py-10 text-center", className)}>
      {icon && <div className="text-dim [&_svg]:size-6">{icon}</div>}
      <div className="text-[13px] font-medium text-fg-2">{title}</div>
      {hint && <div className="max-w-xs text-xs leading-relaxed text-muted">{hint}</div>}
    </div>
  );
}

export function SectionTitle({ children, right, className }: { children: ReactNode; right?: ReactNode; className?: string }) {
  return (
    <div className={cn("flex items-center justify-between gap-2 pb-2", className)}>
      <h3 className="text-[10.5px] font-semibold text-muted">{children}</h3>
      {right}
    </div>
  );
}
