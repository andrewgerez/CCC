//! IPC contract shared with the frontend (mirrored in src/lib/contract.ts).
use crate::accounts::{AccountConfig, AccountId, PermissionMode};
use serde::{Deserialize, Serialize};
use serde_json::Value;

pub fn now_ms() -> i64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_millis() as i64)
        .unwrap_or(0)
}

#[derive(Serialize, Deserialize, Clone, Copy, PartialEq, Eq, Debug)]
#[serde(rename_all = "snake_case")]
pub enum SessionStatus {
    /// Waiting for a global concurrency slot.
    Queued,
    Starting,
    /// A turn is executing.
    Running,
    AwaitingApproval,
    /// Process alive, turn finished, waiting for the next user message.
    WaitingInput,
    /// No process. Persisted and resumable via `--resume`.
    Idle,
    Error,
    Interrupted,
    /// Refused to start: authentication/identity not verified.
    Blocked,
    Archived,
}

impl SessionStatus {
    pub fn as_str(self) -> &'static str {
        match self {
            SessionStatus::Queued => "queued",
            SessionStatus::Starting => "starting",
            SessionStatus::Running => "running",
            SessionStatus::AwaitingApproval => "awaiting_approval",
            SessionStatus::WaitingInput => "waiting_input",
            SessionStatus::Idle => "idle",
            SessionStatus::Error => "error",
            SessionStatus::Interrupted => "interrupted",
            SessionStatus::Blocked => "blocked",
            SessionStatus::Archived => "archived",
        }
    }
    pub fn parse(s: &str) -> SessionStatus {
        match s {
            "queued" => SessionStatus::Queued,
            "starting" => SessionStatus::Starting,
            "running" => SessionStatus::Running,
            "awaiting_approval" => SessionStatus::AwaitingApproval,
            "waiting_input" => SessionStatus::WaitingInput,
            "error" => SessionStatus::Error,
            "interrupted" => SessionStatus::Interrupted,
            "blocked" => SessionStatus::Blocked,
            "archived" => SessionStatus::Archived,
            _ => SessionStatus::Idle,
        }
    }
    pub fn is_live(self) -> bool {
        matches!(
            self,
            SessionStatus::Queued
                | SessionStatus::Starting
                | SessionStatus::Running
                | SessionStatus::AwaitingApproval
                | SessionStatus::WaitingInput
        )
    }
}

#[derive(Serialize, Deserialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct SessionSummary {
    pub id: String,
    pub account: AccountId,
    pub repo_path: String,
    pub repo_name: String,
    pub worktree_path: Option<String>,
    pub title: String,
    pub status: SessionStatus,
    pub model: Option<String>,
    pub permission_mode: PermissionMode,
    pub priority: i32,
    pub created_at: i64,
    pub updated_at: i64,
    pub last_activity: Option<String>,
    pub total_cost_usd: f64,
    pub input_tokens: i64,
    pub output_tokens: i64,
    pub turns: i64,
    pub pending_approvals: i64,
    pub last_error: Option<String>,
    pub pid: Option<i64>,
    /// True once the CLI has persisted a transcript (resume supported).
    pub resumable: bool,
    /// Additional directories (same account workspace) passed via --add-dir.
    #[serde(default)]
    pub extra_dirs: Vec<String>,
}

#[derive(Serialize, Deserialize, Clone, Copy, PartialEq, Eq, Debug)]
#[serde(rename_all = "snake_case")]
pub enum AgentStatus {
    Running,
    Tool,
    AwaitingApproval,
    Done,
    Error,
    Idle,
    Unknown,
}

