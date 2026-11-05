//! Pure parsing of Claude Code `--output-format stream-json` lines and
//! construction of `--input-format stream-json` control messages.
//! Shapes verified against Claude Code 2.1.x (see docs/PROTOCOL.md).
use serde_json::{json, Value};

pub const HOOK_EVENTS: &[&str] =
    &["PreToolUse", "PostToolUse", "SubagentStart", "SubagentStop", "Stop", "Notification", "UserPromptSubmit"];

#[derive(Debug, Clone, PartialEq)]
pub enum Block {
    Text(String),
    ToolUse { id: String, name: String, input: Value },
    Thinking,
}

#[derive(Debug, Clone, PartialEq)]
pub enum Parsed {
    Init { session_id: String, model: Option<String> },
    Assistant { message_id: String, parent_tool_use_id: Option<String>, blocks: Vec<Block>, output_tokens: Option<i64> },
    ToolResults { parent_tool_use_id: Option<String>, results: Vec<(String, String, bool)> },
    UserEcho { text: String },
    MessageStart { message_id: String, parent_tool_use_id: Option<String> },
    TextDelta { parent_tool_use_id: Option<String>, text: String },
    Result(TurnResult),
    TaskStarted { task_id: String, tool_use_id: Option<String>, description: Option<String>, subagent_type: Option<String> },
    TaskProgress { task_id: String, description: Option<String>, last_tool: Option<String>, tokens: Option<i64>, tool_uses: Option<i64> },
    TaskUpdated { task_id: String, status: Option<String> },
    BackgroundTasks { count: usize },
    Thinking,
    ControlRequest { request_id: String, subtype: String, request: Value },
    ControlResponse { request_id: String, ok: bool, error: Option<String> },
    RateLimit { status: String, resets_at: Option<i64> },
    Other(String),
}

#[derive(Debug, Clone, PartialEq, Default)]
pub struct TurnResult {
    pub subtype: String,
    pub is_error: bool,
    pub cost_usd: f64,
    pub duration_ms: i64,
    pub num_turns: i64,
    pub input_tokens: i64,
    pub output_tokens: i64,
    pub cache_read: i64,
    pub cache_write: i64,
    pub text: Option<String>,
}

fn s(v: &Value, k: &str) -> Option<String> {
    v.get(k).and_then(|x| x.as_str()).map(str::to_string)
}
fn i(v: &Value, k: &str) -> i64 {
    v.get(k).and_then(|x| x.as_i64()).unwrap_or(0)
}

fn content_to_text(c: &Value) -> String {
    match c {
        Value::String(s) => s.clone(),
        Value::Array(items) => items
            .iter()
            .filter_map(|it| match it.get("type").and_then(|t| t.as_str()) {
                Some("text") => it.get("text").and_then(|t| t.as_str()).map(str::to_string),
                Some("image") => Some("[imagem]".to_string()),
                _ => None,
            })
            .collect::<Vec<_>>()
            .join("\n"),
        _ => String::new(),
    }
}

pub fn parse_line(line: &str) -> Option<Parsed> {
    let v: Value = serde_json::from_str(line).ok()?;
    Some(parse_value(&v))
}

