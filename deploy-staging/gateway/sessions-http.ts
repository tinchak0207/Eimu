// 从 index.ts 无损抽取（2026-09-19 第一阶段）：Sessions HTTP 业务区段。
// 迁出区间：原 index.ts 4928–4972（L0 画像 onboarding＋S7 用户级 Settings）、
// 6320–6365（handleGetSession）、6371–6503（P1-E1 历史读取辅助＋handleGetSessionMessages）。
// 依赖说明：
//  - jsonError：import 自 ./gw-lib.ts
//  - loadUserSettings：import 自 ./persistence（照抄 index.ts 头部 import 符号）
//  - gzipSync：import 自 node:zlib（照抄 index.ts 头部 import 语句）
//  - SessionState：TODO types-gateway.ts 未建（B 路任务），整合时改
//    `import type { SessionState } from "./types-gateway.ts"`；本档先以结构占位型别（只用 apiKey）
//  - getOwnedSession / opencodeHeaders / OPENCODE_URL / TAIL_PAYLOAD_MARKER：仍定义在
//    index.ts（≈1352/1119/462/5394 行），以 declare 占位（bun build 只转译不查名），
//    整合阶段接线时替换为正式 import
import { gzipSync } from "node:zlib"
import { loadUserSettings } from "./persistence"
import { jsonError } from "./gw-lib.ts"
import type { SessionState } from "./types-gateway.ts"
import { MergedReplayFrame } from "./replay-frame.ts"
import { isSystemWakeText } from "./system-wake.ts"
import { getOwnedSession } from "./sessions-core.ts"
import { TAIL_DATA_MARKER, TAIL_PAYLOAD_MARKER, GW_TOKEN_RE } from "./messages-gw.ts"
import { opencodeFetch } from "./opencode-client.ts"
import { t2sVisibleText } from "./outbound-sanitize.ts"

// L0 画像 onboarding：账户还没有任何确认过的画像时，引导 agent 用 question 工具
// 以选择题采集画像（PM 原则：别让用户动脑写表单）。答案存 pendingProfile，
// 下次建会话时作为临时画像注入（站点 DB 落库前的过渡方案）。
export const PROFILE_ONBOARDING_DIRECTIVE = [
  "这个账户还没有画像记录。开场简短欢迎一句，先问用户今天想做什么。",
  "画像信息（行业/常做素材/风格偏好）在对话中自然了解即可，不要用 question 工具刻意采集，更不要一次问多道题。",
  "若用户直接说出任务，直接开工，别问画像。",
].join("\n")

// ── S7（2026-08-29）：用户级 Settings（罪状6 网关侧真实 Adapt）─────────────
// 存 sessions.db user_settings 表（key 维度，owner_key 与 sessions 表同一 key、
// 同一归一化方式），重启不丢。GET 无记录回默认值；POST 部分更新、非法值 400。
// Adapt 两条腿：
//   1. system 指令：persona/cost_mode 每轮注入 promptBody.system（不是只首轮；
//      balanced 不注入成本线）。
//   2. 等待容忍窗：persona=thoughtful 时 ack/心跳延迟 ×1.5（思考本来就久，
//      30s 就说「收到」是骚扰）；实现为投递时按 settings 计算延迟，不改全局常量。
// 模型思考强度（cost_mode → 真实模型切换）本期不落地，如实原因见任务报告：
// opencode.jsonc 无第二个可用模型、有效配置 small_model 与主模型相同
// （b-ai/glm-5.3-flash），PATCH /session/:id 200 但 model 无落地证据。
const DEFAULT_USER_SETTINGS: UserSettingsShape = { interrupt_mode: "steer", persona: "efficient", cost_mode: "balanced", interaction_mode: "preset" }
// 野兽模式开关（MOE 改革，2026-09-08）：settings 布林栏，缺省=false（零回归）。
// 不入 USER_SETTINGS_ENUMS（那是枚举字串栏白名单）；POST 专门放行本栏（仅接受
// 真布林），sanitize 显式列出栏位、缺栏=保持现值。
export type UserSettingsShape = { interrupt_mode: string; persona: string; cost_mode: string; interaction_mode: string; beast_mode?: boolean }
export const USER_SETTINGS_ENUMS: Record<Exclude<keyof UserSettingsShape, "beast_mode">, readonly string[]> = {
  interrupt_mode: ["steer", "queue"],
  persona: ["efficient", "thoughtful"],
  cost_mode: ["economy", "balanced", "premium"],
  interaction_mode: ["collaborate", "preset", "auto"],
}

