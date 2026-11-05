//! Identity verification per account. Execution requires that
//! `claude auth status --json`, run inside the account's sandbox with the
//! account's CLAUDE_CONFIG_DIR, reports exactly the configured email.
use crate::accounts::AccountConfig;
use crate::launch::{self, ClaudeBin, DataDirs, LaunchSpec};
use crate::model::{now_ms, AuthState, AuthStatus};
use serde_json::Value;
use std::time::Duration;

pub const TTL_MS: i64 = 10 * 60 * 1000;

pub fn interpret(acc: &AccountConfig, raw: &str) -> AuthStatus {
    let mut st = AuthStatus {
        account: acc.id,
        state: AuthState::Error,
        email: None,
        expected_email: acc.email.clone(),
        org_name: None,
        subscription: None,
        expires_at: None,
        checked_at: now_ms(),
        message: None,
    };
    let v: Value = match serde_json::from_str(raw.trim()) {
        Ok(v) => v,
        Err(_) => {
            st.message = Some("resposta inesperada de `claude auth status`".into());
            return st;
        }
    };
    let get = |k: &str| v.get(k).and_then(|x| x.as_str()).map(str::to_string);
    st.email = get("email");
    st.org_name = get("orgName");
    st.subscription = get("subscriptionType");
    st.expires_at = get("loginExpiresAt");
    let logged = v.get("loggedIn").and_then(|x| x.as_bool()).unwrap_or(false);
    if !logged {
        st.state = AuthState::LoggedOut;
        st.message = Some("não autenticado".into());
        return st;
    }
    if let Some(dir) = get("configDirectory") {
        if crate::paths::normalize(std::path::Path::new(&dir)) != crate::paths::normalize(&acc.config_dir) {
            st.state = AuthState::Mismatch;
            st.message = Some("CLI reportou um diretório de configuração diferente".into());
            return st;
        }
    }
    match &st.email {
        // Not linked yet: any logged-in identity is accepted here and bound by the caller.
        Some(_) if acc.email.trim().is_empty() => {
            st.state = AuthState::Verified;
        }
        Some(e) if e.eq_ignore_ascii_case(acc.email.trim()) => {
            st.state = AuthState::Verified;
        }
        Some(e) => {
            st.state = AuthState::Mismatch;
            st.message = Some(format!("autenticado como {e}, esperado {}", acc.email));
        }
        None => {
            st.state = AuthState::Mismatch;
            st.message = Some("CLI não informou o e-mail; identidade não verificável — refaça o login".into());
        }
    }
    st
}

pub async fn check(acc: &AccountConfig, other: &AccountConfig, claude: &ClaudeBin, data: &DataDirs, enforce: bool) -> AuthStatus {
    let spec = LaunchSpec {
        account: acc,
        other,
        claude,
        data,
        enforce,
        writable: vec![],
        cwd: acc.config_dir.clone(),
        args: vec!["auth".into(), "status".into(), "--json".into()],
        run_id: format!("auth-{}", uuid::Uuid::new_v4()),
    };
    let fail = |m: String| AuthStatus {
        account: acc.id,
        state: AuthState::Error,
        email: None,
        expected_email: acc.email.clone(),
        org_name: None,
        subscription: None,
        expires_at: None,
        checked_at: now_ms(),
        message: Some(crate::redact::redact(&m)),
    };
    let mut cmd = match launch::command(&spec) {
        Ok(c) => c,
        Err(e) => return fail(e.to_string()),
    };
    cmd.stdin(std::process::Stdio::null());
    let out = match tokio::time::timeout(Duration::from_secs(30), cmd.output()).await {
        Ok(Ok(o)) => o,
        Ok(Err(e)) => return fail(format!("falha ao executar claude: {e}")),
        Err(_) => return fail("timeout em `claude auth status`".into()),
    };
    let stdout = String::from_utf8_lossy(&out.stdout);
    if stdout.trim().is_empty() {
        return fail(String::from_utf8_lossy(&out.stderr).lines().last().unwrap_or("sem saída").to_string());
    }
    interpret(acc, &stdout)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::accounts::default_accounts;
    fn acc() -> AccountConfig {
        let mut a = default_accounts(std::path::Path::new("/home/u")).remove(1);
        a.email = "work.user@example.com".into();
        a
    }
    #[test]
    fn unlinked_account_accepts_first_identity() {
        let mut a = acc();
        a.email.clear();
        let raw = format!(r#"{{"loggedIn":true,"email":"anyone@example.com","configDirectory":"{}"}}"#, a.config_dir.display());
        assert_eq!(interpret(&a, &raw).state, AuthState::Verified);
        let out = format!(r#"{{"loggedIn":false,"configDirectory":"{}"}}"#, a.config_dir.display());
        assert_eq!(interpret(&a, &out).state, AuthState::LoggedOut);
    }
    #[test]
    fn verified_only_on_exact_email() {
        let a = acc();
        let ok = format!(r#"{{"loggedIn":true,"email":"Work.User@example.com","configDirectory":"{}"}}"#, a.config_dir.display());
        assert_eq!(interpret(&a, &ok).state, AuthState::Verified);
        let other = format!(r#"{{"loggedIn":true,"email":"me@example.com","configDirectory":"{}"}}"#, a.config_dir.display());
        assert_eq!(interpret(&a, &other).state, AuthState::Mismatch);
    }
    #[test]
    fn null_email_is_not_trusted() {
        let a = acc();
        let raw = format!(r#"{{"loggedIn":true,"email":null,"configDirectory":"{}"}}"#, a.config_dir.display());
        assert_eq!(interpret(&a, &raw).state, AuthState::Mismatch);
    }
    #[test]
    fn wrong_config_dir_is_mismatch() {
        let a = acc();
        let raw = r#"{"loggedIn":true,"email":"work.user@example.com","configDirectory":"/home/u/.claude-personal"}"#;
        assert_eq!(interpret(&a, raw).state, AuthState::Mismatch);
    }
    #[test]
    fn logged_out_and_garbage() {
        let a = acc();
        assert_eq!(interpret(&a, r#"{"loggedIn":false}"#).state, AuthState::LoggedOut);
        assert_eq!(interpret(&a, "oops").state, AuthState::Error);
    }
}
