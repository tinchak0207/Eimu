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

import { chmodSync, mkdirSync, readFileSync, writeFileSync, readdirSync, statSync, existsSync } from "node:fs"
import { join, resolve, sep } from "node:path"
// 用户面 peek 子代理：追加式 JSONL 转录（与 live .md 日志并存，不改其语义）。
import { appendTranscript, getTranscriptInfo, initTranscript } from "./subagent-transcript.ts"
// 刀 2B/刀 3（2026-09-19）：Jev 权威闸——spec 注入隔离＋expert 路由＋sync 资格。
// 量级瘦身 A：spec 模板机器注入（playbook 2.0 起模板不进 orchestrator 上下文）。
import { guardExpertContent, musicFirstBlockReason, lyricsFirstBlockReason, isReworkSpec, reworkLockDirective, quarantineSpec, routeExpertAuthoritative, syncDispatchEligible, classifyDispatchMeta, classifyDispatchGuards, workflowTemplateDirective, isPlanOnlyNoGenerationIntent, type JevDispatchGuards } from "./jev-gate"
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
import { billingAutoApprovalEnabled } from "./charge-approval-policy.ts"
import { notify, waitFor, parseWaitMs } from "./internal-waiters.ts"
// 协作总线：派遣成功即登记 worker 为 mailbox 团队成员（只登记，不参与编排）。
import { registerTeamMember, removeTeamMember } from "./agent-mailbox.ts"
// FIX-A（2026-10-02）：子代理工具结果的媒体成品出卡——共用主路径的成品 URL 提取器与
// emitVideoDone/emitAudioDone（不另造第二套）。events-translate↔sessions-core↔subagent 的
// 循环与 canvas-cascade-state↔subagent 同型，两端均在呼叫期使用绑定，bun ESM 循环安全。
import { parseToolOutput, collectToolOutputMediaUrls, emitVideoDone, emitAudioDone, attachCanvasTask } from "./events-translate.ts"
import { bindGenerationConsumer, generationParent, saveDurableSubagentRun, durableSubagentRun, durableSubagentRuns, acknowledgeDurableSubagentRun } from "./job-store"
import { currentKernelFingerprint, decideKernelResume } from "./agent-kernel.ts"
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
  checkCriticReceipt,
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
  type ArtifactVerifyRecord,
  type CriticScoreSample,
  type DeliveryGateResult,
  type CriticPassTarget,
} from "./delivery-gate"
// P1-3 接线：交付闸消费 artifact store 的 verify 状态（blocked 拒绝、no_row 保持原行为）。
import { listArtifacts, artifactLocalEvidenceMatches } from "./artifact-store.ts"
import { isMultiStepAvProductionIntent } from "./canvas-write-gate.ts"
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
  loadSessionDeliveries,
  type ReworkRecord,
} from "./persistence"
// 2026-10-03：事后产物硬检（确定性量测；gateway 侧移植，见 media-quality.ts 档头）。
// 只回技术分（非审美）；量测失败一律 null，绝不让交付主流程受阻。
import { measureMediaScore, MEDIA_QUALITY_MEASURED_MARK, type MeasuredMediaResult } from "./media-quality.ts"
// CC 2.1.302 移植（2026-10-18）：fork／worker 硬规则／name／effort／深度闸的纯策略。
// 本档零 gateway 内部依赖，避免扩大 subagent↔sessions-core 的既有 ESM 循环。
import {
  WORKER_HARD_RULES,
  FORK_HARD_RULES,
  FORK_STARTED_NOTICE,
  buildForkDirective,
  validateSubagentName,
  forkNameFromLabel,
  normalizeEffort,
  effortVariant,
  stripAuthorizationSection,
  shouldRetryWithoutVariant,
  computeSubagentUsage,
  runMessageWindow,
  messagesInWindow,
  type MessageWindow,
  type SubagentUsageMessage,
  subagentMaxDepth,
  agentNestingDepth,
  depthLimitMessage,
  parseSubagentModel,
  type SubagentEffort,
} from "./subagent-policy.ts"
// CC 2.1.302 SubagentStart/SubagentStop hook（2026-10-18 接线）。
// fire-and-forget：hook 失败只进日志，绝不影响派遣/收尾。
import { runHooksWithBudget } from "./hooks-http.ts"
// 会话活性时钟（2026-10-18）：把 byParent 的只读计数注册给重启接管判断用，
// 避免「父回合静默但子代理还在跑」被误判为死回合。
import { setLiveChildCounter } from "./session-activity.ts"
// P2b（2026-09-11）刀1：任务书首行自动补「预期 N 分钟」死线行。
// 任何派遣若首行没有「预期 N」，补上 5 分钟 → R1 parseSyncDeadlineMs 得
// min(2*5,4)=4 分钟 = 240s 同步硬死线，主会话不再被无死线子代理长期锁住。
// 已自带「预期/预期 N」的任务书原样不动（避免双补）。
export type { RunLivenessInput, RunLivenessVerdict, SubagentUsage, SubagentCheckpoint, SubagentSuspension, TypedArtifact, ScratchpadEntry, PublicSubagentRun } from "./subagent-types.ts"
export { SUBAGENT_SUMMARY_MAX_CHARS, safeCheckpointToken, resolveCheckpointFile, SUBAGENT_BUSY_MESSAGE, SUBAGENT_UNTRUSTED_PREFIX, evaluateRunLiveness } from "./subagent-types.ts"
export { initSubagent, subagentHandlesSession, subagentMailboxMemberName, subagentParentApiKey, subagentParentState, stopSubagentRun, stopSubagentsForParent, findRunningRun } from "./subagent-runs.ts"
export { criticScoreEnforcementEnabled, shouldForceCriticRejectByScore, emitRunningSubagentsStatus } from "./subagent-finish.ts"
export { buildExpertSkillFact } from "./subagent-attempt.ts"
export { handleSubagentEvent, hasWorkflowCriticReview, enqueueWorkflowCriticReview, maybeRunMachineCriticPass, runGoalEvaluator, forgetCriticPassState, forgetSessionWorkspaceState, snapshotPendingCriticTargets } from "./subagent-events.ts"
export { handleSubagentDispatch } from "./subagent-dispatch.ts"
export { handleSubagentStatus, handleSubagentStop } from "./subagent-status.ts"
export { listLiveSubagentRuns, stopLiveSubagentRun, renderSubagentNoteWakeContent, renderSubagentNoteQueueBlock, composeSubagentWakeInjection } from "./subagent-live.ts"
export { forkResultDeliveryTarget, handleSubagentMessage } from "./subagent-messages.ts"
export { handleSubagentNotify, handleSubagentAskParent, handleSubagentCheckpoint, handleSubagentScratchpad, handleSubagentArtifact } from "./subagent-inbox.ts"
export { checkPendingResumeQueue, handleSubagentSuspend, handleSubagentResume, handleLoopBreaker } from "./subagent-suspend.ts"
export { recoverReworkRunsOnStartup } from "./subagent-recover.ts"
