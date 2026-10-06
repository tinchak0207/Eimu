/**
 * subagent.ts — 子代理运行时（Orchestrator 派工）。
 *
 * 主代理通过 workspace 工具 subagent_dispatch 调 POST /internal/subagent/dispatch，
 * 本模块为父会话创建子 opencode 会话并 prompt_async 投递任务书。子会话事件本就
 * 流经网关的全局 /event tap（index.ts handleOpencodeEvent 开头按 sessionID 查
 * 本模块注册表，命中即转发到这里），翻译成 subagent.* 帧发到父会话的 SSE clients：
 *   - subagent.started { id, label }
 *   - subagent.delta   { id, text, kind? }（子会话 assistant 增量：正文不带 kind，
 *                       思维链带 kind:"reasoning"——跑马灯据此区分）
 *   - subagent.done    { id, status: "ok"|"error", summary }
 * 子会话 idle（对齐主路径的 idle 语义）→ 取最后一条 assistant 文本作 summary（行内
 * 只留 600 字）→ **完整全文先落盘 workspace/outputs/subagent/（E 片，2026-09-12）** →
 * 从注册表摘除 → DELETE 子 opencode 会话防堆积。单子代理 15 分钟硬顶，到点 done
 * status=error。
 *
 * 模型路由（2026-08-31 补）：子代理不再吃 opencode 预设模型，而是继承父会话
 * persona 的主模型 + registry fallbacks 链（与主路径 personaModelForAttempt 同源）。
 * 上游模型错误（opencode APIError 形状 {name, data:{message}}）时自动换下一个模型
 * 重投；错误原文经 opencodeErrorMessage 透传进 done，不再被 .message 直读吞掉
 * （2026-08-31 事故：shuai 输出审核 DataInspectionFailed 被显示成「子代理上游错误」）。
 *
 * 并发上限：每个父会话最多 3 个活跃子代理，第 4 个 dispatch 返回 busy 文案，
 * 工具原样转给主代理。
 */

import { chmodSync, mkdirSync, readFileSync, writeFileSync, readdirSync, statSync } from "node:fs"
import { join } from "node:path"
// 刀 2B/刀 3（2026-09-19）：Jev 权威闸——spec 注入隔离＋expert 路由＋sync 资格。
// 量级瘦身 A：spec 模板机器注入（playbook 2.0 起模板不进 orchestrator 上下文）。
import { guardExpertContent, musicFirstBlockReason, isReworkSpec, reworkLockDirective, quarantineSpec, routeExpertAuthoritative, syncDispatchEligible, classifyDispatchMeta, classifyDispatchGuards, workflowTemplateDirective, type JevDispatchGuards } from "./jev-gate"
// 任务状态枚举真源（0920 收口）：running/ok/error/stopped 以此为准，禁散布裸字串。
import type { TaskStatus } from "./types-gateway.ts"
// 0920：模板判定即建骨架（不等 Expert）——workflowService 是纯 service 模组，
// workflow-gw 不 import subagent，无循环风险。
import { workflowService, workflowOwnerBySession } from "./workflow-gw"
import { templatePlaceholderContent } from "./workflow-templates"
// 2026-10-02：派工时把「画布模板空位」当系统事实注入子代理任务书（专家看不到画布，
// 只能凭印象另起炉灶 → 模板被架空）。buildTemplateSlotsFact 为纯读函式，无值回 null
// （此路径输出与注入前逐字元等价）。reverse import 与 canvas-cascade-state→subagent 的既有
// 循环同型，两端均在呼叫期使用绑定（非模组顶层求值），bun ESM 循环安全。
import { buildTemplateSlotsFact, getTemplateDeviateToken } from "./canvas-cascade-state.ts"
// FIX-A（2026-10-02）：子代理工具结果的媒体成品出卡——共用主路径的成品 URL 提取器与
// emitVideoDone/emitAudioDone（不另造第二套）。events-translate↔sessions-core↔subagent 的
// 循环与 canvas-cascade-state↔subagent 同型，两端均在呼叫期使用绑定，bun ESM 循环安全。
import { parseToolOutput, collectToolOutputMediaUrls, emitVideoDone, emitAudioDone, attachCanvasTask } from "./events-translate.ts"
// 片 C（2026-09-15）：Expert 交付契约的机器强制点。纯函数模组，零 gateway 内部依赖。
// 片 D（2026-09-15）：追加 REWORK_FAIL_MARK/buildReworkDirective——FAIL 时机器化重派一次。
import {
  checkDelivery,
  formatDeliveryGateNotice,
  buildReworkDirective,
  renderContractDirective,
  shouldTriggerCriticPass,
  buildCriticPassSpec,
  criticVerdictRejected,
  CRITIC_REJECT_MARK,
  CRITIC_PASS_MARK,
  CRITIC_PASS_MAX_TARGETS,
  REWORK_FAIL_MARK,
  ORPHANED_GATE_MARK,
  DELIVERY_CONTRACTS,
  // 2026-10-03：数值阈值判定的代码强制入口（纯函数；政策＝CRITIC_SCORE_THRESHOLD_POLICY）。
  evaluateCriticScoreThreshold,
  CRITIC_SCORE_THRESHOLD_POLICY,
  // 2026-10-04 F10：done 摘要从源头过用户可见白名单（内审/契约内部文字不上桌）。
  // F10 起与 sse-core 咽喉点、index.ts 唤醒路径共用同一纯函数 scrubSubagentPayload。
  scrubSubagentPayload,
  type CriticScoreSample,
  type DeliveryGateResult,
  type CriticPassTarget,
} from "./delivery-gate"
// 刀 F（2026-09-15）：in-flight rework run 持久化 + 启动孤儿治理（复用 persistence.ts
// 同一 bun:sqlite 层，非自造第二套持久层）。finishRun 终态删、startRework 成功写。
import {
  saveReworkRecord,
  loadReworkRecords,
  deleteReworkRecord,
  markCriticPass,
  hasCriticPass,
  deleteCriticPass,
  // D7（2026-10-02）：品质量测基座写入（fail-open；量测不得影响交付）。
  saveCriticVerdict,
  saveExpertLesson,
  saveDelivery,
  type ReworkRecord,
} from "./persistence"
// 2026-10-03：事后产物硬检（确定性量测；gateway 侧移植，见 media-quality.ts 档头）。
// 只回技术分（非审美）；量测失败一律 null，绝不让交付主流程受阻。
import { measureMediaScore, MEDIA_QUALITY_MEASURED_MARK, type MeasuredMediaResult } from "./media-quality.ts"

// P2b（2026-09-11）刀1：任务书首行自动补「预期 N 分钟」死线行。
// 任何派遣若首行没有「预期 N」，补上 5 分钟 → R1 parseSyncDeadlineMs 得
// min(2*5,4)=4 分钟 = 240s 同步硬死线，主会话不再被无死线子代理长期锁住。
// 已自带「预期/预期 N」的任务书原样不动（避免双补）。
const SPEC_DEADLINE_LINE = "\n预期 5 分钟（超 2x 杀线）。\n"

const MAX_ACTIVE_PER_PARENT = 3
const HARD_TIMEOUT_MS = 15 * 60 * 1000 // 单子代理硬顶
// R6（2026-09-10）：async 子代理无工具轮询死线顶著，军团研究/创作任务合法更长，
// 硬顶放宽到 30 分钟；超时同样走 finishRun(error) → 唤醒父会话如实汇报。
const ASYNC_HARD_TIMEOUT_MS = 30 * 60 * 1000
// F8（2026-10-04）断面 B：async 子代理「子会话孤儿」活性检测。
// 病灶（F7 取证）：部署重启 opencode-server 会把在途子会话原地杀死并孤儿化，gateway
// 无「子会话丢失」检测 → 一路静默等到 30 分钟硬顶（ASYNC_HARD_TIMEOUT_MS）才收束，
// 用户体感 4 分钟 → 30 分钟。判据见 evaluateRunLiveness：async run 在「无在途工具 +
// 超过阈值无任何子会话事件/part 写入」时判 stale → 立即 finishRun(error) 走既有唤醒链
// 收束父会话。阈值默认 120s（SUBAGENT_STALE_MS 覆写）；30 分钟硬顶保留为最后兜底，不删。
const SUBAGENT_STALE_DEFAULT_MS = 120_000
const SUBAGENT_LIVENESS_POLL_DEFAULT_MS = 15_000
function subagentStaleMs(): number {
  const n = Number.parseInt(process.env.SUBAGENT_STALE_MS || "", 10)
  return Number.isFinite(n) && n >= 30_000 ? n : SUBAGENT_STALE_DEFAULT_MS
}
function subagentLivenessPollMs(): number {
  const n = Number.parseInt(process.env.SUBAGENT_LIVENESS_POLL_MS || "", 10)
  return Number.isFinite(n) && n >= 3_000 ? n : SUBAGENT_LIVENESS_POLL_DEFAULT_MS
}
// 用户可见层文案（简体、无栏名/runId/token/内部路径）：经 finishRun → wakeParent 的
// scrubSubagentPayload 白名单后上桌。
const SUBAGENT_STALE_MESSAGE =
  "这一路子代理中途断开了（长时间没有任何进展），结果没有取回。已中断这一路并通知主流程，请重新派一次。"
const SUMMARY_MAX_CHARS = 600
// 2026-10-02 能力片：ok 摘要（最后一则有文字的 assistant 讯息）的明确字数上限。子代理末则
// 文字可能上万字，若不设上限会让 subagent.done 的 SSE 帧与注入父会话的唤醒文案膨胀——与本轮
// 「控制上下文与工具结果大小」的目标直接矛盾（同轮工具结果已设 50,000 字上限，摘要口径 4000）。
// 超过即在换行边界截断并附「已截断」提示；全文仍走既有落盘指标，不丢资讯。
export const SUBAGENT_SUMMARY_MAX_CHARS = 4000
// E 片（2026-09-12）缺陷一：行内 600 字帽保留，但完整结果先落盘再 DELETE 子会话。
// 09-12 实案：数千字作曲规格文档在行内被截到「m16 属…」，子会话随即被 DELETE，
// 全文不可恢复；同一次上游 502 的长死因也被切掉。落盘根 = gateway WORKSPACE_DIR
// （index.ts:570 同值；gateway 进程 WorkingDirectory=/opt/agent-harness/gateway，
// workspace 真身 /opt/agent-harness/workspace，opencode server 的 --dir 就是它）。
const SUBAGENT_OUTPUT_REL = "outputs/subagent"
const SUBAGENT_OUTPUT_DIR = "/opt/agent-harness/workspace/outputs/subagent"
const PERSIST_TAIL = "[gateway 落盘: 完整结果未截断]"
const COMPLETED_TTL_MS = 10 * 60 * 1000 // status 轮询窗口，过期即弃
export const SUBAGENT_BUSY_MESSAGE = "已有 3 个子代理在跑，等一个完成再派"

// R1（2026-09-11）：同步 dispatch 硬 deadline 解析。任务书首行/正文自带估时
// 「预期 N 分钟 / 预期 N 分钟」（容忍中英、容忍小数）→ deadline = min(2N, 4) 分钟；
// 解析不到 → 预设 180 秒。评测 P0：spec 自写「预期 4 分钟」而同步派发无任何死线，
// 主会话被锁 651 秒、正文 0 字。
const SYNC_DEADLINE_DEFAULT_MS = 180_000
const SYNC_DEADLINE_MAX_MS = 4 * 60_000
function parseSyncDeadlineMs(prompt: string): number {
  const m = /[预预]\s*期\s*([0-9]+(?:\.[0-9]+)?)\s*(?:分钟|分钟|min(?:ute)?s?)/i.exec(prompt || "")
  if (!m) return SYNC_DEADLINE_DEFAULT_MS
  const n = Number.parseFloat(m[1])
  if (!Number.isFinite(n) || n <= 0) return SYNC_DEADLINE_DEFAULT_MS
  return Math.min(n * 2 * 60_000, SYNC_DEADLINE_MAX_MS)
}

/** ok 摘要截断（2026-10-02 能力片）：超过 SUBAGENT_SUMMARY_MAX_CHARS 时在换行边界断开
 *  （换行太靠前 <60% 则硬切），回传保留文字与被截字元数。纯函数。 */
function truncateSummaryText(text: string): { text: string; truncated: number } {
  if (typeof text !== "string" || text.length <= SUBAGENT_SUMMARY_MAX_CHARS) {
    return { text: typeof text === "string" ? text : "", truncated: 0 }
  }
  const head = text.slice(0, SUBAGENT_SUMMARY_MAX_CHARS)
  const nl = head.lastIndexOf("\n")
  const cut = nl > SUBAGENT_SUMMARY_MAX_CHARS * 0.6 ? nl : SUBAGENT_SUMMARY_MAX_CHARS
  const kept = text.slice(0, cut)
  return { text: kept, truncated: text.length - kept.length }
}

/**
 * F8（2026-10-04）断面 B：async 子代理活性判定（纯函数，探针/单测可直接喂输入）。
 *
 * 病灶（F7 取证）：部署重启 opencode-server 把在途子会话原地杀死并孤儿化，gateway
 * 无「子会话丢失」检测 → 静默等到 30 分钟硬顶才收束（用户 4 分钟体感 → 30 分钟）。
 *
 * 判「失活(stale)」需同时满足（缺一即放行）：
 *   ① status==="running" 且非 stopped、非重派在途（reworking）；
 *   ② async 模式（同步 run 有 deadlineTimer 先放行、主会话有工具轮询解锁，不在此判）；
 *   ③ **无在途工具**（pendingToolCount===0）——防误杀的关键：正在跑的工具（如
 *      music_gen 真生成 150-180s）长时间不产生新 part 属正常，必须放行；
 *   ④ 距最近一次子会话事件（lastActivityAt）已 ≥ staleMs。
 * 正常流式生成每个 delta/part 都会刷新 lastActivityAt（handleSubagentEvent 首行打点）；
 * 只有「子会话已被孤儿化、永不再写入」才会同时满足 ③④。30 分钟硬顶保留为最后兜底。
 */
export interface RunLivenessInput {
  status: string
  stopped?: boolean
  asyncMode: boolean
  reworking?: boolean
  now: number
  lastActivityAt: number
  pendingToolCount: number
  staleMs: number
}
export interface RunLivenessVerdict {
  stale: boolean
  reason?: "silent_no_pending_tool"
}
export function evaluateRunLiveness(input: RunLivenessInput): RunLivenessVerdict {
  if (input.status !== "running") return { stale: false }
  if (input.stopped === true) return { stale: false }
  if (input.asyncMode !== true) return { stale: false }
  if (input.reworking === true) return { stale: false }
  if (input.pendingToolCount > 0) return { stale: false }
  if (input.now - input.lastActivityAt >= input.staleMs) return { stale: true, reason: "silent_no_pending_tool" }
  return { stale: false }
}

interface SubagentModelRef {
  providerID: string
  modelID: string
}

// 2026-10-02 能力片：子代理回传契约收敛的用量计数（设计取自 Claude Code 同步子代理
// 回传 {totalToolUseCount,totalDurationMs,totalTokens} 形态，未复制其程式码）。
// 只随 subagent.done 以新栏位输出，既有 id/status/summary 语义一字不动。
export interface SubagentUsage {
  tool_calls: number
  duration_ms: number
  tokens: number
}

interface SubagentRun {
  id: string
  parentGatewaySessionId: string
  parentOpencodeSessionId: string
  opencodeSessionId: string
  label: string
  startedAt: number
  // 0920 停止闸：新增 "stopped"——用户／orchestrator 主动停止**不是失败**，
  // 此前复用 error 导致卡片显示「失败」（实锤：停止成功却被假判定为失败）。
  status: TaskStatus
  summary?: string
  error?: string
  // 任务书与模型链：上游错误时换新子会话、下一模型重投。
  prompt: string
  modelChain: SubagentModelRef[]
  attempt: number // 1-based，索引进 modelChain
  // 子会话 messageID → role（与主路径 messageRole 同语义：role 只在 message.updated 出现）
  messageRole: Map<string, string>
  // partID → 已发字符数（message.part.updated 全量补发时只发未发后缀）
  partEmitted: Map<string, number>
  // 野兽模式快照：dispatch 时取自父会话 settings；重试换模重投沿用同一快照。
  beastMode: boolean
  // R8 修复片2（2026-09-10）：Expert 路由输入端。dispatch 入口按 expert-ids.json
  // 白名单校验后写入（仅 beast_mode ON 生效）；dispatchAttempt 把它带进 prompt_async
  // body 的 agent 栏（opencode 已验证支持），子会话即挂对应 Expert 的裁剪工具表。
  agent?: string
  // R6（2026-09-10）：async=true → 投递后立即返回，终态时 deps.wakeParent 唤醒父会话。
  asyncMode: boolean
  // partID → 类型（"text" | "reasoning"）：delta 事件自身不带类型，靠先行的
  // message.part.updated 登记（raw capture 实锤 part.updated -> delta -> delta）。
  // S3（2026-09-11）：reasoning 增量放行转发（带 kind 区分），正文照旧不带 kind。
  partKind: Map<string, "text" | "reasoning">
  // step-start/unknown part 的 partID：其 delta 照旧丢弃（对齐主路径
  // suppressedParts 丢弃语义；只放行 reasoning 与正文两类）。
  suppressedParts: Set<string>
  // 修 3（2026-10-02）：message.part.updated 带完整 text，按 partID 保存最新全文；
  // 逾时/中止（partial 落盘）时 join 成正文。有界 Map（同 suppressedParts 口径）。
  partText: Map<string, string>
  // 修 3：本 run 落盘标记 partial（persistRunOutput 据此把「状态」写成 partial）。
  partialPersist?: boolean
  // 2026-10-02 能力片：子代理用量计数（summarizeChild 从 opencode message 列表算出）。
  // 只在 summarizeChild 路径赋值；逾时/错误/重派回收路径为 undefined（done 不带 usage 栏）。
  usage?: SubagentUsage
  timeoutTimer?: ReturnType<typeof setTimeout>
  // R1（2026-09-11）：同步 dispatch 硬 deadline 计时器。到点只把「超时」这一事实
  // 兑现给主会话（写进 completed，工具轮询立刻取件解锁），run 不杀——降为 async
  // 续跑，完成后照样走既有 wakeParent 回填通路。
  deadlineTimer?: ReturnType<typeof setTimeout>
  // D5（2026-10-02）：心跳 + 逾时前部分交付计时器（见 armHeartbeat）。摘除时必须清。
  heartbeatTimer?: ReturnType<typeof setInterval>
  earlyPartialTimer?: ReturnType<typeof setTimeout>
  // F8（2026-10-04）断面 B：活性检测状态。
  //   lastActivityAt：最近一次子会话事件（任何 type，含 part 写入/工具状态变更）时间戳。
  //   pendingTools：在途工具 callID 集（state.status 为 pending/running 登记，completed/error 摘除）。
  //   「有在途工具」＝合法的长期静默（长生成），活性检测必须放行，不得误杀。
  lastActivityAt: number
  pendingTools: Set<string>
  // 2026-10-05 修复（成品交付链下半场）：本 run 的工具结果里已观测到的成片类成品。
  // 子代理被 30 分钟硬顶/上游错误打死、或收尾摘要里没写 URL 时，父会话仍能拿到
  // 「这一路已经产出了什么」——此前唯一证据是用户屏幕上的卡片，父模型据此误判零产物重派。
  artifacts: Array<{ kind: string; url: string; task_id?: string; cost_coins?: number }>
  // 2026-10-05：子代理工具状态帧（subagent.tool）的每 callID 已发状态，防重复刷帧。
  toolStatusEmitted: Map<string, string>
  // 片 D（2026-09-15）：交付闸门机器化重派状态。reworkCount=已重派次数（硬帽 1，
  // 防无限回圈烧钱）；reworking=重派投递在途护栏（旧子会话残影事件不得提前收尾）；
  // reworkFailure=重派投递失败原因（非空=重派从未真正跑过，done 不得伪称 reworked）。
  reworkCount: number
  reworking?: boolean
  reworkFailure?: string
  // 刀 F（2026-09-15）：启动扫描重建的孤儿 run 标记——finishRun 见其 true 直接走诚实
  // 收尾（delivery_gate.orphaned + 前缀 wake），不重派、不幽灵续 watch、不伪称 reworked。
  orphaned?: boolean
  // 刀 2（2026-09-15）：本 run 是 gateway 在收盘判定点**机器派遣**的 critic（非 orchestrator
  // 决定）。终态处置分岔：verdict 通过 → 仅 journal 留痕、抑制 wake（不扰会话、不新增空转
  // turn）；判退回 → 以前缀 CRITIC_REJECT_MARK 走既有 wakeParent 把判决送回父会话。
  machineCriticPass?: boolean
  // 刀 2：机器 pass 的 critic run 专用——其终态 verdict 判读结果（false=通过）。
  machineCriticRejected?: boolean
  // 2026-10-03：机器 critic run 被派时所审的那批 Expert 交付（跨 finishRun 需要它们的
  // 正文抽取可量测媒体 URL）。只在 maybeRunMachineCriticPass 建立 run 时赋值一次。
  criticReviewed?: CriticPassTarget[]
  // 0920 暴君裁定（停止闸）：用户／orchestrator 主动停止。置位后：
  //   ① killSwitch 已 abort+DELETE 子会话；② 所有事件与重投路径一律早退
  //   （stopCheck 见 stopped 即 return），含换模重试与交付闸门重派；
  //   ③ finishRun 归属 "stopped"，**不做 wakeParent**（停止不该把父会话再唤起来）。
  stopped?: boolean
  stoppedBy?: "user" | "orchestrator"
  stoppedAt?: number
}

