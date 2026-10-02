// context-slim plugin（2026-10-02）：上下文經濟第二層——microCompact（T1-3）＋工具結果預算安全網（T1-4）。
//
// 為什麼需要（與 eimu-guard 的 D6 分工）：
//   - 原生 truncate 只保證「單次呼叫」≤ ~51KB，且只覆蓋走原生截斷路徑的工具；跨輪殘留、
//     MCP／自訂工具不回報長度（見 opencode tool_output config 與 compaction.prune）。
//   - eimu-guard 的 D6 只在 tool.execute.after（單次輸出落盤前）截斷，且只覆蓋白名單工具。
//   本 plugin 在**送上游前的最後一關**（experimental.chat.messages.transform）做兩件事：
//     A) microCompact：距最後一則 user 訊息 > 1 小時（對齊上游 prompt cache TTL）時，
//        把較舊的已完成工具結果就地換成 [Old tool result content cleared]，保留最近 N 筆。
//        概念取自 Claude Code microCompact（只取概念，未複製其程式碼）。
//     B) 工具結果安全網：單筆 > 50,000 字元或單訊息聚合 > 200,000 字元時，完整內容落盤到
//        workspace 內 outputs/tool-results/<content-hash>.txt，訊息換成 <persisted-output> ＋
//        前後預覽（換行邊界切）。已被原生截斷（含 "Full output saved to:"）者放行，不二次落盤。
//
// 純記憶體改寫：不動 DB、不發任何上游請求（零 API 成本）。任何錯誤都 try/catch 原樣放行。
//
// hook 形狀（@opencode-ai/plugin 1.17.1 型別、1.18.14 執行）：
//   "experimental.chat.messages.transform"?: (input: {}, output: { messages: { info: Message; parts: Part[] }[] }) => Promise<void>
//   主聊天路徑 trigger(..., {}, { messages: C }) 後緊接 toModelMessagesEffect(C, ...)，就地改寫即影響送上游內容。

import type { Plugin } from "@opencode-ai/plugin"
import { createHash } from "node:crypto"
import { mkdir, writeFile } from "node:fs/promises"
import path from "node:path"
import { WORKSPACE } from "../lib/sandbox"

// ── 常數（可用 env 覆寫；預設為待調參數）────────────────────────────────────

/** 清除後的就地標記（與原生 compaction.prune 同字串，方便辨識與冪等）。 */
export const CLEARED_MARKER = "[Old tool result content cleared]"

function intEnv(name: string, dflt: number): number {
  const n = Number.parseInt(process.env[name] ?? "", 10)
  return Number.isFinite(n) && n > 0 ? n : dflt
}

/** 開關：CONTEXT_SLIM=0 可整支停用。 */
export const CONTEXT_SLIM_ENABLED = process.env.CONTEXT_SLIM !== "0"

/** A：距最後一則 user 訊息超過此毫秒數＝上游 prompt cache 必已過期。預設 60 分鐘。 */
export const MICROCOMPACT_IDLE_MS = intEnv("MICROCOMPACT_IDLE_MINUTES", 60) * 60_000
/** A：保留最近幾筆可壓縮的工具結果（下限 1）。 */
export const MICROCOMPACT_KEEP = Math.max(1, intEnv("MICROCOMPACT_KEEP", 5))
/** A：豁免的工具名（skill 類等），逗號分隔。預設 skill。 */
export const MICROCOMPACT_EXEMPT_TOOLS: ReadonlySet<string> = new Set(
  (process.env.MICROCOMPACT_EXEMPT_TOOLS ?? "skill")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean),
)

/** B：單筆工具結果字元上限。 */
export const TOOL_RESULT_MAX_CHARS = intEnv("TOOL_RESULT_MAX_CHARS", 50_000)
/** B：單訊息（同一 assistant message 內所有工具結果）聚合字元上限。 */
export const TOOL_RESULT_BUDGET_PER_MESSAGE_CHARS = intEnv("TOOL_RESULT_BUDGET_PER_MESSAGE_CHARS", 200_000)
/** B：落盤根目錄（agent 可讀的 workspace 內）。 */
export const TOOL_RESULT_PERSIST_DIR =
  process.env.TOOL_RESULT_PERSIST_DIR || path.join(WORKSPACE, "outputs", "tool-results")
/** B：前後預覽字元數。 */
const PREVIEW_HEAD_CHARS = intEnv("TOOL_RESULT_PREVIEW_HEAD_CHARS", 2_000)
const PREVIEW_TAIL_CHARS = intEnv("TOOL_RESULT_PREVIEW_TAIL_CHARS", 1_000)

/** 原生截斷參考句（opencode tool_output 超限時寫入訊息的字串）。 */
const NATIVE_TRUNCATED_RE = /Full output saved to:/
/** 本安全網自己寫入的參考。 */
const PERSISTED_RE = /<persisted-output\b/

// ── 型別（寬鬆定義：現場可能是 SDK 型別或內部結構，只碰必要欄位）─────────────

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

