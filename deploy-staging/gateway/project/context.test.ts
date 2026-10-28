// S15 装配判准（设计文档 §3.7、§10 S15）。
// 期望值来源：设计文档的字节/条数硬上限与逐字要求；不使用被测实现的源码字符串做断言。
import { describe, expect, test } from "bun:test"
import {
  DIGEST_TAG_OPEN,
  STATIC_SYSTEM_MAX_BYTES,
  SYSTEM_POLICY_STATIC,
  applyProjectContext,
  buildStaticSystem,
  groupSteps,
  measureRequest,
  projectContextResponse,
  pruneToolParts,
  userTextOfMessage,
} from "./context"
import type { AgentMessage, AgentPart } from "./context"
import { GOAL_CARD_TAG, GOAL_CARD_MAX_TOKENS, appendBriefEntry, renderGoalCard } from "./brief"
import { renderDigest } from "./digest"
import type { DigestInputs } from "./digest"
import { LIMITS } from "./constants"
import type { BriefEntry, ProjectGraph, ProjectNode } from "./types"

const T0 = Date.parse("2026-10-28T00:00:00.000Z")
const iso = (ms: number) => new Date(ms).toISOString()

// ── 图：含 failed/blocked/pinned/drift 与预算 ────────────────────────────────
function node(id: string, o: Partial<ProjectNode> = {}): ProjectNode {
  return {
    id, type: "keyframe", intent: "", params: {}, inputs: {}, refs: [], pinned: null,
    status: "pending", signature: null, lastRun: null, outputs: [], rev: 1, ...o,
  }
}

function makeGraph(now: string): ProjectGraph {
  const nodes: Record<string, ProjectNode> = {}
  for (let i = 0; i < 40; i++) nodes[`ok_${i}`] = node(`ok_${i}`, { status: "done", signature: `sig_ok_${i}` })
  for (let i = 0; i < 7; i++) {
    nodes[`fail_${i}`] = node(`fail_${i}`, {
      status: "failed",
      error: { code: "provider_error", message: `上游 500：模型不可用（第 ${i} 次）`, retryable: true, at: now },
    })
  }
  for (let i = 0; i < 5; i++) nodes[`block_${i}`] = node(`block_${i}`, { status: "blocked" })
  for (let i = 0; i < 4; i++) {
    nodes[`pin_${i}`] = node(`pin_${i}`, {
      status: "done", signature: `sig_pin_${i}`,
      pinned: { by: "user", at: now, outputsSha: [`${"a".repeat(64)}`], signatureAtPin: `sig_pin_${i}` },
    })
  }
  // 漂移：签名已变但钉住仍在
  nodes.pin_1.signature = "sig_pin_1_v2"
  nodes.pin_2.signature = "sig_pin_2_v2"
  return {
    schema: 1 as never, id: "ses_test", sessionId: "ses_test", version: 7,
    createdAt: now, updatedAt: now, templateId: "feature_film",
    brief: [], decisions: [
      { id: "d1", at: now, question: "用 16:9 还是 9:16？", answer: "16:9，别裁我的竖图" },
    ],
    targets: { durationSec: 30, aspect: "16:9", audio: "both", setBy: { kind: "user" }, at: now },
    defaults: { videoModel: "seedance-2.0-900-特惠", imageModel: "nano-banana", imageSize: "1280x720", style: "胶片感" },
    nodes, order: Object.keys(nodes), budget: { capCoins: 500, spentCoins: 123, savedCoins: 40 },
    activeRun: null, seq: 200,
  }
}

// ── 200 步合成会话（15 条真实用户消息、多种工具回执）───────────────────────
const USER_TEXTS = [
  "帮我做一支 30 秒的茶饮广告，竖屏转横屏 😀\n主线：清晨窗边的杯子",
  "改成 16:9，不要竖屏",
  "主角换成短发女生，穿米色毛衣",
  "配乐用轻柔的钢琴，不要鼓点 🎹",
  "第一个镜头太暗了，重做",
  "把杯子换成玻璃杯，上面有冷凝水",
  "字幕用简体中文，字号大一点",
  "色调再暖一点，像傍晚",
  "授权：预算 500 币，不用每次问我",
  "旁白文案我贴在下面：\n「一杯茶的时间，把清晨留在手心。」\n（这句不许改）",
  "第三个镜头改成慢动作",
  "去掉背景噪音，只保留钢琴",
  "结尾加 logo，白色",
  "成片要能直接发抖音，别带水印",
  "最后确认：30 秒、16:9、有旁白有音乐，导出成 mp4",
]
const LONG_TEXT = `这是一条超长需求，用来验证 ingress 单条 12000 字截断与目标卡折叠规则。${"细节".repeat(8000)}` // 16000+ 字