pub fn parse_value(v: &Value) -> Parsed {
    let t = v.get("type").and_then(|x| x.as_str()).unwrap_or("");
    let st = v.get("subtype").and_then(|x| x.as_str()).unwrap_or("");
    let ptu = s(v, "parent_tool_use_id");
    match (t, st) {
        ("system", "init") => Parsed::Init { session_id: s(v, "session_id").unwrap_or_default(), model: s(v, "model") },
        ("system", "task_started") => Parsed::TaskStarted {
            task_id: s(v, "task_id").unwrap_or_default(),
            tool_use_id: s(v, "tool_use_id"),
            description: s(v, "description"),
            subagent_type: s(v, "subagent_type"),
        },
        ("system", "task_progress") => {
            let usage = v.get("usage").cloned().unwrap_or(Value::Null);
            Parsed::TaskProgress {
                task_id: s(v, "task_id").unwrap_or_default(),
                description: s(v, "description"),
                last_tool: s(v, "last_tool_name"),
                tokens: usage.get("total_tokens").and_then(|x| x.as_i64()),
                tool_uses: usage.get("tool_uses").and_then(|x| x.as_i64()),
            }
        }
        ("system", "task_updated") => Parsed::TaskUpdated {
            task_id: s(v, "task_id").unwrap_or_default(),
            status: v.get("patch").and_then(|p| s(p, "status")),
        },
        ("system", "task_notification") => {
            Parsed::TaskUpdated { task_id: s(v, "task_id").unwrap_or_default(), status: s(v, "status") }
        }
        ("system", "background_tasks_changed") => Parsed::BackgroundTasks {
            count: v.get("tasks").and_then(|x| x.as_array()).map(|a| a.len()).unwrap_or(0),
        },
        ("system", "thinking_tokens") => Parsed::Thinking,
        ("assistant", _) => {
            let msg = v.get("message").cloned().unwrap_or(Value::Null);
            let blocks = msg
                .get("content")
                .and_then(|c| c.as_array())
                .map(|arr| {
                    arr.iter()
                        .filter_map(|b| match b.get("type").and_then(|x| x.as_str()) {
                            Some("text") => Some(Block::Text(s(b, "text").unwrap_or_default())),
                            Some("tool_use") => Some(Block::ToolUse {
                                id: s(b, "id").unwrap_or_default(),
                                name: s(b, "name").unwrap_or_default(),
                                input: b.get("input").cloned().unwrap_or(Value::Null),
                            }),
                            Some("thinking") | Some("redacted_thinking") => Some(Block::Thinking),
                            _ => None,
                        })
                        .collect()
                })
                .unwrap_or_default();
            Parsed::Assistant {
                message_id: s(&msg, "id").unwrap_or_default(),
                parent_tool_use_id: ptu,
                blocks,
                output_tokens: msg.get("usage").and_then(|u| u.get("output_tokens")).and_then(|x| x.as_i64()),
            }
        }
        ("user", _) => {
            let content = v.get("message").and_then(|m| m.get("content")).cloned().unwrap_or(Value::Null);
            if let Some(arr) = content.as_array() {
                let results: Vec<(String, String, bool)> = arr
                    .iter()
                    .filter(|b| b.get("type").and_then(|x| x.as_str()) == Some("tool_result"))
                    .map(|b| {
                        (
                            s(b, "tool_use_id").unwrap_or_default(),
                            content_to_text(b.get("content").unwrap_or(&Value::Null)),
                            b.get("is_error").and_then(|x| x.as_bool()).unwrap_or(false),
                        )
                    })
                    .collect();
                if !results.is_empty() {
                    return Parsed::ToolResults { parent_tool_use_id: ptu, results };
                }
            }
            Parsed::UserEcho { text: content_to_text(&content) }
        }
        ("stream_event", _) => {
            let ev = v.get("event").cloned().unwrap_or(Value::Null);
            match ev.get("type").and_then(|x| x.as_str()) {
                Some("message_start") => Parsed::MessageStart {
                    message_id: ev.get("message").and_then(|m| s(m, "id")).unwrap_or_default(),
                    parent_tool_use_id: ptu,
                },
                Some("content_block_delta") => {
                    let d = ev.get("delta").cloned().unwrap_or(Value::Null);
                    if d.get("type").and_then(|x| x.as_str()) == Some("text_delta") {
                        Parsed::TextDelta { parent_tool_use_id: ptu, text: s(&d, "text").unwrap_or_default() }
                    } else {
                        Parsed::Other("delta".into())
                    }
                }
                _ => Parsed::Other("stream_event".into()),
            }
        }
        ("result", _) => {
            let u = v.get("usage").cloned().unwrap_or(Value::Null);
            Parsed::Result(TurnResult {
                subtype: st.to_string(),
                is_error: v.get("is_error").and_then(|x| x.as_bool()).unwrap_or(false),
                cost_usd: v.get("total_cost_usd").and_then(|x| x.as_f64()).unwrap_or(0.0),
                duration_ms: i(v, "duration_ms"),
                num_turns: i(v, "num_turns"),
                input_tokens: i(&u, "input_tokens"),
                output_tokens: i(&u, "output_tokens"),
                cache_read: i(&u, "cache_read_input_tokens"),
                cache_write: i(&u, "cache_creation_input_tokens"),
                text: s(v, "result"),
            })
        }
        ("control_request", _) => {
            let req = v.get("request").cloned().unwrap_or(Value::Null);
            Parsed::ControlRequest {
                request_id: s(v, "request_id").unwrap_or_default(),
                subtype: s(&req, "subtype").unwrap_or_default(),
                request: req,
            }
        }
        ("control_response", _) => {
            let r = v.get("response").cloned().unwrap_or(Value::Null);
            Parsed::ControlResponse {
                request_id: s(&r, "request_id").unwrap_or_default(),
                ok: r.get("subtype").and_then(|x| x.as_str()) == Some("success"),
                error: s(&r, "error"),
            }
        }
        ("rate_limit_event", _) => {
            let info = v.get("rate_limit_info").cloned().unwrap_or(Value::Null);
            Parsed::RateLimit { status: s(&info, "status").unwrap_or_default(), resets_at: info.get("resetsAt").and_then(|x| x.as_i64()) }
        }
        _ => Parsed::Other(format!("{t}/{st}")),
    }
}

