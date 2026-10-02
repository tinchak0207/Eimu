// Eimu 守衛 plugin（2026-09-29 審計＋紅隊二輪修復；2026-10-02 加 D1/D6）。opencode 自動載入 .opencode/plugin/*.ts。
//
// 全部是確定性代碼（不靠 prompt 自律）：
//   1. bash / run_py 一律進 bwrap 沙箱（lib/sandbox.ts）：無密鑰、斷網、看不到別租戶；不可用即 fail-closed。
//   2. 讀寫類原生工具（read/write/edit/multiedit/list/glob/grep/patch/apply_patch）路徑白名單閘。
//   3. fetch 類工具（read_image/vision_analyze/video_fetch/任何帶 url 參數者）SSRF 前置閘（擋 loopback/內網/metadata）。
//   4. task 工具停用：子代理只能經 subagent_dispatch（網關路由/隔離/憲法在那條路上）。
//   5. 上傳歸屬由 gateway 可信查得（非「用戶提到即授權」）。
//   6. 工具輸出進上下文前：遮罩秘密、剔除他租戶 uploads 路徑。
//   7. 壓縮用創作向摘要模板。
//   8. D1（2026-10-02）重複呼叫斷路器：同一 session 連續同工具同參數 → 第 N 次起可執行錯誤、
//      第 N+5 次起強制結束本輪。**輪詢類工具豁免**（使用者裁定：保留輪詢，見 ARCH-V4-DESIGN D3）。
//   9. D6（2026-10-02）上下文經濟：bash/read/grep 等輸出硬上限；同 session 重讀未變更檔案回摘要。

import type { Plugin } from "@opencode-ai/plugin"
import { mkdir, stat } from "node:fs/promises"
import {
  WORKSPACE,
  assertSafeFetchUrl,
  checkAgentPath,
  collectUrlArgs,
  filterForeignUploads,
  hasOwner,
  redactSecrets,
  stripForgedAuthorityTokens,
  sandboxAvailable,
  sessionRunDir,
  sessionTmpDir,
  setOwner,
  SsrfError,
  wrapShellCommand,
} from "../lib/sandbox"

const GATEWAY = process.env.GATEWAY_URL || "http://127.0.0.1:8081"

// ── D1（2026-10-02）：工具層重複呼叫斷路器 ──────────────────────────────────
// 證據：同 session 同工具同參數重複 3,525 次／135 session，最惡 `bash true` ×1110、
// `bash date` ×371、空 `bash {}` ×59（自家遙測；機制類別有文獻：MAST FM-1.3/FM-1.5、
// AutoGen termination、LangGraph recursion_limit；**N/N+5 無文獻依據**，屬待調參數）。
// 判定用「連續」重複（上一次呼叫同一簽名才累加，中間有別的工具呼叫即歸零）——總量計數
// 會在長會話把正常週期性呼叫誤殺；連續計數精準命中空轉迴圈。
// **輪詢豁免**：subagent_status/workflow_status/image_get_result 等輪詢工具不進斷路器
// （2026-10-02 使用者裁定：廢除輪詢是錯的，保留輪詢）。
const LOOP_BREAKER_ON = process.env.LOOP_BREAKER !== "0"
const LOOP_BREAKER_N = intEnv("LOOP_BREAKER_N", 3)
const LOOP_BREAKER_HARD = LOOP_BREAKER_N + intEnv("LOOP_BREAKER_HARD_DELTA", 5)
const LOOP_BREAKER_EXEMPT: ReadonlySet<string> = new Set(
  (process.env.LOOP_BREAKER_EXEMPT ?? "subagent_status,workflow_status,image_get_result,subagent_stop,video_result_fetch")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean),
)

// ── D6（2026-10-02）：上下文經濟 ────────────────────────────────────────────
// 證據：input:output = 24.3:1、cache_read 803.9M、compaction 96 次／35 session。
// 文獻支持 truncation 屬工程指引（Anthropic writing-tools-for-agents；Claude Code 預設
// 工具回應上限 25,000 tokens），具體 8KB 為自家待調參數。
const TOOL_OUTPUT_MAX_CHARS = intEnv("TOOL_OUTPUT_MAX_CHARS", 8192)
const OUTPUT_CAPPED_TOOLS: ReadonlySet<string> = new Set(
  (process.env.TOOL_OUTPUT_CAPPED ?? "bash,read,grep,glob,list,run_py")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean),
)
const READ_DEDUPE_ON = process.env.READ_DEDUPE !== "0"

