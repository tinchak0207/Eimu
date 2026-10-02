/**
 * search_aggregate harness 工具實作（跨平台聚合檢索，aggregate-search skill 的工具化）。
 *
 * 零外部依賴：只用 node 內建模組（child_process spawn 傳 argv 陣列，禁 shell 拼接）。
 * 呼叫端（tools/search_aggregate.ts）負責 @opencode-ai/plugin 的 import；本檔不得引入。
 *
 * 上游：Python 腳本逐檔複製自 ~/.agents/skills/aggregate-search/scripts/（未改寫），
 * 落位在 lib/aggregate-search/scripts/。腳本內的 BASE_DIR=dirname(dirname(__file__))
 * 假設自己位於 skill root 的 scripts/ 子目錄，故保留 scripts/ 子目錄層級，
 * 使 `sys.path.insert(BASE_DIR/scripts)`（reddit_miner）與 state 預設路徑語義不變。
 *
 * 落位：/opt/agent-harness/workspace/.opencode/lib/search_aggregate_impl.ts
 * env：子進程只帶 PATH/HOME/LANG/LC_ALL（嚴禁整體 process.env 透傳；TAVILY_API_KEY /
 *      EXA_API_KEY 一律不傳——本工具不接 tavily）；HOME 與 AGGREGATE_SEARCH_STATE_DIR
 *      指向 os.tmpdir() 下的可寫臨時目錄，確保不會嘗試寫入唯讀的 lib/。
 */

import { spawn } from "node:child_process"
import { fileURLToPath } from "node:url"
import { dirname, join } from "node:path"
import { tmpdir } from "node:os"
import { mkdirSync, mkdtempSync } from "node:fs"

const HERE = dirname(fileURLToPath(import.meta.url))

/** 腳本絕對路徑由模組自身位置推導（cwd / repo 相對路徑一律不用）。 */
export const AGGREGATE_SEARCH_SCRIPT = join(HERE, "aggregate-search", "scripts", "search.py")

/** 預設平台集（不含 reddit：reddit 單次可達 3 分鐘，非必要不加；本工具也不接 tavily）。 */
export const AGGREGATE_DEFAULT_PLATFORMS = "bilibili,github"

/** 每平台預設結果數。 */
export const AGGREGATE_DEFAULT_MAX = 8

/** max 上限（超出靜默收斂到帽值）。 */
export const AGGREGATE_MAX_CAP = 20

/** 逾時：不含 reddit。 */
export const AGGREGATE_TIMEOUT_MS = 45_000

/** 逾時：平台集含 reddit（arctic-shift 很慢，實測 176s）。 */
export const AGGREGATE_TIMEOUT_REDDIT_MS = 240_000

/** 錯誤訊息攜帶原文的上限。 */
const OUTPUT_EXCERPT_MAX_CHARS = 2000

// ── plumbing（ok/fail 同構 web_search_impl.ts / music-tools.ts） ──────────────

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

// ── 平台集 → 逾時推導 ────────────────────────────────────────────────────────

/**
 * 平台集是否含 reddit（"all"/"all,-xhs" 隱含；"-reddit" 顯式排除）。
 * 語義解析而非子字串比對，避免 "all,-reddit" 被誤判。
 */
export function platformsIncludeReddit(platforms: string): boolean {
  const tokens = platforms
    .split(",")
    .map((t) => t.trim().toLowerCase())
    .filter(Boolean)
  if (tokens.includes("-reddit")) return false
  if (tokens.includes("all")) return true
  return tokens.includes("reddit")
}

/** 逾時推導：含 reddit → 240s；否則 45s。 */
export function resolveTimeoutMs(platforms: string): number {
  return platformsIncludeReddit(platforms) ? AGGREGATE_TIMEOUT_REDDIT_MS : AGGREGATE_TIMEOUT_MS
}

// ── 子進程 env 白名單 ────────────────────────────────────────────────────────

/**
 * 只傳必要 env：PATH/HOME/LANG/LC_ALL、AGGREGATE_SEARCH_STATE_DIR。
 * 嚴禁整體 process.env 透傳（避免其他密鑰外洩給子進程）；TAVILY_API_KEY / EXA_API_KEY
 * 一律不傳（本工具不接 tavily，通用網頁搜尋走 search_web）。
 */
export function buildChildEnv(source: NodeJS.ProcessEnv, homeDir: string): Record<string, string> {
  return {
    PATH: source.PATH ?? "/usr/local/bin:/usr/bin:/bin",
    HOME: homeDir,
    LANG: "C.UTF-8",
    LC_ALL: "C.UTF-8",
    AGGREGATE_SEARCH_STATE_DIR: join(homeDir, "state"),
  }
}

// ── 子進程執行（argv 陣列，禁 shell 拼接） ───────────────────────────────────

export interface AggregateRunResult {
  code: number | null
  stdout: string
  stderr: string
  timedOut: boolean
  spawnError?: string
  elapsedMs: number
}

/**
 * spawn argv 陣列執行腳本。query 等使用者輸入一律作為單一 argv 元素傳入，
 * never 經過 shell（無注入面）。
 */
