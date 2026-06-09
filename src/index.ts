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

type CopilotAuth = {
  type?: string
  refresh?: string
  access?: string
  enterpriseUrl?: string
}

const config = {
  permission: { bg: env("PERMISSION_BG", "colour179"), fg: env("PERMISSION_FG", "black") } as Style,
  question: { bg: env("QUESTION_BG", "colour97"), fg: env("QUESTION_FG", "white") } as Style,
  done: { bg: env("DONE_BG", "colour131"), fg: env("DONE_FG", "white") } as Style,
  windowName: env("WINDOW_NAME", "llm"),
  nameModel: env("NAME_MODEL", "github-copilot/gpt-4o-mini"),
  nameTimeoutMs: envInt("NAME_TIMEOUT_MS", 2500, 500, 10000),
  resetOnFocus: env("RESET_ON_FOCUS", "on") !== "off",
  manageTmuxConf: env("MANAGE_TMUX_CONF", "on") !== "off",
}

// Maximum tmux window-name length.
const MAX_LEN = 8

const DEFAULT_WINDOW_NAME = "opencode"
const COPILOT_API_VERSION = "2026-06-01"

// Generic words that aren't useful as a window name.
const BAD_SLUGS = new Set([
  "session", "new", "untitled", "opencode", "window", "name", "task", "project", "chat", "agent", "code",
  "done", "complete", "completed", "finish", "finished", "idle",
  "if", "ok", "okay", "please", "prompt", "title", "titles",
  "i", "me", "my", "we", "us", "our", "you", "your", "it", "its", "this", "that", "these", "those", "they", "them", "their",
])

// opencode's placeholder title ("New session - <ts>") and generic status
// titles aren't meaningful — don't name a window from them.
const isRealTitle = (t?: string): boolean => {
  const s = (t || "").trim()
  const slug = slugify(s)
  return s !== "" && !/^new session\b/i.test(s) && slug.length > 1 && !BAD_SLUGS.has(slug)
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

const authPath = (): string => join(process.env.XDG_DATA_HOME || join(homedir(), ".local", "share"), "opencode", "auth.json")

const copilotBase = (enterpriseUrl?: string): string => {
  if (!enterpriseUrl) return "https://api.githubcopilot.com"
  const normalized = enterpriseUrl.replace(/^https?:\/\//, "").replace(/\/$/, "")
  return `https://copilot-api.${normalized}`
}

const readCopilotAuth = (): CopilotAuth | undefined => {
  try {
    const auth = JSON.parse(readFileSync(authPath(), "utf8")) as Record<string, CopilotAuth>
    const copilot = auth["github-copilot"]
    if (copilot?.type === "oauth" && (copilot.refresh || copilot.access)) return copilot
  } catch {
    /* auth is optional; deterministic fallback covers misses */
  }
  return undefined
}

const directModelSlug = async (raw: string): Promise<string> => {
  const parsed = config.nameModel.split("/")
  const modelID = parsed[0] === "github-copilot" ? parsed.slice(1).join("/") : ""
  if (!modelID) return ""
  const auth = readCopilotAuth()
  const token = auth?.refresh || auth?.access
  if (!token) return ""

  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), config.nameTimeoutMs)
  ;(timer as any).unref?.()
  try {
    const response = await fetch(`${copilotBase(auth.enterpriseUrl)}/chat/completions`, {
      method: "POST",
      signal: controller.signal,
      headers: {
        "content-type": "application/json",
        authorization: `Bearer ${token}`,
        "openai-intent": "conversation-edits",
        "user-agent": "opencode-tmux-signal",
        "x-github-api-version": COPILOT_API_VERSION,
        "x-interaction-type": "agent-session-name-generation",
        "x-initiator": "agent",
      },
      body: JSON.stringify({
        model: modelID,
        temperature: 0,
        max_tokens: 8,
        messages: [
          {
            role: "system",
            content:
              `Name a tmux window for a coding session. Reply with ONLY one lowercase token, ${MAX_LEN} characters or fewer, using a-z, 0-9, or hyphen. ` +
              "Focus on the concrete technical topic or domain. Ignore meta words like title, prompt, okay, analyze, explain. No explanation.",
          },
          { role: "user", content: raw.slice(0, 500) },
        ],
      }),
    })
    if (!response.ok) {
      dbg("directModelSlug failed", response.status, modelID)
      return ""
    }
    const body = (await response.json()) as any
    const text = body?.choices?.[0]?.message?.content || body?.choices?.[0]?.text || ""
    const slug = slugify(text)
    dbg("directModelSlug", modelID, "->", JSON.stringify(slug))
    return goodSlug(slug) && !STOPWORDS.has(slug) ? slug : ""
  } catch (e) {
    dbg("directModelSlug error", String(e).slice(0, 120))
    return ""
  } finally {
    clearTimeout(timer)
  }
}

const nameSlug = async (raw: string): Promise<string> => fastStructuredSlug(raw) || (await directModelSlug(raw)) || fallbackPromptSlug(raw)

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
  const waitForInit = async (ms = 1000): Promise<boolean> => {
    if (initDone) return initOk
    return (await withTimeout(initReady, ms)) === true
  }

  const applyStyle = (s: Style) =>
    windowId ? tmux("set-window-option", "-t", windowId, "window-status-style", `bg=${s.bg},fg=${s.fg}`) : Promise.resolve()
  const clearStyle = () => windowId ? tmux("set-window-option", "-t", windowId, "-u", "window-status-style") : Promise.resolve()

  const llmMode = config.windowName === "llm"
  const childSessions = new Set<string>()

  let ourName: string | null = null
  const renameIfOurs = async (name: string): Promise<void> => {
    if (!name) return
    if (!(await waitForInit())) return
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

  // Name the window for `sessionID`, in priority order:
  //   1. real session title (a resumed/named session)
  //   2. the first prompt (a brand-new session)
  //   3. the project directory name — only as a fallback for an *old* session
  //      that has no title yet (a brand-new session waits for its prompt instead).
  const startTime = Date.now()
  let contentSession: string | null = null // named from title/prompt (final)
  let dirSession: string | null = null // named from the directory (upgradable)
  const namingSessions = new Set<string>()
  const nameSession = async (sessionID?: string, promptText?: string): Promise<void> => {
    if (!llmMode || !sessionID) return
    if (childSessions.has(sessionID) || sessionID === contentSession || namingSessions.has(sessionID)) return
    namingSessions.add(sessionID)
    try {
      if (!(await waitForInit())) return
      let title = ""
      let createdAt = 0
      try {
        const s = await withTimeout(client.session.get({ path: { id: sessionID } }), 1000)
        title = (s?.data?.title || "").trim()
        createdAt = s?.data?.time?.created || 0
      } catch {
        /* ignore */
      }
      const resumed = createdAt > 0 && createdAt < startTime - 30000
      if (resumed && isRealTitle(title)) {
        contentSession = sessionID
        const slug = await nameSlug(title)
        dbg("nameSession title", sessionID, "->", JSON.stringify(slug))
        if (slug) await renameIfOurs(slug)
        else contentSession = null
        return
      }
      const content = (promptText || "").trim()
      if (content && !BAD_SLUGS.has(slugify(content))) {
        contentSession = sessionID
        const slug = await nameSlug(content)
        dbg("nameSession prompt", sessionID, "->", JSON.stringify(slug))
        if (slug) await renameIfOurs(slug)
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
        if (dn) await renameIfOurs(dn)
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
    if (!(await waitForInit(1000))) return
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
      void nameSession(input.sessionID, text)
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
