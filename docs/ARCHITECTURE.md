# Architecture

```
React (Vite)  ── invoke ──▶  Rust commands ──▶ Session actors (1 per live session)
     ▲                                             │  spawn via self re-exec
     └── batched "ccc://events" (40ms / 500ms) ◀───┤  --ccc-sandbox-exec (Landlock)
                                                   ▼
                                     claude -p --input/output-format stream-json
                                     --permission-prompt-tool stdio
```

- **Executor** (`session.rs`): one tokio actor per live session. Writes
  `initialize` (hook callbacks registered over the control protocol — no hook
  scripts, no settings changes), user messages, permission responses and
  `interrupt` to stdin; parses stdout line by line through a bounded channel
  (backpressure reaches the CLI pipe).
- **Lifecycle**: queued → starting (identity gate) → running ↔ awaiting_approval
  → waiting_input → idle. After `idleTimeoutSecs` with no turn, no background
  subagents and no pending approval, stdin is closed and the process exits;
  the session stays resumable via `--resume <id>` (no process kept alive).
  Stop = EOF, then SIGTERM/SIGKILL to the process group after 5s/8s.
  Process dies with the app (`PR_SET_PDEATHSIG`); orphans tagged with
  `CCC_RUN_ID` are terminated on startup; DB statuses are reconciled
  (running → interrupted).
- **Scheduler** (`scheduler.rs`): global limit (default 2), per-account queues,
  priority then account fairness then FIFO; cancel-safe permits.
- **Graph** (`tracker.rs`): nodes/edges only from observed events —
  `task_started.tool_use_id` + caller of that tool use (hook `agent_id`),
  `SubagentStart/Stop`, `Pre/PostToolUse`, `can_use_tool`, `task_*`. When the
  process ends, any non-terminal agent becomes `unknown` ("state not observable").
- **Persistence** (`db.rs`): SQLite WAL, one file per account stamped with the
  account id; batched writer thread (150 ms / 512 ops per transaction),
  per-session event retention, paging for history.
- **UI**: a canvas (React Flow) with one card per session and its subagents,
  one account at a time. zustand store with a pure batch reducer (one `set` per
  batch, structural sharing), lazy markdown/diff, animations
  only on active nodes and paused when hidden; metrics pushed (no UI polling),
  sampled from /proc only while visible.