interface SessionSpec {
  messages: AgentMessage[]
  /** 每轮的真实用户消息下标（进入装配时的「当前用户消息」）。 */
  rounds: number[]
}

function toolPart(callID: string, tool: string, output: string, status = "completed"): AgentPart {
  return { type: "tool", id: `prt_${callID}`, callID, tool, state: { status, output } }
}

function buildSession(): SessionSpec {
  const messages: AgentMessage[] = []
  const rounds: number[] = []
  let seq = 0
  let uid = 0
  const pushUser = (text: string) => {
    const id = `msg_u${uid++}`
    messages.push({ info: { id, role: "user", sessionID: "ses_test", time: { created: T0 + seq } }, parts: [{ type: "text", text }] })
    rounds.push(messages.length - 1)
  }
  const pushStep = (i: number, kind: number) => {
    const id = `msg_a${i}`
    const parts: AgentPart[] = []
    if (kind === 1) {
      // 完成：assistant 工具调用 + 紧随的 role="tool" 回执
      parts.push(toolPart(`call_${i}_a`, "project_get", `{"ok":true,"version":${i},"digest":"节点 ${i} done"}`))
      parts.push({ type: "text", text: `第 ${i} 步：已提交节点 ${i}，等待结果。` })
      messages.push({ info: { id, role: "assistant", sessionID: "ses_test", time: { created: T0 + seq } }, parts })
      const big = i % 7 === 0 ? "回执".repeat(5000) : i % 3 === 0 ? "回执".repeat(900) : `tool output ${i}`
      messages.push({
        info: { id: `msg_t${i}`, role: "tool", sessionID: "ses_test", time: { created: T0 + seq } },
        parts: [{ type: "tool", id: `prt_res_${i}`, callID: `call_${i}_a`, tool: "project_get", state: { status: "completed", output: big } }],
      })
    } else if (kind === 2) {
      // 未完成的工具调用：不得进入模型请求（成对性）
      parts.push(toolPart(`call_${i}_run`, "project_run", "", "running"))
      messages.push({ info: { id, role: "assistant", sessionID: "ses_test", time: { created: T0 + seq } }, parts })
    } else if (kind === 3) {
      // 纯文本的最终回答
      parts.push({ type: "text", text: `第 ${i} 步完成：本轮小结（${"x".repeat(120)}）` })
      messages.push({ info: { id, role: "assistant", sessionID: "ses_test", time: { created: T0 + seq } }, parts })
    } else {
      // 一次带图片附件的工具回执（非文本部件按字节计入预算）
      parts.push(toolPart(`call_${i}_img`, "read_image", "已读取参考图"))
      parts.push({ type: "file", id: `prt_file_${i}`, bytes: 180_000, synthetic: false })
      messages.push({ info: { id, role: "assistant", sessionID: "ses_test", time: { created: T0 + seq } }, parts })
    }
    seq++
  }
  // 15 条用户消息之间各插入若干步，合计 200 步。
  for (let u = 0; u < USER_TEXTS.length; u++) {
    pushUser(u === 9 ? LONG_TEXT : USER_TEXTS[u])
    const stepsHere = u === USER_TEXTS.length - 1 ? 0 : 13
    for (let s = 0; s < stepsHere; s++) pushStep(u * 13 + s, (u + s) % 4)
  }
  return { messages, rounds }
}

function buildBrief(texts: string[], at = iso(T0)): BriefEntry[] {
  const entries: BriefEntry[] = []
  texts.forEach((text, i) => {
    appendBriefEntry(entries, { at: iso(T0 + i * 1000), messageId: `msg_u${i}`, text })
  })
  return entries
}

