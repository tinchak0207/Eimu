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
 * 模型路由（2026-08-31 補）：子代理不再吃 opencode 預設模型，而是繼承父會話
 * persona 的主模型 + registry fallbacks 鏈（與主路徑 personaModelForAttempt 同源）。
 * 上游模型錯誤（opencode APIError 形狀 {name, data:{message}}）時自動換下一個模型
 * 重投；錯誤原文經 opencodeErrorMessage 透傳進 done，不再被 .message 直讀吞掉
 * （2026-08-31 事故：shuai 輸出審核 DataInspectionFailed 被顯示成「子代理上游错误」）。
 *
 * 并发上限：每个父会话最多 3 个活跃子代理，第 4 个 dispatch 返回 busy 文案，
 * 工具原样转给主代理。
 */

import { chmodSync, mkdirSync, readFileSync, writeFileSync, readdirSync, statSync } from "node:fs"
import { join } from "node:path"
// 刀 2B/刀 3（2026-09-19）：Jev 權威閘——spec 注入隔離＋expert 路由＋sync 資格。
// 量級瘦身 A：spec 模板機器注入（playbook 2.0 起模板不進 orchestrator 上下文）。
import { guardExpertContent, musicFirstBlockReason, isReworkSpec, reworkLockDirective, quarantineSpec, routeExpertAuthoritative, syncDispatchEligible, classifyDispatchMeta, workflowTemplateDirective } from "./jev-gate"
// 任務狀態枚舉真源（0920 收口）：running/ok/error/stopped 以此為準，禁散布裸字串。
import type { TaskStatus } from "./types-gateway.ts"
// 0920：模板判定即建骨架（不等 Expert）——workflowService 是純 service 模組，
// workflow-gw 不 import subagent，無循環風險。
import { workflowService, workflowOwnerBySession } from "./workflow-gw"
import { templatePlaceholderContent } from "./workflow-templates"
// 2026-10-02：派工時把「畫布模板空位」當系統事實注入子代理任務書（專家看不到畫布，
// 只能憑印象另起爐灶 → 模板被架空）。buildTemplateSlotsFact 為純讀函式，無值回 null
// （此路徑輸出與注入前逐字元等價）。reverse import 與 canvas-cascade-state→subagent 的既有
// 循環同型，兩端均在呼叫期使用綁定（非模組頂層求值），bun ESM 循環安全。
import { buildTemplateSlotsFact, getTemplateDeviateToken } from "./canvas-cascade-state.ts"
// 片 C（2026-09-15）：Expert 交付契約的機器強制點。純函數模組，零 gateway 內部依賴。
// 片 D（2026-09-15）：追加 REWORK_FAIL_MARK/buildReworkDirective——FAIL 時機器化重派一次。
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
  type DeliveryGateResult,
  type CriticPassTarget,
} from "./delivery-gate"
// 刀 F（2026-09-15）：in-flight rework run 持久化 + 啟動孤兒治理（復用 persistence.ts
// 同一 bun:sqlite 層，非自造第二套持久層）。finishRun 終態刪、startRework 成功寫。
import {
  saveReworkRecord,
  loadReworkRecords,
  deleteReworkRecord,
  markCriticPass,
  hasCriticPass,
  deleteCriticPass,
  // D7（2026-10-02）：品質量測基座寫入（fail-open；量測不得影響交付）。
  saveCriticVerdict,
  saveExpertLesson,
  saveDelivery,
  type ReworkRecord,
} from "./persistence"

// P2b（2026-09-11）刀1：任務書首行自動補「预期 N 分钟」死線行。
// 任何派遣若首行沒有「预期 N」，補上 5 分鐘 → R1 parseSyncDeadlineMs 得
// min(2*5,4)=4 分鐘 = 240s 同步硬死線，主會話不再被無死線子代理長期鎖住。
// 已自帶「预期/預期 N」的任務書原樣不動（避免雙補）。
const SPEC_DEADLINE_LINE = "\n预期 5 分钟（超 2x 杀线）。\n"

const MAX_ACTIVE_PER_PARENT = 3
const HARD_TIMEOUT_MS = 15 * 60 * 1000 // 单子代理硬顶
// R6（2026-09-10）：async 子代理無工具輪詢死線頂著，軍團研究/創作任務合法更長，
// 硬頂放寬到 30 分鐘；超時同樣走 finishRun(error) → 喚醒父會話如實匯報。
const ASYNC_HARD_TIMEOUT_MS = 30 * 60 * 1000
const SUMMARY_MAX_CHARS = 600
// E 片（2026-09-12）缺陷一：行內 600 字帽保留，但完整結果先落盤再 DELETE 子會話。
// 09-12 實案：數千字作曲規格文檔在行內被截到「m16 属…」，子會話隨即被 DELETE，
// 全文不可恢復；同一次上游 502 的長死因也被切掉。落盤根 = gateway WORKSPACE_DIR
// （index.ts:570 同值；gateway 進程 WorkingDirectory=/opt/agent-harness/gateway，
// workspace 真身 /opt/agent-harness/workspace，opencode server 的 --dir 就是它）。
const SUBAGENT_OUTPUT_REL = "outputs/subagent"
const SUBAGENT_OUTPUT_DIR = "/opt/agent-harness/workspace/outputs/subagent"
const PERSIST_TAIL = "[gateway 落盘: 完整结果未截断]"
const COMPLETED_TTL_MS = 10 * 60 * 1000 // status 轮询窗口，过期即弃
export const SUBAGENT_BUSY_MESSAGE = "已有 3 个子代理在跑，等一个完成再派"

// R1（2026-09-11）：同步 dispatch 硬 deadline 解析。任務書首行/正文自帶估時
// 「预期 N 分钟 / 預期 N 分鐘」（容忍中英、容忍小數）→ deadline = min(2N, 4) 分鐘；
// 解析不到 → 預設 180 秒。評測 P0：spec 自寫「预期 4 分钟」而同步派發無任何死線，
// 主會話被鎖 651 秒、正文 0 字。
const SYNC_DEADLINE_DEFAULT_MS = 180_000
const SYNC_DEADLINE_MAX_MS = 4 * 60_000
function parseSyncDeadlineMs(prompt: string): number {
  const m = /[预預]\s*期\s*([0-9]+(?:\.[0-9]+)?)\s*(?:分钟|分鐘|min(?:ute)?s?)/i.exec(prompt || "")
  if (!m) return SYNC_DEADLINE_DEFAULT_MS
  const n = Number.parseFloat(m[1])
  if (!Number.isFinite(n) || n <= 0) return SYNC_DEADLINE_DEFAULT_MS
  return Math.min(n * 2 * 60_000, SYNC_DEADLINE_MAX_MS)
}

interface SubagentModelRef {
  providerID: string
  modelID: string
}

interface SubagentRun {
  id: string
  parentGatewaySessionId: string
  parentOpencodeSessionId: string
  opencodeSessionId: string
  label: string
  startedAt: number
  // 0920 停止閘：新增 "stopped"——用戶／orchestrator 主動停止**不是失敗**，
  // 此前複用 error 導致卡片顯示「失败」（實錘：停止成功卻被假判定為失敗）。
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
  // 野獸模式快照：dispatch 時取自父會話 settings；重試換模重投沿用同一快照。
  beastMode: boolean
  // R8 修復片2（2026-09-10）：Expert 路由輸入端。dispatch 入口按 expert-ids.json
  // 白名單校驗後寫入（僅 beast_mode ON 生效）；dispatchAttempt 把它帶進 prompt_async
  // body 的 agent 欄（opencode 已驗證支持），子會話即掛對應 Expert 的裁剪工具表。
  agent?: string
  // R6（2026-09-10）：async=true → 投遞後立即返回，終態時 deps.wakeParent 喚醒父會話。
  asyncMode: boolean
  // partID → 类型（"text" | "reasoning"）：delta 事件自身不带类型，靠先行的
  // message.part.updated 登记（raw capture 实锤 part.updated -> delta -> delta）。
  // S3（2026-09-11）：reasoning 增量放行转发（带 kind 区分），正文照旧不带 kind。
  partKind: Map<string, "text" | "reasoning">
  // step-start/unknown part 的 partID：其 delta 照旧丢弃（对齐主路径
  // suppressedParts 丢弃语义；只放行 reasoning 与正文两类）。
  suppressedParts: Set<string>
  // 修 3（2026-10-02）：message.part.updated 帶完整 text，按 partID 保存最新全文；
  // 逾時/中止（partial 落盤）時 join 成正文。有界 Map（同 suppressedParts 口徑）。
  partText: Map<string, string>
  // 修 3：本 run 落盤標記 partial（persistRunOutput 據此把「状态」寫成 partial）。
  partialPersist?: boolean
  timeoutTimer?: ReturnType<typeof setTimeout>
  // R1（2026-09-11）：同步 dispatch 硬 deadline 計時器。到點只把「超時」這一事實
  // 兌現給主會話（寫進 completed，工具輪詢立刻取件解鎖），run 不殺——降為 async
  // 續跑，完成後照樣走既有 wakeParent 回填通路。
  deadlineTimer?: ReturnType<typeof setTimeout>
  // D5（2026-10-02）：心跳 + 逾時前部分交付計時器（見 armHeartbeat）。摘除時必須清。
  heartbeatTimer?: ReturnType<typeof setInterval>
  earlyPartialTimer?: ReturnType<typeof setTimeout>
  // 片 D（2026-09-15）：交付閘門機器化重派狀態。reworkCount=已重派次數（硬帽 1，
  // 防無限迴圈燒錢）；reworking=重派投遞在途護欄（舊子會話殘影事件不得提前收尾）；
  // reworkFailure=重派投遞失敗原因（非空=重派從未真正跑過，done 不得偽稱 reworked）。
  reworkCount: number
  reworking?: boolean
  reworkFailure?: string
  // 刀 F（2026-09-15）：啟動掃描重建的孤兒 run 標記——finishRun 見其 true 直接走誠實
  // 收尾（delivery_gate.orphaned + 前綴 wake），不重派、不幽靈續 watch、不偽稱 reworked。
  orphaned?: boolean
  // 刀 2（2026-09-15）：本 run 是 gateway 在收盤判定點**機器派遣**的 critic（非 orchestrator
  // 決定）。終態處置分岔：verdict 通過 → 僅 journal 留痕、抑制 wake（不擾會話、不新增空轉
  // turn）；判退回 → 以前綴 CRITIC_REJECT_MARK 走既有 wakeParent 把判決送回父會話。
  machineCriticPass?: boolean
  // 刀 2：機器 pass 的 critic run 專用——其終態 verdict 判讀結果（false=通過）。
  machineCriticRejected?: boolean
  // 0920 暴君裁定（停止閘）：用戶／orchestrator 主動停止。置位後：
  //   ① killSwitch 已 abort+DELETE 子會話；② 所有事件與重投路徑一律早退
  //   （stopCheck 見 stopped 即 return），含換模重試與交付閘門重派；
  //   ③ finishRun 歸屬 "stopped"，**不做 wakeParent**（停止不該把父會話再喚起來）。
  stopped?: boolean
  stoppedBy?: "user" | "orchestrator"
  stoppedAt?: number
}

