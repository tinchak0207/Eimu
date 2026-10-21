/**
 * delivery-gate.ts — Expert 交付契约的**机器强制点**（片 C，2026-09-15）。
 *
 * 病灶（R8 审计实锤，09-10）：7 个 Expert 的 `*_DELIVERABLES` 契约只写在 prompt/digest 里，
 * gateway 全域 grep `requiredFields`/`qcSignatureRequired`/`deliverableContract` **零命中**
 * ——契约无任何执行点。09-15 实案：music 域契约要求 5 栏，`audio_url` 是空的（无 demo），
 * 收尾路径照样 `status:"ok"` 放行，Orchestrator 直接标「部分成功」。
 *
 * ─────────────────────────────────────────────────────────────────────────
 * 【本闸门的边界：这是「栏位存在性」检查，不是「品质」检查】
 *
 * 判据 = 契约 requiredFields 的**栏位名**是否在交付文本中出现（大小写正规化后子字串命中）。
 * 它**不**验证：
 *   - 值的正确性（`audio_url` 写了个 404 的连结照样过闸）；
 *   - 值的完整度/长度（`lyrics: ""` 也算命中）；
 *   - 品质、审美、是否符合 TaskType 意图。
 * 因此**不得**把本闸门宣称为「品质闸门」或「验收通过」。它的作用是：
 * 把「契约栏位整栏缺失」这种**可机械判定**的漏交付变成可见的显式标记，
 * 让收尾摘要不再能若无其事地标 ok。品质判定仍属 critic/Expert 职权。
 * ─────────────────────────────────────────────────────────────────────────
 *
 * 【fail-open 取舍】契约档不存在 → 契约视为空 → 全放行（仅 console.warn 一行）。
 * 理由：本模组在 gateway 启动时载入，若因部署顺序（新代码先于契约档落位）或缺档就
 * 判定「全部 Expert 交付未达标」，等于把整条生产链卡死——一个新档没部署不该有这种
 * 爆炸半径。契约档坏掉同理（JSON 解析失败 = 空契约），但一律留 warn 证据，不静默。
 *
 * 【非 Expert 零回归】agent 为 undefined 或不在 contracts → 直接 {ok:true}。
 * 通用子代理（label/prompt/async 三栏派工、不带 expert）完全不受本闸门影响。
 */

import { readFileSync } from "node:fs"
// 「评审可计量」（v3，2026-10-03）：分数来源型别的真源在 persistence.ts（栏位所在）。type-only
// import 在编译期即被抹除，不会把 persistence 的执行期模组（bun:sqlite）拉进本纯函数模组。
import type { CriticScoreSource } from "./persistence.ts"
// 2026-10-04（内审剧场拆除片 F3-B）：成品证据判定复用既有媒体 URL 抽取轮子
// （media-quality.extractMediaTargets，副档名口径与 events-translate 同源），不造第二份副档名表。
// 该模组只依赖 node 内建（child_process/fs/os/path），不含 bun:sqlite，不会把本纯函数模组拖进 DB runtime。
import { extractMediaTargets } from "./media-quality.ts"

export type { ExpertDeliveryContract, DeliveryContracts, DeliveryGateResult, ArtifactVerifyRecord, CriticPassTarget, CriticPassInput } from "./delivery-gate-types.ts"
export { DELIVERY_CONTRACTS_FILE, DELIVERY_GATE_MARK, REWORK_FAIL_MARK, ORPHANED_GATE_MARK, ARTIFACT_VERIFY_BLOCKED_MARK, DELIVERY_CONTRACTS, checkDelivery, formatDeliveryGateNotice, renderContractDirective, buildReworkDirective } from "./delivery-gate-contracts.ts"
export { CRITIC_PASS_MARK, CRITIC_REJECT_MARK, CRITIC_UNREVIEWED_DECL, CRITIC_UNREVIEWED_DECL_SIMP, CRITIC_PASS_MAX_TARGETS, CRITIC_PASS_PER_TARGET_CHARS, CRITIC_PASS_TOTAL_CHARS, shouldTriggerCriticPass, declaresUnreviewed, hasRealDeliverable, countDeliverableEvidence, buildCriticPassSpec, VIDEO_MOTION_RECEIPT_POLICY, checkCriticReceipt, criticVerdictRejected, CRITIC_SCORE_THRESHOLD_POLICY, evaluateCriticScoreThreshold } from "./delivery-gate-critic.ts"
export type { CriticScoreThresholdPolicy, CriticScoreSample } from "./delivery-gate-critic.ts"
export { classifyInternalReviewPayload, scrubVisibleProse, scrubSubagentPayload, scrubVisibleFrame } from "./delivery-gate-scrub.ts"
