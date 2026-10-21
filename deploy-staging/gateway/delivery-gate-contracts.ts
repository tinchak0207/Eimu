import { readFileSync } from "node:fs"
import type { ArtifactVerifyRecord, DeliveryContracts, DeliveryGateResult, ExpertDeliveryContract } from "./delivery-gate-types.ts"

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
