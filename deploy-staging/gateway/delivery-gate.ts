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

/** 单一 Expert 的交付契约（与 src/lib/expert-registry.ts deliverableContract 同形）。 */
export interface ExpertDeliveryContract {
  requiredFields: string[]
  qcSignatureRequired: boolean
}

export type DeliveryContracts = Record<string, ExpertDeliveryContract>

export interface DeliveryGateResult {
  /** true = 无契约可判 / 契约栏位齐；false = 有契约且缺栏位。 */
  ok: boolean
  /** 合同栏位中「在交付文本里找不到栏位名」的那些（已去重、保持契约顺序）。 */
  missing: string[]
  /** 人话理由（仅 ok:false 时给）。 */
  reason?: string
}

/** 契约档座标：与 subagent.ts 读 expert-ids.json 同目录（gateway/expert/）。 */
export const DELIVERY_CONTRACTS_FILE = "expert-delivery-contracts.json"

/** 收尾摘要/事件用的显式标记（前端与 Orchestrator 靠它肉眼可辨）。 */
export const DELIVERY_GATE_MARK = "【交付闸门·未达标】"

/** 片 D（2026-09-15）：机器化重派一次后复检仍 FAIL 的升级标记（区别于首轮未达标）。 */
export const REWORK_FAIL_MARK = "【交付闸门·重派后仍未达标】"

/**
 * 刀 F（2026-09-15）：gateway 重启把 in-flight rework run 遗成孤儿时，启动扫描走诚实路径
 * （abort+DELETE 孤儿子会话、done 带 delivery_gate.orphaned、wake 父会话一次），done/wake
 * 前缀挂此标记——让 orchestrator 拿到「进程中断未复原」的事实而非永挂，自行决定补派。
 */
export const ORPHANED_GATE_MARK = "【交付闸门·进程中断未复原】"

/**
 * 契约载入（模组载入时一次）。档不存在/坏掉 → 空契约 + 一行 warn（fail-open，见档头）。
 * 用 `import.meta.dir`（Bun）：gateway 进程 WorkingDirectory=/opt/agent-harness/gateway，
 * 本档与 expert/ 同层 → `${import.meta.dir}/expert/...` 与 subagent.ts 的 expert-ids.json
 * 读法完全一致（同一个雷：别用 process.cwd()，别用相对 ./expert）。
 */
function loadContractsAtImport(): DeliveryContracts {
  const file = `${import.meta.dir}/expert/${DELIVERY_CONTRACTS_FILE}`
  try {
    const parsed: unknown = JSON.parse(readFileSync(file, "utf8"))
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      console.warn(`[gateway] delivery gate: 契约档形状错误（非对象），契约视为空，全放行：${file}`)
      return {}
    }
    const out: DeliveryContracts = {}
    for (const [agent, raw] of Object.entries(parsed as Record<string, unknown>)) {
      const c = raw as Partial<ExpertDeliveryContract> | null
      if (!c || typeof c !== "object" || !Array.isArray(c.requiredFields)) {
        console.warn(`[gateway] delivery gate: 契约档条目形状错误，跳过该 Expert：agent=${agent}`)
        continue
      }
      out[agent] = {
        requiredFields: c.requiredFields.filter((f): f is string => typeof f === "string" && f.length > 0),
        qcSignatureRequired: c.qcSignatureRequired === true,
      }
    }
    console.log(
      `[gateway] delivery gate: 契约已载入 ${Object.keys(out).length} 个 Expert（${file}）`,
    )
    return out
  } catch (e) {
    const code = (e as { code?: string })?.code
    const why = code === "ENOENT" ? "档不存在" : e instanceof Error ? e.message : String(e)
    // 一行 warn，不抛：契约缺档不得把整条子代理收尾链卡死（档头 fail-open 取舍）。
    console.warn(`[gateway] delivery gate: 契约档不可读（${why}），契约视为空，全放行：${file}`)
    return {}
  }
}

/** 模组载入即读（module-load 快照；换契约档须重启 gateway 才生效，同 expert-ids.json 语义）。 */
export const DELIVERY_CONTRACTS: DeliveryContracts = loadContractsAtImport()

/**
 * 纯函数：判定某次 Expert 交付是否满足其契约栏位。
 * @param agent     run.agent（expert id）；undefined/空字串 = 非 Expert 派工 → 放行。
 * @param text      交付文本（**未截断全文**，不是 600 字摘要——摘要会把栏位切掉变假阴性）。
 * @param contracts 契约表（注入式，便于单测；生产传 DELIVERY_CONTRACTS）。
 */
