// context-slim 核心逻辑（2026-10-02）：microCompact（T1-3）＋工具结果预算安全网（T1-4）。
//
// 为什么独立成 lib/（2026-10-02 生产事故）：
//   opencode 的 plugin loader 逐个 export 检查，遇到非函式 export 即整档载入失败
//   （`Plugin export is not a function`）。此前常数与函式都挂在 plugin/context-slim.ts，
//   导致该 plugin 在生产**根本没被载入**（microCompact 与安全网全是死的）。
//   把非 plugin 的常数／函式搬到 lib/（不会被当 plugin 自动载入），plugin 档只留一个
//   `export const ContextSlim: Plugin`。
//
// 为什么需要（与 eimu-guard 的 D6 分工）：
//   - 原生 truncate 只保证「单次呼叫」≤ ~51KB，且只覆盖走原生截断路径的工具；跨轮残留、
//     MCP／自订工具不回报长度（见 opencode tool_output config 与 compaction.prune）。
//   - eimu-guard 的 D6 只在 tool.execute.after（单次输出落盘前）截断，且只覆盖白名单工具。
//   本核心供 plugin 在**送上游前的最后一关**（experimental.chat.messages.transform）做两件事：
//     A) microCompact：距最后一则 user 讯息 > 1 小时（对齐上游 prompt cache TTL）时，
//        把较旧的已完成工具结果就地换成 [Old tool result content cleared]，保留最近 N 笔。
//        概念取自 Claude Code microCompact（只取概念，未复制其程式码）。
//     B) 工具结果安全网：单笔 > 50,000 字元或单讯息聚合 > 200,000 字元时，完整内容落盘到
//        workspace 内 outputs/tool-results/<content-hash>.txt，讯息换成 <persisted-output> ＋
//        前后预览（换行边界切）。已被原生截断（含 "Full output saved to:"）者放行，不二次落盘。
//
// 纯记忆体改写：不动 DB、不发任何上游请求（零 API 成本）。任何错误都 try/catch 原样放行。

import { createHash } from "node:crypto"
import { constants as fsConstants, existsSync, realpathSync } from "node:fs"
import { mkdir, open } from "node:fs/promises"
import path from "node:path"
import { WORKSPACE } from "./sandbox"

// ── 常数（可用 env 覆写；预设为待调参数）────────────────────────────────────

/** 清除后的就地标记（与原生 compaction.prune 同字串，方便辨识与幂等）。 */
export const CLEARED_MARKER = "[Old tool result content cleared]"

function intEnv(name: string, dflt: number): number {
  const n = Number.parseInt(process.env[name] ?? "", 10)
  return Number.isFinite(n) && n > 0 ? n : dflt
}

/** 开关：CONTEXT_SLIM=0 可整支停用。 */
export const CONTEXT_SLIM_ENABLED = process.env.CONTEXT_SLIM !== "0"

/** A：距最后一则 user 讯息超过此毫秒数＝上游 prompt cache 必已过期。预设 60 分钟。 */
export const MICROCOMPACT_IDLE_MS = intEnv("MICROCOMPACT_IDLE_MINUTES", 60) * 60_000
/** A：保留最近几笔可压缩的工具结果（下限 1）。 */
export const MICROCOMPACT_KEEP = Math.max(1, intEnv("MICROCOMPACT_KEEP", 5))
/** A：豁免的工具名（skill 类等），逗号分隔。预设 skill。 */
export const MICROCOMPACT_EXEMPT_TOOLS: ReadonlySet<string> = new Set(
  (process.env.MICROCOMPACT_EXEMPT_TOOLS ?? "skill")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean),
)

/** B：单笔工具结果字元上限。 */
export const TOOL_RESULT_MAX_CHARS = intEnv("TOOL_RESULT_MAX_CHARS", 50_000)
/** B：单讯息（同一 assistant message 内所有工具结果）聚合字元上限。 */
export const TOOL_RESULT_BUDGET_PER_MESSAGE_CHARS = intEnv("TOOL_RESULT_BUDGET_PER_MESSAGE_CHARS", 200_000)
/** B：落盘根目录（agent 可读的 workspace 内）。 */
export const TOOL_RESULT_PERSIST_DIR =
  process.env.TOOL_RESULT_PERSIST_DIR || path.join(WORKSPACE, "outputs", "tool-results")
/** B：前后预览字元数。 */
const PREVIEW_HEAD_CHARS = intEnv("TOOL_RESULT_PREVIEW_HEAD_CHARS", 2_000)
const PREVIEW_TAIL_CHARS = intEnv("TOOL_RESULT_PREVIEW_TAIL_CHARS", 1_000)

