//! Application state, bootstrap, auth cache and the metrics loop.
use crate::accounts::{self, AccountConfig, AccountId};
use crate::db::{AccountDb, GlobalDb};
use crate::emitter::Emitter;
use crate::error::{AppError, AppResult};
use crate::launch::{ClaudeBin, DataDirs};
use crate::model::*;
use crate::scheduler::Scheduler;
use crate::session;
use parking_lot::{Mutex, RwLock};
use std::collections::HashMap;
use std::path::PathBuf;
use std::sync::atomic::Ordering;
use std::sync::Arc;
use tauri::{AppHandle, Emitter as _};
use tokio::sync::Notify;

pub struct LoginHandle {
    pub stdin: Option<tokio::process::ChildStdin>,
    pub pid: Option<u32>,
}

pub struct AppState {
    pub home: PathBuf,
    pub data: DataDirs,
    pub global: GlobalDb,
    pub accounts: RwLock<Vec<AccountConfig>>,
    pub config_error: RwLock<Option<String>>,
    pub warnings: RwLock<Vec<String>>,
    pub settings: RwLock<Settings>,
    pub dbs: HashMap<AccountId, Arc<AccountDb>>,
    pub auth: Mutex<HashMap<AccountId, AuthStatus>>,
    auth_locks: HashMap<AccountId, tokio::sync::Mutex<()>>,
    pub scheduler: Arc<Scheduler>,
    pub live: Mutex<HashMap<String, session::Handle>>,
    pub emitter: Emitter,
    pub claude: Option<ClaudeBin>,
    pub claude_version: RwLock<Option<String>>,
    pub logins: tokio::sync::Mutex<HashMap<AccountId, LoginHandle>>,
    pub visibility: Notify,
}

impl AppState {
    pub fn bootstrap(app: AppHandle) -> AppResult<Arc<AppState>> {
        let home = dirs::home_dir().ok_or_else(|| AppError::Invalid("no home dir".into()))?;
        let base = dirs::data_dir().unwrap_or_else(|| home.join(".local/share"));
        let root = base.join("ccc");
        // One-time move from the pre-rename location so existing sessions survive.
        let legacy = base.join("claude-command-center");
        if !root.exists() && legacy.is_dir() {
            if let Err(e) = std::fs::rename(&legacy, &root) {
                tracing::warn!("could not migrate {} -> {}: {e}", legacy.display(), root.display());
            }
        }
        crate::launch::ensure_private_dir(&root)?;
        let data = DataDirs { root: root.clone() };
        let global = GlobalDb::open(&root.join("app.db"))?;
        let settings: Settings = global.get("settings")?.unwrap_or_default();
        let mut accs: Vec<AccountConfig> = global.get("accounts")?.unwrap_or_else(|| accounts::default_accounts(&home));
        if global.get::<bool>("perm_auto_v1")?.is_none() {
            for a in accs.iter_mut() {
                if a.default_permission_mode == accounts::PermissionMode::Default {
                    a.default_permission_mode = accounts::PermissionMode::Auto;
                }
            }
            global.set("accounts", &accs)?;
            global.set("perm_auto_v1", &true)?;
        }
        // Labels from early builds -> current wording.
        if global.get::<bool>("labels_v2")?.is_none() {
            for a in accs.iter_mut() {
                match a.label.as_str() {
                    "Empresarial" => a.label = "Trabalho".into(),
                    "Pessoal / PJ" => a.label = "Pessoal · PJ".into(),
                    _ => {}
                }
            }
            global.set("accounts", &accs)?;
            global.set("labels_v2", &true)?;
        }
        let (config_error, warnings) = match accounts::validate_pair(&accs, &home) {
            Ok(w) => (None, w),
            Err(e) => (Some(e.to_string()), vec![]),
        };
        let mut dbs = HashMap::new();
        for id in AccountId::ALL {
            let db = AccountDb::open(&root.join(format!("{}.db", id.as_str())), id, settings.event_retention_per_session)?;
            dbs.insert(id, Arc::new(db));
        }
        let handle = app.clone();
        let emitter = Emitter::new(move |batch| {
            let _ = handle.emit(crate::emitter::CHANNEL, batch);
        });
        let em2 = emitter.clone();
        let scheduler = Scheduler::new(
            settings.max_concurrent,
            Box::new(move |view| {
                em2.try_send(UiEvent::Metrics { snapshot: MetricsSnapshot { ts: now_ms(), scheduler: view, ..Default::default() } });
            }),
        );
        let st = Arc::new(AppState {
            claude: ClaudeBin::discover(&home),
            home,
            data,
            global,
            accounts: RwLock::new(accs),
            config_error: RwLock::new(config_error),
            warnings: RwLock::new(warnings),
            settings: RwLock::new(settings),
            dbs,
            auth: Mutex::new(HashMap::new()),
            auth_locks: AccountId::ALL.iter().map(|a| (*a, tokio::sync::Mutex::new(()))).collect(),
            scheduler,
            live: Mutex::new(HashMap::new()),
            emitter,
            claude_version: RwLock::new(None),
            logins: tokio::sync::Mutex::new(HashMap::new()),
            visibility: Notify::new(),
        });
        st.reconcile();
        Ok(st)
    }