interface SubagentResult {
  // 0920 停止闸：新增 "stopped"——人工取消不是失败（停止成功却显示「失败」＝假判定）。
  status: Exclude<TaskStatus, "running">
  summary: string
  error?: string
  finishedAt: number
  // 异步模式（2026-09-10 R6）：dispatch async=true 时 finishRun 摘除 run 后
  // 直接唤醒父会话；label 留给唤醒文案取用。
  label?: string
  // R1（2026-09-11）：同步 deadline 超时的「部分结果」语义（工具侧/前端契约栏位）。
  partial?: boolean
  reason?: string
  // D4（2026-10-02）：所属父会话（gateway session id）。此前 completed 记录无归属，
  // 「latest／最近 3 笔」查不到本会话的已完成 run。新写入必带；旧记录无此栏＝不列入。
  parent?: string
  // 2026-10-05 修复（成品交付链下半场）：本 run 已观测到的成片类成品（见 SubagentRun.artifacts）。
  artifacts?: Array<{ kind: string; url: string; task_id?: string; cost_coins?: number }>
}

interface SubagentDeps {
  // 现有出口：emitToSession(state, name, data)（replayBuffer/clients/enqueue 全在里面）
  emitToSession: (state: any, name: string, data: unknown) => void
  // 父会话解析：gateway id → state；miss 再按 opencode id 查
  resolveSession: (id: string) => any
  findSessionByOpenCodeId: (opencodeSessionId: string) => any
  openCodeUrl: string
  openCodeHeaders: () => Record<string, string>
  // 主路径 opencodeErrorMessage 原样注入：opencode 错误是 {name, data:{message}}
  // 形状，直读 .message 恒 undefined（主路径注解已警告过的坑）。
  describeError: (err: unknown) => string
  // 父会话 persona 主模型 + fallbacks 链（与主路径 personaModelForAttempt 同源）。
  subagentModelChain: (parentState: any) => SubagentModelRef[]
  // 野兽模式（MOE 改革，2026-09-08）：父会话 settings.beast_mode；ON 时任务书头部
  // 注入 Expert 宪法（gateway/expert/expert-constitution.md）。OFF/缺栏 = 原文零改动。
  beastMode: (parentState: any) => boolean
  // 异步完成唤醒（2026-09-10 R6）：子代理终态时由 gateway 注入的出口，把结果
  // 摘要投进父会话消息流并续 turn（轮子=index.ts wakeSessionForSubagent，对齐
  // workflow 唤醒扫描器的 prompt_async 轮廓：turn 计数重置＋watchdog 布哨＋幂等守卫）。
  // 未注入（旧 index.ts 配新 subagent.ts）时 async dispatch 自动降级同步语义。
  wakeParent: (parentState: any, run: { id: string; label: string; status: "ok" | "error"; summary: string; error?: string; artifacts?: Array<{ kind: string; url: string; task_id?: string; cost_coins?: number }> }) => void
}

let deps: SubagentDeps | undefined
// 父 gateway session id → 活跃子代理列表（dispatch 并发上限按此计）
const byParent = new Map<string, SubagentRun[]>()
// 子 opencode session id → run（全局 tap 按 sessionID 命中）
const byChildOc = new Map<string, SubagentRun>()
// FIX-B（2026-10-02）：子会话→父会话映射的耐久性。byChildOc 在 run 收尾（finishRun/
// stopSubagentRun/换模）会被 delete，但 poller 可能在子代理结束后才把成品经 /internal/emit
// 用子会话 id 发出 → subagentParentState 解析不到父会话 → 404 → 卡丢失。于绑定点
// （dispatchAttempt）额外写一张有界（≤200）TTL（2h）表，byChildOc 未命中时回退查。
// **只在绑定处写**，不改任何 byChildOc.has()/delete() 语义（subagent_stop/status 依赖它们）。
const RECENT_CHILD_PARENT_CAP = 200
const RECENT_CHILD_PARENT_TTL_MS = 2 * 60 * 60 * 1000
const recentChildParent = new Map<string, { parentGatewaySessionId: string; parentOpencodeSessionId: string; at: number }>()
// 子代理 id → 结果（工具轮询取件；TTL 后清）
const completed = new Map<string, SubagentResult>()

// ── 刀 2（2026-09-15）：machine critic pass 状态 ─────────────────────────────────
// 待审交付：父 gateway session id → 本窗口内已终态的 Expert 交付（尚未送审）。
// 由 finishRun 在 Expert 正常终态时登记；machine pass 消耗后清空。纯内存（有界：
// 每次 pass 至多取 CRITIC_PASS_MAX_TARGETS；登记侧亦封顶）。
const pendingCriticTargets = new Map<string, CriticPassTarget[]>()
// 本轮是否已有 critic 派遣（含在途）。值 = 登记时的父会话 turnGen。
// **语义钉死为「本轮」**：判据比较「登记 turnGen === 当前 turnGen」，新一轮自动失效
// ——避免 orchestrator 早轮派过一次 critic 就永久豁免机器兜底（本刀要的就是兜底常在）。
// orchestrator 自派（handleSubagentDispatch expert="critic"）与机器 pass 派遣皆登记于此。
// 有界 Map 防无界增长。
const criticDispatchedByParent = new Map<string, number>()
// M2/M3（2026-10-02）：每父会话交付簿——music-first 前置断言（music 交付事件）＋
// 返工内容锁（上一份交付物落盘路径）。有界 Map，每父会话 ≤20 笔。
const deliveredByParent = new Map<string, Array<{ agent: string; label: string; relPath: string }>>()
// 本会话是否已用掉 machine critic pass（内存镜像；权威在 persistence.critic_passes）。
const criticPassUsed = new Set<string>()
const CRITIC_PENDING_CAP = 16
// 修 1（2026-10-02）：被并发上限挤掉的 critic 待审目标入队（per-parent）。
// 此前直接丢弃 → critic 从未跑；槽位释放时由 maybeDrainCriticQueue 补跑。有界。
const criticRetryQueue = new Map<string, CriticPassTarget[]>()

export function initSubagent(d: SubagentDeps): void {
  deps = d
  startLivenessWatch()
}

/** 全局 tap 用：该 opencode 会话是否是本运行时的子会话。 */
export function subagentHandlesSession(opencodeSessionId: string): boolean {
  return byChildOc.has(opencodeSessionId)
}

/**
 * 死线③（片 AN，评测 REPORT S2）：子代理 opencode session 不在主 sessions 表，
 * /internal/session-key 查无记录 → 工具侧 resolveKey 全挂（「网关侧解析不到本
 * 会话的 API key」）。子会话仍活跃时经此继承父会话 apiKey（同一用户，计费口径
 * 不变）；父会话已被逐出/收尾则回 undefined，维持 404 原语义。
 */
export function subagentParentApiKey(opencodeSessionId: string): string | undefined {
  const state = subagentParentState(opencodeSessionId)
  const key = state?.apiKey
  return typeof key === "string" && key ? key : undefined
}

/**
 * 死线③同构（2026-09-19 片头曲 404 实锤）：子代理 opencode session 不在主
 * sessions 表，/internal/media/upload 等「session_id 解析」型端点查无记录 →
 * 工具侧上传全挂（音轨生成成功却 404 session not found）。子会话仍活跃时
 * 经此解析父会话 SessionState；父会话已被逐出/收尾则回 undefined，由呼叫方
 * 维持 404 原语义。uploadAudio 落盘归属父会话（同用户，存储口径不变）。
 */
export function subagentParentState(opencodeSessionId: string): any | undefined {
  const run = byChildOc.get(opencodeSessionId)
  if (run) {
    return (
      deps?.resolveSession(run.parentGatewaySessionId) ??
      deps?.findSessionByOpenCodeId(run.parentOpencodeSessionId)
    )
  }
  // FIX-B（2026-10-02）：run 已收尾（byChildOc 已删）但 poller 仍可能用子会话 id 晚到取件
  // → 回退查有界 TTL 表（lazy prune 过期项），解析方式与上面逐字相同。
  pruneRecentChildParent(Date.now())
  const rec = recentChildParent.get(opencodeSessionId)
  if (!rec) return undefined
  return deps?.resolveSession(rec.parentGatewaySessionId) ?? deps?.findSessionByOpenCodeId(rec.parentOpencodeSessionId)
}

function parentStateOf(run: SubagentRun): any {
  return (
    deps.resolveSession(run.parentGatewaySessionId) ??
    deps.findSessionByOpenCodeId(run.parentOpencodeSessionId)
  )
}

// ── 0920 暴君裁定：子代理停止闸（此前「一出就刹不住车」）─────────────────────
// 病灶（三处结构性缺失，全在本次修复）：
//   ① 用户终止按钮打 /agent/v1/sessions/:id/abort → 只杀**主会话**在途 turn，
//      子代理（各自独立子会话）完全不受影响，跑完照样 wakeParent 把父会话**重新
//      唤起来**——用户视角＝「按了终止，它又自己活了」。
//   ② orchestrator 没有任何停止子代理的工具（只有 dispatch/status）。
//   ③ 换模重试（retryWithNextModel）与交付闸门重派（startRework）都会另建子会话，
//      没有「已停止」这道闸，停止后仍会被重投路径复活。
// 本闸：stopped 一置，所有事件处理与重投路径早退，finishRun 归属 "stopped" 且不唤醒。

/** 停止单一 run：标记 + abort/DELETE 子会话 + 摘注册表 + 记 completed（工具轮询可解锁）。 */
export function stopSubagentRun(run: SubagentRun, by: "user" | "orchestrator", reason: string): void {
  if (run.status !== "running") return
  run.stopped = true
  run.stoppedBy = by
  run.stoppedAt = Date.now()
  if (run.timeoutTimer) clearTimeout(run.timeoutTimer)
  if (run.deadlineTimer) clearTimeout(run.deadlineTimer)
  const text = reason || `已停止子代理「${run.label}」`
  // 修 3（2026-10-02）：中止＝先落盘 partial（已累积文字，档名规则同终态），再做
  // stopped 收尾——此前中止零产物、工作全丢（实锤：C2 与查重代理被一并杀掉）。
  run.partialPersist = true
  const persist = persistRunOutput(run, "timeout", partialBodyOf(run), text)
  const summary = persist.relPath ? `${persist.pointer}${text}` : text
  // 先落一条 done（不经 finishRun——那条路会走交付闸门/唤醒，停止语义不适用）。
  // 0920 停止闸：人工／orchestrator 停止不是失败，标 "stopped"，前端的 "已中止"。
  run.status = "stopped" satisfies TaskStatus
  run.error = text
  run.summary = summary
  removeFromRegistries(run)
  // 修 1：停止也释放槽位——补跑被挤掉的 critic。
  maybeDrainCriticQueue(run.parentGatewaySessionId)
  deleteReworkRecord(run.id)
  completed.set(run.id, { status: "stopped" satisfies TaskStatus, summary, error: text, finishedAt: Date.now(), label: run.label, parent: run.parentGatewaySessionId })
  const state = parentStateOf(run)
  if (state && deps) {
    try {
      deps.emitToSession(state, "subagent.done", { id: run.id, status: "stopped" satisfies TaskStatus, summary, stopped: true, stopped_by: by })
    } catch (e) {
      console.error(`[gateway] subagent stop emit failed: id=${run.id}`, e)
    }
    // 刻意**不唤醒**父会话：停止＝结束，不是新任务。唤醒会让 orchestrator 又起一轮
    // （并可能再派新 subagent），正是用户抱怨的「刹不住」。
  }
  if (isOpenCodeSessionId(run.opencodeSessionId) && deps) {
    void fetch(`${deps.openCodeUrl}/session/${run.opencodeSessionId}/abort`, {
      method: "POST",
      headers: deps.openCodeHeaders(),
      signal: AbortSignal.timeout(5000),
    }).catch(() => {})
    void fetch(`${deps.openCodeUrl}/session/${run.opencodeSessionId}`, {
      method: "DELETE",
      headers: deps.openCodeHeaders(),
      signal: AbortSignal.timeout(5000),
    }).catch(() => {})
  }
  console.log(
    `[gateway] subagent stopped: id=${run.id} label="${run.label}" by=${by} parent=${run.parentGatewaySessionId} reason=${text}`,
  )
}

/** 停止一个父会话名下全部在跑子代理（用户终止按钮 / orchestrator 一键清场）。回停掉几个。 */
export function stopSubagentsForParent(parentGatewaySessionId: string, by: "user" | "orchestrator", reason = ""): number {
  const list = byParent.get(parentGatewaySessionId) ?? []
  const running = list.filter((r) => r.status === "running" && !r.stopped)
  for (const r of running) stopSubagentRun(r, by, reason)
  return running.length
}

/** 停止或恢复单一 run（orchestrator 工具用；id 可为 gateway run id 或 label 前缀）。回 run 或 undefined。 */
export function findRunningRun(parentGatewaySessionId: string, idOrLabel: string): SubagentRun | undefined {
  const list = (byParent.get(parentGatewaySessionId) ?? []).filter((r) => r.status === "running" && !r.stopped)
  const exact = list.find((r) => r.id === idOrLabel)
  if (exact) return exact
  const byLabel = list.filter((r) => r.label.startsWith(idOrLabel))
  return byLabel[0]
}

function boundMap<T>(map: Map<string, T>, max: number): void {
  if (map.size <= max) return
  const oldest = map.keys().next().value
  if (oldest !== undefined) map.delete(oldest)
}

function boundSet<T>(set: Set<T>, max: number): void {
  if (set.size <= max) return
  const oldest = set.values().next().value
  if (oldest !== undefined) set.delete(oldest)
}

function pruneCompleted(): void {
  const now = Date.now()
  for (const [id, rec] of completed) {
    if (now - rec.finishedAt > COMPLETED_TTL_MS) completed.delete(id)
  }
}

// FIX-B：记住子会话→父会话绑定（有界）；byChildOc 收尾删除后仍能解析父 state 供晚到取件。
function rememberChildParent(childId: string, run: SubagentRun): void {
  recentChildParent.set(childId, {
    parentGatewaySessionId: run.parentGatewaySessionId,
    parentOpencodeSessionId: run.parentOpencodeSessionId,
    at: Date.now(),
  })
  while (recentChildParent.size > RECENT_CHILD_PARENT_CAP) {
    const oldest = recentChildParent.keys().next().value
    if (oldest === undefined) break
    recentChildParent.delete(oldest)
  }
}

// FIX-B：lazy prune 过期项（TTL 2h），随每次回退查询顺手清（只在 subagentParentState miss 时呼叫）。
function pruneRecentChildParent(now: number): void {
  for (const [k, v] of recentChildParent) {
    if (now - v.at > RECENT_CHILD_PARENT_TTL_MS) recentChildParent.delete(k)
  }
}

function removeFromRegistries(run: SubagentRun): void {
  byChildOc.delete(run.opencodeSessionId)
  const list = byParent.get(run.parentGatewaySessionId)
  if (list) {
    const idx = list.indexOf(run)
    if (idx >= 0) list.splice(idx, 1)
    if (list.length === 0) byParent.delete(run.parentGatewaySessionId)
  }
  if (run.timeoutTimer) clearTimeout(run.timeoutTimer)
  if (run.deadlineTimer) clearTimeout(run.deadlineTimer)
  if (run.heartbeatTimer) clearInterval(run.heartbeatTimer)
  if (run.earlyPartialTimer) clearTimeout(run.earlyPartialTimer)
}

/**
 * 2026-10-03（v3 接线）：开关 `CRITIC_SCORE_ENFORCE`。真值＝**必须字面 "1"**。
 * 刻意不接受 "true"/"on"/"yes"：本闸门一旦启用，measured 低分会被当成「退回」，
 * 经既有重派链让上游 Expert 重跑＝再一次模型呼叫＝花钱，故用最不易误开的形式。
 * 未设／其他值 → false：与接线前**逐位元组相同**（零 I/O、零 await、零重派）。
 */
export function criticScoreEnforcementEnabled(): boolean {
  return process.env.CRITIC_SCORE_ENFORCE === "1"
}

