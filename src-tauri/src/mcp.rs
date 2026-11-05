//! MCP servers per account, user scope. Reads `<CLAUDE_CONFIG_DIR>/.claude.json`
//! directly (fast, no health checks); writes go through the official
//! `claude mcp add-json/remove --scope user` CLI so the file format and any
//! concurrent writers stay the CLI's responsibility.
use crate::accounts::AccountConfig;
use crate::error::{AppError, AppResult};
use serde::Serialize;
use serde_json::Value;
use std::path::Path;

#[derive(Serialize, Clone, Debug, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct McpServer {
    pub name: String,
    /// stdio | http | sse | ws
    pub transport: String,
    /// Command line or URL, for display.
    pub target: String,
    /// Names of env vars / headers configured (values never leave the backend).
    pub secrets: Vec<String>,
}

pub fn valid_name(name: &str) -> bool {
    !name.is_empty() && name.len() <= 64 && name.chars().all(|c| c.is_ascii_alphanumeric() || c == '-' || c == '_')
}

/// Accepts the same JSON shape as `claude mcp add-json`.
pub fn validate_config(cfg: &Value) -> AppResult<()> {
    let o = cfg.as_object().ok_or_else(|| AppError::Invalid("configuração deve ser um objeto JSON".into()))?;
    let kind = o.get("type").and_then(Value::as_str).unwrap_or("stdio");
    match kind {
        "stdio" => {
            if o.get("command").and_then(Value::as_str).map_or(true, |c| c.trim().is_empty()) {
                return Err(AppError::Invalid("servidor stdio precisa de \"command\"".into()));
            }
        }
        "http" | "sse" | "ws" => {
            let url = o.get("url").and_then(Value::as_str).unwrap_or("");
            if !(url.starts_with("https://") || url.starts_with("http://") || url.starts_with("wss://") || url.starts_with("ws://")) {
                return Err(AppError::Invalid("servidor remoto precisa de \"url\" válida".into()));
            }
        }
        other => return Err(AppError::Invalid(format!("tipo desconhecido: {other}"))),
    }
    Ok(())
}

fn summarize(name: &str, v: &Value) -> McpServer {
    let kind = v.get("type").and_then(Value::as_str).unwrap_or("stdio").to_string();
    let target = if kind == "stdio" {
        let mut parts = vec![v.get("command").and_then(Value::as_str).unwrap_or("").to_string()];
        if let Some(args) = v.get("args").and_then(Value::as_array) {
            parts.extend(args.iter().filter_map(Value::as_str).map(str::to_string));
        }
        parts.join(" ")
    } else {
        v.get("url").and_then(Value::as_str).unwrap_or("").to_string()
    };
    let mut secrets: Vec<String> = ["env", "headers"]
        .iter()
        .filter_map(|k| v.get(*k).and_then(Value::as_object))
        .flat_map(|m| m.keys().cloned())
        .collect();
    secrets.sort();
    McpServer { name: name.to_string(), transport: kind, target: crate::redact::redact(&target), secrets }
}

pub fn list_from(config_dir: &Path) -> AppResult<Vec<McpServer>> {
    let p = config_dir.join(".claude.json");
    let raw = match std::fs::read_to_string(&p) {
        Ok(s) => s,
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => return Ok(vec![]),
        Err(e) => return Err(e.into()),
    };
    let v: Value = serde_json::from_str(&raw)?;
    let mut out: Vec<McpServer> = v
        .get("mcpServers")
        .and_then(Value::as_object)
        .map(|m| m.iter().map(|(k, v)| summarize(k, v)).collect())
        .unwrap_or_default();
    out.sort_by(|a, b| a.name.cmp(&b.name));
    Ok(out)
}

pub fn list(acc: &AccountConfig) -> AppResult<Vec<McpServer>> {
    list_from(&acc.config_dir)
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn reads_user_scope_and_hides_secret_values() {
        let dir = tempfile::tempdir().unwrap();
        std::fs::write(
            dir.path().join(".claude.json"),
            json!({ "mcpServers": {
                "github": { "type": "http", "url": "https://api.example.com/mcp", "headers": { "Authorization": "Bearer abc" } },
                "fs": { "command": "npx", "args": ["-y", "server-fs", "/tmp"], "env": { "TOKEN": "s3cr3t" } }
            }, "projects": { "/x": { "mcpServers": { "local": { "command": "y" } } } } })
            .to_string(),
        )
        .unwrap();
        let l = list_from(dir.path()).unwrap();
        assert_eq!(l.iter().map(|s| s.name.as_str()).collect::<Vec<_>>(), ["fs", "github"]);
        assert_eq!(l[0].transport, "stdio");
        assert_eq!(l[0].target, "npx -y server-fs /tmp");
        assert_eq!(l[0].secrets, ["TOKEN"]);
        assert_eq!(l[1].secrets, ["Authorization"]);
        let dump = serde_json::to_string(&l).unwrap();
        assert!(!dump.contains("s3cr3t") && !dump.contains("Bearer abc"));
    }

    #[test]
    fn missing_file_is_empty() {
        let dir = tempfile::tempdir().unwrap();
        assert!(list_from(dir.path()).unwrap().is_empty());
    }

    #[test]
    fn validates_names_and_shapes() {
        assert!(valid_name("my-server_1"));
        assert!(!valid_name("bad name") && !valid_name("") && !valid_name("x;rm"));
        assert!(validate_config(&json!({ "command": "npx" })).is_ok());
        assert!(validate_config(&json!({ "type": "http", "url": "https://a" })).is_ok());
        assert!(validate_config(&json!({ "type": "http", "url": "file:///etc" })).is_err());
        assert!(validate_config(&json!({ "type": "stdio" })).is_err());
        assert!(validate_config(&json!("x")).is_err());
    }
}
