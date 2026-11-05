//! Live cross-account isolation tests: run real processes through the app's
//! own Landlock launcher with the PERSONAL policy and verify that the WORK
//! account's config dir and workspace are unreachable (and vice versa).
use ccc_lib::accounts::{default_accounts, AccountConfig};
use ccc_lib::envsafe::{build_env, EnvPaths};
use ccc_lib::sandbox::{build_policy, PolicyInputs, LAUNCH_FLAG, POLICY_ENV};
use std::path::{Path, PathBuf};
use std::process::Command;

struct Fx {
    _t: tempfile::TempDir,
    root: PathBuf,
    acc: Vec<AccountConfig>,
}

fn fx() -> Fx {
    let t = tempfile::tempdir().unwrap();
    let root = t.path().canonicalize().unwrap();
    let mut acc = default_accounts(&root);
    acc[0].workspace_root = root.join("personal");
    acc[1].workspace_root = root.join("work");
    acc[0].config_dir = root.join(".claude-personal");
    acc[1].config_dir = root.join(".claude-work");
    for a in acc.iter_mut() {
        a.extra_read_paths.clear();
        std::fs::create_dir_all(a.workspace_root.join("repo/.git")).unwrap();
        std::fs::create_dir_all(&a.config_dir).unwrap();
        std::fs::write(a.config_dir.join(".credentials.json"), format!("{{\"secret\":\"{}\"}}", a.id.as_str())).unwrap();
        std::fs::write(a.workspace_root.join("repo/README"), "hello").unwrap();
    }
    Fx { _t: t, root, acc }
}

/// Runs `argv` inside the sandbox of `me` (index into fx.acc).
fn run_as(f: &Fx, me: usize, argv: &[&str]) -> (bool, String) {
    let (a, o) = (&f.acc[me], &f.acc[1 - me]);
    let tmp = f.root.join(format!("data/tmp/{}", a.id.as_str()));
    let cache = f.root.join(format!("data/cache/{}", a.id.as_str()));
    std::fs::create_dir_all(&tmp).unwrap();
    std::fs::create_dir_all(&cache).unwrap();
    let repo = a.workspace_root.join("repo");
    let policy = build_policy(&PolicyInputs {
        account: a,
        other: o,
        writable_dirs: vec![repo.clone()],
        claude_install_dir: Path::new("/usr/lib"),
        tmp_dir: &tmp,
        cache_dir: &cache,
        enforce: true,
    })
    .unwrap();
    let env = build_env(a, "test", &EnvPaths { home: &f.root, tmp_dir: &tmp, cache_dir: &cache }, std::env::vars());
    let out = Command::new(env!("CARGO_BIN_EXE_ccc"))
        .arg(LAUNCH_FLAG)
        .arg("--")
        .args(argv)
        .env_clear()
        .envs(env)
        .env(POLICY_ENV, serde_json::to_string(&policy).unwrap())
        .current_dir(&repo)
        .output()
        .unwrap();
    let text = format!("{}{}", String::from_utf8_lossy(&out.stdout), String::from_utf8_lossy(&out.stderr));
    (out.status.success(), text)
}

#[test]
fn personal_cannot_read_work_credentials_or_workspace() {
    let f = fx();
    let work_cred = f.acc[1].config_dir.join(".credentials.json");
    let (ok, out) = run_as(&f, 0, &["/usr/bin/cat", work_cred.to_str().unwrap()]);
    assert!(!ok, "personal read work credentials: {out}");
    assert!(!out.contains("\"work\""));
    let (ok, _) = run_as(&f, 0, &["/usr/bin/ls", f.acc[1].workspace_root.to_str().unwrap()]);
    assert!(!ok, "personal listed work workspace");
    let (ok, _) = run_as(&f, 0, &["/usr/bin/touch", f.acc[1].workspace_root.join("repo/pwned").to_str().unwrap()]);
    assert!(!ok);
    assert!(!f.acc[1].workspace_root.join("repo/pwned").exists());
}

#[test]
fn work_cannot_read_personal_credentials_or_workspace() {
    let f = fx();
    let cred = f.acc[0].config_dir.join(".credentials.json");
    let (ok, out) = run_as(&f, 1, &["/usr/bin/cat", cred.to_str().unwrap()]);
    assert!(!ok, "work read personal credentials: {out}");
    let (ok, _) = run_as(&f, 1, &["/usr/bin/cat", f.acc[0].workspace_root.join("repo/README").to_str().unwrap()]);
    assert!(!ok);
}

#[test]
fn own_account_paths_work() {
    let f = fx();
    let (ok, out) = run_as(&f, 0, &["/usr/bin/cat", f.acc[0].config_dir.join(".credentials.json").to_str().unwrap()]);
    assert!(ok && out.contains("personal"), "{out}");
    let (ok, _) = run_as(&f, 0, &["/usr/bin/touch", f.acc[0].workspace_root.join("repo/ok").to_str().unwrap()]);
    assert!(ok);
}

#[test]
fn symlink_inside_repo_cannot_escape() {
    let f = fx();
    let link = f.acc[0].workspace_root.join("repo/escape");
    std::os::unix::fs::symlink(&f.acc[1].config_dir, &link).unwrap();
    let (ok, _) = run_as(&f, 0, &["/usr/bin/cat", link.join(".credentials.json").to_str().unwrap()]);
    assert!(!ok, "symlink escape succeeded");
}

#[test]
fn environment_has_only_own_config_dir() {
    let f = fx();
    let (ok, out) = run_as(&f, 0, &["/usr/bin/env"]);
    assert!(ok);
    assert!(out.contains(&format!("CLAUDE_CONFIG_DIR={}", f.acc[0].config_dir.display())));
    assert!(!out.contains(".claude-work"));
    assert!(!out.contains("ANTHROPIC_"));
    assert!(!out.contains("CLAUDECODE"));
}

#[test]
fn launcher_refuses_without_policy() {
    let out = Command::new(env!("CARGO_BIN_EXE_ccc"))
        .args([LAUNCH_FLAG, "--", "/usr/bin/true"])
        .env_clear()
        .output()
        .unwrap();
    assert!(!out.status.success());
}
