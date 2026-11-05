import { ShieldQuestion, X } from "lucide-react";
import { useEffect, useMemo, useState } from "react";
import { ZoomIn } from "lucide-react";
import { useShallow } from "zustand/react/shallow";
import { ACCOUNT_LABEL, cn, truncate } from "../../lib/utils";
import { useData } from "../../store/data";
import { useUi } from "../../store/ui";
import { ApprovalActions, approvalSummary } from "../detail/Approvals";

/** Bottom-center: pending approvals (opaque, actionable). Top-right: transient warn/error notices. */
export function Toasts() {
  const approvals = useData(useShallow((s) => Object.values(s.approvals).sort((a, b) => a.createdAt - b.createdAt)));
  const sessions = useData((s) => s.sessions);
  const notices = useData((s) => s.notices);
  const selected = useUi((s) => s.selectedSessionId);
  const panelTab = useUi((s) => s.panelTab);
  const openSession = useUi((s) => s.openSession);
  const [dismissed, setDismissed] = useState<Set<string>>(new Set());
  const [shownNotices, setShownNotices] = useState<number[]>([]);

  const lastNotice = notices.at(-1);
  useEffect(() => {
    if (!lastNotice || lastNotice.level === "info") return;
    setShownNotices((s) => [...s, lastNotice.id].slice(-3));
    const t = setTimeout(() => setShownNotices((s) => s.filter((x) => x !== lastNotice.id)), 6000);
    return () => clearTimeout(t);
  }, [lastNotice]);

  const visible = useMemo(
    () => approvals.filter((a) => !dismissed.has(a.requestId) && !(selected === a.sessionId && panelTab === "approvals")).slice(0, 3),
    [approvals, dismissed, selected, panelTab],
  );
  const noticeItems = notices.filter((n) => shownNotices.includes(n.id));

  return (
    <>
    <div className="pointer-events-none fixed bottom-4 left-4 z-40 flex w-[min(460px,92vw)] flex-col-reverse gap-2.5" aria-live="polite">
      {visible.map((a) => {
        const s = sessions[a.sessionId];
        return (
          <div key={a.requestId} className="pointer-events-auto rounded-2xl border border-amber/50 bg-surface-2 p-4 shadow-[0_20px_40px_-18px_rgb(40_30_10/0.35)] enter">
            <div className="flex items-start gap-2.5">
              <div className="grid size-7 shrink-0 place-items-center rounded-lg bg-amber/15 text-amber"><ShieldQuestion className="size-4" /></div>
              <div className="min-w-0 flex-1">
                <div className="flex items-center gap-2">
                  <span className="text-[13.5px] font-semibold">{a.toolName}</span>
                  <span className={cn("text-[11px]", a.account === "work" ? "text-work" : "text-personal")}>{ACCOUNT_LABEL[a.account]}</span>
                </div>
                <button onClick={() => openSession(a.sessionId, "approvals")} className="block w-full truncate text-left text-[12px] text-muted hover:text-fg-2">
                  {s?.title ?? a.sessionId.slice(0, 8)} · {s?.repoName}
                </button>
                <div className="mt-2 rounded-lg border border-line bg-bg px-2.5 py-1.5 font-mono text-[12px] leading-relaxed text-fg"><span className="line-clamp-3 break-all">{truncate(approvalSummary(a), 400)}</span></div>
              </div>
              <button aria-label="Dispensar" onClick={() => setDismissed((d) => new Set(d).add(a.requestId))} className="rounded p-0.5 text-muted hover:text-fg"><X className="size-3.5" /></button>
            </div>
            <div className="mt-2.5">
              {a.toolName === "AskUserQuestion" ? (
                <button onClick={() => openSession(a.sessionId, "approvals")} className="text-xs text-cyan hover:underline">Responder pergunta →</button>
              ) : (
                <ApprovalActions approval={a} compact />
              )}
            </div>
          </div>
        );
      })}
    </div>
    <div className="pointer-events-none fixed right-4 top-16 z-30 flex w-[360px] flex-col gap-2">
      {noticeItems.map((n) => (
        <div key={n.id} className={cn("pointer-events-auto rounded-xl border bg-surface-2 px-3 py-2.5 text-xs shadow-[0_18px_40px_-18px_rgb(40_30_10/0.3)] enter", n.level === "error" ? "border-red/40 text-red" : "border-amber/40 text-amber")}>
          {truncate(n.text, 200)}
        </div>
      ))}
    </div>
    <ZoomBadge />
    </>
  );
}

/** Brief "110%" pill when the UI zoom changes. */
function ZoomBadge() {
  const [z, setZ] = useState<number | null>(null);
  useEffect(() => {
    let t: ReturnType<typeof setTimeout> | undefined;
    const on = (e: Event) => {
      setZ((e as CustomEvent<number>).detail);
      clearTimeout(t);
      t = setTimeout(() => setZ(null), 1200);
    };
    window.addEventListener("ccc-zoom", on);
    return () => { window.removeEventListener("ccc-zoom", on); clearTimeout(t); };
  }, []);
  if (z == null) return null;
  return (
    <div className="pointer-events-none fixed left-1/2 top-16 z-50 flex -translate-x-1/2 items-center gap-1.5 rounded-full border border-line-2 bg-surface-2 px-3 py-1.5 text-xs text-fg shadow-lg enter">
      <ZoomIn className="size-3.5 text-cyan" />{Math.round(z * 100)}%
    </div>
  );
}