impl AgentStatus {
    pub fn as_str(self) -> &'static str {
        match self {
            AgentStatus::Running => "running",
            AgentStatus::Tool => "tool",
            AgentStatus::AwaitingApproval => "awaiting_approval",
            AgentStatus::Done => "done",
            AgentStatus::Error => "error",
            AgentStatus::Idle => "idle",
            AgentStatus::Unknown => "unknown",
        }
    }
    pub fn parse(s: &str) -> AgentStatus {
        match s {
            "running" => AgentStatus::Running,
            "tool" => AgentStatus::Tool,
            "awaiting_approval" => AgentStatus::AwaitingApproval,
            "done" => AgentStatus::Done,
            "error" => AgentStatus::Error,
            "idle" => AgentStatus::Idle,
            _ => AgentStatus::Unknown,
        }
    }
}

#[derive(Serialize, Deserialize, Clone, Debug, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct AgentNode {
    pub id: String,
    pub session_id: String,
    /// None for the orchestrator. Only set from observed events
    /// (task_started.tool_use_id / hook agent_id), never inferred.
    pub parent_id: Option<String>,
    pub kind: String, // "orchestrator" | "subagent"
    pub name: String,
    pub description: Option<String>,
    pub status: AgentStatus,
    pub current_tool: Option<String>,
    pub activity: Option<String>,
    pub started_at: i64,
    pub ended_at: Option<i64>,
    pub tool_uses: i64,
    pub tokens: Option<i64>,
    pub tool_use_id: Option<String>,
}

#[derive(Serialize, Deserialize, Clone, Debug)]
#[serde(tag = "kind", rename_all = "snake_case")]
pub enum ChatBody {
    UserText {
        text: String,
        /// Small data-URL previews of pasted images (the full images only go to Claude).
        #[serde(default, skip_serializing_if = "Vec::is_empty")]
        images: Vec<String>,
    },
    #[serde(rename_all = "camelCase")]
    AssistantText { message_id: String, text: String },
    #[serde(rename_all = "camelCase")]
    ToolUse { tool_use_id: String, name: String, input: String },
    #[serde(rename_all = "camelCase")]
    ToolResult { tool_use_id: String, content: String, is_error: bool },
    #[serde(rename_all = "camelCase")]
    TurnResult {
        cost_usd: f64,
        duration_ms: i64,
        input_tokens: i64,
        output_tokens: i64,
        cache_read: i64,
        cache_write: i64,
        is_error: bool,
        num_turns: i64,
        subtype: String,
    },
    System { text: String, level: String },
    #[serde(rename_all = "camelCase")]
    Approval { request_id: String, tool_name: String, summary: String, decision: Option<String> },
}

#[derive(Serialize, Deserialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct ChatItem {
    pub seq: i64,
    pub session_id: String,
    pub ts: i64,
    pub agent_id: Option<String>,
    pub body: ChatBody,
}

#[derive(Serialize, Deserialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct Approval {
    pub request_id: String,
    pub session_id: String,
    pub account: AccountId,
    pub agent_id: Option<String>,
    pub tool_name: String,
    pub tool_use_id: Option<String>,
    pub input: Value,
    pub description: Option<String>,
    pub suggestions: Value,
    pub created_at: i64,
}

#[derive(Serialize, Deserialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct ApprovalDecision {
    pub behavior: String, // "allow" | "deny"
    pub message: Option<String>,
    /// For AskUserQuestion etc: replacement tool input.
    pub updated_input: Option<Value>,
    /// Apply the CLI's permission suggestions for the rest of this session.
    #[serde(default)]
    pub remember: bool,
}

#[derive(Serialize, Deserialize, Clone, Copy, PartialEq, Eq, Debug)]
#[serde(rename_all = "snake_case")]
pub enum AuthState {
    Unknown,
    Checking,
    Verified,
    Mismatch,
    LoggedOut,
    Error,
}

#[derive(Serialize, Deserialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct AuthStatus {
    pub account: AccountId,
    pub state: AuthState,
    pub email: Option<String>,
    pub expected_email: String,
    pub org_name: Option<String>,
    pub subscription: Option<String>,
    pub expires_at: Option<String>,
    pub checked_at: i64,
    pub message: Option<String>,
}