/** 原生截断参考句（opencode tool_output 超限时写入讯息的字串）。 */
const NATIVE_TRUNCATED_RE = /Full output saved to:/
/** 从原生参考句取回落盘路径（"Full output saved to: <path>"，到此行为止的第一个非空白字串）。 */
const NATIVE_PATH_RE = /Full output saved to:\s*([^\s"'<>]+)/
/** 完整多行参考句：整串必须恰好是一个多行 `<persisted-output>…</persisted-output>` 区块（锚定＋单一化）。 */
const PERSISTED_REF_FULL_RE =
  /^\s*<persisted-output\s+path="([^"]+)"\s+total-chars="(\d+)"[^>]*>[\s\S]*<\/persisted-output>\s*$/
/** 极简退路式参考句：整串恰好是一个自闭合 `<persisted-output …/>`。 */
const PERSISTED_REF_SELF_RE =
  /^\s*<persisted-output\s+path="([^"]+)"\s+total-chars="(\d+)"[^>]*\/>\s*$/
/** 本档内容定址档名格式（`tool-<sha256 前 16 hex>.txt`）。 */
const PERSISTED_FILE_NAME_RE = /^tool-[0-9a-f]{16}\.txt$/

/** 解析整串是否为**单一**自有参考句；是则回传其 path，否则 null。 */
function parseOwnPersistedRef(out: string): string | null {
  const full = PERSISTED_REF_FULL_RE.exec(out)
  if (full) return full[1]
  const self = PERSISTED_REF_SELF_RE.exec(out)
  if (self) return self[1]
  return null
}

/** 以 realpath 解析一个稳定根（解析失败则退回绝对化），不依赖单次呼叫的 persistDir。 */
function resolveRoot(base: string): string {
  try {
    return realpathSync(base)
  } catch {
    return path.resolve(base)
  }
}

/** real 是否落在 root 子树之下（不含 root 自身）。 */
function isUnder(real: string, root: string): boolean {
  const rel = path.relative(root, real)
  return rel !== "" && !rel.startsWith("..") && !path.isAbsolute(rel)
}

/**
 * 判定「这是不是本安全网自己写的 <persisted-output> 参考句」。
 * 旧版只做子字串比对（/<persisted-output\b/），导致**任何提及**该字面的输出（被 cat 的
 * 本档原始码、旧 log、工具回传）永久免落盘与免压缩 ⇒ context 膨胀且可被内容伪造。
 * 收窄为结构化判定（H2/H3），必须同时满足：
 *   ① 形状符合本档模板，且**整串就是这一个区块**（锚定＋单一化）：头／中／尾缀注入，
 *      或「合法前缀＋任意尾随内容」的一律不算；
 *   ② 档名是内容定址格式，路径为绝对路径且无 `..` 跳脱；
 *   ③ 档案真实存在（挡孤儿／幻影指针），且其 realpath 落在稳定根（本次 persistDir、
 *      预设 persistDir、WORKSPACE）之下；或落在稳定的内容定址目录结构
 *      `…/outputs/tool-results/tool-<hash>.txt` 之下（目录搬迁但结构保留时仍认，H3）。
 */
function isOwnPersistedRef(out: string, persistDir: string): boolean {
  const refPath = parseOwnPersistedRef(out)
  if (refPath === null) return false
  if (!path.isAbsolute(refPath)) return false
  if (refPath.split(/[\\/]/).includes("..")) return false
  if (!PERSISTED_FILE_NAME_RE.test(path.basename(refPath))) return false
  let real: string
  try {
    if (!existsSync(refPath)) return false
    real = realpathSync(refPath)
  } catch {
    return false
  }
  for (const root of [persistDir, TOOL_RESULT_PERSIST_DIR, WORKSPACE]) {
    if (root && isUnder(real, resolveRoot(root))) return true
  }
  // 稳定结构退路：任意根下的 `outputs/tool-results/tool-<hash>.txt`（H3）。
  return path.basename(path.dirname(real)) === "tool-results" && PERSISTED_FILE_NAME_RE.test(path.basename(real))
}

/**
 * 原生截断参考句（H4）：`Full output saved to: <path>` 且该档真实存在才算「带真实落盘路径的
 * 参考句」。任何这类参考句都不得被 microCompact 清除（清掉＝模型失去唯一取回路）。
 */
function isNativeTruncatedRef(out: string): boolean {
  const m = NATIVE_PATH_RE.exec(out)
  if (!m) return false
  const p = m[1]
  if (!path.isAbsolute(p)) return false
  try {
    return existsSync(p) && !!realpathSync(p)
  } catch {
    return false
  }
}

