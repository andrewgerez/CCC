// Mirror of src-tauri/src/model.rs. Keep in sync.
export type AccountId = "personal" | "work";
export type PermissionMode = "auto" | "default" | "acceptEdits" | "plan";

export type SessionStatus =
  | "queued" | "starting" | "running" | "awaiting_approval" | "waiting_input"
  | "idle" | "error" | "interrupted" | "blocked" | "archived";

export const LIVE_STATUSES: SessionStatus[] = ["queued", "starting", "running", "awaiting_approval", "waiting_input"];

export interface SessionSummary {
  id: string;
  account: AccountId;
  repoPath: string;
  repoName: string;
  worktreePath: string | null;
  title: string;
  status: SessionStatus;
  model: string | null;
  permissionMode: PermissionMode;
  extraDirs?: string[];
  priority: number;
  createdAt: number;
  updatedAt: number;
  lastActivity: string | null;
  totalCostUsd: number;
  inputTokens: number;
  outputTokens: number;
  turns: number;
  pendingApprovals: number;
  lastError: string | null;
  pid: number | null;
  resumable: boolean;
}

export type AgentStatus = "running" | "tool" | "awaiting_approval" | "done" | "error" | "idle" | "unknown";

export interface AgentNode {
  id: string;
  sessionId: string;
  parentId: string | null;
  kind: "orchestrator" | "subagent";
  name: string;
  description: string | null;
  status: AgentStatus;
  currentTool: string | null;
  activity: string | null;
  startedAt: number;
  endedAt: number | null;
  toolUses: number;
  tokens: number | null;
  toolUseId: string | null;
}

export type ChatBody =
  | { kind: "user_text"; text: string }
  | { kind: "assistant_text"; messageId: string; text: string }
  | { kind: "tool_use"; toolUseId: string; name: string; input: string }
  | { kind: "tool_result"; toolUseId: string; content: string; isError: boolean }
  | {
      kind: "turn_result"; costUsd: number; durationMs: number; inputTokens: number; outputTokens: number;
      cacheRead: number; cacheWrite: number; isError: boolean; numTurns: number; subtype: string;
    }
  | { kind: "system"; text: string; level: "info" | "warn" | "error" }
  | { kind: "approval"; requestId: string; toolName: string; summary: string; decision: string | null };

export interface ChatItem {
  seq: number;
  sessionId: string;
  ts: number;
  agentId: string | null;
  body: ChatBody;
}

export interface Approval {
  requestId: string;
  sessionId: string;
  account: AccountId;
  agentId: string | null;
  toolName: string;
  toolUseId: string | null;
  input: unknown;
  description: string | null;
  suggestions: unknown;
  createdAt: number;
}

export interface ApprovalDecision {
  behavior: "allow" | "deny";
  message?: string | null;
  updatedInput?: unknown;
  remember?: boolean;
}

export type AuthState = "unknown" | "checking" | "verified" | "mismatch" | "logged_out" | "error";

export interface AuthStatus {
  account: AccountId;
  state: AuthState;
  email: string | null;
  expectedEmail: string;
  orgName: string | null;
  subscription: string | null;
  expiresAt: string | null;
  checkedAt: number;
  message: string | null;
}

export interface AccountConfig {
  id: AccountId;
  label: string;
  email: string;
  workspaceRoot: string;
  configDir: string;
  extraReadPaths: string[];
  extraWritePaths: string[];
  defaultModel: string | null;
  defaultPermissionMode: PermissionMode;
}

export interface Settings {
  maxConcurrent: number;
  idleTimeoutSecs: number;
  sandboxEnforce: boolean;
  eventRetentionPerSession: number;
  includePartialMessages: boolean;
}

export interface AccountView {
  config: AccountConfig;
  auth: AuthStatus;
  warnings: string[];
  workspaceExists: boolean;
}

export interface Overview {
  accounts: AccountView[];
  settings: Settings;
  landlockAbi: number;
  claudePath: string | null;
  claudeVersion: string | null;
  configError: string | null;
}

export interface RepoInfo { path: string; name: string; relPath: string; branch: string | null; isWorktree: boolean }
export interface FileChange { path: string; index: string; worktree: string }
export interface RepoStatus {
  branch: string | null; upstream: string | null; ahead: number; behind: number;
  files: FileChange[]; worktrees: string[];
}

export interface ProcStat { pid: number; rssBytes: number; cpuPercent: number; procs: number }
export interface SessionProc { sessionId: string; account: AccountId; stat: ProcStat }
export interface SchedulerView { limit: number; running: number; queuedPersonal: number; queuedWork: number }
export interface MetricsSnapshot {
  ts: number; app: ProcStat; webviewRssBytes: number; sessions: SessionProc[]; scheduler: SchedulerView;
}

export interface TaskItem {
  id: string; account: AccountId; repoPath: string; title: string; prompt: string;
  priority: number; status: "todo" | "running" | "done"; sessionId: string | null; createdAt: number;
}

export interface ExternalSession { id: string; title: string; updatedAt: number; sizeBytes: number }

export interface NewSession {
  repoPath: string; prompt: string; title?: string | null; model?: string | null;
  permissionMode?: PermissionMode | null; priority?: number | null; worktreePath?: string | null;
  extraDirs?: string[] | null;
}

/** Named group of directories in one account workspace; first dir is the session cwd. */
export interface Project { id: string; name: string; dirs: string[]; createdAt: number }

export interface SessionDetail { session: SessionSummary; agents: AgentNode[]; approvals: Approval[] }

export type UiEvent =
  | { type: "sessionUpsert"; session: SessionSummary }
  | { type: "sessionRemoved"; account: AccountId; sessionId: string }
  | { type: "chat"; account: AccountId; item: ChatItem }
  | { type: "delta"; account: AccountId; sessionId: string; agentId: string | null; messageId: string; text: string }
  | { type: "agentUpsert"; account: AccountId; agent: AgentNode }
  | { type: "approval"; approval: Approval }
  | { type: "approvalResolved"; account: AccountId; sessionId: string; requestId: string; decision: string }
  | { type: "auth"; status: AuthStatus }
  | { type: "authLog"; account: AccountId; line: string }
  | { type: "metrics"; snapshot: MetricsSnapshot }
  | { type: "notice"; level: "info" | "warn" | "error"; text: string; account: AccountId | null; sessionId: string | null };

/** User-scope MCP server of one account. Secret values never reach the UI, only their names. */
export interface McpServer { name: string; transport: "stdio" | "http" | "sse" | "ws"; target: string; secrets: string[] }

export const EVENTS_CHANNEL = "ccc://events";

export interface AppErrorPayload { code: string; message: string }
