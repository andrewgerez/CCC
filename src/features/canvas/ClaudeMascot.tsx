import { memo } from "react";
import martelo from "../../assets/claudes/martelo.gif";
import typing from "../../assets/claudes/typing.gif";
import waiting from "../../assets/claudes/waiting.gif";
import type { AgentStatus, SessionStatus } from "../../lib/contract";
import { cn } from "../../lib/utils";
import { ClaudeFlag } from "./ClaudeFlag";

export type MascotState = "run" | "need" | "done" | "idle" | "error";
/** What a working Claude is doing right now. */
export type Activity = "typing" | "waiting";

export function sessionMascot(s: SessionStatus): MascotState {
  switch (s) {
    case "running": case "starting": return "run";
    case "awaiting_approval": case "waiting_input": return "need";
    case "archived": return "done";
    case "error": case "blocked": return "error";
    default: return "idle";
  }
}

export function agentMascot(s: AgentStatus): MascotState {
  switch (s) {
    case "running": case "tool": return "run";
    case "awaiting_approval": return "need";
    case "done": return "done";
    case "error": return "error";
    default: return "idle";
  }
}

export const ACTIVITY_LABEL: Record<Activity, string> = { typing: "trabalhando", waiting: "esperando subagente" };
const ACTIVITY_GIF: Record<Activity, string> = { typing, waiting };

/** Per-GIF framing so the whole sprite fits the tile, centred (measured sprite bounds: scale, then shift in tile %). */
export const GIF_FIT: Record<string, string> = {
  [typing]: "none",
  [waiting]: "translate(-1.2%, -5.8%) scale(1.15)",
  [martelo]: "translate(-11.9%, -44.2%) scale(1.7)",
};

type Badge = "need" | "idle" | "error";

/** Pixel Claude GIF for every state except "done" (which waves the flag); states without their own GIF get a small badge. */
export function gifFor(state: Exclude<MascotState, "done">, activity: Activity | null): { src: string; label: string; badge: Badge | null; dim: boolean } {
  switch (state) {
    case "run": { const a = activity ?? "typing"; return { src: ACTIVITY_GIF[a], label: ACTIVITY_LABEL[a], badge: null, dim: false }; }
    case "need": return { src: waiting, label: "esperando você", badge: "need", dim: false };
    case "error": return { src: martelo, label: "erro", badge: "error", dim: false };
    default: return { src: waiting, label: "parado", badge: "idle", dim: true };
  }
}

const BADGE: Record<Badge, { cls: string; text: string }> = {
  need: { cls: "bg-fg text-white mascot-hop", text: "!" },
  error: { cls: "bg-red text-white", text: "×" },
  idle: { cls: "bg-surface text-muted shadow-[0_0_0_1px_var(--color-line-2)]", text: "z" },
};

export const MASCOT_TILE: Record<MascotState, string> = {
  run: "bg-[#fbefe7]", need: "bg-[#fbefe7]", done: "bg-[#eef4ec]", idle: "bg-surface-3", error: "bg-[#f8e7e4]",
};

/** Pixel Claude GIF in a tinted tile; the GIF's white background is blended into the tile. */
export const ClaudeMascot = memo(function ClaudeMascot({
  state, activity = null, size = "md", className,
}: { state: MascotState; activity?: Activity | null; size?: "sm" | "md" | "lg"; className?: string }) {
  const box = size === "sm" ? "size-[34px] rounded-[11px]" : size === "md" ? "size-[46px] rounded-[14px]" : "size-20 rounded-[24px]";
  if (state === "done") {
    return (
      <div className={cn("relative shrink-0", box, MASCOT_TILE.done, className)}>
        <ClaudeFlag className="absolute -left-[8%] -top-[30%] size-[125%] overflow-visible" />
      </div>
    );
  }
  const g = gifFor(state, activity);
  const badge = g.badge ? BADGE[g.badge] : null;
  return (
    <div className={cn("relative shrink-0", className)}>
      <div className={cn("overflow-hidden", box, MASCOT_TILE[state])}>
        <img
          src={g.src}
          alt={g.label}
          draggable={false}
          style={{ transform: GIF_FIT[g.src] }}
          className={cn("size-full object-contain mix-blend-multiply", g.dim && "opacity-60 grayscale")}
        />
      </div>
      {badge && (
        <span
          aria-hidden
          className={cn(
            "absolute -right-1 -top-1 grid place-items-center rounded-full font-bold leading-none",
            size === "sm" ? "size-[14px] text-[9px]" : "size-[17px] text-[10.5px]",
            badge.cls,
          )}
        >
          {badge.text}
        </span>
      )}
    </div>
  );
});
