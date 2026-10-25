import type { CriticScoreSource } from "./persistence.ts"
import { extractMediaTargets } from "./media-quality.ts"
import type { CriticPassInput, CriticPassTarget, DeliveryContracts } from "./delivery-gate-types.ts"

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
export function contractFieldsOf(agent: string, contracts: DeliveryContracts): string[] {
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

/** 冲突判决的拒收码（唯一真源；呼叫点据此留日志/回执）。 */
export const CRITIC_VERDICT_CONFLICT_CODE = "critic_verdict_conflict"

export interface VerdictConflict {
  conflict: true
  pass: string
  other: string
}

/** 找第一个「非否定式」的 PASS 词：未通过／不通过／没有通过／无法通过 不算 PASS。 */
function findPassVerdictTokenAt(src: string): { token: string; index: number } | null {
  // 正则一律本地新建（不复用带 g 的物件，避免 lastIndex 跨呼叫污染）。
  const cjk = /通过/g
  for (let m = cjk.exec(src); m; m = cjk.exec(src)) {
    const before = src.slice(Math.max(0, m.index - 3), m.index)
    if (/(?:未|不|没|无法|没有)\s*$/.test(before)) continue
    return { token: m[0], index: m.index }
  }
  const en = /\b(?:PASS|PASSED|APPROVED)\b/gi
  const e = en.exec(src)
  if (e) {
    const before = src.slice(Math.max(0, e.index - 8), e.index).toLowerCase()
    if (!/(?:\bnot|\bno|未|不)\s*$/.test(before)) return { token: e[0], index: e.index }
  }
  return null
}

function findPassVerdictToken(src: string): string {
  const hit = findPassVerdictTokenAt(src)
  return hit ? hit.token : ""
}

/** 找第一个非 PASS 判决词：PARTIAL/部分/FAIL/退回/不通过/未通过（含英文同义）。 */
function findNonPassVerdictToken(src: string): string {
  const cjk = /部分|退回|驳回|不通过|未通过/g
  const c = cjk.exec(src)
  if (c) return c[0]
  const en = /\b(?:PARTIAL|FAIL|FAILED|FAILURE|REJECT|REJECTED)\b/gi
  const e = en.exec(src)
  return e ? e[0] : ""
}

/** 结构化判定行：`verdict/结论/判定/评审结论` **带冒号**，或关键字后**紧跟判定词**（无冒号形态）。
 *  2026-10-21 修正：裸 `结论` 让 issues 行 `结论无重大问题；部分素材待补` 被当成第二判定行 →
 *  PASS 误拒；判定行必须显式 `结论：` 才算判定。
 *  2026-10-21 二次修正：实测 `verdict: PASS\n结论 部分通过` 无冒号 → 漏判、PARTIAL 被当 PASS 放行；
 *  补「关键字 + 判定词」形态。判定词后仍须紧跟判定词作为锚点：`结论无重大问题` 后没有判定词 → 不匹配，
 *  不重新引入 issues 散文误判。 */
const VERDICT_LINE_RE =
  /(?:verdict|结论|判定|评审结论)\s*(?:[:：]\s*([^\n]{0,160})|((?:PASS|PARTIAL|FAIL|FAILED|FAILURE|REJECT|REJECTED|通过|部分通过|不通过|未通过|驳回|退回)[^\n]{0,160}))/gi
/** 独立判定 token 行：整行只有 PASS/PARTIAL/FAIL/REJECT（大小写不敏感）。 */
const STANDALONE_VERDICT_RE = /^\s*(PASS|PARTIAL|FAIL|REJECT)\s*$/gim

/** PASS 判决后的说明性尾注分隔符（破折号/冒号）：尾注是备注，不是第二个判决。 */
const VERDICT_TAIL_DELIM_RE = /^\s*(?:——|—|-|：|:)/
/** 尾注里出现这些词仍视为真冲突（不只是备注）。 */
const VERDICT_TAIL_CONFLICT_RE = /驳回|退回|不通过|未通过|\b(?:PARTIAL|FAIL|FAILED|FAILURE|REJECT|REJECTED)\b/i

/**
 * 纯函数（C2，2026-10-21）：**只认结构化判定**，不认散文。
 * 先抓「verdict/结论/判定」判定行与独立 token 行，再逐行找 PASS/非 PASS：
 *  - 同一行或不同判定行同时出现 PASS 与非 PASS → 判决自相矛盾，返回首个命中词对；
 *  - 只有一侧、或整份 payload 没有结构化判定 → null（保持「找不到 pass 就不拒」既有语义）。
 *
 * 病灶（2026-10-21 实测）：旧版全篇扫 `部分|退回|驳回|不通过|未通过`，普通散文
 * 「这部分素材…」与 PASS 同现即误判 critic_verdict_conflict 拒收正当评审。
 * 另：pack-0014、pack-0122 等实测「同一份评审里 PASS 与 PARTIAL/FAIL 并存」，
 * 既有 criticVerdictRejected 只看 `verdict` 栏后 80 字 → 冲突 payload 被判 PASS，矛盾结论照样放行。
 * 2026-10-21 二次 Hack：`结论：通过 — 部分镜头偏暗` 的破折号尾注是备注，不是 PARTIAL 判决；
 * PASS 后紧跟 `—|——|-|：|:` 时只扫尾注之前判非 PASS（尾注含 驳回/退回/不通过/未通过/FAIL/REJECT
 * 仍算冲突）。`结论：部分通过` 的「部分」在 PASS 之前，照旧冲突。
 */
export function conflictingVerdicts(text: string): VerdictConflict | null {
  const src = typeof text === "string" ? text : ""
  if (!src.trim()) return null
  let pass = ""
  let other = ""
  const noteLine = (line: string): void => {
    // 2026-10-21 Hack：先剥掉括号备注再扫判决。「结论：通过（部分镜头偏暗）」里的
    // 「部分」是评审备注不是判决，旧版与 PASS 同现即误判 critic_verdict_conflict。
    const stripped = line.replace(/（[^）]*）|\([^)]*\)/g, "")
    let otherSource = stripped
    const hit = findPassVerdictTokenAt(stripped)
    if (hit) {
      const afterPass = stripped.slice(hit.index + hit.token.length)
      const delim = VERDICT_TAIL_DELIM_RE.exec(afterPass)
      if (delim) {
        const tail = afterPass.slice(delim[0].length)
        const tailConflict = VERDICT_TAIL_CONFLICT_RE.exec(tail)
        if (tailConflict) {
          if (!pass) pass = hit.token
          if (!other) other = tailConflict[0]
          return
        }
        // 说明性尾注不含冲突词：只扫 PASS 之前的部分判非 PASS。
        otherSource = stripped.slice(0, hit.index)
      }
    }
    if (!pass) pass = findPassVerdictToken(stripped)
    if (!other) other = findNonPassVerdictToken(otherSource)
  }
  for (const m of src.matchAll(VERDICT_LINE_RE)) noteLine(m[1] ?? m[2] ?? "")
  for (const m of src.matchAll(STANDALONE_VERDICT_RE)) noteLine(m[1] ?? "")
  if (!pass || !other) return null
  return { conflict: true, pass, other }
}

/**
 * 纯函数：critic 交付正文的 verdict 判读。
 * 取 `verdict` 栏后紧跟片段（无则取开头 400 字）找驳回/通过词。
 * **保守方向**：无正文或判不出 → 视为退回（宁可多一次唤醒，不吞掉问题）。
 * C2：整份 payload 自相矛盾（PASS 与 PARTIAL/FAIL 并存）→ 一律退回；干净 payload 行为不变。
 */
export function criticVerdictRejected(text: string): boolean {
  const src = typeof text === "string" ? text : ""
  if (!src.trim()) return true
  if (conflictingVerdicts(src) !== null) return true
  const m = /verdict[\s:：>*-]*([^\n]{0,80})/i.exec(src)
  const rawHead = m ? m[1] : src.slice(0, 400)
  // 2026-10-21 Hack：`VERDICT: PASS (PARTIAL)` 的括号内是备注，旧版不剥括号 → 判 PARTIAL 拒收。
  const head = rawHead.replace(/（[^）]*）|\([^)]*\)/g, "").toLowerCase()
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
