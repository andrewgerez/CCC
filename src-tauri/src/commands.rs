//! Tauri IPC commands. Every account-scoped command takes `account` and only
//! touches that account's database, config, sandbox and live handles.
use crate::accounts::{self, AccountConfig, AccountId};
use crate::error::{AppError, AppResult};
use crate::model::*;
use crate::session::{Actor, Cmd};
use crate::state::AppState;
use std::path::{Path, PathBuf};
use std::sync::atomic::Ordering;
use std::sync::Arc;
use tauri::State;
use tokio::io::{AsyncBufReadExt, AsyncWriteExt, BufReader};

type S<'a> = State<'a, Arc<AppState>>;

fn session_of(st: &AppState, account: AccountId, id: &str) -> AppResult<SessionSummary> {
    // Looks only in this account's database: a work id under "personal" is NotFound.
    st.db(account).get_session(id)
}

async fn send_cmd(st: &AppState, account: AccountId, id: &str, cmd: Cmd) -> AppResult<bool> {
    let h = st.live.lock().get(id).cloned();
    match h {
        Some(h) if h.account == account => Ok(h.tx.send(cmd).await.is_ok()),
        Some(_) => Err(AppError::Isolation("sessão pertence a outra conta".into())),
        None => Ok(false),
    }
}

#[tauri::command]
pub fn get_overview(st: S) -> Overview {
    st.overview()
}

#[tauri::command]
pub async fn refresh_auth(st: S<'_>, account: AccountId) -> AppResult<AuthStatus> {
    Ok(st.inner().clone().ensure_auth(account, true).await)
}

#[tauri::command]
pub async fn start_login(st: S<'_>, account: AccountId) -> AppResult<()> {
    let st = st.inner().clone();
    let (acc, other) = st.account_pair(account)?;
    let claude = st.claude.clone().ok_or_else(|| AppError::Process("claude CLI não encontrado".into()))?;
    let mut logins = st.logins.lock().await;
    if logins.contains_key(&account) {
        return Err(AppError::Invalid("login já em andamento".into()));
    }
    let spec = crate::launch::LaunchSpec {
        account: &acc,
        other: &other,
        claude: &claude,
        data: &st.data,
        enforce: st.settings.read().sandbox_enforce,
        writable: vec![],
        cwd: acc.config_dir.clone(),
        args: {
            let mut a: Vec<String> = vec!["auth".into(), "login".into(), "--claudeai".into()];
            if !acc.email.trim().is_empty() {
                a.extend(["--email".into(), acc.email.clone()]);
            }
            a
        },
        run_id: format!("login-{}", account.as_str()),
    };
    let mut child = crate::launch::command(&spec)?.spawn()?;
    let stdin = child.stdin.take();
    let out = child.stdout.take();
    let err = child.stderr.take();
    logins.insert(account, crate::state::LoginHandle { stdin, pid: child.id() });
    drop(logins);
    let em = st.emitter.clone();
    let streams: Vec<Box<dyn tokio::io::AsyncRead + Unpin + Send>> = [
        out.map(|o| Box::new(o) as Box<dyn tokio::io::AsyncRead + Unpin + Send>),
        err.map(|e| Box::new(e) as Box<dyn tokio::io::AsyncRead + Unpin + Send>),
    ]
    .into_iter()
    .flatten()
    .collect();
    for stream in streams {
        let em = em.clone();
        tauri::async_runtime::spawn(async move {
            let mut lines = BufReader::new(stream).lines();
            while let Ok(Some(l)) = lines.next_line().await {
                em.send(UiEvent::AuthLog { account, line: crate::redact::redact(&l) }).await;
            }
        });
    }
    let st2 = st.clone();
    tauri::async_runtime::spawn(async move {
        let status = child.wait().await;
        st2.logins.lock().await.remove(&account);
        st2.emitter
            .send(UiEvent::AuthLog { account, line: format!("[login finalizado: {:?}]", status.ok().and_then(|s| s.code())) })
            .await;
        st2.ensure_auth(account, true).await;
    });
    Ok(())
}

#[tauri::command]
pub async fn login_input(st: S<'_>, account: AccountId, text: String) -> AppResult<()> {
    if text.len() > 4096 || text.contains('\0') {
        return Err(AppError::Invalid("entrada inválida".into()));
    }
    let mut logins = st.logins.lock().await;
    let h = logins.get_mut(&account).ok_or_else(|| AppError::NotFound("nenhum login em andamento".into()))?;
    if let Some(w) = h.stdin.as_mut() {
        w.write_all(format!("{}\n", text.trim()).as_bytes()).await?;
        w.flush().await?;
    }
    Ok(())
}

