import { invoke } from "@tauri-apps/api/core";
import type {
  AccountConfig, AccountId, ApprovalDecision, AuthStatus, ChatItem, ExternalSession, McpServer, MetricsSnapshot,
  NewSession, PermissionMode, Overview, Project, RepoInfo, RepoStatus, SessionDetail, SessionSummary, Settings, TaskItem,
} from "./contract";

// Thin typed wrappers. Tauri maps camelCase keys to snake_case Rust params.
export const api = {
  getOverview: () => invoke<Overview>("get_overview"),
  refreshAuth: (account: AccountId) => invoke<AuthStatus>("refresh_auth", { account }),
  startLogin: (account: AccountId) => invoke<void>("start_login", { account }),
  loginInput: (account: AccountId, text: string) => invoke<void>("login_input", { account, text }),
  cancelLogin: (account: AccountId) => invoke<void>("cancel_login", { account }),

  listRepos: (account: AccountId, refresh = false) => invoke<RepoInfo[]>("list_repos", { account, refresh }),
  repoStatus: (account: AccountId, repo: string) => invoke<RepoStatus>("repo_status", { account, repo }),
  repoDiff: (account: AccountId, repo: string, file?: string | null) =>
    invoke<string>("repo_diff", { account, repo, file: file ?? null }),
  createWorktree: (account: AccountId, repo: string, name: string) =>
    invoke<RepoInfo>("create_worktree", { account, repo, name }),

  listSessions: (account?: AccountId | null) => invoke<SessionSummary[]>("list_sessions", { account: account ?? null }),
  createSession: (account: AccountId, req: NewSession) => invoke<SessionSummary>("create_session", { account, req }),
  sendMessage: (account: AccountId, sessionId: string, text: string) =>
    invoke<void>("send_message", { account, sessionId, text }),
  respondApproval: (account: AccountId, sessionId: string, requestId: string, decision: ApprovalDecision) =>
    invoke<void>("respond_approval", { account, sessionId, requestId, decision }),
  interruptSession: (account: AccountId, sessionId: string) => invoke<void>("interrupt_session", { account, sessionId }),
  stopSession: (account: AccountId, sessionId: string) => invoke<void>("stop_session", { account, sessionId }),
  archiveSession: (account: AccountId, sessionId: string) => invoke<void>("archive_session", { account, sessionId }),
  deleteSession: (account: AccountId, sessionId: string) => invoke<void>("delete_session", { account, sessionId }),
  setPermissionMode: (account: AccountId, sessionId: string, mode: PermissionMode) =>
    invoke<void>("set_permission_mode", { account, sessionId, mode }),
  setSessionPriority: (account: AccountId, sessionId: string, priority: number) =>
    invoke<void>("set_session_priority", { account, sessionId, priority }),
  getSession: (account: AccountId, sessionId: string) => invoke<SessionDetail>("get_session", { account, sessionId }),
  getChat: (account: AccountId, sessionId: string, beforeSeq: number | null, limit: number) =>
    invoke<ChatItem[]>("get_chat", { account, sessionId, beforeSeq, limit }),

  updateSettings: (settings: Settings) => invoke<Overview>("update_settings", { settings }),
  updateAccount: (config: AccountConfig) => invoke<Overview>("update_account", { config }),
  getMetrics: () => invoke<MetricsSnapshot>("get_metrics"),
  setUiVisible: (visible: boolean) => invoke<void>("set_ui_visible", { visible }),

  listTasks: (account: AccountId, repo?: string | null) => invoke<TaskItem[]>("list_tasks", { account, repo: repo ?? null }),
  createTask: (account: AccountId, repo: string, title: string, prompt: string, priority: number) =>
    invoke<TaskItem>("create_task", { account, repo, title, prompt, priority }),
  updateTask: (account: AccountId, task: TaskItem) => invoke<void>("update_task", { account, task }),
  deleteTask: (account: AccountId, taskId: string) => invoke<void>("delete_task", { account, taskId }),
  runTask: (account: AccountId, taskId: string) => invoke<SessionSummary>("run_task", { account, taskId }),

  listExternalSessions: (account: AccountId, repo: string) =>
    invoke<ExternalSession[]>("list_external_sessions", { account, repo }),
  importExternalSession: (account: AccountId, repo: string, id: string) =>
    invoke<SessionSummary>("import_external_session", { account, repo, id }),

  listProjects: (account: AccountId) => invoke<Project[]>("list_projects", { account }),
  saveProject: (account: AccountId, project: Project) => invoke<Project>("save_project", { account, project }),
  deleteProject: (account: AccountId, projectId: string) => invoke<void>("delete_project", { account, projectId }),

  mcpList: (account: AccountId) => invoke<McpServer[]>("mcp_list", { account }),
  mcpAdd: (account: AccountId, name: string, config: Record<string, unknown>) =>
    invoke<McpServer[]>("mcp_add", { account, name, config }),
  mcpRemove: (account: AccountId, name: string) => invoke<McpServer[]>("mcp_remove", { account, name }),
  mcpLogin: (account: AccountId, name: string) => invoke<void>("mcp_login", { account, name }),
  mcpLoginInput: (account: AccountId, name: string, text: string) => invoke<void>("mcp_login_input", { account, name, text }),
  mcpLoginCancel: (account: AccountId, name: string) => invoke<void>("mcp_login_cancel", { account, name }),
  openExternal: (url: string) => invoke<void>("open_external", { url }),
};
