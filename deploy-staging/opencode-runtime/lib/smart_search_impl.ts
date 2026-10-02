/**
 * smart_search harness 工具實作（多來源研究工具，smartsearch 免 Key 通路）。
 *
 * 零外部依賴：只用 node 內建模組（child_process spawn 傳 argv 陣列，禁 shell 拼接）。
 * 呼叫端（tools/smart_search.ts）負責 @opencode-ai/plugin 的 import；本檔不得引入。
 *
 * 上游：konbakuyomu/smartsearch v0.1.25（MIT）之 smart_search package **逐檔複製**到
 * lib/smartsearch/smart_search/（含 providers/ 子包），外加免 Key 最小補丁（見
 * lib/smartsearch/UPSTREAM.md 與 keyless.patch）。本工具只做 argparse 映射 → 呼叫既有
 * `python3 -m smart_search.cli <subcommand> ... --format json`，**不另寫 driver**。
 *
 * 免 Key 通路（實測可通）：fetch=Jina Reader、docs=Context7、vertical=AnySearch、
 * 部分 web_search=fircrawl 匿名。`web` intent 走 CLI `search`（需 main-search 憑證），
 * 憑證缺失時 CLI 回 ok:false config_error，本工具據此回 fail 並給可操作 hint。
 *
 * 落位：/opt/agent-harness/workspace/.opencode/lib/smart_search_impl.ts
 * env：子進程只帶 PATH/HOME/LANG/LC_ALL/PYTHONPATH（指向 vendored package 父目錄）
 *      ＋**若進程有 EXA_API_KEY 才透傳**（讓 Exa 亦可用）。嚴禁整體 process.env 透傳。
 *      HOME 指向 os.tmpdir() 下的可寫臨時目錄，確保 CLI 的自動 skill maintenance
 *      不嘗試寫入唯讀的 lib/。
 */

import { spawn } from "node:child_process"
import { fileURLToPath } from "node:url"
import { dirname, join } from "node:path"
import { tmpdir } from "node:os"
import { mkdirSync, mkdtempSync } from "node:fs"

const HERE = dirname(fileURLToPath(import.meta.url))

/** vendored `smart_search` package 父目錄（PYTHONPATH 指這裡；同目錄另有 vendored tenacity/）。 */
export const SMART_SEARCH_PACKAGE_DIR = join(HERE, "smartsearch")

/** CLI 以模組方式執行（不依賴 PATH 上的 `smart-search` entrypoint）。 */
export const SMART_SEARCH_CLI_MODULE = "smart_search.cli"

/** 逾時：page（抓取已知 URL）。 */
export const SMART_SEARCH_TIMEOUT_PAGE_MS = 60_000

/** 逾時：docs（函式庫/API 文檔）。 */
export const SMART_SEARCH_TIMEOUT_DOCS_MS = 60_000

/** 逾時：web（通用網頁搜尋，較慢）。 */
export const SMART_SEARCH_TIMEOUT_WEB_MS = 120_000

/** 錯誤訊息攜帶原文的上限（同 search_aggregate_impl.ts 口徑）。 */
const OUTPUT_EXCERPT_MAX_CHARS = 2000

// ── plumbing（ok/fail 同構 search_aggregate_impl.ts / web_search_impl.ts） ────

export type WebToolResult = { title: string; output: string }

function ok(data: Record<string, unknown>): WebToolResult {
  const { title, ...rest } = data
  return { title: (title as string) ?? "完成", output: JSON.stringify({ ok: true, ...rest }) }
}

function fail(code: string, hint: string, extra?: Record<string, unknown>): WebToolResult {
  const { title, ...rest } = extra ?? {}
  return { title: (title as string) ?? "失败", output: JSON.stringify({ ok: false, error: { code, hint }, ...rest }) }
}

export interface WebToolArgSpec {
  type: "string" | "number" | "boolean"
  required: boolean
  description: string
  enum?: readonly string[]
}

export interface WebToolContext {
  abort?: AbortSignal
  /** 會話 id（本工具暫無會話資產落盤；adapter 機械透傳保留欄位）。 */
  sessionId?: string
}

