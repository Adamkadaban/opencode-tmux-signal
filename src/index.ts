import type { Plugin, PluginModule } from "@opencode-ai/plugin"
import { basename, join } from "node:path"
import { homedir } from "node:os"
import { readFileSync, writeFileSync, existsSync, appendFileSync } from "node:fs"

const PREFIX = "OPENCODE_TMUX_SIGNAL_"
const env = (key: string, fallback: string): string => process.env[PREFIX + key] ?? fallback
const envInt = (key: string, fallback: number, min: number, max: number): number => {
  const n = Number.parseInt(env(key, String(fallback)), 10)
  return Number.isFinite(n) ? Math.min(max, Math.max(min, n)) : fallback
}

const withTimeout = async <T>(promise: Promise<T>, ms: number): Promise<T | undefined> => {
  if (ms <= 0) return undefined
  let timer: ReturnType<typeof setTimeout> | undefined
  const timeout = new Promise<undefined>((resolve) => {
    timer = setTimeout(() => resolve(undefined), ms)
    ;(timer as any).unref?.()
  })
  try {
    return await Promise.race([promise, timeout])
  } finally {
    if (timer) clearTimeout(timer)
  }
}

const elapsed = (start: number): string => `${Date.now() - start}ms`

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
  nameTimeoutMs: envInt("NAME_TIMEOUT_MS", 7000, 1000, 10000),
  resetOnFocus: env("RESET_ON_FOCUS", "on") !== "off",
  manageTmuxConf: env("MANAGE_TMUX_CONF", "on") !== "off",
}

// Maximum tmux window-name length.
const MAX_LEN = 8

// Fast, cheap models tried when no small_model is configured. A model the user
// can't access simply errors and the next is tried; for non-listed providers,
// the configured small_model and the session's own model cover it.
const BUILTIN_MODELS: ModelRef[] = [
  { providerID: "github-copilot", modelID: "claude-haiku-4.5" },
  { providerID: "github-copilot", modelID: "gpt-4o-mini" },
  { providerID: "github-copilot", modelID: "gpt-5-mini" },
  { providerID: "github-copilot", modelID: "gemini-3-flash-preview" },
]

const MODEL_PROMPT_TIMEOUT_MS = 2500

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
  const slug = slugify(s)
  return s !== "" && s !== THROWAWAY_TITLE && !/^new session\b/i.test(s) && slug.length > 1 && !BAD_SLUGS.has(slug)
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

const goodSlug = (slug: string): boolean => slug.length > 1 && slug.length <= MAX_LEN && !BAD_SLUGS.has(slug)

const STOPWORDS = new Set([
  "about", "after", "again", "all", "also", "and", "anything", "are", "around", "ask", "bad", "because", "been", "but", "can", "could",
  "did", "does", "doing", "explain", "for", "from", "gave", "get", "got", "had", "has", "have", "help", "into", "just", "like",
  "long", "make", "more", "much", "need", "not", "one", "please", "prompt", "really", "should", "some", "stuff", "that", "the", "their",
  "then", "there", "things", "this", "title", "titles", "very", "was", "what", "when", "where", "which", "while", "why", "with", "would",
])

