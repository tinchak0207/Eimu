import { tool } from "@opencode-ai/plugin/tool"
import { ok, fail, resolveKey } from "../lib/client"
import { gatewayReadSnapshot, gatewayDispatchOps } from "../lib/canvas-flow"
import {
  readStoryboardShots,
  shotsToVoiceoverLines,
  planBatches,
  synthesizeTimeline,
  applyTimelineToShots,
  audioDurationDrift,
  buildVoiceoverOps,
  VOICEOVER_TOOL_MAX_LINES,
  type VoiceoverTimelineEntry,
} from "../lib/storyboard-voiceover"

// 分鏡逐鏡配音 tool（2026-09-30）：薄 wrapper，邏輯全在 lib/storyboard-voiceover.ts。
// 病歷 `tts-multiline-narration-p2-bug`：旁白貫穿多鏡卻只合成一條音軌。本工具補兩跳——
// ① 從分鏡「確定性」推出逐鏡台詞表（每鏡每欄位恰好一行，不摺成一句）
// ② 逐行真 TTS + ffprobe 實測後，把 `dialogueAudioId`/`narrationAudioId`/`audioAnchorId` 寫回分鏡節點。
// 引擎（TTS 呼叫／下載／ffprobe／offset／誠實失敗）逐行複製自 tools/audio_first_timeline.ts。

const GATEWAY = process.env.GATEWAY_URL || "http://127.0.0.1:8081"