// ---------- outbound ----------

pub fn initialize(request_id: &str) -> Value {
    let hooks: serde_json::Map<String, Value> = HOOK_EVENTS
        .iter()
        .map(|ev| (ev.to_string(), json!([{ "matcher": null, "hookCallbackIds": [format!("ccc_{ev}")] }])))
        .collect();
    json!({ "type": "control_request", "request_id": request_id, "request": { "subtype": "initialize", "hooks": hooks } })
}

pub fn user_message(text: &str) -> Value {
    json!({ "type": "user", "session_id": "", "parent_tool_use_id": null,
            "message": { "role": "user", "content": text } })
}

/// User turn with images: image blocks first, then the text (if any).
pub fn user_prompt(p: &crate::model::Prompt) -> Value {
    if p.images.is_empty() {
        return user_message(&p.text);
    }
    let mut content: Vec<Value> = p
        .images
        .iter()
        .map(|i| json!({ "type": "image", "source": { "type": "base64", "media_type": i.media_type, "data": i.data } }))
        .collect();
    if !p.text.trim().is_empty() {
        content.push(json!({ "type": "text", "text": p.text }));
    }
    json!({ "type": "user", "session_id": "", "parent_tool_use_id": null,
            "message": { "role": "user", "content": content } })
}

pub fn set_model(request_id: &str, model: Option<&str>) -> Value {
    json!({ "type": "control_request", "request_id": request_id, "request": { "subtype": "set_model", "model": model } })
}

pub fn set_permission_mode(request_id: &str, mode: &str) -> Value {
    json!({ "type": "control_request", "request_id": request_id, "request": { "subtype": "set_permission_mode", "mode": mode } })
}

pub fn interrupt(request_id: &str) -> Value {
    json!({ "type": "control_request", "request_id": request_id, "request": { "subtype": "interrupt" } })
}

pub fn success(request_id: &str, response: Value) -> Value {
    json!({ "type": "control_response", "response": { "subtype": "success", "request_id": request_id, "response": response } })
}

pub fn error(request_id: &str, msg: &str) -> Value {
    json!({ "type": "control_response", "response": { "subtype": "error", "request_id": request_id, "error": msg } })
}

pub fn permission_allow(input: &Value, updated_permissions: Option<&Value>) -> Value {
    let mut r = json!({ "behavior": "allow", "updatedInput": input });
    if let Some(p) = updated_permissions {
        if p.as_array().map(|a| !a.is_empty()).unwrap_or(false) {
            r["updatedPermissions"] = p.clone();
        }
    }
    r
}