#[tauri::command]
pub async fn cancel_login(st: S<'_>, account: AccountId) -> AppResult<()> {
    if let Some(h) = st.logins.lock().await.get_mut(&account) {
        h.stdin = None;
        if let Some(pid) = h.pid {
            let _ = nix::sys::signal::killpg(nix::unistd::Pid::from_raw(pid as i32), nix::sys::signal::Signal::SIGTERM);
        }
    }
    Ok(())
}

#[tauri::command]
pub async fn list_repos(st: S<'_>, account: AccountId, refresh: bool) -> AppResult<Vec<RepoInfo>> {
    let db = st.db(account);
    if !refresh {
        let cached = db.cached_repos()?;
        if !cached.is_empty() {
            return Ok(cached);
        }
    }
    let (acc, other) = st.account_pair(account)?;
    let ws = acc.workspace_root.clone();
    let repos = tokio::task::spawn_blocking(move || crate::git::discover(&ws))
        .await
        .map_err(|e| AppError::Process(e.to_string()))?;
    // Defense in depth: drop anything that resolves into the other account.
    let repos: Vec<RepoInfo> = repos
        .into_iter()
        .filter(|r| crate::paths::validate_repo(&acc, &other, &r.path).is_ok())
        .collect();
    db.replace_repos(&repos)?;
    Ok(repos)
}

fn repo_path(st: &AppState, account: AccountId, repo: &str) -> AppResult<PathBuf> {
    let (acc, other) = st.account_pair(account)?;
    // Worktrees created by the app live under the account's data area.
    let base = crate::paths::normalize(&st.data.worktrees(&acc));
    if let Ok(real) = Path::new(repo).canonicalize() {
        if real.starts_with(&base) && real.join(".git").exists() {
            return Ok(real);
        }
    }
    crate::paths::validate_repo(&acc, &other, repo)
}

#[tauri::command]
pub async fn repo_status(st: S<'_>, account: AccountId, repo: String) -> AppResult<RepoStatus> {
    let p = repo_path(&st, account, &repo)?;
    crate::git::status(&p).await
}

#[tauri::command]
pub async fn repo_diff(st: S<'_>, account: AccountId, repo: String, file: Option<String>) -> AppResult<String> {
    let p = repo_path(&st, account, &repo)?;
    let rel = match &file {
        Some(f) => Some(crate::paths::validate_repo_relative(&p, f)?),
        None => None,
    };
    crate::git::diff(&p, rel.as_deref()).await
}

#[tauri::command]
pub async fn create_worktree(st: S<'_>, account: AccountId, repo: String, name: String) -> AppResult<RepoInfo> {
    let (acc, other) = st.account_pair(account)?;
    let p = crate::paths::validate_repo(&acc, &other, &repo)?;
    let name = crate::paths::validate_slug(&name)?;
    let repo_name = p.file_name().map(|s| s.to_string_lossy().into_owned()).unwrap_or_default();
    let base = st.data.worktrees(&acc);
    crate::launch::ensure_private_dir(&base)?;
    let dest = base.join(format!("{repo_name}-{name}"));
    crate::git::create_worktree(&p, &dest, &format!("ccc/{name}")).await?;
    let real = dest.canonicalize()?;
    Ok(RepoInfo {
        path: real.display().to_string(),
        name: format!("{repo_name}-{name}"),
        rel_path: format!("worktree:{repo_name}/{name}"),
        branch: crate::git::read_branch(&real),
        is_worktree: true,
    })
}

#[tauri::command]
pub fn list_sessions(st: S, account: Option<AccountId>) -> AppResult<Vec<SessionSummary>> {
    let mut out = vec![];
    for id in AccountId::ALL {
        if account.map(|a| a == id).unwrap_or(true) {
            out.extend(st.db(id).list_sessions()?);
        }
    }
    out.sort_by(|a, b| b.updated_at.cmp(&a.updated_at));
    Ok(out)
}

pub fn new_summary(account: AccountId, repo: &Path, req: &NewSession, acc: &AccountConfig, worktree: Option<String>) -> SessionSummary {
    let title = req
        .title
        .clone()
        .filter(|t| !t.trim().is_empty())
        .unwrap_or_else(|| {
            let t: String = req.prompt.lines().next().unwrap_or("").chars().take(80).collect();
            if t.trim().is_empty() { "Tarefa com imagem".into() } else { t }
        });
    SessionSummary {
        id: uuid::Uuid::new_v4().to_string(),
        account,
        repo_path: repo.display().to_string(),
        repo_name: repo.file_name().map(|s| s.to_string_lossy().into_owned()).unwrap_or_default(),
        worktree_path: worktree,
        title,
        status: SessionStatus::Queued,
        model: req.model.clone().filter(|m| !m.is_empty() && m != "default").or(acc.default_model.clone()),
        permission_mode: req.permission_mode.unwrap_or(acc.default_permission_mode),
        priority: req.priority.unwrap_or(0).clamp(-10, 10),
        created_at: now_ms(),
        updated_at: now_ms(),
        last_activity: Some("criada".into()),
        total_cost_usd: 0.0,
        input_tokens: 0,
        output_tokens: 0,
        turns: 0,
        pending_approvals: 0,
        last_error: None,
        pid: None,
        resumable: false,
        extra_dirs: vec![],
    }
}