/** 任意输入 → 合法 settings（非法栏位值一律回落默认，写入路径另有 400 校验）。 */
export function normalizeUserSettings(raw: unknown): UserSettingsShape {
  const s: UserSettingsShape = { ...DEFAULT_USER_SETTINGS }
  if (raw && typeof raw === "object" && !Array.isArray(raw)) {
    const r = raw as Record<string, unknown>
    for (const k of Object.keys(USER_SETTINGS_ENUMS) as Exclude<keyof UserSettingsShape, "beast_mode">[]) {
      const v = r[k]
      if (typeof v === "string" && USER_SETTINGS_ENUMS[k].includes(v)) s[k] = v
    }
  }
  return s
}

/** 性格 → 等待容忍倍率：thoughtful ×1.5，efficient（及未知值）默认 1。 */
export function personaPatienceMul(state: SessionState): number {
  return loadUserSettings(state.apiKey)?.persona === "thoughtful" ? 1.5 : 1
}

// GET /agent/v1/sessions/:id — 会话恢复端点（重启后历史仍在的读取路径）。
// 历史从 opencode（权威存储）读取；getOwnedSession 内含 DB lazy reload，
// 因此进程重启后仍可解析。只读，不改任何状态、不动 CORS/SSE/ticket 行为。
export async function handleGetSession(key: string, id: string): Promise<Response> {
  const state = getOwnedSession(key, id)
  if (!state) return jsonError(404, "session not found", "not_found", "not_found")
  try {
    const res = await opencodeFetch(`/session/${state.opencodeSessionId}/message`, {
      timeoutMs: 15_000,
    })
    if (!res.ok) {
      // upstream opencode session 已不在（被外部清理等）：仍回会话元数据，标记历史不可用。
      return Response.json({
        session_id: id,
        opencode_session_id: state.opencodeSessionId,
        history_available: false,
        message_count: 0,
        messages: [],
      })
    }
    const msgs = (await res.json()) as Array<{
      info?: { role?: string; time?: { created?: number } }
      parts?: Array<{ type?: string; text?: string }>
    }>
    const messages = (Array.isArray(msgs) ? msgs : []).map((m) => ({
      role: m.info?.role ?? "unknown",
      created_at: m.info?.time?.created ?? null,
      text: (m.parts ?? [])
        .filter((p) => p.type === "text" && typeof p.text === "string")
        .map((p) => p.text as string)
        .join("\n")
        .slice(0, 20_000),
      has_tool_parts: (m.parts ?? []).some((p) => p.type === "tool"),
    }))
    return Response.json({
      session_id: id,
      opencode_session_id: state.opencodeSessionId,
      history_available: true,
      message_count: messages.length,
      messages,
    })
  } catch {
    return jsonError(502, "opencode backend unreachable", "backend_unreachable", "backend_error")
  }
}

// P1-E1：对话 transcript 端点。真源是 opencode（gateway 不另存 messages，
// 见 L3496 注释——那是第二份会漂移的历史副本）。返回轻量结构：每条 message
// 只保留 role + text/tool parts，tool part 带完整 input（prompt/lora/model/
// size 在此），供前端「存为资产」提取真配方。输出/图片等重 payload 一律不带。
// GET /agent/v1/sessions/:id/messages — 全量历史端点（2026-09-12 永久保留改造）。
// 鉴权与 GET /agent/v1/sessions/:id 完全同构：Bearer 闸门 + getOwnedSession（owner 校验 +
// DB lazy hydrate，reaped/重启后的 row 可读）。返回带游标的物件（前端契约）：
//   { messages: <opencode 消息瘦身阵列（同构 [{info,parts}]，栏位白名单）>, event_counter: <当前计数器>,
//     replay_first_id: <replayBuffer 最旧帧 id，无缓冲则 null> }
// event_counter 给前端做 SSE 续传游标：restore 全史后 openConnection(counter) 只接增量。
// 上游不可达/非 2xx/会话无 messages → 200 且附 fallback:"replay_only"（前端退回回放兜底）。
// 瘦身：前端唯一消费者 normalizeOpenCodeMessages 只读 info.role + text/reasoning/tool/file
// 四类 part 的少数栏位（实测 tool.state.output/metadata 与 info 冗余栏位占 payload ~80%），
// 白名单外栏位一率删除；输出保持 [{info,parts}] 同构契约，未知 part 型别整块丢弃。
// 防呆：读路径宁跳不炸——任何单则/单 part 处理异常只丢弃该项，函数永不抛错。
// GW_TOKEN_RE 带 g 旗标：String.replace 全域抹除安全，但 .test()/.exec() 会因
// lastIndex 残留而误判；需要「位置判据」时在函数内惰性构造无 g 副本。
// 2026-10-18 TDZ 修复：顶层读 GW_TOKEN_RE.source 会在单独 import messages-gw 的
// 循环依赖里触发未初始化绑定。改为呼叫时读取，模块求值阶段不碰该绑定。
function gwTokenNoG(): RegExp {
  return new RegExp(GW_TOKEN_RE.source, "i")
}

