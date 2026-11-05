//! One actor per live session. Owns the Claude CLI process, its stdin, the
//! approval table and the agent tracker. Processes exist only while needed:
//! after `idle_timeout` with no turn, no background tasks and no pending
//! approvals, stdin is closed and the process exits; the session stays
//! persisted and is resumed with `--resume <id>` on the next message.
use crate::accounts::AccountId;
use crate::error::{AppError, AppResult};
use crate::launch::{self, LaunchSpec};
use crate::model::*;
use crate::protocol::{self, Block, Parsed};
use crate::redact::redact;
use crate::state::AppState;
use crate::tracker::Tracker;
use serde_json::{json, Value};
use std::collections::HashMap;
use std::path::PathBuf;
use std::sync::Arc;
use std::time::Duration;
use tokio::io::{AsyncBufReadExt, AsyncWriteExt, BufReader};
use tokio::sync::mpsc;
use tokio::time::Instant;

const MAX_LINE: usize = 16 * 1024 * 1024;
const TOOL_INPUT_CAP: usize = 4 * 1024;
const TOOL_RESULT_CAP: usize = 8 * 1024;

#[derive(Debug)]
pub enum Cmd {
    Send(String),
    Approve { request_id: String, decision: ApprovalDecision },
    Interrupt,
    Stop,
    SetPriority(i32),
    SetMode(crate::accounts::PermissionMode),
}

#[derive(Clone)]
pub struct Handle {
    pub account: AccountId,
    pub tx: mpsc::Sender<Cmd>,
}

fn cap(s: &str, n: usize) -> String {
    if s.len() <= n {
        return s.to_string();
    }
    let mut cut = n;
    while !s.is_char_boundary(cut) {
        cut -= 1;
    }
    format!("{}\n… [{} bytes omitidos]", &s[..cut], s.len() - cut)
}

struct Pending {
    input: Value,
    suggestions: Value,
    agent_id: Option<String>,
    tool_use_id: Option<String>,
}

enum Exit {
    /// Prompts that arrived after stdin closed; run again with --resume.
    Leftover(Vec<String>),
    Done,
}

pub struct Actor {
    st: Arc<AppState>,
    account: AccountId,
    s: SessionSummary,
    tracker: Tracker,
    rx: mpsc::Receiver<Cmd>,
    db: Arc<crate::db::AccountDb>,
}

impl Actor {
    /// Starts an actor and registers its handle. Returns the handle.
    pub fn spawn(st: Arc<AppState>, account: AccountId, session_id: String, prompts: Vec<String>) -> AppResult<Handle> {
        let mut live = st.live.lock();
        if let Some(h) = live.get(&session_id) {
            return Ok(h.clone());
        }
        let db = st.db(account);
        let s = db.get_session(&session_id)?;
        let agents = db.list_agents(&session_id)?;
        let (tx, rx) = mpsc::channel(64);
        let h = Handle { account, tx };
        live.insert(session_id.clone(), h.clone());
        drop(live);
        let actor = Actor { st, account, tracker: Tracker::new(&session_id, agents), s, rx, db };
        tauri::async_runtime::spawn(actor.run(prompts));
        Ok(h)
    }

    async fn persist(&mut self) {
        self.s.updated_at = now_ms();
        if let Err(e) = self.db.upsert_session(&self.s) {
            tracing::error!("persist session: {e}");
        }
        self.st.emitter.send(UiEvent::SessionUpsert { session: self.s.clone() }).await;
    }

    async fn set_status(&mut self, status: SessionStatus, activity: Option<String>) {
        self.s.status = status;
        if activity.is_some() {
            self.s.last_activity = activity;
        }
        self.persist().await;
    }

    async fn chat(&mut self, agent_id: Option<String>, body: ChatBody) {
        let item = ChatItem { seq: self.db.next_seq(), session_id: self.s.id.clone(), ts: now_ms(), agent_id, body };
        self.db.push_event(&item);
        self.st.emitter.send(UiEvent::Chat { account: self.account, item }).await;
    }