#[tauri::command]
pub async fn create_session(st: S<'_>, account: AccountId, req: NewSession) -> AppResult<SessionSummary> {
    let first_prompt = Prompt { text: req.prompt.clone(), images: req.images.clone(), thumbs: req.thumbs.clone() };
    first_prompt.validate().map_err(AppError::Invalid)?;
    let (acc, other) = st.account_pair(account)?;
    let repo = crate::paths::validate_repo(&acc, &other, &req.repo_path)?;
    let worktree = match &req.worktree_path {
        Some(w) if !w.is_empty() => {
            let real = Path::new(w).canonicalize().map_err(|_| AppError::Path("worktree inexistente".into()))?;
            if !real.starts_with(crate::paths::normalize(&st.data.worktrees(&acc))) {
                return Err(AppError::Isolation("worktree fora da área desta conta".into()));
            }
            Some(real.display().to_string())
        }
        _ => None,
    };
    let extra = validate_dirs(&acc, &other, req.extra_dirs.as_deref().unwrap_or(&[]), Some(&repo))?;
    let mut s = new_summary(account, &repo, &req, &acc, worktree);
    s.extra_dirs = extra;
    st.db(account).upsert_session(&s)?;
    st.emitter.send(UiEvent::SessionUpsert { session: s.clone() }).await;
    Actor::spawn(st.inner().clone(), account, s.id.clone(), vec![first_prompt])?;
    Ok(s)
}

/// Canonicalises and isolation-checks a list of directories; drops duplicates
/// and the primary repo. Every entry must live in this account's workspace.
fn validate_dirs(acc: &AccountConfig, other: &AccountConfig, dirs: &[String], primary: Option<&Path>) -> AppResult<Vec<String>> {
    if dirs.len() > 16 {
        return Err(AppError::Invalid("no máximo 16 diretórios por projeto".into()));
    }
    let mut out: Vec<String> = vec![];
    for d in dirs {
        let real = crate::paths::validate_repo(acc, other, d)?;
        let s = real.display().to_string();
        if primary.map(|p| p == real.as_path()).unwrap_or(false) || out.contains(&s) {
            continue;
        }
        out.push(s);
    }
    Ok(out)
}

#[tauri::command]
pub fn list_projects(st: S, account: AccountId) -> AppResult<Vec<Project>> {
    st.db(account).list_projects()
}

#[tauri::command]
pub fn save_project(st: S, account: AccountId, project: Project) -> AppResult<Project> {
    let name = project.name.trim().to_string();
    if name.is_empty() || name.chars().count() > 80 {
        return Err(AppError::Invalid("nome do projeto: 1-80 caracteres".into()));
    }
    let (acc, other) = st.account_pair(account)?;
    let dirs = validate_dirs(&acc, &other, &project.dirs, None)?;
    if dirs.is_empty() {
        return Err(AppError::Invalid("selecione ao menos um diretório".into()));
    }
    let existing = st.db(account).list_projects()?;
    let id = if project.id.is_empty() { uuid::Uuid::new_v4().to_string() } else { project.id.clone() };
    let created_at = existing.iter().find(|p| p.id == id).map(|p| p.created_at).unwrap_or_else(now_ms);
    let p = Project { id, name, dirs, created_at };
    st.db(account).upsert_project(&p)?;
    Ok(p)
}

#[tauri::command]
pub fn delete_project(st: S, account: AccountId, project_id: String) -> AppResult<()> {
    st.db(account).remove_project(&project_id)
}

#[tauri::command]
pub async fn send_message(
    st: S<'_>,
    account: AccountId,
    session_id: String,
    text: String,
    images: Option<Vec<ImageInput>>,
    thumbs: Option<Vec<String>>,
) -> AppResult<()> {
    let prompt = Prompt { text, images: images.unwrap_or_default(), thumbs: thumbs.unwrap_or_default() };
    prompt.validate().map_err(AppError::Invalid)?;
    let s = session_of(&st, account, &session_id)?;
    if s.status == SessionStatus::Archived {
        return Err(AppError::Invalid("sessão arquivada".into()));
    }
    if !send_cmd(&st, account, &session_id, Cmd::Send(prompt.clone())).await? {
        // No live process: resume (spawn new actor with --resume).
        Actor::spawn(st.inner().clone(), account, session_id, vec![prompt])?;
    }
    Ok(())
}

