// tool-defer plugin（2026-11-24）：工具定义静态折叠 ＋ base64 入参拦截。逻辑全在 lib/tool-defer-core.ts。
//
// loader 契约（见 plugin/context-slim.ts 档头）：本档只准有一个 export，且必须是 Plugin 函式。

import type { Plugin } from "@opencode-ai/plugin"
import { base64ArgGate, deferredCallGate, foldDefinition } from "../lib/tool-defer-core"

export const ToolDefer: Plugin = async () => {
  return {
    "tool.definition": async (input, output) => {
      try {
        foldDefinition((input as { toolID: string }).toolID, output as { description?: string; jsonSchema?: unknown })
      } catch {
        /* 折叠失败：原样送出完整定义 */
      }
    },
    "tool.execute.before": async (input, output) => {
      let reject: string | null = null
      try {
        reject = base64ArgGate(input.tool, output?.args) ?? deferredCallGate(input.tool, input.sessionID, output?.args)
      } catch {
        reject = null
      }
      if (reject) throw new Error(reject)
    },
  }
}
