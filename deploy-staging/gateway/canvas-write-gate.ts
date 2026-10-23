/**
 * canvas-write-gate.ts — 多步影音制作「画布写穿」硬闸（2026-10-11 用户裁定修画布）。
 *
 * 生产证据：媒体会话 workflow_write 覆盖率 ≈1%（ledger 有 image/video/audio 交付，
 * 但同会话几乎不调 workflow_write → 画布空灶／仅 dry_run）。评测 Wave2 A 亦实锤
 * dry_run 9/14 编译过却 has_state:false。
 *
 * 裁定三件：
 *   1) 收盘硬闸：多步影音制作意图未成功 workflow_write（非 dry_run）→ 不得完成
 *      （首期覆盖：music + 多镜视频；见 MULTI_STEP_AV_TEMPLATES / music 关键词）
 *   2) 命中意图 → 默认起画布骨架（既有 PROMPT_SKELETON／startFast）+ 注入「模型改 DSL」
 *   3) 近 N 天媒体会话 workflow_write 覆盖率发版门（tools/check-media-workflow-write-coverage.*）
 *
 * 本模组只放纯函数与文案；接线在 messages-gw（意图标记）、events-translate（写穿记账）、
 * opencode-event-handler（session.idle 收盘拦截）。
 */

/** 首期硬闸覆盖的多步影音模板（Jev／PROMPT_SKELETON 判定 id）。 */
export const MULTI_STEP_AV_TEMPLATES = new Set<string>([
  "feature_film", // 多镜成片／OP／MV／预告
  "shortdrama_visual", // 短剧／番剧工业链
  "novel_film", // 小说改编成片
  "single_video", // 单段连续视频（常与多镜分镜联用）
])

/** 音乐制作意图关键词（模板可能判 none，但仍属多步影音）。 */
const MUSIC_INTENT_RE =
  /(?:\bMV\b|\bOP\b|主题曲|片头曲|片尾曲|角色歌|作词|作曲|编曲|歌词|BGM|配乐|歌曲|音乐|专辑|单曲|FlowMusic|flowmusic|lyria)/i

/** 纯文字委托（只要歌词/文案/方案，明确不生成媒体）：不属于多步影音制作，不触发画布写穿闸。 */
const TEXT_ONLY_RE =
  /(?:只要文字|只要歌词|只写歌词|只写文字|仅要文字|只要方案|文字稿即可|不要生成|不生成音频|不要音频|不要调用\s*music_gen|不要报价)/i

/** 多镜／成片制作意图关键词（模板漏判兜底）。 */
const MULTI_SHOT_AV_RE =
  /(?:多镜|分镜|成片|长片|短剧|预告片|纪录片|广告片|宣传片|剧集|番剧|短片|storyboard|shot\s*list|镜头表)/i

export const WORKFLOW_WRITE_GATE_MARK = "【画布写穿闸·未达标】"

export interface AvIntentInput {
  templateId?: string | null
  prompt?: string | null
  /** 本会话曾派 music expert 或 planExperts 含 music */
  musicExpertSeen?: boolean
}

/** 是否命中「多步影音制作」意图（硬闸覆盖面；首期＝music + 多镜视频）。 */
export function isMultiStepAvProductionIntent(input: AvIntentInput): boolean {
  const p = typeof input.prompt === "string" ? input.prompt : ""
  // 纯文字委托不是媒体生产：不拦收盘、不逼写画布（2026-10-21 实测：歌词正文被闸门挤成「见上一条」）。
  if (p.trim() && TEXT_ONLY_RE.test(p) && !MULTI_SHOT_AV_RE.test(p)) return false
  const tid = typeof input.templateId === "string" ? input.templateId.trim() : ""
  if (tid && MULTI_STEP_AV_TEMPLATES.has(tid)) return true
  if (input.musicExpertSeen === true) return true
  if (!p.trim()) return false
  if (MUSIC_INTENT_RE.test(p)) return true
  if (MULTI_SHOT_AV_RE.test(p)) return true
  return false
}