/**
 * 纯函数（可单测）：measured 样本 + 开关 → 是否以数值阈值强制退回。
 * 三条件缺一不可：开关 true；来源＝policy.enforcedSource（measured）；分数 < reworkBelow。
 * 无分数（null）／model_self／human → 一律 false（未知≠失败；模型自评非验收 oracle）。
 * 判定逻辑全在 evaluateCriticScoreThreshold（唯一真源），本函数只加 env 闸门、不另立阈值。
 */
export function shouldForceCriticRejectByScore(
  sample: CriticScoreSample,
  enabled: boolean = criticScoreEnforcementEnabled(),
): boolean {
  if (!enabled) return false
  return evaluateCriticScoreThreshold(sample).enforce
}

/**
 * 2026-10-03：对机器 critic run 所审 Expert 交付做**事后产物硬检**，只算不写。
 * 全程 try/catch，永不 throw；量测回 null（开关 OFF／ffprobe 不可用／无媒体／量测失败）
 * → 回 null，呼叫端据此维持 null 分数（未知≠通过，绝不填 0/满分冒充）。写入交由呼叫端
 * 一次性完成（persistMeasuredVerdict），避免第二套写入路径。
 */
async function measureReviewedMedia(run: SubagentRun): Promise<MeasuredMediaResult | null> {
  try {
    const targets = run.criticReviewed ?? []
    if (targets.length === 0) return null
    return await measureMediaScore(targets.map((t) => t.text))
  } catch (e) {
    console.warn(`[gateway] media-quality-gate: measured 旁路失败已忽略（交付不受影响）run=${run.id}`, e)
    return null
  }
}

/** 以同一 runId 覆写 critic_verdicts 的 measured 分栏（唯一写入形状＝persistence.saveCriticVerdict）。 */
function persistMeasuredVerdict(run: SubagentRun, measured: MeasuredMediaResult, criticVerdictText: string): void {
  try {
    saveCriticVerdict({
      sessionId: run.parentGatewaySessionId,
      runId: run.id,
      agent: run.agent,
      label: run.label,
      // verdict 沿用 critic 判读（硬检不翻判方向，只补数值分；两者不混为一谈）。
      verdict: run.machineCriticRejected ? "reject" : "pass",
      score: measured.score,
      // measured 有数值才算（saveCriticVerdict 内另有「measured 无数值→来源强制 null」不变式）。
      scoreSource: "measured",
      judgeModel: "hardcheck/ffprobe",
      // 量测细节置前（保留 provenance），其后附 critic 判词（saveCriticVerdict 统一截 4000）。
      verdictText: `${MEDIA_QUALITY_MEASURED_MARK}${measured.detail}\n\n${criticVerdictText}`,
    })
    console.log(
      `[gateway] media-quality-gate: measured 技术分=${measured.score} 件数=${measured.artifacts} run=${run.id}（覆盖 model_self 分栏；仅技术正确性，非审美）`,
    )
  } catch (e) {
    console.warn(`[gateway] media-quality-gate: measured 旁路失败已忽略（交付不受影响）run=${run.id}`, e)
  }
}

/**
 * 2026-10-03：fire-and-forget 旁路（**仅在闸门关闭时使用**）。量测成功 → 以同一 runId
 * 覆写 critic_verdicts 的 measured 分栏（供观测）；失败 → 不写。终态收尾**不被阻断**。
 * 闸门开启时改走 finishRun 内的 await 路径（量测结果要先参与判决），本函数不再被呼叫。
 */
async function applyMeasuredMediaVerdict(run: SubagentRun, criticVerdictText: string): Promise<void> {
  const measured = await measureReviewedMedia(run)
  if (!measured) return
  persistMeasuredVerdict(run, measured, criticVerdictText)
}

/** 收尾：登记结果、摘除注册表、向父会话发 done、DELETE 子会话防堆积。
 *  2026-10-03：改 async——仅在「critic-score 闸门开启且本 run 是机器 critic」时才会 await
 *  一次量测（要在判决前拿到 measured 分）。闸门未设时无任何 await：副作用与时序与接线前
 *  完全相同（呼叫端皆忽略回传值）。 */
async function finishRun(run: SubagentRun, status: "ok" | "error", fullText: string, error?: string): Promise<void> {
  if (run.status !== "running") return // 幂等：idle 与超时硬顶可能竞态
  // 0920 停止闸：停止已由 stopSubagentRun 收尾（已 done/已摘表）；此处不得再走
  // 交付闸门或 wakeParent——否则停止后仍会把父会话唤醒重跑（「刹不住」病灶①）。
  if (run.stopped) return
  run.status = status
  // E 片（2026-09-12）缺陷一：**先落盘完整全文/死因全文，再走摘要与 DELETE**。行内
  // 摘要仍只给 600 字（semantics 不变），但前缀挂落盘指针 → 父会话可 read 全文。
  const persist = persistRunOutput(run, status, fullText, error)
  if (status === "ok" && run.agent && !run.stopped) {
    const arr = deliveredByParent.get(run.parentGatewaySessionId) ?? []
    arr.push({ agent: run.agent, label: run.label, relPath: persist.relPath ?? "" })
    if (arr.length > 20) arr.shift()
    deliveredByParent.set(run.parentGatewaySessionId, arr)
    boundMap(deliveredByParent, 500)
  }
  // 2026-10-02 能力片：ok 摘要＝最后一则有文字的 assistant 讯息（语义取自 Claude Code
  // 子代理回传契约）+ 一行用量计数；**不是**「全文前 N 字」。子代理末则文字可能上万字，
  // 为避免 done 帧与注入父会话的唤醒文案膨胀（与本轮控上下文/工具结果大小的目标一致），
  // 以 SUBAGENT_SUMMARY_MAX_CHARS 在换行边界截断并附「已截断」提示；全文落盘照旧保留
  // （persist.pointer / PERSIST_TAIL 不变）。error 摘要维持原 600 字死因帽（既有语义零回归）。
  const okTrunc = status === "ok" ? truncateSummaryText(fullText) : null
  const inline =
    error && status === "error"
      ? error.slice(0, SUMMARY_MAX_CHARS)
      : okTrunc
        ? okTrunc.text
        : fullText
  const truncNote =
    okTrunc && okTrunc.truncated > 0 ? `\n\n[已截断 ${okTrunc.truncated} 字元；完整结果见落盘指标]` : ""
  const usageNote =
    status === "ok" && run.usage
      ? `\n\n[子代理用量] 工具调用 ${run.usage.tool_calls} 次 · 耗时 ${Math.round(run.usage.duration_ms / 1000)}s · token ${run.usage.tokens}`
      : ""
  let summary = `${persist.pointer}${inline}${truncNote}${usageNote}`
  run.summary = summary
  run.error = error
  // 片 C（2026-09-15）刀2：交付闸门。病灶＝7 个 Expert 的 `*_DELIVERABLES` 契约只写在
  // prompt/digest 里，gateway 全域零强制点，漏交付（09-15 实案 music.audio_url 空）照样
  // status:"ok" 放行。此处为唯一机械强制点：
  //   - **不改 status 语义**（ok 仍为 ok；交付缺口不是上游错误，混进 error 会让既有
  //     「换模重试/超时」判读全乱）；
  //   - 只在 summary 前缀加显式标记 → 三个出口（subagent.done payload、completed 取件、
  //     wakeParent 唤醒）自动全带（三处都用下面这个 summary 变数）；
  //   - subagent.done payload 加**新栏位** delivery_gate（ok 时不加，既有栏语义不动）。
  // 判据用**未截断全文 fullText**（不是 600 字摘要——摘要会把栏位名切掉→假阴性）。
  // 只在 ok + beastMode + agent 有值时跑：非 Expert 通用子代理零回归。
  // 边界：只验栏位名存在性，不验值/品质（见 delivery-gate.ts 档头）。
  let deliveryGate: { ok: boolean; missing: string[]; reworked?: boolean; stillFailing?: boolean; orphaned?: boolean } | undefined
  // 刀 F（2026-09-15）：孤儿治理路径——启动扫描重建的 in-flight rework run（watcher 已死、
  // 不续 watch），done 带 delivery_gate.orphaned:true，summary 已含 ORPHANED_GATE_MARK 前缀
  // （呼叫端 error 字串带入）；status 由呼叫端传 "error"，走既有单终态守卫 + 单次 wake。
  if (run.orphaned === true) {
    const miss = run.agent && DELIVERY_CONTRACTS[run.agent] ? DELIVERY_CONTRACTS[run.agent].requiredFields.slice() : []
    deliveryGate = { ok: false, missing: miss, reworked: true, stillFailing: true, orphaned: true }
    console.warn(
      `[gateway] delivery gate: id=${run.id} agent=${run.agent} status=ORPHANED (进程中断未复原) missing=${miss.join(",")}`,
    )
  } else if (status === "ok" && run.beastMode === true && run.agent) {
    const verdict = checkDelivery(run.agent, fullText, DELIVERY_CONTRACTS)
    // 片 D（2026-09-15）：FAIL → 机器化重派一次（同 Expert 同任务＋修正指令注回，硬帽
    // reworkCount=1）。触发条件＝闸门区块外条件（ok+beastMode+agent）加 FAIL 判定，
    // 非 Expert/已失败收场零污染；status==="ok" 是必要条件——上游 error/超时不进重派链。
    // 提前 return：本轮**不终态**（回退 status、不发 done/不 completed.set/不 wake），
    // run 留在注册表由 startRework 接棒；终态只属重派链的最后一次 finishRun（spec 6 幂等）。
    if (!verdict.ok && run.reworkCount === 0 && !run.reworkFailure && !run.stopped) {
      run.reworkCount = 1
      run.reworking = true
      run.status = "running"
      run.summary = undefined
      console.warn(
        `[gateway] delivery gate: id=${run.id} agent=${run.agent} status=FAIL missing=${verdict.missing.join(",")} — 触发机器化重派`,
      )
      // D7（2026-10-02）：失败模式永久留存（此前 subagent_reworks 终局删除、无终身计数）。
      saveExpertLesson({
        sessionId: run.parentGatewaySessionId,
        agent: run.agent ?? "unknown",
        runId: run.id,
        source: "delivery_gate",
        failureMode: verdict.missing.join(",") || "delivery_gate_fail",
        detail: typeof fullText === "string" ? fullText.slice(0, 2000) : "",
      })
      void startRework(run, verdict, fullText)
      return
    }
    if (!verdict.ok) {
      if (run.reworkFailure) {
        // 重派投递从未成功（如 opencode 不可达）：重派没跑过，done 不伪称 reworked——
        // 维持片 C 原「未达标」标记语义，仅缀一行失败事实。
        summary = `${formatDeliveryGateNotice(run.agent, verdict, DELIVERY_CONTRACTS)}（自动重派投递失败：${run.reworkFailure}）\n${summary}`
        deliveryGate = { ok: false, missing: verdict.missing }
      } else {
        // 重派后复检仍 FAIL：标记升级「重派后仍未达标」，交由既有唤醒链如实回报。
        // status 栏语义不动（仍 ok——重派是补救尝试，不保证成功，也不把缺口洗成错误）。
        summary = `${formatDeliveryGateNotice(run.agent, verdict, DELIVERY_CONTRACTS, REWORK_FAIL_MARK)}\n${summary}`
        deliveryGate = { ok: false, missing: verdict.missing, reworked: true, stillFailing: true }
      }
      run.summary = summary
      console.warn(
        `[gateway] delivery gate: id=${run.id} agent=${run.agent} status=FAIL${run.reworkCount > 0 ? " (rework exhausted)" : ""} missing=${verdict.missing.join(",")}`,
      )
    } else if (run.reworkCount > 0) {
      // 重派后复检 PASS：done 带 reworked 旗标（正常 summary，无前缀）；既有栏不动。
      deliveryGate = { ok: true, missing: [], reworked: true }
      console.log(`[gateway] delivery gate: id=${run.id} agent=${run.agent} status=PASS (reworked)`)
    } else {
      // PASS 也留一行：证明闸门确实在跑（否则「零命中」无法与「未接线」区分）。
      console.log(`[gateway] delivery gate: id=${run.id} agent=${run.agent} status=PASS`)
    }
  }
  // 刀 2（2026-09-15）：机器 pass 的 critic run 终态处置。verdict 判读（保守：判不出＝退回）
  // 决定是否走既有 wakeParent 把判决送回父会话；判退回时 summary 前缀 CRITIC_REJECT_MARK，
  // orchestrator 据此依 playbook 第 16-18 条重派原 Expert 修正（原 Expert 若再失败，其自带
  // 的 rework 链硬帽 1 次仍然生效）。
  if (run.machineCriticPass === true && status === "ok") {
    // 2026-10-03（v3 接线）：闸门开启时，**先**对本 critic 所审交付取得 measured 样本，
    // 再与既有词表判读并成同一条「拒/过」决策。闸门未设＝不做任何 I/O、不 await，
    // 落到下方既有 fire-and-forget 旁路 → 行为与接线前逐位元组相同。
    const scoreEnforced = criticScoreEnforcementEnabled()
    let measured: MeasuredMediaResult | null = null
    if (scoreEnforced) measured = await measureReviewedMedia(run)
    // 既有决策（词表判读 criticVerdictRejected）＋新的数值阈值并入同一处：
    // 来源只在真有量测时才是 "measured"，无量测给 null → 恒不 enforce
    // （未知≠失败；model_self/human 非验收 oracle）。
    const forcedByScore = shouldForceCriticRejectByScore(
      { value: measured?.score ?? null, source: measured ? "measured" : null },
      scoreEnforced,
    )
    run.machineCriticRejected = criticVerdictRejected(fullText) || forcedByScore
    if (forcedByScore) {
      console.warn(
        `[gateway] critic-score-gate: measured 技术分=${measured!.score} < ${CRITIC_SCORE_THRESHOLD_POLICY.reworkBelow} → 判退回（沿用既有重派链；critic_run=${run.id}）`,
      )
    }
    // 修 1（2026-10-02）：PASS 也以前缀标记判决方向，让 summary/emit/wake 三出口一致回灌。
    if (!run.machineCriticRejected) {
      summary = `${CRITIC_PASS_MARK}机器审核判定「通过」，无退回项（逐项核验见落盘全文）。\n${summary}`
      run.summary = summary
    }
    if (run.machineCriticRejected) {
      summary = `${CRITIC_REJECT_MARK}机器派遣的独立审核判定「退回」，请依第 16-18 条重派原 Expert 修正后重新送审。
${summary}`
      run.summary = summary
      console.warn(
        `[gateway] machine critic pass: verdict=REJECT — 送回父会话 session=${run.parentGatewaySessionId} critic_run=${run.id}`,
      )
    }
    // D7（2026-10-02）／v3（2026-10-03）：判决落库（此前 critic_passes 只有 session_id/created_at）。
    // 无量测 → score=null、source=model_self（同族模型自评，只作便宜筛子，永不通过数值阈值）。
    // 有量测 → score+source="measured"、judge_model=hardcheck/ffprobe（独立于被测模型的量测
    // 来源，才可被 evaluateCriticScoreThreshold enforce）。绝不填 0 假值、不从文字硬解析假分数。
    saveCriticVerdict({
      sessionId: run.parentGatewaySessionId,
      runId: run.id,
      agent: run.agent,
      label: run.label,
      verdict: run.machineCriticRejected ? "reject" : "pass",
      score: measured?.score ?? null,
      scoreSource: measured ? "measured" : "model_self",
      judgeModel: measured
        ? "hardcheck/ffprobe"
        : (() => {
            const m = run.modelChain[run.attempt - 1]
            return m ? `${m.providerID}/${m.modelID}` : "opencode-default"
          })(),
      verdictText: measured
        ? `${MEDIA_QUALITY_MEASURED_MARK}${measured.detail}\n\n${typeof fullText === "string" ? fullText : ""}`
        : typeof fullText === "string"
          ? fullText
          : "",
    })
    if (run.machineCriticRejected) {
      saveExpertLesson({
        sessionId: run.parentGatewaySessionId,
        agent: run.agent ?? "critic",
        runId: run.id,
        source: "critic_reject",
        failureMode: "machine_critic_reject",
        detail: typeof fullText === "string" ? fullText : "",
      })
    }
    // 闸门关闭时维持既有 fire-and-forget 旁路：量测成功 → 以同一 runId 覆写上面的 model_self
    // 列（供观测）；失败不写。闸门开启时上面已 await 出 measured 并落库，此处不再重复量测/写入。
    if (!scoreEnforced) {
      void applyMeasuredMediaVerdict(run, typeof fullText === "string" ? fullText : "")
    }
  }
  // 刀 2（2026-09-15）：Expert 交付登记为待审对象（machine critic pass 的输入）。
  // 条件全成立才登记：正常终态（非孤儿路径）、ok、beast、agent 在契约域内、非 critic 自身
  // （critic run 不得再触发本 pass —— 防递归）。非 Expert／通用子代理零登记＝零回归。
  if (
    run.orphaned !== true &&
    status === "ok" &&
    run.beastMode === true &&
    typeof run.agent === "string" &&
    run.agent !== "critic" &&
    DELIVERY_CONTRACTS[run.agent] !== undefined
  ) {
    const list = pendingCriticTargets.get(run.parentGatewaySessionId) ?? []
    list.push({ agent: run.agent, label: run.label, runId: run.id, text: typeof fullText === "string" ? fullText : "" })
    // 有界：只留最近 CRITIC_PENDING_CAP 份（机器 pass 一次最多送审 CRITIC_PASS_MAX_TARGETS）。
    if (list.length > CRITIC_PENDING_CAP) list.splice(0, list.length - CRITIC_PENDING_CAP)
    pendingCriticTargets.set(run.parentGatewaySessionId, list)
  }

  const asyncMode = run.asyncMode === true
  removeFromRegistries(run)
  // 2026-10-04 F6：done 摘要从**源头**改为用户可读——内部落盘指针、契约栏名（verdict/issues/
  // evidence/qc）、审核身份与 runId、内审判词与编号审稿正文、用量计数一律剥离。三个出口
  // （subagent.done 帧 / completed 取件 / wakeParent 唤醒）本来共用同一 summary 变数，这里
  // 换成清洗后的版本即三处同时干净；咽喉点（sse-core.emitToSession）与唤醒路径（index.ts）
  // 复用同一纯函数做下游兜底，此处是让出口天生干净的第一层。
  const visibleSummary = scrubSubagentPayload(summary)
  run.summary = visibleSummary
  // 修 1：本 run 释放了一个槽位——若该父会话有被并发上限挤掉的 critic 待跑，补跑。
  maybeDrainCriticQueue(run.parentGatewaySessionId)
  deleteReworkRecord(run.id) // 刀 F：终态即清持久记录（幂等；非 rework run 无记录=no-op）
  completed.set(run.id, { status, summary: visibleSummary, error, finishedAt: Date.now(), label: run.label, parent: run.parentGatewaySessionId, artifacts: run.artifacts?.length ? run.artifacts : undefined })
  // D7（2026-10-02）：交付事件落库——重问率＝同 (session, agent, label) 再次交付的比例。
  if (status === "ok" && run.agent) {
    saveDelivery({
      sessionId: run.parentGatewaySessionId,
      runId: run.id,
      agent: run.agent,
      label: run.label,
      relPath: persist.relPath,
      contractOk: deliveryGate ? deliveryGate.ok : undefined,
    })
  }
  const state = parentStateOf(run)
  if (state) {
    deps!.emitToSession(state, "subagent.done", {
      id: run.id,
      status,
      summary: visibleSummary,
      // 片 C（2026-09-15）：新增栏位，不动既有 id/status/summary 语义；ok 时不加。
      ...(deliveryGate ? { delivery_gate: deliveryGate } : {}),
      // 2026-10-02 能力片：用量计数（仅 summarizeChild 路径有值；新栏位，不动既有键）。
      ...(run.usage ? { usage: run.usage } : {}),
    })
    // R6 异步完成唤醒：async dispatch 的终态（成功与失败皆唤）在 emit 帧之外
    // 直接续父会话 turn（轮子=deps.wakeParent）。finishRun 幂等守卫保唤醒不重复；
    // deps.wakeParent 内部再带 ackTimer 在途让位，双保险。同步模式不唤（工具还在
    // 轮询取件，唤醒反而插话）。
    if (asyncMode && run.machineCriticPass === true) {
      // 修 1（2026-10-02）：verdict（PASS 与 REJECT）一律以正常完成仪式回灌父会话——
      // PASS 不再只写 journal（实锤：判决从未送达，orchestrator 两小时后手动 read 才发现）。
      try {
        deps!.wakeParent(state, { id: run.id, label: run.label, status, summary: visibleSummary, error, artifacts: run.artifacts })
      } catch (e) {
        console.error(`[gateway] subagent wake failed: id=${run.id}`, e)
      }
      console.log(
        `[gateway] machine critic pass: verdict=${run.machineCriticRejected ? "REJECT" : "PASS"} — 回灌父会话 session=${run.parentGatewaySessionId} critic_run=${run.id}`,
      )
    } else if (asyncMode) {
      try {
        deps!.wakeParent(state, {
          id: run.id,
          label: run.label,
          status,
          summary: visibleSummary,
          error,
          artifacts: run.artifacts,
        })
      } catch (e) {
        console.error(`[gateway] subagent wake failed: id=${run.id}`, e)
      }
    }
  }
  console.log(
    `[gateway] subagent done: id=${run.id} label="${run.label}" parent=${run.parentGatewaySessionId} status=${status}`,
  )
  // 防堆积：best-effort abort（硬顶路径 turn 可能还在跑）+ DELETE 子会话。
  // E 片（2026-09-12）缺陷二防御：拼 URL 前先验 ses 前缀，不符跳过并记一行日志。
  if (deps) {
    if (isOpenCodeSessionId(run.opencodeSessionId)) {
      const abortUrl = `${deps.openCodeUrl}/session/${run.opencodeSessionId}/abort`
      void fetch(abortUrl, { method: "POST", headers: deps.openCodeHeaders(), signal: AbortSignal.timeout(5000) }).catch(
        () => {},
      )
      void fetch(`${deps.openCodeUrl}/session/${run.opencodeSessionId}`, {
        method: "DELETE",
        headers: deps.openCodeHeaders(),
        signal: AbortSignal.timeout(5000),
      }).catch(() => {})
    } else {
      console.error(
        `[gateway] subagent cleanup skipped: id=${run.id} label="${run.label}" reason=invalid opencode session id "${String(run.opencodeSessionId)}"`,
      )
    }
  }
}

