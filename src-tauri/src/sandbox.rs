//! Kernel-enforced filesystem isolation via Landlock (unprivileged).
//!
//! The app re-executes its own binary as `--ccc-sandbox-exec -- <program> <args>`
//! with the policy in `CCC_SANDBOX_POLICY`. The launcher applies a Landlock
//! ruleset (deny-by-default allowlist) and then `exec`s the program, so the
//! Claude CLI and every subprocess it spawns (Bash tool, git, MCP servers,
//! hooks) inherit the restriction. Nothing outside the allowlist — notably the
//! other account's workspace and config dir — can be read, written or executed.
//!
//! Limitations (documented, not hidden):
//! - Network is NOT restricted (the CLI needs the API).
//! - Paths in the read-only allowlist (system dirs, toolchains) are visible to
//!   both accounts. They must not contain account-private data.
//! - Abstract unix sockets and signals are scoped (ABI >= 6); pathname unix
//!   sockets of other processes may still be connectable if their directory
//!   is in the allowlist.
use crate::accounts::AccountConfig;
use crate::error::{AppError, AppResult};
use crate::paths;
use serde::{Deserialize, Serialize};
use std::path::{Path, PathBuf};

pub const LAUNCH_FLAG: &str = "--ccc-sandbox-exec";
pub const POLICY_ENV: &str = "CCC_SANDBOX_POLICY";

#[derive(Serialize, Deserialize, Clone, Debug, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct Policy {
    pub read: Vec<PathBuf>,
    pub write: Vec<PathBuf>,
    /// When false the launcher still runs (for auditing) but applies nothing.
    /// Only reachable when the user explicitly disabled the sandbox.
    pub enforce: bool,
}

pub struct PolicyInputs<'a> {
    pub account: &'a AccountConfig,
    pub other: &'a AccountConfig,
    pub writable_dirs: Vec<PathBuf>,
    pub claude_install_dir: &'a Path,
    pub tmp_dir: &'a Path,
    pub cache_dir: &'a Path,
    pub enforce: bool,
}

const SYSTEM_RO: &[&str] = &["/usr", "/bin", "/sbin", "/lib", "/lib32", "/lib64", "/etc", "/opt", "/proc", "/sys", "/snap"];

pub fn build_policy(i: &PolicyInputs) -> AppResult<Policy> {
    let mut read: Vec<PathBuf> = SYSTEM_RO.iter().map(PathBuf::from).collect();
    // /etc/resolv.conf is usually a symlink into /run/systemd/resolve.
    if let Ok(real) = Path::new("/etc/resolv.conf").canonicalize() {
        if let Some(parent) = real.parent() {
            read.push(parent.to_path_buf());
        }
    }
    read.push(i.claude_install_dir.to_path_buf());
    read.extend(i.account.extra_read_paths.iter().cloned());

    let mut write: Vec<PathBuf> = vec![
        PathBuf::from("/dev"),
        i.account.config_dir.clone(),
        i.tmp_dir.to_path_buf(),
        i.cache_dir.to_path_buf(),
    ];
    write.extend(i.writable_dirs.iter().cloned());
    write.extend(i.account.extra_write_paths.iter().cloned());

    let read: Vec<PathBuf> = read.iter().map(|p| paths::normalize(p)).collect();
    let write: Vec<PathBuf> = write.iter().map(|p| paths::normalize(p)).collect();

    // Hard invariant: nothing in the allowlist may expose the other account.
    let forbidden = crate::accounts::private_roots(i.other);
    for p in read.iter().chain(write.iter()) {
        for f in &forbidden {
            if paths::overlaps(p, f) {
                return Err(AppError::Isolation(format!(
                    "sandbox allowlist entry {} would expose {} private path {}",
                    p.display(),
                    i.other.id.as_str(),
                    f.display()
                )));
            }
        }
    }
    // Writable repos must be inside the account workspace (worktree base aside).
    Ok(Policy { read, write, enforce: i.enforce })
}

/// Returns the argv to spawn: [self_exe, LAUNCH_FLAG, "--", program, args...]
pub fn launcher_argv(program: &Path, args: &[String]) -> AppResult<(PathBuf, Vec<String>)> {
    let me = std::env::current_exe().map_err(|e| AppError::Sandbox(format!("current_exe: {e}")))?;
    let mut a = vec![LAUNCH_FLAG.to_string(), "--".to_string(), program.display().to_string()];
    a.extend(args.iter().cloned());
    Ok((me, a))
}

