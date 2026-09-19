/**
 * delivery-gate.ts — Expert 交付契約的**機器強制點**（片 C，2026-09-15）。
 *
 * 病灶（R8 審計實錘，09-10）：7 個 Expert 的 `*_DELIVERABLES` 契約只寫在 prompt/digest 裡，
 * gateway 全域 grep `requiredFields`/`qcSignatureRequired`/`deliverableContract` **零命中**
 * ——契約無任何執行點。09-15 實案：music 域契約要求 5 欄，`audio_url` 是空的（無 demo），
 * 收尾路徑照樣 `status:"ok"` 放行，Orchestrator 直接標「部分成功」。
 *
 * ─────────────────────────────────────────────────────────────────────────
 * 【本閘門的邊界：這是「欄位存在性」檢查，不是「品質」檢查】
 *
 * 判據 = 契約 requiredFields 的**欄位名**是否在交付文本中出現（大小寫正規化後子字串命中）。
 * 它**不**驗證：
 *   - 值的正確性（`audio_url` 寫了個 404 的連結照樣過閘）；
 *   - 值的完整度/長度（`lyrics: ""` 也算命中）；
 *   - 品質、審美、是否符合 TaskType 意圖。
 * 因此**不得**把本閘門宣稱為「品質閘門」或「驗收通過」。它的作用是：
 * 把「契約欄位整欄缺失」這種**可機械判定**的漏交付變成可見的顯式標記，
 * 讓收尾摘要不再能若無其事地標 ok。品質判定仍屬 critic/Expert 職權。
 * ─────────────────────────────────────────────────────────────────────────
 *
 * 【fail-open 取捨】契約檔不存在 → 契約視為空 → 全放行（僅 console.warn 一行）。
 * 理由：本模組在 gateway 啟動時載入，若因部署順序（新代碼先於契約檔落位）或缺檔就
 * 判定「全部 Expert 交付未達標」，等於把整條生產鏈卡死——一個新檔沒部署不該有這種
 * 爆炸半徑。契約檔壞掉同理（JSON 解析失敗 = 空契約），但一律留 warn 證據，不靜默。
 *
 * 【非 Expert 零回歸】agent 為 undefined 或不在 contracts → 直接 {ok:true}。
 * 通用子代理（label/prompt/async 三欄派工、不帶 expert）完全不受本閘門影響。
 */

import { readFileSync } from "node:fs"

/** 單一 Expert 的交付契約（與 src/lib/expert-registry.ts deliverableContract 同形）。 */
export interface ExpertDeliveryContract {
  requiredFields: string[]
  qcSignatureRequired: boolean
}

export type DeliveryContracts = Record<string, ExpertDeliveryContract>

export interface DeliveryGateResult {
  /** true = 無契約可判 / 契約欄位齊；false = 有契約且缺欄位。 */
  ok: boolean
  /** 合同欄位中「在交付文本裡找不到欄位名」的那些（已去重、保持契約順序）。 */
  missing: string[]
  /** 人話理由（僅 ok:false 時給）。 */
  reason?: string
}

/** 契約檔座標：與 subagent.ts 讀 expert-ids.json 同目錄（gateway/expert/）。 */
export const DELIVERY_CONTRACTS_FILE = "expert-delivery-contracts.json"

/** 收尾摘要/事件用的顯式標記（前端與 Orchestrator 靠它肉眼可辨）。 */
export const DELIVERY_GATE_MARK = "【交付閘門·未達標】"

/** 片 D（2026-09-15）：機器化重派一次後復檢仍 FAIL 的升級標記（區別於首輪未達標）。 */
export const REWORK_FAIL_MARK = "【交付閘門·重派後仍未達標】"

/**
 * 刀 F（2026-09-15）：gateway 重啟把 in-flight rework run 遺成孤兒時，啟動掃描走誠實路徑
 * （abort+DELETE 孤兒子會話、done 帶 delivery_gate.orphaned、wake 父會話一次），done/wake
 * 前綴掛此標記——讓 orchestrator 拿到「進程中斷未復原」的事實而非永挂，自行決定補派。
 */
export const ORPHANED_GATE_MARK = "【交付閘門·進程中斷未復原】"

/**
 * 契約載入（模組載入時一次）。檔不存在/壞掉 → 空契約 + 一行 warn（fail-open，見檔頭）。
 * 用 `import.meta.dir`（Bun）：gateway 進程 WorkingDirectory=/opt/agent-harness/gateway，
 * 本檔與 expert/ 同層 → `${import.meta.dir}/expert/...` 與 subagent.ts 的 expert-ids.json
 * 讀法完全一致（同一個雷：別用 process.cwd()，別用相對 ./expert）。
 */
