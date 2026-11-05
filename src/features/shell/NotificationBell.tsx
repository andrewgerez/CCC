import { Bell } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { useShallow } from "zustand/react/shallow";
import { ACCOUNT_LABEL, cn, fmtRelative, truncate } from "../../lib/utils";
import { useData } from "../../store/data";
import { useUi } from "../../store/ui";

/** Pending approvals + recent notices. */
export function NotificationBell() {
  const approvals = useData(useShallow((s) => Object.values(s.approvals)));
  const notices = useData((s) => s.notices);
  const sessions = useData((s) => s.sessions);
  const openSession = useUi((s) => s.openSession);
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => { if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false); };
    window.addEventListener("mousedown", onDown);
    return () => window.removeEventListener("mousedown", onDown);
  }, [open]);
  const count = approvals.length;
  const recent = notices.slice(-6).reverse();
  return (
    <div ref={ref} className="relative">
      <button
        aria-label={`Notificações: ${count} aprovações pendentes`}
        aria-expanded={open}
        onClick={() => setOpen((o) => !o)}
        className={cn("relative grid size-8 place-items-center rounded-full transition-colors", count ? "bg-amber/10 text-amber" : "text-fg-2 hover:bg-surface-3")}
      >
        <Bell className="size-4" />
        {count > 0 && <span className="absolute -right-1 -top-1 grid h-4 min-w-4 place-items-center rounded-full bg-amber px-1 text-[10px] font-bold text-white">{count}</span>}
      </button>
      {open && (
        <div className="glass absolute right-0 top-10 z-30 w-[340px] rounded-xl p-2 shadow-2xl enter">
          <div className="px-2 pb-1.5 pt-1 text-[10.5px] font-semibold text-muted">Aprovações pendentes</div>
          {approvals.length === 0 && <div className="px-2 py-2 text-xs text-muted">Nada aguardando você.</div>}
          {approvals.map((a) => (
            <button key={a.requestId} onClick={() => { openSession(a.sessionId, "approvals"); setOpen(false); }} className="flex w-full items-start gap-2 rounded-lg px-2 py-2 text-left hover:bg-surface-3">
              <span className="mt-1 size-1.5 shrink-0 rounded-full bg-amber" />
              <span className="min-w-0">
                <span className="block truncate text-xs font-medium">{a.toolName} · {sessions[a.sessionId]?.title ?? a.sessionId.slice(0, 8)}</span>
                <span className="block truncate text-[11px] text-muted">{ACCOUNT_LABEL[a.account]} · {fmtRelative(a.createdAt)}</span>
              </span>
            </button>
          ))}
          {recent.length > 0 && (
            <>
              <div className="mt-1 border-t border-line px-2 pb-1 pt-2 text-[10.5px] font-semibold text-muted">Recentes</div>
              {recent.map((n) => (
                <div key={n.id} className="flex items-start gap-2 px-2 py-1.5 text-[11.5px]">
                  <span className={cn("mt-1.5 size-1.5 shrink-0 rounded-full", n.level === "error" ? "bg-red" : n.level === "warn" ? "bg-amber" : "bg-blue")} />
                  <span className="min-w-0 text-fg-2">{truncate(n.text, 120)}</span>
                </div>
              ))}
            </>
          )}
        </div>
      )}
    </div>
  );
}