export default tool({
  description:
    "分鏡逐鏡配音：读画布分镜节点 -> 确定性地按「每镜每字段恰好一行」组台词表（对白 dialogue + 旁白 narration）-> 逐行真 TTS 合成 + ffprobe 实测时长 -> 把 dialogueAudioId/narrationAudioId/audioAnchorId 写回分镜节点。用于「先配音后配画」的长片：旁白贯穿多镜时**必须**走本工具，不要自己拼一句长台词送 tts_speak（那只会生成一条音轨，成片后半段无声——病历时 P2 bug）。\n\n【诚实】时长一律 ffprobe 实测；TTS 上游不可用时整批 fail 回 tts_unavailable，不编造音频 URL；写回失败（画布未打开，前端 30 秒未回执）如實回 writeback_ok:false 与原因，不假装成功。\n\n【成本】逐行按字符计价（以每行返回的 cost_coins 为准，单价见 VPS pricing 'tts-zh': 0.001 币/字）。传 dry_run:true 只报行数与预估字数、零上游呼叫零扣费。\n\n【上限】台词表硬上限 50 行，超过具名拒（不截断）；分批次逐行序列生成，禁并发。speed 上游未接入语速控制，传入不生效（如實标注）。",
  args: {
    dry_run: tool.schema
      .boolean()
      .optional()
      .describe("true＝只从分镜组台词表并回报行数/字数，零 TTS 呼叫零扣费（默认 false）"),
    voice: tool.schema.string().optional().describe("音色名（可选，透传上游）"),
    speed: tool.schema.number().min(0.5).max(2).optional().describe("语速（可选；当前上游未支持，传入不生效，如實标注）"),
    gap_ms: tool.schema.number().int().min(0).max(5000).optional().describe("行间静默毫秒，默认 0（offset 纯累加）"),
    label: tool.schema.string().optional().describe("给用户看的一句话操作意图，如「逐镜配音」"),
  },
  async execute(args, context) {
    // 1) 讀 raw 快照（切記：分鏡文本必須走 raw state，不可用 compactCanvasState——它會截斷長文本）
    const snap = await gatewayReadSnapshot(GATEWAY, context.sessionID)
    if (!snap.has_state || snap.state === null) {
      return fail("no_canvas_state", "画布尚未上报状态，请让用户打开画布", {
        hint: "画布尚未上报状态，请让用户打开画布",
      })
    }
    const shots = readStoryboardShots(snap.state)
    if (!shots.length) {
      return fail("no_storyboard_shots", "画布上找不到分镜节点（判准：metadata.storyboardShot.shotNumber 非空）", {
        title: "无分镜",
      })
    }

    // 2) 確定性組台詞表（每鏡每欄位恰好一行；>50 具名拒）
    const plan = shotsToVoiceoverLines(shots)
    if (plan.refused) {
      return fail(plan.refused.code, plan.refused.note, {
        title: `台词表被拒（${plan.source.length} 行 > ${VOICEOVER_TOOL_MAX_LINES}）`,
        lines: plan.source.length,
      })
    }
    if (!plan.lines.length) {
      return fail("no_voiceover_lines", "分镜里没有任何 dialogue/narration 文本，无可配音内容", {
        title: "无台词",
        shots: shots.length,
      })
    }
    const totalChars = plan.lines.reduce((n, l) => n + l.text.length, 0)

    if (args.dry_run === true) {
      return ok({
        title: `逐镜配音（dry_run）：${plan.lines.length} 行 / ${totalChars} 字`,
        dry_run: true,
        shots: shots.length,
        lines: plan.lines.length,
        total_chars: totalChars,
        batches: planBatches(plan.lines).map((b) => ({ startIndex: b.startIndex, lines: b.lines.length, maxLines: b.maxLines })),
        source: plan.source,
      })
    }

    // 3) 解析 key（照 audio_first_timeline 用法）
    let key: string
    try {
      key = await resolveKey(context.sessionID, context.abort)
    } catch (e: any) {
      return fail("key_unresolved", e?.message || "无法解析 API key", { title: "钥匙解析失败" })
    }

    // 4) 分批逐行真 TTS（每批**顯式帶** maxLines＝該批實際行數），批間序接禁併發
    const timeline: VoiceoverTimelineEntry[] = []
    let totalCost = 0
    for (const batch of planBatches(plan.lines)) {
      const result = await synthesizeTimeline(batch.lines, {
        key,
        voice: args.voice,
        speed: args.speed,
        gapMs: args.gap_ms,
        maxLines: batch.maxLines,
        signal: context.abort,
      })
      if (!result.ok) {
        return fail(result.code, result.hint, {
          title: "配音上游暂缺",
          note: "台詞已收到，但當前無法真實生成音軌；請如實告知用戶，勿編造音頻鏈接。",
          lines_processed: timeline.length,
        })
      }
      for (const entry of result.timeline) {
        timeline.push({ ...entry, index: batch.startIndex + entry.index })
      }
      totalCost += result.total_cost_coins
    }

    // 5) 逐鏡時長漂移（只回報不修正）＋ 回寫（任一不符＝整批拒寫）
    const drift = audioDurationDrift(shots, timeline, plan.source)
    const apply = applyTimelineToShots(shots, timeline, plan.source)
    const appliedTimeline = timeline
    if (!apply.applied) {
      return fail(apply.refused?.code ?? "apply_refused", apply.refused?.note ?? "回寫被拒", {
        title: "回写被拒",
        lines: appliedTimeline.length,
        total_chars: totalChars,
        total_cost_coins: Math.round(totalCost * 1e6) / 1e6,
        drift,
      })
    }

    // 6) 寫回畫布（patch 只含三個鍵）；失敗如實回報，不假裝成功
    const ops = buildVoiceoverOps(shots, apply.shots)
    let writebackOk = true
    let writebackError: string | undefined
    let writebackCode: string | undefined
    let requestId: string | null = null
    if (ops.length) {
      const outcome = await gatewayDispatchOps(GATEWAY, context.sessionID, ops, args.label ?? "逐镜配音")
      requestId = outcome.request_id
      writebackOk = outcome.ok === true && outcome.result?.ok === true
      if (!writebackOk) {
        writebackCode = outcome.code || (outcome.status ? `http_${outcome.status}` : "dispatch_failed")
        writebackError = outcome.error || outcome.result?.error || "前端未回执（画布页可能未打开）"
      }
    }

    const drifted = drift.filter((d) => d.overThreshold)
    return ok(
      {
        title: `逐镜配音：${appliedTimeline.length} 行（实测 ${appliedTimeline.filter((e) => e.duration_ms !== null).length} 行时长）${writebackOk ? "· 已写回分镜" : "· 写回失败"}`,
        lines: appliedTimeline.length,
        total_chars: totalChars,
        total_cost_coins: Math.round(totalCost * 1e6) / 1e6,
        total_duration_ms: appliedTimeline.reduce((n, e) => n + (typeof e.duration_ms === "number" ? e.duration_ms : 0), 0),
        batches: planBatches(plan.lines).length,
        batch_max_lines: planBatches(plan.lines).map((b) => b.maxLines),
        source: plan.source,
        timeline: appliedTimeline,
        drift,
        drift_over_threshold: drifted,
        unmeasured: apply.unmeasuredDurations,
        audio_urls: appliedTimeline.map((e) => e.audio_url),
        speed_note: args.speed !== undefined ? "speed 已傳入但当前上游未支持语速控制，不生效" : null,
        writeback_ok: writebackOk,
        writeback_ops: ops.length,
        ...(writebackOk ? {} : { writeback_code: writebackCode, writeback_error: writebackError }),
      },
      {
        lines: appliedTimeline.length,
        total_duration_ms: appliedTimeline.reduce((n, e) => n + (typeof e.duration_ms === "number" ? e.duration_ms : 0), 0),
        total_cost_coins: Math.round(totalCost * 1e6) / 1e6,
        writeback_ok: writebackOk,
      },
    )
  },
})