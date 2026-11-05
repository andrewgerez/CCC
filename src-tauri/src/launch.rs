//! Builds the sandboxed, account-scoped command for every Claude CLI process.
use crate::accounts::AccountConfig;
use crate::envsafe::{self, EnvPaths};
use crate::error::{AppError, AppResult};
use crate::sandbox::{self, PolicyInputs};
use std::path::{Path, PathBuf};
use std::process::Stdio;

#[derive(Clone, Debug)]
pub struct ClaudeBin {
    pub path: PathBuf,
    pub install_dir: PathBuf,
}

impl ClaudeBin {
    pub fn discover(home: &Path) -> Option<ClaudeBin> {
        let mut candidates: Vec<PathBuf> = std::env::var("PATH")
            .unwrap_or_default()
            .split(':')
            .map(|d| Path::new(d).join("claude"))
            .collect();
        candidates.push(home.join(".local/bin/claude"));
        candidates.push(home.join(".claude/local/claude"));
        for c in candidates {
            if let Ok(real) = c.canonicalize() {
                if real.is_file() {
                    let s = real.display().to_string();
                    let install_dir = match s.find("/versions/") {
                        Some(i) => PathBuf::from(&s[..i]),
                        None => real.parent().map(Path::to_path_buf).unwrap_or_default(),
                    };
                    return Some(ClaudeBin { path: real, install_dir });
                }
            }
        }
        None
    }
}

#[derive(Clone, Debug)]
pub struct DataDirs {
    pub root: PathBuf,
}

impl DataDirs {
    pub fn tmp(&self, a: &AccountConfig) -> PathBuf {
        self.root.join("tmp").join(a.id.as_str())
    }
    pub fn cache(&self, a: &AccountConfig) -> PathBuf {
        self.root.join("cache").join(a.id.as_str())
    }
    pub fn worktrees(&self, a: &AccountConfig) -> PathBuf {
        self.root.join("worktrees").join(a.id.as_str())
    }
}

pub fn ensure_private_dir(p: &Path) -> AppResult<()> {
    use std::os::unix::fs::PermissionsExt;
    std::fs::create_dir_all(p)?;
    std::fs::set_permissions(p, std::fs::Permissions::from_mode(0o700))?;
    Ok(())
}

pub struct LaunchSpec<'a> {
    pub account: &'a AccountConfig,
    pub other: &'a AccountConfig,
    pub claude: &'a ClaudeBin,
    pub data: &'a DataDirs,
    pub enforce: bool,
    pub writable: Vec<PathBuf>,
    pub cwd: PathBuf,
    pub args: Vec<String>,
    pub run_id: String,
}

const FORBIDDEN_ARGS: &[&str] = &["--dangerously-skip-permissions", "--allow-dangerously-skip-permissions", "bypassPermissions"];

pub fn command(spec: &LaunchSpec) -> AppResult<tokio::process::Command> {
    command_with(spec, &spec.claude.path, &spec.args)
}

/// Same sandbox, env and policy as `command`, but running another program (e.g. `script` for a pty).
pub fn command_with(spec: &LaunchSpec, program: &Path, args: &[String]) -> AppResult<tokio::process::Command> {
    if args.iter().any(|a| FORBIDDEN_ARGS.iter().any(|f| a.contains(f))) {
        return Err(AppError::Invalid("permission bypass flags are never allowed".into()));
    }
    let home = dirs::home_dir().ok_or_else(|| AppError::Invalid("no home dir".into()))?;
    let tmp = spec.data.tmp(spec.account);
    let cache = spec.data.cache(spec.account);
    ensure_private_dir(&spec.account.config_dir)?;
    ensure_private_dir(&tmp)?;
    ensure_private_dir(&cache)?;
    let policy = sandbox::build_policy(&PolicyInputs {
        account: spec.account,
        other: spec.other,
        writable_dirs: spec.writable.clone(),
        claude_install_dir: &spec.claude.install_dir,
        tmp_dir: &tmp,
        cache_dir: &cache,
        enforce: spec.enforce,
    })?;
    let (exe, argv) = sandbox::launcher_argv(program, args)?;
    let env = envsafe::build_env(
        spec.account,
        &spec.run_id,
        &EnvPaths { home: &home, tmp_dir: &tmp, cache_dir: &cache },
        std::env::vars(),
    );
    let mut cmd = tokio::process::Command::new(exe);
    cmd.args(argv)
        .env_clear()
        .envs(env)
        .env(sandbox::POLICY_ENV, serde_json::to_string(&policy)?)
        .current_dir(&spec.cwd)
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .process_group(0)
        .kill_on_drop(true);
    Ok(cmd)
}

/// Read/write roots used for defense-in-depth checks of tool paths.
pub fn policy_roots(spec_writable: &[PathBuf], a: &AccountConfig) -> (Vec<PathBuf>, Vec<PathBuf>) {
    let mut write: Vec<PathBuf> = spec_writable.iter().map(|p| crate::paths::normalize(p)).collect();
    write.push(crate::paths::normalize(&a.config_dir));
    let mut read = write.clone();
    read.extend(a.extra_read_paths.iter().map(|p| crate::paths::normalize(p)));
    (read, write)
}