export function checkDelivery(
  agent: string | undefined,
  text: string,
  contracts: DeliveryContracts,
): DeliveryGateResult {
  // 非 Expert / 未登记 → 零回归放行。
  if (!agent || typeof agent !== "string") return { ok: true, missing: [] }
  const contract = contracts[agent]
  if (!contract) return { ok: true, missing: [] }

  // 栏位名大小写正规化后子字串命中。toLowerCase 对 CJK 是恒等（中文标签不受影响），
  // 故契约栏位若写中文标签也照样子字串可比。
  const haystack = (typeof text === "string" ? text : "").toLowerCase()
  const missing: string[] = []
  const push = (f: string) => {
    if (!missing.includes(f)) missing.push(f)
  }
  for (const field of contract.requiredFields) {
    if (!haystack.includes(field.toLowerCase())) push(field)
  }
  // qcSignatureRequired：签名要求是独立条款——即使 requiredFields 没列 qc，也要求 qc 栏位名在场。
  if (contract.qcSignatureRequired && !missing.includes("qc") && !haystack.includes("qc")) {
    push("qc")
  }
  if (missing.length === 0) return { ok: true, missing: [] }
  const total = contract.requiredFields.length + (contract.qcSignatureRequired && !contract.requiredFields.includes("qc") ? 1 : 0)
  const delivered = total - missing.length
  return {
    ok: false,
    missing,
    reason: `缺少契约栏位：${missing.join("、")}（该 Expert 交付契约要求 ${total} 栏，实到 ${delivered} 栏）。此交付物视为未完整，请勿直接放行。`,
  }
}

/**
 * 组收尾前缀（人话、可肉眼辨识、带 missing 与栏位计数）。
 * 纯字串拼装，不碰 status 语义（status 恒为呼叫端给的 ok/error）。
 */
export function formatDeliveryGateNotice(
  agent: string,
  result: DeliveryGateResult,
  contracts: DeliveryContracts,
  mark: string = DELIVERY_GATE_MARK,
): string {
  const c = contracts[agent]
  const total = c
    ? c.requiredFields.length + (c.qcSignatureRequired && !c.requiredFields.includes("qc") ? 1 : 0)
    : result.missing.length
  const delivered = Math.max(total - result.missing.length, 0)
  return `${mark}缺少契约栏位：${result.missing.join("、")}（该 Expert 交付契约要求 ${total} 栏，实到 ${delivered} 栏）。此交付物视为未完整，请勿直接放行。`
}

/**
 * 刀 G（2026-09-15）：契约栏**机器注入**。病灶＝round3 首派 3/3 spec 未抄契约栏
 * （playbook 第 19 条对 orchestrator 零渗透），全靠闸门重派兜底＝每次白烧一倍成本。
 * 修法＝不再「期待」子代理服从 prompt 里手抄的栏位条款，而是在 dispatch 建立 Expert
 * run 时，把其契约栏清单作为**固定段**追加到子代理 prompt 尾部——真源单一（复用已载入
 * 的 DELIVERY_CONTRACTS，禁手抄第二份）。纯函数：非 contracts agent / 空 agent → 回
 * 空字串（调用端据此零注入，非 Expert 零回归）。
 */
export function renderContractDirective(
  agent: string | undefined,
  contracts: DeliveryContracts,
): string {
  if (!agent || typeof agent !== "string") return ""
  const c = contracts[agent]
  if (!c || !Array.isArray(c.requiredFields)) return ""
  const fields = c.requiredFields.slice()
  if (c.qcSignatureRequired && !fields.includes("qc")) fields.push("qc")
  const fieldList = fields.join(",")
  return `\n\n【交付契约·系统注入】本次交付正文必须逐字出现以下栏位名并各带实质内容（缺整栏＝未交付，系统闸门将逐栏核对）：${fieldList}。栏位名为硬匹配，措辞不得同义替换；无真实产物的栏位必须写 FAILED＋原因，禁止以占位文字冒充交付。`
}

/**
 * 刀 2（2026-09-15，gateway 手术片）：machine critic pass —— 不叫模型派，gateway 自己派。
 *
 * 病灶（四轮实录）：playbook 第 18 条「必须派 critic」四轮均在场，orchestrator 四轮零派遣
 * （r2 软条款 → r3b「未启用」藉口＋自签承诺 → r3c 配置已翻正、条款逐请求注入，11 段推理
 * critic/审核/review 零命中，逐字「I won't re-dispatch anything…synthesis is my job」）。
 * 纯 prompt 路线已证死 → 在父会话收盘判定点由 gateway 直接派遣。
 *
 * 本段只放**纯函数**（触发判据 + spec 组装 + verdict 判读）；派遣 / 旗标 / 唤醒 / 重派
 * 全部复用既有轮子（subagent.ts dispatchAttempt+startRework、wakeSessionForSubagent、
 * persistence.ts bun:sqlite 同款表惯例），禁自造第二套派遣或轮询。
 */

