/**
 * search_aggregate harness 工具实作（跨平台聚合检索，aggregate-search skill 的工具化）。
 *
 * 零外部依赖：只用 node 内建模组（child_process spawn 传 argv 阵列，禁 shell 拼接）。
 * 呼叫端（tools/search_aggregate.ts）负责 @opencode-ai/plugin 的 import；本档不得引入。
 *
 * 上游：Python 脚本逐档复制自 ~/.agents/skills/aggregate-search/scripts/（未改写），
 * 落位在 lib/aggregate-search/scripts/。脚本内的 BASE_DIR=dirname(dirname(__file__))
 * 假设自己位于 skill root 的 scripts/ 子目录，故保留 scripts/ 子目录层级，
 * 使 `sys.path.insert(BASE_DIR/scripts)`（reddit_miner）与 state 预设路径语义不变。
 *
 * 落位：/opt/eimu-harness/workspace/.opencode/lib/search_aggregate_impl.ts
 * env：子进程只带 PATH/HOME/LANG/LC_ALL（严禁整体 process.env 透传；TAVILY_API_KEY /
 *      EXA_API_KEY 一律不传——本工具不接 tavily）；HOME 与 AGGREGATE_SEARCH_STATE_DIR
 *      指向 os.tmpdir() 下的可写临时目录，确保不会尝试写入唯读的 lib/。
 */

import { spawn } from "node:child_process"
import { fileURLToPath } from "node:url"
import { dirname, join } from "node:path"
import { tmpdir } from "node:os"
import { mkdirSync, mkdtempSync } from "node:fs"

const HERE = dirname(fileURLToPath(import.meta.url))

/** 脚本绝对路径由模组自身位置推导（cwd / repo 相对路径一律不用）。 */
export const AGGREGATE_SEARCH_SCRIPT = join(HERE, "aggregate-search", "scripts", "search.py")

/** 预设平台集（不含 reddit：reddit 单次可达 3 分钟，非必要不加；本工具也不接 tavily）。 */
export const AGGREGATE_DEFAULT_PLATFORMS = "bilibili,github"

/** 每平台预设结果数。 */
export const AGGREGATE_DEFAULT_MAX = 8

/** max 上限（超出静默收敛到帽值）。 */
export const AGGREGATE_MAX_CAP = 20

/** 逾时：不含 reddit。 */
export const AGGREGATE_TIMEOUT_MS = 45_000

/** 逾时：平台集含 reddit（arctic-shift 很慢，实测 176s）。 */
export const AGGREGATE_TIMEOUT_REDDIT_MS = 240_000

/** 错误讯息携带原文的上限。 */
const OUTPUT_EXCERPT_MAX_CHARS = 2000

// ── plumbing（ok/fail 同构 web_search_impl.ts / music-tools.ts） ──────────────

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

// ── 平台集 → 逾时推导 ────────────────────────────────────────────────────────

/**
 * 平台集是否含 reddit（"all"/"all,-xhs" 隐含；"-reddit" 显式排除）。
 * 语义解析而非子字串比对，避免 "all,-reddit" 被误判。
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

/** 逾时推导：含 reddit → 240s；否则 45s。 */
export function resolveTimeoutMs(platforms: string): number {
  return platformsIncludeReddit(platforms) ? AGGREGATE_TIMEOUT_REDDIT_MS : AGGREGATE_TIMEOUT_MS
}

/**
 * 输出内恒在的覆盖范围提示（本轮分流培训的关键设计）：让模型在使用当下就看见
 * 自己查的宇宙有多小，通用网页意图当场被纠正回 search_web。纯加法栏位。
 */
export function aggregateCoverageNotice(platforms: string): string {
  return `本工具只查了 ${platforms}；不涵盖通用网页。人物／新闻／公司／概念类查询请改用 search_web。`
}

// ── 子进程 env 白名单 ────────────────────────────────────────────────────────

