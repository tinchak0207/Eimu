// 影片翻拍计画（解析 → 切段 → 角色替换确认）——本机优先、零付费、fail-closed。
//
// 形态来源（不另造轮子）：
//   ① 解析（场景／台词）→ 复用 lib/video-analyze.ts 的 analyzeVideo：场景＝visualBoundaries 的
//      机械式相邻帧变化候选＋segmentScenes 去抖动；台词＝lib/asr.ts 的本机 loopback ASR 词级时间轴；
//      提示词反推＝VLM，本机无零付费通道时照 video-analyze 的既有形状回 vlm_unavailable，**不编造**。
//   ② 切段 → 同一份 boundaries 的场景 ＋ 复用 lib/video-evidence.ts 的 cutSpans 真的切出短片段
//      （真正的输出时长由 cutSpans 重新 probe 回报，不是请求值）。
//   ③ 角色／场景候选 → 由**台词轮次与场景归属聚合**。本机无 speaker diarization、无人脸辨识、
//      无 VLM ⇒ 不判「谁说的」、不编造角色姓名、不编造新角色/新场景提示词（照 video-analyze 的诚实口径）。
//   ④ 生成 → **本档只产生待确认清单**：不自动替换、不呼叫任何生成、不发出任何付费上游请求。
//
// 本档不是 tool，不得 export tool 定义。

import { analyzeVideo, segmentScenes, type AnalyzeResult, type Scene } from "./video-analyze"
import { cutSpans, probeMedia, requireVideo } from "./video-evidence"

function round(value: number): number {
  return Number(value.toFixed(3))
}