    async fn agent(&mut self, a: AgentNode) {
        self.db.push_agent(&a);
        self.st.emitter.send(UiEvent::AgentUpsert { account: self.account, agent: a }).await;
    }

    async fn system(&mut self, level: &str, text: String) {
        self.chat(None, ChatBody::System { text: redact(&text), level: level.into() }).await;
    }

    async fn run(mut self, mut prompts: Vec<String>) {
        loop {
            match self.run_once(std::mem::take(&mut prompts)).await {
                Exit::Leftover(p) if !p.is_empty() => prompts = p,
                _ => break,
            }
        }
        self.db.flush();
        self.st.live.lock().remove(&self.s.id);
        let view = self.st.scheduler.view();
        self.st.emitter.try_send(UiEvent::Metrics { snapshot: MetricsSnapshot { scheduler: view, ts: now_ms(), ..Default::default() } });
    }

    async fn run_once(&mut self, mut prompts: Vec<String>) -> Exit {
        // ---- queue for a global slot ----
        self.set_status(SessionStatus::Queued, Some("na fila de execução".into())).await;
        let sched = self.st.scheduler.clone();
        let sid = self.s.id.clone();
        let acquire = sched.acquire(&sid, self.account, self.s.priority);
        tokio::pin!(acquire);
        let permit = loop {
            tokio::select! {
                p = &mut acquire => break p,
                cmd = self.rx.recv() => match cmd {
                    Some(Cmd::Send(t)) => prompts.push(t),
                    Some(Cmd::SetPriority(p)) => { self.s.priority = p; sched.set_priority(&sid, p); self.persist().await; }
                    Some(Cmd::SetMode(m)) => { self.s.permission_mode = m; self.persist().await; }
                    Some(Cmd::Stop) | None => {
                        self.set_status(SessionStatus::Idle, Some("removida da fila".into())).await;
                        return Exit::Done;
                    }
                    Some(_) => {}
                }
            }
        };
        if prompts.is_empty() {
            drop(permit);
            self.set_status(SessionStatus::Idle, None).await;
            return Exit::Done;
        }

        // ---- identity gate ----
        self.set_status(SessionStatus::Starting, Some("verificando identidade".into())).await;
        let auth = self.st.ensure_auth(self.account, false).await;
        if auth.state != AuthState::Verified {
            let msg = format!(
                "Execução bloqueada: conta {} não verificada ({}). Faça login com {}.",
                self.account.as_str(),
                auth.message.clone().unwrap_or_else(|| format!("{:?}", auth.state)),
                auth.expected_email
            );
            self.s.last_error = Some(msg.clone());
            self.system("error", msg).await;
            self.set_status(SessionStatus::Blocked, Some("bloqueada: autenticação".into())).await;
            return Exit::Done;
        }

        // ---- spawn ----
        let mut child = match self.spawn_process() {
            Ok(c) => c,
            Err(e) => {
                let m = format!("Falha ao iniciar Claude: {e}");
                self.s.last_error = Some(redact(&m));
                self.system("error", m).await;
                self.set_status(SessionStatus::Error, None).await;
                return Exit::Done;
            }
        };
        self.s.pid = child.id().map(|p| p as i64);
        self.s.last_error = None;
        let mut stdin = child.stdin.take();
        let stdout = child.stdout.take().expect("piped stdout");
        let stderr = child.stderr.take().expect("piped stderr");

        // stdout reader with backpressure (bounded channel)
        let (line_tx, mut line_rx) = mpsc::channel::<String>(256);
        tauri::async_runtime::spawn(async move {
            let mut r = BufReader::with_capacity(64 * 1024, stdout);
            let mut buf = Vec::with_capacity(64 * 1024);
            loop {
                buf.clear();
                match r.read_until(b'\n', &mut buf).await {
                    Ok(0) | Err(_) => break,
                    Ok(_) => {
                        if buf.len() > MAX_LINE {
                            continue;
                        }
                        if line_tx.send(String::from_utf8_lossy(&buf).into_owned()).await.is_err() {
                            break;
                        }
                    }
                }
            }
        });
        let (err_tx, mut err_rx) = mpsc::channel::<String>(64);
        tauri::async_runtime::spawn(async move {
            let mut lines = BufReader::new(stderr).lines();
            while let Ok(Some(l)) = lines.next_line().await {
                let _ = err_tx.try_send(l);
            }
        });

        let init_id = uuid::Uuid::new_v4().to_string();
        write_line(&mut stdin, protocol::initialize(&init_id)).await;

        let mut busy_turns = 0u32; // user messages written but not yet answered by a result
        for p in prompts.drain(..) {
            self.chat(None, ChatBody::UserText { text: p.clone() }).await;
            write_line(&mut stdin, protocol::user_message(&p)).await;
            busy_turns += 1;
        }
        let root = self.tracker.turn_started();
        self.agent(root).await;
        self.set_status(SessionStatus::Running, Some("executando".into())).await;

        let idle_timeout = Duration::from_secs(self.st.settings.read().idle_timeout_secs.max(5) as u64);
        let mut bg_tasks = 0usize;
        let mut pending: HashMap<String, Pending> = HashMap::new();
        let mut idle_since: Option<Instant> = None;
        let mut leftover: Vec<String> = vec![];
        let mut stopping = false;
        let mut user_stop = false;
        let mut interrupt_deadline: Option<Instant> = None;
        let mut kill_deadline: Option<Instant> = None;
        let mut saw_result_since_start = false;
        let mut stderr_tail: Vec<String> = vec![];
        let mut current_msg: HashMap<Option<String>, String> = HashMap::new();
        let (read_roots, write_roots) = launch::policy_roots(&self.writable_dirs(), &self.st.account_cfg(self.account));
        let base_cost = self.s.total_cost_usd;
        let _ = base_cost;

        let exit_status = loop {
            let idle_ready = !stopping && busy_turns == 0 && bg_tasks == 0 && pending.is_empty();
            if idle_ready && idle_since.is_none() {
                idle_since = Some(Instant::now());
            } else if !idle_ready {
                idle_since = None;
            }
            let idle_at = idle_since.map(|t| t + idle_timeout);
            let next_deadline = [idle_at, interrupt_deadline, kill_deadline].into_iter().flatten().min();

            tokio::select! {
                line = line_rx.recv() => {
                    let Some(line) = line else {
                        // stdout closed: wait for exit
                        break child.wait().await.ok();
                    };
                    let Some(parsed) = protocol::parse_line(&line) else { continue };
                    match parsed {
                        Parsed::Init { model, .. } => {
                            if !self.s.resumable || self.s.model.is_none() {
                                self.s.resumable = true;
                                if self.s.model.is_none() { self.s.model = model; }
                                self.persist().await;
                            }
                        }
                        Parsed::MessageStart { message_id, parent_tool_use_id } => {
                            current_msg.insert(parent_tool_use_id, message_id);
                        }
                        Parsed::TextDelta { parent_tool_use_id, text } => {
                            let mid = current_msg.get(&parent_tool_use_id).cloned().unwrap_or_default();
                            let agent_id = self.tracker.agent_for_parent_tool(parent_tool_use_id.as_deref());
                            self.st.emitter.try_send(UiEvent::Delta {
                                account: self.account, session_id: self.s.id.clone(), agent_id, message_id: mid, text,
                            });
                        }
                        Parsed::Assistant { message_id, parent_tool_use_id, blocks, .. } => {
                            let agent_id = self.tracker.agent_for_parent_tool(parent_tool_use_id.as_deref());
                            for b in blocks {
                                match b {
                                    Block::Text(t) if !t.trim().is_empty() => {
                                        self.chat(agent_id.clone(), ChatBody::AssistantText { message_id: message_id.clone(), text: t }).await;
                                    }
                                    Block::ToolUse { id, name, input } => {
                                        let pretty = serde_json::to_string_pretty(&input).unwrap_or_default();
                                        self.chat(agent_id.clone(), ChatBody::ToolUse { tool_use_id: id, name: name.clone(), input: redact(&cap(&pretty, TOOL_INPUT_CAP)) }).await;
                                        self.s.last_activity = Some(protocol::tool_summary(&name, &input));
                                    }
                                    _ => {}
                                }
                            }
                        }
                        Parsed::ToolResults { parent_tool_use_id, results } => {
                            let agent_id = self.tracker.agent_for_parent_tool(parent_tool_use_id.as_deref());
                            for (id, content, is_error) in results {
                                self.chat(agent_id.clone(), ChatBody::ToolResult { tool_use_id: id, content: redact(&cap(&content, TOOL_RESULT_CAP)), is_error }).await;
                            }
                        }
                        Parsed::UserEcho { .. } | Parsed::Other(_) | Parsed::ControlResponse { .. } => {}
                        Parsed::Thinking => {
                            if let Some(a) = self.tracker.thinking() { self.agent(a).await; }
                        }
                        Parsed::TaskStarted { task_id, tool_use_id, description, subagent_type } => {
                            let a = self.tracker.task_started(&task_id, tool_use_id.as_deref(), description, subagent_type);
                            self.agent(a).await;
                        }
                        Parsed::TaskProgress { task_id, description, last_tool, tokens, tool_uses } => {
                            if let Some(a) = self.tracker.task_progress(&task_id, description, last_tool, tokens, tool_uses) {
                                self.agent(a).await;
                            }
                        }
                        Parsed::TaskUpdated { task_id, status } => {
                            if let Some(a) = status.and_then(|s| self.tracker.task_status(&task_id, &s)) {
                                self.agent(a).await;
                            }
                        }
                        Parsed::BackgroundTasks { count } => bg_tasks = count,
                        Parsed::RateLimit { status, resets_at } => {
                            if status != "allowed" {
                                self.system("warn", format!("Limite de uso: {status}{}", resets_at.map(|r| format!(" (reset {r})")).unwrap_or_default())).await;
                            }
                        }
                        Parsed::Result(r) => {
                            saw_result_since_start = true;
                            busy_turns = busy_turns.saturating_sub(1);
                            interrupt_deadline = None;
                            self.s.total_cost_usd += r.cost_usd;
                            self.s.input_tokens += r.input_tokens + r.cache_read + r.cache_write;
                            self.s.output_tokens += r.output_tokens;
                            self.s.turns += r.num_turns.max(1);
                            if r.is_error {
                                let t = r.text.clone().unwrap_or_else(|| r.subtype.clone());
                                if looks_like_auth_error(&t) { self.st.invalidate_auth(self.account); }
                                self.s.last_error = Some(redact(&cap(&t, 500)));
                            }
                            self.chat(None, ChatBody::TurnResult {
                                cost_usd: r.cost_usd, duration_ms: r.duration_ms, input_tokens: r.input_tokens + r.cache_read + r.cache_write,
                                output_tokens: r.output_tokens, cache_read: r.cache_read, cache_write: r.cache_write,
                                is_error: r.is_error, num_turns: r.num_turns, subtype: r.subtype.clone(),
                            }).await;
                            let a = self.tracker.turn_ended(r.is_error);
                            self.agent(a).await;
                            let st = if busy_turns > 0 { SessionStatus::Running }
                                     else if !pending.is_empty() { SessionStatus::AwaitingApproval }
                                     else { SessionStatus::WaitingInput };
                            let act = if bg_tasks > 0 { format!("{bg_tasks} subagente(s) em segundo plano") } else { "aguardando mensagem".into() };
                            self.set_status(st, Some(act)).await;
                        }
                        Parsed::ControlRequest { request_id, subtype, request } => {
                            self.on_control(&mut stdin, &mut pending, request_id, subtype, request, &read_roots, &write_roots).await;
                        }
                        Parsed::RateLimit { .. } => {}
                    }
                }
                Some(l) = err_rx.recv() => {
                    let l = redact(&l);
                    if looks_like_auth_error(&l) { self.st.invalidate_auth(self.account); }
                    tracing::debug!(target: "claude_stderr", "{}", l);
                    stderr_tail.push(l);
                    if stderr_tail.len() > 20 { stderr_tail.remove(0); }
                }
                cmd = self.rx.recv() => match cmd {
                    Some(Cmd::Send(t)) => {
                        if stdin.is_some() && !stopping {
                            self.chat(None, ChatBody::UserText { text: t.clone() }).await;
                            write_line(&mut stdin, protocol::user_message(&t)).await;
                            busy_turns += 1;
                            let a = self.tracker.turn_started();
                            self.agent(a).await;
                            self.set_status(SessionStatus::Running, Some("executando".into())).await;
                        } else {
                            leftover.push(t);
                        }
                    }
                    Some(Cmd::Approve { request_id, decision }) => {
                        self.resolve(&mut stdin, &mut pending, &request_id, decision).await;
                    }
                    Some(Cmd::Interrupt) => {
                        if busy_turns > 0 || !pending.is_empty() {
                            write_line(&mut stdin, protocol::interrupt(&uuid::Uuid::new_v4().to_string())).await;
                            interrupt_deadline = Some(Instant::now() + Duration::from_secs(10));
                            self.system("info", "Interrupção solicitada".into()).await;
                        }
                    }
                    Some(Cmd::SetPriority(p)) => { self.s.priority = p; self.persist().await; }
                    Some(Cmd::SetMode(m)) => {
                        self.s.permission_mode = m;
                        self.persist().await;
                        if stdin.is_some() && !stopping {
                            write_line(&mut stdin, protocol::set_permission_mode(&uuid::Uuid::new_v4().to_string(), m.cli_value())).await;
                            self.system("info", format!("Modo de permissão: {}", m.cli_value())).await;
                        }
                    }
                    Some(Cmd::Stop) | None => {
                        user_stop = true;
                        stopping = true;
                        for (rid, _) in pending.drain() {
                            write_line(&mut stdin, protocol::success(&rid, protocol::permission_deny("Sessão encerrada pelo usuário"))).await;
                            let _ = self.db.resolve_approval(&rid, "expired");
                        }
                        stdin = None; // graceful: EOF lets the CLI exit
                        kill_deadline = Some(Instant::now() + Duration::from_secs(5));
                    }
                },
                _ = async { match next_deadline { Some(d) => tokio::time::sleep_until(d).await, None => std::future::pending().await } } => {
                    let now = Instant::now();
                    if let Some(d) = kill_deadline { if now >= d {
                        signal_group(&child, nix::sys::signal::Signal::SIGTERM);
                        kill_deadline = None;
                        tokio::time::sleep(Duration::from_secs(3)).await;
                        signal_group(&child, nix::sys::signal::Signal::SIGKILL);
                        break child.wait().await.ok();
                    }}
                    if let Some(d) = interrupt_deadline { if now >= d {
                        interrupt_deadline = None;
                        self.system("warn", "CLI não respondeu à interrupção; encerrando processo".into()).await;
                        stopping = true;
                        stdin = None;
                        kill_deadline = Some(Instant::now());
                    }}
                    if let Some(i) = idle_at { if now >= i && !stopping {
                        // Idle: release process + slot; session stays resumable.
                        stopping = true;
                        stdin = None;
                        kill_deadline = Some(Instant::now() + Duration::from_secs(10));
                    }}
                }
            }
        };

        // ---- process exited ----
        drop(permit);
        let code = exit_status.and_then(|s| s.code());
        let clean = code == Some(0) || (stopping && saw_result_since_start) || user_stop;
        for a in self.tracker.process_ended(clean) {
            self.agent(a).await;
        }
        let _ = self.db.expire_approvals(&self.s.id);
        self.s.pid = None;
        while let Ok(cmd) = self.rx.try_recv() {
            if let Cmd::Send(t) = cmd {
                leftover.push(t);
            }
        }
        if clean {
            let act = if user_stop { "encerrada pelo usuário" } else { "ociosa — processo liberado, retomável" };
            self.set_status(SessionStatus::Idle, Some(act.into())).await;
        } else {
            let tail = stderr_tail.join("\n");
            let msg = format!("Processo Claude terminou inesperadamente (código {:?}). {}", code, cap(&tail, 1500));
            self.s.last_error = Some(redact(&cap(&msg, 600)));
            self.system("error", msg).await;
            self.set_status(SessionStatus::Error, None).await;
        }
        if leftover.is_empty() { Exit::Done } else { Exit::Leftover(leftover) }
    }

