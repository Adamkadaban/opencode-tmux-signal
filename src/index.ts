import type { Plugin, PluginModule } from "@opencode-ai/plugin"
import { basename, join } from "node:path"
import { homedir } from "node:os"
import { readFileSync, writeFileSync, existsSync, appendFileSync } from "node:fs"

const PREFIX = "OPENCODE_TMUX_SIGNAL_"
const env = (key: string, fallback: string): string => process.env[PREFIX + key] ?? fallback

const DEBUG = (process.env[PREFIX + "DEBUG"] ?? "") !== ""
const dbg: (...a: unknown[]) => void = DEBUG
  ? (...a) => {
      try {
        const line = a.map((x) => (typeof x === "string" ? x : JSON.stringify(x))).join(" ")
        appendFileSync("/tmp/opencode-tmux-signal.log", `[${new Date().toISOString()}] ${line}\n`)
      } catch {
        /* ignore */
      }
    }
  : () => {}

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
  permission: { bg: env("PERMISSION_BG", "colour179"), fg: env("PERMISSION_FG", "black") } as Style,
  question: { bg: env("QUESTION_BG", "colour97"), fg: env("QUESTION_FG", "white") } as Style,
  done: { bg: env("DONE_BG", "colour131"), fg: env("DONE_FG", "white") } as Style,
  windowName: env("WINDOW_NAME", "llm"),
  nameModels: parseModels(
    env(
      "NAME_MODELS",
      "github-copilot/gpt-5.4-mini,github-copilot/claude-haiku-4.5,github-copilot/gemini-3.5-flash",
    ),
  ),
  resetOnFocus: env("RESET_ON_FOCUS", "on") !== "off",
  manageTmuxConf: env("MANAGE_TMUX_CONF", "on") !== "off",
}

const DEFAULT_WINDOW_NAME = "opencode"
const THROWAWAY_TITLE = "opencode-tmux-signal: window name"

// opencode's placeholder title ("New session - <ts>") and the throwaway title
// aren't meaningful — don't name a window from them.
const isRealTitle = (t?: string): boolean => {
  const s = (t || "").trim()
  return s !== "" && s !== THROWAWAY_TITLE && !/^new session\b/i.test(s)
}

// Generic words a model might emit for a vague title — reject and try the next.
const BAD_SLUGS = new Set([
  "session", "new", "untitled", "opencode", "window", "name", "task", "project", "chat", "agent", "code",
])

// Bare process names tmux's automatic-rename may show. If a window shows one of
// these (or "opencode", or a name we set), it isn't a custom name the user
// chose, so we may rename it.
const PROCESS_NAMES = new Set([
  "opencode", "nano", "vim", "nvim", "vi", "emacs", "zsh", "bash", "sh", "fish",
  "node", "bun", "python", "python3", "git", "less", "man", "tmux", "htop", "top",
])

const slugify = (raw: string): string => {
  const toks = (raw || "").toLowerCase().match(/[a-z0-9][a-z0-9-]*/g) || []
  const filler = new Set(["name", "the", "a", "an", "is", "for", "project", "task", "window"])
  const pick = toks.find((t) => !filler.has(t)) || toks[0] || ""
  return pick.replace(/^-+|-+$/g, "").slice(0, 12)
}

// ---------------------------------------------------------------------------
// Persistent tmux setup (idempotent managed block in ~/.tmux.conf)
// ---------------------------------------------------------------------------

const CONF_BEGIN = "# >>> opencode-tmux-signal (managed) >>>"
const CONF_END = "# <<< opencode-tmux-signal (managed) <<<"
const CONF_BLOCK = [
  CONF_BEGIN,
  "# Clears the agent-state highlight when you open/click a window, and enables",
  "# focus events so it clears on mouse click too. Set",
  "# OPENCODE_TMUX_SIGNAL_MANAGE_TMUX_CONF=off to stop managing this block.",
  "set -g focus-events on",
  "set-hook -g after-select-window 'set-window-option -u window-status-style'",
  "set-hook -g after-select-pane 'set-window-option -u window-status-style'",
  CONF_END,
].join("\n")

