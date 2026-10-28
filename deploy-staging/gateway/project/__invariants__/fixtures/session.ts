// 200 步合成会话 + 上下文计划应用器 + fake opencode 记录器。
// 会话内容全部由本档按固定种子生成（不读生产库）；期望值就是这里写死的用户原话。
import { recorderOf } from "./recorder.ts"

export interface AgentPartLike {
  type: string
  text?: string
  synthetic?: boolean
  id?: string
  tool?: string
  callID?: string
  state?: { status?: string; output?: string }
  bytes?: number
  [k: string]: unknown
}
export interface AgentMessageLike {
  info: { id: string; role: string; sessionID?: string; summary?: boolean; time?: { created?: number } }
  parts: AgentPartLike[]
}

const T0 = Date.parse("2026-10-28T00:00:00.000Z")
const iso = (ms: number) => new Date(ms).toISOString()

/** 21 条用户原话：含 emoji、换行、纠正/授权类；第 6 条是 >12000 字的超长需求。 */
export const USER_TEXTS: string[] = [
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
  "第二镜的杯子要在光里，别逆光",
  "字幕不要挡住人物脸",
  "配乐音量降一点，旁白要听清",
  "导出前再检查一次时长",
  "封面用第三镜的构图",
  "收工：给我 mp4 和封面图",
]

/** 超长单条（>12000 字）：验证 ingress 单条截断与目标卡折叠规则。 */
export const LONG_TEXT = `这是一条超长需求，用来验证 ingress 单条 12000 字截断与目标卡折叠规则。\n${"细节".repeat(7000)}`
/** >12000 字的那一条在 USER_TEXTS 里的下标。 */
export const LONG_INDEX = 5

function textsWithLong(): string[] {
  const copy = [...USER_TEXTS]
  copy[LONG_INDEX] = LONG_TEXT
  return copy
}

export interface LongSession {
  messages: AgentMessageLike[]
  /** 每轮用户消息在数组里的下标。 */
  rounds: number[]
  texts: string[]
  /** 每轮用户消息 id（brief 的 messageId）。 */
  messageIds: string[]
}

const STEP_KINDS = [0, 1, 2, 3] as const

/**
 * 200 个 assistant 步：20 轮 × 10 步 + 第 21 条用户消息（尾部无步）。
 * 步型循环：完成工具对 / 未完成工具调用 / 纯文本 / 带图片附件。
 */
export function buildLongSession(): LongSession {
  const texts = textsWithLong()
  const messages: AgentMessageLike[] = []
  const rounds: number[] = []
  const messageIds: string[] = []
  let t = T0
  let step = 0
  for (let u = 0; u < texts.length; u++) {
    const id = `msg_u${u}`
    messages.push({ info: { id, role: "user", sessionID: "ses_inv", time: { created: t++ } }, parts: [{ type: "text", text: texts[u] }] })
    rounds.push(messages.length - 1)
    messageIds.push(id)
    const stepsHere = u === texts.length - 1 ? 0 : 10
    for (let s = 0; s < stepsHere; s++) {
      const kind = STEP_KINDS[(step + s) % STEP_KINDS.length]
      const aid = `msg_a${step}`
      if (kind === 0) {
        const big = step % 7 === 0 ? "回执".repeat(4000) : step % 3 === 0 ? "回执".repeat(700) : `tool output ${step}`
        messages.push({
          info: { id: aid, role: "assistant", sessionID: "ses_inv", time: { created: t++ } },
          parts: [
            { type: "tool", id: `prt_call_${step}`, callID: `call_${step}`, tool: "project_get", state: { status: "completed", output: `{"ok":true,"step":${step}}` } },
            { type: "text", text: `第 ${step} 步：已提交节点 n${step}，等待结果。` },
          ],
        })
        messages.push({
          info: { id: `msg_t${step}`, role: "tool", sessionID: "ses_inv", time: { created: t++ } },
          parts: [{ type: "tool", id: `prt_res_${step}`, callID: `call_${step}`, tool: "project_get", state: { status: "completed", output: big } }],
        })
      } else if (kind === 1) {
        messages.push({
          info: { id: aid, role: "assistant", sessionID: "ses_inv", time: { created: t++ } },
          parts: [{ type: "tool", id: `prt_run_${step}`, callID: `call_run_${step}`, tool: "project_run", state: { status: "running", output: "" } }],
        })
      } else if (kind === 2) {
        messages.push({
          info: { id: aid, role: "assistant", sessionID: "ses_inv", time: { created: t++ } },
          parts: [{ type: "text", text: `第 ${step} 步完成：本轮小结（${"x".repeat(120)}）` }],
        })
      } else {
        messages.push({
          info: { id: aid, role: "assistant", sessionID: "ses_inv", time: { created: t++ } },
          parts: [
            { type: "tool", id: `prt_img_${step}`, callID: `call_img_${step}`, tool: "read_image", state: { status: "completed", output: "已读取参考图" } },
            { type: "file", id: `prt_file_${step}`, bytes: 120_000 },
          ],
        })
      }
      step++
    }
  }
  return { messages, rounds, texts, messageIds }
}