export interface WebToolDef {
  id: string
  description: string
  args: Record<string, WebToolArgSpec>
  execute: (args: Record<string, unknown>, context?: WebToolContext) => Promise<WebToolResult>
}

function asString(v: unknown): string | undefined {
  return typeof v === "string" && v.trim() !== "" ? v : undefined
}

// ── intent → 子命令 / 逾時 映射 ───────────────────────────────────────────────

export const SMART_SEARCH_INTENTS = ["web", "page", "docs"] as const
export type SmartSearchIntent = (typeof SMART_SEARCH_INTENTS)[number]

/**
 * intent → CLI 子命令 argv（flag 與值亦為獨立 argv 元素，使用者輸入永不經 shell）。
 *   page → fetch <url>
 *   docs → context7-docs <library_id> <query>；無 library_id → context7-library <query>（自動選庫）
 *   web  → search <query>
 */
export function resolveSubcommand(intent: SmartSearchIntent, args: { query?: string; url?: string; library_id?: string }): string[] {
  if (intent === "page") {
    return ["fetch", args.url as string]
  }
  if (intent === "docs") {
    const libraryId = asString(args.library_id)
    if (libraryId) return ["context7-docs", libraryId, args.query as string]
    return ["context7-library", args.query as string]
  }
  return ["search", args.query as string]
}

/** 逾時推導：page 60s、docs 60s、web 120s。 */
export function resolveTimeoutMs(intent: SmartSearchIntent): number {
  if (intent === "page") return SMART_SEARCH_TIMEOUT_PAGE_MS
  if (intent === "docs") return SMART_SEARCH_TIMEOUT_DOCS_MS
  return SMART_SEARCH_TIMEOUT_WEB_MS
}

// ── 子進程 env 白名單 ────────────────────────────────────────────────────────

/**
 * 只傳必要 env：PATH/HOME/LANG/LC_ALL/PYTHONPATH。
 * EXA_API_KEY 僅在來源存在時才透傳（讓 Exa 亦可用）；其餘密鑰（JINA/FIRECRAWL/
 * CONTEXT7/ANYSEARCH/XAI/OPENAI_COMPATIBLE 等）一律不透傳。
 */
export function buildChildEnv(source: NodeJS.ProcessEnv, homeDir: string, pythonPath: string = SMART_SEARCH_PACKAGE_DIR): Record<string, string> {
  const env: Record<string, string> = {
    PATH: source.PATH ?? "/usr/local/bin:/usr/bin:/bin",
    HOME: homeDir,
    LANG: "C.UTF-8",
    LC_ALL: "C.UTF-8",
    PYTHONPATH: pythonPath,
  }
  const exa = asString(source.EXA_API_KEY)
  if (exa) env.EXA_API_KEY = exa
  return env
}

// ── 子進程執行（argv 陣列，禁 shell 拼接） ───────────────────────────────────

export interface SmartSearchRunResult {
  code: number | null
  stdout: string
  stderr: string
  timedOut: boolean
  spawnError?: string
  elapsedMs: number
}

/**
 * spawn argv 陣列執行 `python3 -m smart_search.cli <argv>`。
 * query/url 等使用者輸入一律作為單一 argv 元素傳入，never 經過 shell（無注入面）。
 */
