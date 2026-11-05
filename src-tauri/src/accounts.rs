//! Account model and cross-account isolation invariants.
use crate::error::{AppError, AppResult};
use crate::paths;
use serde::{Deserialize, Serialize};
use std::path::{Path, PathBuf};

#[derive(Serialize, Deserialize, Clone, Copy, PartialEq, Eq, Hash, Debug, PartialOrd, Ord)]
#[serde(rename_all = "lowercase")]
pub enum AccountId {
    Personal,
    Work,
}

impl AccountId {
    pub const ALL: [AccountId; 2] = [AccountId::Personal, AccountId::Work];
    pub fn as_str(self) -> &'static str {
        match self {
            AccountId::Personal => "personal",
            AccountId::Work => "work",
        }
    }
    pub fn other(self) -> AccountId {
        match self {
            AccountId::Personal => AccountId::Work,
            AccountId::Work => AccountId::Personal,
        }
    }
    pub fn parse(s: &str) -> AppResult<AccountId> {
        match s {
            "personal" => Ok(AccountId::Personal),
            "work" => Ok(AccountId::Work),
            _ => Err(AppError::Invalid(format!("unknown account '{s}'"))),
        }
    }
}

#[derive(Serialize, Deserialize, Clone, Copy, PartialEq, Eq, Debug, Default)]
#[serde(rename_all = "camelCase")]
pub enum PermissionMode {
    /// Claude Code "auto" mode: the CLI's classifier approves routine actions
    /// on its own. Never maps to bypassPermissions.
    #[default]
    Auto,
    Default,
    AcceptEdits,
    Plan,
}

impl PermissionMode {
    pub fn cli_value(self) -> &'static str {
        match self {
            PermissionMode::Auto => "auto",
            PermissionMode::Default => "default",
            PermissionMode::AcceptEdits => "acceptEdits",
            PermissionMode::Plan => "plan",
        }
    }
}

#[derive(Serialize, Deserialize, Clone, Debug, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct AccountConfig {
    pub id: AccountId,
    pub label: String,
    /// Expected authenticated identity. Execution is blocked unless
    /// `claude auth status` reports exactly this email. Empty = not linked yet:
    /// the first successful login on this account binds its email here.
    pub email: String,
    pub workspace_root: PathBuf,
    pub config_dir: PathBuf,
    /// Extra read-only paths exposed inside the sandbox (toolchains etc).
    #[serde(default)]
    pub extra_read_paths: Vec<PathBuf>,
    /// Extra read-write paths exposed inside the sandbox.
    #[serde(default)]
    pub extra_write_paths: Vec<PathBuf>,
    #[serde(default)]
    pub default_model: Option<String>,
    #[serde(default)]
    pub default_permission_mode: PermissionMode,
    /// Folder with skills (`.claude/skills`), a CLAUDE.md and optionally a plugin manifest that
    /// every session of this account loads. Read-only inside the sandbox.
    #[serde(default)]
    pub behavior_dir: Option<PathBuf>,
}

fn pick_workspace(home: &Path, name: &str) -> PathBuf {
    let direct = home.join(name);
    if direct.is_dir() {
        return direct;
    }
    let desk = home.join("Desktop").join(name);
    if desk.is_dir() {
        return desk;
    }
    direct
}

pub fn default_accounts(home: &Path) -> Vec<AccountConfig> {
    let toolchains: Vec<PathBuf> = [".nvm", ".cargo", ".rustup", ".bun", ".deno", ".local/bin", ".gitconfig", ".config/git"]
        .iter()
        .map(|p| home.join(p))
        .collect();
    vec![
        AccountConfig {
            id: AccountId::Personal,
            label: "Pessoal".into(),
            email: String::new(),
            workspace_root: pick_workspace(home, "personal"),
            config_dir: home.join(".claude-personal"),
            extra_read_paths: toolchains.clone(),
            extra_write_paths: vec![],
            default_model: None,
            default_permission_mode: PermissionMode::Auto,
            behavior_dir: None,
        },
        AccountConfig {
            id: AccountId::Work,
            label: "Trabalho".into(),
            email: String::new(),
            workspace_root: pick_workspace(home, "work"),
            config_dir: home.join(".claude-work"),
            extra_read_paths: toolchains,
            extra_write_paths: vec![],
            default_model: None,
            default_permission_mode: PermissionMode::Auto,
            behavior_dir: None,
        },
    ]
}

/// Paths that belong exclusively to one account (canonicalised when they exist).
pub fn private_roots(a: &AccountConfig) -> Vec<PathBuf> {
    vec![paths::normalize(&a.workspace_root), paths::normalize(&a.config_dir)]
}

