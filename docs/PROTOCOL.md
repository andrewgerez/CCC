# Claude Code stream-json protocol (verified on 2.1.318)

Spawn: `claude -p --output-format stream-json --input-format stream-json --verbose
--permission-prompt-tool stdio --permission-mode <m> [--include-partial-messages]
(--session-id <uuid> | --resume <uuid>)`

stdin → CLI:
- `{"type":"control_request","request_id":…,"request":{"subtype":"initialize","hooks":{"PreToolUse":[{"matcher":null,"hookCallbackIds":["ccc_PreToolUse"]}],…}}}`
- `{"type":"user","message":{"role":"user","content":"…"},"parent_tool_use_id":null,"session_id":""}`
- `{"type":"control_request","request":{"subtype":"interrupt"}}`
- `{"type":"control_response","response":{"subtype":"success","request_id":…,"response":{…}}}`

CLI → stdout (observed): `system/init`, `assistant`, `user` (tool_result),
`stream_event` (partials), `result`, `rate_limit_event`,
`system/{task_started,task_progress,task_updated,task_notification,background_tasks_changed,thinking_tokens}`,
`control_request` subtypes `can_use_tool` (has `agent_id`, `tool_use_id`,
`permission_suggestions`) and `hook_callback` (hook input incl. `agent_id`).

Gotcha: subagents run in background; the CLI starts a new turn after their
completion. Closing stdin early auto-denies later permission requests, so the
executor only closes stdin when no turn, no background task and no approval is
pending.
