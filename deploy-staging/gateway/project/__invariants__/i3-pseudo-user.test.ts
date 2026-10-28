// I3（设计文档 §8 第三行）：网关发给 opencode 的 prompt 里，user 角色中不等于人类原话的条数 = 0。
//
// 独立期望来源：
//   * 测试自己发送的用户消息列表（fixtures/session.ts）；
//   * fake opencode 记录的原始 prompt 载荷（fixtures/recorder.ts），不读网关自报计数。
// 双侧：同一会话里 run 完成事件真实发生过（真的跑完一轮工程，事件从 events.jsonl 取），
// 反例用旧席位路径证明这条闸会咬人（旧路径确实会注入尾端文本）。
import "./fixtures/env"
import "./fixtures/fake-platform"
import "./fixtures/recorder"
import { beforeAll, beforeEach, describe, expect, test } from "bun:test"
import { mkdirSync, writeFileSync } from "node:fs"
import { join } from "node:path"
import { recorderOf } from "./fixtures/recorder"
import { USER_TEXTS } from "./fixtures/session"

const INJECTED_PREFIXES = ["【系统注入·尾端】", "【系统注入·尾端·资料】"]

let adm: typeof import("../../messages-gw-admission.ts")

beforeAll(async () => {
  adm = await import("../../messages-gw-admission.ts")
})

beforeEach(() => recorderOf().reset())

function projectState() {
  return { sessionId: "gw_i3", apiKey: "sk-i3-project", opencodeSessionId: "ses_inv", projectMode: true as const }
}
function legacyState() {
  return { sessionId: "gw_i3", apiKey: "sk-i3-project", opencodeSessionId: "ses_inv", projectMode: false as const, seat: "creator_legacy" as const }
}

/** 本轮网关会尝试贴到 user 消息尾部的四类注入（S14 已把它们收成同一个开关）。 */
function buildBody(withInjections: boolean): { body: { parts: { type: string; text: string }[] }; injected: boolean[] } {
  const text = USER_TEXTS[0]
  const body = { parts: [{ type: "text", text }] }
  const state: any = withInjections ? legacyState() : projectState()
  const injected = [
    adm.maybeAppendSystemTail(state, body as never, "授权：full（用户设了完全访问）", "【本轮设置·真实状态】"),
    adm.maybeAppendDataTail(state, body as never, "偏好：中文回答；导出 mp4", "【模板偏好·用户资料】"),
    adm.maybeAppendContextDelta(state, body as never, "【技能索引·版本资料】", "技能内容：读图、检索、画布"),
    adm.maybePushHookInjection(state, body as never, [], "hook 上下文：SessionStart 补一条环境事实", { id: "hook", priority: 5, label: "【hook·本轮资料】" }),
  ]
  return { body, injected }
}

/** 从 fake opencode 收到的载荷里取 user 角色文本，找出不属于人类原话的条目。 */
function nonHumanUserTexts(payload: { parts?: { type?: string; text?: string; synthetic?: boolean }[] }, sent: readonly string[]): string[] {
  const out: string[] = []
  for (const part of payload.parts ?? []) {
    if (part?.type !== "text" || typeof part.text !== "string") continue
    if (part.synthetic === true) continue
    if (sent.includes(part.text)) continue
    if (INJECTED_PREFIXES.some((p) => part.text!.includes(p)) || part.text.trim()) out.push(part.text)
  }
  return out
}

async function sendPrompt(sessionId: string, body: unknown): Promise<any> {
  const rec = recorderOf()
  await fetch(`${rec.base}/session/${sessionId}/prompt_async`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  })
  return JSON.parse(rec.last()!.body)
}

