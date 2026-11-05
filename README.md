# ccc

A desktop canvas for running [Claude Code](https://docs.claude.com/en/docs/claude-code) across **two strictly isolated accounts**: one for work, one personal. Every session is a card on a board, its subagents hang off to the right, and a little pixel Claude shows what each one is doing.

Linux only for now (Tauri 2 + React + Rust, sandboxed with Landlock). The UI is in Portuguese (pt-BR).

## What it does

- **Canvas**: one card per Claude Code session, with its subagents as connected cards. Cards show live state: working, using a tool, waiting on subagents, needs you, finished (flag-waving Claude), idle or error.
- **Two accounts, never mixed**: a switch at the top (or `Tab`) flips between *Trabalho* and *Pessoal*. Each account has its own `CLAUDE_CONFIG_DIR`, workspace, database and sandbox. The other account shows a badge when something there needs you.
- **Approvals in the app**: when Claude asks to edit or run something, you approve or deny it from the card or the side panel.
- **Auto / Ask**: per session, let Claude Code's auto mode handle routine actions or ask before acting. You can switch it while a session runs.
- **MCP connections per account**: add or remove MCP servers (local command or URL) for each account from the plug icon.
- **Side panel**: chat, agents, tools, changed files, logs and approvals for a session; resizable, with adjustable text size.

## Requirements

- Linux with Landlock (kernel 5.13+; ABI 3+ recommended)
- [Claude Code CLI](https://docs.claude.com/en/docs/claude-code) on your `PATH`
- Node 20+, Rust stable, and the [Tauri 2 Linux prerequisites](https://v2.tauri.app/start/prerequisites/#linux) (webkit2gtk 4.1 etc.)

## Run

```bash
npm install
npm run tauri dev          # development
npx tauri build            # release: src-tauri/target/release/bundle/{deb,appimage}
npm run dev                # browser preview with mock data (no backend)
npm test                   # frontend tests
cd src-tauri && cargo test # backend tests, including live sandbox isolation
```

Install the `.deb`:

```bash
sudo apt install ./src-tauri/target/release/bundle/deb/ccc_0.1.0_amd64.deb
```

## First run: connect your accounts

Both accounts start locked. For each one, click **Entrar** (or the lock on the account switch) and sign in with the Claude account you want there. The first successful login **links** that email to the account; from then on, sessions only start if `claude auth status` reports that same email, and the same email can't be linked to both sides.

You can also sign in from a terminal:

```bash
CLAUDE_CONFIG_DIR=~/.claude-work     claude auth login
CLAUDE_CONFIG_DIR=~/.claude-personal claude auth login
```

Then open **Configurações** (gear icon) and set, per account:

| Setting | Default |
|---|---|
| Name shown in the UI | `Trabalho` / `Pessoal` |
| Workspace (where your repos live) | `~/work` / `~/personal` (or the same folder under `~/Desktop`) |
| Config dir (`CLAUDE_CONFIG_DIR`) | `~/.claude-work` / `~/.claude-personal` |
| Expected email | empty until the first login links it |

Workspaces and config dirs of the two accounts must not overlap; the app refuses configs that would let one account see the other's files.

App data lives in `~/.local/share/ccc/` (`app.db`, one database per account, private `tmp/`, `cache/` and `worktrees/`), all mode 0700/0600.

## Docs

- [Architecture](docs/ARCHITECTURE.md)
- [Security and isolation model](docs/SECURITY.md)
- [Claude Code stream protocol notes](docs/PROTOCOL.md)

## Credits

- The flag-waving Claude is rebuilt from Ayotomiwa Wale-Durojaye's SVG recreation of the Claude mascot animations ([article](https://tympanus.net/codrops/2026/05/05/reverse-engineering-claude-ais-mascot-animations-with-svg-and-gsap/), [demo](https://ayotomcs.me/claude-mascot)).
- The Claude mascot, name and pixel art belong to Anthropic. This is an unofficial community project, not affiliated with or endorsed by Anthropic.
