//! Read-mostly git integration. Runs git directly (no shell) with hardening
//! flags so a malicious repo config cannot execute code (fsmonitor, hooks,
//! external diff drivers, textconv). Never modifies repos except the explicit,
//! user-initiated `create_worktree`.
use crate::error::{AppError, AppResult};
use crate::model::{FileChange, RepoInfo, RepoStatus};
use std::path::{Path, PathBuf};
use std::time::Duration;

const SKIP_DIRS: &[&str] = &[
    "node_modules", "target", "dist", "build", "vendor", ".venv", "venv", "__pycache__", ".next", ".cache",
    "Pods", ".gradle", "DerivedData", "out",
];
const MAX_DEPTH: usize = 5;
const MAX_DIRS: usize = 40_000;
const MAX_DIFF: usize = 2 * 1024 * 1024;

pub async fn git(repo: &Path, args: &[&str]) -> AppResult<String> {
    let mut cmd = tokio::process::Command::new("git");
    cmd.arg("-C")
        .arg(repo)
        .args(["-c", "core.fsmonitor=false", "-c", "core.hooksPath=/dev/null", "-c", "diff.external=", "--no-optional-locks"])
        .args(args)
        .env_clear()
        .env("PATH", "/usr/bin:/bin")
        .env("HOME", std::env::var("HOME").unwrap_or_default())
        .env("GIT_TERMINAL_PROMPT", "0")
        .env("LC_ALL", "C")
        .stdin(std::process::Stdio::null())
        .kill_on_drop(true);
    let out = tokio::time::timeout(Duration::from_secs(20), cmd.output())
        .await
        .map_err(|_| AppError::Process("git timed out".into()))??;
    if !out.status.success() {
        let err = String::from_utf8_lossy(&out.stderr);
        return Err(AppError::Process(format!("git {}: {}", args.first().unwrap_or(&""), err.trim())));
    }
    let mut s = String::from_utf8_lossy(&out.stdout).into_owned();
    if s.len() > MAX_DIFF {
        let mut cut = MAX_DIFF;
        while !s.is_char_boundary(cut) {
            cut -= 1;
        }
        s.truncate(cut);
        s.push_str("\n… [truncado]\n");
    }
    Ok(s)
}

/// Reads the branch from .git/HEAD without spawning a process.
pub fn read_branch(repo: &Path) -> Option<String> {
    let dotgit = repo.join(".git");
    let gitdir = if dotgit.is_file() {
        let c = std::fs::read_to_string(&dotgit).ok()?;
        let p = c.trim().strip_prefix("gitdir:")?.trim().to_string();
        let p = PathBuf::from(p);
        if p.is_absolute() { p } else { repo.join(p) }
    } else {
        dotgit
    };
    let head = std::fs::read_to_string(gitdir.join("HEAD")).ok()?;
    let head = head.trim();
    Some(match head.strip_prefix("ref: refs/heads/") {
        Some(b) => b.to_string(),
        None => format!("(detached {})", &head[..head.len().min(8)]),
    })
}

/// Breadth-first, bounded, read-only scan. Does not follow symlinks and does
/// not descend into repositories.
pub fn discover(workspace: &Path) -> Vec<RepoInfo> {
    let mut out = vec![];
    let root = match workspace.canonicalize() {
        Ok(r) => r,
        Err(_) => return out,
    };
    let mut queue = std::collections::VecDeque::from([(root.clone(), 0usize)]);
    let mut seen = 0usize;
    while let Some((dir, depth)) = queue.pop_front() {
        seen += 1;
        if seen > MAX_DIRS {
            break;
        }
        let dotgit = dir.join(".git");
        if dotgit.exists() {
            out.push(RepoInfo {
                path: dir.display().to_string(),
                name: dir.file_name().map(|s| s.to_string_lossy().into_owned()).unwrap_or_default(),
                rel_path: dir.strip_prefix(&root).map(|p| p.display().to_string()).unwrap_or_default(),
                branch: read_branch(&dir),
                is_worktree: dotgit.is_file(),
            });
            continue;
        }
        if depth >= MAX_DEPTH {
            continue;
        }
        let Ok(rd) = std::fs::read_dir(&dir) else { continue };
        let mut children: Vec<PathBuf> = rd
            .filter_map(Result::ok)
            .filter(|e| e.file_type().map(|t| t.is_dir() && !t.is_symlink()).unwrap_or(false))
            .filter(|e| {
                let n = e.file_name();
                let n = n.to_string_lossy();
                !n.starts_with('.') && !SKIP_DIRS.contains(&n.as_ref())
            })
            .map(|e| e.path())
            .collect();
        children.sort();
        queue.extend(children.into_iter().map(|c| (c, depth + 1)));
    }
    out.sort_by(|a, b| a.rel_path.cmp(&b.rel_path));
    out
}