pub fn permission_deny(message: &str) -> Value {
    json!({ "behavior": "deny", "message": message })
}

pub fn pre_tool_deny(reason: &str) -> Value {
    json!({ "hookSpecificOutput": { "hookEventName": "PreToolUse", "permissionDecision": "deny",
            "permissionDecisionReason": reason } })
}

/// One-line human summary of a tool input for activity labels.
pub fn tool_summary(name: &str, input: &Value) -> String {
    let pick = |k: &str| input.get(k).and_then(|x| x.as_str()).map(str::to_string);
    let raw = match name {
        "Bash" => pick("description").or_else(|| pick("command")),
        "Read" | "Write" | "Edit" | "NotebookEdit" => pick("file_path").or_else(|| pick("notebook_path")),
        "Glob" | "Grep" => pick("pattern"),
        "WebFetch" => pick("url"),
        "WebSearch" => pick("query"),
        "Agent" | "Task" => pick("description"),
        _ => None,
    }
    .unwrap_or_default();
    let one = raw.lines().next().unwrap_or("").to_string();
    let mut out = format!("{name}{}{}", if one.is_empty() { "" } else { ": " }, one);
    if out.chars().count() > 140 {
        out = out.chars().take(139).collect::<String>() + "…";
    }
    out
}

/// File paths a tool would touch, and whether the access is a write.
pub fn tool_paths(name: &str, input: &Value) -> Vec<(String, bool)> {
    let get = |k: &str| input.get(k).and_then(|x| x.as_str()).map(str::to_string);
    match name {
        "Write" | "Edit" | "MultiEdit" => get("file_path").map(|p| vec![(p, true)]).unwrap_or_default(),
        "NotebookEdit" => get("notebook_path").map(|p| vec![(p, true)]).unwrap_or_default(),
        "Read" => get("file_path").map(|p| vec![(p, false)]).unwrap_or_default(),
        "Glob" | "Grep" => get("path").map(|p| vec![(p, false)]).unwrap_or_default(),
        _ => vec![],
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_task_started_and_subagent_tool_request() {
        let p = parse_line(r#"{"type":"system","subtype":"task_started","task_id":"a8eb","tool_use_id":"toolu_1","description":"Write hello","subagent_type":"general-purpose","spawn_depth":1}"#).unwrap();
        assert_eq!(p, Parsed::TaskStarted { task_id: "a8eb".into(), tool_use_id: Some("toolu_1".into()), description: Some("Write hello".into()), subagent_type: Some("general-purpose".into()) });
        let p = parse_line(r#"{"type":"control_request","request_id":"r1","request":{"subtype":"can_use_tool","tool_name":"Write","input":{"file_path":"/x"},"agent_id":"a8eb","tool_use_id":"toolu_2"}}"#).unwrap();
        match p {
            Parsed::ControlRequest { request_id, subtype, request } => {
                assert_eq!(request_id, "r1");
                assert_eq!(subtype, "can_use_tool");
                assert_eq!(request["agent_id"], "a8eb");
            }
            _ => panic!(),
        }
    }

    #[test]
    fn parses_assistant_blocks_and_tool_results() {
        let p = parse_line(r#"{"type":"assistant","parent_tool_use_id":null,"message":{"id":"msg_1","content":[{"type":"thinking","thinking":""},{"type":"text","text":"hi"},{"type":"tool_use","id":"t1","name":"Bash","input":{"command":"ls"}}],"usage":{"output_tokens":5}}}"#).unwrap();
        match p {
            Parsed::Assistant { message_id, blocks, output_tokens, .. } => {
                assert_eq!(message_id, "msg_1");
                assert_eq!(blocks.len(), 3);
                assert_eq!(output_tokens, Some(5));
            }
            _ => panic!(),
        }
        let p = parse_line(r#"{"type":"user","message":{"role":"user","content":[{"type":"tool_result","tool_use_id":"t1","content":[{"type":"text","text":"ok"}],"is_error":true}]}}"#).unwrap();
        assert_eq!(p, Parsed::ToolResults { parent_tool_use_id: None, results: vec![("t1".into(), "ok".into(), true)] });
    }

    #[test]
    fn parses_result_and_deltas() {
        let p = parse_line(r#"{"type":"result","subtype":"success","is_error":false,"duration_ms":10,"num_turns":2,"total_cost_usd":0.5,"usage":{"input_tokens":4,"output_tokens":390,"cache_read_input_tokens":3,"cache_creation_input_tokens":8},"result":"done"}"#).unwrap();
        match p {
            Parsed::Result(r) => {
                assert_eq!(r.output_tokens, 390);
                assert_eq!(r.cost_usd, 0.5);
                assert_eq!(r.text.as_deref(), Some("done"));
            }
            _ => panic!(),
        }
        let p = parse_line(r#"{"type":"stream_event","event":{"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":"He"}},"parent_tool_use_id":null}"#).unwrap();
        assert_eq!(p, Parsed::TextDelta { parent_tool_use_id: None, text: "He".into() });
    }

    #[test]
    fn garbage_is_ignored() {
        assert!(parse_line("not json").is_none());
        assert!(matches!(parse_line(r#"{"type":"weird"}"#), Some(Parsed::Other(_))));
    }

    #[test]
    fn outbound_messages_shape() {
        let init = initialize("i1");
        assert_eq!(init["request"]["subtype"], "initialize");
        let img = crate::model::ImageInput { media_type: "image/png".into(), data: "iVBORw0KGgo=".into() };
        let p = crate::model::Prompt { text: "o que é isso?".into(), images: vec![img.clone()], thumbs: vec![] };
        let u = user_prompt(&p);
        assert_eq!(u["message"]["content"][0]["type"], "image");
        assert_eq!(u["message"]["content"][0]["source"]["media_type"], "image/png");
        assert_eq!(u["message"]["content"][1]["text"], "o que é isso?");
        assert_eq!(user_prompt(&"oi".to_string().into())["message"]["content"], "oi");
        assert!(p.validate().is_ok());
        let only_img = crate::model::Prompt { text: " ".into(), images: vec![img.clone()], thumbs: vec![] };
        assert!(only_img.validate().is_ok());
        assert!(crate::model::Prompt::default().validate().is_err());
        let bad_type = crate::model::Prompt { text: "x".into(), images: vec![crate::model::ImageInput { media_type: "image/svg+xml".into(), data: "AAAA".into() }], thumbs: vec![] };
        assert!(bad_type.validate().is_err());
        let bad_b64 = crate::model::Prompt { text: "x".into(), images: vec![crate::model::ImageInput { media_type: "image/png".into(), data: "<script>".into() }], thumbs: vec![] };
        assert!(bad_b64.validate().is_err());
        let too_many = crate::model::Prompt { text: "x".into(), images: vec![img; 7], thumbs: vec![] };
        assert!(too_many.validate().is_err());
        let m = set_model("m1", Some("opus"));
        assert_eq!((m["type"].as_str(), m["request"]["subtype"].as_str(), m["request"]["model"].as_str()), (Some("control_request"), Some("set_model"), Some("opus")));
        assert!(set_model("m2", None)["request"]["model"].is_null());
        let pm = set_permission_mode("p1", "default");
        assert_eq!(pm["request"]["mode"], "default");
        assert!(crate::commands::valid_model("claude-opus-4-1[1m]") && crate::commands::valid_model("sonnet"));
        assert!(!crate::commands::valid_model("opus; rm -rf") && !crate::commands::valid_model(""));
        assert!(init["request"]["hooks"]["SubagentStart"].is_array());
        let allow = permission_allow(&json!({"a":1}), Some(&json!([])));
        assert!(allow.get("updatedPermissions").is_none());
        assert_eq!(tool_summary("Bash", &json!({"command":"ls -la\nrm x"})), "Bash: ls -la");
        assert_eq!(tool_paths("Edit", &json!({"file_path":"/a"})), vec![("/a".to_string(), true)]);
    }
}
