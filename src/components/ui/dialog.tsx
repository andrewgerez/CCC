import * as D from "@radix-ui/react-dialog";
import { X } from "lucide-react";
import type { ReactNode } from "react";
import { cn } from "../../lib/utils";

export const Dialog = D.Root;
export const DialogClose = D.Close;

export function DialogContent({
  title, description, children, className,
}: { title: string; description?: ReactNode; children: ReactNode; className?: string }) {
  return (
    <D.Portal>
      <D.Overlay className="fixed inset-0 z-40 bg-[#1d1c1a]/25 backdrop-blur-[2px] enter" />
      <D.Content
        className={cn(
          "glass fixed left-1/2 top-[11vh] z-50 max-h-[78vh] w-[min(560px,92vw)] -translate-x-1/2 overflow-auto rounded-2xl p-5 shadow-[0_30px_80px_-20px_rgb(40_30_10/0.35)] enter focus:outline-none",
          className,
        )}
      >
        <div className="mb-4 flex items-start justify-between gap-4">
          <div>
            <D.Title className="text-[15px] font-semibold tracking-tight text-fg">{title}</D.Title>
            <D.Description className={description ? "mt-1 text-xs text-muted" : "sr-only"}>{description ?? title}</D.Description>
          </div>
          <D.Close aria-label="Fechar" className="rounded-md p-1 text-muted hover:bg-surface-3 hover:text-fg">
            <X className="size-4" />
          </D.Close>
        </div>
        {children}
      </D.Content>
    </D.Portal>
  );
}
