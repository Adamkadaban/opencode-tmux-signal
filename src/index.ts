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
  // Optional explicit override (comma-separated provider/model). When empty,
  // model selection prefers opencode's small_model, then a built-in fast list,
  // then the session's own model.
  nameModels: parseModels(env("NAME_MODELS", "")),
  resetOnFocus: env("RESET_ON_FOCUS", "on") !== "off",
  manageTmuxConf: env("MANAGE_TMUX_CONF", "on") !== "off",
}

// Maximum tmux window-name length.
const MAX_LEN = 8

// Fast, cheap models tried when no small_model is configured. A model the user
// can't access simply errors and the next is tried; for non-listed providers,
// the configured small_model and the session's own model cover it.
const BUILTIN_MODELS: ModelRef[] = [
  { providerID: "github-copilot", modelID: "gpt-5-mini" },
  { providerID: "github-copilot", modelID: "claude-haiku-4.5" },
  { providerID: "github-copilot", modelID: "gemini-3.5-flash" },
]

const DEFAULT_WINDOW_NAME = "opencode"
const THROWAWAY_TITLE = "opencode-tmux-signal: window name"

// Generic words a model might emit for a vague title — reject and try the next.
const BAD_SLUGS = new Set([
  "session", "new", "untitled", "opencode", "window", "name", "task", "project", "chat", "agent", "code",
  "done", "complete", "completed", "finish", "finished", "idle",
])

// opencode's placeholder title ("New session - <ts>"), generic status titles,
// and the throwaway title aren't meaningful — don't name a window from them.
const isRealTitle = (t?: string): boolean => {
  const s = (t || "").trim()
  return s !== "" && s !== THROWAWAY_TITLE && !/^new session\b/i.test(s) && !BAD_SLUGS.has(slugify(s))
}

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
  return pick.replace(/^-+|-+$/g, "").slice(0, 40)
}

const fastTitleSlug = (raw: string): string => {
  const toks = (raw || "").toLowerCase().match(/[a-z0-9][a-z0-9-]*/g) || []
  const filler = new Set([
    "a", "an", "and", "for", "from", "in", "into", "is", "of", "on", "the", "to", "with",
    "add", "build", "create", "debug", "fix", "implement", "make", "update", "use", "using",
    "name", "project", "task", "window",
  ])
  const pick = toks.find((t) => !filler.has(t) && !BAD_SLUGS.has(t) && t.length <= MAX_LEN) || ""
  return pick.replace(/^-+|-+$/g, "")
}

