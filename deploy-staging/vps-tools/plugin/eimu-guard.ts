// Eimu 守衛 plugin（2026-09-29 審計＋紅隊二輪修復）。opencode 自動載入 .opencode/plugin/*.ts。
//
// 全部是確定性代碼（不靠 prompt 自律）：
//   1. bash / run_py 一律進 bwrap 沙箱（lib/sandbox.ts）：無密鑰、斷網、看不到別租戶；不可用即 fail-closed。
//   2. 讀寫類原生工具（read/write/edit/multiedit/list/glob/grep/patch/apply_patch）路徑白名單閘。
//   3. fetch 類工具（read_image/vision_analyze/video_fetch/任何帶 url 參數者）SSRF 前置閘（擋 loopback/內網/metadata）。
//   4. task 工具停用：子代理只能經 subagent_dispatch（網關路由/隔離/憲法在那條路上）。
//   5. 上傳歸屬由 gateway 可信查得（非「用戶提到即授權」）。
//   6. 工具輸出進上下文前：遮罩秘密、剔除他租戶 uploads 路徑。
//   7. 壓縮用創作向摘要模板。

import type { Plugin } from "@opencode-ai/plugin"
import { mkdir } from "node:fs/promises"
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