// ── 型别（宽松定义：现场可能是 SDK 型别或内部结构，只碰必要栏位）─────────────

interface MsgLike {
  info?: { role?: string; time?: { created?: number } }
  parts?: PartLike[]
}
interface PartLike {
  type?: string
  tool?: string
  state?: {
    status?: string
    output?: unknown
  }
}

/** 在换行边界切头（含切点那个换行）。 */
export function cutAtNewlineHead(s: string, n: number): string {
  if (s.length <= n) return s
  const i = s.lastIndexOf("\n", n)
  return s.slice(0, i === -1 ? n : i + 1)
}
/** 在换行边界切尾（从切点后第一个换行开始）。 */
export function cutAtNewlineTail(s: string, n: number): string {
  if (s.length <= n) return s
  const start = s.length - n
  const i = s.indexOf("\n", start)
  return s.slice(i === -1 ? start : i + 1)
}

/** 内容定址档名（幂等：同内容同档）。 */
function contentFileName(content: string): string {
  return `tool-${createHash("sha256").update(content, "utf8").digest("hex").slice(0, 16)}.txt`
}

interface SlimResult {
  cleared: number
  persisted: number
  paths: string[]
}

/**
 * 就地改写 messages（供 hook 呼叫，也可直接单测）。
 * 失败不抛：内部已逐段 try/catch，最坏情况维持原样。
 */
export async function slimMessages(
  messages: MsgLike[],
  opts: {
    now?: number
    persistDir?: string
    microCompact?: boolean
    toolResultMax?: number
    perMessageBudget?: number
    idleMs?: number
    keep?: number
    exemptTools?: ReadonlySet<string>
  } = {},
): Promise<SlimResult> {
  const now = opts.now ?? Date.now()
  const persistDir = opts.persistDir ?? TOOL_RESULT_PERSIST_DIR
  const toolResultMax = opts.toolResultMax ?? TOOL_RESULT_MAX_CHARS
  const perMessageBudget = opts.perMessageBudget ?? TOOL_RESULT_BUDGET_PER_MESSAGE_CHARS
  const idleMs = opts.idleMs ?? MICROCOMPACT_IDLE_MS
  const keep = Math.max(1, opts.keep ?? MICROCOMPACT_KEEP)
  const exempt = opts.exemptTools ?? MICROCOMPACT_EXEMPT_TOOLS
  const result: SlimResult = { cleared: 0, persisted: 0, paths: [] }
  // 本轮被安全网改写过的 state：microCompact 同轮不得再清除（同轮自杀不可接受）。
  const persistedThisRound = new Set<object>()
  // 本轮尝试落盘但失败的 state（H5）：该笔既无档可回，同轮就不得再被 microCompact 清掉。
  const failedPersist = new Set<object>()

  if (!Array.isArray(messages)) return result

  // ── B：工具结果预算安全网（先做，避免超大字串进入后续处理）──────────────
  try {
    for (const msg of messages) {
      if (!msg || !Array.isArray(msg.parts)) continue
      let running = 0
      for (const part of msg.parts) {
        if (!part || part.type !== "tool") continue
        const st = part.state
        if (!st || st.status !== "completed" || typeof st.output !== "string") continue
        const out = st.output

        // 已清除：放行，不二次处理；但仍计入预算（避免合成误判）。
        // 判定必须「整串等于」标记：用 includes 会让任何「提及」标记的输出（被 cat 的原始码／旧 log）
        // 永久免落盘，与 <persisted-output> 的子字串误判同病。
        if (out === CLEARED_MARKER) {
          running += out.length
          continue
        }
        // 原生已截断：安全网放行（不二次落盘）。
        if (NATIVE_TRUNCATED_RE.test(out) || isOwnPersistedRef(out, persistDir)) {
          running += out.length
          continue
        }

        const overSingle = out.length > toolResultMax
        const overBudget = !overSingle && running + out.length > perMessageBudget
        // 落盘本身要能缩小讯息才有意义：比预览还小的内容不落盘（否则越处理越大）。
        const worthPersisting = out.length > PREVIEW_HEAD_CHARS + PREVIEW_TAIL_CHARS + 512
        if (!((overSingle || overBudget) && worthPersisting)) {
          running += out.length
          continue
        }

        const replacement = await persistAndPreview(out, persistDir, toolResultMax)
        if (replacement === null) {
          // 落盘失败：放弃该笔改写，原样放行（不中断会话）。
          // H5：记住该笔曾 attempt 落盘失败，microCompact 同轮不得清除（否则无档可回、静默遗失）。
          failedPersist.add(st)
          running += out.length
          continue
        }
        st.output = replacement.ref
        running += replacement.ref.length
        result.persisted++
        result.paths.push(replacement.path)
        persistedThisRound.add(st)
      }
    }
  } catch {
    /* 安全网失败：原样放行 */
  }

  // ── A：microCompact（仅在距最后一则 user 讯息 > idleMs 时触发）────────────
  try {
    if (opts.microCompact !== false) {
      let lastUserCreated = -Infinity
      for (const msg of messages) {
        const role = msg?.info?.role
        const t = msg?.info?.time?.created
        if (role === "user" && typeof t === "number") lastUserCreated = Math.max(lastUserCreated, t)
      }
      if (Number.isFinite(lastUserCreated) && now - lastUserCreated > idleMs) {
        // 依讯息顺序收集「可压缩」的已完成工具结果。
        const eligible: Array<{ st: NonNullable<PartLike["state"]> }> = []
        for (const msg of messages) {
          if (!msg || !Array.isArray(msg.parts)) continue
          for (const part of msg.parts) {
            if (!part || part.type !== "tool") continue
            const st = part.state
            if (!st || st.status !== "completed" || typeof st.output !== "string") continue
            const toolName = part.tool ?? ""
            if (exempt.has(toolName)) continue
            const out = st.output
            if (out.length === 0) continue
            if (out === CLEARED_MARKER) continue // 幂等：整串等于标记的已清除项不再计数（includes 会被「提及」伪造）
            // 参考句是模型取回完整内容的唯一路径指针，清除即永久断链 ⇒ 不纳入可压缩集（与安全网放行对称）。
            // ① 自产 <persisted-output> 指针（H2 判定）；
            // ② 原生 `Full output saved to: <path>` 且该档真实存在（H4）；
            // ③ 本轮 attempt 落盘但失败者（H5：无档可回，宁可留着也不断链）；
            // ④ 本轮刚由安全网落盘者，同轮不得再清除。
            if (isOwnPersistedRef(out, persistDir)) continue
            if (isNativeTruncatedRef(out)) continue
            if (failedPersist.has(st)) continue
            if (persistedThisRound.has(st)) continue
            eligible.push({ st })
          }
        }
        // 保留最近 keep 笔，其余清成标记（就地）。
        const toClear = eligible.length - keep
        for (let i = 0; i < toClear; i++) {
          eligible[i].st.output = CLEARED_MARKER
          result.cleared++
        }
      }
    }
  } catch {
    /* microCompact 失败：原样放行 */
  }

  return result
}