    /// After restart: nothing is assumed running. Orphans we started get SIGTERM.
    fn reconcile(&self) {
        for id in AccountId::ALL {
            match self.db(id).reconcile_after_restart() {
                Ok(stale) if !stale.is_empty() => tracing::info!("{}: {} sessions reconciled after restart", id.as_str(), stale.len()),
                Err(e) => tracing::error!("reconcile {}: {e}", id.as_str()),
                _ => {}
            }
        }
        let me = std::process::id() as i64;
        for (pid, run) in crate::metrics::find_orphans(crate::envsafe::MARKER_ENV, me) {
            tracing::warn!("terminating orphaned Claude process pid={pid} run={run}");
            let _ = nix::sys::signal::kill(nix::unistd::Pid::from_raw(pid as i32), nix::sys::signal::Signal::SIGTERM);
        }
    }

    pub fn db(&self, id: AccountId) -> Arc<AccountDb> {
        self.dbs.get(&id).expect("db per account").clone()
    }

    pub fn account_cfg(&self, id: AccountId) -> AccountConfig {
        self.accounts.read().iter().find(|a| a.id == id).cloned().expect("both accounts configured")
    }

    /// (mine, other). Refuses when the configuration failed validation.
    pub fn account_pair(&self, id: AccountId) -> AppResult<(AccountConfig, AccountConfig)> {
        if let Some(e) = self.config_error.read().clone() {
            return Err(AppError::Isolation(format!("configuração inválida: {e}")));
        }
        Ok((self.account_cfg(id), self.account_cfg(id.other())))
    }

    pub fn invalidate_auth(&self, id: AccountId) {
        if let Some(a) = self.auth.lock().get_mut(&id) {
            a.checked_at = 0;
        }
    }

    pub fn cached_auth(&self, id: AccountId) -> AuthStatus {
        let acc = self.account_cfg(id);
        self.auth.lock().get(&id).cloned().unwrap_or(AuthStatus {
            account: id,
            state: AuthState::Unknown,
            email: None,
            expected_email: acc.email,
            org_name: None,
            subscription: None,
            expires_at: None,
            checked_at: 0,
            message: None,
        })
    }

    pub async fn ensure_auth(self: &Arc<Self>, id: AccountId, force: bool) -> AuthStatus {
        let _g = self.auth_locks[&id].lock().await;
        let cached = self.cached_auth(id);
        if !force && cached.state == AuthState::Verified && now_ms() - cached.checked_at < crate::auth::TTL_MS {
            return cached;
        }
        let (acc, other) = match self.account_pair(id) {
            Ok(p) => p,
            Err(e) => {
                let mut s = cached;
                s.state = AuthState::Error;
                s.message = Some(e.to_string());
                return s;
            }
        };
        let Some(claude) = self.claude.clone() else {
            let mut s = cached;
            s.state = AuthState::Error;
            s.message = Some("claude CLI não encontrado no PATH".into());
            return s;
        };
        let mut checking = cached.clone();
        checking.state = AuthState::Checking;
        self.emitter.send(UiEvent::Auth { status: checking }).await;
        let enforce = self.settings.read().sandbox_enforce;
        let mut s = crate::auth::check(&acc, &other, &claude, &self.data, enforce).await;
        if s.state == AuthState::Verified && acc.email.trim().is_empty() {
            s = self.bind_identity(id, s);
        }
        self.auth.lock().insert(id, s.clone());
        self.emitter.send(UiEvent::Auth { status: s.clone() }).await;
        s
    }