#[tauri::command]
pub async fn respond_approval(st: S<'_>, account: AccountId, session_id: String, request_id: String, decision: ApprovalDecision) -> AppResult<()> {
    session_of(&st, account, &session_id)?;
    if decision.behavior != "allow" && decision.behavior != "deny" {
        return Err(AppError::Invalid("behavior deve ser allow|deny".into()));
    }
    if !send_cmd(&st, account, &session_id, Cmd::Approve { request_id: request_id.clone(), decision }).await? {
        st.db(account).resolve_approval(&request_id, "expired")?;
        return Err(AppError::NotFound("sessão não está ativa; a solicitação expirou".into()));
    }
    Ok(())
}

#[tauri::command]
pub async fn interrupt_session(st: S<'_>, account: AccountId, session_id: String) -> AppResult<()> {
    session_of(&st, account, &session_id)?;
    send_cmd(&st, account, &session_id, Cmd::Interrupt).await?;
    Ok(())
}

#[tauri::command]
pub async fn stop_session(st: S<'_>, account: AccountId, session_id: String) -> AppResult<()> {
    session_of(&st, account, &session_id)?;
    send_cmd(&st, account, &session_id, Cmd::Stop).await?;
    Ok(())
}

#[tauri::command]
pub async fn archive_session(st: S<'_>, account: AccountId, session_id: String) -> AppResult<()> {
    let mut s = session_of(&st, account, &session_id)?;
    if st.live.lock().contains_key(&session_id) {
        return Err(AppError::Invalid("encerre a sessão antes de arquivar".into()));
    }
    s.status = SessionStatus::Archived;
    s.updated_at = now_ms();
    st.db(account).upsert_session(&s)?;
    st.emitter.send(UiEvent::SessionUpsert { session: s }).await;
    Ok(())
}

#[tauri::command]
pub async fn set_session_priority(st: S<'_>, account: AccountId, session_id: String, priority: i32) -> AppResult<()> {
    let mut s = session_of(&st, account, &session_id)?;
    let p = priority.clamp(-10, 10);
    if !send_cmd(&st, account, &session_id, Cmd::SetPriority(p)).await? {
        s.priority = p;
        st.db(account).upsert_session(&s)?;
        st.emitter.send(UiEvent::SessionUpsert { session: s }).await;
    }
    Ok(())
}

#[tauri::command]
pub fn get_session(st: S, account: AccountId, session_id: String) -> AppResult<SessionDetail> {
    let db = st.db(account);
    Ok(SessionDetail {
        session: db.get_session(&session_id)?,
        agents: db.list_agents(&session_id)?,
        approvals: db.pending_approvals(Some(&session_id))?,
    })
}

#[tauri::command]
pub fn get_chat(st: S, account: AccountId, session_id: String, before_seq: Option<i64>, limit: u32) -> AppResult<Vec<ChatItem>> {
    session_of(&st, account, &session_id)?;
    st.db(account).get_chat(&session_id, before_seq, limit.clamp(1, 1000))
}

#[tauri::command]
pub fn update_settings(st: S, settings: Settings) -> AppResult<Overview> {
    let mut s = settings;
    s.max_concurrent = s.max_concurrent.clamp(1, 8);
    s.idle_timeout_secs = s.idle_timeout_secs.clamp(5, 3600);
    s.event_retention_per_session = s.event_retention_per_session.clamp(200, 100_000);
    st.global.set("settings", &s)?;
    st.scheduler.set_limit(s.max_concurrent);
    for id in AccountId::ALL {
        st.db(id).set_retention(s.event_retention_per_session);
    }
    if !s.sandbox_enforce {
        tracing::warn!("sandbox enforcement DISABLED by user");
    }
    *st.settings.write() = s;
    for a in st.auth.lock().values_mut() {
        a.checked_at = 0;
    }
    Ok(st.overview())
}

#[tauri::command]
pub fn update_account(st: S, config: AccountConfig) -> AppResult<Overview> {
    if st.live_count(Some(config.id)) > 0 {
        return Err(AppError::Invalid("encerre as sessões ativas desta conta antes de alterar a configuração".into()));
    }
    let mut next = st.accounts.read().clone();
    for a in next.iter_mut() {
        if a.id == config.id {
            *a = config.clone();
        }
    }
    let warnings = accounts::validate_pair(&next, &st.home)?; // refuse invalid configs outright
    st.global.set("accounts", &next)?;
    *st.accounts.write() = next;
    *st.warnings.write() = warnings;
    *st.config_error.write() = None;
    st.auth.lock().remove(&config.id);
    st.db(config.id).replace_repos(&[])?;
    Ok(st.overview())
}

