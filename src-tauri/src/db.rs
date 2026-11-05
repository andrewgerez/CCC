//! SQLite persistence. One database FILE per account (personal.db, work.db),
//! each stamped with its account id; opening a file with the wrong stamp is
//! refused. Cross-account access is structurally impossible: every query runs
//! on an `AccountDb` bound to a single account. Global, non-sensitive app
//! settings live in app.db.
use crate::accounts::{AccountId, PermissionMode};
use crate::error::{AppError, AppResult};
use crate::model::*;
use parking_lot::Mutex;
use rusqlite::{params, Connection, OptionalExtension};
use std::path::Path;
use std::sync::atomic::{AtomicI64, Ordering};
use std::sync::mpsc;
use std::sync::Arc;
use std::time::Duration;

const SCHEMA: &str = r#"
CREATE TABLE IF NOT EXISTS meta(key TEXT PRIMARY KEY, value TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS sessions(
  id TEXT PRIMARY KEY, repo_path TEXT NOT NULL, worktree_path TEXT, title TEXT NOT NULL,
  status TEXT NOT NULL, model TEXT, permission_mode TEXT NOT NULL, priority INTEGER NOT NULL DEFAULT 0,
  created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL, last_activity TEXT,
  total_cost_usd REAL NOT NULL DEFAULT 0, input_tokens INTEGER NOT NULL DEFAULT 0,
  output_tokens INTEGER NOT NULL DEFAULT 0, turns INTEGER NOT NULL DEFAULT 0, last_error TEXT,
  pid INTEGER, run_id TEXT, resumable INTEGER NOT NULL DEFAULT 0);
CREATE TABLE IF NOT EXISTS agents(session_id TEXT NOT NULL, id TEXT NOT NULL, data TEXT NOT NULL,
  PRIMARY KEY(session_id, id));
CREATE TABLE IF NOT EXISTS events(seq INTEGER PRIMARY KEY, session_id TEXT NOT NULL, ts INTEGER NOT NULL,
  agent_id TEXT, body TEXT NOT NULL);
CREATE INDEX IF NOT EXISTS events_session ON events(session_id, seq);
CREATE TABLE IF NOT EXISTS approvals(request_id TEXT PRIMARY KEY, session_id TEXT NOT NULL, data TEXT NOT NULL,
  decision TEXT, created_at INTEGER NOT NULL);
CREATE TABLE IF NOT EXISTS tasks(id TEXT PRIMARY KEY, repo_path TEXT NOT NULL, title TEXT NOT NULL,
  prompt TEXT NOT NULL, priority INTEGER NOT NULL, status TEXT NOT NULL, session_id TEXT, created_at INTEGER NOT NULL);
CREATE TABLE IF NOT EXISTS projects(id TEXT PRIMARY KEY, data TEXT NOT NULL, created_at INTEGER NOT NULL);
CREATE TABLE IF NOT EXISTS repos(path TEXT PRIMARY KEY, name TEXT NOT NULL, rel_path TEXT NOT NULL, branch TEXT,
  is_worktree INTEGER NOT NULL, seen_at INTEGER NOT NULL);
"#;

fn open_conn(path: &Path) -> AppResult<Connection> {
    let c = Connection::open(path)?;
    c.busy_timeout(Duration::from_secs(5))?;
    c.pragma_update(None, "journal_mode", "WAL")?;
    c.pragma_update(None, "synchronous", "NORMAL")?;
    c.pragma_update(None, "foreign_keys", "ON")?;
    {
        use std::os::unix::fs::PermissionsExt;
        let _ = std::fs::set_permissions(path, std::fs::Permissions::from_mode(0o600));
    }
    Ok(c)
}

enum WriteOp {
    Event { seq: i64, session_id: String, ts: i64, agent_id: Option<String>, body: String },
    Agent { session_id: String, id: String, data: String },
    Flush(mpsc::Sender<()>),
}

pub struct AccountDb {
    pub account: AccountId,
    conn: Mutex<Connection>,
    writer: mpsc::Sender<WriteOp>,
    next_seq: AtomicI64,
    retention: Arc<AtomicI64>,
}

impl AccountDb {
    pub fn open(path: &Path, account: AccountId, retention: u32) -> AppResult<AccountDb> {
        let conn = open_conn(path)?;
        conn.execute_batch(SCHEMA)?;
        // Additive migration (ignored when the column already exists).
        let _ = conn.execute("ALTER TABLE sessions ADD COLUMN extra_dirs TEXT", []);
        let stamp: Option<String> =
            conn.query_row("SELECT value FROM meta WHERE key='account'", [], |r| r.get(0)).optional()?;
        match stamp {
            Some(s) if s != account.as_str() => {
                return Err(AppError::Isolation(format!(
                    "{} is stamped for account '{s}', refusing to open as '{}'",
                    path.display(),
                    account.as_str()
                )));
            }
            Some(_) => {}
            None => {
                conn.execute("INSERT INTO meta(key,value) VALUES('account',?1)", [account.as_str()])?;
            }
        }
        let max: i64 = conn.query_row("SELECT COALESCE(MAX(seq),0) FROM events", [], |r| r.get(0))?;
        let wconn = open_conn(path)?;
        let (tx, rx) = mpsc::channel::<WriteOp>();
        let retention = Arc::new(AtomicI64::new(retention.max(100) as i64));
        let ret = retention.clone();
        std::thread::Builder::new()
            .name(format!("db-writer-{}", account.as_str()))
            .spawn(move || writer_loop(wconn, rx, ret))
            .map_err(AppError::Io)?;
        Ok(AccountDb { account, conn: Mutex::new(conn), writer: tx, next_seq: AtomicI64::new(max + 1), retention })
    }

    pub fn set_retention(&self, n: u32) {
        self.retention.store(n.max(100) as i64, Ordering::Relaxed);
    }

    pub fn next_seq(&self) -> i64 {
        self.next_seq.fetch_add(1, Ordering::Relaxed)
    }

    /// Queue an event for batched persistence (non-blocking).
    pub fn push_event(&self, item: &ChatItem) {
        let body = match serde_json::to_string(&item.body) {
            Ok(b) => b,
            Err(_) => return,
        };
        let _ = self.writer.send(WriteOp::Event {
            seq: item.seq,
            session_id: item.session_id.clone(),
            ts: item.ts,
            agent_id: item.agent_id.clone(),
            body,
        });
    }

    pub fn push_agent(&self, a: &AgentNode) {
        if let Ok(data) = serde_json::to_string(a) {
            let _ = self.writer.send(WriteOp::Agent { session_id: a.session_id.clone(), id: a.id.clone(), data });
        }
    }

    /// Block until queued writes are committed.
    pub fn flush(&self) {
        let (tx, rx) = mpsc::channel();
        if self.writer.send(WriteOp::Flush(tx)).is_ok() {
            let _ = rx.recv_timeout(Duration::from_secs(5));
        }
    }

    // ---------- sessions ----------
    pub fn upsert_session(&self, s: &SessionSummary) -> AppResult<()> {
        if s.account != self.account {
            return Err(AppError::Isolation("session account does not match database".into()));
        }
        let c = self.conn.lock();
        c.execute(
            "INSERT INTO sessions(id,repo_path,worktree_path,title,status,model,permission_mode,priority,created_at,updated_at,
               last_activity,total_cost_usd,input_tokens,output_tokens,turns,last_error,pid,resumable,extra_dirs)
             VALUES(?1,?2,?3,?4,?5,?6,?7,?8,?9,?10,?11,?12,?13,?14,?15,?16,?17,?18,?19)
             ON CONFLICT(id) DO UPDATE SET worktree_path=?3,title=?4,status=?5,model=?6,permission_mode=?7,priority=?8,
               updated_at=?10,last_activity=?11,total_cost_usd=?12,input_tokens=?13,output_tokens=?14,turns=?15,
               last_error=?16,pid=?17,resumable=?18",
            params![
                s.id,
                s.repo_path,
                s.worktree_path,
                s.title,
                s.status.as_str(),
                s.model,
                serde_json::to_string(&s.permission_mode)?,
                s.priority,
                s.created_at,
                s.updated_at,
                s.last_activity,
                s.total_cost_usd,
                s.input_tokens,
                s.output_tokens,
                s.turns,
                s.last_error,
                s.pid,
                s.resumable as i64,
                serde_json::to_string(&s.extra_dirs)?
            ],
        )?;
        Ok(())
    }

    fn row_to_session(&self, r: &rusqlite::Row) -> rusqlite::Result<SessionSummary> {
        let repo_path: String = r.get("repo_path")?;
        let pm: String = r.get("permission_mode")?;
        Ok(SessionSummary {
            id: r.get("id")?,
            account: self.account,
            repo_name: Path::new(&repo_path).file_name().map(|s| s.to_string_lossy().into_owned()).unwrap_or_default(),
            repo_path,
            worktree_path: r.get("worktree_path")?,
            title: r.get("title")?,
            status: SessionStatus::parse(&r.get::<_, String>("status")?),
            model: r.get("model")?,
            permission_mode: serde_json::from_str::<PermissionMode>(&pm).unwrap_or_default(),
            priority: r.get("priority")?,
            created_at: r.get("created_at")?,
            updated_at: r.get("updated_at")?,
            last_activity: r.get("last_activity")?,
            total_cost_usd: r.get("total_cost_usd")?,
            input_tokens: r.get("input_tokens")?,
            output_tokens: r.get("output_tokens")?,
            turns: r.get("turns")?,
            pending_approvals: r.get("pending")?,
            last_error: r.get("last_error")?,
            pid: r.get("pid")?,
            resumable: r.get::<_, i64>("resumable")? != 0,
            extra_dirs: r
                .get::<_, Option<String>>("extra_dirs")?
                .and_then(|j| serde_json::from_str(&j).ok())
                .unwrap_or_default(),
        })
    }

    const SESSION_SELECT: &'static str = "SELECT s.*, (SELECT COUNT(*) FROM approvals a WHERE a.session_id=s.id AND a.decision IS NULL) AS pending FROM sessions s";

    pub fn get_session(&self, id: &str) -> AppResult<SessionSummary> {
        let c = self.conn.lock();
        c.query_row(&format!("{} WHERE s.id=?1", Self::SESSION_SELECT), [id], |r| self.row_to_session(r))
            .optional()?
            .ok_or_else(|| AppError::NotFound(format!("session {id} in {} account", self.account.as_str())))
    }

    pub fn list_sessions(&self) -> AppResult<Vec<SessionSummary>> {
        let c = self.conn.lock();
        let mut st = c.prepare(&format!("{} ORDER BY s.updated_at DESC LIMIT 2000", Self::SESSION_SELECT))?;
        let rows = st.query_map([], |r| self.row_to_session(r))?;
        Ok(rows.filter_map(Result::ok).collect())
    }

    /// Startup reconciliation: nothing is running after a restart.
    pub fn reconcile_after_restart(&self) -> AppResult<Vec<(String, Option<i64>)>> {
        let c = self.conn.lock();
        let mut st = c.prepare(
            "SELECT id, pid FROM sessions WHERE status IN ('queued','starting','running','awaiting_approval','waiting_input')",
        )?;
        let stale: Vec<(String, Option<i64>)> =
            st.query_map([], |r| Ok((r.get(0)?, r.get(1)?)))?.filter_map(Result::ok).collect();
        drop(st);
        c.execute(
            "UPDATE sessions SET status=CASE WHEN status IN ('queued','waiting_input') THEN 'idle' ELSE 'interrupted' END, pid=NULL,
               last_activity='Processo encerrado: aplicativo foi reiniciado', updated_at=?1
             WHERE status IN ('queued','starting','running','awaiting_approval','waiting_input')",
            [now_ms()],
        )?;
        c.execute("UPDATE approvals SET decision='expired' WHERE decision IS NULL", [])?;
        Ok(stale)
    }

    // ---------- agents ----------
    pub fn list_agents(&self, session_id: &str) -> AppResult<Vec<AgentNode>> {
        let c = self.conn.lock();
        let mut st = c.prepare("SELECT data FROM agents WHERE session_id=?1")?;
        let rows = st.query_map([session_id], |r| r.get::<_, String>(0))?;
        Ok(rows.filter_map(Result::ok).filter_map(|d| serde_json::from_str(&d).ok()).collect())
    }

    // ---------- events ----------
    pub fn get_chat(&self, session_id: &str, before_seq: Option<i64>, limit: u32) -> AppResult<Vec<ChatItem>> {
        let c = self.conn.lock();
        let mut st = c.prepare(
            "SELECT seq, ts, agent_id, body FROM events WHERE session_id=?1 AND seq < ?2 ORDER BY seq DESC LIMIT ?3",
        )?;
        let rows = st.query_map(params![session_id, before_seq.unwrap_or(i64::MAX), limit.min(1000)], |r| {
            Ok((r.get::<_, i64>(0)?, r.get::<_, i64>(1)?, r.get::<_, Option<String>>(2)?, r.get::<_, String>(3)?))
        })?;
        let mut out: Vec<ChatItem> = rows
            .filter_map(Result::ok)
            .filter_map(|(seq, ts, agent_id, body)| {
                serde_json::from_str(&body).ok().map(|body| ChatItem { seq, session_id: session_id.to_string(), ts, agent_id, body })
            })
            .collect();
        out.reverse();
        Ok(out)
    }

    // ---------- approvals ----------
    pub fn insert_approval(&self, a: &Approval) -> AppResult<()> {
        let c = self.conn.lock();
        c.execute(
            "INSERT OR REPLACE INTO approvals(request_id, session_id, data, decision, created_at) VALUES(?1,?2,?3,NULL,?4)",
            params![a.request_id, a.session_id, serde_json::to_string(a)?, a.created_at],
        )?;
        Ok(())
    }
    pub fn resolve_approval(&self, request_id: &str, decision: &str) -> AppResult<()> {
        let c = self.conn.lock();
        c.execute("UPDATE approvals SET decision=?2 WHERE request_id=?1", params![request_id, decision])?;
        Ok(())
    }
    pub fn expire_approvals(&self, session_id: &str) -> AppResult<()> {
        let c = self.conn.lock();
        c.execute("UPDATE approvals SET decision='expired' WHERE session_id=?1 AND decision IS NULL", [session_id])?;
        Ok(())
    }
    pub fn pending_approvals(&self, session_id: Option<&str>) -> AppResult<Vec<Approval>> {
        let c = self.conn.lock();
        let mut st = c.prepare(
            "SELECT data FROM approvals WHERE decision IS NULL AND (?1 IS NULL OR session_id=?1) ORDER BY created_at",
        )?;
        let rows = st.query_map([session_id], |r| r.get::<_, String>(0))?;
        Ok(rows.filter_map(Result::ok).filter_map(|d| serde_json::from_str(&d).ok()).collect())
    }

    // ---------- tasks ----------
    pub fn list_tasks(&self, repo: Option<&str>) -> AppResult<Vec<TaskItem>> {
        let c = self.conn.lock();
        let mut st = c.prepare(
            "SELECT id,repo_path,title,prompt,priority,status,session_id,created_at FROM tasks
             WHERE (?1 IS NULL OR repo_path=?1) ORDER BY status='done', priority DESC, created_at",
        )?;
        let rows = st.query_map([repo], |r| {
            Ok(TaskItem {
                id: r.get(0)?,
                account: self.account,
                repo_path: r.get(1)?,
                title: r.get(2)?,
                prompt: r.get(3)?,
                priority: r.get(4)?,
                status: r.get(5)?,
                session_id: r.get(6)?,
                created_at: r.get(7)?,
            })
        })?;
        Ok(rows.filter_map(Result::ok).collect())
    }
    pub fn upsert_task(&self, t: &TaskItem) -> AppResult<()> {
        if t.account != self.account {
            return Err(AppError::Isolation("task account does not match database".into()));
        }
        let c = self.conn.lock();
        c.execute(
            "INSERT INTO tasks(id,repo_path,title,prompt,priority,status,session_id,created_at) VALUES(?1,?2,?3,?4,?5,?6,?7,?8)
             ON CONFLICT(id) DO UPDATE SET title=?3,prompt=?4,priority=?5,status=?6,session_id=?7",
            params![t.id, t.repo_path, t.title, t.prompt, t.priority, t.status, t.session_id, t.created_at],
        )?;
        Ok(())
    }
    pub fn get_task(&self, id: &str) -> AppResult<TaskItem> {
        self.list_tasks(None)?
            .into_iter()
            .find(|t| t.id == id)
            .ok_or_else(|| AppError::NotFound(format!("task {id}")))
    }
    pub fn remove_task(&self, id: &str) -> AppResult<()> {
        self.conn.lock().execute("DELETE FROM tasks WHERE id=?1", [id])?;
        Ok(())
    }

    // ---------- projects ----------
    pub fn list_projects(&self) -> AppResult<Vec<Project>> {
        let c = self.conn.lock();
        let mut st = c.prepare("SELECT data FROM projects ORDER BY created_at")?;
        let rows = st.query_map([], |r| r.get::<_, String>(0))?;
        Ok(rows.filter_map(Result::ok).filter_map(|j| serde_json::from_str(&j).ok()).collect())
    }
    pub fn upsert_project(&self, p: &Project) -> AppResult<()> {
        self.conn.lock().execute(
            "INSERT INTO projects(id,data,created_at) VALUES(?1,?2,?3) ON CONFLICT(id) DO UPDATE SET data=?2",
            params![p.id, serde_json::to_string(p)?, p.created_at],
        )?;
        Ok(())
    }
    /// Removes a session and everything recorded for it (chat, agents, approvals).
    pub fn remove_session(&self, id: &str) -> AppResult<()> {
        let mut c = self.conn.lock();
        let tx = c.transaction()?;
        for t in ["events", "agents", "approvals"] {
            tx.execute(&format!("DELETE FROM {t} WHERE session_id=?1"), [id])?;
        }
        tx.execute("UPDATE tasks SET session_id=NULL WHERE session_id=?1", [id])?;
        tx.execute("DELETE FROM sessions WHERE id=?1", [id])?;
        tx.commit()?;
        Ok(())
    }
    pub fn remove_project(&self, id: &str) -> AppResult<()> {
        self.conn.lock().execute("DELETE FROM projects WHERE id=?1", [id])?;
        Ok(())
    }

    // ---------- repos cache ----------
    pub fn replace_repos(&self, repos: &[RepoInfo]) -> AppResult<()> {
        let mut c = self.conn.lock();
        let tx = c.transaction()?;
        tx.execute("DELETE FROM repos", [])?;
        for r in repos {
            tx.execute(
                "INSERT INTO repos(path,name,rel_path,branch,is_worktree,seen_at) VALUES(?1,?2,?3,?4,?5,?6)",
                params![r.path, r.name, r.rel_path, r.branch, r.is_worktree as i64, now_ms()],
            )?;
        }
        tx.commit()?;
        Ok(())
    }
    pub fn cached_repos(&self) -> AppResult<Vec<RepoInfo>> {
        let c = self.conn.lock();
        let mut st = c.prepare("SELECT path,name,rel_path,branch,is_worktree FROM repos ORDER BY rel_path")?;
        let rows = st.query_map([], |r| {
            Ok(RepoInfo {
                path: r.get(0)?,
                name: r.get(1)?,
                rel_path: r.get(2)?,
                branch: r.get(3)?,
                is_worktree: r.get::<_, i64>(4)? != 0,
            })
        })?;
        Ok(rows.filter_map(Result::ok).collect())
    }
}