// Project directory as a window name. `dirFull` is the untruncated lowercased
// basename (used to recognize a window we previously named after the dir, even
// if the length limit changed); `dirName` applies the configured length cap.
const dirFull = (dir: string): string =>
  basename(dir || "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
const dirName = (dir: string): string => dirFull(dir).slice(0, MAX_LEN)

const explicitSessionID = (argv = process.argv): string => {
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]
    if (arg === "-s" || arg === "--session") return argv[i + 1] || ""
    const m = arg.match(/^--session=(.+)$/)
    if (m) return m[1]
  }
  return ""
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
    const d = worktree || directory
    const ours =
      cur === DEFAULT_WINDOW_NAME ||
      cur === ourName ||
      PROCESS_NAMES.has(cur) ||
      cur === dirName(d) ||
      cur === dirFull(d)
    if (!ours) {
      dbg("rename skip: custom window name", JSON.stringify(cur))
      return
    }
    if (cur === name) {
      ourName = name
      return
    }
    await tmux("set-window-option", "-t", windowId, "automatic-rename", "off")
    await tmux("rename-window", "-t", windowId, name)
    ourName = name
    dbg("renamed window ->", name)
  }

  const dedupeAdd = (arr: ModelRef[], m?: ModelRef | null): void => {
    if (m?.providerID && m?.modelID && !arr.some((x) => x.providerID === m.providerID && x.modelID === m.modelID)) arr.push(m)
  }
  const parseModel = (s?: string): ModelRef | null => {
    const i = (s || "").indexOf("/")
    return i > 0 ? { providerID: (s as string).slice(0, i), modelID: (s as string).slice(i + 1) } : null
  }
  // Resolve naming models, preferring a subscription-appropriate small model:
  // explicit override -> opencode's configured small_model -> built-in fast list
  // -> the session's own model (always usable with the active subscription).
  const resolveModels = async (sessionModel?: ModelRef): Promise<ModelRef[]> => {
    const out: ModelRef[] = []
    if (config.nameModels.length) {
      config.nameModels.forEach((m) => dedupeAdd(out, m))
    } else {
      try {
        const c = await client.config.get()
        dedupeAdd(out, parseModel((c?.data as any)?.small_model))
      } catch {
        /* ignore */
      }
      BUILTIN_MODELS.forEach((m) => dedupeAdd(out, m))
    }
    dedupeAdd(out, sessionModel)
    return out
  }

  const textParts = (res: any): string =>
    ((res?.data?.parts ?? []) as any[]).filter((p) => p.type === "text").map((p) => p.text as string).join(" ")

  // Ask a model for a window-name slug. The model is told to keep it <= MAX_LEN;
  // if it returns something longer we reject it and ask again (trying the next
  // model / a stronger instruction) rather than blindly truncating.
  const llmSlug = async (text: string, sessionModel?: ModelRef): Promise<string> => {
    const models = await resolveModels(sessionModel)
    if (!models.length) return ""
    let tmpId: string | undefined
    try {
      const created = await client.session.create({ body: { title: THROWAWAY_TITLE } })
      tmpId = created?.data?.id
      if (!tmpId) return ""
      childSessions.add(tmpId)
      const base =
        "You name a tmux window for a coding session. Reply with ONLY one lowercase token " +
        `(a word, abbreviation, or acronym), ${MAX_LEN} characters or fewer, using only a-z, 0-9 and hyphens. ` +
        "No spaces, quotes, punctuation, or explanation."
      const userText = `Task: ${text.slice(0, 400)}`
      let best = ""
      const maxAttempts = Math.min(5, models.length + 2)
      for (let i = 0; i < maxAttempts; i++) {
        const model = models[Math.min(i, models.length - 1)]
        const system =
          i === 0 ? base : `${base} Your previous answer was too long — it MUST be ${MAX_LEN} characters or fewer; abbreviate or use an acronym.`
        try {
          const res = await client.session.prompt({
            path: { id: tmpId },
            body: { model, system, parts: [{ type: "text" as const, text: userText }] },
          })
          const slug = slugify(textParts(res))
          dbg("llmSlug", `${model.providerID}/${model.modelID}`, "->", JSON.stringify(slug), `(len ${slug.length})`)
          if (slug && !BAD_SLUGS.has(slug)) {
            if (slug.length <= MAX_LEN) return slug
            if (!best) best = slug // remember in case nothing fits, as a last resort
          }
        } catch (e) {
          dbg("llmSlug model failed", `${model.providerID}/${model.modelID}`, String(e).slice(0, 120))
        }
      }
      return best ? best.slice(0, MAX_LEN) : ""
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

  // Name the window for `sessionID`, in priority order:
  //   1. real session title (a resumed/named session)
  //   2. the first prompt (a brand-new session)
  //   3. the project directory name — only as a fallback for an *old* session
  //      that has no title yet (a brand-new session waits for its prompt instead).
  const startTime = Date.now()
  let contentSession: string | null = null // named from title/prompt (final)
  let dirSession: string | null = null // named from the directory (upgradable)
  const nameSession = async (sessionID?: string, promptText?: string, fallbackModel?: ModelRef): Promise<void> => {
    if (!llmMode || !sessionID) return
    if (childSessions.has(sessionID) || sessionID === contentSession) return
    try {
      let title = ""
      let createdAt = 0
      try {
        const s = await client.session.get({ path: { id: sessionID } })
        title = (s?.data?.title || "").trim()
        createdAt = s?.data?.time?.created || 0
      } catch {
        /* ignore */
      }
      if (title === THROWAWAY_TITLE) {
        childSessions.add(sessionID)
        return
      }
      if (isRealTitle(title)) {
        contentSession = sessionID // claim before the async model call
        const quick = fastTitleSlug(title)
        if (quick) {
          dbg("nameSession fast-title", sessionID, "->", JSON.stringify(quick))
          await renameIfOurs(quick)
          return
        }
        const slug = await llmSlug(title, fallbackModel)
        dbg("nameSession title", sessionID, "->", JSON.stringify(slug))
        if (slug) await renameIfOurs(slug)
        else contentSession = null
        return
      }
      const content = (promptText || "").trim()
      if (content && !BAD_SLUGS.has(slugify(content))) {
        contentSession = sessionID // claim before the async model call
        const slug = await llmSlug(content, fallbackModel)
        dbg("nameSession prompt", sessionID, "->", JSON.stringify(slug))
        if (slug) await renameIfOurs(slug)
        else contentSession = null
        return
      }
      // No title and no prompt. Fall back to the directory only for a session
      // that existed before this opencode started (a resume); a brand-new
      // session waits for its first prompt.
      const resumed = createdAt > 0 && createdAt < startTime - 30000
      if (resumed && dirSession !== sessionID) {
        dirSession = sessionID
        const dn = dirName(worktree || directory)
        dbg("nameSession dir-fallback", sessionID, "->", JSON.stringify(dn))
        if (dn) await renameIfOurs(dn)
      }
    } catch (e) {
      dbg("nameSession error", String(e).slice(0, 160))
    }
  }

  // --- one-time setup ------------------------------------------------------

  ensureTmuxConf(config.manageTmuxConf)

  // In "dir" mode the window is named after the project directory up front.
  // In "llm" mode naming is driven by nameSession (title / prompt / dir fallback).
  if (config.windowName === "dir") {
    await renameIfOurs(dirName(worktree || directory) || DEFAULT_WINDOW_NAME)
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
    const resumedSessionID = explicitSessionID()
    // Startup probe: name an explicitly resumed/idle session that emits no
    // events on its own. A plain blank session must not inherit the latest
    // historical session name from the same directory.
    // nameSession applies the priority (title -> prompt -> dir fallback for old).
    const startupProbe = async () => {
      if (contentSession || !resumedSessionID) return
      try {
        await nameSession(resumedSessionID)
      } catch (e) {
        dbg("startup probe error", String(e).slice(0, 160))
      }
    }
    setTimeout(startupProbe, 100)
    setTimeout(startupProbe, 1000)
  }

  // --- state machine -------------------------------------------------------

  let lastState: State = "off"
  let idleAt = 0

  // True when this window is the one you're currently looking at.
  const isWindowActive = async (): Promise<boolean> =>
    (await tmuxOut("display-message", "-p", "-t", windowId, "#{window_active}")) === "1"

  const setState = async (state: State): Promise<void> => {
    if (state === lastState) return
    lastState = state
    const style =
      state === "permission" ? config.permission : state === "question" ? config.question : state === "done" ? config.done : null
    // Only highlight when the window is in the background — if you're already on
    // it, you've seen the state change, so leave it unhighlighted.
    if (style && !(await isWindowActive())) await applyStyle(style)
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