const fastStructuredSlug = (raw: string): string => {
  const path = raw.match(/(?:~|\.{1,2}|\/)[^\s'"`)]+/)
  if (path) {
    const clean = path[0].replace(/[.,;:!?]+$/g, "")
    const base = basename(clean).replace(/^\.+/, "")
    const slug = slugify(base)
    if (goodSlug(slug)) return slug
  }
  return ""
}

const fallbackPromptSlug = (raw: string): string => {
  const text = (raw || "").toLowerCase()
  const topic = text.match(/\b(?:about|regarding|around|for)\s+([a-z0-9][a-z0-9-]*)/)
  if (topic) {
    const slug = slugify(topic[1])
    if (goodSlug(slug) && !STOPWORDS.has(slug)) return slug
  }
  const toks = text.match(/[a-z0-9][a-z0-9-]*/g) || []
  let best = ""
  let bestScore = -1
  for (let i = 0; i < toks.length; i++) {
    const t = toks[i]
    if (t.length > MAX_LEN || t.length < 3 || STOPWORDS.has(t) || BAD_SLUGS.has(t)) continue
    let score = t.length
    if (/\d/.test(t)) score += 2
    if (i > 0 && ["about", "regarding", "around", "for"].includes(toks[i - 1])) score += 20
    if (score > bestScore) {
      best = t
      bestScore = score
    }
  }
  return goodSlug(best) ? best : ""
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

  let windowId = ""
  let resolveInit: (ok: boolean) => void = () => {}
  let initDone = false
  let initOk = false
  const initReady = new Promise<boolean>((resolve) => {
    resolveInit = resolve
  })
  const finishInit = (ok: boolean): boolean => {
    if (!initDone) {
      initDone = true
      initOk = ok
      resolveInit(ok)
    }
    return ok
  }
  const timeLeft = (deadline: number): number => Math.max(0, deadline - Date.now())
  const waitForInit = async (deadline: number): Promise<boolean> => {
    if (initDone) return initOk
    return (await withTimeout(initReady, timeLeft(deadline))) === true
  }

  const applyStyle = (s: Style) =>
    windowId ? tmux("set-window-option", "-t", windowId, "window-status-style", `bg=${s.bg},fg=${s.fg}`) : Promise.resolve()
  const clearStyle = () => windowId ? tmux("set-window-option", "-t", windowId, "-u", "window-status-style") : Promise.resolve()

  const llmMode = config.windowName === "llm"
  const childSessions = new Set<string>()

  let ourName: string | null = null
  const renameIfOurs = async (name: string, deadline = Date.now() + config.nameTimeoutMs): Promise<void> => {
    if (!name) return
    if (!(await waitForInit(deadline))) return
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
  const resolveModels = async (sessionModel?: ModelRef, deadline = Date.now() + config.nameTimeoutMs): Promise<ModelRef[]> => {
    const start = Date.now()
    const out: ModelRef[] = []
    if (config.nameModels.length) {
      config.nameModels.forEach((m) => dedupeAdd(out, m))
    } else {
      try {
        const left = timeLeft(deadline)
        const c = left > 0 ? await withTimeout(client.config.get(), left) : undefined
        if (!c) dbg("resolveModels config timeout", elapsed(start))
        dedupeAdd(out, parseModel((c?.data as any)?.small_model))
      } catch {
        /* ignore */
      }
      BUILTIN_MODELS.forEach((m) => dedupeAdd(out, m))
    }
    dedupeAdd(out, sessionModel)
    dbg("resolveModels", out.map((m) => `${m.providerID}/${m.modelID}`).join(","), elapsed(start))
    return out
  }

  const textParts = (res: any): string =>
    ((res?.data?.parts ?? []) as any[]).filter((p) => p.type === "text").map((p) => p.text as string).join(" ")

  // Ask a model for a window-name slug. The model is told to keep it <= MAX_LEN;
  // if it returns something longer we reject it and ask again (trying the next
  // model / a stronger instruction) rather than blindly truncating.
  const llmSlug = async (text: string, sessionModel?: ModelRef, deadline = Date.now() + config.nameTimeoutMs): Promise<string> => {
    const start = Date.now()
    const models = await resolveModels(sessionModel, deadline)
    if (!models.length) return ""
    try {
      const base =
        "You name a tmux window for a coding session. Reply with ONLY one lowercase token " +
        `(a word, abbreviation, or acronym), ${MAX_LEN} characters or fewer, using only a-z, 0-9 and hyphens. ` +
        "No spaces, quotes, punctuation, or explanation."
      const userText = `Task: ${text.slice(0, 400)}`
      let best = ""
      for (let i = 0; i < models.length; i++) {
        let tmpId = ""
        const model = models[i]
        const system =
          i === 0 ? base : `${base} Your previous answer was too long — it MUST be ${MAX_LEN} characters or fewer; abbreviate or use an acronym.`
        try {
          if (timeLeft(deadline) <= 0) break
          const created = await withTimeout(client.session.create({ body: { title: THROWAWAY_TITLE } }), Math.min(500, timeLeft(deadline)))
          if (!created?.data?.id) {
            dbg("llmSlug create timeout", `${model.providerID}/${model.modelID}`, elapsed(start))
            continue
          }
          tmpId = created.data.id
          childSessions.add(tmpId)
          const attemptMs = Math.min(MODEL_PROMPT_TIMEOUT_MS, timeLeft(deadline))
          const res = await withTimeout(client.session.prompt({
            path: { id: tmpId },
            body: { model, system, parts: [{ type: "text" as const, text: userText }] },
          }), attemptMs)
          if (!res) {
            dbg("llmSlug prompt timeout", `${model.providerID}/${model.modelID}`, elapsed(start))
            continue
          }
          const slug = slugify(textParts(res))
          dbg("llmSlug", `${model.providerID}/${model.modelID}`, "->", JSON.stringify(slug), `(len ${slug.length})`)
          if (slug && !BAD_SLUGS.has(slug)) {
            if (goodSlug(slug)) return slug
            if (!best) best = slug // remember in case nothing fits, as a last resort
          }
        } catch (e) {
          dbg("llmSlug model failed", `${model.providerID}/${model.modelID}`, String(e).slice(0, 120))
        } finally {
          if (tmpId) void client.session.delete({ path: { id: tmpId } }).catch(() => {})
        }
      }
      const fallback = best.slice(0, MAX_LEN)
      if (!fallback) dbg("llmSlug no usable slug", elapsed(start))
      return fallback.length > 1 && !BAD_SLUGS.has(fallback) ? fallback : ""
    } catch (e) {
      dbg("llmSlug error", String(e).slice(0, 160))
      return ""
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
  const namingSessions = new Set<string>()
  const nameSession = async (sessionID?: string, promptText?: string, fallbackModel?: ModelRef): Promise<void> => {
    if (!llmMode || !sessionID) return
    if (childSessions.has(sessionID) || sessionID === contentSession || namingSessions.has(sessionID)) return
    namingSessions.add(sessionID)
    const deadline = Date.now() + config.nameTimeoutMs
    try {
      if (!(await waitForInit(deadline))) return
      let title = ""
      let createdAt = 0
      try {
        const left = timeLeft(deadline)
        const s = left > 0 ? await withTimeout(client.session.get({ path: { id: sessionID } }), left) : undefined
        title = (s?.data?.title || "").trim()
        createdAt = s?.data?.time?.created || 0
      } catch {
        /* ignore */
      }
      if (title === THROWAWAY_TITLE) {
        childSessions.add(sessionID)
        return
      }
      const resumed = createdAt > 0 && createdAt < startTime - 30000
      if (resumed && isRealTitle(title)) {
        contentSession = sessionID // claim before the async model call
        const quick = fastStructuredSlug(title)
        if (quick) {
          dbg("nameSession fast-title", sessionID, "->", JSON.stringify(quick))
          await renameIfOurs(quick, deadline)
          return
        }
        const slug = (await llmSlug(title, fallbackModel, deadline)) || fallbackPromptSlug(title)
        dbg("nameSession title", sessionID, "->", JSON.stringify(slug))
        if (slug) await renameIfOurs(slug, deadline)
        else contentSession = null
        return
      }
      const content = (promptText || "").trim()
      if (content && !BAD_SLUGS.has(slugify(content))) {
        contentSession = sessionID // claim before the async model call
        const quick = fastStructuredSlug(content)
        if (quick) {
          dbg("nameSession fast-prompt", sessionID, "->", JSON.stringify(quick))
          await renameIfOurs(quick, deadline)
          return
        }
        const slug = (await llmSlug(content, fallbackModel, deadline)) || fallbackPromptSlug(content)
        dbg("nameSession prompt", sessionID, "->", JSON.stringify(slug))
        if (slug) await renameIfOurs(slug, deadline)
        else contentSession = null
        return
      }
      // No title and no prompt. Fall back to the directory only for a session
      // that existed before this opencode started (a resume); a brand-new
      // session waits for its first prompt.
      if (resumed && dirSession !== sessionID) {
        dirSession = sessionID
        const dn = dirName(worktree || directory)
        dbg("nameSession dir-fallback", sessionID, "->", JSON.stringify(dn))
        if (dn) await renameIfOurs(dn, deadline)
      }
    } catch (e) {
      dbg("nameSession error", String(e).slice(0, 160))
    } finally {
      namingSessions.delete(sessionID)
    }
  }

  // --- one-time setup ------------------------------------------------------

  void (async () => {
    windowId = await tmuxOut("display-message", "-p", "-t", pane, "#{window_id}")
    if (!windowId) {
      finishInit(false)
      return
    }
    finishInit(true)
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
  })().catch((e) => {
    dbg("init error", String(e).slice(0, 160))
    finishInit(false)
  })

  // --- state machine -------------------------------------------------------

  let lastState: State = "off"
  let idleAt = 0

  // True when this window is the one you're currently looking at.
  const isWindowActive = async (): Promise<boolean> =>
    (await tmuxOut("display-message", "-p", "-t", windowId, "#{window_active}")) === "1"

  const setState = async (state: State): Promise<void> => {
    const deadline = Date.now() + 1000
    if (!(await waitForInit(deadline))) return
    if (state !== lastState) dbg("state", lastState, "->", state)
    lastState = state
    const style =
      state === "permission" ? config.permission : state === "question" ? config.question : state === "done" ? config.done : null
    // Only highlight when the window is in the background — if you're already on
    // it, you've seen the state change, so leave it unhighlighted.
    if (style && !(await isWindowActive())) await applyStyle(style)
    else await clearStyle()
  }

  // OpenCode 1.16.2 does not invoke the documented permission.ask hook for
  // external-directory prompts in the TUI. Watch the pane text as a fallback so
  // background windows still get the permission color while waiting for input.
  const pollPermissionPrompt = async (): Promise<void> => {
    const text = await tmuxOut("capture-pane", "-p", "-t", pane, "-S", "-80")
    const waiting = /Permission required|Allow once\s+Allow always\s+Reject/.test(text)
    if (waiting) await setState("permission")
    else if (lastState === "permission") await setState("running")
  }
  const permissionPoll = setInterval(() => void pollPermissionPrompt(), 500)
  ;(permissionPoll as any).unref?.()

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
      dbg("permission.ask hook")
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