/// Validates both accounts together. Any overlap between one account's
/// private roots and the other's is a hard isolation failure.
pub fn validate_pair(accounts: &[AccountConfig], home: &Path) -> AppResult<Vec<String>> {
    let mut warnings = vec![];
    if accounts.len() != 2 || accounts[0].id == accounts[1].id {
        return Err(AppError::Isolation("exactly one personal and one work account required".into()));
    }
    let home_n = paths::normalize(home);
    for a in accounts {
        if !a.email.trim().is_empty() && !a.email.contains('@') {
            return Err(AppError::Invalid(format!("{}: invalid email", a.id.as_str())));
        }
        for root in private_roots(a) {
            if root == home_n || root == Path::new("/") {
                return Err(AppError::Isolation(format!("{}: {} is too broad", a.id.as_str(), root.display())));
            }
        }
        let ws = paths::normalize(&a.workspace_root);
        let cfg = paths::normalize(&a.config_dir);
        if paths::overlaps(&ws, &cfg) {
            return Err(AppError::Isolation(format!(
                "{}: config dir must not be inside the workspace (agents could read credentials)",
                a.id.as_str()
            )));
        }
        if cfg == home_n.join(".claude") {
            warnings.push(format!(
                "{}: ~/.claude is the global default config dir; any bare `claude` invocation will use this account",
                a.id.as_str()
            ));
        }
        for p in a.extra_read_paths.iter().chain(a.extra_write_paths.iter()).chain(a.behavior_dir.iter()) {
            let n = paths::normalize(p);
            if n == home_n || n == Path::new("/") || home_n.starts_with(&n) {
                return Err(AppError::Isolation(format!("{}: extra path {} is too broad", a.id.as_str(), n.display())));
            }
        }
    }
    let (a, b) = (&accounts[0], &accounts[1]);
    for (x, y) in [(a, b), (b, a)] {
        let theirs = private_roots(y);
        let mine: Vec<PathBuf> = private_roots(x)
            .into_iter()
            .chain(x.extra_read_paths.iter().map(|p| paths::normalize(p)))
            .chain(x.extra_write_paths.iter().map(|p| paths::normalize(p)))
            .chain(x.behavior_dir.iter().map(|p| paths::normalize(p)))
            .collect();
        for m in &mine {
            for t in &theirs {
                if paths::overlaps(m, t) {
                    return Err(AppError::Isolation(format!(
                        "{} path {} overlaps {} private path {}",
                        x.id.as_str(),
                        m.display(),
                        y.id.as_str(),
                        t.display()
                    )));
                }
            }
        }
    }
    if !a.email.trim().is_empty() && a.email.trim().eq_ignore_ascii_case(b.email.trim()) {
        return Err(AppError::Isolation("both accounts use the same email".into()));
    }
    Ok(warnings)
}

#[cfg(test)]
mod tests {
    use super::*;
    fn mk(dir: &Path) -> Vec<AccountConfig> {
        let mut v = default_accounts(dir);
        v[0].workspace_root = dir.join("personal");
        v[1].workspace_root = dir.join("work");
        v[0].email = "me@example.com".into();
        v[1].email = "work.user@example.com".into();
        v[0].extra_read_paths.clear();
        v[1].extra_read_paths.clear();
        std::fs::create_dir_all(&v[0].workspace_root).unwrap();
        std::fs::create_dir_all(&v[1].workspace_root).unwrap();
        v
    }
    #[test]
    fn defaults_are_valid() {
        let t = tempfile::tempdir().unwrap();
        assert!(validate_pair(&mk(t.path()), t.path()).is_ok());
    }
    #[test]
    fn behavior_dir_cannot_expose_the_other_account() {
        let t = tempfile::tempdir().unwrap();
        let mut v = mk(t.path());
        let shared = t.path().join("brains/work");
        std::fs::create_dir_all(&shared).unwrap();
        v[1].behavior_dir = Some(shared);
        assert!(validate_pair(&v, t.path()).is_ok());
        v[1].behavior_dir = Some(v[0].workspace_root.join("skills"));
        assert!(matches!(validate_pair(&v, t.path()), Err(AppError::Isolation(_))));
        v[1].behavior_dir = Some(t.path().to_path_buf());
        assert!(validate_pair(&v, t.path()).is_err());
    }
    #[test]
    fn unlinked_emails_are_allowed_but_malformed_are_not() {
        let t = tempfile::tempdir().unwrap();
        let mut v = mk(t.path());
        v[0].email.clear();
        v[1].email.clear();
        assert!(validate_pair(&v, t.path()).is_ok());
        v[0].email = "nope".into();
        assert!(validate_pair(&v, t.path()).is_err());
    }
    #[test]
    fn rejects_nested_workspaces() {
        let t = tempfile::tempdir().unwrap();
        let mut v = mk(t.path());
        v[1].workspace_root = v[0].workspace_root.join("sub");
        std::fs::create_dir_all(&v[1].workspace_root).unwrap();
        assert!(matches!(validate_pair(&v, t.path()), Err(AppError::Isolation(_))));
    }
    #[test]
    fn rejects_shared_config_dir() {
        let t = tempfile::tempdir().unwrap();
        let mut v = mk(t.path());
        v[1].config_dir = v[0].config_dir.clone();
        assert!(matches!(validate_pair(&v, t.path()), Err(AppError::Isolation(_))));
    }
    #[test]
    fn rejects_config_inside_workspace() {
        let t = tempfile::tempdir().unwrap();
        let mut v = mk(t.path());
        v[0].config_dir = v[0].workspace_root.join(".claude");
        assert!(matches!(validate_pair(&v, t.path()), Err(AppError::Isolation(_))));
    }
    #[test]
    fn rejects_extra_path_exposing_other_account() {
        let t = tempfile::tempdir().unwrap();
        let mut v = mk(t.path());
        v[0].extra_read_paths = vec![v[1].workspace_root.clone()];
        assert!(matches!(validate_pair(&v, t.path()), Err(AppError::Isolation(_))));
        let mut v = mk(t.path());
        v[0].extra_read_paths = vec![t.path().to_path_buf()];
        assert!(validate_pair(&v, t.path()).is_err());
    }
    #[test]
    fn rejects_symlinked_workspace_alias() {
        let t = tempfile::tempdir().unwrap();
        let mut v = mk(t.path());
        let link = t.path().join("alias");
        std::os::unix::fs::symlink(&v[0].workspace_root, &link).unwrap();
        v[1].workspace_root = link;
        assert!(matches!(validate_pair(&v, t.path()), Err(AppError::Isolation(_))));
    }
    #[test]
    fn rejects_same_email() {
        let t = tempfile::tempdir().unwrap();
        let mut v = mk(t.path());
        v[1].email = v[0].email.to_uppercase();
        assert!(validate_pair(&v, t.path()).is_err());
    }
}
