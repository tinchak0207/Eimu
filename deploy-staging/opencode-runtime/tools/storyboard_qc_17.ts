import { tool } from "@opencode-ai/plugin/tool"
import { ok, fail } from "../lib/client"
import { llmChatJson } from "../lib/llm-channel"

// 分镜 17 道 QC 门（2026-08-31 片1 实装）。
// 17 项清单权威来源 = 本地 repo PRD 源文 src/lib/shortdrama-domain/index.ts 的
// STORYBOARD_GATE_IDS + storyboardQc()（本工具逐门移植其判定逻辑），非现场推导。
// 17 门全部为代码判定（pass/block）；语义项（情绪连贯/轴线/节奏）为附加 LLM 判定段，
// 失败诚实标 unavailable，不影响 17 门结果、不编造。清单可配置：改 GATE 数组即可。

interface Shot {
  shotId: string
  sceneId?: string
  order?: number
  prompt: string
  characterCardIds: string[]
  sceneCardIds: string[]
  durationSeconds?: number
  keyframeId?: string
  lastFrameId?: string
  audioAnchorId?: string
  aspectRatio?: string
}

interface GateResult {
  id: string
  status: "pass" | "block"
  evidence: string
}

function asRecord(v: unknown): Record<string, unknown> {
  return v && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, unknown>) : {}
}
function text(v: unknown): string {
  return typeof v === "string" ? v.trim() : ""
}
function num(v: unknown): number | undefined {
  const n = typeof v === "number" ? v : typeof v === "string" ? Number(v) : NaN
  return Number.isFinite(n) ? n : undefined
}
function strArr(v: unknown): string[] {
  return Array.isArray(v) ? v.filter((x): x is string => typeof x === "string") : []
}

function parseShots(input: string): { shots?: Shot[]; reason?: string } {
  const trimmed = input.trim()
  if (!trimmed) return { reason: "shots 为空" }
  let parsed: unknown = null
  try {
    parsed = JSON.parse(trimmed)
  } catch {
    parsed = null
  }
  const rawList: unknown[] | null = Array.isArray(parsed)
    ? parsed
    : parsed && typeof parsed === "object" && Array.isArray((parsed as Record<string, unknown>).shots)
      ? ((parsed as Record<string, unknown>).shots as unknown[])
      : null
  if (rawList) {
    const shots: Shot[] = rawList.map((item, i) => {
      const r = asRecord(item)
      return {
        shotId: text(r.shotId) || text(r.id) || `S${i + 1}`,
        sceneId: text(r.sceneId) || undefined,
        order: num(r.order) ?? i + 1,
        prompt: text(r.prompt) || text(r.description) || text(r.content),
        characterCardIds: strArr(r.characterCardIds ?? r.characters),
        sceneCardIds: strArr(r.sceneCardIds ?? r.scenes),
        durationSeconds: num(r.durationSeconds ?? r.duration),
        keyframeId: text(r.keyframeId) || undefined,
        lastFrameId: text(r.lastFrameId) || undefined,
        audioAnchorId: text(r.audioAnchorId) || undefined,
        aspectRatio: text(r.aspectRatio) || undefined,
      }
    })
    if (!shots.length) return { reason: "shots JSON 为空数组" }
    return { shots }
  }
  // 纯文本回退：每行一镜，可选「序号. 」前缀与「N秒」时长
  const lines = trimmed.split(/\r?\n/).map((l) => l.trim()).filter(Boolean)
  if (!lines.length) return { reason: "shots 既不是合法 JSON 也不是可解析文本" }
  const shots: Shot[] = lines.map((line, i) => {
    const dur = line.match(/(\d+(?:\.\d+)?)\s*(?:s|秒)/i)
    const stripped = line.replace(/^\d+\s*[.、．:：]\s*/, "")
    return {
      shotId: `S${i + 1}`,
      order: i + 1,
      prompt: stripped,
      characterCardIds: [],
      sceneCardIds: [],
      durationSeconds: dur ? Number(dur[1]) : undefined,
    }
  })
  return { shots }
}

function gate(id: string, passed: boolean, evidence: string): GateResult {
  return { id, status: passed ? "pass" : "block", evidence }
}

const MIN_SHOT_SECONDS = 10

function inBounds_ok(offenders: string[], shots: Shot[]): string {
  if (shots.length === 0 || offenders.length === 0) return `单镜 ${MIN_SHOT_SECONDS}-30 秒（按条计费：单镜尽量打满模型最大档）`
  const detail = offenders.map((id) => `${id}(${shots.find((s) => s.shotId === id)?.durationSeconds ?? "缺失"}s)`).join(", ")
  return `duration_bounds 不通过：单镜须 ${MIN_SHOT_SECONDS}-30 秒，严禁 <${MIN_SHOT_SECONDS} 秒短档（硬规则，见 workflow-video-rules §4b）；不足请并入前一镜或加长至 ${MIN_SHOT_SECONDS}s 以上。越界/缺失：${detail}`
}

