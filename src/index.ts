import type { Plugin, PluginModule } from "@opencode-ai/plugin"
import { basename } from "node:path"

// ---------------------------------------------------------------------------
// Config — all options are read from environment variables so they can live in
// your shell profile. Defaults match a mellow palette that pairs with a green
// tmux status bar.
// ---------------------------------------------------------------------------

const PREFIX = "OPENCODE_TMUX_SIGNAL_"
const env = (key: string, fallback: string): string => process.env[PREFIX + key] ?? fallback

type Style = { bg: string; fg: string }

const config = {
  // Yellow: the agent is asking permission to do something.
  permission: { bg: env("PERMISSION_BG", "colour179"), fg: env("PERMISSION_FG", "black") } as Style,
  // Purple: the agent is asking you a question.
  question: { bg: env("QUESTION_BG", "colour97"), fg: env("QUESTION_FG", "white") } as Style,
  // Soft red: the main agent finished (or errored) while you were away.
  done: { bg: env("DONE_BG", "colour131"), fg: env("DONE_FG", "white") } as Style,
  // "dir" -> rename the window to the project directory; "off" -> leave it.
  windowName: env("WINDOW_NAME", "dir"),
  // Clear the highlight once you focus the window ("mark as read").
  resetOnFocus: env("RESET_ON_FOCUS", "on") !== "off",
}

type State = "running" | "permission" | "question" | "done" | "off"

// ---------------------------------------------------------------------------
// Plugin
// ---------------------------------------------------------------------------

export const TmuxSignal: Plugin = async ({ $, directory, worktree }) => {
  const pane = process.env.TMUX_PANE
  const inTmux = Boolean(process.env.TMUX && pane)
  if (!inTmux) return {}

  // Run a tmux command, swallowing errors (tmux may be an old version, the
  // window may have closed, etc. — never let it break the session).
  const tmux = async (...args: string[]): Promise<void> => {
    try {
      await $`tmux ${args}`.quiet()
    } catch {
      /* non-fatal */
    }
  }
  const tmuxOut = async (...args: string[]): Promise<string> => {
    try {
      return (await $`tmux ${args}`.quiet().text()).trim()
    } catch {
      return ""
    }
  }

  // Resolve OUR window once, from the pane opencode was launched in. This is
  // robust to multi-pane layouts (no "active pane" guessing).
  const windowId = await tmuxOut("display-message", "-p", "-t", pane!, "#{window_id}")
  if (!windowId) return {}

  const applyStyle = (s: Style) =>
    tmux("set-window-option", "-t", windowId, "window-status-style", `bg=${s.bg},fg=${s.fg}`)
  const clearStyle = () => tmux("set-window-option", "-t", windowId, "-u", "window-status-style")

  // --- one-time setup ------------------------------------------------------

  // Name the window after the project so the window list shows *what* it is
  // instead of just "opencode". We disable automatic-rename for this window
  // only; other windows keep their behavior.
  if (config.windowName === "dir") {
    const name = basename(worktree || directory || "") || "opencode"
    await tmux("set-window-option", "-t", windowId, "automatic-rename", "off")
    await tmux("rename-window", "-t", windowId, name)
  }

  // Clear the highlight when the window gains focus. Window-scoped hook so it
  // disappears with the window and never touches global tmux state.
  if (config.resetOnFocus) {
    await tmux(
      "set-hook",
      "-w",
      "-t",
      windowId,
      "pane-focus-in",
      `set-window-option -t ${windowId} -u window-status-style`,
    )
  }

  await clearStyle()

  // --- state machine -------------------------------------------------------

  let lastState: State = "off"
  let idleAt = 0
  // Sub-agent (child) sessions have a parentID. Track them so their lifecycle
  // events don't flash the main window.
  const childSessions = new Set<string>()

  const setState = async (state: State): Promise<void> => {
    if (state === lastState) return
    lastState = state
    if (state === "permission") await applyStyle(config.permission)
    else if (state === "question") await applyStyle(config.question)
    else if (state === "done") await applyStyle(config.done)
    else await clearStyle() // running / off -> no highlight
  }

  return {
    event: async ({ event }) => {
      const props = (event as { properties?: Record<string, any> }).properties

      // Learn which sessions are sub-agents as soon as we see them.
      if (
        (event.type === "session.created" || event.type === "session.updated") &&
        props?.info?.parentID
      ) {
        childSessions.add(props.info.id)
        return
      }

      if (event.type === "session.status" && props?.status?.type === "busy") {
        if (childSessions.has(props.sessionID)) return
        if (Date.now() - idleAt < 2000) return // race guard vs. a just-fired idle
        await setState("running")
      }

      if (event.type === "session.idle") {
        if (childSessions.has(props?.sessionID)) return
        idleAt = Date.now()
        await setState("done")
      }

      if (event.type === "session.error") {
        if (props?.sessionID && childSessions.has(props.sessionID)) return
        idleAt = Date.now()
        await setState("done")
      }
    },

    // The agent is blocked asking permission.
    "permission.ask": async () => {
      await setState("permission")
    },
    // The question tool blocks waiting for your answer.
    "tool.execute.before": async (input: { tool: string }) => {
      if (input.tool === "question") await setState("question")
    },
  }
}

const plugin: PluginModule & { id: string } = {
  id: "opencode-tmux-signal",
  server: TmuxSignal,
}

export default plugin