#[tauri::command]
pub fn get_metrics(st: S) -> MetricsSnapshot {
    let mut sampler = crate::metrics::Sampler::default();
    crate::state::snapshot(&st, &mut sampler, std::process::id() as i64)
}

#[tauri::command]
pub fn set_ui_visible(st: S, visible: bool) {
    st.emitter.visible.store(visible, Ordering::Relaxed);
    st.visibility.notify_waiters();
}

#[tauri::command]
pub fn list_tasks(st: S, account: AccountId, repo: Option<String>) -> AppResult<Vec<TaskItem>> {
    st.db(account).list_tasks(repo.as_deref())
}

#[tauri::command]
pub fn create_task(st: S, account: AccountId, repo: String, title: String, prompt: String, priority: i32) -> AppResult<TaskItem> {
    let (acc, other) = st.account_pair(account)?;
    let repo = crate::paths::validate_repo(&acc, &other, &repo)?;
    if title.trim().is_empty() || prompt.trim().is_empty() {
        return Err(AppError::Invalid("título e prompt são obrigatórios".into()));
    }
    let t = TaskItem {
        id: uuid::Uuid::new_v4().to_string(),
        account,
        repo_path: repo.display().to_string(),
        title: title.chars().take(200).collect(),
        prompt,
        priority: priority.clamp(-10, 10),
        status: "todo".into(),
        session_id: None,
        created_at: now_ms(),
    };
    st.db(account).upsert_task(&t)?;
    Ok(t)
}

#[tauri::command]
pub fn update_task(st: S, account: AccountId, task: TaskItem) -> AppResult<()> {
    let existing = st.db(account).get_task(&task.id)?;
    let mut t = task;
    t.account = account;
    t.repo_path = existing.repo_path; // repo is immutable
    if !["todo", "running", "done"].contains(&t.status.as_str()) {
        return Err(AppError::Invalid("status inválido".into()));
    }
    st.db(account).upsert_task(&t)
}

#[tauri::command]
pub fn delete_task(st: S, account: AccountId, task_id: String) -> AppResult<()> {
    st.db(account).remove_task(&task_id)
}

#[tauri::command]
pub async fn run_task(st: S<'_>, account: AccountId, task_id: String) -> AppResult<SessionSummary> {
    let mut t = st.db(account).get_task(&task_id)?;
    let (acc, other) = st.account_pair(account)?;
    let repo = crate::paths::validate_repo(&acc, &other, &t.repo_path)?;
    let req = NewSession {
        repo_path: t.repo_path.clone(),
        prompt: t.prompt.clone(),
        title: Some(t.title.clone()),
        model: None,
        permission_mode: None,
        priority: Some(t.priority),
        worktree_path: None,
        extra_dirs: None,
        images: vec![],
        thumbs: vec![],
    };
    let s = new_summary(account, &repo, &req, &acc, None);
    st.db(account).upsert_session(&s)?;
    t.status = "running".into();
    t.session_id = Some(s.id.clone());
    st.db(account).upsert_task(&t)?;
    st.emitter.send(UiEvent::SessionUpsert { session: s.clone() }).await;
    Actor::spawn(st.inner().clone(), account, s.id.clone(), vec![t.prompt.into()])?;
    Ok(s)
}

/// The CLI stores transcripts at <config>/projects/<cwd, non-alnum -> '-'>/<id>.jsonl
pub fn project_slug(p: &Path) -> String {
    p.display().to_string().chars().map(|c| if c.is_ascii_alphanumeric() { c } else { '-' }).collect()
}

#[tauri::command]
pub async fn list_external_sessions(st: S<'_>, account: AccountId, repo: String) -> AppResult<Vec<ExternalSession>> {
    let (acc, other) = st.account_pair(account)?;
    let repo = crate::paths::validate_repo(&acc, &other, &repo)?;
    let dir = acc.config_dir.join("projects").join(project_slug(&repo));
    tokio::task::spawn_blocking(move || {
        let mut out = vec![];
        let Ok(rd) = std::fs::read_dir(&dir) else { return out };
        for e in rd.filter_map(Result::ok) {
            let p = e.path();
            if p.extension().and_then(|x| x.to_str()) != Some("jsonl") {
                continue;
            }
            let Some(id) = p.file_stem().map(|s| s.to_string_lossy().into_owned()) else { continue };
            if uuid::Uuid::parse_str(&id).is_err() {
                continue;
            }
            let meta = e.metadata().ok();
            let updated = meta
                .as_ref()
                .and_then(|m| m.modified().ok())
                .and_then(|t| t.duration_since(std::time::UNIX_EPOCH).ok())
                .map(|d| d.as_millis() as i64)
                .unwrap_or(0);
            out.push(ExternalSession {
                title: first_prompt(&p).unwrap_or_else(|| "(sem título)".into()),
                id,
                updated_at: updated,
                size_bytes: meta.map(|m| m.len() as i64).unwrap_or(0),
            });
        }
        out.sort_by(|a, b| b.updated_at.cmp(&a.updated_at));
        out.truncate(200);
        out
    })
    .await
    .map_err(|e| AppError::Process(e.to_string()))
}

