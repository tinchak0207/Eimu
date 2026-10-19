/**
 * smart_search harness 工具实作（多来源研究工具，smartsearch 免 Key 通路）。
 *
 * 零外部依赖：只用 node 内建模组（child_process spawn 传 argv 阵列，禁 shell 拼接）。
 * 呼叫端（tools/smart_search.ts）负责 @opencode-ai/plugin 的 import；本档不得引入。
 *
 * 上游：konbakuyomu/smartsearch v0.1.25（MIT）之 smart_search package **逐档复制**到
 * lib/smartsearch/smart_search/（含 providers/ 子包），外加免 Key 最小补丁（见
 * lib/smartsearch/UPSTREAM.md 与 keyless.patch）。本工具只做 argparse 映射 → 呼叫既有
 * `python3 -m smart_search.cli <subcommand> ... --format json`，**不另写 driver**。
 *
 * 免 Key 通路（实测可通）：fetch=Jina Reader、docs=Context7、vertical=AnySearch、
 * 部分 web_search=fircrawl 匿名。`web` intent 先走 CLI `search`（需 main-search 凭证）；
 * 若回 ok:false（含凭证缺失的 config_error/main_search），**自动免 Key 回落**改跑 vendored
 * smartsearch 自己的 `anysearch-search`（通用网页搜寻，免 Key），外层以 served_by 标明实际
 * 由哪条通路服务（`smartsearch:search` / `smartsearch:anysearch-search`）。两条皆失败才回 fail，
 * hint 同时列出两条错误与可操作替代（search_web / search_aggregate）。
 *
 * 落位：/opt/eimu-harness/workspace/.opencode/lib/smart_search_impl.ts
 * env：子进程只带 PATH/HOME/LANG/LC_ALL/PYTHONPATH（指向 vendored package 父目录）
 *      ＋**若进程有 EXA_API_KEY 才透传**（让 Exa 亦可用）。严禁整体 process.env 透传。
 *      HOME 指向 os.tmpdir() 下的可写临时目录，确保 CLI 的自动 skill maintenance
 *      不尝试写入唯读的 lib/。
 */

import { spawn } from "node:child_process"
import { fileURLToPath } from "node:url"
import { dirname, join } from "node:path"
import { tmpdir } from "node:os"
import { mkdirSync, mkdtempSync } from "node:fs"

const HERE = dirname(fileURLToPath(import.meta.url))

/** vendored `smart_search` package 父目录（PYTHONPATH 指这里；同目录另有 vendored tenacity/）。 */
export const SMART_SEARCH_PACKAGE_DIR = join(HERE, "smartsearch")

/** CLI 以模组方式执行（不依赖 PATH 上的 `smart-search` entrypoint）。 */
export const SMART_SEARCH_CLI_MODULE = "smart_search.cli"

/** 逾时：page（抓取已知 URL）。 */
export const SMART_SEARCH_TIMEOUT_PAGE_MS = 60_000

/** 逾时：docs（函式库/API 文档）。 */
export const SMART_SEARCH_TIMEOUT_DOCS_MS = 60_000

/** 逾时：web（通用网页搜寻，较慢）。 */
export const SMART_SEARCH_TIMEOUT_WEB_MS = 120_000

/**
 * web 免 Key 回落（anysearch-search）的最低剩余预算（ms）：主通路失败后若剩余预算低于此值，
 * 宁可如实回报（upstream_timeout）也不静默截断。
 */
export const SMART_SEARCH_MIN_FALLBACK_MS = 10_000

/** 错误讯息携带原文的上限（同 search_aggregate_impl.ts 口径）。 */
const OUTPUT_EXCERPT_MAX_CHARS = 2000

// ── plumbing（ok/fail 同构 search_aggregate_impl.ts / web_search_impl.ts） ────

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
  /** 会话 id（本工具暂无会话资产落盘；adapter 机械透传保留栏位）。 */
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

// ── intent → 子命令 / 逾时 映射 ───────────────────────────────────────────────

export const SMART_SEARCH_INTENTS = ["web", "page", "docs"] as const
export type SmartSearchIntent = (typeof SMART_SEARCH_INTENTS)[number]