/** 在換行邊界切頭（含切點那個換行）。 */
export function cutAtNewlineHead(s: string, n: number): string {
  if (s.length <= n) return s
  const i = s.lastIndexOf("\n", n)
  return s.slice(0, i === -1 ? n : i + 1)
}
/** 在換行邊界切尾（從切點後第一個換行開始）。 */
export function cutAtNewlineTail(s: string, n: number): string {
  if (s.length <= n) return s
  const start = s.length - n
  const i = s.indexOf("\n", start)
  return s.slice(i === -1 ? start : i + 1)
}

/** 內容定址檔名（冪等：同內容同檔）。 */
function contentFileName(content: string): string {
  return `tool-${createHash("sha256").update(content, "utf8").digest("hex").slice(0, 16)}.txt`
}

interface SlimResult {
  cleared: number
  persisted: number
  paths: string[]
}

/**
 * 就地改寫 messages（供 hook 呼叫，也可直接單測）。
 * 失敗不拋：內部已逐段 try/catch，最壞情況維持原樣。
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

  if (!Array.isArray(messages)) return result

  // ── B：工具結果預算安全網（先做，避免超大字串進入後續處理）──────────────
  try {
    for (const msg of messages) {
      if (!msg || !Array.isArray(msg.parts)) continue
      let running = 0
      for (const part of msg.parts) {
        if (!part || part.type !== "tool") continue
        const st = part.state
        if (!st || st.status !== "completed" || typeof st.output !== "string") continue
        const out = st.output

        // 已清除／已是參考句：放行，不二次處理；但仍計入預算（避免合成誤判）。
        if (out === CLEARED_MARKER || out.includes(CLEARED_MARKER)) {
          running += out.length
          continue
        }
        // 原生已截斷：安全網放行（不二次落盤）。
        if (NATIVE_TRUNCATED_RE.test(out) || PERSISTED_RE.test(out)) {
          running += out.length
          continue
        }

        const overSingle = out.length > toolResultMax
        const overBudget = !overSingle && running + out.length > perMessageBudget
        // 落盤本身要能縮小訊息才有意義：比預覽還小的內容不落盤（否則越處理越大）。
        const worthPersisting = out.length > PREVIEW_HEAD_CHARS + PREVIEW_TAIL_CHARS + 512
        if (!((overSingle || overBudget) && worthPersisting)) {
          running += out.length
          continue
        }

        const replacement = await persistAndPreview(out, persistDir, toolResultMax)
        if (replacement === null) {
          // 落盤失敗：放棄該筆改寫，原樣放行（不中斷會話）。
          running += out.length
          continue
        }
        st.output = replacement
        running += replacement.length
        result.persisted++
      }
    }
  } catch {
    /* 安全網失敗：原樣放行 */
  }

  // ── A：microCompact（僅在距最後一則 user 訊息 > idleMs 時觸發）────────────
  try {
    if (opts.microCompact !== false) {
      let lastUserCreated = -Infinity
      for (const msg of messages) {
        const role = msg?.info?.role
        const t = msg?.info?.time?.created
        if (role === "user" && typeof t === "number") lastUserCreated = Math.max(lastUserCreated, t)
      }
      if (Number.isFinite(lastUserCreated) && now - lastUserCreated > idleMs) {
        // 依訊息順序收集「可壓縮」的已完成工具結果。
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
            if (out.includes(CLEARED_MARKER)) continue // 冪等：已清除的再計數
            eligible.push({ st })
          }
        }
        // 保留最近 keep 筆，其餘清成標記（就地）。
        const toClear = eligible.length - keep
        for (let i = 0; i < toClear; i++) {
          eligible[i].st.output = CLEARED_MARKER
          result.cleared++
        }
      }
    }
  } catch {
    /* microCompact 失敗：原樣放行 */
  }

  return result
}

/** 落盤並回傳 <persisted-output> 參考句；失敗回 null。 */
async function persistAndPreview(content: string, persistDir: string, maxChars: number): Promise<string | null> {
  try {
    const file = path.join(persistDir, contentFileName(content))
    await mkdir(persistDir, { recursive: true })
    // 同 hash 已存在時覆寫為相同內容＝仍冪等（內容定址）。
    await writeFile(file, content, "utf8")
    const head = cutAtNewlineHead(content, PREVIEW_HEAD_CHARS)
    const tail = cutAtNewlineTail(content, PREVIEW_TAIL_CHARS)
    const omitted = content.length - head.length - tail.length
    const ref =
      `<persisted-output path="${file}" total-chars="${content.length}" omitted-chars="${omitted}">\n` +
      `${head}\n...[中略 ${omitted} 字元，完整內容見上述 path]...\n${tail}\n` +
      `</persisted-output>`
    // 保險：參考句本身必須遠小於上限，否則退回極簡式。
    return ref.length < maxChars ? ref : `<persisted-output path="${file}" total-chars="${content.length}"/>\n`
  } catch {
    return null
  }
}

// ── Plugin ──────────────────────────────────────────────────────────────────

export const ContextSlim: Plugin = async () => {
  return {
    "experimental.chat.messages.transform": async (_input, output) => {
      if (!CONTEXT_SLIM_ENABLED) return
      try {
        const messages = (output as { messages?: MsgLike[] } | undefined)?.messages
        if (!Array.isArray(messages) || messages.length === 0) return
        await slimMessages(messages)
      } catch {
        /* 一律放行 */
      }
    },
  }
}