function errMsg(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

function sceneId(index: number): string {
  return `scene-${String(index).padStart(3, "0")}`
}

// ─────────────────────────────────────────── 台词轮次与角色／场景候选

export interface RemakeTurn {
  index: number
  start?: number
  end?: number
  text: string
  word_count: number
  /** 该轮次起始时间所落的场景 id；轮次无时间戳时缺席（不猜）。 */
  scene_id?: string
}

export interface RemakeScene {
  id: string
  index: number
  start: number
  end: number
  /** 场景中点（代表帧请求时间）。 */
  at: number
  frame_path?: string
  frame_actual_at?: number
  frame_error?: string
  /** 落在本场景内的台词轮次索引。 */
  dialogue_turn_ids: number[]
  has_speech: boolean
}

/**
 * 角色候选：**由台词轮次与场景归属聚合**，一个「有台词的场景」聚成一个候选槽。
 * 本机无 diarization ⇒ 同一槽内多个轮次无法判定是否同一人、也无法判定姓名（name 保持 null）。
 */
export interface RemakeCharacterCandidate {
  id: string
  /** 永远是 null：本机无 diarization／人脸辨识／VLM，不编造角色姓名。 */
  name: null
  name_source: "undetermined"
  scene_id?: string
  frame_path?: string
  frame_actual_at?: number
  dialogue_turn_ids: number[]
  evidence: string
  identity_note: string
}

// ─────────────────────────────────────────── 切段

export interface SegmentPlan {
  id: string
  start: number
  end: number
  duration: number
  scene_ids: string[]
}

/**
 * 把场景清单聚成「适合 AI 重生的短片段」：相邻场景在 `targetSeconds` 之前持续并入，
 * 但任一并入都不得让段落超过 `maxSeconds`。单一场景本身超长时**不假装切得开**——
 * 原样成段并记在 oversize（要再切需要新的变化候选，不是本工具可以无中生有的）。
 */
export function planSegments(
  scenes: readonly Scene[],
  targetSeconds: number,
  maxSeconds: number,
): { segments: SegmentPlan[]; oversize: number[] } {
  const plans: { start: number; end: number; sceneIds: number[] }[] = []
  for (const scene of scenes) {
    const current = plans.at(-1)
    if (current === undefined) {
      plans.push({ start: scene.start, end: scene.end, sceneIds: [scene.index] })
      continue
    }
    const currentDuration = current.end - current.start
    const mergeable = scene.end - scene.start <= maxSeconds
      && scene.end - current.start <= maxSeconds
      && currentDuration < targetSeconds
    if (mergeable) {
      current.end = scene.end
      current.sceneIds.push(scene.index)
      continue
    }
    plans.push({ start: scene.start, end: scene.end, sceneIds: [scene.index] })
  }
  const oversize: number[] = []
  const segments: SegmentPlan[] = plans.map((plan, position) => {
    const duration = round(plan.end - plan.start)
    if (plan.sceneIds.length === 1 && duration > maxSeconds) oversize.push(plan.sceneIds[0]!)
    return {
      id: `segment-${String(position + 1).padStart(3, "0")}`,
      start: round(plan.start),
      end: round(plan.end),
      duration,
      scene_ids: plan.sceneIds.map((index) => sceneId(index)),
    }
  })
  return { segments, oversize }
}

export interface RemakeClip {
  path: string
  /** cutSpans 重新 probe 输出档得到的实际时长（不是请求值）。 */
  actual_seconds: number
  has_video: boolean
  has_audio: boolean
}

export interface RemakeSegment extends SegmentPlan {
  dialogue_turn_ids: number[]
  frame_path?: string
  frame_actual_at?: number
  clip?: RemakeClip
  clip_error?: string
}

// ─────────────────────────────────────────── 待确认清单

export type RemakeConfirmationAction = "confirm" | "reject" | "rename"

export interface RemakeConfirmationItem {
  id: string
  kind: "character" | "scene"
  original: {
    name: string | null
    name_source: string
    frame_path?: string
    frame_actual_at?: number
    scene_id?: string
    start?: number
    end?: number
    evidence: string
  }
  inferred: {
    status: "needs_vision_model"
    code: string
    reason: string
    new_name: null
    new_prompt: null
  }
  allowed_actions: readonly RemakeConfirmationAction[]
  /** 本工具只出清单，永不自动套用（不替换、不生成）。 */
  applied: false
}

// ─────────────────────────────────────────── 主流程

export interface RemakePlanOptions {
  /** 代表帧输出目录（必须可写；由呼叫端建立）。 */
  frames_dir: string
  /** 短片段输出目录。 */
  out_dir: string
  /** 目标段长（秒），预设 5。 */
  target_seconds?: number
  /** 单段上限（秒），预设 10。 */
  max_seconds?: number
  scene_rate?: number
  scene_threshold?: number
  max_scenes?: number
  language?: string
  max_audio_seconds?: number
  /** false＝只出计画不切档（除错用）；预设 true。 */
  cut?: boolean
  signal?: AbortSignal
}

export interface RemakePlanResult {
  ok: true
  format: "eimu.video-remake-plan@1"
  source: string
  media: AnalyzeResult["media"]
  parse: {
    scenes: {
      count: number
      boundary_count: number
      ignored_boundaries: number
      frames_extracted: number
      items: RemakeScene[]
      note: string
    }
    dialogue: {
      ok: boolean
      provider?: string
      model?: string
      language?: string
      audio_seconds?: number
      word_count: number
      turn_count: number
      code?: string
      reason?: string
      probed?: readonly string[]
      speaker_identity: "undetermined"
      turns: RemakeTurn[]
      note: string
    }
    cast: {
      count: number
      items: RemakeCharacterCandidate[]
      note: string
    }
  }
  segments: {
    target_seconds: number
    max_seconds: number
    count: number
    cut: boolean
    items: RemakeSegment[]
    oversize_scenes: number[]
    note: string
  }
  confirmation: {
    count: number
    actions: readonly RemakeConfirmationAction[]
    items: RemakeConfirmationItem[]
    note: string
  }
  prompt: AnalyzeResult["prompt"]
  generation: { called: false; note: string }
  warnings: string[]
}

/** 台词轮次落点 → 场景（以轮次起始时间为准；无时间戳/越界者不归属，不猜）。 */
function locateScenes(scenes: readonly Scene[], starts: readonly (number | undefined)[]): (string | undefined)[] {
  return starts.map((start) => {
    if (start === undefined) return undefined
    const hit = scenes.find((scene) => start >= scene.start && start < scene.end)
    return hit === undefined ? undefined : sceneId(hit.index)
  })
}

export async function buildRemakePlan(source: string, opts: RemakePlanOptions): Promise<RemakePlanResult> {
  const warnings: string[] = []
  const targetSeconds = opts.target_seconds ?? 5
  const maxSeconds = opts.max_seconds ?? 10
  if (targetSeconds > maxSeconds) throw new Error(`target_seconds (${targetSeconds}) 不得大于 max_seconds (${maxSeconds})`)

  // ① 解析：完全复用 analyzeVideo（场景＋词级台词＋VLM fail-closed 的提示词格）
  const analysis = await analyzeVideo(source, {
    frames_dir: opts.frames_dir,
    ...(opts.scene_rate === undefined ? {} : { scene_rate: opts.scene_rate }),
    ...(opts.scene_threshold === undefined ? {} : { scene_threshold: opts.scene_threshold }),
    ...(opts.max_scenes === undefined ? {} : { max_scenes: opts.max_scenes }),
    ...(opts.language === undefined ? {} : { language: opts.language }),
    ...(opts.max_audio_seconds === undefined ? {} : { max_seconds: opts.max_audio_seconds }),
    signal: opts.signal,
    // allow_paid_vision 一律不传 ⇒ false（零付费；要付费通道须项目负责人逐次报备）
  })
  warnings.push(...analysis.warnings)

  const info = await probeMedia(source)
  requireVideo(info, source)

  // 场景全集（不因 max_scenes 截断）：对同一份 boundaries 用同一支 segmentScenes 重算
  const fullScenes = segmentScenes(analysis.scenes.boundaries, info.duration).scenes
  const frameByIndex = new Map(analysis.scenes.items.map((item) => [item.index, item]))

  // 台词轮次（passages ＝ 轮次）
  const passages = analysis.speech.turns ?? []
  const located = locateScenes(fullScenes, passages.map((passage) => passage.start_seconds))
  const turns: RemakeTurn[] = passages.map((passage, position) => ({
    index: position + 1,
    ...(passage.start_seconds === undefined ? {} : { start: round(passage.start_seconds) }),
    ...(passage.end_seconds === undefined ? {} : { end: round(passage.end_seconds) }),
    text: passage.text,
    word_count: passage.words.length,
    ...(located[position] === undefined ? {} : { scene_id: located[position]! }),
  }))
  const turnsByScene = new Map<string, number[]>()
  for (const turn of turns) {
    if (turn.scene_id === undefined) continue
    turnsByScene.set(turn.scene_id, [...(turnsByScene.get(turn.scene_id) ?? []), turn.index])
  }
  const unlocated = turns.filter((turn) => turn.scene_id === undefined).length
  if (unlocated > 0) {
    warnings.push(`${unlocated} 个台词轮次没有可用时间戳或落在场景边界外，未归属任何场景（不猜）`)
  }

  const sceneItems: RemakeScene[] = fullScenes.map((scene) => {
    const id = sceneId(scene.index)
    const frame = frameByIndex.get(scene.index)
    const dialogue = turnsByScene.get(id) ?? []
    return {
      id,
      index: scene.index,
      start: scene.start,
      end: scene.end,
      at: scene.at,
      ...(frame?.frame_path === undefined ? {} : { frame_path: frame.frame_path }),
      ...(frame?.frame_actual_at === undefined ? {} : { frame_actual_at: frame.frame_actual_at }),
      ...(frame?.frame_error === undefined ? {} : { frame_error: frame.frame_error }),
      dialogue_turn_ids: dialogue,
      has_speech: dialogue.length > 0,
    }
  })

  // 角色候选：一个「有台词的场景」→ 一个候选槽（无 diarization ⇒ 不判身分、不取名）
  const cast: RemakeCharacterCandidate[] = sceneItems
    .filter((scene) => scene.has_speech)
    .map((scene, position) => {
      const sceneTurns = turns.filter((turn) => turn.scene_id === scene.id)
      const text = sceneTurns.map((turn) => turn.text).join(" / ")
      return {
        id: `role-${String(position + 1).padStart(3, "0")}`,
        name: null,
        name_source: "undetermined",
        scene_id: scene.id,
        ...(scene.frame_path === undefined ? {} : { frame_path: scene.frame_path }),
        ...(scene.frame_actual_at === undefined ? {} : { frame_actual_at: scene.frame_actual_at }),
        dialogue_turn_ids: scene.dialogue_turn_ids,
        evidence: text.length > 200 ? `${text.slice(0, 200)}…` : text,
        identity_note:
          `本机无 speaker diarization、无人脸辨识、无零付费 VLM：只知此场景有 ${sceneTurns.length} 个台词轮次，`
          + "无法判定谁说的、无法给角色命名（name 保持 null，不编造）。",
      }
    })

  // ② 切段：计画 ＋ 真的切档（复用 cutSpans，回传重新 probe 的实际秒数）
  const planned = planSegments(fullScenes, targetSeconds, maxSeconds)
  if (planned.oversize.length > 0) {
    warnings.push(
      `场景 ${planned.oversize.join(", ")} 本身长于 max_seconds 且区间内没有可用的变化候选可再切，原样成段（不假装切得开）`,
    )
  }
  const cutEnabled = opts.cut !== false
  const outDir = opts.out_dir.replace(/\/+$/u, "")
  const segments: RemakeSegment[] = []
  for (const plan of planned.segments) {
    const dialogueTurnIds = turns
      .filter((turn) => turn.start !== undefined && turn.start >= plan.start && turn.start < plan.end)
      .map((turn) => turn.index)
    // 代表帧：取该段中点所在场景的实际解码格（该格必落在区间内）
    const middle = (plan.start + plan.end) / 2
    const holder =
      sceneItems.find((scene) => middle >= scene.start && middle < scene.end && scene.frame_path !== undefined)
      ?? sceneItems.find((scene) => plan.scene_ids.includes(scene.id) && scene.frame_path !== undefined)
    const segment: RemakeSegment = {
      ...plan,
      dialogue_turn_ids: dialogueTurnIds,
      ...(holder?.frame_path === undefined ? {} : { frame_path: holder.frame_path }),
      ...(holder?.frame_actual_at === undefined ? {} : { frame_actual_at: holder.frame_actual_at }),
    }
    if (cutEnabled) {
      const target = `${outDir}/${plan.id}.mp4`
      try {
        const output = await cutSpans(source, [{ start: plan.start, end: plan.end }], target, false)
        segment.clip = {
          path: target,
          actual_seconds: round(output.actualSeconds),
          has_video: output.hasVideo,
          has_audio: output.hasAudio,
        }
      } catch (error) {
        segment.clip_error = errMsg(error)
      }
    }
    segments.push(segment)
  }
  if (segments.some((segment) => segment.clip_error !== undefined)) {
    warnings.push("有片段切档失败（见该段 clip_error），其余片段不受影响")
  }

  // ③ 角色替换确认：只出待确认清单
  const vlmCode = analysis.prompt.ok ? "vision_prompt_available" : (analysis.prompt.code ?? "vlm_unavailable")
  const vlmReason = analysis.prompt.ok
    ? "呼叫端已显式允许付费视觉通道，反推结果见 prompt（模型输出、非量测事实，仍需人眼覆核）"
    : (analysis.prompt.reason ?? "本机无零付费 VLM 通道")
  const inferred = {
    status: "needs_vision_model" as const,
    code: vlmCode,
    reason: `${vlmReason} ⇒ 本工具不产出「新角色名／新角色 prompt／新场景名／新场景 prompt」的推断值（维持 null），留待确认页人机协作。`,
    new_name: null,
    new_prompt: null,
  }
  const confirmationItems: RemakeConfirmationItem[] = [
    ...cast.map((candidate) => ({
      id: candidate.id,
      kind: "character" as const,
      original: {
        name: candidate.name,
        name_source: candidate.name_source,
        ...(candidate.frame_path === undefined ? {} : { frame_path: candidate.frame_path }),
        ...(candidate.frame_actual_at === undefined ? {} : { frame_actual_at: candidate.frame_actual_at }),
        ...(candidate.scene_id === undefined ? {} : { scene_id: candidate.scene_id }),
        evidence: candidate.evidence,
      },
      inferred: { ...inferred },
      allowed_actions: ["confirm", "reject", "rename"] as const,
      applied: false as const,
    })),
    ...sceneItems.map((scene) => ({
      id: scene.id,
      kind: "scene" as const,
      original: {
        name: scene.id,
        name_source: "mechanical_boundary",
        ...(scene.frame_path === undefined ? {} : { frame_path: scene.frame_path }),
        ...(scene.frame_actual_at === undefined ? {} : { frame_actual_at: scene.frame_actual_at }),
        scene_id: scene.id,
        start: scene.start,
        end: scene.end,
        evidence: scene.has_speech
          ? `${scene.dialogue_turn_ids.length} 个台词轮次落在本场景`
          : "本场景没有台词轮次",
      },
      inferred: { ...inferred },
      allowed_actions: ["confirm", "reject", "rename"] as const,
      applied: false as const,
    })),
  ]

  return {
    ok: true,
    format: "eimu.video-remake-plan@1",
    source,
    media: analysis.media,
    parse: {
      scenes: {
        count: sceneItems.length,
        boundary_count: analysis.scenes.boundary_count,
        ignored_boundaries: analysis.scenes.ignored_boundaries,
        frames_extracted: analysis.scenes.items.length,
        items: sceneItems,
        note:
          "场景由机械式相邻帧变化候选切出（分数不是镜头标签）；代表帧是各场景中点的实际解码格。"
          + `本轮抽了 ${analysis.scenes.items.length} 个场景的代表帧（max_scenes），场景全集仍完整列出。`,
      },
      dialogue: {
        ok: analysis.speech.ok,
        provider: analysis.speech.provider,
        model: analysis.speech.model,
        language: analysis.speech.language,
        audio_seconds: analysis.speech.audio_seconds,
        word_count: analysis.speech.word_count ?? 0,
        turn_count: turns.length,
        code: analysis.speech.code,
        reason: analysis.speech.reason,
        probed: analysis.speech.probed,
        speaker_identity: "undetermined",
        turns,
        // 依有无音轨分流（同 video-analyze.ts 的 hasAudio 口径，用 analysis.media 的既有探测值，
        // 不另跑 ffprobe）：无音轨时不得宣称「台词是 ASR 的词级量测事实」——没有台词可量测。
        note: analysis.media.has_audio === false
          ? "来源影片没有音轨，**没有台词可量测**（未送 ASR，非转写失败）；"
            + "本机无 speaker diarization ⇒ **无法判定谁说的**，不得由轮次顺序或场景归属推论发话人。"
          : "台词是本机 ASR 的词级量测事实（每词 start/end 秒），passages 即台词轮次；"
            + "本机无 speaker diarization ⇒ **无法判定谁说的**，不得由轮次顺序或场景归属推论发话人。",
      },
      cast: {
        count: cast.length,
        items: cast,
        note:
          "角色候选＝由「台词轮次落在哪个场景」聚合出的候选槽，不是辨识出的真人身分；"
          + "没有 diarization／人脸辨识／VLM ⇒ 姓名一律 null，需在确认页手动标定（confirm/reject/rename）。",
      },
    },
    segments: {
      target_seconds: targetSeconds,
      max_seconds: maxSeconds,
      count: segments.length,
      cut: cutEnabled,
      items: segments,
      oversize_scenes: planned.oversize,
      note:
        "切段＝把相邻场景在 target 秒前持续并成短片段、单段不超过 max 秒，"
        + "再用既有 cutSpans 真的切档；actual_seconds 是重新 probe 输出档的时长（不是请求值）。",
    },
    confirmation: {
      count: confirmationItems.length,
      actions: ["confirm", "reject", "rename"],
      items: confirmationItems,
      note:
        "只产生待确认清单：原角色（名＋代表帧）／原场景与其推断的新名／新 prompt 并列，供人工 confirm/reject/rename。"
        + "本工具**不自动替换、不呼叫任何生成**（不花钱、不可逆的动作一律留给人按下确认）。",
    },
    prompt: analysis.prompt,
    generation: {
      called: false,
      note: "本工具只产生待确认清单，不自动替换、不呼叫任何生成（零付费上游呼叫）",
    },
    warnings,
  }
}