/**
 * workflow_write 工具回执是否算「真写穿」。
 * dry_run／confirm_new_line 拒绝／ok:false → 不算；幂等「无需改动」与 queued 落盘算。
 */
export function isSuccessfulWorkflowWrite(parsed: unknown, ok: boolean): boolean {
  if (!ok) return false
  if (parsed === null || typeof parsed !== "object") {
    // 无结构化 ok 栏时上层已把 ok 当 true；保守：不算写穿（避免误放）
    return false
  }
  const o = parsed as Record<string, unknown>
  if (o.dry_run === true) return false
  // confirm_new_line 走 fail → ok 已 false；此处双保险
  if (o.code === "confirm_new_line" || o.error === "confirm_new_line") return false
  // 结构化成功：有 applied／queued／summary／new_production_line 等任一栏，或显式 ok
  if (o.ok === false) return false
  return true
}

export interface WorkflowWriteGateInput {
  avProductionIntent: boolean
  workflowWriteSucceeded: boolean
  /** 本会话已发过一次收盘补写 nudge（防死循环） */
  nudgeSent: boolean
  turnAborted?: boolean
  hasLastPromptBody?: boolean
}

/**
 * 收盘点是否应拦截 turn.done 并补写 nudge。
 * 条件：多步影音意图 + 尚未真写穿 + 尚未 nudge 过 + 有可重投的 lastPromptBody + 非用户中止。
 */
export function shouldBlockCompletionForWorkflowWrite(input: WorkflowWriteGateInput): boolean {
  if (!input.avProductionIntent) return false
  if (input.workflowWriteSucceeded) return false
  if (input.nudgeSent) return false
  if (input.turnAborted) return false
  if (!input.hasLastPromptBody) return false
  return true
}

/** 收盘补写指令（接在 user 尾端，经 TAIL_PAYLOAD_MARKER；显示通道会截掉）。 */
export function buildWorkflowWriteGateNudge(templateId?: string | null): string {
  const tpl = templateId && templateId.trim() ? `（领域模板＝\`${templateId.trim()}\`）` : ""
  return (
    `${WORKFLOW_WRITE_GATE_MARK} 本会话是多步影音制作${tpl}，收盘前必须成功调用 \`workflow_write\` 把产线 DSL **真写穿**画布` +
    `（禁止只 \`dry_run\`；新产线须 \`confirm_new_line: true\`）。` +
    `动作：① \`canvas_get_state\` 读当前 \`dsl\`（空则按意图整份交 source）；` +
    `② 改 steps／prompt 后 \`workflow_write\` 整份交回；③ 回执列节点标题清单。` +
    `未写穿不得宣称完成／不得只交 document 链接交差。现在立刻写穿，不要再派无关研究。`
  )
}

/** 开场／骨架注入：命中意图后告诉模型「骨架已起，你只改 DSL」。 */
export function buildAvCanvasSkeletonDirective(templateId: string, opts?: { planOnlyLean?: boolean }): string {
  const lean = opts?.planOnlyLean === true
  return (
    `【机器·画布写穿·默认骨架】System One 判定多步影音制作＝\`${templateId}\`${lean ? "（策划瘦身：仅 text／结构）" : ""}。` +
    `网关已按模板自动起画布骨架（PROMPT_SKELETON／DSL 可读）。规则：\n` +
    `1. 不要另起平行产线；读 \`canvas_get_state\` 的 \`dsl\`，改 steps 后用 \`workflow_write\` 整份交回（模型改 DSL，不是手拼 ops）。\n` +
    `2. 收盘硬闸：本会话未成功 \`workflow_write\`（非 dry_run）不得完成；document 链接不能代替画布写穿。\n` +
    `3. 新产线确认：工具回 \`confirm_new_line\` 时，确为有意铺线则带 \`confirm_new_line: true\` 重交。`
  )
}