function loadContractsAtImport(): DeliveryContracts {
  const file = `${import.meta.dir}/expert/${DELIVERY_CONTRACTS_FILE}`
  try {
    const parsed: unknown = JSON.parse(readFileSync(file, "utf8"))
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      console.warn(`[gateway] delivery gate: 契约档形状错误（非对象），契約视为空，全放行：${file}`)
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
      `[gateway] delivery gate: 契约已载入 ${Object.keys(out).length} 個 Expert（${file}）`,
    )
    return out
  } catch (e) {
    const code = (e as { code?: string })?.code
    const why = code === "ENOENT" ? "档不存在" : e instanceof Error ? e.message : String(e)
    // 一行 warn，不拋：契約缺檔不得把整條子代理收尾鏈卡死（檔頭 fail-open 取捨）。
    console.warn(`[gateway] delivery gate: 契约档不可读（${why}），契約视为空，全放行：${file}`)
    return {}
  }
}

/** 模組載入即讀（module-load 快照；換契約檔須重啟 gateway 才生效，同 expert-ids.json 語義）。 */
export const DELIVERY_CONTRACTS: DeliveryContracts = loadContractsAtImport()

/**
 * 純函數：判定某次 Expert 交付是否滿足其契約欄位。
 * @param agent     run.agent（expert id）；undefined/空字串 = 非 Expert 派工 → 放行。
 * @param text      交付文本（**未截斷全文**，不是 600 字摘要——摘要會把欄位切掉變假陰性）。
 * @param contracts 契約表（注入式，便於單測；生產傳 DELIVERY_CONTRACTS）。
 */