    fn writable_dirs(&self) -> Vec<PathBuf> {
        let mut w = vec![PathBuf::from(&self.s.repo_path)];
        if let Some(wt) = &self.s.worktree_path {
            w.push(PathBuf::from(wt));
        }
        w.extend(self.s.extra_dirs.iter().map(PathBuf::from));
        w
    }

    fn spawn_process(&self) -> AppResult<tokio::process::Child> {
        let (acc, other) = self.st.account_pair(self.account)?;
        let claude = self.st.claude.clone().ok_or_else(|| AppError::Process("claude CLI não encontrado".into()))?;
        let settings = self.st.settings.read().clone();
        let cwd = PathBuf::from(self.s.worktree_path.clone().unwrap_or_else(|| self.s.repo_path.clone()));
        // Re-validate on every spawn: the repo may have been replaced by a symlink.
        crate::paths::validate_repo(&acc, &other, &self.s.repo_path)?;
        if let Some(wt) = &self.s.worktree_path {
            let real = std::path::Path::new(wt).canonicalize().map_err(|_| AppError::Path("worktree ausente".into()))?;
            let base = crate::paths::normalize(&self.st.data.worktrees(&acc));
            if !real.starts_with(&base) {
                return Err(AppError::Isolation("worktree fora da área da conta".into()));
            }
        }
        let mut args: Vec<String> = [
            "-p", "--output-format", "stream-json", "--input-format", "stream-json", "--verbose",
            "--permission-prompt-tool", "stdio", "--permission-mode", self.s.permission_mode.cli_value(),
        ]
        .iter()
        .map(|s| s.to_string())
        .collect();
        if settings.include_partial_messages {
            args.push("--include-partial-messages".into());
        }
        if let Some(m) = self.s.model.as_ref().or(acc.default_model.as_ref()) {
            if m.chars().all(|c| c.is_ascii_alphanumeric() || c == '-' || c == '.' || c == '[' || c == ']') {
                args.extend(["--model".into(), m.clone()]);
            }
        }
        for d in &self.s.extra_dirs {
            // Re-validate each extra dir on every spawn (symlink swaps).
            let real = crate::paths::validate_repo(&acc, &other, d)?;
            args.extend(["--add-dir".into(), real.display().to_string()]);
        }
        if self.s.resumable {
            args.extend(["--resume".into(), self.s.id.clone()]);
        } else {
            args.extend(["--session-id".into(), self.s.id.clone()]);
        }
        let spec = LaunchSpec {
            account: &acc,
            other: &other,
            claude: &claude,
            data: &self.st.data,
            enforce: settings.sandbox_enforce,
            writable: self.writable_dirs(),
            cwd,
            args,
            run_id: format!("{}:{}", self.account.as_str(), self.s.id),
        };
        let mut cmd = launch::command(&spec)?;
        Ok(cmd.spawn()?)
    }