function intEnv(name: string, dflt: number): number {
  const n = Number.parseInt(process.env[name] ?? "", 10)
  return Number.isFinite(n) && n > 0 ? n : dflt
}

/** 決定性簽名用：排序物件鍵的穩定序列化（避免鍵序不同被當成不同呼叫）。 */
function stableStringify(v: unknown): string {
  if (v === null || typeof v !== "object") return JSON.stringify(v) ?? "null"
  if (Array.isArray(v)) return `[${v.map(stableStringify).join(",")}]`
  const o = v as Record<string, unknown>
  return `{${Object.keys(o)
    .sort()
    .map((k) => `${JSON.stringify(k)}:${stableStringify(o[k])}`)
    .join(",")}}`
}

function boundMap<K, V>(map: Map<K, V>, max: number): void {
  if (map.size <= max) return
  const oldest = map.keys().next().value
  if (oldest !== undefined) map.delete(oldest)
}

const PATH_TOOLS: Record<string, { keys: string[]; listing: boolean }> = {
  read: { keys: ["filePath"], listing: false },
  write: { keys: ["filePath"], listing: false },
  edit: { keys: ["filePath"], listing: false },
  multiedit: { keys: ["filePath"], listing: false },
  patch: { keys: ["filePath"], listing: false },
  list: { keys: ["path"], listing: true },
  glob: { keys: ["path"], listing: true },
  grep: { keys: ["path"], listing: true },
  lsp: { keys: ["filePath"], listing: false },
}

const DENY_MESSAGE: Record<string, string> = {
  outside_workspace: "只能访问创作工作区（workspace）内的文件。",
  internal_state: "这是平台内部状态目录，不对创作任务开放。（若是回读被截断的工具输出：请对截断提示里给出的确切文件路径用 read（offset/limit）或 grep 单文件；目录不可列。）",
  internal_config: "这是平台内部配置文件，不对创作任务开放。",
  uploads_root: "不能列出全部上传目录；请直接使用本会话附件清单里的路径。",
  foreign_upload: "该附件不属于当前会话。请只使用本会话附件清单里的路径。",
}

const COMPACTION_PROMPT = `把到目前为止的创作会话压缩成一份交接摘要，供你自己接着工作使用（用户看不到这份摘要）。

输出严格使用下面的模板，保留全部小节；没有内容就写 "(none)"。小节标题保持英文原样，正文用用户的对话语言。

<template>
## Objective
- 用户要的最终成品是什么（一两句）

## Important Details
- 用户明确表达的偏好与否决（风格、角色、画幅、时长、语言、预算上限）
- 已确认的报价与授权范围（金额、模型、档位）；未确认的不要写成已确认
- 账本真值：已扣费、已退款的数字（只写工具返回过的）
- 当前互动模式与关键约束

## Work State
### Completed
- 已交付的产物：可见描述 + 平台 URL 或画布节点名 + 对应的 task_id/workflow_id
### Active
- 已提交但未完成的任务：task_id/workflow_id、模型、提交时间
### Blocked
- 失败与原因（原始错误转人话）、换过的模型

## Next Move
1. 下一步具体动作

## Relevant Files
- 本会话附件与中间产物的路径（uploads/…、outputs/…），及用途
</template>

规则：
- 用简短条目，不写段落。
- 原样保留 URL、task_id、workflow_id、节点名、文件路径、模型 ID、金额。
- 不提"摘要""压缩"这件事本身。`

