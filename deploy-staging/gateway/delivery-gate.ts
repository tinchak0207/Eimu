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
 * Artifact 验证闸（P2-5 接线）：交付涉及已落库 artifact 时，外链必须 verified；
 * 无外链本地文件必须有当前安全读取/hash 匹配证据。调用端不传记录（或记录为空）时保持原行为，不误杀。
 */
export const ARTIFACT_VERIFY_BLOCKED_MARK = "【交付闸门·产物验证未通过】"

export interface ArtifactVerifyRecord {
  name: string
  verify_status?: string | null
  url?: string | null
  /** 仅无 URL 且当前安全读取的 hash/bytes 与登记值一致时为 true。 */
  local_available?: boolean
}

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
  artifactVerify?: ReadonlyArray<ArtifactVerifyRecord> | null,
): DeliveryGateResult {
  // 外链未 verified 或本地证据不可用时拒绝；完全无记录沿用历史行为。
  const blocked = (artifactVerify ?? [])
    .filter((record) => record && (record.verify_status === "blocked" ||
      (record.url === null ? record.local_available !== true : record.verify_status !== "verified")))
    .map((record) => record.name)
  // 非 Expert / 未登记 → 零回归放行（除非有 blocked artifact）。
  if (!agent || typeof agent !== "string") {
    return blocked.length === 0
      ? { ok: true, missing: [] }
      : {
          ok: false,
          missing: blocked.map((name) => `artifact:${name}:verify_blocked`),
          reason: `${ARTIFACT_VERIFY_BLOCKED_MARK} artifact 尚无可用交付证据：${blocked.join("、")}。此交付物不得放行。`,
        }
  }
  const contract = contracts[agent]
  if (!contract) {
    return blocked.length === 0
      ? { ok: true, missing: [] }
      : {
          ok: false,
          missing: blocked.map((name) => `artifact:${name}:verify_blocked`),
          reason: `${ARTIFACT_VERIFY_BLOCKED_MARK} artifact 尚无可用交付证据：${blocked.join("、")}。此交付物不得放行。`,
        }
  }

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
  if (blocked.length > 0) {
    for (const name of blocked) push(`artifact:${name}:verify_blocked`)
    return {
      ok: false,
      missing,
      reason: `${ARTIFACT_VERIFY_BLOCKED_MARK} artifact 尚无可用交付证据：${blocked.join("、")}。此交付物不得放行。`,
    }
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
  if (result.missing.some((field) => field.startsWith("artifact:"))) {
    return `${mark}${result.reason?.replace(ARTIFACT_VERIFY_BLOCKED_MARK, "") || "产物缺少可用交付证据，请重新验证。"}`
  }
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
  return `\n\n【交付契约·系统注入】本次交付正文必须逐字出现以下栏位名并各带实质内容（缺整栏＝未交付，系统闸门将逐栏核对）：${fieldList}。最终返回单个顶层JSON，键就是上述字段，字段值可用自然语说明；不要再造另一份最终格式。过程工具回执保持原样。qc写制作自查与独立审阅证据的覆盖范围，不能自证质量；无真实产物的字段明确失败与原因。系统字段存在性检查不等于独立质量验收。`
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
  /** Captured from this author's actual successful output receipts, not authored prose. */
  artifacts?: string[]
  /** Actual generation input / server workflow parameters, never the author's review prose. */
  mediaIntent?: Array<{ artifact: string; prompt?: string; camera?: unknown; durationSeconds?: number; sourceCallId?: string }>
  workflowReview?: { workflowId: string; nodeId: string; artifact: string }
  onReview?: (result: { state: "passed" | "failed" | "partial"; criticRunId: string; receipt: unknown }) => void
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
  /**
   * 其中带**真实成品证据**（交付正文含真实媒体 URL）的份数（2026-10-04 F3-B）。
   * 缺省 undefined ＝ 呼叫端未提供（退回旧行为）；提供时须 >0 才可能触发——
   * probe／报告类交付（无成品 URL）一律不进入成品契约内审。
   */
  deliverableEvidence?: number
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
  // 2026-10-04 F3-B：有 Expert 交付 ≠ 有成品。无真实媒体产物的交付（probe／报告／空壳）
  // 不得触发成品契约内审；呼叫端有提供证据计数时，0 份成品即一票否决。
  if (input.deliverableEvidence !== undefined && !(input.deliverableEvidence > 0)) return false
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
 * 2026-10-04（F3-B）：该交付正文是否带**真实成品证据**——正文含至少一个可量测的媒体 URL
 * （audio_url／image/video 产物；判定复用 media-quality.extractMediaTargets 的既有副档名口径）。
 *
 * 病灶（eval-music-r2/EVAL-A-text.md 第四节 A/三·A）：一张「先不要生成，只做通路体检」的
 * 免费单被成品契约内审判「退回」，触发 4 路返工 + ~15 万 token，全程 0 成品。根因＝触发判据
 * 只看「有 Expert 交付」，不看「有没有真产物」。本函式把「成品」钉死为可机械判定的媒体 URL。
 */
export function hasRealDeliverable(text: unknown): boolean {
  const s = typeof text === "string" ? text : ""
  if (!s) return false
  // 既有轮子 URL_RE 的全形边界只挡「，。、;；」，不挡「（）」；实测成品行常写成
  // `…onq516.m4a（60.000 秒）`——URL 尾巴吞进全形括号导致副档名判定失败（真成品被漏判）。
  // 先把紧贴的全形括号隔离成空格，再喂既有轮子（不另造副档名表）。
  return extractMediaTargets(s.replace(/[（）【】「」《》]/g, (m) => ` ${m} `)).length > 0
}

/** 2026-10-04（F3-B）：待审清单里带真实成品证据的份数（shouldTriggerCriticPass 的输入来源）。 */
export function countDeliverableEvidence(targets: CriticPassTarget[]): number {
  if (!Array.isArray(targets)) return 0
  let n = 0
  for (const t of targets) if (hasRealDeliverable(t?.text)) n++
  return n
}

/**
 * 纯函数：组 machine critic pass 的 critic spec。
 * = 固定审核指令（逐栏核验值是否空壳／跨档一致性／引用真伪／四栏输出）
 * + 逐份（Expert id / label / 该 Expert 契约栏清单 / 交付正文）。
 * 契约栏真源 = 传入 contracts（生产传 DELIVERY_CONTRACTS，禁手抄第二份）。
 *
 * 2026-10-04（F3-B）：**成品证据前置**——先滤掉不带真实媒体产物的交付（probe／报告／空壳），
 * 只审真成品。全被滤空 → 回空字串；呼叫端（subagent.ts maybeRunMachineCriticPass）在
 * `if (!spec) return false` 处据此零派遣、零旗标消耗——这就是「非成品交付不触发成品内审」的活闸门。
 * 空 targets → 回空字串（呼叫端据此零派遣）。
 */
export function buildCriticPassSpec(
  targets: CriticPassTarget[],
  contracts: DeliveryContracts,
): string {
  if (!Array.isArray(targets) || targets.length === 0) return ""
  const reviewed = targets.filter((t) => hasRealDeliverable(t?.text))
  if (reviewed.length === 0) return ""
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
    "qc：具名独立审阅身份、实际感知工具callId、被审runId与artifact、检查结果和未覆盖项；作者勾选/文字PASS不作为证据。",
    "缺真实读取/感知、失败或覆盖不足时写未验，不要求作者盲目重产。末行 VERDICT: PASS|FAIL|PARTIAL。",
    "视频（包括合法静态镜头）必须核时间连续性：先 video_evidence probe 取得真实duration/frameRate，再 frames/tile/tiles抽原帧0、下一原帧（请求1/fps减0.001秒以避免取到第二帧），以及约25%/50%/75%/片尾≥90%时刻；实际read_image或vision_analyze读取这组帧/拼板。单帧、scene代表帧、metadata、转写或像素差不是动态感知。",
    "核对下列真实生成意图与序列实际运动：首帧跳变不是连续运镜；主体微动不是摄影机运动；画面整体放大只能说明缩放观感，physical dolly需要前后景视差、遮挡揭示或连续透视变化证据。静态意图允许机位不动；意图未知只报告可观察运动和未覆盖项，不强行要求移动。无法区分时PARTIAL，不凭motion PASS字串补证。",
    "",
    "被审正文若标记「已截断」，你只能就所见部分下判，不得对截断外内容断言。你只审不产：禁止改写或补产被审内容。",
    "",
    `【被审交付共 ${reviewed.length} 份（已滤除无成品的探活/报告类交付）】`,
  ].join("\n")

  const blocks: string[] = []
  let used = 0
  for (const t of reviewed) {
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
        `真实生成输入/工作流意图（缺失=unknown）：${JSON.stringify(t.mediaIntent ?? [])}`,
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

export const VIDEO_MOTION_RECEIPT_POLICY = "video-sequence-perception-v1"

/** Independent perception, with source-bound temporal coverage; sampling never decides camera quality. */
export function checkCriticReceipt(targets: CriticPassTarget[], messages: unknown): {
  ok: boolean; checked: Array<{ runId: string; artifact: string; callId: string; tool: string; motion?: { policy: string; duration: number; frameRate: number; times: number[]; callIds: string[]; probeCallId: string; derivationCallIds: string[] } }>; missing: string[]
} {
  const checked: ReturnType<typeof checkCriticReceipt>["checked"] = []
  const missing: string[] = []
  const parts = Array.isArray(messages) ? messages.flatMap((m: any) => m?.info?.role === "assistant" ? m?.parts ?? [] : []) : []
  const refs = (value: unknown): string[] => typeof value === "string"
    ? /^(?:https?:\/\/|\/).+\.(?:png|jpe?g|webp|gif|bmp|avif|heic|mp4|mov|mkv|webm)(?:[?#].*)?$/i.test(value) ? [value] : []
    : Array.isArray(value) ? value.flatMap(refs)
    : value && typeof value === "object" ? Object.values(value).flatMap(refs) : []
  for (const target of targets) for (const artifact of extractMediaTargets((target.artifacts ?? []).join("\n"), Infinity)) {
    const video = /\.(mp4|mov|mkv|webm)(?:[?#]|$)/i.test(artifact)
    const reachable = new Set([artifact])
    const frameTimes = new Map<string, number[]>()
    const viewed = new Set<number>(); const calls = new Set<string>()
    const derivations = new Set<string>(); let probeCallId = ""
    let duration = 0; let frameRate = 0
    let proof: { callId: string; tool: string } | undefined
    for (const part of parts) {
      if (part?.type !== "tool" || part?.state?.status !== "completed" || typeof part?.callID !== "string") continue
      let out: any
      try { out = typeof part.state.output === "string" ? JSON.parse(part.state.output) : part.state.output } catch { continue }
      if (out?.ok !== true) continue
      const input = part.state.input ?? {}
      const source = input.image_url ?? input.image_path ?? input.source ?? input.url
      if (typeof source !== "string" || !reachable.has(source)) continue
      const visual = part.tool === "vision_analyze" || (part.tool === "read_image" && out.attached === true && out.bytes > 0 && typeof out.mime === "string" && out.mime.startsWith("image/"))
      if (visual && /\.(png|jpe?g|webp|gif|bmp|avif|heic)(?:[?#]|$)/i.test(source)) {
        if (!video) proof = { callId: part.callID, tool: part.tool }
        else if (frameTimes.has(source)) {
          for (const time of frameTimes.get(source)!) viewed.add(time)
          calls.add(part.callID); proof = { callId: part.callID, tool: part.tool }
        }
      }
      if (!["video_fetch", "video_analyze", "video_evidence"].includes(part.tool)) continue
      // Existing exact-source receipts establish local aliases; metadata alone supplies no visual proof.
      for (const ref of refs(out)) {
        // A cut/re-encoded video is a different artifact, not an alias of the full review target.
        if (!/\.(mp4|mov|mkv|webm)(?:[?#]|$)/i.test(ref) || part.tool === "video_fetch" || (part.tool === "video_evidence" && ["probe", "fetch"].includes(input.action))) reachable.add(ref)
      }
      if (part.tool !== "video_evidence") continue
      if (input.action === "probe" && out.action === "probe" && out.hasVideo === true && Number.isFinite(out.duration) && out.duration > 0 && Number.isFinite(out.frameRate) && out.frameRate > 0) {
        duration = out.duration; frameRate = out.frameRate
        probeCallId = part.callID
      }
      if (!duration || !["frames", "tile", "tiles"].includes(input.action) || out.action !== input.action) continue
      const register = (path: unknown, frames: any[]) => {
        if (typeof path !== "string") return
        const times = frames.map((frame) => frame?.at).filter((at): at is number => typeof at === "number" && Number.isFinite(at) && at >= 0 && at < duration)
        if (!times.length) return
        derivations.add(part.callID)
        const aliases = [path, ...(Array.isArray(out.artifacts) ? out.artifacts.filter((item: any) => item?.path === path).map((item: any) => item.url) : [])]
        for (const alias of aliases) if (typeof alias === "string") { reachable.add(alias); frameTimes.set(alias, times) }
      }
      if (input.action === "frames") for (const frame of out.frames ?? []) register(frame.path, [frame])
      if (input.action === "tile") register(out.path, out.frames ?? [])
      if (input.action === "tiles") for (const grid of out.grids ?? []) register(grid.path, grid.frames ?? [])
    }
    const times = [...viewed].sort((a, b) => a - b)
    const epsilon = 0.002
    const temporal = duration > 0 && frameRate > 0 && times.length >= 6 &&
      times.some((t) => t <= 0.5 / frameRate + epsilon) &&
      times.some((t) => t > times[0]! + epsilon && t >= 0.5 / frameRate - epsilon && t <= 1.5 / frameRate + epsilon) &&
      [0.25, 0.5, 0.75].every((fraction) => times.some((t) => Math.abs(t - duration * fraction) <= duration * 0.10)) &&
      times.some((t) => t >= duration * 0.90)
    if (proof && (!video || temporal)) checked.push({ runId: target.runId, artifact, ...proof,
      ...(video ? { motion: { policy: VIDEO_MOTION_RECEIPT_POLICY, duration, frameRate, times, callIds: [...calls], probeCallId, derivationCallIds: [...derivations] } } : {}) })
    else missing.push(`${target.runId}:${artifact}${video ? ":motion-sequence-or-opening-adjacent-frames-missing" : ""}`)
  }
  return { ok: checked.length > 0 && missing.length === 0, checked, missing }
}

const CRITIC_REJECT_WORDS = ["partial", "fail", "未验", "退回", "驳回", "驳回", "不通过", "不通过", "未通过", "未通过", "reject", "rejected"]
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
  if (result.missing.some((field) => field.startsWith("artifact:"))) {
    return [
      "【系统修正指令·自动重派（上限 1 次，本次为第 1 次）】",
      result.reason || "登记产物尚无可用交付证据。",
      "修复当前登记产物：有外链的产物调用 artifact_verify 核实当前 URL；无外链本地文件须保留可安全读取且 hash/bytes 与登记一致的真实文件。",
      "不得只在正文补状态或伪造验证字段；完成修复后重新交付原任务的完整结果。",
    ].join("\n")
  }
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

// ─────────────────────────────────────────────────────────────────────────
// F10（2026-10-04）：内审/复核正文从用户可见文字剥离 v2（结构判定 + 分层降级）
//
// 病灶（eval-music-r2/EVAL-R4-retest.md 判据 1/2/3）：F6 的清洗对生产真实文本逐字节 no-op。
// F6 假设泄漏形态是裸露的 `verdict：`／`qc：` 行，但真实 critic 输出是 markdown：
// `**verdict**：pass`、`- **qc**: …`、`1. **【lyrics 栏·数值自证错误】** …`、行内 code span。
// F6 的栏名正则要求「栏名 + 紧邻冒号」（`**` 夹在中间即不命中），且只在命中标签行时删行——
// 审稿编号正文没有对应标签行可删 → 整段留下。R4 取反证：部署版纯函数对 5 条真实 critic
// 摘要 IN len == OUT len。
//
// v2 改用**结构判定**：先问「这段载荷是不是内审/复核产物」，判据对 markdown 变体免疫
// （强调/code span/标题/列表符号/引用标记一律归一，全角半角冒号等价）。判定为内审产物即
// **整段降级**为一句产品语言（只保留成品 URL 与落差），不做逐行手术；编号审稿正文一律不留。
//
// 三出口共用同一纯函数 `scrubSubagentPayload`：① subagent.done.summary（源头 subagent.ts
// finishRun ＋ 咽喉点 sse-core.emitToSession）② subagent.delta.text（sse-core）
// ③ role:"system" 唤醒载体（源头 index.ts wakeSessionForSubagent）。判定逻辑只此一份。
//
// F11（2026-10-04）追加：F10 只按**帧名**治 subagent.*，模型自己的正文（message.delta /
// turn.status）不过 scrubbing → R5 判据 1 里内审语汇改由模型自述上桌。本档把作用面从
// 「网关搬运的帧」扩到「模型自写的正文」：**按内容判定**（同一批判定正则），但只对**用户
// 可见文字帧**生效；正文走逐句定向改写（scrubVisibleProse），不整段掏空。
//
// 不过清洗（R4/R5 判据，F13 重定 oracle）：**用户写的**内容（prompt/歌词/附件）、**成品 URL 与
// 文件名**（含 `video-evidence-*.wav` 的 `evidence` 子串）、**结构化字段键名与值**（`audio_url` 等）、
// 代码区块与 URL 查询串一律逐字不变。**agent 自己写的**契约栏名行/栏名标签（`**qc**:`、`verdict：`、
// `issues：`、`evidence：`、`qcSignature：`、`score_abc = …`、`emotion_contract: …`，含 markdown 包裹、
// 全角/半角冒号、`- `/`1. ` 前缀、`##` 标题形态）一律剥离，无论载荷是 review 还是 scaffold。
// F11 曾以 agent 自写的 U2 报告全文不变为 oracle —— 错的 oracle（U2 本身违反「内审不上桌」）。
// ─────────────────────────────────────────────────────────────────────────

/** 本机/回环地址的内部端点 URL——永远不是给用户的产品链接，直接删。 */
const INTERNAL_ENDPOINT_URL_RE =
  /https?:\/\/(?:127\.0\.0\.1|localhost|0\.0\.0\.0|\[::1\])(?::\d+)?[^\s，。；、）)】"'`]*/gi

/** F11：**裸**回环端点（不带 scheme，如 `127.0.0.1:8788`）——R5-A3 D5 漏网形态。 */
const BARE_LOOPBACK_RE = /(?:127\.0\.0\.1|0\.0\.0\.0|\[::1\])(?::\d+)?|localhost:\d+/gi

/** F11：内部路径 / 源码路径行号 / runId / token 计数——用户可见文字里出现即泄漏。 */
const INTERNAL_PATH_RE = /outputs\/subagent\/[^\s`"'）)】]*|\.opencode\/[^\s`"'）)】]*/gi
const SOURCE_REF_RE = /\b[\w./-]+\.(?:ts|tsx|js|jsx|mjs|cjs|py|json|md):\d+(?::\d+)?/gi
const RUN_ID_RE = /\brunId\b[\s:：=]*[0-9a-zA-Z_-]*/gi
const TOKEN_COUNT_RE = /\btokens?\b[\s:：=]*\d{2,}|(?:工具调用|tool\s*calls?)[\s:：=]*\d+/gi

/** F11：整行/整帧恰为一个内部栏名或内部身份词的裸形态（如 subagent.delta 的裸 `evidence` 帧）。
 *  仅当**整行去空白后恰为该词**时命中——复合 token（`video-evidence-*.wav`）不误伤（R5 要求）。 */
const BARE_INTERNAL_TOKEN_RE =
  /^(?:evidence|qc|qc[\s\-_.]*signature|score[\s\-_.]*abc|verdict|issues?|needs?[_\s]?fix|emotion[\s\-_.]*contract|melody[\s\-_.]*notation|duration[\s\-_.]*source|prompt[\s\-_.]*used|critic|runId|subagent|审核官|独立审核|機器審核|機器审核|机器审核|复核官)[\s.。:：,，]*$/i

/** F11：正常交付里出现的契约栏名/内部身份词——用于「纯栏位行」判定。
 *  分隔变体（`_ - . 空格`）一并纳入：`score_abc` / `score-abc` / `score abc` 等价命中。 */
const CONTRACT_FIELD_ALT =
  "qc[\\s\\-_.]*signature|score[\\s\\-_.]*abc|emotion[\\s\\-_.]*contract|melody[\\s\\-_.]*notation|duration[\\s\\-_.]*source|prompt[\\s\\-_.]*used|qc"

/** 交付契约栏位区块标题 / 纯栏位标题行（`## qc` / `**qcSignature**`）——整行恰为栏名。 */
const FIELD_HEADING_LINE_RE = new RegExp(
  `^[ \\t]*(?:#{1,6}[ \\t]+)?(?:\\*\\*|__)?[ \\t]*(?:${CONTRACT_FIELD_ALT})[ \\t]*(?:\\*\\*|__)?[ \\t]*$`,
  "i",
)

/** 栏位标签行起始（行首可选列表符 + 栏名 + 冒号/等号）：`- **qc**: …` / `score_abc = null`。 */
const FIELD_LABEL_LINE_RE = new RegExp(
  `^[ \\t]*(?:[-*+]\\s+)?(?:\\*\\*|__)?[ \\t]*(?:${CONTRACT_FIELD_ALT}|verdict|issues|evidence|runId)[ \\t]*(?:\\*\\*|__)?[ \\t]*[:：=]`,
  "i",
)

/** 纯内部栏位行（**仅模型正文逐句改写路径用**）：是栏位标签行，且分隔符后没有中文说明。
 *  F13 口径：契约栏位标签行的剥离不再看冒号后有没有中文（旧「带中文说明＝正常业务」假设
 *  以 agent 自写的 U2 报告当 oracle，是错的 oracle）；scaffold 交付路径改由
 *  `SCAFFOLD_FIELD_LABEL_LINE_RE` 整行剥离，本函式只保留给 `scrubVisibleProse` 的正文改写。 */
function isPureInternalFieldLine(line: string): boolean {
  const m = FIELD_LABEL_LINE_RE.exec(line)
  if (!m) return false
  return !/[\u4e00-\u9fff]/.test(line.slice(m[0].length))
}

/** F13（2026-10-04）：交付契约栏位**区块标题行**（`## 交付契约栏位`）——内审后厨稿面，整行删除。 */
const CONTRACT_BLOCK_HEADING_LINE_RE =
  /^[ \t]*(?:#{1,6}[ \t]+)?(?:\*\*|__)?[ \t]*交付契约栏位[ \t]*(?:\*\*|__)?[ \t]*$/

/** F13：契约栏位**标签行**（含 `lyrics`／`audio_url` 等交付契约栏；F10 口径恢复，F11 曾按原文
 *  保留整块）——无论冒号后有无中文说明，整行剥离。带产品 URL 的标签行例外保留：成品链接逐字不变。
 *  覆盖 markdown 包裹、全角/半角冒号与等号、`- `/`1. ` 列表前缀。 */
const SCAFFOLD_FIELD_LABEL_LINE_RE = new RegExp(
  `^[ \\t]*(?:[-*+]\\s+|\\d+[.、]\\s+)?(?:\\*\\*|__)?[ \\t]*(?:${CONTRACT_FIELD_ALT}|verdict|issues?|evidence|lyrics|audio_url)[ \\t]*(?:\\*\\*|__)?[ \\t]*[:：=]`,
  "i",
)

/** F13：内部契约栏名 token（scaffold 载荷里出现即剥离），只在非 URL 段生效（调用端
 *  `scrubOutsideUrls`）。两个安全护栏：
 *  ① 负向环视排除复合 token：成品档名 `video-evidence-*.wav`、工具名 `video_evidence` 及一切
 *     `- _ .` 连接的标识符不误伤（R4/R5 明列的合法误报）；`audio_url`／`lyrics` 等产品字段不在列。
 *  ② `verdict`／`issues`／`evidence` 是英文常用词，**只认标签形态**（`` `evidence` ``／`**evidence**`
 *     这类 markdown 包裹，或 `evidence：`／`evidence =` 带分隔符）；裸词（英文正文 the evidence）
 *     不剥离，避免误伤业务正文。`qc*`／`score_abc`／`emotion_contract` 等不会出现在英文正文，裸词即剥。 */
const SCAFFOLD_FIELD_TOKEN_STRIP_RE = new RegExp(
  "(?<![\\w\\-.])" +
    "(?:" +
    "[`*]{0,2}(?:qc[\\s\\-_.]*signature|score[\\s\\-_.]*abc|prompt[\\s\\-_.]*used|emotion[\\s\\-_.]*contract|melody[\\s\\-_.]*notation|duration[\\s\\-_.]*source|qc)[`*]{0,2}" +
    "|[`*]{1,2}(?:verdict|issues?|evidence)[`*]{1,2}[:：=]?" +
    "|(?:verdict|issues?|evidence)[ \\t]*[:：=]" +
    ")" +
    "(?![\\w\\-.])",
  "gi",
)

/** URL 段切分（URL 段原样保留——产品链接与其查询串不得被当内部赋值误删）。 */
const VISIBLE_URL_SEGMENT_RE = /(https?:\/\/[^\s)）\]」>`"']+)/

/** 只在**非 URL 段**做替换（URL 段原样返回，产品链接/文件名零误伤）。 */
function scrubOutsideUrls(s: string, fn: (chunk: string) => string): string {
  return s
    .split(VISIBLE_URL_SEGMENT_RE)
    .map((part, i) => (i % 2 === 1 ? part : fn(part)))
    .join("")
}

/**
 * 归一化视图（仅用于结构判定）：去 markdown 装饰（`**`/`__`/`*`/`_`/`` ` ``/`#`/`>`/列表符号）、
 * 全角冒号与等号归一为半角、空白压缩。目的是让 `**verdict**：pass`／`` `verdict` ``／
 * `### verdict`／`> verdict`／`1. verdict：` 全部归一为同一可判形态。
 */
function normalizeForReviewDetection(s: string): string {
  return s
    .replace(/\uFF1A/g, ":")
    .replace(/\uFF1D/g, "=")
    .replace(/[`*_~>#|]+/g, " ")
    .replace(/[\s\u3000]+/g, " ")
}

/** 判定视图：先摘掉 URL 段与本机端点（产品链接、成品文件名不得触发判定）。 */
function reviewDetectionView(s: string): string {
  return normalizeForReviewDetection(
    s
      .replace(/\r\n?/g, "\n")
      .replace(INTERNAL_ENDPOINT_URL_RE, " ")
      .replace(VISIBLE_URL_SEGMENT_RE, " "),
  )
}

// ── 判定规则（三族，命中任一即内审产物）─────────────────────────────────────
// 族 1：契约**判决**栏名（verdict/qcSignature 任意 markdown 包裹下命中；issues 须栏位语法）。
// F11：`score_abc` 等**数据**栏名不再单独判 review（否则用户 prompt 里用户自己写的
// `melody_notation / score_abc` 会被整段误降级）——它们走 scaffold 的「纯栏位行」删除。
const REVIEW_FIELD_RE = /\b(?:verdict|qc[\s\-_.]*signature)\b|\bissues?\s*[:：=|]/i
// 族 2：内部审核身份（含繁体变体）。
const CRITIC_IDENTITY_RE =
  /独立审核|獨立審核|审核官|審核官|机器审核|機器審核|复核官|覆核官|\bcritic\b/i
// 族 2'：内审正文结构特征（编号审稿条目 / 逐条引用 / 存在性判词）。
// 注意：`结论如下`／`結論如下` 是普通中文短语（正常交付也会用），不能作为内审判据；
// 真内审仍由 verdict/issues 栏位与审核身份判族拦截。
const CRITIC_STRUCTURE_RE =
  /被审原文|被審原文|栏位存在性|欄位存在性|审核已完成|審核已完成/
const NUMBERED_REVIEW_RE = /(?:^|\s)\d+[.、]\s*【/
// 判词（退回类）——只用于降级句式的方向选择，不单独作判定族。
const REJECT_WORD_RE = /退回|驳回|駁回|不通过|不通過/
const GAP_WORD_RE = /有落差|需修正/

// 族 4（弱信号）：契约数据栏脚手架（非判决类）——正常交付里也会出现，只删脚手架、留正文。
// 刻意**不含** `evidence` 裸词：成品档名 `video-evidence-*.wav` 与工具名 `video_evidence`
// 是 R4 明列的合法误报，裸词命中会造成成品文件名误删。
const SCAFFOLD_FIELD_TOKEN_RE =
  /\b(?:qc[\s\-_.]*signature|score[\s\-_.]*abc|prompt[\s\-_.]*used|emotion[\s\-_.]*contract|melody[\s\-_.]*notation|duration[\s\-_.]*source|qc)\b/i

type ReviewClass = "review" | "scaffold" | "clean"

/**
 * 纯函数：判定一段载荷是否内审/复核产物。
 *  `review`   = 内审/复核产物（判决栏名 / 审核身份 / 审稿结构 / 编号审稿）→ 整段降级；
 *  `scaffold` = 正常交付里夹带的契约栏脚手架 → 只删脚手架行，正文逐字保留；
 *  `clean`    = 正常业务正文 → 原样返回。
 */
export function classifyInternalReviewPayload(s: string): ReviewClass {
  const v = reviewDetectionView(s)
  // 栏位语法视图：保留表格管道、把引号归一为空格。`reviewDetectionView` 会把 `|` 抹成空格，
  // 若只判 v，`| issues |`／`"issues":` 的栏位边界会消失——本视图只补这两个形态，不参与其他判族。
  const fieldView = s
    .replace(/\r\n?/g, "\n")
    .replace(INTERNAL_ENDPOINT_URL_RE, " ")
    .replace(VISIBLE_URL_SEGMENT_RE, " ")
    .replace(/\uFF1A/g, ":")
    .replace(/[`*_~>#]+/g, " ")
    .replace(/["']/g, " ")
    .replace(/\s+/g, " ")
  if (
    REVIEW_FIELD_RE.test(v) ||
    REVIEW_FIELD_RE.test(fieldView) ||
    CRITIC_IDENTITY_RE.test(v) ||
    CRITIC_STRUCTURE_RE.test(v) ||
    NUMBERED_REVIEW_RE.test(v)
  ) {
    return "review"
  }
  if (SCAFFOLD_FIELD_TOKEN_RE.test(v)) return "scaffold"
  return "clean"
}

/** 从载荷中抽取**产品** URL（回环/本机端点不算），去重保序。 */
const PRODUCT_URL_RE = /https?:\/\/[^\s)）\]」>`"'，。；、]+/gi
function extractProductUrls(s: string): string[] {
  const out: string[] = []
  for (const m of s.matchAll(PRODUCT_URL_RE)) {
    const u = m[0]
    if (/^https?:\/\/(?:127\.0\.0\.1|localhost|0\.0\.0\.0|\[::1\])(?::\d+)?/i.test(u)) continue
    if (!out.includes(u)) out.push(u)
  }
  return out
}

/** 降级句式的方向：判词/落差 → 落差句；明确 pass → 通过句。 */
function productLanguageForReview(s: string): string {
  const v = reviewDetectionView(s)
  const passed =
    /(?:判定「通过」|判定「通過」|已复核通过|已覆核通過|无落差|無落差)/.test(v) ||
    /verdict\s*:?\s*(?:pass|approved?|通过|通過)/i.test(v)
  return passed && !REJECT_WORD_RE.test(v) && !GAP_WORD_RE.test(v)
    ? "（这一路已复核通过。）"
    : "（这一路经复核有落差，需修正。）"
}

/** 内审产物 → 整段降级为一句产品语言（+ 该载荷中的成品 URL，逐字）。 */
function degradeInternalReviewPayload(s: string): string {
  const urls = extractProductUrls(s)
  return [productLanguageForReview(s), ...urls].join("\n")
}

/** 正常交付（scaffold）：剥离 agent 自写的**契约栏位区块**——区块标题行、契约栏位标签行
 *  （含带中文说明的标签行，含 `lyrics`／`audio_url` 等交付契约栏）与栏内裸栏名 token。
 *
 *  F13 口径（2026-10-04）：F11 为让 U2 报告「逐字不变」把整块按原文保留——但 U2 是 agent
 *  自写的交付，其「交付契约栏位」区块本身就在违反「内审不上桌」（用户可见文字禁出现
 *  `qc`／`verdict`／`issues`／`evidence` 栏名）。**拿 agent 自写的报告当「不过清洗」oracle
 *  是错的 oracle**。故恢复 F10 的剥离口径，并补上 F10 刻意放行的表格头 `evidence` 标签 token。
 *
 *  本档「不过清洗」判据改为：**用户写的内容**（prompt/歌词/附件）、**成品 URL 与文件名**
 *  （含 `video-evidence-*.wav` 的 `evidence` 子串）、**结构化字段键名与值**（`audio_url` 等）、
 *  代码区块与 URL 查询串一律逐字不变；正文与成品 URL 逐字保留。无任何剥离时**原样返回**。
 */
function stripScaffoldFromDeliverable(s: string): string {
  let changed = false
  const kept: string[] = []
  for (const line of s.split("\n")) {
    if (
      CONTRACT_BLOCK_HEADING_LINE_RE.test(line) ||
      (SCAFFOLD_FIELD_LABEL_LINE_RE.test(line) && !/https?:\/\//i.test(line)) ||
      BARE_INTERNAL_TOKEN_RE.test(line.trim())
    ) {
      changed = true
      continue
    }
    kept.push(line)
  }
  const base = kept.join("\n")
  // 行内裸栏名 token（如表格头「探针 `evidence`」）：只在**非 URL 段**剥离，复合词不误伤。
  const stripped = scrubOutsideUrls(base, (chunk) => chunk.replace(SCAFFOLD_FIELD_TOKEN_STRIP_RE, ""))
  if (stripped !== base) changed = true
  if (!changed) return s
  return stripped
}

// ─────────────────────────────────────────────────────────────────────────
// F11（2026-10-04）：模型自述正文的内审语汇剥离（按内容判定，仅用户可见文字帧）
//
// 病灶（eval-music-r2/EVAL-R5-retest.md 判据 1）：F10 按**帧名**只治 subagent.done /
// subagent.delta；模型自己的正文（message.delta / turn.status）结构性地不过 scrubbing
// → V1 msg[13]「按流程派独立审核官逐栏核验」、msg[14]「拿到 verdict 后」直接上桌。
//
// 与 F10 同源：本段复用同一批判定正则与 URL 保护，只换**改写粒度**——
// 内审产物走整段降级（scrubSubagentPayload）；模型正文走**逐句定向改写**（本段），
// 命中句改写为产品语言、未命中句逐字不动，绝不整段掏空。
// ─────────────────────────────────────────────────────────────────────────

/** 模型正文的定向改写规则（顺序敏感：具体短语先于裸词；先英文判词后中文身份）。
 *  只替换命中片段本身，前后文逐字保留——输出必须是通顺简体，不是残句。 */
const PROSE_REWRITE_RULES: Array<[RegExp, string]> = [
  // 派 X 逐栏核验 → 我已逐栏核对过（覆盖 R5 msg[13] 原句）。
  [
    /按[^。；\n]{0,8}?派\s*(?:一位|一名|一个)?\s*(?:独立审核官|独立审核|审核官|复核官|机器审核|审核|critic)\s*(?:来|去)?\s*(?:逐栏)?\s*(?:核验|复核|审核|检查|审查)/gi,
    "我已逐栏核对过",
  ],
  [/\b(?:dispatch|派遣)\s*(?:an?\s+)?(?:independent\s+)?(?:critic|reviewer)\b/gi, "逐栏核对"],
  [/据其裁决/g, "据此"],
  // 判词族（先整短语后裸词）。
  [/拿到\s*verdict\s*后/gi, "核对结果出来后"],
  [/\bverdict\b/gi, "核对结果"],
  [/\s*\bneeds?[_\s]?fix\b\s*/gi, "需修正，"],
  [/\s*\baccepted\b\s*/gi, "通过，"],
  [/\bissues?\b/gi, "问题"],
  [/\bcritic\b/gi, "复核"],
  // 内部身份裸词。
  [/独立审核官|独立审核|审核官|复核官|机器审核/g, "核对"],
  // 契约栏名裸形 → 产品语言（`_ - . 空格` 分隔变体一并命中）。
  [/\bqc[\s\-_.]*signature\b/gi, "质检签名"],
  [/\bscore[\s\-_.]*abc\b/gi, "乐谱数据"],
  [/\bemotion[\s\-_.]*contract\b/gi, "情感契约"],
  [/\bmelody[\s\-_.]*notation\b/gi, "乐谱记谱"],
  [/\bduration[\s\-_.]*source\b/gi, "时长来源"],
  [/\bprompt[\s\-_.]*used\b/gi, "提示词"],
  [/\bqc\b/gi, "质检"],
]

/** 单块（非代码栅栏）正文的定向清洗：删纯内部栏位行/标题行/裸栏名行，再逐条改写。
 *  无任何命中时**原样返回**（零误伤正常正文）。 */
function scrubProseChunk(chunk: string): string {
  let changed = false
  const kept: string[] = []
  for (const line of chunk.split("\n")) {
    if (FIELD_HEADING_LINE_RE.test(line) || isPureInternalFieldLine(line) || BARE_INTERNAL_TOKEN_RE.test(line.trim())) {
      changed = true
      continue
    }
    kept.push(line)
  }
  const base = kept.join("\n")
  const rewritten = scrubOutsideUrls(base, (c) => {
    let r = c
    for (const [re, rep] of PROSE_REWRITE_RULES) r = r.replace(re, rep)
    r = r.replace(INTERNAL_PATH_RE, "内部工作区").replace(SOURCE_REF_RE, "源码")
    r = r.replace(RUN_ID_RE, "运行编号").replace(TOKEN_COUNT_RE, "用量计数")
    r = r.replace(BARE_LOOPBACK_RE, "本机地址")
    return r
  })
  if (!changed && rewritten === chunk) return chunk
  return rewritten.trim().length === 0 ? "" : rewritten
}

/**
 * 纯函数（F11）：**模型自述正文**（message.delta / turn.status / notice 类）的内审语汇剥离。
 *  = 与 F10 同源判定 + 定向改写；代码栅栏整段跳过，URL 段原样保留。
 */
export function scrubVisibleProse(raw: unknown): string {
  if (typeof raw !== "string") return ""
  if (raw.length === 0) return raw
  // 代码栅栏整段不碰（split 后奇数索引即栅栏段）。
  const parts = raw.split(/(```[\s\S]*?(?:```|$)|~~~[\s\S]*?(?:~~~|$))/)
  return parts.map((p, i) => (i % 2 === 1 ? p : scrubProseChunk(p))).join("")
}

/**
 * 弱内部痕迹的**就地脱敏**（clean/scaffold 路径专用，不整段降级）：
 * 内部路径 / runId / 用量计数换成产品语言；UUID 与 task_id 是用户需要的生成回执，保持原样。
 */
function sanitizeWeakInternalArtifacts(s: string): string {
  return s
    .replace(INTERNAL_PATH_RE, "内部工作区")
    .replace(RUN_ID_RE, "运行编号")
    .replace(TOKEN_COUNT_RE, "用量计数")
}

/**
 * 纯函数（三出口共用）：子代理产出/唤醒载荷 → 用户可见文字。
 *  内审/复核产物 → 一句产品语言（+ 成品 URL）；正常交付 → 去纯内部栏位行留正文；正常正文 → 原样。
 *  F11 附加：整行恰为裸栏名单词（如 subagent.delta 的裸 `evidence`）整行删除；裸回环端点先删。
 */
export function scrubSubagentPayload(raw: unknown): string {
  if (typeof raw !== "string" || raw.length === 0) return ""
  let s = raw.replace(/\r\n?/g, "\n")
  // 0) 内部端点先删（带 scheme 的 URL 与裸回环端点是同一类内部物证）。
  s = s.replace(INTERNAL_ENDPOINT_URL_RE, "")
  s = s.replace(BARE_LOOPBACK_RE, "")
  // 1) 结构脚手架：落盘指针 / 截断提示 / 用量计数。既非用户内容，也不作内审判据
  //    （否则每个 run 的落盘指针都会把正常交付误判成内审产物）。
  s = s.replace(/\[(?:完整|部分)结果(?:已落盘|落盘失败)[^\]]*\]\s*/g, "")
  s = s.replace(/\n*\[已截断[^\]]*\]\s*/g, "\n")
  s = s.replace(/\n*\[子代理用量\][^\n]*/g, "")
  // 2) 结构判定 → 分层降级。
  const cls = classifyInternalReviewPayload(s)
  if (cls === "review") return degradeInternalReviewPayload(s)
  // scaffold：只删**纯内部栏位行**（无中文说明），再就地脱敏弱内部痕迹；正常报告正文逐字不变。
  if (cls === "scaffold") return sanitizeWeakInternalArtifacts(stripScaffoldFromDeliverable(s))
  // 3) 正常正文：整行恰为裸栏名单词的行删掉（R5 的 138 帧裸 `evidence`），其余逐字不变。
  if (BARE_INTERNAL_TOKEN_RE.test(s.trim())) return ""
  const lines = s.split("\n").filter((line) => !BARE_INTERNAL_TOKEN_RE.test(line.trim()))
  const joined = lines.join("\n")
  // F13：无行被删 → **逐字原样返回**（不再无条件 trim/折叠空行——用户 prompt／歌词／业务正文
  // 必须 OUT==IN；旧行为会把首尾空白与连续空行吃掉，破坏「不过清洗」的长度+sha 判据）。
  const body =
    joined === s ? s : joined.replace(/[ \t]+\n/g, "\n").replace(/\n{3,}/g, "\n\n").trim()
  // 正常正文里的弱内部痕迹就地脱敏（不再整段降级），UUID/task_id 保留。
  return sanitizeWeakInternalArtifacts(body)
}

/** F11：用户可见**文字**帧（正文/状态/通知）——只清洗这些帧的 `text`；tool/canvas/结构化帧不碰。 */
function isUserVisibleTextFrame(name: string): boolean {
  return name === "message.delta" || name === "turn.status" || name === "notice" || name.endsWith(".notice")
}

/**
 * 用户可见 SSE 帧的单一咽喉点清洗（F11：由「按帧名」改为「按内容判定，但只对用户可见文字帧」）。
 *  ① 携带**子代理内部摘要/正文**的帧 → F10 同源判定（整段降级 / 去纯栏位行 / 原样）；
 *  ② 模型自述**正文/状态/通知**帧 → 同源判定 + 逐句定向改写（scrubVisibleProse）；
 *  其余帧（tool payload、canvas、结构化字段等）一律不碰 → 零误伤。
 */
export function scrubVisibleFrame(name: string, data: unknown): unknown {
  if (data === null || typeof data !== "object" || Array.isArray(data)) return data
  const d = data as Record<string, unknown>
  if (name === "subagent.done") {
    if (typeof d.summary !== "string") return data
    const cleaned = scrubSubagentPayload(d.summary)
    return cleaned === d.summary ? data : { ...d, summary: cleaned }
  }
  if (name === "subagent.delta") {
    if (typeof d.text !== "string") return data
    const cleaned = scrubSubagentPayload(d.text)
    return cleaned === d.text ? data : { ...d, text: cleaned }
  }
  if (isUserVisibleTextFrame(name)) {
    if (typeof d.text !== "string") return data
    const cleaned = scrubVisibleProse(d.text)
    return cleaned === d.text ? data : { ...d, text: cleaned }
  }
  return data
}
