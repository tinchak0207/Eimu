// context-slim plugin（2026-10-02）：上下文经济第二层——microCompact（T1-3）＋工具结果预算安全网（T1-4）。
//
// **loader 契约（2026-10-02 生产事故）**：opencode 自动载入 .opencode/plugin/*.ts 时逐个
//   export 检查，遇到非函式 export 即整档载入失败（`Plugin export is not a function`）。
//   本档因此**只准有一个 export**，且必须是 Plugin 函式——实际逻辑与常数全部放在
//   lib/context-slim-core.ts（lib/ 不会被当 plugin 自动载入）。新增常数／函式请加在 core，
//   切勿在本档再 export 任何东西。
//
// 旧版事故：常数（CLEARED_MARKER／TOOL_RESULT_* 等）与函式（slimMessages 等）原本就挂在本档
//   的 export 上，使本 plugin 在生产根本没被载入——microCompact 与安全网在生产是死的。
//
// hook 形状（@opencode-ai/plugin 1.17.1 型别、1.18.14 执行）：
//   "experimental.chat.messages.transform"?: (input: {}, output: { messages: { info: Message; parts: Part[] }[] }) => Promise<void>
//   主聊天路径 trigger(..., {}, { messages: C }) 后紧接 toModelMessagesEffect(C, ...)，就地改写即影响送上游内容。
//
// 纯记忆体改写：不动 DB、不发任何上游请求（零 API 成本）。任何错误都 try/catch 原样放行。

import type { Plugin } from "@opencode-ai/plugin"
import { CONTEXT_SLIM_ENABLED, slimMessages } from "../lib/context-slim-core"

export const ContextSlim: Plugin = async () => {
  return {
    "experimental.chat.messages.transform": async (_input, output) => {
      if (!CONTEXT_SLIM_ENABLED) return
      try {
        const messages = (
          output as { messages?: Parameters<typeof slimMessages>[0] } | undefined
        )?.messages
        if (!Array.isArray(messages) || messages.length === 0) return
        await slimMessages(messages)
      } catch {
        /* 一律放行 */
      }
    },
  }
}