fn writer_loop(mut conn: Connection, rx: mpsc::Receiver<WriteOp>, retention: Arc<AtomicI64>) {
    let mut since_prune: i64 = 0;
    loop {
        let first = match rx.recv() {
            Ok(op) => op,
            Err(_) => return,
        };
        // Coalesce whatever arrives within a short window into one transaction.
        let mut batch = vec![first];
        let deadline = std::time::Instant::now() + Duration::from_millis(150);
        while batch.len() < 512 {
            let left = deadline.saturating_duration_since(std::time::Instant::now());
            match rx.recv_timeout(left) {
                Ok(op) => batch.push(op),
                Err(_) => break,
            }
        }
        let mut flushes = vec![];
        let mut sessions_touched = std::collections::HashSet::new();
        if let Ok(tx) = conn.transaction() {
            for op in batch {
                match op {
                    WriteOp::Event { seq, session_id, ts, agent_id, body } => {
                        let _ = tx.execute(
                            "INSERT OR REPLACE INTO events(seq,session_id,ts,agent_id,body) VALUES(?1,?2,?3,?4,?5)",
                            params![seq, session_id, ts, agent_id, body],
                        );
                        since_prune += 1;
                        sessions_touched.insert(session_id);
                    }
                    WriteOp::Agent { session_id, id, data } => {
                        let _ = tx.execute(
                            "INSERT INTO agents(session_id,id,data) VALUES(?1,?2,?3) ON CONFLICT(session_id,id) DO UPDATE SET data=?3",
                            params![session_id, id, data],
                        );
                    }
                    WriteOp::Flush(done) => flushes.push(done),
                }
            }
            if since_prune > 1000 {
                since_prune = 0;
                let keep = retention.load(Ordering::Relaxed);
                for s in &sessions_touched {
                    let _ = tx.execute(
                        "DELETE FROM events WHERE session_id=?1 AND seq < (SELECT seq FROM events WHERE session_id=?1 ORDER BY seq DESC LIMIT 1 OFFSET ?2)",
                        params![s, keep],
                    );
                }
            }
            if let Err(e) = tx.commit() {
                tracing::error!("db batch commit failed: {e}");
            }
        }
        for f in flushes {
            let _ = f.send(());
        }
    }
}