/**
 * 片 D（2026-09-15）：交付闸门 FAIL 后的机器化重派（bounded auto-rework，上限 1 次）。
 * **轮子复用**：与 retryWithNextModel 同范式——新子会话一律走 dispatchAttempt（内部
 * 自动继承宪法头注入、modelChain 当前模型、run.agent Expert 栏），禁自造第二套派遣逻辑。
 * 注入语义：run.prompt 尾部**追加**系统性修正指令（buildReworkDirective 逐字点名缺栏），
 * 原任务内容原样带过去；agent/beastMode/asyncMode 语义全部不动。
 * 计时器：重派＝新的完整硬顶预算（拆旧装新）——不重装则长任务剩余预算≈0，重派段必然
 * 撞硬顶转 status=error，把「重派后仍未达标」的诚实标记路径抢先污染成超时错误。
 * 同步 deadlineTimer 不动：其「主会话放行转后台」语义属首轮工具侧契约，重派段沿用。
 * 投递失败：孤儿会话 best-effort 清理、run 位回旧会话、记 reworkFailure，再进 finishRun
 * 回退到片 C 标记放行（不伪称 reworked、不动 status）。
 */
async function startRework(run: SubagentRun, verdict: DeliveryGateResult, firstText: string): Promise<void> {
  if (!deps) return
  const oldChild = run.opencodeSessionId
  run.prompt = `${run.prompt}\n\n---\n\n${buildReworkDirective(run.agent ?? "", verdict, DELIVERY_CONTRACTS)}`
  if (run.timeoutTimer) clearTimeout(run.timeoutTimer)
  const hardMs = run.asyncMode ? ASYNC_HARD_TIMEOUT_MS : HARD_TIMEOUT_MS
  run.timeoutTimer = setTimeout(() => {
    console.warn(`[gateway] subagent hard timeout in rework (${Math.round(hardMs / 60000)}min): id=${run.id} label="${run.label}"`)
    // 修 3：重派段逾时同样先落盘 partial。
    run.partialPersist = true
    run.reworking = false
    finishRun(run, "error", partialBodyOf(run), `子代理超时（${Math.round(hardMs / 60000)} 分钟），已强制结束`)
  }, hardMs)
  // D5（2026-10-02）：重派段同样有心跳／逾时前部分交付。
  armHeartbeat(run, hardMs)
  const failure = await dispatchAttempt(run)
  if (failure) {
    run.reworking = false
    // dispatchAttempt 可能已建的新会话（prompt_async 失败路径已摘 byChildOc 映射）：
    // best-effort 删掉孤儿，再把 run 的子会话位回拨到旧会话，让收尾清理对准真身。
    if (isOpenCodeSessionId(run.opencodeSessionId) && run.opencodeSessionId !== oldChild) {
      void fetch(`${deps.openCodeUrl}/session/${run.opencodeSessionId}`, {
        method: "DELETE",
        headers: deps.openCodeHeaders(),
        signal: AbortSignal.timeout(5000),
      }).catch(() => {})
    }
    run.opencodeSessionId = oldChild
    run.reworkFailure = failure
    console.error(`[gateway] delivery gate: id=${run.id} agent=${run.agent} REWORK dispatch failed: ${failure}`)
    finishRun(run, "ok", firstText)
    return
  }
  // 新会话注册成功后才摘旧映射（先立后破：run.id 在 status 端点的 byChildOc 视图无空窗）。
  if (oldChild && byChildOc.get(oldChild) === run) byChildOc.delete(oldChild)
  if (isOpenCodeSessionId(oldChild)) {
    void fetch(`${deps.openCodeUrl}/session/${oldChild}/abort`, {
      method: "POST",
      headers: deps.openCodeHeaders(),
      signal: AbortSignal.timeout(5000),
    }).catch(() => {})
    void fetch(`${deps.openCodeUrl}/session/${oldChild}`, {
      method: "DELETE",
      headers: deps.openCodeHeaders(),
      signal: AbortSignal.timeout(5000),
    }).catch(() => {})
  }
  run.reworking = false
  // 刀 F（2026-09-15）：重派子会话注册成功＝孤儿风险窗口开启，落一条持久记录；终态由
  // finishRun 清除。启动扫描据 child_oc 探 opencode，判断续检还是诚实治理。
  saveReworkRecord({
    runId: run.id,
    parentGw: run.parentGatewaySessionId,
    parentOc: run.parentOpencodeSessionId,
    childOc: run.opencodeSessionId,
    agent: run.agent ?? "",
    label: run.label,
    beast: run.beastMode === true,
    asyncMode: run.asyncMode === true,
    reworkCount: run.reworkCount,
  })
  console.log(
    `[gateway] delivery gate: id=${run.id} agent=${run.agent} REWORK dispatched (attempt=1) child=${run.opencodeSessionId} missing=${verdict.missing.join(",")}`,
  )
}

