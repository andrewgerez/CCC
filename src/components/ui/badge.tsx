import { cva, type VariantProps } from "class-variance-authority";
import type { HTMLAttributes } from "react";
import { cn } from "../../lib/utils";

const badgeVariants = cva(
  "inline-flex items-center gap-1 rounded-md border px-1.5 py-px text-[10.5px] font-medium leading-4 whitespace-nowrap",
  {
    variants: {
      tone: {
        neutral: "border-line-2 bg-surface-3 text-fg-2",
        cyan: "border-cyan/30 bg-cyan/10 text-cyan",
        blue: "border-blue/35 bg-blue/10 text-cyan",
        green: "border-green/30 bg-green/10 text-green",
        amber: "border-amber/35 bg-amber/10 text-amber",
        red: "border-red/35 bg-red/10 text-red",
        violet: "border-violet/35 bg-violet/10 text-violet",
        slate: "border-line-2 bg-transparent text-muted",
        unknown: "border-dashed border-dim text-muted",
      },
    },
    defaultVariants: { tone: "neutral" },
  },
);

export interface BadgeProps extends HTMLAttributes<HTMLSpanElement>, VariantProps<typeof badgeVariants> {}

export function Badge({ className, tone, ...props }: BadgeProps) {
  return <span className={cn(badgeVariants({ tone }), className)} {...props} />;
}