/** 机器 critic pass 的固定标记（journal/spec 留痕用，不作为前端文案前缀）。 */
export const CRITIC_PASS_MARK = "【独立审核·机器派遣】"

/** critic 判「退回」时唤醒父会话摘要的前缀（orchestrator 一眼辨识判决方向）。 */
export const CRITIC_REJECT_MARK = "【独立审核·退回】"

/**
 * 逃逸阀字样：最终文本自行声明「未经独立审核」→ 本次不触发机器 pass。
 * （playbook 第一节末：critic 派遣本身失败时允许自签兜底，且回覆须注明此字样。）
 */
export const CRITIC_UNREVIEWED_DECL = "未经独立审核"

/** 逃生阀字样（简体镜像）：模型输出以简体为主，两种写法都算声明。 */
export const CRITIC_UNREVIEWED_DECL_SIMP = "未经独立审核"

/** 每会话每次 pass 最多送审份数（有界，防 prompt 爆炸）。 */
export const CRITIC_PASS_MAX_TARGETS = 8
/** 单份被审交付内嵌进 critic prompt 的字元上限（超出截断且显式标记，critic 不得越界下判）。 */
export const CRITIC_PASS_PER_TARGET_CHARS = 6000
/** 全部被审交付内嵌字元总上限。 */
export const CRITIC_PASS_TOTAL_CHARS = 24000

/** 被审交付（由 subagent.ts finishRun 在 Expert 终态时登记）。 */
export interface CriticPassTarget {
  /** 被审 Expert id（DELIVERY_CONTRACTS 域内；critic 自身永不入列）。 */
  agent: string
  label: string
  runId: string
  /** 交付正文（finishRun 手上就是未截断全文）。 */
  text: string
}

/**
 * 触发判据输入（全部为真才触发；纯函数便于四态单测）。
 * 语义钉死：任一为假 → 回 false，呼叫端零动作（零回归）。
 */
export interface CriticPassInput {
  /** 父会话 beast_mode（MOE Expert 链的前提）。 */
  beastMode: boolean
  /** 待审份数（本窗口内契约域内已完成、且尚未送审的 Expert 交付）。 */
  expertDeliveries: number
  /** 本轮是否已有 critic 派遣（含在途）。 */
  criticDispatched: boolean
  /** 最终文本是否自行声明「未经独立审核」。 */
  unreviewedDeclared: boolean
  /** 该会话是否已用过本 pass（持久旗标，每会话 ≤1 次）。 */
  alreadyPassed: boolean
}

/**
 * 纯函数：收盘判定点是否该触发一次机器 critic pass。
 * 五个前置条件全部成立才 true：非 beast / 无 Expert 交付 / 已有 critic 派遣 /
 * 已声明未经审核 / 已用过 pass —— 任一即 false（零动作，零回归）。
 */
export function shouldTriggerCriticPass(input: CriticPassInput): boolean {
  if (input.beastMode !== true) return false
  if (!(input.expertDeliveries > 0)) return false
  if (input.criticDispatched === true) return false
  if (input.unreviewedDeclared === true) return false
  if (input.alreadyPassed === true) return false
  return true
}

/**
 * 纯函数：文字片段是否出现「未经独立审核」声明。
 * 跨 chunk 边界安全：呼叫端维持尾巴 16 字，本函数吃 (tail + delta)。
 */
export function declaresUnreviewed(tailAndDelta: string): boolean {
  if (typeof tailAndDelta !== "string") return false
  return tailAndDelta.includes(CRITIC_UNREVIEWED_DECL) || tailAndDelta.includes(CRITIC_UNREVIEWED_DECL_SIMP)
}

/** 契约栏清单（含 qcSignatureRequired 补栏）——与 checkDelivery 同口径，禁第二份清单。 */
function contractFieldsOf(agent: string, contracts: DeliveryContracts): string[] {
  const c = contracts[agent]
  if (!c) return []
  const fields = c.requiredFields.slice()
  if (c.qcSignatureRequired && !fields.includes("qc")) fields.push("qc")
  return fields
}

/**
 * 纯函数：组 machine critic pass 的 critic spec。
 * = 固定审核指令（逐栏核验值是否空壳／跨档一致性／引用真伪／四栏输出）
 * + 逐份（Expert id / label / 该 Expert 契约栏清单 / 交付正文）。
 * 契约栏真源 = 传入 contracts（生产传 DELIVERY_CONTRACTS，禁手抄第二份）。
 * 空 targets → 回空字串（呼叫端据此零派遣）。
 */