export function runSmartSearchProcess(input: {
  argv: string[]
  timeoutMs: number
  env: Record<string, string>
  /** 測試注入：覆寫 python 執行檔（默認 python3）。 */
  pythonBin?: string
  /** 測試注入：覆寫 PYTHONPATH/模組（默認 smart_search.cli）。 */
  cliModule?: string
}): Promise<SmartSearchRunResult> {
  return new Promise((resolve) => {
    const started = Date.now()
    const python = input.pythonBin ?? "python3"
    const module = input.cliModule ?? SMART_SEARCH_CLI_MODULE
    const child = spawn(python, ["-m", module, ...input.argv], {
      env: input.env,
      stdio: ["ignore", "pipe", "pipe"],
    })
    let stdout = ""
    let stderr = ""
    let timedOut = false
    let settled = false
    const timer = setTimeout(() => {
      timedOut = true
      try {
        child.kill("SIGKILL")
      } catch {
        /* 子進程可能已結束 */
      }
    }, input.timeoutMs)
    child.stdout?.on("data", (d) => {
      stdout += d.toString()
    })
    child.stderr?.on("data", (d) => {
      stderr += d.toString()
    })
    child.on("error", (e) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      resolve({
        code: null,
        stdout,
        stderr,
        timedOut,
        spawnError: (e as Error)?.message ?? String(e),
        elapsedMs: Date.now() - started,
      })
    })
    child.on("close", (code) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      resolve({ code, stdout, stderr, timedOut, elapsedMs: Date.now() - started })
    })
  })
}

// ── smart_search 工具 ────────────────────────────────────────────────────────

export interface SmartSearchToolDeps {
  /** 測試注入：覆寫逾時。 */
  timeoutMs?: number
  /** 測試注入：覆寫 env 來源（默認 process.env）。 */
  envSource?: NodeJS.ProcessEnv
  /** 測試注入：覆寫 python 執行檔。 */
  pythonBin?: string
  /** 測試注入：覆寫 CLI 模組。 */
  cliModule?: string
  /** 測試注入：覆寫 PYTHONPATH。 */
  pythonPath?: string
}

/** `web` intent 缺 main-search 憑證時的可操作 hint。 */
const WEB_MISSING_CREDS_HINT =
  "该 intent 走 CLI `search`（需 main-search 凭证：xAI 或 OpenAI 兼容 relay），当前未配置。" +
  "请改用 search_web（Exa，通用网页搜索）或 search_aggregate（B站/GitHub/Reddit 社群口碑），" +
  "亦可指定 provider 子命令（如 anysearch-search / context7-library）。"

/**
 * 工具主體（execute 與測試共用）。deps 僅測試注入用，execute 傳空物件。
 */
export async function runSmartSearchTool(rawArgs: Record<string, unknown>, deps: SmartSearchToolDeps = {}): Promise<WebToolResult> {
  const intentRaw = asString(rawArgs.intent)
  if (!intentRaw || !(SMART_SEARCH_INTENTS as readonly string[]).includes(intentRaw)) {
    return fail("invalid_args", `缺少或非法的 intent，合法值只有 ${SMART_SEARCH_INTENTS.join(" / ")}。`)
  }
  const intent = intentRaw as SmartSearchIntent

  const query = asString(rawArgs.query)
  const url = asString(rawArgs.url)
  if (intent === "page") {
    if (!url) return fail("invalid_args", "page intent 需要 url（要抓取的已知网址）。")
  } else if (!query) {
    return fail("invalid_args", `${intent} intent 需要 query（搜索/文档关键词）。`)
  }

  const subcommand = resolveSubcommand(intent, { query, url, library_id: asString(rawArgs.library_id) })
  const timeoutMs = deps.timeoutMs ?? resolveTimeoutMs(intent)

  let homeDir: string
  try {
    homeDir = mkdtempSync(join(tmpdir(), "smart-search-"))
    mkdirSync(homeDir, { recursive: true })
  } catch (e) {
    return fail("state_dir_unavailable", `无法建立临时 HOME 目录：${(e as Error)?.message ?? String(e)}`)
  }
  const env = buildChildEnv(deps.envSource ?? process.env, homeDir, deps.pythonPath ?? SMART_SEARCH_PACKAGE_DIR)

  const run = await runSmartSearchProcess({
    // 使用者輸入一律單一 argv 元素；flag 與值亦分開成陣列元素。
    argv: [...subcommand, "--format", "json"],
    timeoutMs,
    env,
    pythonBin: deps.pythonBin,
    cliModule: deps.cliModule,
  })

  if (run.timedOut) {
    return fail(
      "upstream_timeout",
      `smart_search ${intent} 超时：已等待 ${run.elapsedMs} ms（上限 ${timeoutMs} ms），已 SIGKILL 终止子进程。` +
        (run.stderr.trim() ? ` stderr 前 ${OUTPUT_EXCERPT_MAX_CHARS} 字：${run.stderr.slice(0, OUTPUT_EXCERPT_MAX_CHARS)}` : ""),
    )
  }
  if (run.spawnError) {
    return fail("upstream_exit", `无法启动 python3（-m ${deps.cliModule ?? SMART_SEARCH_CLI_MODULE}）：${run.spawnError}`)
  }
  if (run.code !== 0) {
    return fail(
      "upstream_exit",
      `smart_search ${intent} 非零退出（exit ${run.code}）。stderr 前 ${OUTPUT_EXCERPT_MAX_CHARS} 字：${run.stderr.slice(0, OUTPUT_EXCERPT_MAX_CHARS) || "(空)"}`,
    )
  }

  let parsed: unknown
  try {
    parsed = JSON.parse(run.stdout)
  } catch {
    return fail(
      "bad_output",
      `CLI 输出不是合法 JSON。stdout 前 ${OUTPUT_EXCERPT_MAX_CHARS} 字：${run.stdout.slice(0, OUTPUT_EXCERPT_MAX_CHARS) || "(空)"}`,
    )
  }

  const obj = (parsed && typeof parsed === "object" ? (parsed as Record<string, unknown>) : {}) as Record<string, unknown>
  if (obj.ok === false) {
    const upstreamError = asString(obj.error) ?? "上游返回 ok:false"
    const code = asString(obj.error_type) ?? "upstream_error"
    const hint = intent === "web" ? `${upstreamError}｜${WEB_MISSING_CREDS_HINT}` : upstreamError
    return fail(code, hint, { intent, upstream: obj })
  }

  return ok({
    title: "检索完成",
    intent,
    elapsed_ms: run.elapsedMs,
    result: obj,
  })
}