function runGates(shots: Shot[], lockedCharacters: Set<string>, lockedScenes: Set<string>, segmentDuration: number | undefined): GateResult[] {
  const uniqueIds = new Set(shots.map((s) => s.shotId))
  const ordered = shots.every((s, i) => s.order === i + 1)
  const every = (fn: (s: Shot) => boolean) => shots.length > 0 && shots.every(fn)
  const bad = (fn: (s: Shot) => boolean) => shots.filter((s) => !fn(s)).map((s) => s.shotId).slice(0, 10)
  const inBounds = (s: Shot) => (s.durationSeconds ?? 0) >= MIN_SHOT_SECONDS && (s.durationSeconds ?? 0) <= 30
  const totalDuration = shots.reduce((sum, s) => sum + (s.durationSeconds || 0), 0)
  return [
    gate("shot_identity", every((s) => Boolean(s.shotId)) && uniqueIds.size === shots.length, `镜号唯一且非空（${shots.length} 镜）`),
    gate("shot_order", ordered, ordered ? "镜号连续 1..N" : `镜号序列不连续：${shots.map((s) => s.order ?? "?").join("→")}`),
    gate("scene_binding", every((s) => Boolean(s.sceneId)), every((s) => Boolean(s.sceneId)) ? "每镜绑定场次" : `缺 sceneId：${bad((s) => Boolean(s.sceneId)).join(", ")}`),
    // 2026-09-20 暴君裁定：上游视频按条计费（5/15/30s 同价），按条秒数最大化才划算。
    // 单镜上限 2→30s（允许打满 seedance-2.5 480p/30s 固定档；2.0 档 10-15s 同样在界内）。
    // 2026-10-02 H7：AGENTS.md 硬规则「严禁 <10 秒短档」（workflow-video-rules §4b）机器化；每镜=一条上游计费单位，无题材/镜头例外，末镜余数亦不豁免（须并入前一镜或明确说明）。
    gate("duration_bounds", every(inBounds), inBounds_ok(bad(inBounds), shots)),
    // 段长去 15s 上限：总长由创作需求决定，门禁只验「已声明且为正」；拆条打满档位是分镜纪律不是门禁。
    gate("segment_duration", (segmentDuration ?? 0) > 0, `段长已声明（输入 ${segmentDuration ?? "未填"}s；分镜总长 ${Math.round(totalDuration * 10) / 10}s；拆条打满最大档，例 80s → 30+30+20）`),
    gate("prompt_present", every((s) => Boolean(s.prompt)), every((s) => Boolean(s.prompt)) ? "每镜有 prompt" : `缺 prompt：${bad((s) => Boolean(s.prompt)).join(", ")}`),
    gate("characters_bound", every((s) => s.characterCardIds.length > 0), every((s) => s.characterCardIds.length > 0) ? "每镜绑角色卡" : `缺角色绑定：${bad((s) => s.characterCardIds.length > 0).join(", ")}`),
    gate("scenes_bound", every((s) => s.sceneCardIds.length > 0), every((s) => s.sceneCardIds.length > 0) ? "每镜绑场景卡" : `缺场景绑定：${bad((s) => s.sceneCardIds.length > 0).join(", ")}`),
    gate("character_lock", every((s) => s.characterCardIds.every((id) => lockedCharacters.has(id))), every((s) => s.characterCardIds.every((id) => lockedCharacters.has(id))) ? "角色引用全部命中锁定卡" : `引用未锁定角色卡：${bad((s) => s.characterCardIds.every((id) => lockedCharacters.has(id))).join(", ")}`),
    gate("scene_lock", every((s) => s.sceneCardIds.every((id) => lockedScenes.has(id))), every((s) => s.sceneCardIds.every((id) => lockedScenes.has(id))) ? "场景引用全部命中锁定卡" : `引用未锁定场景卡：${bad((s) => s.sceneCardIds.every((id) => lockedScenes.has(id))).join(", ")}`),
    gate("keyframe_present", every((s) => Boolean(s.keyframeId)), every((s) => Boolean(s.keyframeId)) ? "每镜有关键帧" : `缺 keyframeId：${bad((s) => Boolean(s.keyframeId)).join(", ")}`),
    gate("last_frame_present", every((s) => Boolean(s.lastFrameId)), every((s) => Boolean(s.lastFrameId)) ? "每镜有尾帧" : `缺 lastFrameId：${bad((s) => Boolean(s.lastFrameId)).join(", ")}`),
    gate("audio_anchor_present", every((s) => Boolean(s.audioAnchorId)), every((s) => Boolean(s.audioAnchorId)) ? "每镜有音讯锚点" : `缺 audioAnchorId：${bad((s) => Boolean(s.audioAnchorId)).join(", ")}`),
    gate("aspect_ratio", every((s) => s.aspectRatio === "9:16" || s.aspectRatio === "16:9" || s.aspectRatio === "1:1"), `交付比例限 9:16/16:9/1:1；不合规：${bad((s) => s.aspectRatio === "9:16" || s.aspectRatio === "16:9" || s.aspectRatio === "1:1").join(", ") || "无"}`),
    gate("dialogue_alignment", every((s) => Boolean(s.audioAnchorId)), "台词/音讯锚点对齐（同 audio_anchor 口径）"),
    gate("continuity", every((s) => Boolean(s.keyframeId && s.lastFrameId)), "连戏引用存在（关键帧+尾帧）"),
    gate("export_readiness", every((s) => Boolean(s.shotId && s.prompt && (s.durationSeconds ?? 0) > 0)), "可导出性（id+prompt+时长齐备）"),
  ]
}