export function runAggregateProcess(input: {
  scriptPath: string
  argv: string[]
  timeoutMs: number
  env: Record<string, string>
}): Promise<AggregateRunResult> {
  return new Promise((resolve) => {
    const started = Date.now()
    const child = spawn("python3", [input.scriptPath, ...input.argv], {
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

// ── search_aggregate 工具 ────────────────────────────────────────────────────

export interface AggregateToolDeps {
  /** 測試注入：覆寫腳本路徑（默認 AGGREGATE_SEARCH_SCRIPT）。 */
  scriptPath?: string
  /** 測試注入：覆寫逾時。 */
  timeoutMs?: number
  /** 測試注入：覆寫 env 來源（默認 process.env）。 */
  envSource?: NodeJS.ProcessEnv
}

/**
 * 工具主體（execute 與測試共用）。deps 僅測試注入用，execute 傳空物件。
 */
export async function runAggregateTool(
  rawArgs: Record<string, unknown>,
  deps: AggregateToolDeps = {},
): Promise<WebToolResult> {
  const query = asString(rawArgs.query)
  if (!query) {
    return fail("invalid_args", "缺少必填参数 query：需要搜索关键词。")
  }
  const platforms = asString(rawArgs.platforms) ?? AGGREGATE_DEFAULT_PLATFORMS
  let max = AGGREGATE_DEFAULT_MAX
  if (rawArgs.max !== undefined && rawArgs.max !== null) {
    const n = typeof rawArgs.max === "number" ? rawArgs.max : Number(rawArgs.max)
    if (!Number.isFinite(n) || n < 1) {
      return fail("invalid_args", `max 需为 1-20 的数字，收到 "${String(rawArgs.max)}"。`)
    }
    max = Math.min(Math.round(n), AGGREGATE_MAX_CAP)
  }

  const scriptPath = deps.scriptPath ?? AGGREGATE_SEARCH_SCRIPT
  const timeoutMs = deps.timeoutMs ?? resolveTimeoutMs(platforms)

  let homeDir: string
  try {
    homeDir = mkdtempSync(join(tmpdir(), "aggregate-search-"))
    mkdirSync(join(homeDir, "state"), { recursive: true })
  } catch (e) {
    return fail("state_dir_unavailable", `无法建立临时状态目录：${(e as Error)?.message ?? String(e)}`)
  }
  const env = buildChildEnv(deps.envSource ?? process.env, homeDir)

  const run = await runAggregateProcess({
    scriptPath,
    // 使用者輸入一律單一 argv 元素；flag 與值亦分開成陣列元素。
    argv: [query, "--platform", platforms, "--max", String(max), "--json"],
    timeoutMs,
    env,
  })

  if (run.timedOut) {
    return fail(
      "upstream_timeout",
      `聚合检索超时：平台集 "${platforms}" 已等待 ${run.elapsedMs} ms（上限 ${timeoutMs} ms），已 SIGKILL 终止子进程。` +
        (run.stderr.trim() ? ` stderr 前 ${OUTPUT_EXCERPT_MAX_CHARS} 字：${run.stderr.slice(0, OUTPUT_EXCERPT_MAX_CHARS)}` : ""),
    )
  }
  if (run.spawnError) {
    return fail("upstream_exit", `无法启动 python3（${scriptPath}）：${run.spawnError}`)
  }
  if (run.code !== 0) {
    return fail(
      "upstream_exit",
      `聚合检索脚本非零退出（exit ${run.code}）。stderr 前 ${OUTPUT_EXCERPT_MAX_CHARS} 字：${run.stderr.slice(0, OUTPUT_EXCERPT_MAX_CHARS) || "(空)"}`,
    )
  }

  let raw: unknown
  try {
    raw = JSON.parse(run.stdout)
  } catch {
    return fail(
      "bad_output",
      `脚本输出不是合法 JSON。stdout 前 ${OUTPUT_EXCERPT_MAX_CHARS} 字：${run.stdout.slice(0, OUTPUT_EXCERPT_MAX_CHARS) || "(空)"}`,
    )
  }

  // 原樣透傳腳本 JSON：單一平台 ok:false 是設計正確行為，不因此判整體失敗。
  return ok({
    title: "搜索完成",
    query,
    platforms_requested: platforms,
    elapsed_ms: run.elapsedMs,
    raw,
  })
}

export const aggregateSearchTool: WebToolDef = {
  id: "search_aggregate",
  description:
    "跨平台聚合检索（search_aggregate，aggregate-search 免 Key 通路）：一次检索多平台，返回真标题＋真链接。" +
    "结论必须带 URL 出处，禁止只凭内部知识作答。" +
    "platforms 合法值只有 bilibili / github / reddit 三个。平台与语言纪律：" +
    "bilibili＝B站中文内容（用中文关键词）；" +
    "github＝开源专案（必须用英文关键词，脚本会硬拦中文）；" +
    "reddit＝英文社群口碑/真实使用体验（必须用英文关键词；单次可达 3 分钟，非必要不要加入）。" +
    "多平台时按各平台语言分别给关键词（例：bilibili: 猫粮推荐 + github/reddit: cat food recommendation），" +
    "英文平台用中文关键词会被拒并回错误提示。platforms 默认 \"bilibili,github\"；" +
    "可用逗号清单、\"all\"、\"all,-xhs\" 等（透传给脚本）。" +
    "通用网页搜索不要用本工具，改用 search_web。",
  args: {
    query: {
      type: "string",
      required: true,
      description:
        "搜索查询词。多平台时按目标平台语言分别给词：中文平台（bilibili）用中文，英文平台（github/reddit）用英文。",
    },
    platforms: {
      type: "string",
      required: false,
      description:
        "逗号分隔平台清单，默认 \"bilibili,github\"（不含 reddit）。合法值只有 bilibili/github/reddit；可用 \"all\"（含 reddit）、\"all,-xhs\"。",
    },
    max: {
      type: "number",
      required: false,
      description: "每平台返回条数，1-20，默认 8。",
    },
  },
  async execute(rawArgs) {
    return runAggregateTool(rawArgs, {})
  },
}

/** registry 登記用 id（同 web_search 範式；註冊名以檔名 search_aggregate 為準）。 */
export const AGGREGATE_SEARCH_HARNESS_TOOL_IDS = ["search_aggregate"] as const