fn first_prompt(p: &Path) -> Option<String> {
    use std::io::BufRead;
    let f = std::fs::File::open(p).ok()?;
    for line in std::io::BufReader::new(f).lines().take(60).map_while(Result::ok) {
        let Ok(v) = serde_json::from_str::<serde_json::Value>(&line) else { continue };
        if v.get("type").and_then(|t| t.as_str()) == Some("user") {
            let Some(c) = v.get("message").and_then(|m| m.get("content")) else { continue };
            let t = match c {
                serde_json::Value::String(s) => s.clone(),
                serde_json::Value::Array(a) => a.iter().filter_map(|b| b.get("text").and_then(|x| x.as_str())).collect::<Vec<_>>().join(" "),
                _ => continue,
            };
            if !t.trim().is_empty() && !t.starts_with('<') {
                return Some(t.chars().take(100).collect());
            }
        }
    }
    None
}

#[tauri::command]
pub fn import_external_session(st: S, account: AccountId, repo: String, id: String) -> AppResult<SessionSummary> {
    uuid::Uuid::parse_str(&id).map_err(|_| AppError::Invalid("id inválido".into()))?;
    let (acc, other) = st.account_pair(account)?;
    let repo_p = crate::paths::validate_repo(&acc, &other, &repo)?;
    let file = acc.config_dir.join("projects").join(project_slug(&repo_p)).join(format!("{id}.jsonl"));
    if !file.is_file() {
        return Err(AppError::NotFound("transcrição não encontrada nesta conta".into()));
    }
    if let Ok(s) = st.db(account).get_session(&id) {
        return Ok(s);
    }
    let req = NewSession {
        repo_path: repo.clone(),
        prompt: String::new(),
        title: first_prompt(&file),
        model: None,
        permission_mode: None,
        priority: None,
        worktree_path: None,
        extra_dirs: None,
        images: vec![],
        thumbs: vec![],
    };
    let mut s = new_summary(account, &repo_p, &req, &acc, None);
    s.id = id;
    s.status = SessionStatus::Idle;
    s.resumable = true;
    s.last_activity = Some("importada da CLI — envie uma mensagem para retomar".into());
    st.db(account).upsert_session(&s)?;
    st.emitter.send_blocking_safe(UiEvent::SessionUpsert { session: s.clone() });
    Ok(s)
}

#[tauri::command]
pub async fn delete_session(st: S<'_>, account: AccountId, session_id: String) -> AppResult<()> {
    session_of(&st, account, &session_id)?;
    if st.live.lock().contains_key(&session_id) {
        return Err(AppError::Invalid("encerre a sessão antes de apagar".into()));
    }
    st.db(account).remove_session(&session_id)?;
    st.emitter.send(UiEvent::SessionRemoved { account, session_id }).await;
    Ok(())
}

#[tauri::command]
pub async fn set_permission_mode(st: S<'_>, account: AccountId, session_id: String, mode: accounts::PermissionMode) -> AppResult<()> {
    let mut s = session_of(&st, account, &session_id)?;
    if !send_cmd(&st, account, &session_id, Cmd::SetMode(mode)).await? {
        s.permission_mode = mode;
        s.updated_at = now_ms();
        st.db(account).upsert_session(&s)?;
        st.emitter.send(UiEvent::SessionUpsert { session: s }).await;
    }
    Ok(())
}

/// Runs a short `claude …` CLI command inside the account's sandbox and env.
async fn run_claude(st: &Arc<AppState>, account: AccountId, args: Vec<String>) -> AppResult<String> {
    let (acc, other) = st.account_pair(account)?;
    let claude = st.claude.clone().ok_or_else(|| AppError::Process("claude CLI não encontrado".into()))?;
    let spec = crate::launch::LaunchSpec {
        account: &acc,
        other: &other,
        claude: &claude,
        data: &st.data,
        enforce: st.settings.read().sandbox_enforce,
        writable: vec![],
        cwd: acc.config_dir.clone(),
        args,
        run_id: format!("mcp-{}", uuid::Uuid::new_v4()),
    };
    let mut cmd = crate::launch::command(&spec)?;
    cmd.stdin(std::process::Stdio::null());
    let out = tokio::time::timeout(std::time::Duration::from_secs(60), cmd.output())
        .await
        .map_err(|_| AppError::Process("timeout no claude CLI".into()))??;
    if !out.status.success() {
        let err = String::from_utf8_lossy(&out.stderr);
        let msg = err.lines().filter(|l| !l.trim().is_empty()).last().unwrap_or("falha no claude CLI");
        return Err(AppError::Process(crate::redact::redact(msg)));
    }
    Ok(String::from_utf8_lossy(&out.stdout).into_owned())
}