/** 档名安全化：去空白、替换 / \ : * ? " < > |；保留中文；去前导点防路径逃逸。 */
function safeLabelForFile(label: string): string {
  const cleaned = (label || "")
    .replace(/[/\\:*?"<>|]/g, "_")
    .replace(/\s+/g, "_")
    .replace(/^\.+/, "")
    .slice(0, 40)
  return cleaned || "subagent"
}

/** 用户可见的子代理名称映射（2026-10-04 F4）：内部审核身份的标签（「机器审核」等）与夹带
 *  内部栏名的标签一律降级为产品语言，禁止出现在任何用户可见文字里（死线：内审不上桌）。
 *  只用于文案；落盘文件名仍走 safeLabelForFile（不改文件名，避免破坏落盘契约与指针）。 */
const USER_FACING_LABEL_MAP: Record<string, string> = {
  "机器审核": "复核",
  "机器复核": "复核",
  "独立审核": "复核",
  "审核官": "复核",
}
function userFacingSubagentLabel(label: string): string {
  const l = (label || "").trim()
  if (USER_FACING_LABEL_MAP[l]) return USER_FACING_LABEL_MAP[l]
  if (/机器审核|独立审核|审核官|critic|verdict|issues|evidence|\bqc\b/i.test(l)) return "复核"
  return l || "子代理"
}

interface PersistOutcome {
  pointer: string
  relPath?: string
  chars: number
  failed?: string
}

/**
 * E 片（2026-09-12）缺陷一：完整结果/死因落盘（在 DELETE 子会话之前呼叫）。
 * 内容 = `# label` + runId/状态/模型/耗时/子会话元信息 + **未截断**正文（无正文时
 * 如实写死因事实，不伪造）+ 尾注 PERSIST_TAIL。644、与 opencode(agentsvc) 读取权限
 * 相容。**落盘失败不得让收尾失败**：全程 try/catch，失败 console.error 带 runId，
 * 指针改成诚实的失败前缀（不吞错、不装成功）。
 */
/** 修 3：join 本 run 已累积的文字 part（message.part.updated 存完整 text）作 partial 正文。 */
function partialBodyOf(run: SubagentRun): string {
  const parts: string[] = []
  for (const t of run.partText.values()) {
    if (typeof t === "string" && t.trim()) parts.push(t.trim())
  }
  return parts.join("\n").trim()
}

/** D5（2026-10-02）：心跳与逾时前部分交付。
 *  证据：硬逾时 22 次、会话实录「40 分钟无任何存活讯号」、中止即全丢（REPORT A8）。
 *  心跳间隔（60s）无文献依据，属待调参数（MCP progress / A2A 任务状态机为机制类别依据）。
 *  心跳不得抛错、不得改变 run 状态；计时器 unref，不阻挡进程退出。 */
function armHeartbeat(run: SubagentRun, hardMs: number): void {
  const hbMs = Number.parseInt(process.env.SUBAGENT_HEARTBEAT_MS || "", 10) || 60_000
  const earlyMs = Number.parseInt(process.env.SUBAGENT_EARLY_PARTIAL_MS || "", 10) || 120_000
  if (run.heartbeatTimer) clearInterval(run.heartbeatTimer)
  if (run.earlyPartialTimer) clearTimeout(run.earlyPartialTimer)
  run.heartbeatTimer = setInterval(() => {
    if (run.status !== "running" || run.stopped) return
    const state = deps?.resolveSession(run.parentGatewaySessionId) ?? deps?.findSessionByOpenCodeId(run.parentOpencodeSessionId)
    if (!state) return
    const elapsed = Math.round((Date.now() - run.startedAt) / 1000)
    try {
      // 2026-10-04 F4：心跳不得夹带子代理内部交付正文——契约栏名清单（verdict/issues/
      // evidence/qc）、「FAILED＋原因」、闸门核对说明会随 snippet 逐字外泄给用户。
      // 只留用户可读的状态句；标签经用户可见映射（「机器审核」→「复核」）。
      deps?.emitToSession(state, "turn.status", {
        text: `子代理「${userFacingSubagentLabel(run.label)}」仍在运行（已 ${elapsed}s）`,
      })
    } catch {
      /* 心跳失败不影响主流程 */
    }
  }, hbMs)
  unrefTimer(run.heartbeatTimer)
  if (hardMs > earlyMs + 30_000) {
    run.earlyPartialTimer = setTimeout(() => {
      if (run.status !== "running" || run.stopped) return
      const body = partialBodyOf(run)
      if (!body.trim()) return
      // 早于硬顶落盘快照，不改变 run 状态；run 真完成时 finishRun 以全文覆写同一档。
      persistRunOutput(run, "timeout", body, "（逾时前部分产物快照；run 仍在续跑，完成后覆写同一档）", true)
      console.warn(`[gateway] subagent early partial persisted: id=${run.id} label="${run.label}" chars=${body.length}`)
    }, hardMs - earlyMs)
    unrefTimer(run.earlyPartialTimer)
  }
}

function unrefTimer(t: ReturnType<typeof setTimeout> | ReturnType<typeof setInterval> | undefined): void {
  ;(t as unknown as { unref?: () => void } | undefined)?.unref?.()
}

// ── F8（2026-10-04）断面 B：async 子代理活性看门狗 ────────────────────────────
// 单一定时器扫全部在跑 run（刻意不用 per-run 计时器——避免与既有 timeout/heartbeat/
// earlyPartial 计时器的生命周期互相牵连）；unref，不阻挡进程退出；finishRun 的
// status 幂等守卫保证不会与硬顶/收尾路径双终态。
// 命中 stale 的处置：走既有 finishRun(error) → subagent.done + wakeParent（唤醒文案过
// 用户可见白名单 scrubSubagentPayload），父会话据此收束/重派。
let livenessTimer: ReturnType<typeof setInterval> | undefined

function startLivenessWatch(): void {
  if (livenessTimer) return
  livenessTimer = setInterval(livenessTick, subagentLivenessPollMs())
  unrefTimer(livenessTimer)
}

function livenessTick(): void {
  const staleMs = subagentStaleMs()
  const now = Date.now()
  // 快照遍历：finishRun 会同步/异步改动 byParent，先拷贝一份防迭代期增删。
  const runs: SubagentRun[] = []
  for (const list of byParent.values()) for (const r of list) runs.push(r)
  for (const run of runs) {
    if (run.status !== "running") continue
    const verdict = evaluateRunLiveness({
      status: run.status,
      stopped: run.stopped,
      asyncMode: run.asyncMode === true,
      reworking: run.reworking === true,
      now,
      lastActivityAt: run.lastActivityAt,
      pendingToolCount: run.pendingTools.size,
      staleMs,
    })
    if (!verdict.stale) continue
    const silentS = Math.round((now - run.lastActivityAt) / 1000)
    console.warn(
      `[gateway] subagent stale detected (no child activity ${silentS}s, no in-flight tool): id=${run.id} label="${run.label}" child=${run.opencodeSessionId}`,
    )
    // 逾时先落盘已累积的 partial（同一行为与硬顶路径一致），再 error 收尾。
    run.partialPersist = true
    void finishRun(run, "error", partialBodyOf(run), SUBAGENT_STALE_MESSAGE)
  }
}

function persistRunOutput(
  run: SubagentRun,
  status: "ok" | "error" | "timeout",
  body: string,
  errorText?: string,
  forcePartial = false,
): PersistOutcome {
  const text = typeof body === "string" && body.trim().length > 0 ? body : ""
  const death = typeof errorText === "string" && errorText.trim().length > 0 ? errorText : ""
  const content = text || death || "（无正文产出，且无死因文本）"
  const fileName = `${run.id}-${safeLabelForFile(run.label)}.md`
  const rel = `${SUBAGENT_OUTPUT_REL}/${fileName}`
  try {
    mkdirSync(SUBAGENT_OUTPUT_DIR, { recursive: true })
    const model = run.modelChain[run.attempt - 1]
    // 修 3：partial 落盘时「状态」标 partial（档名规则与终态一致）。
    const effStatus = forcePartial || run.partialPersist ? "partial" : status
    const meta = [
      `# ${run.label}`,
      "",
      `- runId: \`${run.id}\``,
      `- 状态: ${effStatus}`,
      `- 模型: ${model ? `${model.providerID}/${model.modelID}` : "opencode-default"}（attempt ${run.attempt}/${Math.max(run.modelChain.length, 1)}）`,
      `- 耗时: ${Math.round((Date.now() - run.startedAt) / 1000)}s（起 ${new Date(run.startedAt).toISOString()}）`,
      `- 子代理会话: ${run.opencodeSessionId || "-"}`,
      `- 内容: ${text ? "子代理最后一条 assistant 文本全文" : "无正文产出，以下为死因事实（未伪造）"}`,
      "",
    ].join("\n")
    const abs = join(SUBAGENT_OUTPUT_DIR, fileName)
    writeFileSync(abs, `${meta}${content}\n\n---\n\n${PERSIST_TAIL}\n`, { encoding: "utf8", mode: 0o644 })
    try {
      chmodSync(abs, 0o644) // 明确 644：不受进程 umask 影响
    } catch {
      /* chmod 失败不影响可读性（mode 已带） */
    }
    const pointer = run.partialPersist
      ? `[部分结果已落盘（partial）：${rel}（${content.length} 字）] `
      : `[完整结果已落盘：${rel}（${content.length} 字）] `
    return { pointer, relPath: rel, chars: content.length }
  } catch (e) {
    const reason = e instanceof Error ? e.message : String(e)
    console.error(`[gateway] subagent persist failed: id=${run.id} label="${run.label}" reason=${reason}`)
    return { pointer: `[完整结果落盘失败：${reason}] `, chars: 0, failed: reason }
  }
}

/**
 * E 片（2026-09-12）缺陷二防御：凡拼进 opencode session URL 的 id 必须是 `ses` 开头
 * 字串。09-12 实锤：子代理 run id（UUID）被塞进 opencode 的 session 位（session.error
 * code=tool_error message=Expected a string starting with "ses", got "0e160b80-…"）。
 * 不符就跳过该呼叫并 console.error 一行（不静默、不硬送半截 URL）。
 */
function isOpenCodeSessionId(id: unknown): id is string {
  return typeof id === "string" && id.startsWith("ses")
}

/** 2026-10-02 能力片：子代理文字区块。设计取自 Claude Code 子代理回传契约——
 *  取「最后一则有文字的 assistant 讯息」的 text 区块；loop 可能停在纯 tool_use 的
 *  assistant 讯息，此时回退到最近一则有文字的（未复制其程式码）。 */
function textBlocksOfMessage(m: { parts?: Array<{ type?: string; text?: string }> } | undefined): string {
  return (m?.parts ?? [])
    .filter((p) => p?.type === "text" && typeof p.text === "string")
    .map((p) => p.text as string)
    .join("\n")
    .trim()
}
function lastAssistantTextWithFallback(
  msgs: Array<{ info?: { role?: string }; parts?: Array<{ type?: string; text?: string }> }>,
): string {
  for (let i = msgs.length - 1; i >= 0; i--) {
    const m = msgs[i]
    if (m?.info?.role !== "assistant") continue
    const t = textBlocksOfMessage(m)
    if (t) return t
  }
  return ""
}

/** 用量计数：tool part 计数 ＋ token（最后一则 assistant 的 input/output/cache）
 *  ＋耗时。token 口径 = input+output+cache.read+cache.write（对齐 Claude Code
 *  getTokenCountFromUsage 的 input+cache_creation+cache_read+output 形态，未复制程式码）。 */
function computeSubagentUsage(
  msgs: Array<{ info?: { role?: string; tokens?: unknown }; parts?: Array<{ type?: string }> }>,
  startedAt: number,
): SubagentUsage {
  let toolCalls = 0
  for (const m of msgs) for (const p of m?.parts ?? []) if (p?.type === "tool") toolCalls++
  let tokens = 0
  const lastAssistant = [...msgs].reverse().find((m) => m?.info?.role === "assistant")
  const tk = lastAssistant?.info?.tokens
  if (tk && typeof tk === "object") {
    const t = tk as Record<string, unknown>
    for (const k of ["input", "output"]) {
      const v = t[k]
      if (typeof v === "number" && Number.isFinite(v)) tokens += v
    }
    const c = t.cache
    if (c && typeof c === "object") {
      const cc = c as Record<string, unknown>
      for (const k of ["read", "write"]) {
        const v = cc[k]
        if (typeof v === "number" && Number.isFinite(v)) tokens += v
      }
    }
  }
  return { tool_calls: toolCalls, duration_ms: Date.now() - startedAt, tokens }
}

/** 子会话 idle：取最后一条 assistant 文本作 summary。 */
async function summarizeChild(run: SubagentRun): Promise<void> {  // 片 D（2026-09-15）：重派投递在途——run 此刻仍挂在旧子会话 id 上（新会话尚未注册），
  // 旧会话残影事件（如重复 idle）不得把尚在重派链中的 run 提前收尾。
  if (run.reworking) return
  // E 片（2026-09-12）缺陷二防御：无合法子会话 id 就不拼 URL，如实收尾（死因落盘）。
  if (!isOpenCodeSessionId(run.opencodeSessionId)) {
    console.error(
      `[gateway] subagent summarize skipped: id=${run.id} label="${run.label}" reason=invalid opencode session id "${String(run.opencodeSessionId)}"`,
    )
    finishRun(run, "error", "", `子代理会话 id 非法（非 ses 前缀：「${String(run.opencodeSessionId)}」），无法取回结果`)
    return
  }
  let text = ""
  try {
    const res = await fetch(`${deps!.openCodeUrl}/session/${run.opencodeSessionId}/message`, {
      headers: deps!.openCodeHeaders(),
      signal: AbortSignal.timeout(10000),
    })
    if (res.ok) {
      const msgs = (await res.json()) as Array<{
        info?: { role?: string; tokens?: unknown }
        parts?: Array<{ type?: string; text?: string }>
      }>
      if (Array.isArray(msgs)) {
        // 2026-10-02 能力片：语义结果＝最后一则有文字的 assistant 讯息（loop 可能停在
        // 纯 tool_use 讯息，回退到最近有文字的一则）；非「全文前 600 字」。
        text = lastAssistantTextWithFallback(msgs)
        run.usage = computeSubagentUsage(msgs, run.startedAt)
      }
    }
  } catch (e) {
    console.error(`[gateway] subagent summarize failed: id=${run.id}`, e)
  }
  if (text) {
    finishRun(run, "ok", text)
    return
  }
  // 09-18 修复（七路全灭实锤）：上游渠道瞬断时 opencode 吞掉 stream error、子会话以
  // 「正常 idle + 零 assistant 文本」收尾——session.error 事件根本不会出现，下面的
  // 换模重试链因此从不触发，attempt 永远停在 1/5。此处补上对称触发点：零文本且链上
  // 还有备选模型 → 视同渠道故障换模重投；耗尽才如实 finishRun error（语义不变）。
  if (run.attempt < run.modelChain.length) {
    const nextAttempt = run.attempt + 1
    const oldChild = run.opencodeSessionId
    console.error(
      `[gateway] subagent empty-output (attempt ${run.attempt}/${run.modelChain.length}): id=${run.id} label="${run.label}" — 疑似上游渠道故障，换模重投`,
    )
    run.attempt = nextAttempt
    // 与 session.error 换模路径同款清理：旧子会话摘除 + best-effort DELETE + 映射重置。
    if (isOpenCodeSessionId(oldChild)) {
      byChildOc.delete(oldChild)
      void fetch(`${deps!.openCodeUrl}/session/${oldChild}`, {
        method: "DELETE",
        headers: deps!.openCodeHeaders(),
        signal: AbortSignal.timeout(5000),
      }).catch(() => {})
    }
    run.messageRole.clear()
    run.partEmitted.clear()
    run.partKind.clear()
    run.suppressedParts.clear()
    void retryWithNextModel(run, "子代理运行结束但没有产出文本（疑似上游渠道故障）")
    return
  }
  finishRun(run, "error", "", "子代理运行结束但没有产出文本")
}

/**
 * 建子会话并投递任务书（attempt = run.attempt 对应 modelChain 里的模型）。
 * 成功回 undefined；失败回可读原因（调用方决定 finishRun 还是换模重试）。
 * 注意：成功后 run.opencodeSessionId 已更新并重新注册 byChildOc。
 */
// ─────────────────────────────────────────── P0-4（2026-10-06）：本域配方库事实行
// 专家宪法第三条命令每个 Expert「进域即载配方库」，但注册表里部分域 skillPaths 为空
// （video-director / screenwriter / critic）——无条件命令会让子代理去找不存在的配方档。
// 真源＝src/lib/expert-registry.ts 的 EXPERT_REGISTRY[id].skillPaths（gateway 侧同内容的
// 生成物＝expert/registry-digest.txt 的「配方库」栏）。gateway 是独立发布单元（只发布
// deploy-staging/gateway），运行时**无法** import 仓库 src/lib → 本表为逐字镜像，与
// delivery-gate.ts 镜像 *_DELIVERABLES 契约的既有范式同构；改注册表 skillPaths 必须同步本表。
const EXPERT_SKILL_PATHS: Readonly<Record<string, readonly string[]>> = {
  director3d: ["skills/blender-director/SKILL.md"],
  music: ["skills/music-director/SKILL.md", "skills/music-director/files/"],
  "video-director": [],
  editor: [
    "skills/editor/SKILL.md",
    "skills/editor/assembly/SKILL.md",
    "skills/editor/audio-first/SKILL.md",
    "skills/editor/rhythm/SKILL.md",
    "skills/editor/look/SKILL.md",
    "skills/editor/mix/SKILL.md",
    "skills/editor/qc-master/SKILL.md",
  ],
  screenwriter: [],
  "motion-director": ["skills/motion-design/"],
  "web3d-director": ["skills/web-3d-awwwards/SKILL.md"],
  critic: [],
}

/**
 * 派工任务书头部的「本域配方库」事实行（P0-4）。有路径＝列出并声明进域即载、常驻；
 * 空＝明写本域无配方库，直接用域工具，不要去找配方档；未登记（非 Expert）＝空串（零注入）。
 */
function buildExpertSkillFact(agent: string | undefined): string {
  if (typeof agent !== "string" || agent.length === 0) return ""
  const paths = EXPERT_SKILL_PATHS[agent]
  if (!paths) return ""
  if (paths.length === 0) {
    return "【本域配方库】本域无配方库（未配置）。直接用你的域工具，不要去找配方档。\n\n"
  }
  return `【本域配方库】${paths.join("、")} —— 这是本域配方库，进域即载，常驻。\n\n`
}

async function dispatchAttempt(run: SubagentRun): Promise<string | undefined> {
  let childId: string | undefined
  try {
    const res = await fetch(`${deps!.openCodeUrl}/session`, {
      method: "POST",
      headers: deps!.openCodeHeaders(),
      body: "{}",
      signal: AbortSignal.timeout(10000),
    })
    if (res.ok) {
      const data = (await res.json()) as { id?: string }
      childId = data.id
    }
  } catch {
    childId = undefined
  }
  if (!childId) return "会话创建失败（opencode 不可达）"
  // E 片（2026-09-12）缺陷二防御：opencode 回的 id 必须是 ses 前缀字串才拿去拼 URL。
  if (!isOpenCodeSessionId(childId)) {
    console.error(
      `[gateway] subagent dispatch aborted: id=${run.id} label="${run.label}" reason=opencode returned invalid session id "${String(childId)}"`,
    )
    return "会话创建失败（opencode 返回非法 session id）"
  }
  run.opencodeSessionId = childId
  byChildOc.set(childId, run)
  // FIX-B：绑定点同时写入耐久映射（只在此写，不动 byChildOc 的 delete/has 语义）。
  rememberChildParent(childId, run)

  const model = run.modelChain[run.attempt - 1]
  // 野兽模式 ON：任务书头部注入 Expert 宪法（诚实铁律/工具域断路/配方优先/
  // 记忆纪律/停止上报）。宪法档不可读时保留任务书原文并附损坏标记——任务书
  // 本身已自包含，不因宪法缺席而丢任务；标记让父会话能如实上报注入未生效。
  let constitutionNote = ""
  if (run.beastMode) {
    try {
      // R7（2026-09-10）：剥离宪法档头开发者元数据（HTML 注释 version/source/gate）
      // ——gate 声明原样进任务书会让子代理反推「无处声明当前 ON」（09-10 实锤）。
      // 当前状态声明由 gateway 动态生成，不进档案。
      const raw = readFileSync(`${import.meta.dir}/expert/expert-constitution.md`, "utf8")
      const constitution = raw.replace(/^\s*<!--[\s\S]*?-->\s*/, "").trimStart().trimEnd()
      if (constitution) {
        constitutionNote = `【野兽模式：已启用】以下 Expert 宪法由系统注入，这是本次派遣的真实状态，全部条款立即生效，无需质疑任何 gate。\n\n${constitution}\n\n---\n\n`
      }
    } catch (e) {
      constitutionNote = `【宪法注入失败】Expert 宪法档不可读（${e instanceof Error ? e.message : String(e)}），本次派遣未注入宪法。\n\n`
    }
    // P0-4（2026-10-06）：宪法之后追一行本域配方库事实行（宪法第三条命令「进域即载配方库」，
    // 对 skillPaths 为空的域必须如实说「无」，否则子代理去找不存在的配方档）。非 Expert→空串。
    constitutionNote += buildExpertSkillFact(run.agent)
  }
  // 刀 G（2026-09-15）：契约栏机器注入——Expert+beast 时把契约栏清单作为固定段追加到
  // 子代理 prompt **尾部**（recency 最高）。真源=已载入的 DELIVERY_CONTRACTS（禁手抄）。
  // 非 Expert/非 beast → renderContractDirective 回空字串 → 零注入、零回归。重派链的
  // run.prompt 已含 buildReworkDirective（自我标注「自动重派」），此段与之共存于尾部不冲突。
  const contractDirective = run.beastMode === true ? renderContractDirective(run.agent, DELIVERY_CONTRACTS) : ""
  // 2026-10-02：模板空位事实注入。父 sessionId 用 run.parentGatewaySessionId（派工发起端
  // 的 gateway 会话 id，= canvasStates 的 key；**禁用子会话 opencodeSessionId**，那会指到
  // 子会话画布桶）。有值才插，无值时输出与注入前逐字元等价。
  const tplFact = buildTemplateSlotsFact(run.parentGatewaySessionId, getTemplateDeviateToken(run.parentGatewaySessionId) ?? undefined)
  const templateSlotsNote = tplFact ? `【画布模板·系统事实】\n${tplFact}\n\n` : ""
  const body: Record<string, unknown> = { parts: [{ type: "text", text: `${constitutionNote}${run.prompt}${templateSlotsNote}${contractDirective}` }] }
  if (model) body.model = model
  // R8 修复片2（2026-09-10）：Expert agent 栏（prompt_async 吃 agent 栏；
  // POST /session 不支持，08-08 实锤）。带上 = 子会话挂对应 Expert agent
  // （工具表裁剪到该域）；缺省 = default build 零变化。换模重试
  // （retryWithNextModel）走本函数，agent 自然继承。
  if (run.agent) body.agent = run.agent
  try {
    const res = await fetch(`${deps!.openCodeUrl}/session/${childId}/prompt_async`, {
      method: "POST",
      headers: deps!.openCodeHeaders(),
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(10000),
    })
    if (!res.ok) throw new Error(`prompt_async status ${res.status}`)
  } catch (e) {
    byChildOc.delete(childId)
    return `任务投递失败：${(e as Error).message}`
  }
  // F8（断面 B）：新子会话投递成功＝活性起点；清上一 attempt 的在途工具残留。
  run.lastActivityAt = Date.now()
  run.pendingTools.clear()
  console.log(
    `[gateway] subagent attempt: id=${run.id} label="${run.label}" attempt=${run.attempt}/${Math.max(run.modelChain.length, 1)} model=${model ? `${model.providerID}/${model.modelID}` : "opencode-default"} child=${childId} agent=${run.agent ?? "-"}`,
  )
  return undefined
}

/** 上游错误后的换模重试：新子会话 + 链上下一个模型重投任务书。 */
async function retryWithNextModel(run: SubagentRun, lastError: string): Promise<void> {
  // 0920 停止闸：已停止的 run 不得被换模重投复活（病灶③）。
  if (run.stopped || run.status !== "running") {
    console.log(`[gateway] subagent retry skipped (stopped): id=${run.id} label="${run.label}"`)
    return
  }
  const failure = await dispatchAttempt(run)
  if (!failure) return // 重投成功：事件流继续，等 idle/error 收尾
  console.error(`[gateway] subagent retry dispatch failed: id=${run.id} ${failure}`)
  finishRun(run, "error", "", `子代理出错：${lastError}（换模重投也失败：${failure}）`)
}

/** 全局 tap 入口：子会话事件翻译成 subagent.* 帧发到父会话。 */
export function handleSubagentEvent(event: any, opencodeSessionId: string): void {
  if (!deps) return
  const run = byChildOc.get(opencodeSessionId)
  if (!run) return
  // 0920 停止闸：停止后子会话已 DELETE，残影事件一律丢弃（否则又推进卡片状态、
  // 甚至触发换模重投把 run 复活）。
  if (run.stopped) return
  // F8（断面 B）：任何子会话事件都刷新活性时间戳——这是活性检测「子会话仍在写入/
  // 仍在发事件」的唯一证据来源（含 part 增量、工具状态、session.idle 等）。
  run.lastActivityAt = Date.now()
  try {
    // 上游错误（session.error 或任意带 properties.error 的事件）→ 换模重试或 done error。
    const err = event?.properties?.error
    if (event?.type === "session.error" || err != null) {
      const msg = err != null ? deps.describeError(err) : "子代理上游错误"
      // 只有上游模型错误（opencode APIError 形状 {name, data:{message}}）才换模重试；
      // tool_error/Aborted 不是渠道问题，换模无意义，维持原语义直接收尾。
      const isUpstreamApiError =
        Boolean(err) && typeof err === "object" && typeof (err as { data?: { message?: unknown } }).data?.message === "string"
      if (isUpstreamApiError && run.attempt < run.modelChain.length) {
        const nextAttempt = run.attempt + 1
        console.error(
          `[gateway] subagent upstream error (attempt ${run.attempt}/${run.modelChain.length}): id=${run.id} label="${run.label}" error=${msg} — 换模重投`,
        )
        run.attempt = nextAttempt
        // 旧子会话摘除 + best-effort 清理；per-child 映射重置，避免新会话被脏状态误判。
        byChildOc.delete(opencodeSessionId)
        // E 片（2026-09-12）缺陷二防御：ses 前缀不符就不拼 URL（跳过并记录）。
        if (isOpenCodeSessionId(opencodeSessionId)) {
          void fetch(`${deps.openCodeUrl}/session/${opencodeSessionId}`, {
            method: "DELETE",
            headers: deps.openCodeHeaders(),
            signal: AbortSignal.timeout(5000),
          }).catch(() => {})
        } else {
          console.error(
            `[gateway] subagent cleanup skipped (retry): id=${run.id} reason=invalid opencode session id "${String(opencodeSessionId)}"`,
          )
        }
        run.messageRole.clear()
        run.partEmitted.clear()
        run.partKind.clear()
        run.suppressedParts.clear()
        void retryWithNextModel(run, msg)
        return
      }
      console.error(
        `[gateway] subagent failed: id=${run.id} label="${run.label}" attempt=${run.attempt}/${Math.max(run.modelChain.length, 1)} error=${msg}`,
      )
      // 0919 诚实归因（video-director 试产事故）：shuai 预扣费闸的「预扣费额度失败,
      // 用户剩余额度…」原文直出时，orchestrator 在 model-not-found 噪音里把欠费
      // 误读成「模型不可用」再转述给用户。欠费死因补一句归因：未提交、未扣费、
      // 无产物、充值前重试无效——错误分类给机器，因果说明给读它的模型。
      const deadAccountNote = /预扣费额度失败|insufficient[ _-]?(account[ _-]?)?(balance|credit)|余额不足|欠费/i.test(String(msg))
        ? "（归因：上游渠道账户余额不足即欠费，不是模型不可用；本次调用未提交、未扣费、无产物，充值前重试不会成功）"
        : ""
      finishRun(run, "error", "", `子代理出错：${String(msg)}${deadAccountNote}`)
      return
    }

    const parentState = parentStateOf(run)
    if (!parentState) return // 父会话已被回收：不再发帧，等 idle/超时收尾
    // 2026-10-04 F6：机器内审 run（critic pass）的推理/正文一律不上屏——内审正文对用户零价值，
    // 且是 R3 实测最大的外泄通道（subagent.delta 把子代理正文按帧流给父会话，实测含
    // evidence/qc/verdict/退回）。此处按 run 身份整体抑制；非内审子代理照常流，咽喉点再做 token 级兜底。
    const hideBody = run.machineCriticPass === true

    switch (event?.type) {
      case "message.updated": {
        const info = event?.properties?.info
        const mid = typeof info?.id === "string" ? info.id : undefined
        const role = typeof info?.role === "string" ? info.role : undefined
        if (mid && role) {
          run.messageRole.set(mid, role)
          boundMap(run.messageRole, 200)
        }
        // 压缩复读机修复（2026-10-02）：compaction 摘要讯息 role 也是 assistant，
        // 标成非 assistant 后 subagent.delta 不再把摘要草稿当子代理正文上屏。
        if (mid && role === "assistant" && info?.summary === true) {
          run.messageRole.set(mid, "compaction")
          boundMap(run.messageRole, 200)
        }
        break
      }
      case "message.part.delta": {
        const p = event.properties ?? {}
        // text 字段同一通道：正文与 reasoning 增量都转成 subagent.delta，
        // 前端只取最近一行，网关不裁。role 只认 assistant（防用户 prompt 回声）。
        if (p.field === "text" && typeof p.delta === "string" && p.delta.length > 0) {
          if (typeof p.messageID !== "string" || run.messageRole.get(p.messageID) !== "assistant") break
          if (typeof p.partID === "string" && run.suppressedParts.has(p.partID)) break
          // S3（2026-09-11）：reasoning 增量一并转发（跑马灯要让用户感知「子代理在
          // 工作」），用 kind 与正文区分；正文 payload 维持原样不带 kind（零回归）。
          const kind = typeof p.partID === "string" ? run.partKind.get(p.partID) : undefined
          if (!hideBody) {
            deps.emitToSession(
              parentState,
              "subagent.delta",
              kind === "reasoning" ? { id: run.id, text: p.delta, kind } : { id: run.id, text: p.delta },
            )
          }
          if (typeof p.partID === "string") {
            run.partEmitted.set(p.partID, (run.partEmitted.get(p.partID) ?? 0) + p.delta.length)
            boundMap(run.partEmitted, 200)
          }
        }
        break
      }
      case "message.part.updated": {
        const part = event?.properties?.part
        if (!part) break
        // F8（断面 B）：工具在途登记/摘除。「有在途工具」时长期静默是正常的（长生成，
        // 如 music_gen 真生成 150-180s），活性检测据此放行、绝不误杀。
        if (part.type === "tool") {
          const callId = typeof part.callID === "string" ? part.callID : typeof part.id === "string" ? part.id : ""
          const st = typeof part.state?.status === "string" ? part.state.status : ""
          if (callId && st) {
            if (st === "pending" || st === "running") {
              run.pendingTools.add(callId)
              boundSet(run.pendingTools, 200)
            } else if (st === "completed" || st === "error") {
              run.pendingTools.delete(callId)
            }
          }
          // 2026-10-05：向父会话发子代理工具状态帧。此前网关从不发这类帧 → 长工具
          // （音乐生成 150-180s）期间前端只看到一段可能空白的跑马灯，用户以为卡死。
          // 只在状态**变化**时发一次（同一 part 会多次 updated）；payload 契约与前端
          // agent-chat-types.ts 的 AgentSubagentTool 对齐：
          //   { id: 子代理 run id, call_id, tool, status: "running"|"ok"|"failed" }
          // 工具名原样送（前端用既有 toolDisplayName() 转人话），不在此造中文、
          // 不送 state.title/input（可能含内部路径与命令原文，属于泄漏面）。
          if (callId && st) {
            const frameStatus = st === "pending" || st === "running" ? "running" : st === "completed" ? "ok" : "failed"
            if (run.toolStatusEmitted.get(callId) !== frameStatus) {
              run.toolStatusEmitted.set(callId, frameStatus)
              boundMap(run.toolStatusEmitted, 200)
              deps.emitToSession(parentState, "subagent.tool", {
                id: run.id,
                call_id: callId,
                tool: typeof part.tool === "string" ? part.tool : "tool",
                status: frameStatus,
              })
            }
          }
        }
        // FIX-A（2026-10-02）：子代理工具结果的媒体成品 → 父会话出卡。野兽模式下音乐/影片
        // 只能在 Expert 子代理里产生，而其 tool part 此前整类被丢弃 ⇒ 子代理做出的影片/音乐
        // 永远不出卡（暴君抱怨「影片／音乐不主动弹出」的真主因）。只认 completed；去重交给
        // emitVideoDone/emitAudioDone 的 state.announcedUrls（同一 part 可能多次 updated、
        // completed 可能重复触发）。刻意**不处理 image**：子代理（如 video-director）会产大量
        // 中间关键帧，一并发 image.done 会把聊天框灌爆——只放行成片类媒体，刻意的不对称。
        if (part.type === "tool" && part.state?.status === "completed") {
          const parsedOut = parseToolOutput(part.state.output)
          // 2026-10-05：子代理的生成任务必须登记进**父会话**任务表。此前这里只把媒体升格成
          // 卡片、task_id 整类丢弃 ⇒ 父模型用 image_get_result（读 /internal/session-tasks）
          // 查不到自己子代理提交过的任何 job（「每个预览卡都是成品、模型自己都不知道」）。
          // attachCanvasTask 只在 parentState.canvasUnitByCall 命中时才有画布副作用；子代理
          // 的 callID 不在父会话表里 ⇒ 此处等价于「只登记任务」。
          const childCallId =
            typeof part.callID === "string" ? part.callID : typeof part.id === "string" ? part.id : ""
          if (parsedOut && typeof parsedOut.task_id === "string" && parsedOut.task_id) {
            attachCanvasTask(parentState, childCallId, parsedOut.task_id)
          }
          const media = collectToolOutputMediaUrls(parsedOut)
          for (const c of media.video) {
            if (!run.artifacts.some((a) => a.url === c.url)) {
              run.artifacts.push({ kind: "video", url: c.url, task_id: parsedOut?.task_id, cost_coins: c.cost_coins })
            }
            void emitVideoDone(parentState, c.url, c.cost_coins, undefined, "video")
          }
          for (const c of media.audio) {
            if (!run.artifacts.some((a) => a.url === c.url)) {
              run.artifacts.push({ kind: "audio", url: c.url, task_id: parsedOut?.task_id, cost_coins: c.cost_coins })
            }
            void emitAudioDone(parentState, c.url, c.cost_coins, undefined, "audio")
          }
        }
        if (part.type !== "text" && part.type !== "reasoning") {
          // step-start 与未知类型不可达前端：记 partID，其 delta 一并丢弃
          //（delta 事件自身不带类型，与主路径 suppressedParts 同语义）。
          const pid = typeof part.id === "string" ? part.id : ""
          if (pid) run.suppressedParts.add(pid)
          break
        }
        const id = typeof part.id === "string" ? part.id : ""
        if (!id) break
        // S3（2026-09-11）：part 建立那一刻（text 还是空串）就登记类型——空文本会走
        // 下面的早退分支，登记必须放在早退之前，否则其 delta 全部丢 kind（实弹实锤）。
        run.partKind.set(id, part.type)
        boundMap(run.partKind, 200)
        // 修 3：保存 text part 最新全文（part.updated 带完整 text），供逾时/中止 partial 落盘。
        if (part.type === "text" && typeof part.text === "string") {
          run.partText.set(id, part.text)
          boundMap(run.partText, 200)
        }
        if (typeof part.text !== "string") break
        if (part.text.length === 0) break
        if (typeof part.messageID !== "string" || run.messageRole.get(part.messageID) !== "assistant") break
        const emittedLen = run.partEmitted.get(id) ?? 0
        if (part.text.length > emittedLen) {
          const suffix = part.text.slice(emittedLen)
          if (!hideBody) {
            deps.emitToSession(
              parentState,
              "subagent.delta",
              part.type === "reasoning" ? { id: run.id, text: suffix, kind: "reasoning" } : { id: run.id, text: suffix },
            )
          }
          run.partEmitted.set(id, part.text.length)
          boundMap(run.partEmitted, 200)
        }
        break
      }
      case "session.idle": {
        // 子会话 turn 结束：取最后一条 assistant 文本收尾（异步，不阻塞 tap）。
        void summarizeChild(run)
        break
      }
      default:
        break
    }
  } catch (e) {
    console.error(`[gateway] subagent event translation failed: type=${event?.type}`, e)
  }
}

// ── 刀 2（2026-09-15）：machine critic pass —— gateway 自己在收盘判定点派 critic ────────────
// 四轮实录：playbook 第 18 条「必须派 critic」四轮在场、orchestrator 四轮零派遣（r3c 逐字
// 「I won't re-dispatch anything…synthesis is my job」）。纯 prompt 路线已证死 → 不叫模型派。
//
// 挂点＝父会话 session.idle 正常收尾分支（index.ts），调本函数。设计铁律：
//   · 派遣轮子**复用 dispatchAttempt**（同 handleSubagentDispatch 范式：建子会话 + agent 栏
//     + 宪法头 + 契约栏注入 + modelChain），禁自造第二套派遣/轮询。
//   · async 语义沿用：终态由 finishRun → deps.wakeParent 回件（通过抑制唤醒、退回送判决）。
//   · 有界：每会话 ≤1 次（persistence.critic_passes 持久旗标 + 内存镜像）；critic run 自身
//     agent==="critic" 永不入待审清单（finishRun 登记侧已豁免）= 不递归。
//   · 零预算外泄：只在「本来就有 Expert 交付」时跑；同轮已有 critic 派遣 → 不重派。
//   · 并发上限让位：父会话已满 3 路（如 async 子代仍在跑）→ 本轮放弃、不记旗标，下轮 idle 再试。

/**
 * 收盘判定点呼叫：条件成立 → 机器派遣一次 critic pass。回 true = 已派出。
 * 幂等/有界全部在内部（见上方注解）。任何失败只留一行 log，绝不影响收盘路径。
 */
export function maybeRunMachineCriticPass(parentState: any, unreviewedDeclared = false): boolean {
  try {
    if (!deps || !parentState?.sessionId) return false

    // ① 待审清单（finishRun 对 Expert 正常终态登记）。空 → 零动作（非 beast/无 Expert 交付）。
    const parentId = String(parentState.sessionId)
    const targets = pendingCriticTargets.get(parentId) ?? []
    if (targets.length === 0) return false

    // ② 每会话 ≤1 次：内存镜像 or 持久旗标（重启后仍生效）。
    const alreadyPassed = criticPassUsed.has(parentId) || hasCriticPass(parentId)

    // ③ 纯函数判据（四态单测对象）。
    const ok = shouldTriggerCriticPass({
      beastMode: deps.beastMode(parentState) === true,
      expertDeliveries: targets.length,
      criticDispatched: criticDispatchedByParent.get(parentId) === (parentState.turnGen ?? 0),
      unreviewedDeclared: unreviewedDeclared === true, // 逃生阀由呼叫端（index.ts 扫本轮正文）判定
      alreadyPassed,
    })
    if (!ok) return false

    // ④ 修 1（2026-10-02）：并发上限满时**不再丢弃**——待审目标入队（per-parent），
    // 任一子代理完成释放槽位时由 maybeDrainCriticQueue 补跑。此前 return false 直接
    // 丢弃（实锤：四次被挤掉；唯一一次跑到时 verdict 亦未回灌）。
    const list = byParent.get(parentId) ?? []
    if (list.length >= MAX_ACTIVE_PER_PARENT) {
      criticRetryQueue.set(parentId, targets.slice(-CRITIC_PASS_MAX_TARGETS))
      boundMap(criticRetryQueue, 500)
      console.log(
        `[gateway] machine critic pass queued (parent at concurrency cap ${MAX_ACTIVE_PER_PARENT}, retry on slot release): session=${parentId}`,
      )
      return false
    }
    // 修 1：正常派出（槽位有余）时清残留队列，避免稍后 drain 重复派遣。
    criticRetryQueue.delete(parentId)

    // ⑤ spec：被审清单 + 各 Expert 契约栏（真源 DELIVERY_CONTRACTS）+ 固定审核指令。
    const batch = targets.slice(-CRITIC_PASS_MAX_TARGETS)
    const spec = buildCriticPassSpec(batch, DELIVERY_CONTRACTS)
    if (!spec) return false

    // ⑥ modelChain 同源（父会话 persona 主模型 + registry fallbacks）。
    let chain: SubagentModelRef[] = []
    try {
      chain = deps.subagentModelChain(parentState) ?? []
    } catch (e) {
      console.error(`[gateway] machine critic pass model chain failed (fallback to opencode default): session=${parentId}`, e)
    }

    const run: SubagentRun = {
      id: crypto.randomUUID(),
      parentGatewaySessionId: parentId,
      parentOpencodeSessionId: String(parentState.opencodeSessionId ?? ""),
      opencodeSessionId: "",
      label: "复核",
      startedAt: Date.now(),
      status: "running",
      // 首行补死线行（与 handleSubagentDispatch 同款；本 spec 首行非「预期 N」故会补）。
      prompt: SPEC_DEADLINE_LINE + spec,
      modelChain: chain,
      attempt: 1,
      reworkCount: 0,
      beastMode: true, // 已过 beastMode 判据
      agent: "critic",
      asyncMode: typeof deps.wakeParent === "function", // async 语义沿用；deps 未注入则降级同步
      machineCriticPass: true,
      // 2026-10-03：把被审的那批交付正文带进 run，供终态事后硬检抽取媒体 URL（见
      // applyMeasuredMediaVerdict）。此处 batch 即将被 pendingCriticTargets.delete 清掉。
      criticReviewed: batch,
      messageRole: new Map(),
      partEmitted: new Map(),
      partKind: new Map(),
      suppressedParts: new Set(),
      partText: new Map(),
      lastActivityAt: Date.now(),
      pendingTools: new Set(),
      artifacts: [],
      toolStatusEmitted: new Map(),
    }

    // 注册进 byParent：与 handleSubagentDispatch 同语义——critic run 占一个并发位、
    // finishRun 的 removeFromRegistries 才能正确摘除本 run（否则残留注册表泄漏）。
    const parentRuns = byParent.get(parentId) ?? []
    parentRuns.push(run)
    byParent.set(parentId, parentRuns)

    // 先记旗标与派遣位（同步），再投递；投递失败则回滚旗标（不白吃唯一一次配额）。
    criticPassUsed.add(parentId)
    markCriticPass(parentId)
    criticDispatchedByParent.set(parentId, parentState.turnGen ?? 0)
    boundMap(criticDispatchedByParent, 500)
    // 已消耗：清待审清单（本会话不再有第二次 pass）。
    pendingCriticTargets.delete(parentId)

    const asyncMode = run.asyncMode === true
    const hardMs = asyncMode ? ASYNC_HARD_TIMEOUT_MS : HARD_TIMEOUT_MS
    run.timeoutTimer = setTimeout(() => {
      console.warn(`[gateway] subagent hard timeout (${Math.round(hardMs / 60000)}min): id=${run.id} label="${run.label}"`)
      // 修 3（2026-10-02）：逾时先落盘已累积的 partial 文字，再 error 收尾（不让已有工作不可追）。
      run.partialPersist = true
      finishRun(run, "error", partialBodyOf(run), `子代理超时（${Math.round(hardMs / 60000)} 分钟），已强制结束`)
    }, hardMs)
    // D5（2026-10-02）：机器 critic run 亦有心跳／逾时前部分交付。
    armHeartbeat(run, hardMs)

    // ⑦ 复用既有轮子投递（async 语义：立即返回，终态 wake）。
    void (async () => {
      const failure = await dispatchAttempt(run)
      if (failure) {
        criticPassUsed.delete(parentId)
        criticDispatchedByParent.delete(parentId)
        console.error(`[gateway] machine critic pass dispatch failed: session=${parentId} ${failure}`)
        // 回滚持久旗标：投递从未成功＝配额未消耗（不白吃唯一一次），清掉记录让下轮重试。
        deleteCriticPass(parentId)
        return
      }
      deps!.emitToSession(parentState, "subagent.started", { id: run.id, label: run.label })
      console.log(
        `[gateway] machine critic pass: session=${parentId} experts=${batch.length} dispatched critic_run=${run.id} child=${run.opencodeSessionId} agents=${batch.map((t) => t.agent).join(",")}`,
      )
    })()

    return true
  } catch (e) {
    console.error("[gateway] machine critic pass failed:", e)
    return false
  }
}

/** 修 1：槽位释放后补跑被并发上限挤掉的 machine critic pass（per-parent 队列）。
 *  复用 maybeRunMachineCriticPass 的完整判据与派遣轮子（不另造第二套）。 */
function maybeDrainCriticQueue(parentId: string): void {
  const queued = criticRetryQueue.get(parentId)
  if (!queued || queued.length === 0 || !deps) return
  if ((byParent.get(parentId) ?? []).length >= MAX_ACTIVE_PER_PARENT) return
  const parentState = deps.resolveSession(parentId)
  if (!parentState?.sessionId) return
  criticRetryQueue.delete(parentId)
  if (maybeRunMachineCriticPass(parentState, false)) {
    console.log(`[gateway] machine critic pass drained from queue: session=${parentId} targets=${queued.length}`)
  } else {
    console.error(`[gateway] machine critic pass drain not dispatched: session=${parentId}`)
  }
}

/**
 * 会话拆除时清 machine critic pass 的内存状态（待审清单 / 派遣登记 / 内存已用旗标）。
 * 持久旗标（persistence.critic_passes）刻意不清：idle reap 后同 id revive 仍受「每会话 ≤1 次」
 * 约束；真删除时 row 随会话生命周期结束自然无害（无查询点）。
 */
export function forgetCriticPassState(parentId: string): void {
  if (!parentId) return
  pendingCriticTargets.delete(parentId)
  criticDispatchedByParent.delete(parentId)
  criticPassUsed.delete(parentId)
  criticRetryQueue.delete(parentId)
}
/**
 * 刀 1（2026-09-19）：待审 Expert 交付快照（Jev 空壳栏初筛喂料）。
 * 只读镜像——不清空、不影响 machine critic pass 的消耗语义（浅拷贝阵列，
 * text 引用共享：呼叫方只读）。无待审 → 空阵列。
 */
export function snapshotPendingCriticTargets(parentId: string): Array<{ agent: string; label: string; runId: string; text: string }> {
  if (!parentId) return []
  return (pendingCriticTargets.get(parentId) ?? []).slice()
}
/**
 * POST /internal/subagent/dispatch — body { sessionId, label, prompt, async? }。
 * sessionId 接受 gateway id 或父 opencode id（与 /internal/workflow 同语义）。
 * 返回 { ok: true, subagent_id } 供工具轮询 /internal/subagent/status。
 * R6（2026-09-10）：async=true → 投递后立即返回 running，子代理终态时
 * deps.wakeParent 自动唤醒父会话汇总（默认 false=同步语义零回归；deps 未注入
 * wakeParent 时 async 请求按同步处理，不裸奔）。
 */
export async function handleSubagentDispatch(req: Request): Promise<Response> {
  if (!deps) return Response.json({ ok: false, code: "runtime_not_initialized", error: "subagent runtime not initialized" }, { status: 500 })
  const body = (await req.json().catch(() => ({}))) as {
    sessionId?: string
    label?: string
    prompt?: string
    async?: boolean
    expert?: string
  }
  const label = typeof body.label === "string" ? body.label.trim() : ""
  // P2b 刀1：prompt 需可被自动补行改写。
  let prompt = typeof body.prompt === "string" ? body.prompt : ""
  if (!body.sessionId || !label || !prompt) {
    // D2（2026-10-02）：空字串错误码是反模式（历史 717 次）——失败一律带 code 与缺哪栏。
    const missing = [!body.sessionId ? "sessionId" : "", !label ? "label" : "", !prompt ? "prompt" : ""].filter(Boolean)
    return Response.json(
      { ok: false, code: "missing_required_args", error: `sessionId/label/prompt 均为必填；缺少：${missing.join("、")}`, missing },
      { status: 400 },
    )
  }
  // P2b 刀1：首行自动补死线行。已写「预期/预期 N」= 原样不动（避免双补）。
  // 字符集与 R1 parseSyncDeadlineMs 对齐（简/繁皆认），确保不重复补。
  if (!/^\s*[预预]\s*期\s*\d/.test(prompt)) {
    prompt = SPEC_DEADLINE_LINE + prompt
  }
  const parent = deps.resolveSession(body.sessionId)
  if (!parent) {
    return Response.json({ ok: false, code: "session_not_found", error: "父会话不存在或已过期" }, { status: 404 })
  }
  // R6：async 开关。显式 true 且 wakeParent 已注入才走异步；否则一律同步（默认路径零变化）。
  // 刀3（2026-09-19）：async 三条件机器化（playbook 1.9 起 LLM 不再自判）——
  // beast 下明确要求 sync（async:false）时，Jev 判「非单一快速事实查询」→ 自动
  // 转 async 并记 SYNC_DOWNGRADED；Jev 挂 → 放行 sync（fail-open＝现状行为）。
  let asyncMode = body.async === true && typeof deps.wakeParent === "function"
  if (!asyncMode && body.async === false && typeof deps.wakeParent === "function") {
    const eligible = await syncDispatchEligible(prompt)
    if (eligible === false) {
      asyncMode = true
      console.log(`[gateway] jev_gate: SYNC_DOWNGRADED label="${label}" (not a quick fact lookup, forced async)`)
    }
  }

  // R8 修复片2（2026-09-10）＋刀3 权威化（2026-09-19）：Expert 路由。
  // 仅 beast_mode ON 时生效（OFF 时 expert 静默丢弃 = 零 OFF 回归）。
  // 刀3 教义（2026-09-19 立、2026-10-02 暴君修正）：「派谁」不是 LLM 的决策——
  //   ① expert 栏可省略：省略时 Jev 选域（高信心才派，否则通用子代理）；
  //   ② LLM 点名 expert＝最终裁决：Jev 高信心不同意只记 ROUTE_DISSENT，不改派
  //     （原 ROUTE_OVERRIDE 已废除——曾把点名 video-director 的预览转存强改派
  //     editor，改派后域内无鉴权工具全 401；表面词汇无法反映工具持有面）；
  //   ③ Jev 挂 → fail-open 用点名值（行为＝部署前）。
  // 白名单校验照旧（Jev 建议也过 expert-ids.json；域外/未知 → 拒绝 400）。
  let expertId = ""
  // 2026-10-05：派遣守卫的语义判定（研究与否／是否返工／是否依赖 music）一次批次问 Jev；
  // 非 beast 派遣不花这次呼叫（保持 OFF 零变化），此时各守卫走既有正则降级路径。
  let dispatchGuards: JevDispatchGuards = { research: null, rework: null, musicDependency: null }
  const beastOn = deps.beastMode(parent)
  const rawExpert = typeof body.expert === "string" ? body.expert.trim() : ""
  if (beastOn) {
    let allowed: unknown
    try {
      allowed = (JSON.parse(readFileSync(`${import.meta.dir}/expert/expert-ids.json`, "utf8")) as { experts?: unknown })?.experts
    } catch (e) {
      return Response.json(
        { ok: false, code: "expert_registry_unavailable", error: `expert 清单不可读（gateway/expert/expert-ids.json：${e instanceof Error ? e.message : String(e)}）` },
        { status: 503 },
      )
    }
    if (!Array.isArray(allowed)) {
      return Response.json(
        { ok: false, code: "expert_registry_unavailable", error: "expert 清单不可读（gateway/expert/expert-ids.json 形状错误：缺 experts 阵列）" },
        { status: 503 },
      )
    }
    const allowedList = allowed as string[]
    if (rawExpert && !allowedList.includes(rawExpert)) {
      return Response.json({ ok: false, code: "unknown_expert", error: `未知 expert：${rawExpert}`, allowed: allowedList }, { status: 400 })
    }
    // 刀3 权威路由（Jev 失败回 null → fail-open 用点名值/空）。
    const routed = (await routeExpertAuthoritative(prompt, rawExpert)) ?? {
      expertId: rawExpert,
      source: rawExpert ? ("provided" as const) : ("none" as const),
    }
    if (routed.expertId && !allowedList.includes(routed.expertId)) {
      // Jev 建议域外（不该发生：criteria 就是七域＋other；防御性回退到点名值）。
      expertId = rawExpert
    } else {
      expertId = routed.expertId
    }
    // 2026-10-05：三题一呼（Jev 范式：加题不加延迟）；Jev 挂 → 各守卫回退既有正则。
    dispatchGuards = await classifyDispatchGuards(prompt)
    // H9（2026-10-02）：内容 vs expert 域一致性守卫。
    // 在 critic 登记之前执行——被降级的研究任务不得顶掉机器 critic pass 的触发判据。
    {
      const g = guardExpertContent(prompt, expertId, dispatchGuards.research)
      if (g.reason) {
        console.log(`[gateway] jev_gate: EXPERT_GUARD ${expertId || "-"} -> ${g.expertId || "generic"} label="${label}" reason=${g.reason}`)
        expertId = g.expertId
      }
    }
    // M2：music-first 机器前置断言（依赖音乐的任务须等 music 交付事件）。
    {
      const delivered = deliveredByParent.get(parent.sessionId) ?? []
      const musicInFlight = (byParent.get(parent.sessionId) ?? []).some((r) => r.agent === "music" && r.status === "running")
      const reason = musicFirstBlockReason(
        prompt,
        expertId,
        {
          musicInFlight,
          musicDelivered: delivered.some((d) => d.agent === "music"),
        },
        dispatchGuards.musicDependency,
      )
      if (reason) {
        console.log(`[gateway] jev_gate: MUSIC_FIRST_BLOCKED label="${label}" expert=${expertId || "-"} inflight=${musicInFlight}`)
        return Response.json({ ok: false, code: "music_first", error: reason, blocked: "music_first" }, { status: 409 })
      }
    }
    // 刀 2（2026-09-15）：orchestrator **自行**派 critic = 本轮已有 critic 审核动作，
    // 机器 pass 的触发判据据此豁免（不重复派遣）。登记有界 Map。
    if (expertId === "critic") {
      criticDispatchedByParent.set(parent.sessionId, parent.turnGen ?? 0)
      boundMap(criticDispatchedByParent, 500)
    }
  }

  // 刀 2B（2026-09-19）：派遣 spec 消毒（权威）。研究结论/网页内容嵌 spec 是活的
  // 间接注入通道（手册模板二【研究输入】逐字嵌 prompt）。Jev 判拦截线以上 →
  // spec 头注入机器隔离声明（不拦派遣、只废掉注入指令的效力）。
  {
    const quarantine = await quarantineSpec(`dispatch:${label || "unlabeled"}`, prompt)
    if (quarantine) prompt = `${quarantine}\n${prompt}`
  }

  // 量级瘦身 A（2026-09-19）：spec 模板机器注入。三军模板（研究/创作/毒蛇评审，
  // playbook 1.8 逐字迁出至 spec-templates.json）按 Jev 任务分类自动追加到任务书
  // 头部——orchestrator 只写任务意图，配方由机器持有。Jev 挂 → 不注入（fail-open，
  // 子代理照原 spec 跑；模板缺档同理跳过，只留 log）。
  // 0920 暴君裁定：模板选择接 System One——同一请求批次取回工作流模板判定，
  // 命中制作类（confidence≥0.8）即把骨架硬注入任务书头（先于军团模板），
  // 让「没人负责选模板」不再可能（事故：60s 百合 OP MV 裸跑＝无角色卡约束）。
  {
    let templateInjected = false
    try {
      const tpl = JSON.parse(readFileSync(`${import.meta.dir}/spec-templates.json`, "utf8")) as Record<string, string>
      const meta = await classifyDispatchMeta(prompt)
      if (meta.template) {
        prompt = `${workflowTemplateDirective(meta.template.templateId, meta.template.confidence)}\n\n---\n\n${prompt}`
        console.log(
          `[gateway] jev_gate: WORKFLOW_TEMPLATE injected template=${meta.template.templateId} confidence=${meta.template.confidence.toFixed(2)} label="${label}" expert=${expertId || "-"}`,
        )
        // 0920 暴君裁定（第二版）：模板判定完成即建骨架弹上画布——不等 Expert
        // 去调 workflow_start（实锤：Expert 根本没调，右边永远空白，「太慢了」）。
        // 建构用占位内容满足后端「每个 text role 非空」的验证；Expert 之后同模板
        // 呼叫 workflow_start 走 P0 幂等守卫复用同一支 wf，再用 workflow_update_node
        // 回填真内容。失败一律 fail-open（Expert 仍可自行建立，行为＝部署前）。
        try {
          // 修 4（2026-10-02）：per-session 骨架去重——本会话整个生命周期最多一个骨架。
          // 先查该父会话是否已有 workflowSnapshot（持久镜像）或已登记 owner wf：有则
          // 复用同一个 workflowId，不新建不覆盖（此前同一会话建 14 个 wf 只留最后一个=孤儿）。
          const snap = (parent as { workflowSnapshot?: { workflowId?: unknown } }).workflowSnapshot
          const snapWfId = snap && typeof snap.workflowId === "string" ? snap.workflowId : undefined
          const priorWfId = workflowOwnerBySession.get(parent.sessionId) ?? snapWfId
          if (priorWfId) {
            workflowOwnerBySession.set(parent.sessionId, priorWfId)
            console.log(
              `[gateway] jev_gate: WORKFLOW_SKELETON reused wf=${priorWfId} session=${parent.sessionId} (per-session 去重，不新建不覆盖)`,
            )
          } else {
            const r = workflowService.startFast(meta.template.templateId, templatePlaceholderContent(meta.template.templateId) as never, parent)
            if ("workflowId" in r && typeof r.workflowId === "string") {
              workflowOwnerBySession.set(parent.sessionId, r.workflowId)
              console.log(
                `[gateway] jev_gate: WORKFLOW_SKELETON built template=${meta.template.templateId} wf=${r.workflowId} session=${parent.sessionId} (判定即弹，不等 Expert)`,
              )
            } else {
              console.log(`[gateway] workflow skeleton skipped (start error): ${"error" in r ? r.error : "unknown"}`)
            }
          }
        } catch (e) {
          console.log(`[gateway] workflow skeleton build failed: ${e instanceof Error ? e.message : String(e)}`)
        }
      }
      if (meta.specKey && typeof tpl[meta.specKey] === "string" && tpl[meta.specKey]) {
        prompt = `【系统注入·军团模板】以下模板骨架由网关按任务类型自动注入，与你的任务书同效；〔括号〕栏由你填。\n\n${tpl[meta.specKey]}\n\n---\n\n【任务书原文】\n${prompt}`
        templateInjected = true
      }
    } catch (e) {
      console.log(`[gateway] spec template injection skipped (read/classify failed): ${e instanceof Error ? e.message : String(e)}`)
    }
    if (templateInjected) console.log(`[gateway] spec template injected: label="${label}"`)
  }

  // M3（2026-10-02）：返工 spec 内容锁。侦测到返工任务 → 注入「只改 X 栏、其余逐字沿用
  // <原稿路径>＋交付附 diff」（原稿路径＝同 label/同 expert 最近一份落盘交付物）。
  if (isReworkSpec(prompt, dispatchGuards.rework)) {
    const delivered = deliveredByParent.get(parent.sessionId) ?? []
    const prior = [...delivered].reverse().find((d) => d.relPath && (d.label === label.slice(0, 20) || (expertId && d.agent === expertId)))
    prompt = `${reworkLockDirective(prior?.relPath ?? "")}\n\n---\n\n${prompt}`
    console.log(`[gateway] jev_gate: REWORK_LOCK injected label="${label}" original=${prior?.relPath || "-"}`)
  }

  // 并发上限：第 4 个拒绝，文案原样给主代理（附 code 与当前在跑清单，便于编排等待而非重试）。
  const list = byParent.get(parent.sessionId) ?? []
  if (list.length >= MAX_ACTIVE_PER_PARENT) {
    return Response.json({
      ok: false,
      code: "concurrency_limit",
      error: SUBAGENT_BUSY_MESSAGE,
      running: list.map((r) => ({ id: r.id, label: r.label, elapsed_ms: Date.now() - r.startedAt })),
    })
  }

  // 模型链：父会话 persona 主模型 + registry fallbacks（空链 = 吃 opencode 预设，
  // 仅在 registry 缺失的极端情况发生，此时无链可换）。
  let chain: SubagentModelRef[] = []
  try {
    chain = deps.subagentModelChain(parent) ?? []
  } catch (e) {
    console.error(`[gateway] subagent model chain failed (fallback to opencode default): id=${parent.sessionId}`, e)
  }

  const run: SubagentRun = {
    id: crypto.randomUUID(),
    parentGatewaySessionId: parent.sessionId,
    parentOpencodeSessionId: parent.opencodeSessionId,
    opencodeSessionId: "",
    label: label.slice(0, 20),
    startedAt: Date.now(),
    status: "running",
    prompt,
    modelChain: chain,
    attempt: 1,
    // 片 D（2026-09-15）：交付闸门重派计数，硬帽 1 次。
    reworkCount: 0,
    beastMode: deps.beastMode(parent),
    agent: expertId || undefined,
    asyncMode,
    messageRole: new Map(),
    partEmitted: new Map(),
    partKind: new Map(),
    suppressedParts: new Set(),
    partText: new Map(),
    lastActivityAt: Date.now(),
    pendingTools: new Set(),
    artifacts: [],
    toolStatusEmitted: new Map(),
  }
  list.push(run)
  byParent.set(parent.sessionId, list)

  // 硬顶：同步 15 分钟（工具轮询 16 分钟死线之前收尾）；R6 async 30 分钟
  // （军团的窄领域研究/创作任务合法地更长，无工具死线顶着，给足余量）。
  const hardMs = asyncMode ? ASYNC_HARD_TIMEOUT_MS : HARD_TIMEOUT_MS
  run.timeoutTimer = setTimeout(() => {
    console.warn(`[gateway] subagent hard timeout (${Math.round(hardMs / 60000)}min): id=${run.id} label="${run.label}"`)
    // 修 3（2026-10-02）：逾时先落盘已累积的 partial 文字，再 error 收尾（不让已有工作不可追）。
    run.partialPersist = true
    finishRun(run, "error", partialBodyOf(run), `子代理超时（${Math.round(hardMs / 60000)} 分钟），已强制结束`)
  }, hardMs)
  // D5（2026-10-02）：心跳 + 逾时前 2 分钟部分交付。
  armHeartbeat(run, hardMs)

  // 投递任务书（第一次 attempt；后续上游错误换模重试走 retryWithNextModel）
  const failure = await dispatchAttempt(run)
  if (failure) {
    // 投递失败：死因随 502 同步返回工具（主会话当场知道），R6 唤醒不再补发，
    // 避免同一失败双重注入。
    run.asyncMode = false
    finishRun(run, "error", "", `子代理${failure}`)
    return Response.json({ ok: false, error: `子代理${failure}` }, { status: 502 })
  }

  deps.emitToSession(parent, "subagent.started", { id: run.id, label: run.label })
  console.log(
    `[gateway] subagent dispatched: id=${run.id} label="${run.label}" parent=${parent.sessionId} child=${run.opencodeSessionId}${asyncMode ? " mode=async" : ""}`,
  )
  if (!asyncMode) {
    // R1（2026-09-11）：同步 dispatch 硬 deadline。到点先让主会话解锁（工具轮询
    // /internal/subagent/status 读 completed 即取件，实测 <30s 收到 ok:false/TIMEOUT），
    // **子代理 run 不杀**：翻 asyncMode 让它后台续跑，完成后走既有 wakeParent 回填。
    const deadlineMs = parseSyncDeadlineMs(run.prompt)
    // P2b：arm 时刻记一条，deadline 解析结果可被日志直接观测（V3 不必等 240s）。
    console.log(
      `[gateway] subagent sync deadline armed: id=${run.id} label="${run.label}" deadline=${Math.round(deadlineMs / 1000)}s prompt_head="${run.prompt.slice(0, 24).replace(/\n/g, "\\n")}"`,
    )
    run.deadlineTimer = setTimeout(() => {
      run.deadlineTimer = undefined
      if (run.status !== "running") return
      if (completed.has(run.id)) return
      if (typeof deps?.wakeParent === "function") run.asyncMode = true
      const human =
        deadlineMs < 60_000
          ? `子代理超过预定时间（${Math.round(deadlineMs / 1000)} 秒）未回，已放它后台续跑；你先看其他结果`
          : `子代理超过预定时间（${Math.round(deadlineMs / 60_000)} 分钟）未回，已放它后台续跑；你先看其他结果`
      completed.set(run.id, {
        status: "error",
        summary: "",
        error: human,
        finishedAt: Date.now(),
        label: run.label,
        partial: true,
        reason: "timeout",
        parent: run.parentGatewaySessionId,
      })
      // E 片（2026-09-12）：超时放行这一刻的事实也落盘（无正文 → 写死因事实）。此刻
      // 盘上不是交付物，**不挂「完整结果已落盘」指针**（挂了会误导）；run 后续真完成
      // 时 finishRun 用全文覆写同一档并带指针。
      const partialPersist = persistRunOutput(run, "timeout", "", human)
      if (partialPersist.relPath) {
        console.log(`[gateway] subagent partial persisted: id=${run.id} path=${partialPersist.relPath}`)
      }
      console.warn(
        `[gateway] subagent sync deadline hit: id=${run.id} label="${run.label}" deadline=${Math.round(deadlineMs / 1000)}s — 主会话已放行，子代理转后台续跑`,
      )
    }, deadlineMs)
  }
  if (asyncMode) {
    // R6 异步：投递成功立即返回，主会话 turn 可正常结束；完成后 wakeParent 唤醒。
    return Response.json({
      ok: true,
      subagent_id: run.id,
      label: run.label,
      status: "running",
      async: true,
      note: "后台运行中，完成后自动唤醒主会话汇总。结束本轮，不要轮询等待。注意 subagent_id 是网关派工 run id，**不是 opencode session id**——不要把它当 task_id 传给内置 task 工具（必被拒：Expected a string starting with \"ses\"）；要取回完整交付物就 read 唤醒摘要里的落盘文件路径，或用 subagent_status 工具。",
    })
  }
  return Response.json({ ok: true, subagent_id: run.id })
}

/** D4（2026-10-02）：本会话最近 N 笔 run（运行中＋已完成，按时间倒序）。
 *  completed 记录自 2026-10-02 起带 parent 归属；旧记录无 parent＝不列入（诚实：不假装知道归属）。 */
function recentRunsForParent(
  parentKey: string,
  limit: number,
): Array<{ id: string; label: string; status: string; running: boolean }> {
  if (!parentKey) return []
  const out: Array<{ id: string; label: string; status: string; running: boolean; at: number }> = []
  for (const run of byParent.get(parentKey) ?? []) {
    out.push({
      id: run.id,
      label: run.label,
      status: run.status,
      running: run.status === "running" && !run.stopped,
      at: run.startedAt,
    })
  }
  for (const [id, rec] of completed) {
    if (rec.parent === parentKey) out.push({ id, label: rec.label ?? "", status: rec.status, running: false, at: rec.finishedAt })
  }
  return out
    .sort((a, b) => b.at - a.at)
    .slice(0, limit)
    .map(({ at: _at, ...rest }) => rest)
}

/** D4：`latest` 别名 → 本会话最近一次 run 的 id（无记录回 undefined）。 */
function resolveLatestRunId(parentKey: string): string | undefined {
  return recentRunsForParent(parentKey, 1)[0]?.id
}

/** POST /internal/subagent/status — body { session_id, subagent_id }。工具轮询取件。
 *  R6：async 派遣的主会话也可用同一端点主动查询状态（subagent_status 工具）。
 *  D4（2026-10-02）：支援 `latest` 别名；not_found 附最近 3 笔 run 供改用。 */
export async function handleSubagentStatus(req: Request): Promise<Response> {
  pruneCompleted()
  const body = (await req.json().catch(() => ({}))) as { session_id?: string; subagent_id?: string }
  let wantId = typeof body.subagent_id === "string" ? body.subagent_id.trim() : ""
  if (!wantId) {
    return Response.json(
      {
        ok: false,
        code: "missing_required_args",
        error: 'subagent_id 必填：可传完整 run id、"latest"（本会话最近一次）或 label 前缀。示例：{"subagent_id":"latest"}',
      },
      { status: 400 },
    )
  }
  const sid = body.session_id?.trim()
  const parent = sid ? (deps?.resolveSession(sid) ?? deps?.findSessionByOpenCodeId(sid)) : undefined
  const parentKey = parent?.sessionId ?? sid ?? ""
  if (wantId === "latest") {
    const latestId = resolveLatestRunId(parentKey)
    if (!latestId) {
      return Response.json(
        {
          ok: false,
          code: "not_found",
          error: '本会话没有任何子代理记录（"latest" 无对象）。先 subagent_dispatch 派出后再查。',
        },
        { status: 404 },
      )
    }
    wantId = latestId
  }
  const done = completed.get(wantId)
  if (done) {
    return Response.json({
      ok: true,
      done: true,
      status: done.status,
      summary: done.summary,
      label: done.label,
      ...(done.error ? { error: done.error } : {}),
      ...(done.partial ? { partial: true } : {}),
      ...(done.reason ? { reason: done.reason } : {}),
      // 2026-10-05：终态记录带本 run 已产出的成品（subagent_status 工具会透传给模型；
      // 失败/超时也带，让 orchestrator 先读成品再决定要不要重派，不再误判零产物重派）。
      ...(done.artifacts?.length ? { artifacts: done.artifacts } : {}),
    })
  }
  for (const run of byChildOc.values()) {
    if (run.id === wantId) {
      return Response.json({
        ok: true,
        done: false,
        // D4（2026-10-02）：回带实际命中的 run id——`latest`／label 前缀查询时，
        // 呼叫端必须知道解析到哪一个 run，否则拿到状态却无 id 可用。
        subagent_id: run.id,
        label: run.label,
        elapsed_ms: Date.now() - run.startedAt,
      })
    }
  }
  // 刀1（2026-09-20 百合番OP宝藏 PRD）：not_found ≠ 没跑过——run 记录会过期（completed
  // 清理/gateway 重启），但 E 片落盘档是持久的。按 run id 前 8 码扫 outputs/subagent，
  // 命中即在 404 回应带 artifact_path，orchestrator 直接验收盘上档案，不重派不空等
  // （实锤案例：装配方案 23:19 落盘、唤醒丢失、用户空等近 1 小时）。
  // 修 2（2026-10-02）：label 精确查询——此前按 label 查在跑代理一律 not_found，
  // orchestrator 只能从 busy 拒绝讯息反推并发数并误判批次失联（重派造成重复生成）。
  // 完整 run id 已在上面精确命中；此处以 label 前缀比对：单笔回该 run、多笔回候选清单、
  // 仅真正零命中才落到 artifact/404。
  const cands: Array<{ runId: string; label: string; status: string; running: boolean; elapsed_ms?: number }> = []
  for (const run of byChildOc.values()) {
    if (run.id !== wantId && run.label.startsWith(wantId)) {
      cands.push({ runId: run.id, label: run.label, status: "running", running: true, elapsed_ms: Date.now() - run.startedAt })
    }
  }
  for (const [id, rec] of completed) {
    if (id !== wantId && (rec.label ?? "").startsWith(wantId)) {
      cands.push({ runId: id, label: rec.label ?? "", status: rec.status, running: false })
    }
  }
  if (cands.length === 1) {
    const c = cands[0]
    return Response.json({
      ok: true,
      done: !c.running,
      subagent_id: c.runId,
      status: c.status,
      label: c.label,
      ...(c.running ? { elapsed_ms: c.elapsed_ms } : {}),
    })
  }
  if (cands.length > 1) {
    return Response.json({
      ok: true,
      multiple: true,
      candidates: cands.map((c) => ({ runId: c.runId, label: c.label, status: c.status })),
      note: "label 前缀命中多笔，请用完整 runId 或更精确 label 重查。",
    })
  }
  const artifact = findPersistedArtifact(wantId)
  if (artifact) {
    return Response.json({
      ok: true,
      done: true,
      status: artifact.status,
      label: artifact.label,
      artifact_path: artifact.relPath,
      artifact_bytes: artifact.bytes,
      artifact_mtime: artifact.mtimeMs,
      note: "run 记录已过期但产物已落盘：直接 read 上述路径验收，勿重派。",
    })
  }
  // D4（2026-10-02）：not_found 不再是一句死话——附最近 3 笔 run（id/状态/label），
  // 让 orchestrator 直接改用正确 id，或改传 "latest"，而不是重派造成重复生成。
  const recent = recentRunsForParent(parentKey, 3)
  return Response.json(
    {
      ok: false,
      code: "not_found",
      error: recent.length
        ? `subagent_id 不存在或已过期。本会话最近 3 笔 run：${recent
            .map((r) => `${r.id}(${r.status}${r.label ? " " + r.label : ""})`)
            .join("、")}。可改用上述完整 id，或传 "latest"。`
        : "subagent_id 不存在或已过期，且本会话查无历史 run 记录。",
      recent_runs: recent,
    },
    { status: 404 },
  )
}

/**
 * 0920 停止闸：orchestrator 的停止入口（/internal/subagent/stop）。
 * body { session_id, subagent_id?, all? }：
 *   - subagent_id 有值 → 停那一个（gateway run id 或 label 前缀）
 *   - 否则（或 all:true）→ 停该会话名下全部在跑子代理
 * 停止语义：标记 stopped → abort+DELETE 子会话 → 摘注册表 → 不唤醒父会话。
 * 为何不唤醒：停止＝结束，唤醒会让 orchestrator 又起一轮（可能再派新 subagent），
 * 正是用户抱怨的「一出就刹不住车」。
 */
export async function handleSubagentStop(req: Request): Promise<Response> {
  pruneCompleted()
  const body = (await req.json().catch(() => ({}))) as { session_id?: string; subagent_id?: string; all?: boolean }
  const sid = body.session_id?.trim()
  if (!sid) return Response.json({ ok: false, code: "missing_required_args", error: "session_id 必填" }, { status: 400 })
  // session_id 接受 gateway id 或父 opencode id——与 status/dispatch 同语义。
  const parent = deps?.resolveSession(sid) ?? deps?.findSessionByOpenCodeId(sid)
  const parentKey = parent?.sessionId ?? sid
  if (body.subagent_id && body.all !== true) {
    const run = findRunningRun(parentKey, body.subagent_id.trim())
    if (!run) {
      return Response.json(
        { ok: false, code: "not_found", error: `找不到在跑的子代理：${body.subagent_id}`, recent_runs: recentRunsForParent(parentKey, 3) },
        { status: 404 },
      )
    }
    const label = run.label
    const id = run.id
    stopSubagentRun(run, "orchestrator", `已按你的要求停止子代理「${label}」`)
    return Response.json({ ok: true, stopped: 1, subagent_ids: [id] })
  }
  const list = (byParent.get(parentKey) ?? []).filter((r) => r.status === "running" && !r.stopped)
  const ids = list.map((r) => r.id)
  const n = stopSubagentsForParent(parentKey, "orchestrator", "已按你的要求停止全部在跑子代理")
  return Response.json({ ok: true, stopped: n, subagent_ids: ids })
}

/**
 * D1（2026-10-02）：工具层重复呼叫断路器的强制收尾端点。
 * 由 .opencode/plugin/eimu-guard.ts 在「同一 (session, tool, 正规化 args) 第 N+5 次」时呼叫：
 * 中止该会话当前生成并回灌一则系统说明。**轮询类工具不触发**（2026-10-02 使用者裁定：保留轮询）。
 * body { session_id, tool, count }。
 */
export async function handleLoopBreaker(req: Request): Promise<Response> {
  if (!deps) {
    return Response.json({ ok: false, code: "runtime_not_initialized", error: "subagent runtime not initialized" }, { status: 500 })
  }
  const body = (await req.json().catch(() => ({}))) as { session_id?: string; tool?: string; count?: number }
  const sid = typeof body.session_id === "string" ? body.session_id.trim() : ""
  if (!sid) {
    return Response.json({ ok: false, code: "missing_required_args", error: "session_id 必填" }, { status: 400 })
  }
  const state = deps.resolveSession(sid) ?? deps.findSessionByOpenCodeId(sid)
  const ocId = state?.opencodeSessionId
  if (ocId) {
    void fetch(`${deps.openCodeUrl}/session/${ocId}/abort`, {
      method: "POST",
      headers: deps.openCodeHeaders(),
      signal: AbortSignal.timeout(5000),
    }).catch(() => {})
  }
  if (state) {
    deps.emitToSession(state, "turn.status", {
      // 2026-10-04 F4：去内部化——不贴内部工具名（工具面属后厨），只说用户视角的后果与出路。
      text: `同一个动作被以完全相同的参数重复了 ${body.count ?? 0} 次，已结束本轮以免空转；请换个做法，或告诉我新的方向。`,
    })
  }
  console.warn(
    `[gateway] loop-breaker abort: session=${state?.sessionId ?? sid} tool=${body.tool ?? "?"} count=${body.count ?? 0} aborted=${Boolean(ocId)}`,
  )
  return Response.json({ ok: true, aborted: Boolean(ocId), session_id: state?.sessionId ?? sid })
}

/** 刀1：扫 outputs/subagent/<runId前8码>-*.md，取最新一笔（同前缀理论唯一，兜底取 mtime 最大）。 */
function findPersistedArtifact(subagentId: string): { relPath: string; bytes: number; mtimeMs: number; status: string; label: string } | null {
  const prefix = subagentId.replace(/-/g, "").slice(0, 8)
  if (!/^[0-9a-f]{8}$/i.test(prefix)) return null
  try {
    const hits = readdirSync(SUBAGENT_OUTPUT_DIR)
      .filter((f) => f.startsWith(prefix))
      .map((f) => {
        const abs = join(SUBAGENT_OUTPUT_DIR, f)
        const st = statSync(abs)
        // 档头 meta 行是机器写的（persistRunOutput），status/label 直接抽，不读全文。
        const head = readFileSync(abs, "utf8").slice(0, 400)
        const status = /^- 状态: (.+)$/m.exec(head)?.[1]?.trim() ?? "unknown"
        const label = /^# (.+)$/m.exec(head)?.[1]?.trim() ?? ""
        return { relPath: `${SUBAGENT_OUTPUT_REL}/${f}`, bytes: st.size, mtimeMs: st.mtimeMs, status, label }
      })
      .sort((a, b) => b.mtimeMs - a.mtimeMs)
    return hits[0] ?? null
  } catch {
    return null // 目录不可读/不存在 → 维持原 404 行为（fail-open）
  }
}

// ── 刀 F（2026-09-15）：rework 链重启存活——启动扫描治理 in-flight rework 孤儿 ──────────
// 病灶：rework 在途时 gateway 被重启（round3 13:03:37），SubagentRun/watchers 纯记忆体随旧
// 进程死亡 → 子 opencode 会话孤儿 RUNNING（算力白烧）、父会话永挂无 done/无 wake。
// 治法：startRework 落一条 subagent_reworks 记录（child_oc 探针目标），finishRun 终态删。
// 启动时扫残留记录，探 opencode 子会话真况：
//   · 已完成 → 拉正文重跑闸门复检，走既有 finishRun 正常链 done/wake（单终态守卫复用）。
//   · 仍 RUNNING 且 watcher 死 → **不幽灵续 watch**，按诚实路径：finishRun(orphaned) 内部
//     abort+DELETE 子会话 + done delivery_gate.orphaned + 带前缀 wake 父会话一次。
// 幂等：记录终态即删，残留=真孤儿；wake 单次由 finishRun status 守卫 + wakeParent ackTimer
// 让位保证，与正常链不双 wake。

function runFromReworkRecord(rec: ReworkRecord): SubagentRun {
  return {
    id: rec.runId,
    parentGatewaySessionId: rec.parentGw,
    parentOpencodeSessionId: rec.parentOc,
    opencodeSessionId: rec.childOc,
    label: rec.label,
    startedAt: rec.updatedAt,
    status: "running",
    prompt: "",
    modelChain: [],
    attempt: 1,
    messageRole: new Map(),
    partEmitted: new Map(),
    partKind: new Map(),
    suppressedParts: new Set(),
    partText: new Map(),
    beastMode: rec.beast,
    agent: rec.agent || undefined,
    asyncMode: rec.asyncMode,
    reworkCount: rec.reworkCount || 1,
    lastActivityAt: Date.now(),
    pendingTools: new Set(),
    artifacts: [],
    toolStatusEmitted: new Map(),
  }
}

interface ChildProbe {
  exists: boolean
  completed: boolean
  text: string
}

/** 探 opencode 子会话：HTTP 非 ok/404 → 不存在；取最后一条 assistant 的 completed 判终态、
 *  其 text parts 作正文。time.completed===null = turn 仍 RUNNING（对齐验尸配方）。 */
async function probeChildSession(childOc: string): Promise<ChildProbe> {
  if (!deps || !isOpenCodeSessionId(childOc)) return { exists: false, completed: false, text: "" }
  try {
    const res = await fetch(`${deps.openCodeUrl}/session/${childOc}/message`, {
      headers: deps.openCodeHeaders(),
      signal: AbortSignal.timeout(10000),
    })
    if (!res.ok) return { exists: false, completed: false, text: "" }
    const msgs = (await res.json()) as Array<{
      info?: { role?: string; time?: { completed?: number | null } }
      parts?: Array<{ type?: string; text?: string }>
    }>
    if (!Array.isArray(msgs) || msgs.length === 0) return { exists: true, completed: false, text: "" }
    const lastAssistant = [...msgs].reverse().find((m) => m?.info?.role === "assistant")
    if (!lastAssistant) return { exists: true, completed: false, text: "" }
    const completed = lastAssistant.info?.time?.completed != null
    const text = (lastAssistant.parts ?? [])
      .filter((p) => p?.type === "text" && typeof p.text === "string")
      .map((p) => p.text as string)
      .join("\n")
      .trim()
    return { exists: true, completed, text }
  } catch {
    // 探测失败（opencode 短暂不可达）保守回 exists:false，让本轮先不处理——但呼叫端
    // 对 !exists 走孤儿诚实收尾。为避免 opencode 抖动误杀，仅在明确 HTTP 非 ok 才标 !exists；
    // 网络异常在此回 exists:true/completed:false（视为仍 RUNNING），下一轮重启再评。
    return { exists: true, completed: false, text: "" }
  }
}

/** gateway 启动一次性调用：治理 rework 孤儿（见上方注解块）。 */
export async function recoverReworkRunsOnStartup(): Promise<void> {
  if (!deps) return
  const recs = loadReworkRecords()
  if (recs.length === 0) return
  console.log(`[gateway] rework recovery: ${recs.length} in-flight record(s) to reconcile`)
  for (const rec of recs) {
    let run: SubagentRun
    try {
      run = runFromReworkRecord(rec)
      const probe = await probeChildSession(rec.childOc)
      if (probe.exists && probe.completed) {
        // 已完成：拉正文走既有 finishRun（reworkCount>=1 → 不重派，PASS→reworked / FAIL→升级标记）。
        console.log(`[gateway] rework recovery: id=${run.id} child=${rec.childOc} 已完成 — 拉正文复检闸门`)
        if (probe.text) finishRun(run, "ok", probe.text)
        else finishRun(run, "error", "", "子代理运行结束但没有产出文本")
      } else {
        // 仍 RUNNING 或子会话已消失：不续 watch，诚实收尾。finishRun 内部 abort+DELETE 子会话
        // （!exists 时 404 no-op）+ 单次 wake（error 路径，wake「失败原因」带前缀）。
        const why = probe.exists ? "仍 RUNNING 且 watcher 已死" : "子会话已不存在"
        console.error(`[gateway] rework recovery: id=${run.id} child=${rec.childOc} ${why} — abort+DELETE 诚实收尾`)
        run.orphaned = true
        finishRun(run, "error", "", `${ORPHANED_GATE_MARK} gateway 进程在重派途中重启，子会话未被续 watch；已按诚实路径终止（abort+DELETE），未复原交付结果。`)
      }
    } catch (e) {
      console.error(`[gateway] rework recovery failed: id=${rec.runId} child=${rec.childOc}`, e)
      deleteReworkRecord(rec.runId) // 处理异常也要清记录，防下次启动重复幽灵治理
    }
  }
}
