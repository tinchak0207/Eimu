import { tool } from "@opencode-ai/plugin/tool"
import { ok, fail } from "../lib/client"
import { llmChatJson } from "../lib/llm-channel"

// 分鏡 17 道 QC 門（2026-08-31 片1 實裝）。
// 17 項清單權威來源 = 本地 repo PRD 源文 src/lib/shortdrama-domain/index.ts 的
// STORYBOARD_GATE_IDS + storyboardQc()（本工具逐門移植其判定邏輯），非現場推導。
// 17 門全部為代碼判定（pass/block）；語義項（情緒連貫/軸線/節奏）為附加 LLM 判定段，
// 失敗誠實標 unavailable，不影響 17 門結果、不編造。清單可配置：改 GATE 數組即可。

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
  if (!trimmed) return { reason: "shots 為空" }
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
    if (!shots.length) return { reason: "shots JSON 為空數組" }
    return { shots }
  }
  // 純文本回退：每行一鏡，可選「序號. 」前綴與「N秒」時長
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
  if (shots.length === 0 || offenders.length === 0) return `單鏡 ${MIN_SHOT_SECONDS}-30 秒（按條計費：單鏡儘量打滿模型最大檔）`
  const detail = offenders.map((id) => `${id}(${shots.find((s) => s.shotId === id)?.durationSeconds ?? "缺失"}s)`).join(", ")
  return `duration_bounds 不通過：單鏡須 ${MIN_SHOT_SECONDS}-30 秒，嚴禁 <${MIN_SHOT_SECONDS} 秒短檔（硬規則，見 workflow-video-rules §4b）；不足請併入前一鏡或加長至 ${MIN_SHOT_SECONDS}s 以上。越界/缺失：${detail}`
}

function runGates(shots: Shot[], lockedCharacters: Set<string>, lockedScenes: Set<string>, segmentDuration: number | undefined): GateResult[] {
  const uniqueIds = new Set(shots.map((s) => s.shotId))
  const ordered = shots.every((s, i) => s.order === i + 1)
  const every = (fn: (s: Shot) => boolean) => shots.length > 0 && shots.every(fn)
  const bad = (fn: (s: Shot) => boolean) => shots.filter((s) => !fn(s)).map((s) => s.shotId).slice(0, 10)
  const inBounds = (s: Shot) => (s.durationSeconds ?? 0) >= MIN_SHOT_SECONDS && (s.durationSeconds ?? 0) <= 30
  const totalDuration = shots.reduce((sum, s) => sum + (s.durationSeconds || 0), 0)
  return [
    gate("shot_identity", every((s) => Boolean(s.shotId)) && uniqueIds.size === shots.length, `鏡號唯一且非空（${shots.length} 鏡）`),
    gate("shot_order", ordered, ordered ? "鏡號連續 1..N" : `鏡號序列不連續：${shots.map((s) => s.order ?? "?").join("→")}`),
    gate("scene_binding", every((s) => Boolean(s.sceneId)), every((s) => Boolean(s.sceneId)) ? "每鏡綁定場次" : `缺 sceneId：${bad((s) => Boolean(s.sceneId)).join(", ")}`),
    // 2026-09-20 暴君裁定：上游視頻按條計費（5/15/30s 同價），按條秒數最大化才划算。
    // 單鏡上限 2→30s（允許打滿 seedance-2.5 480p/30s 固定檔；2.0 檔 10-15s 同樣在界內）。
    // 2026-10-02 H7：AGENTS.md 硬規則「嚴禁 <10 秒短檔」（workflow-video-rules §4b）機器化；每鏡=一條上游計費單位，無題材/鏡頭例外，末鏡餘數亦不豁免（須併入前一鏡或明確說明）。
    gate("duration_bounds", every(inBounds), inBounds_ok(bad(inBounds), shots)),
    // 段長去 15s 上限：總長由創作需求決定，門禁只驗「已聲明且為正」；拆條打滿檔位是分鏡紀律不是門禁。
    gate("segment_duration", (segmentDuration ?? 0) > 0, `段長已聲明（輸入 ${segmentDuration ?? "未填"}s；分鏡總長 ${Math.round(totalDuration * 10) / 10}s；拆條打滿最大檔，例 80s → 30+30+20）`),
    gate("prompt_present", every((s) => Boolean(s.prompt)), every((s) => Boolean(s.prompt)) ? "每鏡有 prompt" : `缺 prompt：${bad((s) => Boolean(s.prompt)).join(", ")}`),
    gate("characters_bound", every((s) => s.characterCardIds.length > 0), every((s) => s.characterCardIds.length > 0) ? "每鏡綁角色卡" : `缺角色綁定：${bad((s) => s.characterCardIds.length > 0).join(", ")}`),
    gate("scenes_bound", every((s) => s.sceneCardIds.length > 0), every((s) => s.sceneCardIds.length > 0) ? "每鏡綁場景卡" : `缺場景綁定：${bad((s) => s.sceneCardIds.length > 0).join(", ")}`),
    gate("character_lock", every((s) => s.characterCardIds.every((id) => lockedCharacters.has(id))), every((s) => s.characterCardIds.every((id) => lockedCharacters.has(id))) ? "角色引用全部命中鎖定卡" : `引用未鎖定角色卡：${bad((s) => s.characterCardIds.every((id) => lockedCharacters.has(id))).join(", ")}`),
    gate("scene_lock", every((s) => s.sceneCardIds.every((id) => lockedScenes.has(id))), every((s) => s.sceneCardIds.every((id) => lockedScenes.has(id))) ? "場景引用全部命中鎖定卡" : `引用未鎖定場景卡：${bad((s) => s.sceneCardIds.every((id) => lockedScenes.has(id))).join(", ")}`),
    gate("keyframe_present", every((s) => Boolean(s.keyframeId)), every((s) => Boolean(s.keyframeId)) ? "每鏡有關鍵幀" : `缺 keyframeId：${bad((s) => Boolean(s.keyframeId)).join(", ")}`),
    gate("last_frame_present", every((s) => Boolean(s.lastFrameId)), every((s) => Boolean(s.lastFrameId)) ? "每鏡有尾幀" : `缺 lastFrameId：${bad((s) => Boolean(s.lastFrameId)).join(", ")}`),
    gate("audio_anchor_present", every((s) => Boolean(s.audioAnchorId)), every((s) => Boolean(s.audioAnchorId)) ? "每鏡有音訊錨點" : `缺 audioAnchorId：${bad((s) => Boolean(s.audioAnchorId)).join(", ")}`),
    gate("aspect_ratio", every((s) => s.aspectRatio === "9:16" || s.aspectRatio === "16:9" || s.aspectRatio === "1:1"), `交付比例限 9:16/16:9/1:1；不合規：${bad((s) => s.aspectRatio === "9:16" || s.aspectRatio === "16:9" || s.aspectRatio === "1:1").join(", ") || "無"}`),
    gate("dialogue_alignment", every((s) => Boolean(s.audioAnchorId)), "台詞/音訊錨點對齊（同 audio_anchor 口徑）"),
    gate("continuity", every((s) => Boolean(s.keyframeId && s.lastFrameId)), "連戲引用存在（關鍵幀+尾幀）"),
    gate("export_readiness", every((s) => Boolean(s.shotId && s.prompt && (s.durationSeconds ?? 0) > 0)), "可導出性（id+prompt+時長齊備）"),
  ]
}

