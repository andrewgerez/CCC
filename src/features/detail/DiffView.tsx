import { useVirtualizer } from "@tanstack/react-virtual";
import { useMemo, useRef } from "react";
import { cn } from "../../lib/utils";

const LINE_H = 18;

function lineClass(l: string) {
  if (l.startsWith("+++") || l.startsWith("---")) return "text-fg-2 font-semibold";
  if (l.startsWith("diff --git")) return "text-cyan font-semibold border-t border-line mt-1 pt-1";
  if (l.startsWith("@@")) return "text-violet bg-violet/5";
  if (l.startsWith("+")) return "text-green bg-green/[0.07]";
  if (l.startsWith("-")) return "text-red bg-red/[0.07]";
  return "text-fg-2";
}

/** Colored unified diff; virtualized above 400 lines. Content is untrusted text (no HTML). */
export default function DiffView({ diff, className }: { diff: string; className?: string }) {
  const lines = useMemo(() => diff.split("\n"), [diff]);
  const ref = useRef<HTMLDivElement>(null);
  const big = lines.length > 400;
  const v = useVirtualizer({ count: big ? lines.length : 0, getScrollElement: () => ref.current, estimateSize: () => LINE_H, overscan: 30 });
  if (!diff.trim()) return <div className="p-4 text-xs text-muted">Sem diferenças.</div>;
  return (
    <div ref={ref} className={cn("selectable min-h-0 overflow-auto bg-surface-3 font-mono text-[11.5px]", className)}>
      {big ? (
        <div style={{ height: v.getTotalSize(), position: "relative", minWidth: "max-content" }}>
          {v.getVirtualItems().map((vi) => (
            <div key={vi.key} className={cn("absolute left-0 right-0 whitespace-pre px-3", lineClass(lines[vi.index]))} style={{ height: LINE_H, lineHeight: `${LINE_H}px`, transform: `translateY(${vi.start}px)` }}>
              {lines[vi.index] || " "}
            </div>
          ))}
        </div>
      ) : (
        <div className="min-w-max py-1">
          {lines.map((l, i) => (
            <div key={i} className={cn("whitespace-pre px-3", lineClass(l))} style={{ lineHeight: `${LINE_H}px` }}>{l || " "}</div>
          ))}
        </div>
      )}
    </div>
  );
}