    #[allow(clippy::too_many_arguments)]
    async fn on_control(
        &mut self,
        stdin: &mut Option<tokio::process::ChildStdin>,
        pending: &mut HashMap<String, Pending>,
        request_id: String,
        subtype: String,
        req: Value,
        read_roots: &[PathBuf],
        write_roots: &[PathBuf],
    ) {
        let str_of = |v: &Value, k: &str| v.get(k).and_then(|x| x.as_str()).map(str::to_string);
        match subtype.as_str() {
            "can_use_tool" => {
                let tool = str_of(&req, "tool_name").unwrap_or_default();
                let input = req.get("input").cloned().unwrap_or(Value::Null);
                let agent_id = str_of(&req, "agent_id");
                let tool_use_id = str_of(&req, "tool_use_id");
                if let Some(reason) = path_violation(&tool, &input, &self.cwd(), read_roots, write_roots) {
                    write_line(stdin, protocol::success(&request_id, protocol::permission_deny(&reason))).await;
                    self.system("warn", format!("Negado automaticamente ({tool}): {reason}")).await;
                    return;
                }
                let approval = Approval {
                    request_id: request_id.clone(),
                    session_id: self.s.id.clone(),
                    account: self.account,
                    agent_id: agent_id.clone(),
                    tool_name: tool.clone(),
                    tool_use_id: tool_use_id.clone(),
                    input: input.clone(),
                    description: str_of(&req, "description"),
                    suggestions: req.get("permission_suggestions").cloned().unwrap_or(json!([])),
                    created_at: now_ms(),
                };
                let _ = self.db.insert_approval(&approval);
                pending.insert(request_id.clone(), Pending {
                    input: input.clone(),
                    suggestions: approval.suggestions.clone(),
                    agent_id: agent_id.clone(),
                    tool_use_id: tool_use_id.clone(),
                });
                let a = self.tracker.awaiting(agent_id.as_deref(), tool_use_id.as_deref(), &tool);
                self.agent(a).await;
                self.chat(agent_id, ChatBody::Approval { request_id, tool_name: tool.clone(), summary: protocol::tool_summary(&tool, &input), decision: None }).await;
                self.st.emitter.send(UiEvent::Approval { approval }).await;
                self.s.pending_approvals = pending.len() as i64;
                self.set_status(SessionStatus::AwaitingApproval, Some(format!("aguardando aprovação: {tool}"))).await;
            }
            "hook_callback" => {
                let cb = str_of(&req, "callback_id").unwrap_or_default();
                let input = req.get("input").cloned().unwrap_or(Value::Null);
                let agent_id = str_of(&input, "agent_id");
                let mut response = json!({});
                match cb.trim_start_matches("ccc_") {
                    "PreToolUse" => {
                        let tool = str_of(&input, "tool_name").unwrap_or_default();
                        let tin = input.get("tool_input").cloned().unwrap_or(Value::Null);
                        let tu = str_of(&input, "tool_use_id");
                        if let Some(reason) = path_violation(&tool, &tin, &self.cwd(), read_roots, write_roots) {
                            response = protocol::pre_tool_deny(&reason);
                        }
                        let summary = protocol::tool_summary(&tool, &tin);
                        let a = self.tracker.pre_tool(agent_id.as_deref(), tu.as_deref(), &tool, summary.clone());
                        self.agent(a).await;
                        self.s.last_activity = Some(summary);
                    }
                    "PostToolUse" => {
                        let a = self.tracker.post_tool(agent_id.as_deref());
                        self.agent(a).await;
                    }
                    "SubagentStart" => {
                        if let Some(id) = &agent_id {
                            let a = self.tracker.subagent_start(id, str_of(&input, "agent_type"));
                            self.agent(a).await;
                        }
                    }
                    "SubagentStop" => {
                        if let Some(id) = &agent_id {
                            let a = self.tracker.subagent_stop(id);
                            self.agent(a).await;
                        }
                    }
                    "Notification" => {
                        if let Some(m) = str_of(&input, "message") {
                            self.system("info", m).await;
                        }
                    }
                    _ => {}
                }
                write_line(stdin, protocol::success(&request_id, response)).await;
            }
            other => {
                write_line(stdin, protocol::error(&request_id, &format!("unsupported control request: {other}"))).await;
            }
        }
    }