interface SubagentResult {
  // 0920 停止閘：新增 "stopped"——人工取消不是失敗（停止成功卻顯示「失败」＝假判定）。
  status: Exclude<TaskStatus, "running">
  summary: string
  error?: string
  finishedAt: number
  // 異步模式（2026-09-10 R6）：dispatch async=true 時 finishRun 摘除 run 後
  // 直接喚醒父會話；label 留給喚醒文案取用。
  label?: string
  // R1（2026-09-11）：同步 deadline 超時的「部分結果」語義（工具側/前端契約欄位）。
  partial?: boolean
  reason?: string
  // D4（2026-10-02）：所屬父會話（gateway session id）。此前 completed 記錄無歸屬，
  // 「latest／最近 3 筆」查不到本會話的已完成 run。新寫入必帶；舊記錄無此欄＝不列入。
  parent?: string
}

interface SubagentDeps {
  // 现有出口：emitToSession(state, name, data)（replayBuffer/clients/enqueue 全在裡面）
  emitToSession: (state: any, name: string, data: unknown) => void
  // 父会话解析：gateway id → state；miss 再按 opencode id 查
  resolveSession: (id: string) => any
  findSessionByOpenCodeId: (opencodeSessionId: string) => any
  openCodeUrl: string
  openCodeHeaders: () => Record<string, string>
  // 主路径 opencodeErrorMessage 原样注入：opencode 错误是 {name, data:{message}}
  // 形状，直读 .message 恒 undefined（主路徑註解已警告過的坑）。
  describeError: (err: unknown) => string
  // 父會話 persona 主模型 + fallbacks 鏈（與主路徑 personaModelForAttempt 同源）。
  subagentModelChain: (parentState: any) => SubagentModelRef[]
  // 野獸模式（MOE 改革，2026-09-08）：父會話 settings.beast_mode；ON 時任務書頭部
  // 注入 Expert 憲法（gateway/expert/expert-constitution.md）。OFF/缺欄 = 原文零改動。
  beastMode: (parentState: any) => boolean
  // 異步完成喚醒（2026-09-10 R6）：子代理終態時由 gateway 注入的出口，把結果
  // 摘要投進父會話消息流並續 turn（輪子=index.ts wakeSessionForSubagent，對齊
  // workflow 喚醒掃描器的 prompt_async 輪廓：turn 計數重置＋watchdog 布哨＋冪等守衛）。
  // 未注入（舊 index.ts 配新 subagent.ts）時 async dispatch 自動降級同步語義。
  wakeParent: (parentState: any, run: { id: string; label: string; status: "ok" | "error"; summary: string; error?: string }) => void
}

let deps: SubagentDeps | undefined
// 父 gateway session id → 活跃子代理列表（dispatch 并发上限按此计）
const byParent = new Map<string, SubagentRun[]>()
// 子 opencode session id → run（全局 tap 按 sessionID 命中）
const byChildOc = new Map<string, SubagentRun>()
// 子代理 id → 结果（工具轮询取件；TTL 后清）
const completed = new Map<string, SubagentResult>()

// ── 刀 2（2026-09-15）：machine critic pass 狀態 ─────────────────────────────────
// 待審交付：父 gateway session id → 本窗口內已終態的 Expert 交付（尚未送審）。
// 由 finishRun 在 Expert 正常終態時登記；machine pass 消耗後清空。純內存（有界：
// 每次 pass 至多取 CRITIC_PASS_MAX_TARGETS；登記側亦封頂）。
const pendingCriticTargets = new Map<string, CriticPassTarget[]>()
// 本輪是否已有 critic 派遣（含在途）。值 = 登記時的父會話 turnGen。
// **語義釘死為「本輪」**：判據比較「登記 turnGen === 當前 turnGen」，新一輪自動失效
// ——避免 orchestrator 早輪派過一次 critic 就永久豁免機器兜底（本刀要的就是兜底常在）。
// orchestrator 自派（handleSubagentDispatch expert="critic"）與機器 pass 派遣皆登記於此。
// 有界 Map 防無界增長。
const criticDispatchedByParent = new Map<string, number>()
// M2/M3（2026-10-02）：每父會話交付簿——music-first 前置斷言（music 交付事件）＋
// 返工內容鎖（上一份交付物落盤路徑）。有界 Map，每父會話 ≤20 筆。
const deliveredByParent = new Map<string, Array<{ agent: string; label: string; relPath: string }>>()
// 本會話是否已用掉 machine critic pass（內存鏡像；權威在 persistence.critic_passes）。
const criticPassUsed = new Set<string>()
const CRITIC_PENDING_CAP = 16
// 修 1（2026-10-02）：被並發上限擠掉的 critic 待審目標入隊（per-parent）。
// 此前直接丟棄 → critic 從未跑；槽位釋放時由 maybeDrainCriticQueue 補跑。有界。
const criticRetryQueue = new Map<string, CriticPassTarget[]>()