/** 0918：剥掉网关注入的 user 讯息尾端 payload（野兽帧等，见
 *  appendSystemPayloadToTurnTail）。只用在显示读路径（slimHistoryMessages）；
 *  模型上下文由 opencode 持有、不经此函式，故不影响模型看到的内容。
 *  2026-10-11 收紧：真注入件恒为「标记＋紧随其后的网关凭证 ⟦gw:<nonce>⟧」，
 *  仅此形状才从标记处截断；标记后无凭证＝用户自写的同形标题行，原样返回，
 *  不吃掉其后正文（Hacker 实证：用户写标记会截断自己消息后半段）。
 *  2026-10-11 边角补正：改用「扫描第一个后面（允许空白）紧跟网关凭证的标记」，
 *  而不是只看第一个标记——边界：用户自写的同形标记（后无凭证）不截断、其后正文保留；
 *  该标记之后若真有注入块（带凭证）→ 从真注入块那处截断（用户气泡不再露出内部注入正文）。
 *  2026-10-18：无凭证的资料块（模板偏好等）使用 TAIL_DATA_MARKER，恒定可从标记处剥离。
 *  找不到可剥离标记＝原样返回（零回归）。 */
function stripTailInjectedPayload(text: string): string {
  // 资料块无凭证，但标记是网关专属：先按它截断。
  const dataMarker = TAIL_DATA_MARKER.trim()
  const dataAt = text.indexOf(dataMarker)
  if (dataAt >= 0) text = text.slice(0, dataAt).trimEnd()
  const marker = TAIL_PAYLOAD_MARKER.trim()
  // 逐次寻找标记出现处；每处只看其后（允许空白）是否紧跟凭证（位置判据用无 g 副本，
  // 该副本无 g 旗标故 .exec 无 lastIndex 残留）。第一个带凭证的标记＝真注入起点。
  let from = 0
  for (;;) {
    const i = text.indexOf(marker, from)
    if (i < 0) return text
    const rest = text.slice(i + marker.length).replace(/^\s*/, "")
    const m = gwTokenNoG().exec(rest)
    if (m && m.index === 0) return text.slice(0, i).trimEnd()
    // 该标记后无凭证（用户自写）：跳过它，继续找后面真正带凭证的标记。
    from = i + marker.length
  }
}