pub struct GlobalDb {
    conn: Mutex<Connection>,
}

impl GlobalDb {
    pub fn open(path: &Path) -> AppResult<GlobalDb> {
        let c = open_conn(path)?;
        c.execute_batch("CREATE TABLE IF NOT EXISTS settings(key TEXT PRIMARY KEY, value TEXT NOT NULL);")?;
        Ok(GlobalDb { conn: Mutex::new(c) })
    }
    pub fn get<T: serde::de::DeserializeOwned>(&self, key: &str) -> AppResult<Option<T>> {
        let c = self.conn.lock();
        let v: Option<String> = c.query_row("SELECT value FROM settings WHERE key=?1", [key], |r| r.get(0)).optional()?;
        Ok(match v {
            Some(s) => serde_json::from_str(&s).ok(),
            None => None,
        })
    }
    pub fn set<T: serde::Serialize>(&self, key: &str, v: &T) -> AppResult<()> {
        let c = self.conn.lock();
        c.execute(
            "INSERT INTO settings(key,value) VALUES(?1,?2) ON CONFLICT(key) DO UPDATE SET value=?2",
            params![key, serde_json::to_string(v)?],
        )?;
        Ok(())
    }
}

#[cfg(test)]
pub mod tests {
    use super::*;

    pub fn sample(account: AccountId, id: &str) -> SessionSummary {
        SessionSummary {
            id: id.into(),
            account,
            repo_path: "/w/repo".into(),
            repo_name: "repo".into(),
            worktree_path: None,
            title: "t".into(),
            status: SessionStatus::Running,
            model: None,
            permission_mode: PermissionMode::Default,
            priority: 0,
            created_at: 1,
            updated_at: 1,
            last_activity: None,
            total_cost_usd: 0.0,
            input_tokens: 0,
            output_tokens: 0,
            turns: 0,
            pending_approvals: 0,
            last_error: None,
            pid: Some(1),
            resumable: false,
            extra_dirs: vec![],
        }
    }