export function buildCriticPassSpec(
  targets: CriticPassTarget[],
  contracts: DeliveryContracts,
): string {
  if (!Array.isArray(targets) || targets.length === 0) return ""
  const head = [
    `${CRITIC_PASS_MARK}你被**系统直接派遣**（不经 orchestrator 决策）做一次独立审核。`,
    "",
    "【审核对象】以下交付物已由对应 Expert 宣告完成、且已过交付闸门的**栏位存在性**检查；该闸门只验栏位名在场，不验值。你的职权就是补上这一段：逐栏核验值是否为空壳。",
    "",
    "【必做核验】",
    "1. 逐栏核验：对每份交付，逐一检查其契约栏位的**值**是否实质。栏名在场但值为占位文字、借口（如「无 demo」「待补」「N/A」「未生成」「同上」却仍宣称完成）、复述栏名本身、或空字串 → 逐项列出为空壳并列入 issues。",
    "2. 跨档一致性：交付物 A 引用交付物 B 的声称，必须在 B 的正文中可回溯；对不上即列入 issues。",
    "3. 引用真伪：正文中的数字/路径/ID 若无可复算算式或可回溯指针，标为未证实，不得升格为事实。",
    "4. 证据分级：事实／推断／未证实分开记帐。",
    "",
    "【输出契约（硬性）】回复正文必须逐字出现并带实质内容的四栏：",
    "verdict：只接受两种值之一 ——「通过」或「退回」。",
    "issues：逐条列出问题；判「退回」时**必须指名是哪份交付的哪个栏位**、问题为何。通过时可为空阵列，但键必须在场。",
    "evidence：你的核验过程与指针（引用交付正文原文片段佐证）。",
    "qc：自检结论 + 签名。",
    "",
    "被审正文若标记「已截断」，你只能就所见部分下判，不得对截断外内容断言。你只审不产：禁止改写或补产被审内容。",
    "",
    `【被审交付共 ${targets.length} 份】`,
  ].join("\n")

  const blocks: string[] = []
  let used = 0
  for (const t of targets) {
    const fields = contractFieldsOf(t.agent, contracts)
    const budget = Math.min(CRITIC_PASS_PER_TARGET_CHARS, Math.max(0, CRITIC_PASS_TOTAL_CHARS - used))
    const raw = typeof t.text === "string" ? t.text : ""
    const cut = raw.length > budget
    const body = cut
      ? `${raw.slice(0, budget)}\n…（已截断：本份交付正文共 ${raw.length} 字，仅前 ${budget} 字送审）`
      : raw
    used += body.length
    blocks.push(
      [
        "",
        `── 交付 ${blocks.length + 1} ──`,
        `Expert: ${t.agent}`,
        `label: ${t.label}`,
        `runId: ${t.runId}`,
        fields.length > 0
          ? `该 Expert 交付契约栏位（真源 DELIVERY_CONTRACTS，共 ${fields.length} 栏）：${fields.join("、")}`
          : "该 Expert 交付契约栏位：未登记（按正文自述核对）",
        "交付正文：",
        body || "（正文为空）",
      ].join("\n"),
    )
  }
  return `${head}\n${blocks.join("\n")}`
}

const CRITIC_REJECT_WORDS = ["退回", "驳回", "驳回", "不通过", "不通过", "未通过", "未通过", "reject", "rejected"]
const CRITIC_PASS_WORDS = ["通过", "通过", "pass", "approve", "accept", "approved"]

/**
 * 纯函数：critic 交付正文的 verdict 判读。
 * 取 `verdict` 栏后紧跟片段（无则取开头 400 字）找驳回/通过词。
 * **保守方向**：无正文或判不出 → 视为退回（宁可多一次唤醒，不吞掉问题）。
 */
export function criticVerdictRejected(text: string): boolean {
  const src = typeof text === "string" ? text : ""
  if (!src.trim()) return true
  const m = /verdict[\s:：>*-]*([^\n]{0,80})/i.exec(src)
  const head = (m ? m[1] : src.slice(0, 400)).toLowerCase()
  if (CRITIC_REJECT_WORDS.some((w) => head.includes(w.toLowerCase()))) return true
  return !CRITIC_PASS_WORDS.some((w) => head.includes(w.toLowerCase()))
}