const escapeRe = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")
const confPath = (): string => {
  const a = join(homedir(), ".tmux.conf")
  const b = join(homedir(), ".config", "tmux", "tmux.conf")
  return existsSync(a) ? a : existsSync(b) ? b : a
}
const blockRe = () => new RegExp(`\\n*${escapeRe(CONF_BEGIN)}[\\s\\S]*?${escapeRe(CONF_END)}\\n?`)

// Add (or remove) the managed block. Re-running yields a byte-identical file.
const ensureTmuxConf = (enabled: boolean): void => {
  try {
    const p = confPath()
    let cur = ""
    try {
      cur = readFileSync(p, "utf8")
    } catch {
      /* file may not exist */
    }
    const base = cur.replace(blockRe(), "\n").replace(/\s*$/, "")
    let next: string
    if (!enabled) next = base ? `${base}\n` : ""
    else next = base ? `${base}\n\n${CONF_BLOCK}\n` : `${CONF_BLOCK}\n`
    if (next !== cur) {
      writeFileSync(p, next)
      dbg("tmux conf:", enabled ? "wrote" : "removed", "managed block", p)
    }
  } catch (e) {
    dbg("ensureTmuxConf error", String(e))
  }
}

type State = "running" | "permission" | "question" | "done" | "off"

// ---------------------------------------------------------------------------
// Plugin
// ---------------------------------------------------------------------------