pub fn parse_status(raw: &str) -> (Option<String>, Option<String>, i64, i64, Vec<FileChange>) {
    let mut branch = None;
    let mut upstream = None;
    let (mut ahead, mut behind) = (0, 0);
    let mut files = vec![];
    let mut parts = raw.split('\0').peekable();
    while let Some(entry) = parts.next() {
        if entry.is_empty() {
            continue;
        }
        if let Some(h) = entry.strip_prefix("## ") {
            let (names, counts) = match h.find(" [") {
                Some(i) => (&h[..i], Some(&h[i + 2..h.len().saturating_sub(1)])),
                None => (h, None),
            };
            let mut it = names.splitn(2, "...");
            branch = it.next().map(|b| b.trim_start_matches("No commits yet on ").to_string());
            upstream = it.next().map(str::to_string);
            if let Some(c) = counts {
                for part in c.split(", ") {
                    if let Some(n) = part.strip_prefix("ahead ") {
                        ahead = n.parse().unwrap_or(0);
                    }
                    if let Some(n) = part.strip_prefix("behind ") {
                        behind = n.parse().unwrap_or(0);
                    }
                }
            }
            continue;
        }
        if entry.len() < 4 {
            continue;
        }
        let (x, y, path) = (&entry[0..1], &entry[1..2], &entry[3..]);
        if x == "R" || x == "C" {
            parts.next(); // original path follows
        }
        files.push(FileChange { path: path.to_string(), index: x.to_string(), worktree: y.to_string() });
    }
    (branch, upstream, ahead, behind, files)
}

pub async fn status(repo: &Path) -> AppResult<RepoStatus> {
    let raw = git(repo, &["status", "--porcelain=v1", "-b", "-z", "--untracked-files=all"]).await?;
    let (branch, upstream, ahead, behind, files) = parse_status(&raw);
    let wt = git(repo, &["worktree", "list", "--porcelain"]).await.unwrap_or_default();
    let worktrees = wt.lines().filter_map(|l| l.strip_prefix("worktree ").map(str::to_string)).collect();
    Ok(RepoStatus { branch, upstream, ahead, behind, files, worktrees })
}

pub async fn diff(repo: &Path, file: Option<&Path>) -> AppResult<String> {
    let base = ["diff", "--no-ext-diff", "--no-textconv", "--no-color", "HEAD"];
    let mut out = match file {
        Some(f) => {
            let f = f.to_string_lossy().to_string();
            let mut a: Vec<&str> = base.to_vec();
            a.extend(["--", f.as_str()]);
            git(repo, &a).await.unwrap_or_default()
        }
        None => git(repo, &base).await.or_else(|_| Ok::<_, AppError>(String::new()))?,
    };
    if let Some(f) = file {
        if out.is_empty() {
            // Untracked file: show content as an addition.
            let full = repo.join(f);
            if let Ok(meta) = std::fs::metadata(&full) {
                if meta.len() as usize <= MAX_DIFF {
                    if let Ok(c) = std::fs::read_to_string(&full) {
                        out = format!("--- /dev/null\n+++ b/{}\n{}", f.display(), c.lines().map(|l| format!("+{l}\n")).collect::<String>());
                    }
                }
            }
        }
    }
    Ok(out)
}

pub async fn create_worktree(repo: &Path, dest: &Path, branch: &str) -> AppResult<()> {
    if dest.exists() {
        return Err(AppError::Invalid("worktree destination already exists".into()));
    }
    let d = dest.display().to_string();
    git(repo, &["worktree", "add", "-b", branch, &d]).await?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn parses_porcelain_z() {
        let raw = "## main...origin/main [ahead 2, behind 1]\0 M src/a.rs\0R  new.rs\0old.rs\0?? x y.txt\0";
        let (b, u, a, be, f) = parse_status(raw);
        assert_eq!(b.as_deref(), Some("main"));
        assert_eq!(u.as_deref(), Some("origin/main"));
        assert_eq!((a, be), (2, 1));
        assert_eq!(f.len(), 3);
        assert_eq!(f[1].path, "new.rs");
        assert_eq!(f[2].path, "x y.txt");
    }
    #[test]
    fn discovery_skips_heavy_dirs_and_symlinks() {
        let t = tempfile::tempdir().unwrap();
        std::fs::create_dir_all(t.path().join("a/.git")).unwrap();
        std::fs::write(t.path().join("a/.git/HEAD"), "ref: refs/heads/dev\n").unwrap();
        std::fs::create_dir_all(t.path().join("node_modules/b/.git")).unwrap();
        std::fs::create_dir_all(t.path().join("group/c/.git")).unwrap();
        std::os::unix::fs::symlink(t.path().join("a"), t.path().join("link")).unwrap();
        let r = discover(t.path());
        let names: Vec<_> = r.iter().map(|x| x.rel_path.clone()).collect();
        assert_eq!(names, vec!["a", "group/c"]);
        assert_eq!(r[0].branch.as_deref(), Some("dev"));
    }
}