// ─────────────────────────────────────────────────────────────────────────
// 「评审可计量」数值阈值政策（v3，2026-10-03）
//
// 病灶：critic 闸门此前只有布林（criticVerdictRejected 词表判读）——「verdict<7 必返工」
// 只住在 messages-gw.ts 的提示词里，代码内零数值强制；critic_verdicts.score 恒 NULL；
// 与人工接受/拒绝无 join。本节把「阈值」搬进代码，并钉死它只对**独立量测**生效。
//
// 红线（禁同源断言）：模型自评（model_self）是「同族模型评自己」，不是验收 oracle；
// 数值阈值只在 scoreSource==='measured'（存在独立于被测模型的量测来源）时 enforce。
// 人工标签（human）另存 human_labels，是外生 label，不是数值量测，亦不套用本阈值。
// 没有分数 → 不 enforce（维持 null 的诚实状态，不得填 0 假值充数）。
// ─────────────────────────────────────────────────────────────────────────

/** 集中可调的阈值政策（唯一真源；改口径只改这里）。 */
export interface CriticScoreThresholdPolicy {
  /** 分数低于此值 → 判定必须返工（条件为 value < reworkBelow，边界值本身通过）。 */
  reworkBelow: number
  /** 唯一可被阈值约束的来源；其余来源只记录、不 enforce。 */
  enforcedSource: CriticScoreSource
}

/** 预设政策：对齐 messages-gw.ts 提示词「verdict<7 必返工」，且只对 measured 生效。 */
export const CRITIC_SCORE_THRESHOLD_POLICY: CriticScoreThresholdPolicy = {
  reworkBelow: 7,
  enforcedSource: "measured",
}

/**
 * 一条 critic 分数样本。值与来源**始终绑定在一个物件**内，避免「拿掉来源后把自评当量测」。
 * 无量测时 value/source 皆为 null（诚实状态）。
 */
export interface CriticScoreSample {
  value: number | null
  source: CriticScoreSource | null
}

/**
 * 纯函数：数值阈值的**代码强制**判定。回 { enforce, reason }。
 * enforce=true 仅当三个条件同时成立：有有限数值、source===policy.enforcedSource、value<reworkBelow。
 * 其余一律 false（无分数／来源不符／已达标），并给人话 reason 说明为何未强制（可审计）。
 */
export function evaluateCriticScoreThreshold(
  score: CriticScoreSample,
  policy: CriticScoreThresholdPolicy = CRITIC_SCORE_THRESHOLD_POLICY,
): { enforce: boolean; reason: string } {
  const value = typeof score?.value === "number" && Number.isFinite(score.value) ? score.value : null
  const source = score?.source ?? null
  if (value === null) {
    return { enforce: false, reason: "无分数样本（score 为 null），不套用数值阈值。" }
  }
  if (source !== policy.enforcedSource) {
    return {
      enforce: false,
      reason: `分数来源=${source ?? "null"}，非 ${policy.enforcedSource}——模型自评/人工标签不构成验收 oracle，不强制返工。`,
    }
  }
  if (value < policy.reworkBelow) {
    return { enforce: true, reason: `量测分数 ${value} < ${policy.reworkBelow}，代码强制返工。` }
  }
  return { enforce: false, reason: `量测分数 ${value} ≥ ${policy.reworkBelow}，通过数值阈值。` }
}

/**
 * 片 D（2026-09-15）：闸门 FAIL→重派时注入任务书尾部的系统性修正指令。
 * 纯字符串拼装（便于单测）：逐字点名缺失栏位 + 机器可比对判据；「其余任务内容
 * 原样带过去」由调用端（subagent.ts startRework）保证——本指令是**追加**，不替换原文。
 */
export function buildReworkDirective(
  agent: string,
  result: DeliveryGateResult,
  contracts: DeliveryContracts,
): string {
  const c = contracts[agent]
  const fields = c ? c.requiredFields.slice() : result.missing.slice()
  const total = c
    ? c.requiredFields.length + (c.qcSignatureRequired && !c.requiredFields.includes("qc") ? 1 : 0)
    : result.missing.length
  const fieldList = fields.join("、") + (c && c.qcSignatureRequired && !fields.includes("qc") ? "、qc" : "")
  return [
    "【系统修正指令·自动重派（上限 1 次，本次为第 1 次）】",
    `上一轮交付缺少契约栏位：${result.missing.join("、")}。这些栏位必须在交付正文中以可机器匹配的形式出现（栏位名原样出现＋实质内容，缺整栏＝未交付）。`,
    `该 Expert（${agent}）交付契约共 ${total} 栏：${fieldList}。`,
    "本次为同一任务的修正重派：原任务内容与其余要求全部保持不变，请在上一轮交付基础上补齐上述缺失栏位，重新交付完整结果。",
  ].join("\n")
}