export const TmuxSignal: Plugin = async ({ $, client, directory, worktree }) => {
  const pane = process.env.TMUX_PANE
  if (!process.env.TMUX || !pane) return {}

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

  const windowId = await tmuxOut("display-message", "-p", "-t", pane, "#{window_id}")
  if (!windowId) return {}

  const applyStyle = (s: Style) =>
    tmux("set-window-option", "-t", windowId, "window-status-style", `bg=${s.bg},fg=${s.fg}`)
  const clearStyle = () => tmux("set-window-option", "-t", windowId, "-u", "window-status-style")

  const llmMode = config.windowName === "llm"
  const childSessions = new Set<string>()

  let ourName: string | null = null
  const renameIfOurs = async (name: string): Promise<void> => {
    if (!name) return
    const cur = await tmuxOut("display-message", "-p", "-t", windowId, "#{window_name}")
    if (cur !== DEFAULT_WINDOW_NAME && cur !== ourName && !PROCESS_NAMES.has(cur)) {
      dbg("rename skip: custom window name", JSON.stringify(cur))
      return
    }
    await tmux("set-window-option", "-t", windowId, "automatic-rename", "off")
    await tmux("rename-window", "-t", windowId, name)
    ourName = name
    dbg("renamed window ->", name)
  }

  // Ask a cheap model for a short window-name slug, using a throwaway session
  // that is ignored by the visual state machine and deleted immediately after.
  const llmSlug = async (text: string, fallbackModel?: ModelRef): Promise<string> => {
    const models = config.nameModels.slice()
    if (fallbackModel?.providerID && fallbackModel?.modelID) models.push(fallbackModel)
    if (models.length === 0) return ""
    let tmpId: string | undefined
    try {
      const created = await client.session.create({ body: { title: THROWAWAY_TITLE } })
      tmpId = created?.data?.id
      if (!tmpId) return ""
      childSessions.add(tmpId)
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
          dbg("llmSlug raw", `${model.providerID}/${model.modelID}`, JSON.stringify(out))
          const slug = slugify(out)
          if (slug && !BAD_SLUGS.has(slug)) return slug
        } catch (e) {
          dbg("llmSlug model failed", String(e).slice(0, 120))
        }
      }
      return ""
    } catch (e) {
      dbg("llmSlug error", String(e).slice(0, 160))
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

  // Name the window for `sessionID`. New session (no real title yet) -> use the
  // first prompt; resumed session (already titled) -> use the existing title.
  let namedSession: string | null = null
  const nameSession = async (sessionID?: string, promptText?: string, fallbackModel?: ModelRef): Promise<void> => {
    if (!llmMode || !sessionID) return
    if (childSessions.has(sessionID) || sessionID === namedSession) return
    namedSession = sessionID
    try {
      let title = ""
      try {
        const s = await client.session.get({ path: { id: sessionID } })
        title = (s?.data?.title || "").trim()
      } catch {
        /* ignore */
      }
      if (title === THROWAWAY_TITLE) {
        childSessions.add(sessionID)
        namedSession = null
        return
      }
      const text = (isRealTitle(title) ? title : "") || (promptText || "").trim()
      if (!text) {
        namedSession = null
        return
      }
      const slug = await llmSlug(text, fallbackModel)
      dbg("nameSession", sessionID, "->", JSON.stringify(slug))
      if (slug) await renameIfOurs(slug)
    } catch (e) {
      dbg("nameSession error", String(e).slice(0, 160))
    }
  }

  // --- one-time setup ------------------------------------------------------

  ensureTmuxConf(config.manageTmuxConf)

  if (config.windowName === "dir") {
    await renameIfOurs(basename(worktree || directory || "") || DEFAULT_WINDOW_NAME)
  }

  if (config.resetOnFocus) {
    await tmux("set-option", "-g", "focus-events", "on")
    await tmux("set-hook", "-g", "after-select-window", "set-window-option -u window-status-style")
    await tmux("set-hook", "-g", "after-select-pane", "set-window-option -u window-status-style")
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

  if (llmMode) {
    // Startup probe: name a resumed/idle session that emits no events on its own.
    setTimeout(async () => {
      if (namedSession) return
      try {
        const list = await client.session.list()
        const cands = ((list?.data ?? []) as any[])
          .filter(
            (s) => !s.parentID && (s.directory === directory || s.directory === worktree) && isRealTitle(s.title),
          )
          .sort((a, b) => (b.time?.updated || 0) - (a.time?.updated || 0))
        if (cands[0]) await nameSession(cands[0].id)
      } catch (e) {
        dbg("startup probe error", String(e).slice(0, 160))
      }
    }, 1500)
  }

  // --- state machine -------------------------------------------------------

  let lastState: State = "off"
  let idleAt = 0

  const setState = async (state: State): Promise<void> => {
    if (state === lastState) return
    lastState = state
    if (state === "permission") await applyStyle(config.permission)
    else if (state === "question") await applyStyle(config.question)
    else if (state === "done") await applyStyle(config.done)
    else await clearStyle()
  }

  return {
    event: async ({ event }) => {
      const props = (event as { properties?: Record<string, any> }).properties

      if (event.type === "session.created" || event.type === "session.updated") {
        if (props?.info?.parentID) {
          childSessions.add(props.info.id)
          return
        }
        if (props?.info?.id) void nameSession(props.info.id)
      }

      if (event.type === "session.status" && props?.status?.type === "busy") {
        if (childSessions.has(props.sessionID)) return
        void nameSession(props.sessionID)
        if (Date.now() - idleAt < 2000) return
        await setState("running")
      }

      if (event.type === "session.idle") {
        if (childSessions.has(props?.sessionID)) return
        void nameSession(props?.sessionID)
        idleAt = Date.now()
        await setState("done")
      }

      if (event.type === "session.error") {
        if (props?.sessionID && childSessions.has(props.sessionID)) return
        idleAt = Date.now()
        await setState("done")
      }
    },

    "chat.message": async (input, output) => {
      if (childSessions.has(input.sessionID)) return
      const text = ((output?.parts ?? []) as any[])
        .filter((p) => p.type === "text")
        .map((p) => p.text as string)
        .join(" ")
      void nameSession(input.sessionID, text, input.model)
    },

    "permission.ask": async () => {
      await setState("permission")
    },
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