/** 落盘并回传 <persisted-output> 参考句与实际档路径；失败回 null。 */
async function persistAndPreview(
  content: string,
  persistDir: string,
  maxChars: number,
): Promise<{ ref: string; path: string } | null> {
  try {
    await mkdir(persistDir, { recursive: true })
    // 规范化落盘目录：解析 symlink，后续一律在真实目录内操作（父目录逃逸防护）。
    let realDir: string
    try {
      realDir = realpathSync(persistDir)
    } catch {
      realDir = path.resolve(persistDir)
    }
    const file = path.join(realDir, contentFileName(content))
    // H1：档名由内容 hash 决定，攻击者可在目录内预植同名 symlink，让 writeFile 跟随写穿到
    // persistDir 之外（任意档覆写）。一律以 O_NOFOLLOW 打开最终档（不跟随 symlink）；
    // 命中 symlink 即抛 ELOOP → 落盘失败 fail-open，目标档不被触碰。
    // 同 hash 已存在（且为普通档）时覆写为相同内容＝仍幂等（内容定址）。
    const fh = await open(
      file,
      fsConstants.O_WRONLY | fsConstants.O_CREAT | fsConstants.O_TRUNC | fsConstants.O_NOFOLLOW,
      0o600,
    )
    try {
      await fh.writeFile(content, "utf8")
    } finally {
      await fh.close()
    }
    const head = cutAtNewlineHead(content, PREVIEW_HEAD_CHARS)
    const tail = cutAtNewlineTail(content, PREVIEW_TAIL_CHARS)
    const omitted = content.length - head.length - tail.length
    const ref =
      `<persisted-output path="${file}" total-chars="${content.length}" omitted-chars="${omitted}">\n` +
      `${head}\n...[中略 ${omitted} 字元，完整内容见上述 path]...\n${tail}\n` +
      `</persisted-output>`
    // 保险：参考句本身必须远小于上限，否则退回极简式。
    const chosen = ref.length < maxChars ? ref : `<persisted-output path="${file}" total-chars="${content.length}"/>\n`
    return { ref: chosen, path: file }
  } catch {
    return null
  }
}
