/**
 * context-compaction-toolresult.test.ts — context.compacted 边界事件真值验收
 *（2026-10-02，需求1：context.compacted 系统边界事件）。
 *
 * 跑法：bash deploy-staging/vps-tools/run-tests.sh context-compaction-toolresult.test.ts
 * 真值断言＝喂真实输入 → 检查真实输出（真 emitToSession → replayBuffer 逐位元耐久），
 * 不断言原始码字串或函数调用次数（守门件不算验收）。
 *
 * 注：原档同时测「送上游组装／工具结果落盘」一串纯函式；该批已被架构否定
 *（gateway 每轮只送单条 promptBody，不自行组装上游讯息阵列），函式与其测试
 * 一并移除。同功能改在 opencode 的 experimental.chat.messages.transform
 * plugin hook 落地（另一进程），勿在此重造。
 */
import { expect, test } from "bun:test"
import type { SessionState } from "./types-gateway.ts"
import { emitContextCompacted, CONTEXT_COMPACTED_EVENT } from "./messages-gw.ts"
import { isStrippableReplayEntry, appendReplayFrame } from "./replay-frame.ts"
import { serializeSse } from "./sse-core.ts"

test("context.compacted 经真 emitToSession 进 replay 且为耐久（N2 strip 不剥）", () => {
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
  // 耐久：不与模型文字帧同类，N2 strip 的可剥判定为 false
  expect(isStrippableReplayEntry(entry)).toBe(false)
  const wire = new TextDecoder().decode(entry.frame)
  expect(wire).toContain(`event: ${CONTEXT_COMPACTED_EVENT}`)
  expect(wire).toContain('"preTokens":999')
  expect(wire).toContain('"trigger":"auto"')
  // 对照：模型 message.delta 可剥（同一判定函数的阳性对照，不是同源自证）
  const modelFrame = new TextEncoder().encode(serializeSse("message.delta", { text: "模型正文" }, 1))
  const modelBuf: { id: number; frame: Uint8Array }[] = []
  appendReplayFrame(modelBuf, "message.delta", { text: "模型正文" }, 1, modelFrame)
  expect(isStrippableReplayEntry(modelBuf[0])).toBe(true)
})