/** 本会话的 assistant 步数（必须是 200）。 */
export function stepCount(messages: readonly AgentMessageLike[]): number {
  return messages.filter((m) => m.info.role === "assistant" && m.info.summary !== true).length
}

export interface ContextPlanResponse {
  project_mode: true
  keep_ids: string[]
  synthetic: string
  replacements: { messageId: string; partIndex: number; text: string }[]
  drop_parts: { messageId: string; partIndex: number }[]
  steps: number
  dropped: number
  bytes: number
  tokens: number
}

export function isPlan(value: unknown): value is ContextPlanResponse {
  return !!value && typeof value === "object" && (value as { project_mode?: unknown }).project_mode === true
}

/**
 * 按 `/internal/project/context` 的契约把计划应用到消息数组（插件侧行为）：
 * keep_ids 过滤 → 部件替换 / 剔除 → 合成片段追加到当前用户消息尾部。返回新数组，不改入参。
 */
export function applyContextPlan(messages: readonly AgentMessageLike[], plan: ContextPlanResponse): AgentMessageLike[] {
  const byId = new Map(messages.map((m) => [m.info.id, m]))
  const replacements = new Map(plan.replacements.map((r) => [`${r.messageId}#${r.partIndex}`, r.text]))
  const drops = new Set(plan.drop_parts.map((d) => `${d.messageId}#${d.partIndex}`))
  const kept: AgentMessageLike[] = []
  for (const id of plan.keep_ids) {
    const msg = byId.get(id)
    if (!msg) continue
    const parts: AgentPartLike[] = []
    msg.parts.forEach((part, i) => {
      const key = `${id}#${i}`
      if (drops.has(key)) return
      const replacement = replacements.get(key)
      if (replacement !== undefined) {
        parts.push({ ...part, text: replacement, ...(part.state ? { state: { ...part.state, output: replacement } } : {}) })
        return
      }
      parts.push({ ...part })
    })
    kept.push({ info: { ...msg.info }, parts })
  }
  const text = plan.synthetic.trim()
  if (text) {
    let target: AgentMessageLike | undefined
    for (let i = kept.length - 1; i >= 0; i--) {
      const m = kept[i]
      if (m.info.role !== "user") continue
      const real = m.parts.some((p) => p.type === "text" && typeof p.text === "string" && p.text.trim() && p.synthetic !== true)
      if (real) {
        target = m
        break
      }
    }
    if (target) {
      target.parts.push({
        id: `prt_eimuproject_${target.info.id}`,
        type: "text",
        text: plan.synthetic,
        synthetic: true,
      })
    }
  }
  return kept
}

/** 用户在最终请求里的原话（排除合成片段与注入标记）。 */
export function userTextsInRequest(messages: readonly AgentMessageLike[]): string[] {
  const out: string[] = []
  for (const m of messages) {
    if (m.info.role !== "user") continue
    for (const p of m.parts) {
      if (p.type !== "text" || typeof p.text !== "string") continue
      if (p.synthetic === true || p.ignored === true) continue
      if (!p.text.trim()) continue
      out.push(p.text)
    }
  }
  return out
}

export function syntheticOf(messages: readonly AgentMessageLike[]): string {
  const parts = messages.flatMap((m) => m.parts).filter((p) => p.synthetic === true)
  return parts.map((p) => String(p.text ?? "")).join("\n")
}

/** 最终请求（发给模型的模型输入快照）→ fake opencode 记录并返回原始字节。 */
export async function sendModelInput(sessionId: string, messages: readonly AgentMessageLike[], system: string): Promise<string> {
  const recorder = recorderOf()
  const body = JSON.stringify({ session_id: sessionId, system, messages })
  await fetch(`${recorder.base}/session/${sessionId}/model-input`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body,
  })
  return body
}

export { iso as invariantIso, T0 as INVARIANT_T0 }