    async fn resolve(&mut self, stdin: &mut Option<tokio::process::ChildStdin>, pending: &mut HashMap<String, Pending>, request_id: &str, d: ApprovalDecision) {
        let Some(p) = pending.remove(request_id) else {
            self.system("warn", "Aprovação não está mais pendente (expirada ou já respondida)".into()).await;
            return;
        };
        let allow = d.behavior == "allow";
        let body = if allow {
            let input = d.updated_input.clone().unwrap_or(p.input.clone());
            protocol::permission_allow(&input, if d.remember { Some(&p.suggestions) } else { None })
        } else {
            protocol::permission_deny(d.message.as_deref().unwrap_or("Negado pelo usuário no ccc"))
        };
        if let Some(w) = stdin.as_mut() {
            let _ = w.write_all(format!("{}\n", protocol::success(request_id, body)).as_bytes()).await;
            let _ = w.flush().await;
        }
        let decision = if allow { if d.remember { "allow_remember" } else { "allow" } } else { "deny" };
        let _ = self.db.resolve_approval(request_id, decision);
        let a = self.tracker.post_tool(p.agent_id.as_deref());
        let _ = p.tool_use_id;
        self.agent(a).await;
        self.st.emitter.send(UiEvent::ApprovalResolved { account: self.account, session_id: self.s.id.clone(), request_id: request_id.into(), decision: decision.into() }).await;
        self.s.pending_approvals = pending.len() as i64;
        if pending.is_empty() && self.s.status == SessionStatus::AwaitingApproval {
            self.set_status(SessionStatus::Running, Some("executando".into())).await;
        } else {
            self.persist().await;
        }
    }