describe("I3 伪用户消息 = 0", () => {
  test("21 条用户消息逐条投递：user 文本 === 人类原话，注入条数 0", async () => {
    const sent: string[] = []
    let violations = 0
    for (const text of USER_TEXTS) {
      const body = { parts: [{ type: "text", text }] }
      const state: any = projectState()
      const injected = [
        adm.maybeAppendSystemTail(state, body as never, "授权：full", "【本轮设置·真实状态】"),
        adm.maybeAppendDataTail(state, body as never, "偏好：中文", "【模板偏好·用户资料】"),
        adm.maybeAppendContextDelta(state, body as never, "【技能索引·版本资料】", "技能内容"),
        adm.maybePushHookInjection(state, body as never, [], "hook 上下文", { id: "hook", priority: 5, label: "【hook·本轮资料】" }),
      ]
      expect(injected).toEqual([false, false, false, false])
      expect(body.parts.length).toBe(1)
      sent.push(text)
      const received = await sendPrompt("ses_inv", body)
      expect(received.parts.map((p: any) => p.text)).toEqual([text])
      violations += nonHumanUserTexts(received, sent).length
    }
    expect(violations).toBe(0)
  })

  test("双侧：run 完成事件真实发生（真跑一轮工程），工程模式不把完成通知贴进 user 消息", async () => {
    const { clearExecutors, registerExecutor } = await import("../executor-registry.ts")
    const { ensureProject } = await import("../store.ts")
    const { runProject } = await import("../run.ts")
    clearExecutors()
    let artifacts = 0
    registerExecutor({
      type: "script",
      specVersion: 1,
      async estimate() { return 0 },
      async run(ctx: any) {
        const dir = join(process.env.WORKSPACE_DIR!, "projects", ctx.sessionId, "tmp")
        mkdirSync(dir, { recursive: true })
        const file = join(dir, `i3-${++artifacts}.txt`)
        writeFileSync(file, `script ${artifacts}`)
        const out = await ctx.ingest({ path: file }, { port: "out", mime: "text/plain", origin: "generated" })
        return { ok: true, outputs: [{ ...out, port: "out" }], costCoins: 0 }
      },
    } as never)
    const { store } = await ensureProject("s18_i3_events")
    await store.update((g: any) => {
      g.nodes.sc = {
        id: "sc", type: "script", intent: "", params: { text: "剧本" }, inputs: {}, refs: [], pinned: null,
        status: "pending", signature: null, lastRun: null, outputs: [], rev: 1,
      }
      g.order.push("sc")
    })
    const deps: any = {
      session: { sessionId: "s18_i3_events", apiKey: "sk-test", opencodeSessionId: "oc-i3" },
      ledger: { write: async () => {} },
      submitGeneration: async () => ({ ok: false, code: "bad_input", message: "unused", retryable: false }),
      execBridge: { call: async () => ({ ok: false, code: "bridge_unavailable", message: "unused", retryable: false }), result: async () => ({ state: "unknown" }) },
    }
    const result = await runProject(store, deps)
    expect(result.status).toBe("done")
    const events = await store.log.read(0, 1000)
    const kinds = events.map((e: any) => e.kind)
    expect(kinds).toContain("run_started")
    expect(kinds).toContain("run_finished")
    expect(kinds).toContain("node_status")

    // 完成通知的真实文本（由真事件生成）：工程模式下不得作为新的 user 文本进入 prompt。
    const doneText = events.filter((e: any) => e.kind === "run_finished" || (e.kind === "node_status" && e.node === "sc"))
      .map((e: any) => `${e.kind} ${e.node ?? ""}`).join("\n")
    const projectBody: any = { parts: [{ type: "text", text: "继续" }] }
    const appended = adm.maybeAppendSystemTail(projectState() as never, projectBody, doneText, "【run 完成·本轮事实】")
    expect(appended).toBe(false)
    const received = await sendPrompt("ses_inv", projectBody)
    expect(nonHumanUserTexts(received, ["继续"])).toEqual([])
  })

  test("反例：旧席位路径同样四条注入 → 检验器必须报出 4 条伪用户消息", async () => {
    const { body, injected } = buildBody(true)
    expect(injected).toEqual([true, true, true, true])
    expect(body.parts.length).toBe(5)
    const received = await sendPrompt("ses_inv", body)
    const bad = nonHumanUserTexts(received, [USER_TEXTS[0]])
    expect(bad.length).toBe(4)
    for (const text of bad) expect(text).toContain("【系统注入·尾端")
  })
})
