# Security & isolation model

Isolation is enforced in layers. The kernel layer is the real boundary.

1. **Kernel sandbox (Landlock, unprivileged).** Every Claude process (and
   everything it spawns: Bash tool, git, MCP servers, hooks) runs under a
   deny-by-default Landlock ruleset applied by the app's own launcher before
   `exec`. Allowed: system dirs + toolchains read-only; RW only the session's
   repo/worktree, the account's config dir and the account's private tmp/cache.
   Signals and abstract unix sockets are scoped. If Landlock cannot be applied,
   the launcher **refuses to run** (fail closed). Tested live in
   `src-tauri/tests/isolation.rs`.
2. **Config invariants** (`accounts.rs`): workspaces/config dirs of the two
   accounts may not overlap or nest (symlinks resolved); config dir may not be
   inside a workspace; extra sandbox paths may not expose the other account,
   `$HOME` or `/`. Invalid config blocks all execution.
3. **Environment**: built from an empty env + allowlist; `ANTHROPIC_*`,
   `CLAUDE_CODE_*`, `CLAUDECODE`, cloud creds, `SSH_AUTH_SOCK`, display vars are
   never passed. Only the account's `CLAUDE_CONFIG_DIR`.
4. **Identity gate**: before each process, `claude auth status --json` (run in
   the same sandbox) must report the exact expected email and config dir.
   A fresh install has no expected email: the first successful login on each
   account binds it (refused if the other account already uses that email);
   it can be changed later in Settings.
   `email: null` is treated as mismatch. Cache TTL 10 min; invalidated on auth
   errors. Never logs out or touches the other account.
5. **Paths**: repo paths canonicalized and confined to the account workspace;
   relative diff paths reject `..`/absolute/symlink escape; slugs whitelisted.
   File tools (Read/Write/Edit/Glob/Grep) outside allowed roots are denied in
   `PreToolUse` and `can_use_tool` (defense in depth).
6. **No bypass**: `--dangerously-skip-permissions` / `bypassPermissions` are
   rejected by the launcher builder. Approvals go to the UI.
7. **Git hardening**: `core.fsmonitor=false`, `core.hooksPath=/dev/null`,
   `--no-ext-diff --no-textconv`, no shell, timeouts. Repos are never modified
   except explicit, user-initiated `git worktree add` (worktrees live in app data).
8. **Data**: per-account DB files (0600) stamped; secrets redacted from logs,
   stderr, tool payloads and IPC errors. No credentials stored by the app.

## Known limitations (not hidden)

- Network is not restricted (the CLI needs the API).
- Read-only allowlisted toolchain dirs (`~/.nvm`, `~/.cargo`, …) are visible to
  both accounts — keep account secrets out of them.
- Pathname unix sockets in allowlisted dirs may be connectable.
- `/proc` is readable (needed by node/CLI): process listings of the same uid are
  visible, but Landlock blocks ptrace and file access through `/proc/<pid>/root`.
- bwrap/user namespaces are blocked on this Ubuntu (AppArmor
  `apparmor_restrict_unprivileged_userns=1`); Landlock was chosen instead.
- Turning the sandbox off in Settings removes layer 1 (requires confirmation).
- The orchestrator cannot see internals the CLI does not emit; such states are
  shown as `unknown`.
