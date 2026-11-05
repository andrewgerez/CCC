import { clsx, type ClassValue } from "clsx";
import { twMerge } from "tailwind-merge";
import type { AccountId, AgentStatus, SessionStatus } from "./contract";

export function cn(...inputs: ClassValue[]) {
  return twMerge(clsx(inputs));
}

/** Display names; defaults until the backend overview arrives, then synced from each account's configured label. */
export const ACCOUNT_LABEL: Record<AccountId, string> = { personal: "Pessoal", work: "Trabalho" };
export const ACCOUNT_TEXT: Record<AccountId, string> = { personal: "text-personal", work: "text-work" };
export const ACCOUNT_BG: Record<AccountId, string> = { personal: "bg-personal", work: "bg-work" };

export function fmtBytes(n: number | null | undefined): string {
  if (!n || n <= 0) return "—";
  const u = ["B", "KB", "MB", "GB"];
  let i = 0;
  let v = n;
  while (v >= 1024 && i < u.length - 1) { v /= 1024; i++; }
  return `${v >= 100 || i === 0 ? v.toFixed(0) : v.toFixed(1)} ${u[i]}`;
}

export function fmtTokens(n: number | null | undefined): string {
  if (n == null) return "—";
  if (n < 1000) return String(n);
  if (n < 1_000_000) return `${(n / 1000).toFixed(n < 10_000 ? 1 : 0)}k`;
  return `${(n / 1_000_000).toFixed(2)}M`;
}

export function fmtCost(n: number | null | undefined): string {
  if (!n) return "$0.00";
  return n < 0.01 ? `$${n.toFixed(4)}` : `$${n.toFixed(2)}`;
}

export function fmtDuration(ms: number): string {
  const s = Math.floor(Math.max(0, ms) / 1000);
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m ${s % 60}s`;
  return `${Math.floor(m / 60)}h ${m % 60}m`;
}

export function fmtRelative(ts: number, now = Date.now()): string {
  const s = Math.floor(Math.max(0, now - ts) / 1000);
  if (s < 45) return "agora";
  const m = Math.floor(s / 60);
  if (m < 60) return `há ${m} min`;
  const h = Math.floor(m / 60);
  if (h < 24) return `há ${h} h`;
  return `há ${Math.floor(h / 24)} d`;
}

export function fmtTime(ts: number): string {
  return new Date(ts).toLocaleTimeString("pt-BR", { hour: "2-digit", minute: "2-digit", second: "2-digit" });
}

export const SESSION_STATUS_LABEL: Record<SessionStatus, string> = {
  queued: "Na fila",
  starting: "Iniciando",
  running: "Executando",
  awaiting_approval: "Aguardando aprovação",
  waiting_input: "Aguardando você",
  idle: "Pausada",
  error: "Erro",
  interrupted: "Interrompida",
  blocked: "Bloqueada",
  archived: "Concluída",
};

export const AGENT_STATUS_LABEL: Record<AgentStatus, string> = {
  running: "Executando",
  tool: "Usando ferramenta",
  awaiting_approval: "Aguardando aprovação",
  done: "Concluído",
  error: "Erro",
  idle: "Inativo",
  unknown: "Estado não observável",
};

export type Tone = "cyan" | "blue" | "amber" | "green" | "red" | "slate" | "violet" | "unknown";

export function sessionTone(s: SessionStatus): Tone {
  switch (s) {
    case "running": case "starting": return "cyan";
    case "awaiting_approval": return "amber";
    case "waiting_input": return "violet";
    case "queued": return "blue";
    case "error": case "blocked": return "red";
    case "archived": return "green";
    default: return "slate";
  }
}

export function agentTone(s: AgentStatus): Tone {
  switch (s) {
    case "running": return "cyan";
    case "tool": return "blue";
    case "awaiting_approval": return "amber";
    case "done": return "green";
    case "error": return "red";
    case "idle": return "slate";
    default: return "unknown";
  }
}

export const TONE_TEXT: Record<Tone, string> = {
  cyan: "text-cyan", blue: "text-blue", amber: "text-amber", green: "text-green", red: "text-red",
  slate: "text-muted", violet: "text-violet", unknown: "text-dim",
};
export const TONE_BG: Record<Tone, string> = {
  cyan: "bg-cyan", blue: "bg-blue", amber: "bg-amber", green: "bg-green", red: "bg-red",
  slate: "bg-muted", violet: "bg-violet", unknown: "bg-dim",
};

export const isActiveAgent = (s: AgentStatus) => s === "running" || s === "tool" || s === "awaiting_approval";
export const isActiveSession = (s: SessionStatus) => s === "running" || s === "starting" || s === "awaiting_approval";

export function truncate(s: string, n: number) {
  return s.length > n ? `${s.slice(0, n)}…` : s;
}

export function errMessage(e: unknown): string {
  if (e && typeof e === "object" && "message" in e) return String((e as { message: unknown }).message);
  return String(e);
}