#[tauri::command]
pub fn mcp_list(st: S, account: AccountId) -> AppResult<Vec<crate::mcp::McpServer>> {
    let (acc, _) = st.account_pair(account)?;
    crate::mcp::list(&acc)
}

#[tauri::command]
pub async fn mcp_add(st: S<'_>, account: AccountId, name: String, config: serde_json::Value) -> AppResult<Vec<crate::mcp::McpServer>> {
    if !crate::mcp::valid_name(&name) {
        return Err(AppError::Invalid("nome: use letras, números, - ou _ (até 64)".into()));
    }
    crate::mcp::validate_config(&config)?;
    let st = st.inner().clone();
    run_claude(&st, account, vec!["mcp".into(), "add-json".into(), "--scope".into(), "user".into(), name, config.to_string()]).await?;
    let (acc, _) = st.account_pair(account)?;
    crate::mcp::list(&acc)
}

#[tauri::command]
pub async fn mcp_remove(st: S<'_>, account: AccountId, name: String) -> AppResult<Vec<crate::mcp::McpServer>> {
    if !crate::mcp::valid_name(&name) {
        return Err(AppError::Invalid("nome inválido".into()));
    }
    let st = st.inner().clone();
    run_claude(&st, account, vec!["mcp".into(), "remove".into(), "--scope".into(), "user".into(), name]).await?;
    let (acc, _) = st.account_pair(account)?;
    crate::mcp::list(&acc)
}


fn script_bin() -> AppResult<PathBuf> {
    ["/usr/bin/script", "/bin/script"]
        .iter()
        .map(PathBuf::from)
        .find(|p| p.exists())
        .ok_or_else(|| AppError::Process("comando `script` (util-linux) não encontrado".into()))
}

/// Opens a URL in the user's default browser, outside the sandbox.
fn open_in_browser(url: &str) {
    if !url.starts_with("https://") {
        return;
    }
    let _ = std::process::Command::new("xdg-open")
        .arg(url)
        .stdin(std::process::Stdio::null())
        .stdout(std::process::Stdio::null())
        .stderr(std::process::Stdio::null())
        .spawn();
}

/// OAuth for a remote MCP server: runs `claude mcp login <name> --no-browser` under a pty
/// (the CLI refuses without a terminal) inside the account sandbox, opens the authorize URL
/// in the user's browser and lets the CLI's localhost callback finish the flow.
#[tauri::command]
pub async fn mcp_login(st: S<'_>, account: AccountId, name: String) -> AppResult<()> {
    if !crate::mcp::valid_name(&name) {
        return Err(AppError::Invalid("nome inválido".into()));
    }
    let st = st.inner().clone();
    let (acc, other) = st.account_pair(account)?;
    if !crate::mcp::list(&acc)?.iter().any(|s| s.name == name) {
        return Err(AppError::NotFound(format!("MCP {name} não está conectado nesta conta")));
    }
    let claude = st.claude.clone().ok_or_else(|| AppError::Process("claude CLI não encontrado".into()))?;
    let claude_path = claude.path.display().to_string();
    if claude_path.contains('\'') {
        return Err(AppError::Invalid("caminho do claude CLI não suportado".into()));
    }
    let key = (account, name.clone());
    let mut logins = st.mcp_logins.lock().await;
    if logins.contains_key(&key) {
        return Err(AppError::Invalid("login deste MCP já em andamento".into()));
    }
    let spec = crate::launch::LaunchSpec {
        account: &acc,
        other: &other,
        claude: &claude,
        data: &st.data,
        enforce: st.settings.read().sandbox_enforce,
        writable: vec![],
        cwd: acc.config_dir.clone(),
        args: vec![],
        run_id: format!("mcp-login-{}", uuid::Uuid::new_v4()),
    };
    let line = format!("'{claude_path}' mcp login {name} --no-browser");
    let args: Vec<String> = vec!["-q".into(), "-e".into(), "-c".into(), line, "/dev/null".into()];
    let mut child = crate::launch::command_with(&spec, &script_bin()?, &args)?.spawn()?;
    let stdin = child.stdin.take();
    let out = child.stdout.take();
    logins.insert(key.clone(), crate::state::LoginHandle { stdin, pid: child.id() });
    drop(logins);
    let em = st.emitter.clone();
    let last = Arc::new(parking_lot::Mutex::new(String::new()));
    if let Some(out) = out {
        let (em, name, last) = (em.clone(), name.clone(), last.clone());
        tauri::async_runtime::spawn(async move {
            let mut lines = BufReader::new(out).lines();
            let mut opened = false;
            while let Ok(Some(l)) = lines.next_line().await {
                if !opened {
                    if let Some(url) = crate::mcp::authorize_url(&l) {
                        opened = true;
                        open_in_browser(&url);
                        em.send(UiEvent::McpLogin { account, name: name.clone(), phase: "url".into(), text: url }).await;
                        continue;
                    }
                }
                let clean = crate::mcp::strip_ansi(&l).trim().to_string();
                if !clean.is_empty() {
                    *last.lock() = crate::redact::redact(&clean);
                }
            }
        });
    }
    tauri::async_runtime::spawn(async move {
        let status = tokio::time::timeout(std::time::Duration::from_secs(600), child.wait()).await;
        let ok = matches!(status, Ok(Ok(s)) if s.success());
        if status.is_err() {
            let _ = child.kill().await;
        }
        st.mcp_logins.lock().await.remove(&key);
        let text = if ok { "autenticado".to_string() } else { last.lock().clone() };
        let phase = if ok { "done" } else { "error" };
        st.emitter.send(UiEvent::McpLogin { account, name: key.1, phase: phase.into(), text }).await;
    });
    Ok(())
}