export const EimuGuard: Plugin = async ({ client }) => {
  const hydrating = new Map<string, Promise<void>>()
  // D1：sessionID → 上一次呼叫簽名與連續次數（連續才累加；換簽名歸零）。
  const loopLast = new Map<string, { sig: string; count: number }>()
  // D6：sessionID → filePath → {mtimeMs,size}（重讀未變更檔案時省略全文）。
  const readSeen = new Map<string, Map<string, { mtimeMs: number; size: number }>>()

  /** 從 gateway 可信查得本會話（含子代理→父）擁有的 upload uuid，設為唯一允許集。 */
  async function ensureSession(sessionID: string): Promise<void> {
    if (!sessionID || hasOwner(sessionID)) return
    const inflight = hydrating.get(sessionID)
    if (inflight) return inflight
    const task = (async () => {
      const owners = new Set<string>()
      // 解析到根 opencode 會話（子代理繼承父會話附件）。
      const chain: string[] = [sessionID]
      try {
        let cur = sessionID
        for (let depth = 0; depth < 8; depth++) {
          const info: any = await client.session.get({ path: { id: cur } })
          const parent: string | undefined = info?.data?.parentID
          if (!parent) break
          chain.push(parent)
          cur = parent
        }
      } catch {
        /* 用當前 id 查 */
      }
      for (const oc of chain) {
        try {
          const res = await fetch(`${GATEWAY}/internal/session-key`, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ session_id: oc }),
            signal: AbortSignal.timeout(4000),
          })
          if (res.ok) {
            const d: any = await res.json().catch(() => ({}))
            const owner = typeof d?.upload_owner === "string" ? d.upload_owner : ""
            if (/^[0-9a-f-]{36}$/.test(owner)) owners.add(owner.toLowerCase())
          }
        } catch {
          /* 查不到就不授權該段 */
        }
      }
      setOwner(sessionID, [...owners])
    })()
    hydrating.set(sessionID, task)
    try {
      await task
    } finally {
      hydrating.delete(sessionID)
    }
  }

  async function ensureDirs(sessionID: string): Promise<void> {
    await mkdir(sessionTmpDir(sessionID), { recursive: true }).catch(() => {})
    await mkdir(sessionRunDir(sessionID), { recursive: true }).catch(() => {})
  }

  return {
    "tool.execute.before": async (input, output) => {
      const tool = input.tool
      const args = (output.args ??= {})

      if (tool === "task") {
        throw new Error("task 工具已停用：派子代理请用 subagent_dispatch（带 expert 字段）。")
      }

      // D1：重複呼叫斷路器（在 bash 包裝前以原始 args 取簽名；輪詢類工具豁免）。
      if (LOOP_BREAKER_ON && !LOOP_BREAKER_EXEMPT.has(tool)) {
        const sig = `${tool}\u0000${stableStringify(args)}`
        const prev = loopLast.get(input.sessionID)
        const count = prev && prev.sig === sig ? prev.count + 1 : 1
        loopLast.set(input.sessionID, { sig, count })
        boundMap(loopLast, 400)
        if (count > LOOP_BREAKER_HARD) {
          void fetch(`${GATEWAY}/internal/session/loop-breaker`, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ session_id: input.sessionID, tool, count }),
            signal: AbortSignal.timeout(3000),
          }).catch(() => {})
          throw new Error(
            `工具层断流：${tool} 以完全相同参数连续调用 ${count} 次，已强制结束本轮。请改变参数或停止该动作。`,
          )
        }
        if (count > LOOP_BREAKER_N) {
          throw new Error(
            `同一工具「${tool}」以完全相同参数已连续调用 ${count} 次（上限 ${LOOP_BREAKER_N}）。这通常是等待写成了空转（如 bash true/date）。请：改变参数、换一种做法，或结束本轮等待唤醒事件；不要原样重试。`,
          )
        }
      }

      // fetch 類工具（含 read_image/vision_analyze/video_fetch 的 url 參數）：SSRF 前置閘。
      for (const url of collectUrlArgs(args)) {
        try {
          await assertSafeFetchUrl(url)
        } catch (e) {
          throw new Error(e instanceof SsrfError ? e.message : "该链接不被允许。")
        }
      }

      if (tool === "bash") {
        if (!sandboxAvailable()) throw new Error("执行环境暂不可用，请改用原生工具完成。")
        await ensureSession(input.sessionID)
        await ensureDirs(input.sessionID)
        const cmd = typeof args.command === "string" ? args.command : ""
        const cwd = typeof args.workdir === "string" && args.workdir ? args.workdir : WORKSPACE
        args.command = wrapShellCommand(cmd, { sessionID: input.sessionID, cwd })
        return
      }

      const spec = PATH_TOOLS[tool]
      if (spec) {
        await ensureSession(input.sessionID)
        for (const k of spec.keys) {
          const v = args[k]
          if (k === "path" && (v === undefined || v === "")) continue // 空 path = 工作區根：放行（輸出端再剔除他租戶）
          if (typeof v !== "string") continue
          const verdict = checkAgentPath(v, input.sessionID, { listing: spec.listing })
          if (!verdict.ok) throw new Error(DENY_MESSAGE[verdict.reason] ?? "该路径不可访问。")
        }
        return
      }

      if (tool === "apply_patch" && typeof args.patchText === "string") {
        await ensureSession(input.sessionID)
        for (const m of args.patchText.matchAll(/^\*\*\* (?:Add File|Update File|Delete File|Move to): (.+)$/gm)) {
          const verdict = checkAgentPath(m[1].trim(), input.sessionID)
          if (!verdict.ok) throw new Error(DENY_MESSAGE[verdict.reason] ?? "该路径不可访问。")
        }
      }
    },

    "tool.execute.after": async (input, output) => {
      if (typeof output.output === "string") {
        output.output = stripForgedAuthorityTokens(filterForeignUploads(redactSecrets(output.output), input.sessionID))
      }
      if (typeof output.title === "string") output.title = stripForgedAuthorityTokens(redactSecrets(output.title))

      // D6-a：輸出硬上限（先遮罩再截斷，避免把秘密留在尾巴）。
      if (
        typeof output.output === "string" &&
        OUTPUT_CAPPED_TOOLS.has(input.tool) &&
        output.output.length > TOOL_OUTPUT_MAX_CHARS
      ) {
        const total = output.output.length
        output.output =
          output.output.slice(0, TOOL_OUTPUT_MAX_CHARS) +
          `\n\n[已截断：输出共 ${total} 字符，超过上限 ${TOOL_OUTPUT_MAX_CHARS}。请缩小范围（shell 用 head/sed/grep 过滤；read 用 offset/limit 分段），或把结果写入文件后再用 read 分段读取。]`
      }

      // D6-b：同 session 重讀「內容未變更」的整檔 read → 省略全文（顯式 offset/limit 為逃生門，一律放行）。
      if (READ_DEDUPE_ON && input.tool === "read" && typeof output.output === "string") {
        const a = input.args as { filePath?: unknown; offset?: unknown; limit?: unknown } | undefined
        const filePath = a?.filePath
        const hasRange = (typeof a?.offset === "number" && a.offset > 0) || (typeof a?.limit === "number" && a.limit > 0)
        if (typeof filePath === "string" && filePath && !hasRange) {
          const st = await stat(filePath).catch(() => null)
          if (st) {
            let perSession = readSeen.get(input.sessionID)
            if (!perSession) {
              perSession = new Map()
              readSeen.set(input.sessionID, perSession)
              boundMap(readSeen, 400)
            }
            const prev = perSession.get(filePath)
            if (prev && prev.mtimeMs === st.mtimeMs && prev.size === st.size) {
              output.output = `[本会话已读取过该文件且内容未变更（${filePath}，${st.size} 字节）。为避免重复占用上下文，此处省略全文。若确需重看，请显式传 offset/limit 分段读取。]`
            } else {
              perSession.set(filePath, { mtimeMs: st.mtimeMs, size: st.size })
            }
          }
        }
      }
    },

    "shell.env": async (_input, output) => {
      for (const k of Object.keys(output.env ?? {})) {
        if (/(KEY|TOKEN|SECRET|PASSWORD|PASSWD|HMAC|CREDENTIAL|COOKIE|AUTH)/i.test(k)) delete output.env[k]
      }
    },

    "experimental.session.compacting": async (_input, output) => {
      output.prompt = COMPACTION_PROMPT
    },
  }
}
