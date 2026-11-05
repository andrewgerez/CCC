//! Secret redaction for anything that leaves the process boundary as text
//! (logs, persisted tool payloads, stderr captures, IPC error messages).
use regex::Regex;
use std::sync::LazyLock;

static PATTERNS: LazyLock<Vec<(Regex, &'static str)>> = LazyLock::new(|| {
    let p = |r: &str| Regex::new(r).expect("valid redaction regex");
    vec![
        (p(r"-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z ]*PRIVATE KEY-----"), "[REDACTED PRIVATE KEY]"),
        (p(r"sk-ant-[A-Za-z0-9_\-]{8,}"), "sk-ant-[REDACTED]"),
        (p(r"\bsk-[A-Za-z0-9]{20,}"), "sk-[REDACTED]"),
        (p(r"\bgh[pousr]_[A-Za-z0-9]{20,}"), "gh_[REDACTED]"),
        (p(r"\bgithub_pat_[A-Za-z0-9_]{20,}"), "github_pat_[REDACTED]"),
        (p(r"\bAKIA[0-9A-Z]{16}\b"), "AKIA[REDACTED]"),
        (p(r"\bxox[abprs]-[A-Za-z0-9\-]{10,}"), "xox-[REDACTED]"),
        (p(r"(?i)\bbearer\s+[A-Za-z0-9\-\._~\+/]{16,}=*"), "Bearer [REDACTED]"),
        (p(r#"(?i)("(?:access|refresh|id)_?token"\s*:\s*")[^"]+(")"#), "${1}[REDACTED]${2}"),
        (p(r#"(?i)\b((?:api[_-]?key|secret|password|passwd|token|client[_-]?secret|auth)\s*[:=]\s*["']?)[^\s"',;]{6,}"#), "${1}[REDACTED]"),
    ]
});

pub fn redact(input: &str) -> String {
    let mut out = std::borrow::Cow::Borrowed(input);
    for (re, rep) in PATTERNS.iter() {
        if re.is_match(&out) {
            out = std::borrow::Cow::Owned(re.replace_all(&out, *rep).into_owned());
        }
    }
    out.into_owned()
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn redacts_common_secrets() {
        let s = "key sk-ant-api03-abcdefghijklmnop and Bearer abcdefghijklmnopqrstuvwxyz and \"accessToken\":\"zzz\" password=hunter2222";
        let r = redact(s);
        assert!(!r.contains("abcdefghijklmnop"));
        assert!(!r.contains("zzz"));
        assert!(!r.contains("hunter2222"));
        assert!(r.contains("[REDACTED]"));
    }
    #[test]
    fn leaves_normal_text() {
        let s = "Edited src/main.rs: added fn token_count()";
        assert_eq!(redact(s), s);
    }
}
