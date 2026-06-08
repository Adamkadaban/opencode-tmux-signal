# opencode-tmux-signal

[![npm version](https://img.shields.io/npm/v/opencode-tmux-signal.svg)](https://www.npmjs.com/package/opencode-tmux-signal)
[![npm downloads](https://img.shields.io/npm/dm/opencode-tmux-signal.svg)](https://www.npmjs.com/package/opencode-tmux-signal)
[![license](https://img.shields.io/npm/l/opencode-tmux-signal.svg)](./LICENSE)

Signal opencode agent state in tmux. Recolors the session's window when it needs you or finishes, and names the window after the session so a row of `opencode` windows becomes readable.

OpenCode tmux-signal is a server-side plugin that drives tmux at runtime from the pane opencode launched in.

## Install

```bash
opencode plugin opencode-tmux-signal -g
```

This installs the package globally and updates your `opencode.json` automatically.

Or manually:

```bash
npm install -g opencode-tmux-signal
```

Then add to your `opencode.json`:

```json
{
  "$schema": "https://opencode.ai/config.json",
  "plugin": ["opencode-tmux-signal"]
}
```

Requires tmux 3.0+. On first run it adds a small managed block to your `~/.tmux.conf` (focus events + a reset hook) so the highlight clears reliably; disable with `OPENCODE_TMUX_SIGNAL_MANAGE_TMUX_CONF=off`.

## Usage

Run opencode inside tmux. Its window is recolored by state and named automatically — no commands to run.

| State | Window |
| --- | --- |
| Permission request | yellow |
| Question | purple |
| Done / error | soft red |
| Working, or focused | no highlight |

The highlight only shows while the window is **inactive** (you're elsewhere) and clears when you open the window. Naming asks a cheap model for a short slug from your first prompt — or, when you resume a session, its existing title — and **never overwrites a name you set**. Sub-agent (child session) events never flash the main window.

### Configuration

All options are environment variables (defaults are a mellow palette for a green status bar):

| Variable | Default | Description |
| --- | --- | --- |
| `OPENCODE_TMUX_SIGNAL_PERMISSION_BG` / `_FG` | `colour179` / `black` | Permission-request colors |
| `OPENCODE_TMUX_SIGNAL_QUESTION_BG` / `_FG` | `colour97` / `white` | Question colors |
| `OPENCODE_TMUX_SIGNAL_DONE_BG` / `_FG` | `colour131` / `white` | Done colors |
| `OPENCODE_TMUX_SIGNAL_WINDOW_NAME` | `llm` | `llm`, `dir` (project directory), or `off` |
| `OPENCODE_TMUX_SIGNAL_NAME_MODELS` | `github-copilot/gpt-5.4-mini,…claude-haiku-4.5,…gemini-3.5-flash` | `provider/model` list tried in order |
| `OPENCODE_TMUX_SIGNAL_RESET_ON_FOCUS` | `on` | Clear the highlight when you open the window |
| `OPENCODE_TMUX_SIGNAL_MANAGE_TMUX_CONF` | `on` | Manage the `~/.tmux.conf` block |
| `OPENCODE_TMUX_SIGNAL_DEBUG` | _(unset)_ | Log decisions to `/tmp/opencode-tmux-signal.log` |

Colors accept any tmux color (`red`, `brightblue`, `colour0`–`colour255`).

## How it works

- The window is resolved once from `$TMUX_PANE`, so multi-pane layouts work.
- State is colored via `window-status-style` (which only shows on inactive windows); a `pane-focus-in` / `after-select` hook clears it when you open the window.
- Naming runs a throwaway model call in a temporary session (deleted right after) and only renames a window whose name is still a bare process name (`opencode`, `nano`, …), never a custom one.
- Sub-agent sessions (those with a `parentID`) are tracked and ignored.

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
