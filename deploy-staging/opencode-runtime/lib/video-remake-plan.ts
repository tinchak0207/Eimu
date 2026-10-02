// 影片翻拍計畫（解析 → 切段 → 角色替換確認）——本機優先、零付費、fail-closed。
//
// 形態來源（不另造輪子）：
//   ① 解析（場景／台詞）→ 複用 lib/video-analyze.ts 的 analyzeVideo：場景＝visualBoundaries 的
//      機械式相鄰幀變化候選＋segmentScenes 去抖動；台詞＝lib/asr.ts 的本機 loopback ASR 詞級時間軸；
//      提示詞反推＝VLM，本機無零付費通道時照 video-analyze 的既有形狀回 vlm_unavailable，**不編造**。
//   ② 切段 → 同一份 boundaries 的場景 ＋ 複用 lib/video-evidence.ts 的 cutSpans 真的切出短片段
//      （真正的輸出時長由 cutSpans 重新 probe 回報，不是請求值）。
//   ③ 角色／場景候選 → 由**台詞輪次與場景歸屬聚合**。本機無 speaker diarization、無人臉辨識、
//      無 VLM ⇒ 不判「誰說的」、不編造角色姓名、不編造新角色/新場景提示詞（照 video-analyze 的誠實口徑）。
//   ④ 生成 → **本檔只產生待確認清單**：不自動替換、不呼叫任何生成、不發出任何付費上游請求。
//
// 本檔不是 tool，不得 export tool 定義。

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

// ─────────────────────────────────────────── 台詞輪次與角色／場景候選

export interface RemakeTurn {
  index: number
  start?: number
  end?: number
  text: string
  word_count: number
  /** 該輪次起始時間所落的場景 id；輪次無時間戳時缺席（不猜）。 */
  scene_id?: string
}

export interface RemakeScene {
  id: string
  index: number
  start: number
  end: number
  /** 場景中點（代表幀請求時間）。 */
  at: number
  frame_path?: string
  frame_actual_at?: number
  frame_error?: string
  /** 落在本場景內的台詞輪次索引。 */
  dialogue_turn_ids: number[]
  has_speech: boolean
}

/**
 * 角色候選：**由台詞輪次與場景歸屬聚合**，一個「有台詞的場景」聚成一個候選槽。
 * 本機無 diarization ⇒ 同一槽內多個輪次無法判定是否同一人、也無法判定姓名（name 保持 null）。
 */
export interface RemakeCharacterCandidate {
  id: string
  /** 永遠是 null：本機無 diarization／人臉辨識／VLM，不編造角色姓名。 */
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
 * 把場景清單聚成「適合 AI 重生的短片段」：相鄰場景在 `targetSeconds` 之前持續併入，
 * 但任一併入都不得讓段落超過 `maxSeconds`。單一場景本身超長時**不假裝切得開**——
 * 原樣成段並記在 oversize（要再切需要新的變化候選，不是本工具可以無中生有的）。
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
  /** cutSpans 重新 probe 輸出檔得到的實際時長（不是請求值）。 */
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

// ─────────────────────────────────────────── 待確認清單

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
  /** 本工具只出清單，永不自動套用（不替換、不生成）。 */
  applied: false
}

// ─────────────────────────────────────────── 主流程

export interface RemakePlanOptions {
  /** 代表幀輸出目錄（必須可寫；由呼叫端建立）。 */
  frames_dir: string
  /** 短片段輸出目錄。 */
  out_dir: string
  /** 目標段長（秒），預設 5。 */
  target_seconds?: number
  /** 單段上限（秒），預設 10。 */
  max_seconds?: number
  scene_rate?: number
  scene_threshold?: number
  max_scenes?: number
  language?: string
  max_audio_seconds?: number
  /** false＝只出計畫不切檔（除錯用）；預設 true。 */
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

/** 台詞輪次落點 → 場景（以輪次起始時間為準；無時間戳/越界者不歸屬，不猜）。 */
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
  if (targetSeconds > maxSeconds) throw new Error(`target_seconds (${targetSeconds}) 不得大於 max_seconds (${maxSeconds})`)

  // ① 解析：完全複用 analyzeVideo（場景＋詞級台詞＋VLM fail-closed 的提示詞格）
  const analysis = await analyzeVideo(source, {
    frames_dir: opts.frames_dir,
    ...(opts.scene_rate === undefined ? {} : { scene_rate: opts.scene_rate }),
    ...(opts.scene_threshold === undefined ? {} : { scene_threshold: opts.scene_threshold }),
    ...(opts.max_scenes === undefined ? {} : { max_scenes: opts.max_scenes }),
    ...(opts.language === undefined ? {} : { language: opts.language }),
    ...(opts.max_audio_seconds === undefined ? {} : { max_seconds: opts.max_audio_seconds }),
    signal: opts.signal,
    // allow_paid_vision 一律不傳 ⇒ false（零付費；要付費通道須暴君逐次報備）
  })
  warnings.push(...analysis.warnings)

  const info = await probeMedia(source)
  requireVideo(info, source)

