//! Path validation: traversal, symlink escape and cross-workspace access.
use crate::accounts::AccountConfig;
use crate::error::{AppError, AppResult};
use std::path::{Component, Path, PathBuf};

/// Canonicalises if the path exists; otherwise canonicalises the deepest
/// existing ancestor and appends the remaining (lexically cleaned) tail.
pub fn normalize(p: &Path) -> PathBuf {
    if let Ok(c) = p.canonicalize() {
        return c;
    }
    let mut tail = vec![];
    let mut cur = p.to_path_buf();
    loop {
        if let Ok(c) = cur.canonicalize() {
            let mut out = c;
            for t in tail.iter().rev() {
                out.push(t);
            }
            return lexical_clean(&out);
        }
        match (cur.file_name().map(|s| s.to_owned()), cur.parent()) {
            (Some(name), Some(parent)) => {
                tail.push(name);
                cur = parent.to_path_buf();
            }
            _ => return lexical_clean(p),
        }
    }
}

pub fn lexical_clean(p: &Path) -> PathBuf {
    let mut out = PathBuf::new();
    for c in p.components() {
        match c {
            Component::ParentDir => {
                out.pop();
            }
            Component::CurDir => {}
            other => out.push(other.as_os_str()),
        }
    }
    out
}

pub fn overlaps(a: &Path, b: &Path) -> bool {
    a.starts_with(b) || b.starts_with(a)
}

fn reject_suspicious(input: &str) -> AppResult<()> {
    if input.is_empty() {
        return Err(AppError::Path("empty path".into()));
    }
    if input.contains('\0') || input.chars().any(|c| c.is_control()) {
        return Err(AppError::Path("control characters in path".into()));
    }
    Ok(())
}

/// Validates that `input` is a git repository inside `acc`'s workspace and
/// does not touch `other`'s private roots. Symlinks are resolved first, so a
/// link inside the workspace pointing elsewhere is rejected.
pub fn validate_repo(acc: &AccountConfig, other: &AccountConfig, input: &str) -> AppResult<PathBuf> {
    reject_suspicious(input)?;
    let raw = Path::new(input);
    if !raw.is_absolute() {
        return Err(AppError::Path("repository path must be absolute".into()));
    }
    let real = raw
        .canonicalize()
        .map_err(|_| AppError::Path(format!("{} does not exist", raw.display())))?;
    if !real.is_dir() {
        return Err(AppError::Path("not a directory".into()));
    }
    let ws = acc
        .workspace_root
        .canonicalize()
        .map_err(|_| AppError::Path(format!("workspace {} missing", acc.workspace_root.display())))?;
    if !real.starts_with(&ws) {
        return Err(AppError::Isolation(format!(
            "{} resolves outside the {} workspace",
            input,
            acc.id.as_str()
        )));
    }
    for root in crate::accounts::private_roots(other) {
        if overlaps(&real, &root) {
            return Err(AppError::Isolation(format!("{} belongs to the {} account", input, other.id.as_str())));
        }
    }
    if overlaps(&real, &normalize(&acc.config_dir)) {
        return Err(AppError::Isolation("repository overlaps the account config dir".into()));
    }
    if !real.join(".git").exists() {
        return Err(AppError::Path("not a git repository".into()));
    }
    Ok(real)
}

/// Validates a path relative to a repo (for diffs). No absolute paths, no
/// `..`, and if it exists it must resolve inside the repo.
pub fn validate_repo_relative(repo: &Path, rel: &str) -> AppResult<PathBuf> {
    reject_suspicious(rel)?;
    let p = Path::new(rel);
    if p.is_absolute() || p.components().any(|c| matches!(c, Component::ParentDir | Component::RootDir | Component::Prefix(_))) {
        return Err(AppError::Path("relative path escapes repository".into()));
    }
    let joined = repo.join(p);
    if let Ok(real) = joined.canonicalize() {
        if !real.starts_with(repo) {
            return Err(AppError::Path("symlink escapes repository".into()));
        }
    }
    Ok(p.to_path_buf())
}

/// Validates a user-provided slug (branch / worktree names).
pub fn validate_slug(s: &str) -> AppResult<String> {
    let ok = !s.is_empty()
        && s.len() <= 64
        && s.chars().all(|c| c.is_ascii_alphanumeric() || c == '-' || c == '_')
        && !s.starts_with('-');
    if ok { Ok(s.to_string()) } else { Err(AppError::Invalid("use 1-64 chars [A-Za-z0-9_-], not starting with '-'".into())) }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::accounts::default_accounts;

    struct Fx {
        _t: tempfile::TempDir,
        acc: Vec<AccountConfig>,
    }
    fn fx() -> Fx {
        let t = tempfile::tempdir().unwrap();
        let mut acc = default_accounts(t.path());
        acc[0].workspace_root = t.path().join("personal");
        acc[1].workspace_root = t.path().join("work");
        for a in &acc {
            std::fs::create_dir_all(a.workspace_root.join("repo/.git")).unwrap();
        }
        Fx { _t: t, acc }
    }

    #[test]
    fn accepts_repo_in_own_workspace() {
        let f = fx();
        let p = f.acc[0].workspace_root.join("repo");
        assert!(validate_repo(&f.acc[0], &f.acc[1], p.to_str().unwrap()).is_ok());
    }
    #[test]
    fn rejects_other_account_repo() {
        let f = fx();
        let p = f.acc[1].workspace_root.join("repo");
        let e = validate_repo(&f.acc[0], &f.acc[1], p.to_str().unwrap()).unwrap_err();
        assert!(matches!(e, AppError::Isolation(_)));
        let p = f.acc[0].workspace_root.join("repo");
        assert!(validate_repo(&f.acc[1], &f.acc[0], p.to_str().unwrap()).is_err());
    }
    #[test]
    fn rejects_traversal() {
        let f = fx();
        let p = format!("{}/../work/repo", f.acc[0].workspace_root.display());
        assert!(matches!(validate_repo(&f.acc[0], &f.acc[1], &p), Err(AppError::Isolation(_))));
    }
    #[test]
    fn rejects_symlink_escape() {
        let f = fx();
        let link = f.acc[0].workspace_root.join("sneaky");
        std::os::unix::fs::symlink(f.acc[1].workspace_root.join("repo"), &link).unwrap();
        assert!(matches!(
            validate_repo(&f.acc[0], &f.acc[1], link.to_str().unwrap()),
            Err(AppError::Isolation(_))
        ));
    }
    #[test]
    fn rejects_relative_and_control_chars() {
        let f = fx();
        assert!(validate_repo(&f.acc[0], &f.acc[1], "repo").is_err());
        assert!(validate_repo(&f.acc[0], &f.acc[1], "/tmp/a\nb").is_err());
        assert!(validate_repo(&f.acc[0], &f.acc[1], "").is_err());
    }
    #[test]
    fn repo_relative_rules() {
        let f = fx();
        let repo = f.acc[0].workspace_root.join("repo").canonicalize().unwrap();
        assert!(validate_repo_relative(&repo, "src/main.rs").is_ok());
        assert!(validate_repo_relative(&repo, "../x").is_err());
        assert!(validate_repo_relative(&repo, "/etc/passwd").is_err());
        std::os::unix::fs::symlink("/etc", repo.join("etc")).unwrap();
        assert!(validate_repo_relative(&repo, "etc/passwd").is_err());
    }
    #[test]
    fn slug_rules() {
        assert!(validate_slug("feat-x_1").is_ok());
        assert!(validate_slug("-rf").is_err());
        assert!(validate_slug("a;b").is_err());
        assert!(validate_slug("a/b").is_err());
    }
}