#[derive(Serialize, Deserialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct Settings {
    pub max_concurrent: u32,
    pub idle_timeout_secs: u32,
    pub sandbox_enforce: bool,
    pub event_retention_per_session: u32,
    pub include_partial_messages: bool,
}

impl Default for Settings {
    fn default() -> Self {
        Settings {
            max_concurrent: 2,
            idle_timeout_secs: 45,
            sandbox_enforce: true,
            event_retention_per_session: 5000,
            include_partial_messages: true,
        }
    }
}

#[derive(Serialize, Deserialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct AccountView {
    pub config: AccountConfig,
    pub auth: AuthStatus,
    pub warnings: Vec<String>,
    pub workspace_exists: bool,
    /// Model a session gets when none is picked: ccc's account default, else the
    /// `model` in the account's Claude Code settings.json. None = decided by the plan.
    pub default_model: Option<String>,
}

#[derive(Serialize, Deserialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct Overview {
    pub accounts: Vec<AccountView>,
    pub settings: Settings,
    pub landlock_abi: i64,
    pub claude_path: Option<String>,
    pub claude_version: Option<String>,
    pub config_error: Option<String>,
}

#[derive(Serialize, Deserialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct RepoInfo {
    pub path: String,
    pub name: String,
    pub rel_path: String,
    pub branch: Option<String>,
    pub is_worktree: bool,
}

#[derive(Serialize, Deserialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct FileChange {
    pub path: String,
    pub index: String,
    pub worktree: String,
}

#[derive(Serialize, Deserialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct RepoStatus {
    pub branch: Option<String>,
    pub upstream: Option<String>,
    pub ahead: i64,
    pub behind: i64,
    pub files: Vec<FileChange>,
    pub worktrees: Vec<String>,
}

#[derive(Serialize, Deserialize, Clone, Debug, Default)]
#[serde(rename_all = "camelCase")]
pub struct ProcStat {
    pub pid: i64,
    pub rss_bytes: i64,
    pub cpu_percent: f64,
    pub procs: i64,
}

#[derive(Serialize, Deserialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct SessionProc {
    pub session_id: String,
    pub account: AccountId,
    pub stat: ProcStat,
}

#[derive(Serialize, Deserialize, Clone, Debug, Default)]
#[serde(rename_all = "camelCase")]
pub struct SchedulerView {
    pub limit: u32,
    pub running: u32,
    pub queued_personal: u32,
    pub queued_work: u32,
}

#[derive(Serialize, Deserialize, Clone, Debug, Default)]
#[serde(rename_all = "camelCase")]
pub struct MetricsSnapshot {
    pub ts: i64,
    pub app: ProcStat,
    pub webview_rss_bytes: i64,
    pub sessions: Vec<SessionProc>,
    pub scheduler: SchedulerView,
}

#[derive(Serialize, Deserialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct TaskItem {
    pub id: String,
    pub account: AccountId,
    pub repo_path: String,
    pub title: String,
    pub prompt: String,
    pub priority: i32,
    pub status: String, // todo | running | done
    pub session_id: Option<String>,
    pub created_at: i64,
}

#[derive(Serialize, Deserialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct ExternalSession {
    pub id: String,
    pub title: String,
    pub updated_at: i64,
    pub size_bytes: i64,
}

#[derive(Serialize, Deserialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct NewSession {
    pub repo_path: String,
    pub prompt: String,
    pub title: Option<String>,
    pub model: Option<String>,
    pub permission_mode: Option<PermissionMode>,
    pub priority: Option<i32>,
    pub worktree_path: Option<String>,
    #[serde(default)]
    pub extra_dirs: Option<Vec<String>>,
    #[serde(default)]
    pub images: Vec<ImageInput>,
    /// UI thumbnails for the pasted images, stored in the chat history.
    #[serde(default)]
    pub thumbs: Vec<String>,
}

/// A pasted image: base64 payload plus its media type.
#[derive(Serialize, Deserialize, Clone, Debug, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct ImageInput {
    pub media_type: String,
    pub data: String,
}