  // 場景全集（不因 max_scenes 截斷）：對同一份 boundaries 用同一支 segmentScenes 重算
  const fullScenes = segmentScenes(analysis.scenes.boundaries, info.duration).scenes
  const frameByIndex = new Map(analysis.scenes.items.map((item) => [item.index, item]))

  // 台詞輪次（passages ＝ 輪次）
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
    warnings.push(`${unlocated} 個台詞輪次沒有可用時間戳或落在場景邊界外，未歸屬任何場景（不猜）`)
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

  // 角色候選：一個「有台詞的場景」→ 一個候選槽（無 diarization ⇒ 不判身分、不取名）
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
          `本機無 speaker diarization、無人臉辨識、無零付費 VLM：只知此場景有 ${sceneTurns.length} 個台詞輪次，`
          + "無法判定誰說的、無法給角色命名（name 保持 null，不編造）。",
      }
    })

  // ② 切段：計畫 ＋ 真的切檔（複用 cutSpans，回傳重新 probe 的實際秒數）
  const planned = planSegments(fullScenes, targetSeconds, maxSeconds)
  if (planned.oversize.length > 0) {
    warnings.push(
      `場景 ${planned.oversize.join(", ")} 本身長於 max_seconds 且區間內沒有可用的變化候選可再切，原樣成段（不假裝切得開）`,
    )
  }
  const cutEnabled = opts.cut !== false
  const outDir = opts.out_dir.replace(/\/+$/u, "")
  const segments: RemakeSegment[] = []
  for (const plan of planned.segments) {
    const dialogueTurnIds = turns
      .filter((turn) => turn.start !== undefined && turn.start >= plan.start && turn.start < plan.end)
      .map((turn) => turn.index)
    // 代表幀：取該段中點所在場景的實際解碼格（該格必落在區間內）
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
    warnings.push("有片段切檔失敗（見該段 clip_error），其餘片段不受影響")
  }

  // ③ 角色替換確認：只出待確認清單
  const vlmCode = analysis.prompt.ok ? "vision_prompt_available" : (analysis.prompt.code ?? "vlm_unavailable")
  const vlmReason = analysis.prompt.ok
    ? "呼叫端已顯式允許付費視覺通道，反推結果見 prompt（模型輸出、非量測事實，仍需人眼覆核）"
    : (analysis.prompt.reason ?? "本機無零付費 VLM 通道")
  const inferred = {
    status: "needs_vision_model" as const,
    code: vlmCode,
    reason: `${vlmReason} ⇒ 本工具不產出「新角色名／新角色 prompt／新場景名／新場景 prompt」的推斷值（維持 null），留待確認頁人機協作。`,
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
          ? `${scene.dialogue_turn_ids.length} 個台詞輪次落在本場景`
          : "本場景沒有台詞輪次",
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
          "場景由機械式相鄰幀變化候選切出（分數不是鏡頭標籤）；代表幀是各場景中點的實際解碼格。"
          + `本輪抽了 ${analysis.scenes.items.length} 個場景的代表幀（max_scenes），場景全集仍完整列出。`,
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
        // 依有無音軌分流（同 video-analyze.ts 的 hasAudio 口徑，用 analysis.media 的既有探測值，
        // 不另跑 ffprobe）：無音軌時不得宣稱「台詞是 ASR 的詞級量測事實」——沒有台詞可量測。
        note: analysis.media.has_audio === false
          ? "來源影片沒有音軌，**沒有台詞可量測**（未送 ASR，非轉寫失敗）；"
            + "本機無 speaker diarization ⇒ **無法判定誰說的**，不得由輪次順序或場景歸屬推論發話人。"
          : "台詞是本機 ASR 的詞級量測事實（每詞 start/end 秒），passages 即台詞輪次；"
            + "本機無 speaker diarization ⇒ **無法判定誰說的**，不得由輪次順序或場景歸屬推論發話人。",
      },
      cast: {
        count: cast.length,
        items: cast,
        note:
          "角色候選＝由「台詞輪次落在哪個場景」聚合出的候選槽，不是辨識出的真人身分；"
          + "沒有 diarization／人臉辨識／VLM ⇒ 姓名一律 null，需在確認頁手動標定（confirm/reject/rename）。",
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
        "切段＝把相鄰場景在 target 秒前持續併成短片段、單段不超過 max 秒，"
        + "再用既有 cutSpans 真的切檔；actual_seconds 是重新 probe 輸出檔的時長（不是請求值）。",
    },
    confirmation: {
      count: confirmationItems.length,
      actions: ["confirm", "reject", "rename"],
      items: confirmationItems,
      note:
        "只產生待確認清單：原角色（名＋代表幀）／原場景與其推斷的新名／新 prompt 並列，供人工 confirm/reject/rename。"
        + "本工具**不自動替換、不呼叫任何生成**（不花錢、不可逆的動作一律留給人按下確認）。",
    },
    prompt: analysis.prompt,
    generation: {
      called: false,
      note: "本工具只產生待確認清單，不自動替換、不呼叫任何生成（零付費上游呼叫）",
    },
    warnings,
  }
}