export function initSubagent(d: SubagentDeps): void {
  deps = d
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
 * 死线③同構（2026-09-19 片頭曲 404 實錘）：子代理 opencode session 不在主
 * sessions 表，/internal/media/upload 等「session_id 解析」型端點查無記錄 →
 * 工具側上傳全掛（音軌生成成功卻 404 session not found）。子會話仍活躍時
 * 經此解析父會話 SessionState；父會話已被逐出/收尾則回 undefined，由呼叫方
 * 維持 404 原語義。uploadAudio 落盤歸屬父會話（同用戶，存儲口徑不變）。
 */
export function subagentParentState(opencodeSessionId: string): any | undefined {
  const run = byChildOc.get(opencodeSessionId)
  if (!run) return undefined
  return (
    deps?.resolveSession(run.parentGatewaySessionId) ??
    deps?.findSessionByOpenCodeId(run.parentOpencodeSessionId)
  )
}

function parentStateOf(run: SubagentRun): any {
  return (
    deps.resolveSession(run.parentGatewaySessionId) ??
    deps.findSessionByOpenCodeId(run.parentOpencodeSessionId)
  )
}

// ── 0920 暴君裁定：子代理停止閘（此前「一出就刹不住車」）─────────────────────
// 病灶（三處結構性缺失，全在本次修復）：
//   ① 用戶終止按鈕打 /agent/v1/sessions/:id/abort → 只殺**主會話**在途 turn，
//      子代理（各自獨立子會話）完全不受影響，跑完照樣 wakeParent 把父會話**重新
//      喚起來**——用戶視角＝「按了終止，它又自己活了」。
//   ② orchestrator 沒有任何停止子代理的工具（只有 dispatch/status）。
//   ③ 換模重試（retryWithNextModel）與交付閘門重派（startRework）都會另建子會話，
//      沒有「已停止」這道閘，停止後仍會被重投路徑復活。
// 本閘：stopped 一置，所有事件處理與重投路徑早退，finishRun 歸屬 "stopped" 且不喚醒。

/** 停止單一 run：標記 + abort/DELETE 子會話 + 摘註冊表 + 記 completed（工具輪詢可解鎖）。 */
export function stopSubagentRun(run: SubagentRun, by: "user" | "orchestrator", reason: string): void {
  if (run.status !== "running") return
  run.stopped = true
  run.stoppedBy = by
  run.stoppedAt = Date.now()
  if (run.timeoutTimer) clearTimeout(run.timeoutTimer)
  if (run.deadlineTimer) clearTimeout(run.deadlineTimer)
  const text = reason || `已停止子代理「${run.label}」`
  // 修 3（2026-10-02）：中止＝先落盤 partial（已累積文字，檔名規則同終態），再做
  // stopped 收尾——此前中止零產物、工作全丟（實錘：C2 與查重代理被一併殺掉）。
  run.partialPersist = true
  const persist = persistRunOutput(run, "timeout", partialBodyOf(run), text)
  const summary = persist.relPath ? `${persist.pointer}${text}` : text
  // 先落一條 done（不經 finishRun——那條路會走交付閘門/喚醒，停止語義不適用）。
  // 0920 停止閘：人工／orchestrator 停止不是失敗，標 "stopped"，前端的 "已中止"。
  run.status = "stopped" satisfies TaskStatus
  run.error = text
  run.summary = summary
  removeFromRegistries(run)
  // 修 1：停止也釋放槽位——補跑被擠掉的 critic。
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
    // 刻意**不喚醒**父會話：停止＝結束，不是新任務。喚醒會讓 orchestrator 又起一輪
    // （並可能再派新 subagent），正是用戶抱怨的「刹不住」。
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

/** 停止一個父會話名下全部在跑子代理（用戶終止按鈕 / orchestrator 一鍵清場）。回停掉幾個。 */
export function stopSubagentsForParent(parentGatewaySessionId: string, by: "user" | "orchestrator", reason = ""): number {
  const list = byParent.get(parentGatewaySessionId) ?? []
  const running = list.filter((r) => r.status === "running" && !r.stopped)
  for (const r of running) stopSubagentRun(r, by, reason)
  return running.length
}

/** 停止或恢復單一 run（orchestrator 工具用；id 可為 gateway run id 或 label 前綴）。回 run 或 undefined。 */
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

function pruneCompleted(): void {
  const now = Date.now()
  for (const [id, rec] of completed) {
    if (now - rec.finishedAt > COMPLETED_TTL_MS) completed.delete(id)
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

/** 收尾：登记结果、摘除注册表、向父会话发 done、DELETE 子会话防堆积。 */
function finishRun(run: SubagentRun, status: "ok" | "error", fullText: string, error?: string): void {
  if (run.status !== "running") return // 幂等：idle 与超时硬顶可能竞态
  // 0920 停止閘：停止已由 stopSubagentRun 收尾（已 done/已摘表）；此處不得再走
  // 交付閘門或 wakeParent——否則停止後仍會把父會話喚醒重跑（「刹不住」病灶①）。
  if (run.stopped) return
  run.status = status
  // E 片（2026-09-12）缺陷一：**先落盤完整全文/死因全文，再走摘要與 DELETE**。行內
  // 摘要仍只給 600 字（semantics 不變），但前綴掛落盤指針 → 父會話可 read 全文。
  const persist = persistRunOutput(run, status, fullText, error)
  if (status === "ok" && run.agent && !run.stopped) {
    const arr = deliveredByParent.get(run.parentGatewaySessionId) ?? []
    arr.push({ agent: run.agent, label: run.label, relPath: persist.relPath ?? "" })
    if (arr.length > 20) arr.shift()
    deliveredByParent.set(run.parentGatewaySessionId, arr)
    boundMap(deliveredByParent, 500)
  }
  const inline = (error && status === "error" ? error : fullText).slice(0, SUMMARY_MAX_CHARS)
  let summary = `${persist.pointer}${inline}`
  run.summary = summary
  run.error = error
  // 片 C（2026-09-15）刀2：交付閘門。病灶＝7 個 Expert 的 `*_DELIVERABLES` 契約只寫在
  // prompt/digest 裡，gateway 全域零強制點，漏交付（09-15 實案 music.audio_url 空）照樣
  // status:"ok" 放行。此處為唯一機械強制點：
  //   - **不改 status 語義**（ok 仍为 ok；交付缺口不是上游錯誤，混進 error 會讓既有
  //     「換模重試/超時」判讀全亂）；
  //   - 只在 summary 前綴加顯式標記 → 三個出口（subagent.done payload、completed 取件、
  //     wakeParent 喚醒）自動全帶（三處都用下面這個 summary 變數）；
  //   - subagent.done payload 加**新欄位** delivery_gate（ok 時不加，既有欄語義不動）。
  // 判據用**未截斷全文 fullText**（不是 600 字摘要——摘要會把欄位名切掉→假陰性）。
  // 只在 ok + beastMode + agent 有值時跑：非 Expert 通用子代理零回歸。
  // 邊界：只驗欄位名存在性，不驗值/品質（見 delivery-gate.ts 檔頭）。
  let deliveryGate: { ok: boolean; missing: string[]; reworked?: boolean; stillFailing?: boolean; orphaned?: boolean } | undefined
  // 刀 F（2026-09-15）：孤兒治理路徑——啟動掃描重建的 in-flight rework run（watcher 已死、
  // 不續 watch），done 帶 delivery_gate.orphaned:true，summary 已含 ORPHANED_GATE_MARK 前綴
  // （呼叫端 error 字串帶入）；status 由呼叫端傳 "error"，走既有單終態守衛 + 單次 wake。
  if (run.orphaned === true) {
    const miss = run.agent && DELIVERY_CONTRACTS[run.agent] ? DELIVERY_CONTRACTS[run.agent].requiredFields.slice() : []
    deliveryGate = { ok: false, missing: miss, reworked: true, stillFailing: true, orphaned: true }
    console.warn(
      `[gateway] delivery gate: id=${run.id} agent=${run.agent} status=ORPHANED (进程中断未复原) missing=${miss.join(",")}`,
    )
  } else if (status === "ok" && run.beastMode === true && run.agent) {
    const verdict = checkDelivery(run.agent, fullText, DELIVERY_CONTRACTS)
    // 片 D（2026-09-15）：FAIL → 機器化重派一次（同 Expert 同任務＋修正指令注回，硬帽
    // reworkCount=1）。觸發條件＝閘門區塊外條件（ok+beastMode+agent）加 FAIL 判定，
    // 非 Expert/已失敗收場零污染；status==="ok" 是必要條件——上游 error/超時不進重派鏈。
    // 提前 return：本輪**不終態**（回退 status、不發 done/不 completed.set/不 wake），
    // run 留在註冊表由 startRework 接棒；終態只屬重派鏈的最後一次 finishRun（spec 6 冪等）。
    if (!verdict.ok && run.reworkCount === 0 && !run.reworkFailure && !run.stopped) {
      run.reworkCount = 1
      run.reworking = true
      run.status = "running"
      run.summary = undefined
      console.warn(
        `[gateway] delivery gate: id=${run.id} agent=${run.agent} status=FAIL missing=${verdict.missing.join(",")} — 触发机器化重派`,
      )
      // D7（2026-10-02）：失敗模式永久留存（此前 subagent_reworks 終局刪除、無終身計數）。
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
        // 重派投递从未成功（如 opencode 不可达）：重派没跑过，done 不偽稱 reworked——
        // 維持片 C 原「未達標」標記語義，僅綴一行失敗事實。
        summary = `${formatDeliveryGateNotice(run.agent, verdict, DELIVERY_CONTRACTS)}（自动重派投递失败：${run.reworkFailure}）\n${summary}`
        deliveryGate = { ok: false, missing: verdict.missing }
      } else {
        // 重派後復檢仍 FAIL：標記升級「重派後仍未達標」，交由既有喚醒鏈如實回報。
        // status 欄語義不動（仍 ok——重派是補救嘗試，不保證成功，也不把缺口洗成錯誤）。
        summary = `${formatDeliveryGateNotice(run.agent, verdict, DELIVERY_CONTRACTS, REWORK_FAIL_MARK)}\n${summary}`
        deliveryGate = { ok: false, missing: verdict.missing, reworked: true, stillFailing: true }
      }
      run.summary = summary
      console.warn(
        `[gateway] delivery gate: id=${run.id} agent=${run.agent} status=FAIL${run.reworkCount > 0 ? " (rework exhausted)" : ""} missing=${verdict.missing.join(",")}`,
      )
    } else if (run.reworkCount > 0) {
      // 重派後復檢 PASS：done 帶 reworked 旗標（正常 summary，無前綴）；既有欄不動。
      deliveryGate = { ok: true, missing: [], reworked: true }
      console.log(`[gateway] delivery gate: id=${run.id} agent=${run.agent} status=PASS (reworked)`)
    } else {
      // PASS 也留一行：證明閘門確實在跑（否則「零命中」無法與「未接線」區分）。
      console.log(`[gateway] delivery gate: id=${run.id} agent=${run.agent} status=PASS`)
    }
  }
  // 刀 2（2026-09-15）：機器 pass 的 critic run 終態處置。verdict 判讀（保守：判不出＝退回）
  // 決定是否走既有 wakeParent 把判決送回父會話；判退回時 summary 前綴 CRITIC_REJECT_MARK，
  // orchestrator 據此依 playbook 第 16-18 條重派原 Expert 修正（原 Expert 若再失敗，其自帶
  // 的 rework 鏈硬帽 1 次仍然生效）。
  if (run.machineCriticPass === true && status === "ok") {
    run.machineCriticRejected = criticVerdictRejected(fullText)
    // 修 1（2026-10-02）：PASS 也以前綴標記判決方向，讓 summary/emit/wake 三出口一致回灌。
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
    // D7（2026-10-02）：判決落庫（此前 critic_passes 只有 session_id/created_at，verdict 不落地）。
    // score 傳 null（rubric 尚未存在，不填 0 假值）；judge_model 記 critic 實際模型鏈。
    saveCriticVerdict({
      sessionId: run.parentGatewaySessionId,
      runId: run.id,
      agent: run.agent,
      label: run.label,
      verdict: run.machineCriticRejected ? "reject" : "pass",
      score: null,
      judgeModel: (() => {
        const m = run.modelChain[run.attempt - 1]
        return m ? `${m.providerID}/${m.modelID}` : "opencode-default"
      })(),
      verdictText: typeof fullText === "string" ? fullText : "",
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
  }
  // 刀 2（2026-09-15）：Expert 交付登記為待審對象（machine critic pass 的輸入）。
  // 條件全成立才登記：正常終態（非孤兒路徑）、ok、beast、agent 在契約域內、非 critic 自身
  // （critic run 不得再觸發本 pass —— 防遞歸）。非 Expert／通用子代理零登記＝零回歸。
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
    // 有界：只留最近 CRITIC_PENDING_CAP 份（機器 pass 一次最多送審 CRITIC_PASS_MAX_TARGETS）。
    if (list.length > CRITIC_PENDING_CAP) list.splice(0, list.length - CRITIC_PENDING_CAP)
    pendingCriticTargets.set(run.parentGatewaySessionId, list)
  }

  const asyncMode = run.asyncMode === true
  removeFromRegistries(run)
  // 修 1：本 run 釋放了一個槽位——若該父會話有被並發上限擠掉的 critic 待跑，補跑。
  maybeDrainCriticQueue(run.parentGatewaySessionId)
  deleteReworkRecord(run.id) // 刀 F：終態即清持久記錄（冪等；非 rework run 無記錄=no-op）
  completed.set(run.id, { status, summary, error, finishedAt: Date.now(), label: run.label, parent: run.parentGatewaySessionId })
  // D7（2026-10-02）：交付事件落庫——重問率＝同 (session, agent, label) 再次交付的比例。
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
      summary,
      // 片 C（2026-09-15）：新增欄位，不動既有 id/status/summary 語義；ok 時不加。
      ...(deliveryGate ? { delivery_gate: deliveryGate } : {}),
    })
    // R6 異步完成喚醒：async dispatch 的終態（成功與失敗皆喚）在 emit 幀之外
    // 直接續父會話 turn（輪子=deps.wakeParent）。finishRun 幂等守衛保喚醒不重複；
    // deps.wakeParent 內部再帶 ackTimer 在途讓位，雙保險。同步模式不喚（工具還在
    // 輪詢取件，喚醒反而插話）。
    if (asyncMode && run.machineCriticPass === true) {
      // 修 1（2026-10-02）：verdict（PASS 與 REJECT）一律以正常完成儀式回灌父會話——
      // PASS 不再只寫 journal（實錘：判決從未送達，orchestrator 兩小時後手動 read 才發現）。
      try {
        deps!.wakeParent(state, { id: run.id, label: run.label, status, summary, error })
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
          summary,
          error,
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
  // E 片（2026-09-12）缺陷二防禦：拼 URL 前先驗 ses 前綴，不符跳過並記一行日誌。
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
 * 片 D（2026-09-15）：交付閘門 FAIL 後的機器化重派（bounded auto-rework，上限 1 次）。
 * **輪子復用**：與 retryWithNextModel 同範式——新子會話一律走 dispatchAttempt（內部
 * 自動繼承憲法頭注入、modelChain 當前模型、run.agent Expert 欄），禁自造第二套派遣邏輯。
 * 注入語義：run.prompt 尾部**追加**系統性修正指令（buildReworkDirective 逐字點名缺欄），
 * 原任務內容原樣帶過去；agent/beastMode/asyncMode 語義全部不動。
 * 計時器：重派＝新的完整硬頂預算（拆舊裝新）——不重裝則長任務剩餘預算≈0，重派段必然
 * 撞硬頂轉 status=error，把「重派後仍未達標」的誠實標記路徑搶先污染成超時錯誤。
 * 同步 deadlineTimer 不動：其「主會話放行轉后台」語義屬首輪工具側契約，重派段沿用。
 * 投遞失敗：孤兒會話 best-effort 清理、run 位回舊會話、記 reworkFailure，再進 finishRun
 * 回退到片 C 標記放行（不偽稱 reworked、不動 status）。
 */
async function startRework(run: SubagentRun, verdict: DeliveryGateResult, firstText: string): Promise<void> {
  if (!deps) return
  const oldChild = run.opencodeSessionId
  run.prompt = `${run.prompt}\n\n---\n\n${buildReworkDirective(run.agent ?? "", verdict, DELIVERY_CONTRACTS)}`
  if (run.timeoutTimer) clearTimeout(run.timeoutTimer)
  const hardMs = run.asyncMode ? ASYNC_HARD_TIMEOUT_MS : HARD_TIMEOUT_MS
  run.timeoutTimer = setTimeout(() => {
    console.warn(`[gateway] subagent hard timeout in rework (${Math.round(hardMs / 60000)}min): id=${run.id} label="${run.label}"`)
    // 修 3：重派段逾時同樣先落盤 partial。
    run.partialPersist = true
    run.reworking = false
    finishRun(run, "error", partialBodyOf(run), `子代理超时（${Math.round(hardMs / 60000)} 分钟），已强制结束`)
  }, hardMs)
  // D5（2026-10-02）：重派段同樣有心跳／逾時前部分交付。
  armHeartbeat(run, hardMs)
  const failure = await dispatchAttempt(run)
  if (failure) {
    run.reworking = false
    // dispatchAttempt 可能已建的新會話（prompt_async 失敗路徑已摘 byChildOc 映射）：
    // best-effort 刪掉孤兒，再把 run 的子會話位回撥到舊會話，讓收尾清理對準真身。
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
  // 新會話註冊成功後才摘舊映射（先立後破：run.id 在 status 端點的 byChildOc 視圖無空窗）。
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
  // 刀 F（2026-09-15）：重派子會話註冊成功＝孤兒風險窗口開啓，落一條持久記錄；終態由
  // finishRun 清除。啟動掃描據 child_oc 探 opencode，判斷續檢還是誠實治理。
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

/** 檔名安全化：去空白、替換 / \ : * ? " < > |；保留中文；去前導點防路徑逃逸。 */
function safeLabelForFile(label: string): string {
  const cleaned = (label || "")
    .replace(/[/\\:*?"<>|]/g, "_")
    .replace(/\s+/g, "_")
    .replace(/^\.+/, "")
    .slice(0, 40)
  return cleaned || "subagent"
}

interface PersistOutcome {
  pointer: string
  relPath?: string
  chars: number
  failed?: string
}

/**
 * E 片（2026-09-12）缺陷一：完整結果/死因落盤（在 DELETE 子會話之前呼叫）。
 * 內容 = `# label` + runId/狀態/模型/耗時/子會話元信息 + **未截斷**正文（無正文時
 * 如實寫死因事實，不偽造）+ 尾註 PERSIST_TAIL。644、與 opencode(agentsvc) 讀取權限
 * 相容。**落盤失敗不得讓收尾失敗**：全程 try/catch，失敗 console.error 帶 runId，
 * 指針改成誠實的失敗前綴（不吞錯、不裝成功）。
 */
/** 修 3：join 本 run 已累積的文字 part（message.part.updated 存完整 text）作 partial 正文。 */
function partialBodyOf(run: SubagentRun): string {
  const parts: string[] = []
  for (const t of run.partText.values()) {
    if (typeof t === "string" && t.trim()) parts.push(t.trim())
  }
  return parts.join("\n").trim()
}

/** D5（2026-10-02）：心跳與逾時前部分交付。
 *  證據：硬逾時 22 次、會話實錄「40 分鐘無任何存活訊號」、中止即全丟（REPORT A8）。
 *  心跳間隔（60s）無文獻依據，屬待調參數（MCP progress / A2A 任務狀態機為機制類別依據）。
 *  心跳不得抛錯、不得改變 run 狀態；計時器 unref，不阻擋進程退出。 */
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
    const body = partialBodyOf(run).replace(/\s+/g, " ")
    const snippet = body ? body.slice(-120) : "（尚无正文产出）"
    try {
      deps?.emitToSession(state, "turn.status", {
        text: `子代理「${run.label}」仍在运行（已 ${elapsed}s）… 最近：${snippet}`,
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
      // 早於硬頂落盤快照，不改變 run 狀態；run 真完成時 finishRun 以全文覆寫同一檔。
      persistRunOutput(run, "timeout", body, "（逾时前部分产物快照；run 仍在续跑，完成后覆写同一档）", true)
      console.warn(`[gateway] subagent early partial persisted: id=${run.id} label="${run.label}" chars=${body.length}`)
    }, hardMs - earlyMs)
    unrefTimer(run.earlyPartialTimer)
  }
}

function unrefTimer(t: ReturnType<typeof setTimeout> | ReturnType<typeof setInterval> | undefined): void {
  ;(t as unknown as { unref?: () => void } | undefined)?.unref?.()
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
    // 修 3：partial 落盤時「状态」標 partial（檔名規則與終態一致）。
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
      chmodSync(abs, 0o644) // 明確 644：不受進程 umask 影響
    } catch {
      /* chmod 失敗不影響可讀性（mode 已帶） */
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
 * E 片（2026-09-12）缺陷二防禦：凡拼進 opencode session URL 的 id 必須是 `ses` 開頭
 * 字串。09-12 實錘：子代理 run id（UUID）被塞進 opencode 的 session 位（session.error
 * code=tool_error message=Expected a string starting with "ses", got "0e160b80-…"）。
 * 不符就跳過該呼叫並 console.error 一行（不靜默、不硬送半截 URL）。
 */
function isOpenCodeSessionId(id: unknown): id is string {
  return typeof id === "string" && id.startsWith("ses")
}

/** 子会话 idle：取最后一条 assistant 文本作 summary。 */
async function summarizeChild(run: SubagentRun): Promise<void> {
  // 片 D（2026-09-15）：重派投遞在途——run 此刻仍掛在舊子會話 id 上（新會話尚未註冊），
  // 舊會話殘影事件（如重複 idle）不得把尚在重派鏈中的 run 提前收尾。
  if (run.reworking) return
  // E 片（2026-09-12）缺陷二防禦：無合法子會話 id 就不拼 URL，如實收尾（死因落盤）。
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
      const msgs = (await res.json()) as Array<{ info?: { role?: string }; parts?: Array<{ type?: string; text?: string }> }>
      if (Array.isArray(msgs)) {
        const lastAssistant = [...msgs].reverse().find((m) => m?.info?.role === "assistant")
        text = (lastAssistant?.parts ?? [])
          .filter((p) => p?.type === "text" && typeof p.text === "string")
          .map((p) => p.text as string)
          .join("\n")
          .trim()
      }
    }
  } catch (e) {
    console.error(`[gateway] subagent summarize failed: id=${run.id}`, e)
  }
  if (text) {
    finishRun(run, "ok", text)
    return
  }
  // 09-18 修復（七路全滅實錘）：上游渠道瞬斷時 opencode 吞掉 stream error、子會話以
  // 「正常 idle + 零 assistant 文本」收尾——session.error 事件根本不會出現，下面的
  // 換模重試鏈因此從不觸發，attempt 永遠停在 1/5。此處補上對稱觸發點：零文本且鏈上
  // 還有備選模型 → 視同渠道故障換模重投；耗盡才如實 finishRun error（語義不變）。
  if (run.attempt < run.modelChain.length) {
    const nextAttempt = run.attempt + 1
    const oldChild = run.opencodeSessionId
    console.error(
      `[gateway] subagent empty-output (attempt ${run.attempt}/${run.modelChain.length}): id=${run.id} label="${run.label}" — 疑似上游渠道故障，换模重投`,
    )
    run.attempt = nextAttempt
    // 與 session.error 換模路徑同款清理：舊子會話摘除 + best-effort DELETE + 映射重置。
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
 * 建子会话并投递任务书（attempt = run.attempt 對應 modelChain 里的模型）。
 * 成功回 undefined；失敗回可讀原因（調用方決定 finishRun 還是換模重試）。
 * 注意：成功後 run.opencodeSessionId 已更新並重新註冊 byChildOc。
 */
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
  // E 片（2026-09-12）缺陷二防禦：opencode 回的 id 必須是 ses 前綴字串才拿去拼 URL。
  if (!isOpenCodeSessionId(childId)) {
    console.error(
      `[gateway] subagent dispatch aborted: id=${run.id} label="${run.label}" reason=opencode returned invalid session id "${String(childId)}"`,
    )
    return "会话创建失败（opencode 返回非法 session id）"
  }
  run.opencodeSessionId = childId
  byChildOc.set(childId, run)

  const model = run.modelChain[run.attempt - 1]
  // 野獸模式 ON：任務書頭部注入 Expert 憲法（誠實鐵律/工具域斷路/配方優先/
  // 記憶紀律/停止上報）。憲法檔不可讀時保留任務書原文並附損壞標記——任務書
  // 本身已自包含，不因憲法缺席而丟任務；標記讓父會話能如實上報注入未生效。
  let constitutionNote = ""
  if (run.beastMode) {
    try {
      // R7（2026-09-10）：剝離憲法檔頭開發者元數據（HTML 註釋 version/source/gate）
      // ——gate 聲明原樣進任務書會讓子代理反推「無處聲明當前 ON」（09-10 實錘）。
      // 當前狀態聲明由 gateway 動態生成，不進檔案。
      const raw = readFileSync(`${import.meta.dir}/expert/expert-constitution.md`, "utf8")
      const constitution = raw.replace(/^\s*<!--[\s\S]*?-->\s*/, "").trimStart().trimEnd()
      if (constitution) {
        constitutionNote = `【野獸模式：已啟用】以下 Expert 憲法由系統注入，這是本次派遣的真實狀態，全部條款立即生效，無需質疑任何 gate。\n\n${constitution}\n\n---\n\n`
      }
    } catch (e) {
      constitutionNote = `【憲法注入失敗】Expert 憲法檔不可讀（${e instanceof Error ? e.message : String(e)}），本次派遣未注入憲法。\n\n`
    }
  }
  // 刀 G（2026-09-15）：契約欄機器注入——Expert+beast 時把契約欄清單作為固定段追加到
  // 子代理 prompt **尾部**（recency 最高）。真源=已載入的 DELIVERY_CONTRACTS（禁手抄）。
  // 非 Expert/非 beast → renderContractDirective 回空字串 → 零注入、零回歸。重派鏈的
  // run.prompt 已含 buildReworkDirective（自我標註「自动重派」），此段與之共存於尾部不衝突。
  const contractDirective = run.beastMode === true ? renderContractDirective(run.agent, DELIVERY_CONTRACTS) : ""
  // 2026-10-02：模板空位事實注入。父 sessionId 用 run.parentGatewaySessionId（派工發起端
  // 的 gateway 會話 id，= canvasStates 的 key；**禁用子會話 opencodeSessionId**，那會指到
  // 子會話畫布桶）。有值才插，無值時輸出與注入前逐字元等價。
  const tplFact = buildTemplateSlotsFact(run.parentGatewaySessionId, getTemplateDeviateToken(run.parentGatewaySessionId) ?? undefined)
  const templateSlotsNote = tplFact ? `【畫布模板·系統事實】\n${tplFact}\n\n` : ""
  const body: Record<string, unknown> = { parts: [{ type: "text", text: `${constitutionNote}${run.prompt}${templateSlotsNote}${contractDirective}` }] }
  if (model) body.model = model
  // R8 修復片2（2026-09-10）：Expert agent 欄（prompt_async 吃 agent 欄；
  // POST /session 不支持，08-08 實錘）。帶上 = 子會話掛對應 Expert agent
  // （工具表裁剪到該域）；缺省 = default build 零變化。換模重試
  // （retryWithNextModel）走本函數，agent 自然繼承。
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
  console.log(
    `[gateway] subagent attempt: id=${run.id} label="${run.label}" attempt=${run.attempt}/${Math.max(run.modelChain.length, 1)} model=${model ? `${model.providerID}/${model.modelID}` : "opencode-default"} child=${childId} agent=${run.agent ?? "-"}`,
  )
  return undefined
}

/** 上游錯誤後的換模重試：新子會話 + 鏈上下一個模型重投任務書。 */
async function retryWithNextModel(run: SubagentRun, lastError: string): Promise<void> {
  // 0920 停止閘：已停止的 run 不得被換模重投復活（病灶③）。
  if (run.stopped || run.status !== "running") {
    console.log(`[gateway] subagent retry skipped (stopped): id=${run.id} label="${run.label}"`)
    return
  }
  const failure = await dispatchAttempt(run)
  if (!failure) return // 重投成功：事件流繼續，等 idle/error 收尾
  console.error(`[gateway] subagent retry dispatch failed: id=${run.id} ${failure}`)
  finishRun(run, "error", "", `子代理出错：${lastError}（换模重投也失败：${failure}）`)
}

/** 全局 tap 入口：子会话事件翻译成 subagent.* 帧发到父会话。 */
export function handleSubagentEvent(event: any, opencodeSessionId: string): void {
  if (!deps) return
  const run = byChildOc.get(opencodeSessionId)
  if (!run) return
  // 0920 停止閘：停止後子會話已 DELETE，殘影事件一律丟棄（否則又推進卡片狀態、
  // 甚至觸發換模重投把 run 復活）。
  if (run.stopped) return
  try {
    // 上游错误（session.error 或任意带 properties.error 的事件）→ 換模重試或 done error。
    const err = event?.properties?.error
    if (event?.type === "session.error" || err != null) {
      const msg = err != null ? deps.describeError(err) : "子代理上游错误"
      // 只有上游模型錯誤（opencode APIError 形狀 {name, data:{message}}）才換模重試；
      // tool_error/Aborted 不是渠道問題，換模無意義，維持原語義直接收尾。
      const isUpstreamApiError =
        Boolean(err) && typeof err === "object" && typeof (err as { data?: { message?: unknown } }).data?.message === "string"
      if (isUpstreamApiError && run.attempt < run.modelChain.length) {
        const nextAttempt = run.attempt + 1
        console.error(
          `[gateway] subagent upstream error (attempt ${run.attempt}/${run.modelChain.length}): id=${run.id} label="${run.label}" error=${msg} — 换模重投`,
        )
        run.attempt = nextAttempt
        // 舊子會話摘除 + best-effort 清理；per-child 映射重置，避免新會話被髒狀態誤判。
        byChildOc.delete(opencodeSessionId)
        // E 片（2026-09-12）缺陷二防禦：ses 前綴不符就不拼 URL（跳過並記錄）。
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
      // 0919 誠實歸因（video-director 試產事故）：shuai 預扣費閘的「预扣费额度失败,
      // 用户剩余额度…」原文直出時，orchestrator 在 model-not-found 噪音裡把欠費
      // 誤讀成「模型不可用」再轉述給用戶。欠費死因補一句歸因：未提交、未扣費、
      // 無產物、充值前重試無效——錯誤分類給機器，因果說明給讀它的模型。
      const deadAccountNote = /预扣费额度失败|insufficient[ _-]?(account[ _-]?)?(balance|credit)|余额不足|欠费/i.test(String(msg))
        ? "（归因：上游渠道账户余额不足即欠费，不是模型不可用；本次调用未提交、未扣费、无产物，充值前重试不会成功）"
        : ""
      finishRun(run, "error", "", `子代理出错：${String(msg)}${deadAccountNote}`)
      return
    }

    const parentState = parentStateOf(run)
    if (!parentState) return // 父会话已被回收：不再发帧，等 idle/超时收尾

    switch (event?.type) {
      case "message.updated": {
        const info = event?.properties?.info
        const mid = typeof info?.id === "string" ? info.id : undefined
        const role = typeof info?.role === "string" ? info.role : undefined
        if (mid && role) {
          run.messageRole.set(mid, role)
          boundMap(run.messageRole, 200)
        }
        // 壓縮復讀機修復（2026-10-02）：compaction 摘要訊息 role 也是 assistant，
        // 標成非 assistant 後 subagent.delta 不再把摘要草稿當子代理正文上屏。
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
          deps.emitToSession(
            parentState,
            "subagent.delta",
            kind === "reasoning" ? { id: run.id, text: p.delta, kind } : { id: run.id, text: p.delta },
          )
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
        // 下面的早退分支，登记必须放在早退之前，否则其 delta 全部丢 kind（實彈實錘）。
        run.partKind.set(id, part.type)
        boundMap(run.partKind, 200)
        // 修 3：保存 text part 最新全文（part.updated 帶完整 text），供逾時/中止 partial 落盤。
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
          deps.emitToSession(
            parentState,
            "subagent.delta",
            part.type === "reasoning" ? { id: run.id, text: suffix, kind: "reasoning" } : { id: run.id, text: suffix },
          )
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

// ── 刀 2（2026-09-15）：machine critic pass —— gateway 自己在收盤判定點派 critic ────────────
// 四輪實錄：playbook 第 18 條「必須派 critic」四輪在場、orchestrator 四輪零派遣（r3c 逐字
// 「I won't re-dispatch anything…synthesis is my job」）。純 prompt 路線已證死 → 不叫模型派。
//
// 掛點＝父會話 session.idle 正常收尾分支（index.ts），調本函數。設計鐵律：
//   · 派遣輪子**復用 dispatchAttempt**（同 handleSubagentDispatch 範式：建子會話 + agent 欄
//     + 憲法頭 + 契約欄注入 + modelChain），禁自造第二套派遣/輪詢。
//   · async 語義沿用：終態由 finishRun → deps.wakeParent 回件（通過抑制喚醒、退回送判決）。
//   · 有界：每會話 ≤1 次（persistence.critic_passes 持久旗標 + 內存鏡像）；critic run 自身
//     agent==="critic" 永不入待審清單（finishRun 登記側已豁免）= 不遞歸。
//   · 零預算外洩：只在「本來就有 Expert 交付」時跑；同輪已有 critic 派遣 → 不重派。
//   · 並發上限讓位：父會話已滿 3 路（如 async 子代仍在跑）→ 本輪放棄、不記旗標，下輪 idle 再試。

/**
 * 收盤判定點呼叫：條件成立 → 機器派遣一次 critic pass。回 true = 已派出。
 * 冪等/有界全部在內部（見上方註解）。任何失敗只留一行 log，絕不影響收盤路徑。
 */
export function maybeRunMachineCriticPass(parentState: any, unreviewedDeclared = false): boolean {
  try {
    if (!deps || !parentState?.sessionId) return false

    // ① 待審清單（finishRun 對 Expert 正常終態登記）。空 → 零動作（非 beast/無 Expert 交付）。
    const parentId = String(parentState.sessionId)
    const targets = pendingCriticTargets.get(parentId) ?? []
    if (targets.length === 0) return false

    // ② 每會話 ≤1 次：內存鏡像 or 持久旗標（重啟後仍生效）。
    const alreadyPassed = criticPassUsed.has(parentId) || hasCriticPass(parentId)

    // ③ 純函數判據（四態單測對象）。
    const ok = shouldTriggerCriticPass({
      beastMode: deps.beastMode(parentState) === true,
      expertDeliveries: targets.length,
      criticDispatched: criticDispatchedByParent.get(parentId) === (parentState.turnGen ?? 0),
      unreviewedDeclared: unreviewedDeclared === true, // 逃生閥由呼叫端（index.ts 掃本輪正文）判定
      alreadyPassed,
    })
    if (!ok) return false

    // ④ 修 1（2026-10-02）：並發上限滿時**不再丟棄**——待審目標入隊（per-parent），
    // 任一子代理完成釋放槽位時由 maybeDrainCriticQueue 補跑。此前 return false 直接
    // 丟棄（實錘：四次被擠掉；唯一一次跑到時 verdict 亦未回灌）。
    const list = byParent.get(parentId) ?? []
    if (list.length >= MAX_ACTIVE_PER_PARENT) {
      criticRetryQueue.set(parentId, targets.slice(-CRITIC_PASS_MAX_TARGETS))
      boundMap(criticRetryQueue, 500)
      console.log(
        `[gateway] machine critic pass queued (parent at concurrency cap ${MAX_ACTIVE_PER_PARENT}, retry on slot release): session=${parentId}`,
      )
      return false
    }
    // 修 1：正常派出（槽位有餘）時清殘留隊列，避免稍後 drain 重複派遣。
    criticRetryQueue.delete(parentId)

    // ⑤ spec：被審清單 + 各 Expert 契約欄（真源 DELIVERY_CONTRACTS）+ 固定審核指令。
    const batch = targets.slice(-CRITIC_PASS_MAX_TARGETS)
    const spec = buildCriticPassSpec(batch, DELIVERY_CONTRACTS)
    if (!spec) return false

    // ⑥ modelChain 同源（父會話 persona 主模型 + registry fallbacks）。
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
      label: "机器审核",
      startedAt: Date.now(),
      status: "running",
      // 首行補死線行（與 handleSubagentDispatch 同款；本 spec 首行非「预期 N」故會補）。
      prompt: SPEC_DEADLINE_LINE + spec,
      modelChain: chain,
      attempt: 1,
      reworkCount: 0,
      beastMode: true, // 已過 beastMode 判據
      agent: "critic",
      asyncMode: typeof deps.wakeParent === "function", // async 語義沿用；deps 未注入則降級同步
      machineCriticPass: true,
      messageRole: new Map(),
      partEmitted: new Map(),
      partKind: new Map(),
      suppressedParts: new Set(),
      partText: new Map(),
    }

    // 註冊進 byParent：與 handleSubagentDispatch 同語義——critic run 佔一個並發位、
    // finishRun 的 removeFromRegistries 才能正確摘除本 run（否則殘留註冊表泄漏）。
    const parentRuns = byParent.get(parentId) ?? []
    parentRuns.push(run)
    byParent.set(parentId, parentRuns)

    // 先記旗標與派遣位（同步），再投遞；投遞失敗則回滾旗標（不白吃唯一一次配額）。
    criticPassUsed.add(parentId)
    markCriticPass(parentId)
    criticDispatchedByParent.set(parentId, parentState.turnGen ?? 0)
    boundMap(criticDispatchedByParent, 500)
    // 已消耗：清待審清單（本會話不再有第二次 pass）。
    pendingCriticTargets.delete(parentId)

    const asyncMode = run.asyncMode === true
    const hardMs = asyncMode ? ASYNC_HARD_TIMEOUT_MS : HARD_TIMEOUT_MS
    run.timeoutTimer = setTimeout(() => {
      console.warn(`[gateway] subagent hard timeout (${Math.round(hardMs / 60000)}min): id=${run.id} label="${run.label}"`)
      // 修 3（2026-10-02）：逾時先落盤已累積的 partial 文字，再 error 收尾（不讓已有工作不可追）。
      run.partialPersist = true
      finishRun(run, "error", partialBodyOf(run), `子代理超时（${Math.round(hardMs / 60000)} 分钟），已强制结束`)
    }, hardMs)
    // D5（2026-10-02）：機器 critic run 亦有心跳／逾時前部分交付。
    armHeartbeat(run, hardMs)

    // ⑦ 復用既有輪子投遞（async 語義：立即返回，終態 wake）。
    void (async () => {
      const failure = await dispatchAttempt(run)
      if (failure) {
        criticPassUsed.delete(parentId)
        criticDispatchedByParent.delete(parentId)
        console.error(`[gateway] machine critic pass dispatch failed: session=${parentId} ${failure}`)
        // 回滾持久旗標：投遞從未成功＝配額未消耗（不白吃唯一一次），清掉記錄讓下輪重試。
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

/** 修 1：槽位釋放後補跑被並發上限擠掉的 machine critic pass（per-parent 隊列）。
 *  複用 maybeRunMachineCriticPass 的完整判據與派遣輪子（不另造第二套）。 */
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
 * 會話拆除時清 machine critic pass 的內存狀態（待審清單 / 派遣登記 / 內存已用旗標）。
 * 持久旗標（persistence.critic_passes）刻意不清：idle reap 後同 id revive 仍受「每會話 ≤1 次」
 * 約束；真刪除時 row 隨會話生命週期結束自然無害（無查詢點）。
 */
export function forgetCriticPassState(parentId: string): void {
  if (!parentId) return
  pendingCriticTargets.delete(parentId)
  criticDispatchedByParent.delete(parentId)
  criticPassUsed.delete(parentId)
  criticRetryQueue.delete(parentId)
}
/**
 * 刀 1（2026-09-19）：待審 Expert 交付快照（Jev 空殼欄初篩餵料）。
 * 只讀鏡像——不清空、不影響 machine critic pass 的消耗語義（淺拷貝陣列，
 * text 引用共享：呼叫方只讀）。無待審 → 空陣列。
 */
export function snapshotPendingCriticTargets(parentId: string): Array<{ agent: string; label: string; runId: string; text: string }> {
  if (!parentId) return []
  return (pendingCriticTargets.get(parentId) ?? []).slice()
}
/**
 * POST /internal/subagent/dispatch — body { sessionId, label, prompt, async? }。
 * sessionId 接受 gateway id 或父 opencode id（与 /internal/workflow 同语义）。
 * 返回 { ok: true, subagent_id } 供工具轮询 /internal/subagent/status。
 * R6（2026-09-10）：async=true → 投遞後立即返回 running，子代理終態時
 * deps.wakeParent 自動喚醒父會話匯總（默認 false=同步語義零回歸；deps 未注入
 * wakeParent 時 async 請求按同步處理，不裸奔）。
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
  // P2b 刀1：prompt 需可被自動補行改寫。
  let prompt = typeof body.prompt === "string" ? body.prompt : ""
  if (!body.sessionId || !label || !prompt) {
    // D2（2026-10-02）：空字串錯誤碼是反模式（歷史 717 次）——失敗一律帶 code 與缺哪欄。
    const missing = [!body.sessionId ? "sessionId" : "", !label ? "label" : "", !prompt ? "prompt" : ""].filter(Boolean)
    return Response.json(
      { ok: false, code: "missing_required_args", error: `sessionId/label/prompt 均为必填；缺少：${missing.join("、")}`, missing },
      { status: 400 },
    )
  }
  // P2b 刀1：首行自動補死線行。已寫「预期/預期 N」= 原樣不動（避免雙補）。
  // 字符集與 R1 parseSyncDeadlineMs 對齊（简/繁皆認），確保不重複補。
  if (!/^\s*[预預]\s*期\s*\d/.test(prompt)) {
    prompt = SPEC_DEADLINE_LINE + prompt
  }
  const parent = deps.resolveSession(body.sessionId)
  if (!parent) {
    return Response.json({ ok: false, code: "session_not_found", error: "父会话不存在或已过期" }, { status: 404 })
  }
  // R6：async 開關。顯式 true 且 wakeParent 已注入才走異步；否則一律同步（默認路徑零變化）。
  // 刀3（2026-09-19）：async 三條件機器化（playbook 1.9 起 LLM 不再自判）——
  // beast 下明確要求 sync（async:false）時，Jev 判「非單一快速事實查詢」→ 自動
  // 轉 async 並記 SYNC_DOWNGRADED；Jev 掛 → 放行 sync（fail-open＝現狀行為）。
  let asyncMode = body.async === true && typeof deps.wakeParent === "function"
  if (!asyncMode && body.async === false && typeof deps.wakeParent === "function") {
    const eligible = await syncDispatchEligible(prompt)
    if (eligible === false) {
      asyncMode = true
      console.log(`[gateway] jev_gate: SYNC_DOWNGRADED label="${label}" (not a quick fact lookup, forced async)`)
    }
  }

  // R8 修復片2（2026-09-10）＋刀3 權威化（2026-09-19）：Expert 路由。
  // 僅 beast_mode ON 時生效（OFF 時 expert 靜默丟棄 = 零 OFF 回歸）。
  // 刀3 教義（2026-09-19 立、2026-10-02 暴君修正）：「派誰」不是 LLM 的決策——
  //   ① expert 欄可省略：省略時 Jev 選域（高信心才派，否則通用子代理）；
  //   ② LLM 點名 expert＝最終裁決：Jev 高信心不同意只記 ROUTE_DISSENT，不改派
  //     （原 ROUTE_OVERRIDE 已廢除——曾把點名 video-director 的預覽轉存強改派
  //     editor，改派後域內無鑑權工具全 401；表面詞彙無法反映工具持有面）；
  //   ③ Jev 掛 → fail-open 用點名值（行為＝部署前）。
  // 白名單校驗照舊（Jev 建議也過 expert-ids.json；域外/未知 → 拒絕 400）。
  let expertId = ""
  const beastOn = deps.beastMode(parent)
  const rawExpert = typeof body.expert === "string" ? body.expert.trim() : ""
  if (beastOn) {
    let allowed: unknown
    try {
      allowed = (JSON.parse(readFileSync(`${import.meta.dir}/expert/expert-ids.json`, "utf8")) as { experts?: unknown })?.experts
    } catch (e) {
      return Response.json(
        { ok: false, code: "expert_registry_unavailable", error: `expert 清單不可讀（gateway/expert/expert-ids.json：${e instanceof Error ? e.message : String(e)}）` },
        { status: 503 },
      )
    }
    if (!Array.isArray(allowed)) {
      return Response.json(
        { ok: false, code: "expert_registry_unavailable", error: "expert 清單不可讀（gateway/expert/expert-ids.json 形狀錯誤：缺 experts 陣列）" },
        { status: 503 },
      )
    }
    const allowedList = allowed as string[]
    if (rawExpert && !allowedList.includes(rawExpert)) {
      return Response.json({ ok: false, code: "unknown_expert", error: `未知 expert：${rawExpert}`, allowed: allowedList }, { status: 400 })
    }
    // 刀3 權威路由（Jev 失敗回 null → fail-open 用點名值/空）。
    const routed = (await routeExpertAuthoritative(prompt, rawExpert)) ?? {
      expertId: rawExpert,
      source: rawExpert ? ("provided" as const) : ("none" as const),
    }
    if (routed.expertId && !allowedList.includes(routed.expertId)) {
      // Jev 建議域外（不該發生：criteria 就是七域＋other；防禦性回退到點名值）。
      expertId = rawExpert
    } else {
      expertId = routed.expertId
    }
    // H9（2026-10-02）：內容 vs expert 域一致性守衛（確定性，Jev 掛也生效）。
    // 在 critic 登記之前執行——被降級的研究任務不得頂掉機器 critic pass 的觸發判據。
    {
      const g = guardExpertContent(prompt, expertId)
      if (g.reason) {
        console.log(`[gateway] jev_gate: EXPERT_GUARD ${expertId || "-"} -> ${g.expertId || "generic"} label="${label}" reason=${g.reason}`)
        expertId = g.expertId
      }
    }
    // M2：music-first 機器前置斷言（依賴音樂的任務須等 music 交付事件）。
    {
      const delivered = deliveredByParent.get(parent.sessionId) ?? []
      const musicInFlight = (byParent.get(parent.sessionId) ?? []).some((r) => r.agent === "music" && r.status === "running")
      const reason = musicFirstBlockReason(prompt, expertId, {
        musicInFlight,
        musicDelivered: delivered.some((d) => d.agent === "music"),
      })
      if (reason) {
        console.log(`[gateway] jev_gate: MUSIC_FIRST_BLOCKED label="${label}" expert=${expertId || "-"} inflight=${musicInFlight}`)
        return Response.json({ ok: false, code: "music_first", error: reason, blocked: "music_first" }, { status: 409 })
      }
    }
    // 刀 2（2026-09-15）：orchestrator **自行**派 critic = 本輪已有 critic 審核動作，
    // 機器 pass 的觸發判據據此豁免（不重複派遣）。登記有界 Map。
    if (expertId === "critic") {
      criticDispatchedByParent.set(parent.sessionId, parent.turnGen ?? 0)
      boundMap(criticDispatchedByParent, 500)
    }
  }

  // 刀 2B（2026-09-19）：派遣 spec 消毒（權威）。研究結論/網頁內容嵌 spec 是活的
  // 間接注入通道（手冊模板二【研究輸入】逐字嵌 prompt）。Jev 判攔截線以上 →
  // spec 頭注入機器隔離聲明（不攔派遣、只廢掉注入指令的效力）。
  {
    const quarantine = await quarantineSpec(`dispatch:${label || "unlabeled"}`, prompt)
    if (quarantine) prompt = `${quarantine}\n${prompt}`
  }

  // 量級瘦身 A（2026-09-19）：spec 模板機器注入。三軍模板（研究/創作/毒蛇評審，
  // playbook 1.8 逐字遷出至 spec-templates.json）按 Jev 任務分類自動追加到任務書
  // 頭部——orchestrator 只寫任務意圖，配方由機器持有。Jev 掛 → 不注入（fail-open，
  // 子代理照原 spec 跑；模板缺檔同理跳過，只留 log）。
  // 0920 暴君裁定：模板選擇接 System One——同一請求批次取回工作流模板判定，
  // 命中製作類（confidence≥0.8）即把骨架硬注入任務書頭（先於軍團模板），
  // 讓「沒人負責選模板」不再可能（事故：60s 百合 OP MV 裸跑＝無角色卡約束）。
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
        // 0920 暴君裁定（第二版）：模板判定完成即建骨架彈上畫布——不等 Expert
        // 去調 workflow_start（實錘：Expert 根本沒調，右邊永遠空白，「太慢了」）。
        // 建構用佔位內容滿足後端「每個 text role 非空」的驗證；Expert 之後同模板
        // 呼叫 workflow_start 走 P0 冪等守衛復用同一支 wf，再用 workflow_update_node
        // 回填真內容。失敗一律 fail-open（Expert 仍可自行建立，行為＝部署前）。
        try {
          // 修 4（2026-10-02）：per-session 骨架去重——本會話整個生命週期最多一個骨架。
          // 先查該父會話是否已有 workflowSnapshot（持久鏡像）或已登記 owner wf：有則
          // 復用同一個 workflowId，不新建不覆蓋（此前同一會話建 14 個 wf 只留最後一個=孤兒）。
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
                `[gateway] jev_gate: WORKFLOW_SKELETON built template=${meta.template.templateId} wf=${r.workflowId} session=${parent.sessionId} (判定即彈，不等 Expert)`,
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
        prompt = `【系統注入·軍團模板】以下模板骨架由網關按任務類型自動注入，與你的任務書同效；〔括號〕欄由你填。\n\n${tpl[meta.specKey]}\n\n---\n\n【任務書原文】\n${prompt}`
        templateInjected = true
      }
    } catch (e) {
      console.log(`[gateway] spec template injection skipped (read/classify failed): ${e instanceof Error ? e.message : String(e)}`)
    }
    if (templateInjected) console.log(`[gateway] spec template injected: label="${label}"`)
  }

  // M3（2026-10-02）：返工 spec 內容鎖。偵測到返工任務 → 注入「只改 X 欄、其餘逐字沿用
  // <原稿路徑>＋交付附 diff」（原稿路徑＝同 label/同 expert 最近一份落盤交付物）。
  if (isReworkSpec(prompt)) {
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

  // 模型链：父會話 persona 主模型 + registry fallbacks（空鏈 = 吃 opencode 預設，
  // 僅在 registry 缺失的極端情況發生，此時無鏈可換）。
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
    // 片 D（2026-09-15）：交付閘門重派計數，硬帽 1 次。
    reworkCount: 0,
    beastMode: deps.beastMode(parent),
    agent: expertId || undefined,
    asyncMode,
    messageRole: new Map(),
    partEmitted: new Map(),
    partKind: new Map(),
    suppressedParts: new Set(),
    partText: new Map(),
  }
  list.push(run)
  byParent.set(parent.sessionId, list)

  // 硬顶：同步 15 分钟（工具轮询 16 分钟死线之前收尾）；R6 async 30 分钟
  // （军团的窄领域研究/创作任务合法地更长，无工具死线顶着，给足余量）。
  const hardMs = asyncMode ? ASYNC_HARD_TIMEOUT_MS : HARD_TIMEOUT_MS
  run.timeoutTimer = setTimeout(() => {
    console.warn(`[gateway] subagent hard timeout (${Math.round(hardMs / 60000)}min): id=${run.id} label="${run.label}"`)
    // 修 3（2026-10-02）：逾時先落盤已累積的 partial 文字，再 error 收尾（不讓已有工作不可追）。
    run.partialPersist = true
    finishRun(run, "error", partialBodyOf(run), `子代理超时（${Math.round(hardMs / 60000)} 分钟），已强制结束`)
  }, hardMs)
  // D5（2026-10-02）：心跳 + 逾時前 2 分鐘部分交付。
  armHeartbeat(run, hardMs)

  // 投递任务书（第一次 attempt；後續上游錯誤換模重試走 retryWithNextModel）
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
    // R1（2026-09-11）：同步 dispatch 硬 deadline。到點先讓主會話解鎖（工具輪詢
    // /internal/subagent/status 讀 completed 即取件，實測 <30s 收到 ok:false/TIMEOUT），
    // **子代理 run 不殺**：翻 asyncMode 讓它後台續跑，完成後走既有 wakeParent 回填。
    const deadlineMs = parseSyncDeadlineMs(run.prompt)
    // P2b：arm 時刻記一條，deadline 解析結果可被日誌直接觀測（V3 不必等 240s）。
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
      // E 片（2026-09-12）：超時放行這一刻的事實也落盤（無正文 → 寫死因事實）。此刻
      // 盤上不是交付物，**不掛「完整结果已落盘」指針**（掛了會誤導）；run 後續真完成
      // 時 finishRun 用全文覆寫同一檔並帶指針。
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
    // R6 異步：投遞成功立即返回，主會話 turn 可正常結束；完成後 wakeParent 喚醒。
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

/** D4（2026-10-02）：本會話最近 N 筆 run（運行中＋已完成，按時間倒序）。
 *  completed 記錄自 2026-10-02 起帶 parent 歸屬；舊記錄無 parent＝不列入（誠實：不假裝知道歸屬）。 */
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

/** D4：`latest` 別名 → 本會話最近一次 run 的 id（無記錄回 undefined）。 */
function resolveLatestRunId(parentKey: string): string | undefined {
  return recentRunsForParent(parentKey, 1)[0]?.id
}

/** POST /internal/subagent/status — body { session_id, subagent_id }。工具轮询取件。
 *  R6：async 派遣的主會話也可用同一端點主動查詢狀態（subagent_status 工具）。
 *  D4（2026-10-02）：支援 `latest` 別名；not_found 附最近 3 筆 run 供改用。 */
export async function handleSubagentStatus(req: Request): Promise<Response> {
  pruneCompleted()
  const body = (await req.json().catch(() => ({}))) as { session_id?: string; subagent_id?: string }
  let wantId = typeof body.subagent_id === "string" ? body.subagent_id.trim() : ""
  if (!wantId) {
    return Response.json(
      {
        ok: false,
        code: "missing_required_args",
        error: 'subagent_id 必填：可傳完整 run id、"latest"（本會話最近一次）或 label 前綴。示例：{"subagent_id":"latest"}',
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
    })
  }
  for (const run of byChildOc.values()) {
    if (run.id === wantId) {
      return Response.json({
        ok: true,
        done: false,
        // D4（2026-10-02）：回帶實際命中的 run id——`latest`／label 前綴查詢時，
        // 呼叫端必須知道解析到哪一個 run，否則拿到狀態卻無 id 可用。
        subagent_id: run.id,
        label: run.label,
        elapsed_ms: Date.now() - run.startedAt,
      })
    }
  }
  // 刀1（2026-09-20 百合番OP寶藏 PRD）：not_found ≠ 沒跑過——run 記錄會過期（completed
  // 清理/gateway 重啟），但 E 片落盤檔是持久的。按 run id 前 8 碼掃 outputs/subagent，
  // 命中即在 404 回應帶 artifact_path，orchestrator 直接驗收盤上檔案，不重派不空等
  // （實錘案例：裝配方案 23:19 落盤、喚醒丟失、用戶空等近 1 小時）。
  // 修 2（2026-10-02）：label 精確查詢——此前按 label 查在跑代理一律 not_found，
  // orchestrator 只能從 busy 拒絕訊息反推並發數並誤判批次失聯（重派造成重複生成）。
  // 完整 run id 已在上面精確命中；此處以 label 前綴比對：單筆回該 run、多筆回候選清單、
  // 僅真正零命中才落到 artifact/404。
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
      note: "label 前綴命中多筆，請用完整 runId 或更精確 label 重查。",
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
      note: "run 記錄已過期但產物已落盤：直接 read 上述路徑驗收，勿重派。",
    })
  }
  // D4（2026-10-02）：not_found 不再是一句死話——附最近 3 筆 run（id/狀態/label），
  // 讓 orchestrator 直接改用正確 id，或改傳 "latest"，而不是重派造成重複生成。
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
 * 0920 停止閘：orchestrator 的停止入口（/internal/subagent/stop）。
 * body { session_id, subagent_id?, all? }：
 *   - subagent_id 有值 → 停那一個（gateway run id 或 label 前綴）
 *   - 否則（或 all:true）→ 停該會話名下全部在跑子代理
 * 停止語義：標記 stopped → abort+DELETE 子會話 → 摘註冊表 → 不喚醒父會話。
 * 為何不喚醒：停止＝結束，喚醒會讓 orchestrator 又起一輪（可能再派新 subagent），
 * 正是用戶抱怨的「一出就刹不住車」。
 */
export async function handleSubagentStop(req: Request): Promise<Response> {
  pruneCompleted()
  const body = (await req.json().catch(() => ({}))) as { session_id?: string; subagent_id?: string; all?: boolean }
  const sid = body.session_id?.trim()
  if (!sid) return Response.json({ ok: false, code: "missing_required_args", error: "session_id 必填" }, { status: 400 })
  // session_id 接受 gateway id 或父 opencode id——與 status/dispatch 同語義。
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
 * D1（2026-10-02）：工具層重複呼叫斷路器的強制收尾端點。
 * 由 .opencode/plugin/eimu-guard.ts 在「同一 (session, tool, 正規化 args) 第 N+5 次」時呼叫：
 * 中止該會話當前生成並回灌一則系統說明。**輪詢類工具不觸發**（2026-10-02 使用者裁定：保留輪詢）。
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
      text: `检测到工具「${body.tool ?? "?"}」以完全相同参数重复调用 ${body.count ?? 0} 次，已强制结束本轮：请改变参数或停止该动作。`,
    })
  }
  console.warn(
    `[gateway] loop-breaker abort: session=${state?.sessionId ?? sid} tool=${body.tool ?? "?"} count=${body.count ?? 0} aborted=${Boolean(ocId)}`,
  )
  return Response.json({ ok: true, aborted: Boolean(ocId), session_id: state?.sessionId ?? sid })
}

/** 刀1：掃 outputs/subagent/<runId前8碼>-*.md，取最新一筆（同前綴理論唯一，兜底取 mtime 最大）。 */
function findPersistedArtifact(subagentId: string): { relPath: string; bytes: number; mtimeMs: number; status: string; label: string } | null {
  const prefix = subagentId.replace(/-/g, "").slice(0, 8)
  if (!/^[0-9a-f]{8}$/i.test(prefix)) return null
  try {
    const hits = readdirSync(SUBAGENT_OUTPUT_DIR)
      .filter((f) => f.startsWith(prefix))
      .map((f) => {
        const abs = join(SUBAGENT_OUTPUT_DIR, f)
        const st = statSync(abs)
        // 檔頭 meta 行是機器寫的（persistRunOutput），status/label 直接抽，不讀全文。
        const head = readFileSync(abs, "utf8").slice(0, 400)
        const status = /^- 状态: (.+)$/m.exec(head)?.[1]?.trim() ?? "unknown"
        const label = /^# (.+)$/m.exec(head)?.[1]?.trim() ?? ""
        return { relPath: `${SUBAGENT_OUTPUT_REL}/${f}`, bytes: st.size, mtimeMs: st.mtimeMs, status, label }
      })
      .sort((a, b) => b.mtimeMs - a.mtimeMs)
    return hits[0] ?? null
  } catch {
    return null // 目錄不可讀/不存在 → 維持原 404 行為（fail-open）
  }
}

// ── 刀 F（2026-09-15）：rework 鏈重啟存活——啟動掃描治理 in-flight rework 孤兒 ──────────
// 病灶：rework 在途時 gateway 被重啟（round3 13:03:37），SubagentRun/watchers 純記憶體隨舊
// 進程死亡 → 子 opencode 會話孤兒 RUNNING（算力白燒）、父會話永挂無 done/無 wake。
// 治法：startRework 落一條 subagent_reworks 記錄（child_oc 探針目標），finishRun 終態刪。
// 啟動時掃殘留記錄，探 opencode 子會話真況：
//   · 已完成 → 拉正文重跑閘門復檢，走既有 finishRun 正常鏈 done/wake（單終態守衛復用）。
//   · 仍 RUNNING 且 watcher 死 → **不幽靈續 watch**，按誠實路徑：finishRun(orphaned) 內部
//     abort+DELETE 子會話 + done delivery_gate.orphaned + 帶前綴 wake 父會話一次。
// 冪等：記錄終態即刪，殘留=真孤兒；wake 單次由 finishRun status 守衛 + wakeParent ackTimer
// 讓位保證，與正常鏈不雙 wake。

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
  }
}

interface ChildProbe {
  exists: boolean
  completed: boolean
  text: string
}

/** 探 opencode 子會話：HTTP 非 ok/404 → 不存在；取最後一條 assistant 的 completed 判終態、
 *  其 text parts 作正文。time.completed===null = turn 仍 RUNNING（對齊驗屍配方）。 */
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
    // 探測失敗（opencode 短暫不可達）保守回 exists:false，讓本輪先不處理——但呼叫端
    // 對 !exists 走孤兒誠實收尾。為避免 opencode 抖動誤殺，僅在明確 HTTP 非 ok 才標 !exists；
    // 網絡異常在此回 exists:true/completed:false（視為仍 RUNNING），下一輪重啟再評。
    return { exists: true, completed: false, text: "" }
  }
}

/** gateway 啟動一次性調用：治理 rework 孤兒（見上方註解塊）。 */
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
        // 已完成：拉正文走既有 finishRun（reworkCount>=1 → 不重派，PASS→reworked / FAIL→升級標記）。
        console.log(`[gateway] rework recovery: id=${run.id} child=${rec.childOc} 已完成 — 拉正文復檢閘門`)
        if (probe.text) finishRun(run, "ok", probe.text)
        else finishRun(run, "error", "", "子代理运行结束但没有产出文本")
      } else {
        // 仍 RUNNING 或子會話已消失：不續 watch，誠實收尾。finishRun 內部 abort+DELETE 子會話
        // （!exists 時 404 no-op）+ 單次 wake（error 路徑，wake「失败原因」帶前綴）。
        const why = probe.exists ? "仍 RUNNING 且 watcher 已死" : "子会话已不存在"
        console.error(`[gateway] rework recovery: id=${run.id} child=${rec.childOc} ${why} — abort+DELETE 誠實收尾`)
        run.orphaned = true
        finishRun(run, "error", "", `${ORPHANED_GATE_MARK} gateway 进程在重派途中重启，子会话未被续 watch；已按诚实路径终止（abort+DELETE），未复原交付结果。`)
      }
    } catch (e) {
      console.error(`[gateway] rework recovery failed: id=${rec.runId} child=${rec.childOc}`, e)
      deleteReworkRecord(rec.runId) // 處理異常也要清記錄，防下次啟動重複幽靈治理
    }
  }
}
