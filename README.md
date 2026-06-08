# opencode-tmux-signal

[![npm version](https://img.shields.io/npm/v/opencode-tmux-signal.svg)](https://www.npmjs.com/package/opencode-tmux-signal)
[![npm downloads](https://img.shields.io/npm/dm/opencode-tmux-signal.svg)](https://www.npmjs.com/package/opencode-tmux-signal)
[![license](https://img.shields.io/npm/l/opencode-tmux-signal.svg)](./LICENSE)

OpenCode plugin that signals agent state in tmux — recolors **this pane's window** when it needs your attention or finishes, and gives the window a short, LLM-generated name so the window list shows *what* it is instead of just `opencode`.

## What it does

- **Permission request → yellow** — the agent is asking to do something and is waiting on you
- **Question → purple** — the agent asked you a question (the `question` tool)
- **Done → soft red** — the main agent finished (or errored) while you were away
- **Working / focused → normal** — no highlight while you're looking at it
- **Smart window naming** — names the window from a short LLM slug of your first prompt (`fix the auth token bug` → `auth`), works on resumed sessions too, and **never overwrites a name you set** (it only renames a window still called `opencode`)
- **Sub-agent aware** — events from sub-agents (child sessions) never flash your main window
- **Mark-as-read** — opening the window clears the highlight

The highlight only shows while the window is **inactive** (you're somewhere else), which is exactly when you need it. Open the window and it clears.

## Why

AI agents run in tmux panes and give no signal when they finish or need input — you keep switching panes to check. And every opencode window is just labeled `opencode`, so a row of them is indistinguishable. This colors and names each window so a glance at the status bar tells you which project needs attention and why.

Unlike script-based indicators, this is a pure opencode plugin: it drives tmux at runtime from the pane opencode launched in (via `$TMUX_PANE`), so it targets the correct window in multi-pane layouts and **writes nothing to your `~/.tmux.conf`**.

## Install

> Server-side plugin — add it to `opencode.json` (not `tui.json`).

```json
{
  "$schema": "https://opencode.ai/config.json",
  "plugin": ["opencode-tmux-signal"]
}
```

OpenCode installs the package automatically on next start.

## Configuration

All options are environment variables (set them in your shell profile). Defaults are a mellow palette that pairs with a green status bar:

| Variable | Default | Description |
| --- | --- | --- |
| `OPENCODE_TMUX_SIGNAL_PERMISSION_BG` | `colour179` | Permission-request background (mellow yellow) |
| `OPENCODE_TMUX_SIGNAL_PERMISSION_FG` | `black` | Permission-request text |
| `OPENCODE_TMUX_SIGNAL_QUESTION_BG` | `colour97` | Question background (mellow purple) |
| `OPENCODE_TMUX_SIGNAL_QUESTION_FG` | `white` | Question text |
| `OPENCODE_TMUX_SIGNAL_DONE_BG` | `colour131` | Done background (soft red) |
| `OPENCODE_TMUX_SIGNAL_DONE_FG` | `white` | Done text |
| `OPENCODE_TMUX_SIGNAL_WINDOW_NAME` | `llm` | `llm` = short LLM slug from first prompt / session title; `dir` = project dir; `off` = leave it |
| `OPENCODE_TMUX_SIGNAL_NAME_MODELS` | `github-copilot/gpt-5.4-mini,github-copilot/claude-haiku-4.5,github-copilot/gemini-3.5-flash` | Comma-separated `provider/model` list tried in order (fallbacks) for the naming call |
| `OPENCODE_TMUX_SIGNAL_RESET_ON_FOCUS` | `on` | Clear the highlight when you open the window |

Colors accept any tmux color: `red`, `brightblue`, or `colour0`–`colour255`.

```sh
# example overrides
export OPENCODE_TMUX_SIGNAL_DONE_BG=colour52
export OPENCODE_TMUX_SIGNAL_WINDOW_NAME=dir   # skip the LLM, use the directory name
```

## How it works

The plugin maps OpenCode events to states and styles only its own window:

| Trigger | State | Visual |
| --- | --- | --- |
| `permission.ask` hook | permission | yellow `window-status-style` |
| `question` tool | question | purple `window-status-style` |
| `session.idle`, `session.error` (main session) | done | soft-red `window-status-style` |
| `session.status` busy (main session) | running | cleared |

- The window is found once from `$TMUX_PANE`, so multi-pane layouts work correctly.
- Sub-agent sessions (those with a `parentID`) are tracked and their events ignored, so a finishing sub-agent never flashes the main window.
- `window-status-style` applies only to **inactive** windows, so the highlight is hidden while you're viewing the pane; global `after-select-window` / `after-select-pane` hooks clear it the moment you open the window (works without `focus-events`).
- **Window naming** (`llm` mode): on your first prompt (`chat.message`) the plugin spins a throwaway session, asks a cheap model for a one-word slug, applies it, and deletes the session — fire-and-forget, so it never delays your message. **Resumed sessions** are handled too: opening a pre-existing session names the window from that session's existing title instead of waiting for a new message. It only renames a window still named `opencode`, so a name you set yourself is never clobbered. Costs one short model call per session; set `WINDOW_NAME=dir` or `off` to avoid it.

Requires tmux 3.0+ and Bun (provided by OpenCode).

## Development

```bash
bun install
bun run typecheck
bun run build
```

## Releasing

Releases are automated via GitHub Actions. To cut a new release:

```bash
npm version patch   # or minor / major
git push --follow-tags
```

The [publish workflow](./.github/workflows/publish.yml) builds, publishes to npm with [provenance](https://docs.npmjs.com/generating-provenance-statements), and creates a GitHub Release with auto-generated notes.

## License

MIT