/**
 * 只传必要 env：PATH/HOME/LANG/LC_ALL、AGGREGATE_SEARCH_STATE_DIR。
 * 严禁整体 process.env 透传（避免其他密钥外泄给子进程）；TAVILY_API_KEY / EXA_API_KEY
 * 一律不传（本工具不接 tavily，通用网页搜寻走 search_web）。
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

// ── 子进程执行（argv 阵列，禁 shell 拼接） ───────────────────────────────────

export interface AggregateRunResult {
  code: number | null
  stdout: string
  stderr: string
  timedOut: boolean
  spawnError?: string
  elapsedMs: number
}

/**
 * spawn argv 阵列执行脚本。query 等使用者输入一律作为单一 argv 元素传入，
 * never 经过 shell（无注入面）。
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

// ── search_aggregate 工具 ────────────────────────────────────────────────────

export interface AggregateToolDeps {
  /** 测试注入：覆写脚本路径（默认 AGGREGATE_SEARCH_SCRIPT）。 */
  scriptPath?: string
  /** 测试注入：覆写逾时。 */
  timeoutMs?: number
  /** 测试注入：覆写 env 来源（默认 process.env）。 */
  envSource?: NodeJS.ProcessEnv
}

/**
 * 工具主体（execute 与测试共用）。deps 仅测试注入用，execute 传空物件。
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
    // 使用者输入一律单一 argv 元素；flag 与值亦分开成阵列元素。
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

  // 原样透传脚本 JSON：单一平台 ok:false 是设计正确行为，不因此判整体失败。
  // 但「全部平台都 ok:false」要另带 hint，让模型当场看到覆盖范围与替代工具。
  const rawPlatforms = (raw as { platforms?: unknown })?.platforms
  const allPlatformsFailed =
    Array.isArray(rawPlatforms) &&
    rawPlatforms.length > 0 &&
    rawPlatforms.every(
      (p) => typeof p === "object" && p !== null && (p as { ok?: unknown }).ok === false,
    )
  const coverageNotice = aggregateCoverageNotice(platforms)
  return ok({
    title: "搜索完成",
    query,
    platforms_requested: platforms,
    elapsed_ms: run.elapsedMs,
    coverage_notice: coverageNotice,
    ...(allPlatformsFailed
      ? { hint: `${coverageNotice} 本次所有平台均未返回结果，可考虑改用 search_web 做通用网页检索。` }
      : {}),
    raw,
  })
}

export const aggregateSearchTool: WebToolDef = {
  id: "search_aggregate",
  description:
    "平台站内聚合检索（search_aggregate，aggregate-search 免 Key 通路）：一次检索多个**平台站内**内容，返回真标题＋真链接。" +
    "**只涵盖 bilibili / github / reddit 三个平台的站内内容，不涵盖通用网页。**" +
    "**不要用的情况：人物／新闻／公司／概念／一般事实查证 → 改用 search_web（通用网页搜索）。**" +
    "结论必须带 URL 出处，禁止只凭内部知识作答。" +
    "平台与语言纪律（要依查询意图挑平台）：" +
    "bilibili＝B站中文影音内容（用中文关键词）；" +
    "github＝GitHub 开源专案（必须用英文关键词，脚本会硬拦中文）；" +
    "reddit＝Reddit 英文社群口碑/真实使用体验（必须用英文关键词；单次可达 3 分钟，非必要不要加入）。" +
    "多平台时按各平台语言分别给关键词（例：bilibili: 猫粮推荐 + github/reddit: cat food recommendation），" +
    "英文平台用中文关键词会被拒并回错误提示。" +
    "platforms 默认 \"bilibili,github\" **只是预设值，不代表查询涵盖这两个平台**；" +
    "可用逗号清单、\"all\"、\"all,-xhs\" 等（透传给脚本）。" +
    "查某一个网页/一般资料不要用本工具，改用 search_web；抓某一页全文或程式库文档用 smart_search。",
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
        "逗号分隔平台清单。默认 \"bilibili,github\" 只是预设值，不代表查询涵盖这两个平台；要依查询意图挑平台（B站中文影音→bilibili／GitHub 开源专案→github／Reddit 英文社群口碑→reddit）。合法值只有 bilibili/github/reddit；可用 \"all\"（含 reddit）、\"all,-xhs\"。",
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

/** registry 登记用 id（同 web_search 范式；注册名以档名 search_aggregate 为准）。 */
export const AGGREGATE_SEARCH_HARNESS_TOOL_IDS = ["search_aggregate"] as const
