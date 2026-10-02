/**
 * context-compaction-toolresult.test.ts — context.compacted 邊界事件真值驗收
 *（2026-10-02，需求1：context.compacted 系統邊界事件）。
 *
 * 跑法：bash deploy-staging/vps-tools/run-tests.sh context-compaction-toolresult.test.ts
 * 真值斷言＝餵真實輸入 → 檢查真實輸出（真 emitToSession → replayBuffer 逐位元耐久），
 * 不斷言原始碼字串或函數調用次數（守門件不算驗收）。
 *
 * 註：原檔同時測「送上游組裝／工具結果落盤」一串純函式；該批已被架構否定
 *（gateway 每輪只送單條 promptBody，不自行組裝上游訊息陣列），函式與其測試
 * 一併移除。同功能改在 opencode 的 experimental.chat.messages.transform
 * plugin hook 落地（另一進程），勿在此重造。
 */
import { expect, test } from "bun:test"
import type { SessionState } from "./types-gateway.ts"
import { emitContextCompacted, CONTEXT_COMPACTED_EVENT } from "./messages-gw.ts"
import { isStrippableReplayEntry, appendReplayFrame } from "./replay-frame.ts"
import { serializeSse } from "./sse-core.ts"

test("context.compacted 經真 emitToSession 進 replay 且為耐久（N2 strip 不剝）", () => {
  const state = {
    sessionId: "s-test",
    clients: new Set(),
    replayBuffer: [] as { id: number; frame: Uint8Array; strippable?: boolean }[],
    eventCounter: 0,
    lastActivityAt: 0,
    deathDeclared: false,
  } as unknown as SessionState
  const sent = emitContextCompacted(state, { trigger: "auto", preTokens: 999 })
  expect(sent).toBe(true)
  expect(state.replayBuffer.length).toBe(1)
  const entry = state.replayBuffer[0]
  // 耐久：不與模型文字幀同類，N2 strip 的可剝判定為 false
  expect(isStrippableReplayEntry(entry)).toBe(false)
  const wire = new TextDecoder().decode(entry.frame)
  expect(wire).toContain(`event: ${CONTEXT_COMPACTED_EVENT}`)
  expect(wire).toContain('"preTokens":999')
  expect(wire).toContain('"trigger":"auto"')
  // 對照：模型 message.delta 可剝（同一判定函數的陽性對照，不是同源自證）
  const modelFrame = new TextEncoder().encode(serializeSse("message.delta", { text: "模型正文" }, 1))
  const modelBuf: { id: number; frame: Uint8Array }[] = []
  appendReplayFrame(modelBuf, "message.delta", { text: "模型正文" }, 1, modelFrame)
  expect(isStrippableReplayEntry(modelBuf[0])).toBe(true)
})