/// Entry point for the launcher mode. Never returns on success.
pub fn exec_main(argv: Vec<String>) -> ! {
    use std::os::unix::process::CommandExt;
    let fail = |msg: String| -> ! {
        eprintln!("ccc-sandbox: {msg}");
        std::process::exit(126);
    };
    let sep = argv.iter().position(|a| a == "--").unwrap_or_else(|| fail("missing --".into()));
    let rest = &argv[sep + 1..];
    if rest.is_empty() {
        fail("missing program".into());
    }
    let raw = std::env::var(POLICY_ENV).unwrap_or_else(|_| fail("missing policy".into()));
    let policy: Policy = serde_json::from_str(&raw).unwrap_or_else(|e| fail(format!("bad policy: {e}")));
    let env: Vec<(String, String)> = std::env::vars().filter(|(k, _)| k != POLICY_ENV).collect();

    // Die with the app: no orphaned Claude processes if the app crashes.
    let _ = nix::sys::prctl::set_pdeathsig(nix::sys::signal::Signal::SIGTERM);
    if nix::unistd::getppid() == nix::unistd::Pid::from_raw(1) {
        fail("parent already exited".into());
    }
    if policy.enforce {
        if let Err(e) = apply_landlock(&policy) {
            fail(format!("refusing to run unsandboxed: {e}"));
        }
    }
    let err = std::process::Command::new(&rest[0]).args(&rest[1..]).env_clear().envs(env).exec();
    fail(format!("exec {}: {err}", rest[0]));
}

pub fn apply_landlock(policy: &Policy) -> Result<(), String> {
    use landlock::{
        path_beneath_rules, Access, AccessFs, CompatLevel, Compatible, Ruleset, RulesetAttr, RulesetCreatedAttr,
        RulesetStatus, Scope, ABI,
    };
    let abi = ABI::V6;
    let ro = AccessFs::from_read(abi);
    let rw = AccessFs::from_all(abi);
    let status = Ruleset::default()
        .set_compatibility(CompatLevel::BestEffort)
        .handle_access(rw)
        .and_then(|r| r.scope(Scope::AbstractUnixSocket | Scope::Signal))
        .and_then(|r| r.create())
        .and_then(|r| r.add_rules(path_beneath_rules(&policy.read, ro)))
        .and_then(|r| r.add_rules(path_beneath_rules(&policy.write, rw)))
        .and_then(|r| r.restrict_self())
        .map_err(|e| e.to_string())?;
    match status.ruleset {
        RulesetStatus::FullyEnforced | RulesetStatus::PartiallyEnforced => Ok(()),
        RulesetStatus::NotEnforced => Err("Landlock not supported by this kernel".into()),
    }
}

/// Reports the kernel's Landlock ABI (0 = unsupported) without restricting.
pub fn landlock_abi() -> i64 {
    // SAFETY: landlock_create_ruleset(NULL, 0, LANDLOCK_CREATE_RULESET_VERSION)
    // only queries the ABI version; no memory is passed.
    unsafe { nix::libc::syscall(444, std::ptr::null::<u8>(), 0usize, 1u32) }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::accounts::default_accounts;

    #[test]
    fn policy_never_exposes_other_account() {
        let t = tempfile::tempdir().unwrap();
        let mut acc = default_accounts(t.path());
        acc[0].workspace_root = t.path().join("personal");
        acc[1].workspace_root = t.path().join("work");
        acc[0].extra_read_paths.clear();
        for a in &acc {
            std::fs::create_dir_all(&a.workspace_root).unwrap();
        }
        let repo = acc[0].workspace_root.join("r");
        std::fs::create_dir_all(&repo).unwrap();
        let mk = |writable: Vec<PathBuf>, extra: Vec<PathBuf>| {
            let mut a0 = acc[0].clone();
            a0.extra_read_paths = extra;
            build_policy(&PolicyInputs {
                account: &a0,
                other: &acc[1],
                writable_dirs: writable,
                claude_install_dir: Path::new("/usr/lib"),
                tmp_dir: &t.path().join("tmp/personal"),
                cache_dir: &t.path().join("cache/personal"),
                enforce: true,
            })
        };
        let p = mk(vec![repo.clone()], vec![]).unwrap();
        assert!(p.write.iter().any(|w| w.ends_with("r")));
        assert!(mk(vec![acc[1].workspace_root.clone()], vec![]).is_err());
        assert!(mk(vec![repo.clone()], vec![acc[1].config_dir.clone()]).is_err());
        assert!(mk(vec![repo], vec![t.path().to_path_buf()]).is_err());
    }
}