    fn cwd(&self) -> PathBuf {
        PathBuf::from(self.s.worktree_path.clone().unwrap_or_else(|| self.s.repo_path.clone()))
    }
}

async fn write_line(stdin: &mut Option<tokio::process::ChildStdin>, v: Value) {
    if let Some(w) = stdin.as_mut() {
        let line = format!("{}\n", v);
        let _ = w.write_all(line.as_bytes()).await;
        let _ = w.flush().await;
    }
}

fn signal_group(child: &tokio::process::Child, sig: nix::sys::signal::Signal) {
    if let Some(pid) = child.id() {
        let _ = nix::sys::signal::killpg(nix::unistd::Pid::from_raw(pid as i32), sig);
    }
}

pub fn looks_like_auth_error(s: &str) -> bool {
    let l = s.to_ascii_lowercase();
    l.contains("401") || l.contains("invalid api key") || l.contains("oauth token") || l.contains("please run /login") || l.contains("not logged in")
}

/// Defense-in-depth check on structured file tools (the kernel sandbox is the
/// real boundary; this produces clear denials before the tool even runs).
pub fn path_violation(tool: &str, input: &Value, cwd: &std::path::Path, read_roots: &[PathBuf], write_roots: &[PathBuf]) -> Option<String> {
    let home = dirs::home_dir().unwrap_or_default();
    for (raw, is_write) in protocol::tool_paths(tool, input) {
        let p = if let Some(rest) = raw.strip_prefix("~/") { home.join(rest) } else { PathBuf::from(&raw) };
        let p = if p.is_absolute() { p } else { cwd.join(p) };
        let n = crate::paths::normalize(&p);
        let roots = if is_write { write_roots } else { read_roots };
        if !roots.iter().any(|r| n.starts_with(r)) {
            return Some(format!("{} fora das pastas autorizadas desta sessão", n.display()));
        }
    }
    None
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn path_violation_blocks_outside_roots() {
        let t = tempfile::tempdir().unwrap();
        let repo = t.path().join("ws/repo");
        std::fs::create_dir_all(&repo).unwrap();
        let repo = repo.canonicalize().unwrap();
        let roots = vec![repo.clone()];
        assert!(path_violation("Write", &json!({"file_path": "src/a.rs"}), &repo, &roots, &roots).is_none());
        assert!(path_violation("Write", &json!({"file_path": "../other/x"}), &repo, &roots, &roots).is_some());
        assert!(path_violation("Read", &json!({"file_path": "/home/x/.claude-work/.credentials.json"}), &repo, &roots, &roots).is_some());
        assert!(path_violation("Bash", &json!({"command": "ls /"}), &repo, &roots, &roots).is_none());
    }
    #[test]
    fn auth_error_detection() {
        assert!(looks_like_auth_error("API Error: 401 Unauthorized"));
        assert!(!looks_like_auth_error("all good"));
    }
}