export const smartSearchTool: WebToolDef = {
  id: "smart_search",
  description:
    "多來源研究工具（smart_search，smartsearch 免 Key 通路）：抓取網頁、查函式庫文檔、社群/垂直檢索，返回真內容＋真連結。" +
    "**結論必須帶 URL 出處，禁止只憑內部知識作答。** " +
    "三種 intent：" +
    "`page`＝抓取「已知 URL」的正文（免 Key，走 Jina/Firecrawl；參數用 url）；" +
    "`docs`＝查函式庫/框架/API 文檔（免 Key，走 Context7；參數用 query，可選 library_id 指定庫，不給則自動選庫）；" +
    "`web`＝通用網頁搜尋（走 CLI search，**需 main-search 憑證**；憑證缺失會回 fail 並提示替代）。" +
    "分流：通用網頁搜尋優先 `search_web`（Exa）；社群口碑（Reddit）、B站中文內容、開源專案/代碼用 `search_aggregate`；" +
    "已知 URL 要正文用本工具的 `page`；查框架/API 文檔用本工具的 `docs`。",
  args: {
    intent: {
      type: "string",
      required: true,
      enum: SMART_SEARCH_INTENTS,
      description: "检索类型：web＝通用网页搜索（需 main-search 凭证）；page＝抓取已知 URL 正文（用 url）；docs＝函式库/API 文档（用 query，可带 library_id）。",
    },
    query: {
      type: "string",
      required: false,
      description: "搜索/文档关键词。intent=web 与 intent=docs 必填；intent=page 忽略。",
    },
    url: {
      type: "string",
      required: false,
      description: "要抓取的已知网页 URL。intent=page 必填；其余 intent 忽略。",
    },
    library_id: {
      type: "string",
      required: false,
      description: "intent=docs 可选：指定 Context7 函式库 id（如 /reactjs/react.dev）。不填则按 query 自动选库。",
    },
  },
  async execute(rawArgs) {
    return runSmartSearchTool(rawArgs, {})
  },
}

/** registry 登記用 id（同 web_search/search_aggregate 範式；註冊名以檔名 smart_search 為準）。 */
export const SMART_SEARCH_HARNESS_TOOL_IDS = ["smart_search"] as const