/**
 * intent → CLI 子命令 argv（flag 与值亦为独立 argv 元素，使用者输入永不经 shell）。
 *   page → fetch <url>
 *   docs → context7-docs <library_id> <query>；无 library_id → context7-library <query>（自动选库）
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

/** 逾时推导：page 60s、docs 60s、web 120s。 */
export function resolveTimeoutMs(intent: SmartSearchIntent): number {
  if (intent === "page") return SMART_SEARCH_TIMEOUT_PAGE_MS
  if (intent === "docs") return SMART_SEARCH_TIMEOUT_DOCS_MS
  return SMART_SEARCH_TIMEOUT_WEB_MS
}

// ── 子进程 env 白名单 ────────────────────────────────────────────────────────

/**
 * 只传必要 env：PATH/HOME/LANG/LC_ALL/PYTHONPATH。
 * EXA_API_KEY 仅在来源存在时才透传（让 Exa 亦可用）；其余密钥（JINA/FIRECRAWL/
 * CONTEXT7/ANYSEARCH/XAI/OPENAI_COMPATIBLE 等）一律不透传。
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

// ── 子进程执行（argv 阵列，禁 shell 拼接） ───────────────────────────────────

export interface SmartSearchRunResult {
  code: number | null
  stdout: string
  stderr: string
  timedOut: boolean
  spawnError?: string
  elapsedMs: number
}

/**
 * spawn argv 阵列执行 `python3 -m smart_search.cli <argv>`。
 * query/url 等使用者输入一律作为单一 argv 元素传入，never 经过 shell（无注入面）。
 */