const SEMANTIC_SYSTEM = [
  "你是短劇分鏡語義質檢員。給定有序分鏡清單，判定三個語義項：",
  "mood_continuity（情緒曲線連貫）、axis_consistency（鏡頭軸線/方位不跳）、pacing（快慢節奏合理）。",
  '只輸出 JSON：{"mood_continuity":{"verdict":"pass|warn|block","note":"≤40字"},"axis_consistency":{...},"pacing":{...}}',
  "只依據清單文字判定，證據不足給 warn 並在 note 說明缺什麼。",
].join("\n")

export default tool({
  description:
    "分鏡 17 道 QC 門（10-30 秒單鏡（嚴禁 <10 秒）/段長須聲明（拆條打滿模型最大檔）/鏡號連續/角色場景卡鎖定/關鍵幀尾幀音訊錨點/交付比例等，17 項清單移植自 PRD 源文 shortdrama-domain，逐門代碼判定 pass/block+證據）。shots 填分鏡表 JSON（陣列或 {shots:[...]}，欄位 shotId/order/sceneId/prompt/durationSeconds/characterCardIds/sceneCardIds/keyframeId/lastFrameId/audioAnchorId/aspectRatio），也接受每行一鏡的純文本。另附 LLM 語義判定段（情緒連貫/軸線/節奏，失敗誠實標 unavailable）。ready=true 才可進關鍵幀渲染。",
  args: {
    shots: tool.schema.string().describe("分鏡表：JSON 字串或每行一鏡的純文本"),
    locked_character_card_ids: tool.schema.string().optional().describe("已鎖定角色卡 id，JSON 陣列字串或逗號分隔"),
    locked_scene_card_ids: tool.schema.string().optional().describe("已鎖定場景卡 id，JSON 陣列字串或逗號分隔"),
    segment_duration_seconds: tool.schema.number().optional().describe("目標段長（秒），須為正數（總長不限；拆條打滿模型最大檔，例 80s → 30+30+20）"),
    llm_semantic: tool.schema.boolean().optional().describe("是否附加 LLM 語義判定（默認 true）"),
  },
  async execute(args) {
    const parsed = parseShots(String(args.shots ?? ""))
    if (!parsed.shots) return fail("invalid_shots", parsed.reason || "shots 無法解析", { title: "輸入非法" })
    const shots = parsed.shots

    const idList = (v?: string): Set<string> => {
      if (!v) return new Set()
      try {
        const j = JSON.parse(v)
        if (Array.isArray(j)) return new Set(j.filter((x): x is string => typeof x === "string"))
      } catch {
        /* 逗號分隔回退 */
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
      const r = await llmChatJson(SEMANTIC_SYSTEM, `分鏡清單（共 ${shots.length} 鏡）：\n${list}`, 2000)
      semantic = r.ok
        ? { status: "ok", ...r.data }
        : { status: "unavailable", reason: r.reason }
    }

    return ok({
      title: `分鏡 QC：${gates.length - blocked.length}/17 通過`,
      gates,
      gates_total: gates.length,
      gates_passed: gates.length - blocked.length,
      gates_blocked: blocked.map((g) => g.id),
      ready,
      shot_count: shots.length,
      semantic,
      note: "17 項清單來源：PRD 源文 src/lib/shortdrama-domain/index.ts STORYBOARD_GATE_IDS（代碼移植，可配置）",
    })
  },
})