    /// First successful login on an unlinked account: remember its email so every later
    /// check enforces it. Refuses an identity already bound to the other account.
    fn bind_identity(&self, id: AccountId, mut s: AuthStatus) -> AuthStatus {
        let Some(email) = s.email.clone() else { return s };
        let mut next = self.accounts.read().clone();
        if next.iter().any(|a| a.id != id && a.email.trim().eq_ignore_ascii_case(email.trim())) {
            s.state = AuthState::Mismatch;
            s.message = Some(format!("{email} já está vinculado à outra conta; entre com outra conta Claude"));
            return s;
        }
        for a in next.iter_mut().filter(|a| a.id == id) {
            a.email = email.clone();
        }
        if let Err(e) = self.global.set("accounts", &next) {
            s.state = AuthState::Error;
            s.message = Some(format!("não foi possível salvar o vínculo: {e}"));
            return s;
        }
        *self.accounts.write() = next;
        s.expected_email = email.clone();
        s.message = Some(format!("conta vinculada a {email}"));
        s
    }

    pub fn overview(&self) -> Overview {
        let warnings = self.warnings.read().clone();
        Overview {
            accounts: AccountId::ALL
                .iter()
                .map(|id| {
                    let config = self.account_cfg(*id);
                    AccountView {
                        auth: self.cached_auth(*id),
                        warnings: warnings.iter().filter(|w| w.starts_with(id.as_str())).cloned().collect(),
                        workspace_exists: config.workspace_root.is_dir(),
                        config,
                    }
                })
                .collect(),
            settings: self.settings.read().clone(),
            landlock_abi: crate::sandbox::landlock_abi(),
            claude_path: self.claude.as_ref().map(|c| c.path.display().to_string()),
            claude_version: self.claude_version.read().clone(),
            config_error: self.config_error.read().clone(),
        }
    }

    pub fn live_count(&self, id: Option<AccountId>) -> usize {
        self.live.lock().values().filter(|h| id.map(|i| h.account == i).unwrap_or(true)).count()
    }

    pub fn live_pids(&self) -> Vec<(String, AccountId, i64)> {
        let live: Vec<(String, AccountId)> = self.live.lock().iter().map(|(k, h)| (k.clone(), h.account)).collect();
        live.into_iter()
            .filter_map(|(id, acc)| self.db(acc).get_session(&id).ok().and_then(|s| s.pid).map(|p| (id, acc, p)))
            .collect()
    }
}

/// Samples /proc only while the UI is visible; cadence 2s with live
/// sessions, 15s otherwise. Sleeps on a Notify while hidden (zero polling).
pub async fn metrics_loop(st: Arc<AppState>) {
    let mut sampler = crate::metrics::Sampler::default();
    let me = std::process::id() as i64;
    loop {
        if !st.emitter.visible.load(Ordering::Relaxed) {
            st.visibility.notified().await;
            continue;
        }
        let snap = snapshot(&st, &mut sampler, me);
        let live = !snap.sessions.is_empty();
        st.emitter.try_send(UiEvent::Metrics { snapshot: snap });
        sampler.gc();
        let wait = if live { 2 } else { 15 };
        tokio::select! {
            _ = tokio::time::sleep(std::time::Duration::from_secs(wait)) => {}
            _ = st.visibility.notified() => {}
        }
    }
}

pub fn snapshot(st: &AppState, sampler: &mut crate::metrics::Sampler, me: i64) -> MetricsSnapshot {
    let sessions_pids = st.live_pids();
    let mut session_trees = std::collections::HashSet::new();
    let mut sessions = vec![];
    for (id, acc, pid) in sessions_pids {
        let tree = crate::metrics::tree(pid);
        session_trees.extend(tree.iter().copied());
        sessions.push(SessionProc { session_id: id, account: acc, stat: sampler.sample(&tree) });
    }
    let others: Vec<i64> = crate::metrics::tree(me).into_iter().filter(|p| !session_trees.contains(p)).collect();
    let webview: Vec<i64> = others
        .iter()
        .copied()
        .filter(|p| *p != me && crate::metrics::read_proc(*p).map(|i| i.comm.starts_with("WebKit")).unwrap_or(false))
        .collect();
    let app = sampler.sample(&[me]);
    let wv = sampler.sample(&webview);
    MetricsSnapshot { ts: now_ms(), app, webview_rss_bytes: wv.rss_bytes, sessions, scheduler: st.scheduler.view() }
}