    #[test]
    fn refuses_db_file_of_other_account() {
        let t = tempfile::tempdir().unwrap();
        let p = t.path().join("personal.db");
        drop(AccountDb::open(&p, AccountId::Personal, 100).unwrap());
        assert!(matches!(AccountDb::open(&p, AccountId::Work, 100), Err(AppError::Isolation(_))));
    }

    #[test]
    fn sessions_do_not_cross_databases() {
        let t = tempfile::tempdir().unwrap();
        let p = AccountDb::open(&t.path().join("personal.db"), AccountId::Personal, 100).unwrap();
        let w = AccountDb::open(&t.path().join("work.db"), AccountId::Work, 100).unwrap();
        p.upsert_session(&sample(AccountId::Personal, "s1")).unwrap();
        assert!(matches!(w.get_session("s1"), Err(AppError::NotFound(_))));
        assert!(matches!(w.upsert_session(&sample(AccountId::Personal, "s2")), Err(AppError::Isolation(_))));
        assert_eq!(p.get_session("s1").unwrap().account, AccountId::Personal);
    }

    #[test]
    fn events_batch_and_page() {
        let t = tempfile::tempdir().unwrap();
        let db = AccountDb::open(&t.path().join("personal.db"), AccountId::Personal, 100).unwrap();
        for i in 0..50 {
            db.push_event(&ChatItem {
                seq: db.next_seq(),
                session_id: "s".into(),
                ts: i,
                agent_id: None,
                body: ChatBody::UserText { text: format!("m{i}") },
            });
        }
        db.flush();
        let page = db.get_chat("s", None, 10).unwrap();
        assert_eq!(page.len(), 10);
        assert!(page[0].seq < page[9].seq);
        let older = db.get_chat("s", Some(page[0].seq), 100).unwrap();
        assert_eq!(older.len(), 40);
    }

    #[test]
    fn reconcile_marks_running_as_interrupted() {
        let t = tempfile::tempdir().unwrap();
        let db = AccountDb::open(&t.path().join("personal.db"), AccountId::Personal, 100).unwrap();
        db.upsert_session(&sample(AccountId::Personal, "s1")).unwrap();
        let stale = db.reconcile_after_restart().unwrap();
        assert_eq!(stale.len(), 1);
        let s = db.get_session("s1").unwrap();
        assert_eq!(s.status, SessionStatus::Interrupted);
        assert_eq!(s.pid, None);
    }
}