function digestInputs(): DigestInputs {
  return {
    environment: `read_image 可用；image_generate 已折叠到节点；exec-bridge music 可用；${"环境细节".repeat(120)}`,
    preferences: `偏好：中文回答；导出 mp4；不要水印；${"偏好".repeat(200)}`,
    authorization: "full（用户设了完全访问）",
    pending: [{ question: "第三镜要不要补拍？", at: iso(T0) }],
    recentEvents: Array.from({ length: 14 }, (_, i) => ({
      seq: 180 + i, at: iso(T0 + i), kind: (["node_status", "cost", "pinned"] as const)[i % 3],
      node: `ok_${i}`, data: { status: "done", note: "事件说明" },
    })),
  }
}

function clone<T>(v: T): T {
  return JSON.parse(JSON.stringify(v)) as T
}

describe("S15 工程模式上下文装配", () => {
  test("固定系统提示 ≤8KB 且不随轮次变化", () => {
    expect(Buffer.byteLength(SYSTEM_POLICY_STATIC, "utf8")).toBeLessThanOrEqual(STATIC_SYSTEM_MAX_BYTES)
    expect(buildStaticSystem(false)).toBe(SYSTEM_POLICY_STATIC)
    expect(buildStaticSystem(true)).not.toBe(SYSTEM_POLICY_STATIC)
    expect(Buffer.byteLength(buildStaticSystem(true), "utf8")).toBeLessThanOrEqual(STATIC_SYSTEM_MAX_BYTES)
  })

  test("工程摘要 ≤6144B 且含全部 failed/blocked/pinned/drift 节点", () => {
    const graph = makeGraph(iso(T0))
    const digest = renderDigest(graph, digestInputs())
    expect(Buffer.byteLength(digest, "utf8")).toBeLessThanOrEqual(LIMITS.DIGEST_BYTES)
    for (const n of Object.values(graph.nodes)) {
      if (["failed", "blocked"].includes(n.status) || n.pinned) {
        expect(digest).toContain(n.id)
      }
    }
    // 漂移标记出现两次（pin_1 / pin_2 改了签名）
    expect(digest.split("⇄漂移").length - 1).toBe(2)
    // 固定段顺序
    const order = ["## 状态计数", "## 失败与阻塞", "## 钉住与漂移", "## 待决问题与用户决定", "## 预算与授权", "## 环境可用性", "## 用户偏好", "## 最近事件"]
    let cursor = -1
    for (const head of order) {
      const at = digest.indexOf(head)
      expect(at).toBeGreaterThan(cursor)
      cursor = at
    }
  })

  test("200 步会话每轮 ≤65536 字节 / ≤32768 token，且目标卡逐字", () => {
    const session = buildSession()
    const graph = makeGraph(iso(T0))
    const brief = buildBrief(USER_TEXTS)
    graph.brief = brief
    let maxBytes = 0
    let maxTokens = 0
    let maxJsonBytes = 0
    for (const round of session.rounds) {
      // opencode 每轮从库里重建 msgs（这里传副本，库本身不动）。
      const db = clone(session.messages.slice(0, round + 1))
      const dbSnapshot = JSON.stringify(db)
      const assembled = clone(db)
      const r = applyProjectContext(assembled, { graph, digestInputs: digestInputs() })
      expect(r.applied).toBe(true)
      const measured = measureRequest(assembled)
      maxBytes = Math.max(maxBytes, measured.bytes)
      maxTokens = Math.max(maxTokens, measured.tokens)
      maxJsonBytes = Math.max(maxJsonBytes, Buffer.byteLength(JSON.stringify(assembled), "utf8"))
      expect(measured.bytes).toBeLessThanOrEqual(LIMITS.INPUT_CAP_BYTES)
      expect(measured.tokens).toBeLessThanOrEqual(32768)
      expect(Buffer.byteLength(JSON.stringify(assembled), "utf8")).toBeLessThanOrEqual(LIMITS.INPUT_CAP_BYTES)

      // 窗口：当前用户消息在、最多 K=6 步
      const steps = groupSteps(assembled)
      expect(steps.length).toBeLessThanOrEqual(LIMITS.CONTEXT_WINDOW_STEPS)
      const lastUser = assembled.filter((m) => userTextOfMessage(m)).pop()
      expect(lastUser?.info.id).toBe(`msg_u${session.rounds.indexOf(round)}`)

      // 合成片段：synthetic:true、不落库
      const syntheticParts = assembled.flatMap((m) => m.parts.filter((p) => p.synthetic === true))
      expect(syntheticParts.length).toBe(1)
      expect(syntheticParts[0].text!.startsWith(GOAL_CARD_TAG)).toBe(true)
      expect(syntheticParts[0].text!).toContain(DIGEST_TAG_OPEN)
      expect(dbSnapshot).toBe(JSON.stringify(session.messages.slice(0, round + 1)))
      expect(dbSnapshot).not.toContain(GOAL_CARD_TAG)
      expect(dbSnapshot).not.toContain(DIGEST_TAG_OPEN)

      // 目标卡：首条与最近条逐字（超长条按折叠规则：头/尾仍是原文）
      const card = syntheticParts[0].text!.slice(0, syntheticParts[0].text!.indexOf(DIGEST_TAG_OPEN))
      expect(card).toContain(USER_TEXTS[0])
      const lastIdx = session.rounds.indexOf(round)
      if (lastIdx > 0) {
        const latest = USER_TEXTS[Math.min(lastIdx, USER_TEXTS.length - 1)]
        if (latest !== LONG_TEXT) expect(card).toContain(latest)
      }
      // 卡片里每条 <user-message> 正文都必须与某条原话（或其截断版）逐字相同
      const bodies = [...card.matchAll(/<user-message[^>]*>\n([\s\S]*?)\n<\/user-message>/g)].map((m) => m[1])
      expect(bodies.length).toBeGreaterThan(0)
      for (const body of bodies) {
        if (body.includes("中段") && body.includes("已折叠")) {
          const [head, tail] = body.split(/\n\[…单条过长[^\n]*\n/)
          expect(LONG_TEXT.startsWith(head)).toBe(true)
          expect(LONG_TEXT.endsWith(tail)).toBe(true)
        } else {
          expect(USER_TEXTS.includes(body)).toBe(true)
        }
      }

      // 摘要：全列 failed/blocked/pinned/drift
      const digest = syntheticParts[0].text!.slice(syntheticParts[0].text!.indexOf(DIGEST_TAG_OPEN))
      expect(Buffer.byteLength(digest, "utf8")).toBeLessThanOrEqual(LIMITS.DIGEST_BYTES + 40)
      for (const n of Object.values(graph.nodes)) {
        if (["failed", "blocked"].includes(n.status) || n.pinned) expect(digest).toContain(n.id)
      }

      // tool_use / tool_result 成对：每个工具调用都有回执，每个回执都有调用
      const pruned = pruneToolParts(clone(assembled))
      const uses = new Set<string>()
      for (const m of pruned) {
        if (m.info.role !== "assistant") continue
        for (const p of m.parts) if (p.type === "tool" || p.type === "tool_use") uses.add(String(p.callID ?? p.id))
      }
      for (const m of pruned) {
        if (m.info.role !== "tool") continue
        const kept = m.parts.filter((p) => p.type === "tool")
        expect(kept.length).toBeGreaterThan(0)
        for (const p of kept) expect(uses.has(String(p.callID ?? p.id))).toBe(true)
      }
      // 未完成的工具调用不得留下 tool_use
      for (const m of assembled) {
        for (const p of m.parts) {
          if ((p.type === "tool" || p.type === "tool_use") && !(m.info.role === "tool")) {
            expect(p.state?.status).not.toBe("running")
          }
        }
      }
    }
    expect(maxBytes).toBeGreaterThan(0)
    expect(maxTokens).toBeGreaterThan(0)
    expect(maxJsonBytes).toBeLessThanOrEqual(LIMITS.INPUT_CAP_BYTES)
    console.log(`[S15] rounds=${session.rounds.length} maxBytes=${maxBytes} maxTokens=${maxTokens} maxJsonBytes=${maxJsonBytes}`)
  })

  test("旧席位（非工程模式）路径逐字节不变", () => {    const session = buildSession()
    const graph = makeGraph(iso(T0))
    for (const round of [session.rounds[0], session.rounds[7], session.rounds[session.rounds.length - 1]]) {
      const messages = clone(session.messages.slice(0, round + 1))
      const before = JSON.stringify(messages)
      const r = applyProjectContext(messages, { graph, projectMode: false })
      expect(r.applied).toBe(false)
      expect(r.projectMode).toBe(false)
      expect(JSON.stringify(messages)).toBe(before)
    }
  })

  test("网关 /internal/project/context 响应体与插件契约一致（snake_case / 非工程模式 false）", () => {
    const session = buildSession()
    const graph = makeGraph(iso(T0))
    graph.brief = buildBrief(USER_TEXTS)
    const messages = clone(session.messages.slice(0, session.rounds[8] + 1))
    const res = projectContextResponse(graph, messages)
    expect(res.project_mode).toBe(true)
    if (res.project_mode) {
      expect(Array.isArray(res.keep_ids)).toBe(true)
      expect(typeof res.synthetic).toBe("string")
      expect(Array.isArray(res.replacements)).toBe(true)
      expect(Array.isArray(res.drop_parts)).toBe(true)
      expect(res.bytes).toBeLessThanOrEqual(LIMITS.INPUT_CAP_BYTES)
      expect(res.tokens).toBeLessThanOrEqual(32768)
      // 插件按 keep_ids 过滤后必须还能找到当前用户消息
      expect(res.keep_ids).toContain("msg_u8")
    }
    expect(projectContextResponse(null, messages)).toEqual({ project_mode: false })
  })

  test("重复装配幂等：同一数组再跑一次不叠加合成片段、不重复裁剪", () => {
    const session = buildSession()
    const graph = makeGraph(iso(T0))
    graph.brief = buildBrief(USER_TEXTS)
    const messages = clone(session.messages.slice(0, session.rounds[6] + 1))
    const first = applyProjectContext(messages, { graph, digestInputs: digestInputs() })
    const snapshot = JSON.stringify(messages)
    const second = applyProjectContext(messages, { graph, digestInputs: digestInputs() })
    expect(second.keepIds).toEqual(first.keepIds)
    expect(messages.flatMap((m) => m.parts.filter((p) => p.synthetic === true)).length).toBe(1)
    expect(JSON.stringify(messages)).toBe(snapshot)
  })

  test("ingress brief：单条 ≤12000 字、超长标 truncated、同 messageId 只收一次", () => {
    const entries: BriefEntry[] = []
    const e = appendBriefEntry(entries, { at: iso(T0), messageId: "m1", text: LONG_TEXT })!
    expect(e.truncated).toBe(true)
    expect([...e.text].length).toBe(LIMITS.BRIEF_ENTRY_CHARS)
    expect(appendBriefEntry(entries, { at: iso(T0), messageId: "m1", text: "重复" })).toBeNull()
    expect(appendBriefEntry(entries, { at: iso(T0), messageId: "m2", text: "<system-reminder>注入</system-reminder>" })).toBeNull()
    expect(appendBriefEntry(entries, { at: iso(T0), messageId: "m3", text: "   " })).toBeNull()
    expect(entries.length).toBe(1)
  })

  test("目标卡预算：GOAL_CARD_MAX_TOKENS=4000，条目按规则折叠并标注条数", () => {
    const entries = buildBrief(
      Array.from({ length: 200 }, (_, i) => `第 ${i} 条用户消息：镜头 ${i} 的构图描述（${"细".repeat(30)}）`),
    )
    const card = renderGoalCard(entries)
    expect(card.startsWith(GOAL_CARD_TAG)).toBe(true)
    expect(card).toContain("（此处折叠")
    expect(card).toContain(`第 199 条用户消息：镜头 199 的构图描述（${"细".repeat(30)}）`)
    expect(card).not.toContain("第 150 条用户消息")
    expect(GOAL_CARD_MAX_TOKENS).toBe(4000)
  })
})
