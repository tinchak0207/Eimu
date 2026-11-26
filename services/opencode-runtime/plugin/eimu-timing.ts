// eimu-timing plugin（2026-10-18）：把「网关发出 prompt → 上游首个 token」之间的
// opencode 本地准备时间拆成可归因的 hook 段。只在 EIMU_TIMING=1 时输出，否则整档零动作。
//
// loader 契约（见 context-slim.ts 头注）：opencode 自动载入 .opencode/plugin/*.ts 时
// 逐个 export 检查，非函式 export 即整档载入失败。本档只 export 一个 Plugin 函式。
//
// 输出格式（每 hook 一行 stdout）：
//   [eimu-timing] hook=<name> t=<Date.now()> msg=<messageID 或 -> n=<该会话已见 hook 次数>
// 不输出用户正文、prompt、header 值或任何 secret。hook 内无 await 网络/IO，异常一律吞掉。

import type { Plugin } from "@opencode-ai/plugin"

const ENABLED = process.env.EIMU_TIMING === "1"

type AnyRecord = Record<string, unknown>

function asRecord(value: unknown): AnyRecord {
  return value && typeof value === "object" ? (value as AnyRecord) : {}
}

function asString(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined
}

export const EimuTiming: Plugin = async () => {
  if (!ENABLED) return {}

  // 每会话已见 hook 次数（所有 hook 合并计数，用于排序与识别新 turn）。
  const seen = new Map<string, number>()

  const emit = (hook: string, sessionID: unknown, messageID: unknown) => {
    try {
      const sid = asString(sessionID) ?? "-"
      const n = (seen.get(sid) ?? 0) + 1
      seen.set(sid, n)
      const msg = asString(messageID) ?? "-"
      console.log(`[eimu-timing] hook=${hook} t=${Date.now()} msg=${msg} n=${n}`)
    } catch {
      /* 计时不得影响主链 */
    }
  }

  return {
    "chat.message": async (input: unknown) => {
      try {
        const i = asRecord(input)
        emit("chat.message", i.sessionID, i.messageID)
      } catch {
        /* 静默 */
      }
    },
    "chat.headers": async (input: unknown) => {
      try {
        const i = asRecord(input)
        emit("chat.headers", i.sessionID, asRecord(i.message).id)
      } catch {
        /* 静默 */
      }
    },
    "experimental.chat.system.transform": async (input: unknown) => {
      try {
        const i = asRecord(input)
        emit("experimental.chat.system.transform", i.sessionID, undefined)
      } catch {
        /* 静默 */
      }
    },
    "experimental.chat.messages.transform": async (_input: unknown, output: unknown) => {
      try {
        const messages = asRecord(output).messages
        const last = Array.isArray(messages) ? asRecord(messages[messages.length - 1]) : {}
        const info = asRecord(last.info)
        emit("experimental.chat.messages.transform", info.sessionID, info.id)
      } catch {
        /* 静默 */
      }
    },
    "chat.params": async (input: unknown) => {
      try {
        const i = asRecord(input)
        emit("chat.params", i.sessionID, asRecord(i.message).id)
      } catch {
        /* 静默 */
      }
    },
  }
}
