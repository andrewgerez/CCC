//! Child-process environment construction. Starts from an EMPTY environment
//! and adds an explicit allowlist, so credentials/config of the other account
//! (or of the Claude Code session that launched this app) can never leak in.
use crate::accounts::AccountConfig;
use std::path::Path;

pub const MARKER_ENV: &str = "CCC_RUN_ID";
pub const ACCOUNT_ENV: &str = "CCC_ACCOUNT";

const PASSTHROUGH: &[&str] = &["PATH", "LANG", "LANGUAGE", "USER", "LOGNAME", "TZ"];

/// Prefixes that must never reach a child, even if a future change adds them
/// to the passthrough list. Checked as a final assertion.
const FORBIDDEN_PREFIXES: &[&str] = &[
    "ANTHROPIC_", "CLAUDE_CODE_", "CLAUDECODE", "AWS_", "GOOGLE_", "GCLOUD", "AZURE_", "OPENAI_",
    "GITHUB_TOKEN", "GH_TOKEN", "NPM_TOKEN", "SSH_AUTH_SOCK", "DBUS_SESSION_BUS_ADDRESS", "DISPLAY",
    "WAYLAND_DISPLAY", "XAUTHORITY",
];

pub struct EnvPaths<'a> {
    pub home: &'a Path,
    pub tmp_dir: &'a Path,
    pub cache_dir: &'a Path,
}

pub fn build_env(
    acc: &AccountConfig,
    run_id: &str,
    p: &EnvPaths,
    parent: impl Iterator<Item = (String, String)>,
) -> Vec<(String, String)> {
    let mut out: Vec<(String, String)> = parent
        .filter(|(k, _)| PASSTHROUGH.contains(&k.as_str()) || k.starts_with("LC_"))
        .collect();
    let set = |out: &mut Vec<(String, String)>, k: &str, v: String| {
        out.retain(|(kk, _)| kk != k);
        out.push((k.to_string(), v));
    };
    set(&mut out, "HOME", p.home.display().to_string());
    set(&mut out, "CLAUDE_CONFIG_DIR", acc.config_dir.display().to_string());
    set(&mut out, "TMPDIR", p.tmp_dir.display().to_string());
    set(&mut out, "XDG_CACHE_HOME", p.cache_dir.display().to_string());
    set(&mut out, "npm_config_cache", p.cache_dir.join("npm").display().to_string());
    set(&mut out, "TERM", "dumb".into());
    set(&mut out, "SHELL", "/bin/bash".into());
    set(&mut out, "NO_COLOR", "1".into());
    set(&mut out, "GIT_TERMINAL_PROMPT", "0".into());
    set(&mut out, "DISABLE_AUTOUPDATER", "1".into());
    set(&mut out, ACCOUNT_ENV, acc.id.as_str().into());
    set(&mut out, MARKER_ENV, run_id.into());
    // CLAUDE_CONFIG_DIR is the only CLAUDE_* key allowed; enforce invariants.
    out.retain(|(k, _)| k == "CLAUDE_CONFIG_DIR" || !FORBIDDEN_PREFIXES.iter().any(|f| k.starts_with(f)));
    out
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::accounts::default_accounts;
    use std::path::PathBuf;

    #[test]
    fn strips_inherited_credentials_and_pins_config_dir() {
        let home = PathBuf::from("/home/u");
        let accs = default_accounts(&home);
        let parent = vec![
            ("PATH".to_string(), "/usr/bin".to_string()),
            ("ANTHROPIC_API_KEY".into(), "sk-ant-xxx".into()),
            ("ANTHROPIC_AUTH_TOKEN".into(), "t".into()),
            ("CLAUDE_CONFIG_DIR".into(), accs[1].config_dir.display().to_string()),
            ("CLAUDE_CODE_OAUTH_TOKEN".into(), "x".into()),
            ("CLAUDECODE".into(), "1".into()),
            ("AWS_SECRET_ACCESS_KEY".into(), "x".into()),
            ("SSH_AUTH_SOCK".into(), "/run/x".into()),
            ("LC_ALL".into(), "C.UTF-8".into()),
        ];
        let tmp = PathBuf::from("/data/tmp/personal");
        let cache = PathBuf::from("/data/cache/personal");
        let env = build_env(&accs[0], "run1", &EnvPaths { home: &home, tmp_dir: &tmp, cache_dir: &cache }, parent.into_iter());
        let get = |k: &str| env.iter().find(|(kk, _)| kk == k).map(|(_, v)| v.clone());
        assert_eq!(get("CLAUDE_CONFIG_DIR").unwrap(), accs[0].config_dir.display().to_string());
        assert_eq!(env.iter().filter(|(k, _)| k == "CLAUDE_CONFIG_DIR").count(), 1);
        for k in ["ANTHROPIC_API_KEY", "ANTHROPIC_AUTH_TOKEN", "CLAUDE_CODE_OAUTH_TOKEN", "CLAUDECODE", "AWS_SECRET_ACCESS_KEY", "SSH_AUTH_SOCK"] {
            assert!(get(k).is_none(), "{k} leaked");
        }
        assert_eq!(get("LC_ALL").unwrap(), "C.UTF-8");
        assert_eq!(get("CCC_ACCOUNT").unwrap(), "personal");
        assert!(!env.iter().any(|(_, v)| v.contains(".claude-work")));
    }
}