/// One user turn: text plus optional images (and their UI thumbnails).
#[derive(Clone, Debug, Default, PartialEq)]
pub struct Prompt {
    pub text: String,
    pub images: Vec<ImageInput>,
    pub thumbs: Vec<String>,
}

impl From<String> for Prompt {
    fn from(text: String) -> Self {
        Prompt { text, ..Default::default() }
    }
}

pub const MAX_IMAGES: usize = 6;
const MAX_IMAGE_BYTES: usize = 5 * 1024 * 1024;
const MAX_THUMB_LEN: usize = 64 * 1024;
const IMAGE_TYPES: &[&str] = &["image/png", "image/jpeg", "image/gif", "image/webp"];

impl Prompt {
    /// Rejects anything Claude won't accept or that would bloat the pipe / history.
    pub fn validate(&self) -> Result<(), String> {
        if self.text.trim().is_empty() && self.images.is_empty() {
            return Err("mensagem vazia".into());
        }
        if self.text.len() > 200_000 {
            return Err("mensagem grande demais".into());
        }
        if self.images.len() > MAX_IMAGES || self.thumbs.len() > MAX_IMAGES {
            return Err(format!("no máximo {MAX_IMAGES} imagens por mensagem"));
        }
        for i in &self.images {
            if !IMAGE_TYPES.contains(&i.media_type.as_str()) {
                return Err(format!("formato de imagem não suportado: {}", i.media_type));
            }
            if i.data.len() / 4 * 3 > MAX_IMAGE_BYTES {
                return Err("imagem maior que 5 MB".into());
            }
            if i.data.is_empty() || !i.data.bytes().all(|b| b.is_ascii_alphanumeric() || b == b'+' || b == b'/' || b == b'=') {
                return Err("imagem inválida".into());
            }
        }
        for t in &self.thumbs {
            if t.len() > MAX_THUMB_LEN || !t.starts_with("data:image/") {
                return Err("miniatura inválida".into());
            }
        }
        Ok(())
    }
}

/// A named group of directories inside one account's workspace
/// (e.g. "Acme" = front + back + mobile). Stored in that account's DB only.
#[derive(Serialize, Deserialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct Project {
    #[serde(default)]
    pub id: String,
    pub name: String,
    pub dirs: Vec<String>,
    #[serde(default)]
    pub created_at: i64,
}

#[derive(Serialize, Deserialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct SessionDetail {
    pub session: SessionSummary,
    pub agents: Vec<AgentNode>,
    pub approvals: Vec<Approval>,
}

/// Events pushed to the UI in batches on the `ccc://events` channel.
#[derive(Serialize, Clone, Debug)]
#[serde(tag = "type", rename_all = "camelCase")]
pub enum UiEvent {
    SessionUpsert { session: SessionSummary },
    #[serde(rename_all = "camelCase")]
    SessionRemoved { account: AccountId, session_id: String },
    /// Progress of an MCP OAuth login: phase is "url" (opened in the browser), "done" or "error".
    McpLogin { account: AccountId, name: String, phase: String, text: String },
    #[serde(rename_all = "camelCase")]
    Chat { account: AccountId, item: ChatItem },
    #[serde(rename_all = "camelCase")]
    Delta { account: AccountId, session_id: String, agent_id: Option<String>, message_id: String, text: String },
    #[serde(rename_all = "camelCase")]
    AgentUpsert { account: AccountId, agent: AgentNode },
    Approval { approval: Approval },
    #[serde(rename_all = "camelCase")]
    ApprovalResolved { account: AccountId, session_id: String, request_id: String, decision: String },
    Auth { status: AuthStatus },
    AuthLog { account: AccountId, line: String },
    Metrics { snapshot: MetricsSnapshot },
    #[serde(rename_all = "camelCase")]
    Notice { level: String, text: String, account: Option<AccountId>, session_id: Option<String> },
}
