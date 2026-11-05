import { forwardRef, type HTMLAttributes, type InputHTMLAttributes, type LabelHTMLAttributes, type SelectHTMLAttributes, type TextareaHTMLAttributes } from "react";
import { cn } from "../../lib/utils";

const field =
  "w-full rounded-lg border border-line-2 bg-bg-2 px-2.5 text-[13px] text-fg placeholder:text-dim transition-colors hover:border-dim focus:border-cyan/60 focus:outline-none focus:ring-2 focus:ring-cyan/15 disabled:opacity-50";

export const Input = forwardRef<HTMLInputElement, InputHTMLAttributes<HTMLInputElement>>(({ className, ...p }, ref) => (
  <input ref={ref} className={cn(field, "h-8", className)} {...p} />
));
Input.displayName = "Input";

export const Textarea = forwardRef<HTMLTextAreaElement, TextareaHTMLAttributes<HTMLTextAreaElement>>(
  ({ className, ...p }, ref) => <textarea ref={ref} className={cn(field, "py-2 leading-relaxed resize-none", className)} {...p} />,
);
Textarea.displayName = "Textarea";

export const Select = forwardRef<HTMLSelectElement, SelectHTMLAttributes<HTMLSelectElement>>(({ className, ...p }, ref) => (
  <select ref={ref} className={cn(field, "h-8 pr-6", className)} {...p} />
));
Select.displayName = "Select";

export function Label({ className, ...p }: LabelHTMLAttributes<HTMLLabelElement>) {
  return <label className={cn("mb-1 block text-[11px] font-medium uppercase tracking-[0.06em] text-muted", className)} {...p} />;
}

export function Kbd({ className, ...p }: HTMLAttributes<HTMLElement>) {
  return (
    <kbd
      className={cn("inline-flex h-[18px] min-w-[18px] items-center justify-center rounded border border-line-2 bg-surface-3 px-1 font-mono text-[10px] text-fg-2", className)}
      {...p}
    />
  );
}
