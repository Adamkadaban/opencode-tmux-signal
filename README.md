# opencode-tmux-signal

[![npm version](https://img.shields.io/npm/v/opencode-tmux-signal.svg)](https://www.npmjs.com/package/opencode-tmux-signal)
[![npm downloads](https://img.shields.io/npm/dm/opencode-tmux-signal.svg)](https://www.npmjs.com/package/opencode-tmux-signal)
[![license](https://img.shields.io/npm/l/opencode-tmux-signal.svg)](./LICENSE)

OpenCode plugin that signals agent state in tmux — recolors **this pane's window** when it needs your input or finishes, and names the window after the project directory so the window list shows *what* it is instead of just `opencode`.

## What it does

- **Needs input → purple** — the agent is blocked on a permission prompt or a question
- **Done → soft red** — the main agent finished (or errored) while you were away
- **Working / focused → normal** — no highlight while you're looking at it
- **Window naming** — renames the window to the project directory (`~/code/foo` → `foo`)
- **Sub-agent aware** — events from sub-agents (child sessions) never flash your main window
- **Mark-as-read** — focusing the window clears the highlight

The highlight only shows while the window is **inactive** (you're somewhere else), which is exactly when you need it. Come back to the window and it returns to normal.

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
| `OPENCODE_TMUX_SIGNAL_NEEDS_INPUT_BG` | `colour97` | Needs-input background (mellow purple) |
| `OPENCODE_TMUX_SIGNAL_NEEDS_INPUT_FG` | `white` | Needs-input text |
| `OPENCODE_TMUX_SIGNAL_DONE_BG` | `colour131` | Done background (soft red) |
| `OPENCODE_TMUX_SIGNAL_DONE_FG` | `white` | Done text |
| `OPENCODE_TMUX_SIGNAL_WINDOW_NAME` | `dir` | `dir` = rename window to project dir; `off` = leave it |
| `OPENCODE_TMUX_SIGNAL_RESET_ON_FOCUS` | `on` | Clear the highlight when you focus the window |

Colors accept any tmux color: `red`, `brightblue`, or `colour0`–`colour255`.

```sh
# example overrides
export OPENCODE_TMUX_SIGNAL_DONE_BG=colour52
export OPENCODE_TMUX_SIGNAL_NEEDS_INPUT_BG=colour60
export OPENCODE_TMUX_SIGNAL_WINDOW_NAME=off
```

## How it works

The plugin maps OpenCode events to three states and styles only its own window:

| Trigger | State | Visual |
| --- | --- | --- |
| `permission.ask` hook, `question` tool | needs-input | purple `window-status-style` |
| `session.idle`, `session.error` (main session) | done | soft-red `window-status-style` |
| `session.status` busy (main session) | running | cleared |

- The window is found once from `$TMUX_PANE`, so multi-pane layouts work correctly.
- Sub-agent sessions (those with a `parentID`) are tracked and their events ignored, so a finishing sub-agent never flashes the main window.
- `window-status-style` applies only to **inactive** windows, so the highlight is hidden while you're viewing the pane; a window-scoped `pane-focus-in` hook clears it once you return.
- Window naming sets `automatic-rename off` for that window only, then `rename-window` to the project basename.

Requires tmux 3.2+ (for window-scoped hooks) and bash/Bun (provided by OpenCode).

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