const SEMANTIC_SYSTEM = [
  "你是短剧分镜语义质检员。给定有序分镜清单，判定三个语义项：",
  "mood_continuity（情绪曲线连贯）、axis_consistency（镜头轴线/方位不跳）、pacing（快慢节奏合理）。",
  '只输出 JSON：{"mood_continuity":{"verdict":"pass|warn|block","note":"≤40字"},"axis_consistency":{...},"pacing":{...}}',
  "只依据清单文字判定，证据不足给 warn 并在 note 说明缺什么。",
].join("\n")

export default tool({
  description:
    "分镜 17 道 QC 门（10-30 秒单镜（严禁 <10 秒）/段长须声明（拆条打满模型最大档）/镜号连续/角色场景卡锁定/关键帧尾帧音讯锚点/交付比例等，17 项清单移植自 PRD 源文 shortdrama-domain，逐门代码判定 pass/block+证据）。shots 填分镜表 JSON（阵列或 {shots:[...]}，栏位 shotId/order/sceneId/prompt/durationSeconds/characterCardIds/sceneCardIds/keyframeId/lastFrameId/audioAnchorId/aspectRatio），也接受每行一镜的纯文本。另附 LLM 语义判定段（情绪连贯/轴线/节奏，失败诚实标 unavailable）。ready=true 才可进关键帧渲染。",
  args: {
    shots: tool.schema.string().describe("分镜表：JSON 字串或每行一镜的纯文本"),
    locked_character_card_ids: tool.schema.string().optional().describe("已锁定角色卡 id，JSON 阵列字串或逗号分隔"),
    locked_scene_card_ids: tool.schema.string().optional().describe("已锁定场景卡 id，JSON 阵列字串或逗号分隔"),
    segment_duration_seconds: tool.schema.number().optional().describe("目标段长（秒），须为正数（总长不限；拆条打满模型最大档，例 80s → 30+30+20）"),
    llm_semantic: tool.schema.boolean().optional().describe("是否附加 LLM 语义判定（默认 true）"),
  },
  async execute(args) {
    const parsed = parseShots(String(args.shots ?? ""))
    if (!parsed.shots) return fail("invalid_shots", parsed.reason || "shots 无法解析", { title: "输入非法" })
    const shots = parsed.shots

    const idList = (v?: string): Set<string> => {
      if (!v) return new Set()
      try {
        const j = JSON.parse(v)
        if (Array.isArray(j)) return new Set(j.filter((x): x is string => typeof x === "string"))
      } catch {
        /* 逗号分隔回退 */
      }
      return new Set(v.split(/[，,\s]+/).map((s) => s.trim()).filter(Boolean))
    }

    const gates = runGates(shots, idList(args.locked_character_card_ids), idList(args.locked_scene_card_ids), args.segment_duration_seconds)
    const blocked = gates.filter((g) => g.status === "block")
    const ready = blocked.length === 0

    let semantic: Record<string, unknown> = { status: "skipped" }
    if (args.llm_semantic !== false) {
      const list = shots
        .map((s) => `${s.order}. [${s.shotId}] ${s.durationSeconds ?? "?"}s ${s.aspectRatio || ""} ${s.prompt.slice(0, 80)}`)
        .join("\n")
        .slice(0, 6000)
      const r = await llmChatJson(SEMANTIC_SYSTEM, `分镜清单（共 ${shots.length} 镜）：\n${list}`, 2000)
      semantic = r.ok
        ? { status: "ok", ...r.data }
        : { status: "unavailable", reason: r.reason }
    }

    return ok({
      title: `分镜 QC：${gates.length - blocked.length}/17 通过`,
      gates,
      gates_total: gates.length,
      gates_passed: gates.length - blocked.length,
      gates_blocked: blocked.map((g) => g.id),
      ready,
      shot_count: shots.length,
      semantic,
      note: "17 项清单来源：PRD 源文 src/lib/shortdrama-domain/index.ts STORYBOARD_GATE_IDS（代码移植，可配置）",
    })
  },
})