export function slimHistoryMessages(msgs: unknown[]): unknown[] {
  const out: unknown[] = []
  for (const rawMsg of msgs) {
    try {
      if (rawMsg === null || typeof rawMsg !== "object" || Array.isArray(rawMsg)) continue
      const msg = rawMsg as Record<string, unknown>
      const infoSrc = msg.info !== null && typeof msg.info === "object" && !Array.isArray(msg.info)
        ? (msg.info as Record<string, unknown>)
        : null
      const info: Record<string, unknown> = {}
      if (infoSrc) {
        if (typeof infoSrc.id === "string") info.id = infoSrc.id
        if (typeof infoSrc.role === "string") info.role = infoSrc.role
      }
      const partsSrc = Array.isArray(msg.parts) ? (msg.parts as unknown[]) : []
      // H14 补完：user 讯息首个 text part 为系统唤醒文本 → 历史回放呈现为 system（显示层，不改模型上下文）。
      if (info.role === "user" && partsSrc.some((p) => {
        const q = p as Record<string, unknown> | null
        return !!q && q.type === "text" && isSystemWakeText(q.text)
      })) info.role = "system"
      const parts: unknown[] = []
      for (const rawPart of partsSrc) {
        try {
          if (rawPart === null || typeof rawPart !== "object" || Array.isArray(rawPart)) continue
          const part = rawPart as Record<string, unknown>
          const type = part.type
          if (type === "text" || type === "reasoning") {
            // 0918：历史端点是「显示」通道——剥掉网关附在 user 讯息尾端的注入
            // payload（野兽帧等，见 appendSystemPayloadToTurnTail），否则用户
            // 气泡会被 17.2k 字的派遣协议正文灌爆。模型上下文由 opencode 持有、
            // 不经本函式，故剥除不改变模型看到的内容（纯显示层过滤）。
            if (type === "text" && (info.role === "user" || info.role === "system") && typeof part.text === "string") {
              // 2026-10-10：历史端点是用户可见的显示通道，出站文字同样过一次 T2S
              // 收口（SSE 帧已由 sse-core 收口，此端点原样透传 opencode 存储文本，
              // 刷新/重进会话时模型正文会从简体变回繁体）。仅对非 user 讯息转换，
              // 用户自己输入的文字逐字保留；转换在剥离之后进行。
              let text = stripTailInjectedPayload(part.text)
              // 2026-10-11 缺口C：顺序＝先剥离尾端注入块、再抹除会话凭证 ⟦gw:<nonce>⟧、
              // 最后才 T2S。真注入块与模型复述会把会话级凭证/内部提示原文写进存储文本，
              // 而历史端点是用户可见通道（SSE 干净、只有此处漏）。凭证一律抹为空串
              // （不换成「已移除」字样：不在用户正文里发明文字）。
              text = text.replace(GW_TOKEN_RE, "")
              if (info.role !== "user") text = t2sVisibleText(text)
              // 剥离后为空串：该 text part 的内容全部是网关注入（无 text part 的罕见分支里，
              // nudge 以标记开头被整段截掉）——整块丢弃，避免前端渲染出空气泡。
              if (text.length === 0) continue
              parts.push({ ...part, text })
              continue
            }
            if (typeof part.text === "string") {
              // 非上述分支的 text/reasoning（含 assistant 正文与 assistant/user 的 reasoning）：
              // 同样抹除凭证；非 user 再过 T2S，user 自己输入的文字逐字保留（凭证除外）。
              let text = part.text.replace(GW_TOKEN_RE, "")
              if (info.role !== "user") text = t2sVisibleText(text)
              parts.push(text === part.text ? part : { ...part, text })
              continue
            }
            parts.push(part)
            continue
          }
          if (type === "file") {
            const f: Record<string, unknown> = { type: "file" }
            for (const k of ["url", "mime", "filename", "size"] as const) {
              if (part[k] !== undefined) f[k] = part[k]
            }
            parts.push(f)
            continue
          }
          if (type === "tool") {
            const stSrc = part.state !== null && typeof part.state === "object" && !Array.isArray(part.state)
              ? (part.state as Record<string, unknown>)
              : null
            const st: Record<string, unknown> = {}
            if (stSrc) {
              if (stSrc.status !== undefined) st.status = stSrc.status
              if (stSrc.input !== undefined) {
                let s: string
                try {
                  s = typeof stSrc.input === "string" ? stSrc.input : JSON.stringify(stSrc.input)
                } catch {
                  s = ""
                }
                if (s.length > 500) s = s.slice(0, 500)
                st.input = s
              }
              if (typeof stSrc.error === "string") {
                if (stSrc.error.length > 0) st.error = stSrc.error
              } else if (stSrc.error !== null && typeof stSrc.error === "object" && !Array.isArray(stSrc.error)) {
                const em = (stSrc.error as Record<string, unknown>).message
                if (typeof em === "string") st.error = { message: em }
              }
            }
            const tool: Record<string, unknown> = { type: "tool", state: st }
            const name = typeof part.tool === "string" ? part.tool : typeof part.name === "string" ? part.name : undefined
            if (name !== undefined) tool.tool = name
            parts.push(tool)
            continue
          }
          // step-start / step-finish / compaction / patch / snapshot / 未知型别：丢弃。
        } catch { /* 单 part 坏数据：跳过 */ }
      }
      out.push({ info, parts })
    } catch { /* 单则坏数据：跳过 */ }
  }
  return out
}

export async function handleGetSessionMessages(key: string, id: string): Promise<Response> {
  const state = getOwnedSession(key, id)
  if (!state) return jsonError(404, "session not found", "not_found", "not_found")
  const cursor = {
    event_counter: state.eventCounter,
    replay_first_id:
      state.replayBuffer.length > 0
        ? state.replayBuffer[0] instanceof MergedReplayFrame
          ? state.replayBuffer[0].firstId
          : state.replayBuffer[0].id
        : null,
  }
  try {
    const res = await opencodeFetch(`/session/${state.opencodeSessionId}/message`, {
      timeoutMs: 30_000,
    })
    if (!res.ok) {
      return Response.json({ messages: [], ...cursor, fallback: "replay_only" })
    }
    const msgs: unknown = await res.json()
    if (!Array.isArray(msgs) || msgs.length === 0) {
      return Response.json({ messages: [], ...cursor, fallback: "replay_only" })
    }
    // 成功路径体积大（实测单会话 452KB），瘦身后再 gzip 传输；降级路径体积小维持原样。
    const payload = { messages: slimHistoryMessages(msgs), ...cursor }
    return new Response(gzipSync(Buffer.from(JSON.stringify(payload))), {
      headers: { "Content-Type": "application/json", "Content-Encoding": "gzip" },
    })
  } catch {
    return Response.json({ messages: [], ...cursor, fallback: "replay_only" })
  }
}