export function runSmartSearchProcess(input: {
  argv: string[]
  timeoutMs: number
  env: Record<string, string>
  /** 测试注入：覆写 python 执行档（默认 python3）。 */
  pythonBin?: string
  /** 测试注入：覆写 PYTHONPATH/模组（默认 smart_search.cli）。 */
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
        /* 子进程可能已结束 */
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
  /** 测试注入：覆写逾时。 */
  timeoutMs?: number
  /** 测试注入：覆写 env 来源（默认 process.env）。 */
  envSource?: NodeJS.ProcessEnv
  /** 测试注入：覆写 python 执行档。 */
  pythonBin?: string
  /** 测试注入：覆写 CLI 模组。 */
  cliModule?: string
  /** 测试注入：覆写 PYTHONPATH。 */
  pythonPath?: string
}

/** `web` intent 缺 main-search 凭证时的可操作 hint。 */
const WEB_MISSING_CREDS_HINT =
  "该 intent 走 CLI `search`（需 main-search 凭证：xAI 或 OpenAI 兼容 relay），当前未配置。" +
  "请改用 search_web（Exa，通用网页搜索）或 search_aggregate（B站/GitHub/Reddit 社群口碑），" +
  "亦可指定 provider 子命令（如 anysearch-search / context7-library）。"

/** 两条通路皆失败时的可操作 hint（web intent）。 */
const WEB_BOTH_FAILED_HINT =
  "两条通路均失败，可操作建议：改用 search_web（Exa，通用网页搜索）或 search_aggregate" +
  "（B站/GitHub/Reddit 社群口碑），亦可稍后重试。"

// ── 单次子进程结果归类（逾时/启动失败/非零退出/非 JSON → error；否则 parsed） ──

type RunOutcome =
  | { kind: "parsed"; obj: Record<string, unknown>; elapsedMs: number }
  | { kind: "error"; code: string; message: string; elapsedMs: number }

function classifyRunOutcome(run: SmartSearchRunResult, intent: SmartSearchIntent, timeoutMs: number): RunOutcome {
  if (run.timedOut) {
    return {
      kind: "error",
      code: "upstream_timeout",
      message:
        `smart_search ${intent} 超时：已等待 ${run.elapsedMs} ms（上限 ${timeoutMs} ms），已 SIGKILL 终止子进程。` +
        (run.stderr.trim() ? ` stderr 前 ${OUTPUT_EXCERPT_MAX_CHARS} 字：${run.stderr.slice(0, OUTPUT_EXCERPT_MAX_CHARS)}` : ""),
      elapsedMs: run.elapsedMs,
    }
  }
  if (run.spawnError) {
    return {
      kind: "error",
      code: "upstream_exit",
      message: `无法启动 python3（-m ${SMART_SEARCH_CLI_MODULE}）：${run.spawnError}`,
      elapsedMs: run.elapsedMs,
    }
  }

  // 先尝试解析 stdout：smartsearch CLI 对 config_error 会回**非零退出**（实测 exit 3，
  // 见 cli.py `_exit_code`：auth_error/config_error → EXIT_CONFIG_ERROR=3），但仍印出
  // 合法 JSON `{ok:false, error_type:config_error, ...}`。若死板地「非零退出即失败」，
  // web 免 Key 回落永远不会触发。因此非零退出时只要 stdout 是合法 JSON 且 ok:false，
  // 就当作上游 ok:false 交由呼叫端处理（回落/对帐）；否则维持既有 upstream_exit。
  let parsed: unknown
  let parseOk = true
  try {
    parsed = JSON.parse(run.stdout)
  } catch {
    parseOk = false
  }
  const parsedObj = parseOk && parsed && typeof parsed === "object" ? (parsed as Record<string, unknown>) : undefined

  if (run.code !== 0) {
    if (parsedObj && parsedObj.ok === false) {
      return { kind: "parsed", obj: parsedObj, elapsedMs: run.elapsedMs }
    }
    return {
      kind: "error",
      code: "upstream_exit",
      message: `smart_search ${intent} 非零退出（exit ${run.code}）。stderr 前 ${OUTPUT_EXCERPT_MAX_CHARS} 字：${run.stderr.slice(0, OUTPUT_EXCERPT_MAX_CHARS) || "(空)"}`,
      elapsedMs: run.elapsedMs,
    }
  }
  if (!parseOk || !parsedObj) {
    return {
      kind: "error",
      code: "bad_output",
      message: `CLI 输出不是合法 JSON。stdout 前 ${OUTPUT_EXCERPT_MAX_CHARS} 字：${run.stdout.slice(0, OUTPUT_EXCERPT_MAX_CHARS) || "(空)"}`,
      elapsedMs: run.elapsedMs,
    }
  }
  return { kind: "parsed", obj: parsedObj, elapsedMs: run.elapsedMs }
}

/** 把上游 ok:false 物件转成「error_type + 讯息」的一行描述（供两条通路对帐）。 */
function describeUpstreamError(obj: Record<string, unknown>): string {
  const type = asString(obj.error_type) ?? "upstream_error"
  const msg = asString(obj.error) ?? "上游返回 ok:false"
  return `error_type=${type}；${msg}`
}

/**
 * 工具主体（execute 与测试共用）。deps 仅测试注入用，execute 传空物件。
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
  const totalTimeoutMs = deps.timeoutMs ?? resolveTimeoutMs(intent)

  let homeDir: string
  try {
    homeDir = mkdtempSync(join(tmpdir(), "smart-search-"))
    mkdirSync(homeDir, { recursive: true })
  } catch (e) {
    return fail("state_dir_unavailable", `无法建立临时 HOME 目录：${(e as Error)?.message ?? String(e)}`)
  }
  const env = buildChildEnv(deps.envSource ?? process.env, homeDir, deps.pythonPath ?? SMART_SEARCH_PACKAGE_DIR)

  const runOnce = (argv: string[], timeoutMs: number) =>
    runSmartSearchProcess({ argv, timeoutMs, env, pythonBin: deps.pythonBin, cliModule: deps.cliModule })

  // ── 主通路：intent 映射出的子命令（web → `search`） ──
  // 使用者输入一律单一 argv 元素；flag 与值亦分开成阵列元素。
  const firstRun = await runOnce([...subcommand, "--format", "json"], totalTimeoutMs)
  const first = classifyRunOutcome(firstRun, intent, totalTimeoutMs)

  if (first.kind === "error") {
    return fail(first.code, first.message)
  }
  if (first.obj.ok !== false) {
    // 成功路径：既有栏位（title/intent/elapsed_ms/result）不变，仅新增 served_by 标明通路。
    return ok({
      title: "检索完成",
      intent,
      served_by: `smartsearch:${subcommand[0]}`,
      elapsed_ms: first.elapsedMs,
      result: first.obj,
    })
  }

  // ── 主通路 ok:false ──
  // 非 web：维持原行为（单条 fail，hint = 上游原文）。
  if (intent !== "web") {
    return fail(asString(first.obj.error_type) ?? "upstream_error", asString(first.obj.error) ?? "上游返回 ok:false", {
      intent,
      upstream: first.obj,
    })
  }

  // web 免 Key 回落：改跑 vendored smartsearch 自己的 `anysearch-search`（通用网页搜寻）。
  const primaryError = describeUpstreamError(first.obj)
  const remainingMs = totalTimeoutMs - firstRun.elapsedMs
  if (remainingMs < SMART_SEARCH_MIN_FALLBACK_MS) {
    return fail(
      "upstream_timeout",
      `smart_search web：主通路 search 失败后仅剩 ${remainingMs} ms 预算` +
        `（总 ${totalTimeoutMs} ms，回落下限 ${SMART_SEARCH_MIN_FALLBACK_MS} ms），不足以执行免 Key 回落` +
        ` anysearch-search，已如实终止（未静默截断）。主通路错误：${primaryError}`,
      { intent, served_by: "smartsearch:search", upstream: first.obj },
    )
  }

  const secondRun = await runOnce(["anysearch-search", query as string, "--format", "json"], remainingMs)
  const second = classifyRunOutcome(secondRun, intent, remainingMs)

  if (second.kind === "parsed" && second.obj.ok !== false) {
    return ok({
      title: "检索完成（免 Key 回落）",
      intent,
      served_by: "smartsearch:anysearch-search",
      elapsed_ms: firstRun.elapsedMs + secondRun.elapsedMs,
      fallback: { from: "smartsearch:search", reason: primaryError, primary_elapsed_ms: firstRun.elapsedMs },
      result: second.obj,
    })
  }

  const fallbackError = second.kind === "parsed" ? describeUpstreamError(second.obj) : `error_type=${second.code}；${second.message}`
  return fail(
    asString(first.obj.error_type) ?? "upstream_error",
    `两条通路均失败。① smartsearch:search → ${primaryError}；② smartsearch:anysearch-search → ${fallbackError}。` +
      `${WEB_BOTH_FAILED_HINT}${WEB_MISSING_CREDS_HINT}`,
    {
      intent,
      served_by: "smartsearch:anysearch-search",
      fallback_attempted: true,
      attempts: [
        { served_by: "smartsearch:search", error: primaryError },
        { served_by: "smartsearch:anysearch-search", error: fallbackError },
      ],
      upstream: first.obj,
    },
  )
}

export const smartSearchTool: WebToolDef = {
  id: "smart_search",
  description:
    "多来源研究工具（smart_search，smartsearch 免 Key 通路）：**适用「读某一页的全文内容」与「查某个程式库／框架的官方文档」，不是通用网页搜寻。** " +
    "抓取网页、查函式库文档、社群/垂直检索，返回真内容＋真连结。" +
    "**结论必须带 URL 出处，禁止只凭内部知识作答。** " +
    "三种 intent：" +
    "`page`＝抓取「已知 URL」的正文（免 Key，走 Jina/Firecrawl；参数用 url）；" +
    "`docs`＝查函式库/框架/API 文档（免 Key，走 Context7；参数用 query，可选 library_id 指定库，不给则自动选库）；" +
    "`web`＝通用网页搜寻（先走 CLI `search`，需 main-search 凭证；凭证缺失或失败时**自动免 Key 回落**至 vendored `anysearch-search`，回报以 served_by 标明实际通路）。**通用网页搜寻首选是 `search_web`，不是本工具。**" +
    "检索分流：人物／新闻／公司／概念／事实查证／一般资料用 `search_web`（通用网页，预设）；" +
    "B站中文影音／GitHub 开源专案／Reddit 英文社群口碑（必须指名平台）用 `search_aggregate`；" +
    "要某一页的全文内容用本工具的 `page`；要某个程式库／框架的官方文档用本工具的 `docs`。",
  args: {
    intent: {
      type: "string",
      required: true,
      enum: SMART_SEARCH_INTENTS,
      description: "检索类型：web＝通用网页搜索（search 失败时自动免 Key 回落 anysearch-search）；page＝抓取已知 URL 正文（用 url）；docs＝函式库/API 文档（用 query，可带 library_id）。",
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

/** registry 登记用 id（同 web_search/search_aggregate 范式；注册名以档名 smart_search 为准）。 */
export const SMART_SEARCH_HARNESS_TOOL_IDS = ["smart_search"] as const
