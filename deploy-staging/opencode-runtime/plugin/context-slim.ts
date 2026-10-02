// context-slim plugin（2026-10-02）：上下文經濟第二層——microCompact（T1-3）＋工具結果預算安全網（T1-4）。
//
// **loader 契約（2026-10-02 生產事故）**：opencode 自動載入 .opencode/plugin/*.ts 時逐個
//   export 檢查，遇到非函式 export 即整檔載入失敗（`Plugin export is not a function`）。
//   本檔因此**只准有一個 export**，且必須是 Plugin 函式——實際邏輯與常數全部放在
//   lib/context-slim-core.ts（lib/ 不會被當 plugin 自動載入）。新增常數／函式請加在 core，
//   切勿在本檔再 export 任何東西。
//
// 舊版事故：常數（CLEARED_MARKER／TOOL_RESULT_* 等）與函式（slimMessages 等）原本就掛在本檔
//   的 export 上，使本 plugin 在生產根本沒被載入——microCompact 與安全網在生產是死的。
//
// hook 形狀（@opencode-ai/plugin 1.17.1 型別、1.18.14 執行）：
//   "experimental.chat.messages.transform"?: (input: {}, output: { messages: { info: Message; parts: Part[] }[] }) => Promise<void>
//   主聊天路徑 trigger(..., {}, { messages: C }) 後緊接 toModelMessagesEffect(C, ...)，就地改寫即影響送上游內容。
//
// 純記憶體改寫：不動 DB、不發任何上游請求（零 API 成本）。任何錯誤都 try/catch 原樣放行。

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
