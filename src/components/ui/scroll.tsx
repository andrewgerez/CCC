import { forwardRef, type HTMLAttributes } from "react";
import { cn } from "../../lib/utils";

/** Native scroll container with thin themed scrollbars (no JS). */
export const ScrollArea = forwardRef<HTMLDivElement, HTMLAttributes<HTMLDivElement>>(({ className, ...p }, ref) => (
  <div ref={ref} className={cn("min-h-0 overflow-auto overscroll-contain", className)} {...p} />
));
ScrollArea.displayName = "ScrollArea";