export function checkDelivery(
  agent: string | undefined,
  text: string,
  contracts: DeliveryContracts,
): DeliveryGateResult {
  // 非 Expert / 未登記 → 零回歸放行。
  if (!agent || typeof agent !== "string") return { ok: true, missing: [] }
  const contract = contracts[agent]
  if (!contract) return { ok: true, missing: [] }

  // 欄位名大小寫正規化後子字串命中。toLowerCase 對 CJK 是恆等（中文標籤不受影響），
  // 故契約欄位若寫中文標籤也照樣子字串可比。
  const haystack = (typeof text === "string" ? text : "").toLowerCase()
  const missing: string[] = []
  const push = (f: string) => {
    if (!missing.includes(f)) missing.push(f)
  }
  for (const field of contract.requiredFields) {
    if (!haystack.includes(field.toLowerCase())) push(field)
  }
  // qcSignatureRequired：簽名要求是獨立條款——即使 requiredFields 沒列 qc，也要求 qc 欄位名在場。
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
 * 組收尾前綴（人話、可肉眼辨識、帶 missing 與欄位計數）。
 * 純字串拼裝，不碰 status 語義（status 恒為呼叫端給的 ok/error）。
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
 * 刀 G（2026-09-15）：契約欄**機器注入**。病灶＝round3 首派 3/3 spec 未抄契約欄
 * （playbook 第 19 條對 orchestrator 零滲透），全靠閘門重派兜底＝每次白燒一倍成本。
 * 修法＝不再「期待」子代理服從 prompt 裡手抄的欄位條款，而是在 dispatch 建立 Expert
 * run 時，把其契約欄清單作為**固定段**追加到子代理 prompt 尾部——真源單一（復用已載入
 * 的 DELIVERY_CONTRACTS，禁手抄第二份）。純函數：非 contracts agent / 空 agent → 回
 * 空字串（調用端據此零注入，非 Expert 零回歸）。
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
 * 刀 2（2026-09-15，gateway 手術片）：machine critic pass —— 不叫模型派，gateway 自己派。
 *
 * 病灶（四輪實錄）：playbook 第 18 條「必須派 critic」四輪均在場，orchestrator 四輪零派遣
 * （r2 軟條款 → r3b「未启用」藉口＋自簽承諾 → r3c 配置已翻正、條款逐請求注入，11 段推理
 * critic/審核/review 零命中，逐字「I won't re-dispatch anything…synthesis is my job」）。
 * 純 prompt 路線已證死 → 在父會話收盤判定點由 gateway 直接派遣。
 *
 * 本段只放**純函數**（觸發判據 + spec 組裝 + verdict 判讀）；派遣 / 旗標 / 喚醒 / 重派
 * 全部復用既有輪子（subagent.ts dispatchAttempt+startRework、wakeSessionForSubagent、
 * persistence.ts bun:sqlite 同款表慣例），禁自造第二套派遣或輪詢。
 */

/** 機器 critic pass 的固定標記（journal/spec 留痕用，不作為前端文案前綴）。 */
export const CRITIC_PASS_MARK = "【独立审核·机器派遣】"

/** critic 判「退回」時喚醒父會話摘要的前綴（orchestrator 一眼辨識判決方向）。 */
export const CRITIC_REJECT_MARK = "【独立审核·退回】"

/**
 * 逃逸閥字樣：最終文本自行聲明「未經獨立審核」→ 本次不觸發機器 pass。
 * （playbook 第一節末：critic 派遣本身失敗時允許自簽兜底，且回覆須註明此字樣。）
 */
export const CRITIC_UNREVIEWED_DECL = "未經獨立審核"

/** 逃生閥字樣（簡體鏡像）：模型輸出以簡體為主，兩種寫法都算聲明。 */
export const CRITIC_UNREVIEWED_DECL_SIMP = "未经独立审核"

/** 每會話每次 pass 最多送審份數（有界，防 prompt 爆炸）。 */
export const CRITIC_PASS_MAX_TARGETS = 8
/** 單份被審交付內嵌進 critic prompt 的字元上限（超出截斷且顯式標記，critic 不得越界下判）。 */
export const CRITIC_PASS_PER_TARGET_CHARS = 6000
/** 全部被審交付內嵌字元總上限。 */
export const CRITIC_PASS_TOTAL_CHARS = 24000

/** 被審交付（由 subagent.ts finishRun 在 Expert 終態時登記）。 */
export interface CriticPassTarget {
  /** 被審 Expert id（DELIVERY_CONTRACTS 域內；critic 自身永不入列）。 */
  agent: string
  label: string
  runId: string
  /** 交付正文（finishRun 手上就是未截斷全文）。 */
  text: string
}

/**
 * 觸發判據輸入（全部為真才觸發；純函數便於四態單測）。
 * 語義釘死：任一為假 → 回 false，呼叫端零動作（零回歸）。
 */
export interface CriticPassInput {
  /** 父會話 beast_mode（MOE Expert 鏈的前提）。 */
  beastMode: boolean
  /** 待審份數（本窗口內契約域內已完成、且尚未送審的 Expert 交付）。 */
  expertDeliveries: number
  /** 本輪是否已有 critic 派遣（含在途）。 */
  criticDispatched: boolean
  /** 最終文本是否自行聲明「未經獨立審核」。 */
  unreviewedDeclared: boolean
  /** 該會話是否已用過本 pass（持久旗標，每會話 ≤1 次）。 */
  alreadyPassed: boolean
}

/**
 * 純函數：收盤判定點是否該觸發一次機器 critic pass。
 * 五個前置條件全部成立才 true：非 beast / 無 Expert 交付 / 已有 critic 派遣 /
 * 已聲明未經審核 / 已用過 pass —— 任一即 false（零動作，零回歸）。
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
 * 純函數：文字片段是否出現「未經獨立審核」聲明。
 * 跨 chunk 邊界安全：呼叫端維持尾巴 16 字，本函數吃 (tail + delta)。
 */
export function declaresUnreviewed(tailAndDelta: string): boolean {
  if (typeof tailAndDelta !== "string") return false
  return tailAndDelta.includes(CRITIC_UNREVIEWED_DECL) || tailAndDelta.includes(CRITIC_UNREVIEWED_DECL_SIMP)
}

/** 契約欄清單（含 qcSignatureRequired 補欄）——與 checkDelivery 同口徑，禁第二份清單。 */
function contractFieldsOf(agent: string, contracts: DeliveryContracts): string[] {
  const c = contracts[agent]
  if (!c) return []
  const fields = c.requiredFields.slice()
  if (c.qcSignatureRequired && !fields.includes("qc")) fields.push("qc")
  return fields
}

/**
 * 純函數：組 machine critic pass 的 critic spec。
 * = 固定審核指令（逐欄核驗值是否空殼／跨檔一致性／引用真偽／四欄輸出）
 * + 逐份（Expert id / label / 該 Expert 契約欄清單 / 交付正文）。
 * 契約欄真源 = 傳入 contracts（生產傳 DELIVERY_CONTRACTS，禁手抄第二份）。
 * 空 targets → 回空字串（呼叫端據此零派遣）。
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

const CRITIC_REJECT_WORDS = ["退回", "驳回", "駁回", "不通过", "不通過", "未通过", "未通過", "reject", "rejected"]
const CRITIC_PASS_WORDS = ["通过", "通過", "pass", "approve", "accept", "approved"]

/**
 * 純函數：critic 交付正文的 verdict 判讀。
 * 取 `verdict` 欄後緊跟片段（無則取開頭 400 字）找駁回/通過詞。
 * **保守方向**：無正文或判不出 → 視為退回（寧可多一次喚醒，不吞掉問題）。
 */
export function criticVerdictRejected(text: string): boolean {
  const src = typeof text === "string" ? text : ""
  if (!src.trim()) return true
  const m = /verdict[\s:：>*-]*([^\n]{0,80})/i.exec(src)
  const head = (m ? m[1] : src.slice(0, 400)).toLowerCase()
  if (CRITIC_REJECT_WORDS.some((w) => head.includes(w.toLowerCase()))) return true
  return !CRITIC_PASS_WORDS.some((w) => head.includes(w.toLowerCase()))
}

/**
 * 片 D（2026-09-15）：閘門 FAIL→重派時注入任務書尾部的系統性修正指令。
 * 純字符串拼裝（便於單測）：逐字點名缺失欄位 + 機器可比對判據；「其餘任務內容
 * 原樣帶過去」由調用端（subagent.ts startRework）保证——本指令是**追加**，不替换原文。
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