/// Pastes the redirect URL into a running `mcp login` (fallback when the localhost callback can't be reached).
#[tauri::command]
pub async fn mcp_login_input(st: S<'_>, account: AccountId, name: String, text: String) -> AppResult<()> {
    if text.len() > 8192 || text.contains('\0') || text.contains('\n') {
        return Err(AppError::Invalid("entrada inválida".into()));
    }
    let mut logins = st.mcp_logins.lock().await;
    let h = logins.get_mut(&(account, name)).ok_or_else(|| AppError::NotFound("nenhum login em andamento".into()))?;
    if let Some(w) = h.stdin.as_mut() {
        w.write_all(format!("{}\r", text.trim()).as_bytes()).await?;
        w.flush().await?;
    }
    Ok(())
}

#[tauri::command]
pub async fn mcp_login_cancel(st: S<'_>, account: AccountId, name: String) -> AppResult<()> {
    if let Some(h) = st.mcp_logins.lock().await.remove(&(account, name)) {
        if let Some(pid) = h.pid {
            let _ = nix::sys::signal::killpg(nix::unistd::Pid::from_raw(pid as i32), nix::sys::signal::Signal::SIGTERM);
        }
    }
    Ok(())
}

/// Opens an https link (token pages, docs) in the user's browser.
#[tauri::command]
pub fn open_external(url: String) -> AppResult<()> {
    if !url.starts_with("https://") || url.len() > 2048 || url.chars().any(char::is_whitespace) {
        return Err(AppError::Invalid("apenas links https".into()));
    }
    open_in_browser(&url);
    Ok(())
}

/// What a candidate behaviour folder would contribute (skills, CLAUDE.md, plugin parts).
#[tauri::command]
pub fn inspect_behavior_dir(path: String) -> AppResult<crate::behavior::BehaviorInfo> {
    if path.trim().is_empty() || path.contains('\0') {
        return Err(AppError::Invalid("caminho inválido".into()));
    }
    Ok(crate::behavior::inspect(Path::new(path.trim())))
}

/// Model aliases or ids the CLI accepts (`opus`, `sonnet`, `haiku`, `claude-…`, optional `[1m]`).
pub fn valid_model(m: &str) -> bool {
    !m.is_empty() && m.len() <= 64 && m.chars().all(|c| c.is_ascii_alphanumeric() || matches!(c, '-' | '.' | '[' | ']'))
}

/// Switches a session's model: live sessions change on the next turn via the control protocol,
/// others keep it for their next run. `None` = account/CLI default.
#[tauri::command]
pub async fn set_session_model(st: S<'_>, account: AccountId, session_id: String, model: Option<String>) -> AppResult<()> {
    let model = model.map(|m| m.trim().to_string()).filter(|m| !m.is_empty());
    if let Some(m) = &model {
        if !valid_model(m) {
            return Err(AppError::Invalid("modelo inválido".into()));
        }
    }
    let mut s = session_of(&st, account, &session_id)?;
    if !send_cmd(&st, account, &session_id, Cmd::SetModel(model.clone())).await? {
        s.model = model;
        s.updated_at = now_ms();
        st.db(account).upsert_session(&s)?;
        st.emitter.send(UiEvent::SessionUpsert { session: s }).await;
    }
    Ok(())
}
