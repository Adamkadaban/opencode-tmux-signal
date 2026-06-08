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
type ModelRef = { providerID: string; modelID: string }

const parseModels = (s: string): ModelRef[] =>
  s
    .split(",")
    .map((x) => x.trim())
    .filter(Boolean)
    .map((x) => {
      const i = x.indexOf("/")
      return i === -1 ? null : { providerID: x.slice(0, i), modelID: x.slice(i + 1) }
    })
    .filter((m): m is ModelRef => m !== null)

const config = {
  // Yellow: the agent is asking permission to do something.
  permission: { bg: env("PERMISSION_BG", "colour179"), fg: env("PERMISSION_FG", "black") } as Style,
  // Purple: the agent is asking you a question.
  question: { bg: env("QUESTION_BG", "colour97"), fg: env("QUESTION_FG", "white") } as Style,
  // Soft red: the main agent finished (or errored) while you were away.
  done: { bg: env("DONE_BG", "colour131"), fg: env("DONE_FG", "white") } as Style,
  // "llm" -> short LLM-generated slug from your first prompt / session title;
  // "dir" -> project directory basename; "off" -> leave the window name alone.
  windowName: env("WINDOW_NAME", "llm"),
  // Cheap/small models tried in order (fallbacks) for the naming call.
  nameModels: parseModels(
    env(
      "NAME_MODELS",
      "github-copilot/gpt-5.4-mini,github-copilot/claude-haiku-4.5,github-copilot/gemini-3.5-flash",
    ),
  ),
  // Clear the highlight once you select the window ("mark as read").
  resetOnFocus: env("RESET_ON_FOCUS", "on") !== "off",
}

// The default window name we are allowed to overwrite. Anything else means the
// user (or something) already named the window, so we leave it untouched.
const DEFAULT_WINDOW_NAME = "opencode"

const slugify = (raw: string): string => {
  const toks = (raw || "").toLowerCase().match(/[a-z0-9][a-z0-9-]*/g) || []
  const filler = new Set(["name", "the", "a", "an", "is", "for", "project", "task", "window"])
  const pick = toks.find((t) => !filler.has(t)) || toks[0] || ""
  return pick.replace(/^-+|-+$/g, "").slice(0, 12)
}

type State = "running" | "permission" | "question" | "done" | "off"

// ---------------------------------------------------------------------------
// Plugin
// ---------------------------------------------------------------------------

export const TmuxSignal: Plugin = async ({ $, client, directory, worktree }) => {
  const pane = process.env.TMUX_PANE
  const inTmux = Boolean(process.env.TMUX && pane)
  if (!inTmux) return {}

  // Run a tmux command, swallowing errors (never let it break the session).
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

  // Resolve OUR window once, from the pane opencode was launched in. Robust to
  // multi-pane layouts (no "active pane" guessing).
  const windowId = await tmuxOut("display-message", "-p", "-t", pane!, "#{window_id}")
  if (!windowId) return {}

  const applyStyle = (s: Style) =>
    tmux("set-window-option", "-t", windowId, "window-status-style", `bg=${s.bg},fg=${s.fg}`)
  const clearStyle = () => tmux("set-window-option", "-t", windowId, "-u", "window-status-style")

  // Rename the window, but only if it still has the default name (never clobber
  // a name you set yourself).
  const renameIfDefault = async (name: string): Promise<void> => {
    if (!name) return
    if ((await tmuxOut("display-message", "-p", "-t", windowId, "#{window_name}")) !== DEFAULT_WINDOW_NAME) return
    await tmux("set-window-option", "-t", windowId, "automatic-rename", "off")
    await tmux("rename-window", "-t", windowId, name)
  }

  // Sub-agent (child) sessions have a parentID. Track them so their lifecycle
  // events don't flash the main window (and so the throwaway naming session is
  // ignored too).
  const childSessions = new Set<string>()

  // Ask a cheap model for a short window-name slug, using a throwaway session
  // that is ignored by the visual state machine and deleted immediately after.
  const llmSlug = async (text: string, fallbackModel?: ModelRef): Promise<string> => {
    const models = config.nameModels.slice()
    if (fallbackModel?.providerID && fallbackModel?.modelID) models.push(fallbackModel)
    if (models.length === 0) return ""
    let tmpId: string | undefined
    try {
      const created = await client.session.create({ body: { title: "opencode-tmux-signal: window name" } })
      tmpId = created?.data?.id
      if (!tmpId) return ""
      childSessions.add(tmpId) // ignore this session's events in our visuals
      const system =
        "You name a tmux window for a coding session. Reply with ONLY one short lowercase token " +
        "(a word, abbreviation, or acronym), max 10 characters, using only a-z, 0-9 and hyphens. " +
        "No spaces, quotes, punctuation, or explanation."
      const parts = [{ type: "text" as const, text: `Task: ${text.slice(0, 400)}` }]
      for (const model of models) {
        try {
          const res = await client.session.prompt({ path: { id: tmpId }, body: { model, system, parts } })
          const out = ((res?.data?.parts ?? []) as any[])
            .filter((p) => p.type === "text")
            .map((p) => p.text as string)
            .join(" ")
          const slug = slugify(out)
          if (slug) return slug
        } catch {
          /* try next model */
        }
      }
      return ""
    } catch {
      return ""
    } finally {
      if (tmpId) {
        try {
          await client.session.delete({ path: { id: tmpId } })
        } catch {
          /* ignore */
        }
      }
    }
  }

  // Naming runs at most once. `named` is claimed synchronously so concurrent
  // triggers (first prompt vs. resumed-session title) can't both fire.
  let named = config.windowName !== "llm"
  let probed = false // one-time fetch fallback for resumed sessions

  const startNaming = (text: string | undefined, fallbackModel?: ModelRef): void => {
    const t = (text || "").trim()
    if (named || !t) return
    named = true
    void (async () => {
      try {
        const slug = await llmSlug(t, fallbackModel)
        await renameIfDefault(slug)
      } catch {
        /* non-fatal */
      }
    })()
  }

  // Resumed/pre-existing session: opencode already has an LLM-generated title.
  // Use it (from the event payload when present, else a one-time fetch).
  const probeResume = async (sessionID?: string): Promise<void> => {
    if (named || probed || !sessionID || childSessions.has(sessionID)) return
    probed = true
    try {
      const s = await client.session.get({ path: { id: sessionID } })
      startNaming(s?.data?.title)
    } catch {
      /* non-fatal */
    }
  }

  // --- one-time setup ------------------------------------------------------

  if (config.windowName === "dir") {
    await renameIfDefault(basename(worktree || directory || "") || DEFAULT_WINDOW_NAME)
  }

  // Clear the highlight when you select the window. Global after-select hooks
  // fire on selection regardless of `focus-events` (a window-scoped
  // pane-focus-in hook would need it). With no `-t`, the unset targets the
  // just-selected window, so it only ever clears the window you opened.
  if (config.resetOnFocus) {
    await tmux("set-hook", "-g", "after-select-window", "set-window-option -u window-status-style")
    await tmux("set-hook", "-g", "after-select-pane", "set-window-option -u window-status-style")
  }

  await clearStyle()

  // --- state machine -------------------------------------------------------

  let lastState: State = "off"
  let idleAt = 0

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

      if (event.type === "session.created" || event.type === "session.updated") {
        if (props?.info?.parentID) {
          childSessions.add(props.info.id)
          return
        }
        // Root session with an existing title -> resumed-session naming.
        if (!named && props?.info?.title) startNaming(props.info.title)
      }

      if (event.type === "session.status" && props?.status?.type === "busy") {
        if (childSessions.has(props.sessionID)) return
        if (!named) void probeResume(props.sessionID) // resume fallback
        if (Date.now() - idleAt < 2000) return // race guard vs. a just-fired idle
        await setState("running")
      }

      if (event.type === "session.idle") {
        if (childSessions.has(props?.sessionID)) return
        if (!named) void probeResume(props?.sessionID) // resume fallback
        idleAt = Date.now()
        await setState("done")
      }

      if (event.type === "session.error") {
        if (props?.sessionID && childSessions.has(props.sessionID)) return
        idleAt = Date.now()
        await setState("done")
      }
    },

    // First user prompt of a new session -> generate a short window name
    // (fire-and-forget so we never delay the user's message).
    "chat.message": async (input, output) => {
      if (named) return
      if (childSessions.has(input.sessionID)) return
      const text = ((output?.parts ?? []) as any[])
        .filter((p) => p.type === "text")
        .map((p) => p.text as string)
        .join(" ")
      startNaming(text, input.model)
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
