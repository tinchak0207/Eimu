// S8b：export 执行器（确定性）——工程唯一的交付出口（§3.9）。
// preset 属于 master.ts MASTER_PRESETS（portrait_916/landscape_169/cinema_239）→ 走
// workflow-gw-assemble.ts 抽出的 assembleFromClips（归一化→concat→混流→QC），产出可解码 mp4；
// preset="image_pack" → 产出包清单（每项 sha256，内容寻址的 artifactId 一并列出）。
// 所有产物经 ctx.ingest 入库（sha256 由 artifact-store 现算）。
import { createHash } from "node:crypto"
import { createReadStream, readFileSync } from "node:fs"
import { mkdir, writeFile } from "node:fs/promises"
import path from "node:path"
import { MASTER_PRESETS, type MasterPresetId } from "../../master.ts"
import { assembleFromClips, type AssembleClipInput, type AssembleAudioInput } from "../../workflow-gw-assemble.ts"
import { EXPORT_PRESETS, NODE_SPECS } from "../specs"
// S20：交付只认产物（§3.9）＋ 产物公网化（失败不抛，交付继续）。
import { checkExportArtifacts } from "../gates.ts"
import { verifySignedCriticVerdict } from "./qc.ts"
import { isPublishFailure, publishProjectArtifact } from "../publish.ts"
import type { ExecContext, ExecResult, Json, NodeExecutor, Output } from "../types"
import { appendInterchangeOutputs } from "./interchange"
import { flattenInputs, isAudio, isJson, isObj, isVideo, mimeOf, projectScratchDir, readJsonOutput } from "./timeline"

async function sha256File(file: string): Promise<{ sha: string; bytes: number }> {
  const h = createHash("sha256")
  let bytes = 0
  for await (const chunk of createReadStream(file)) {
    h.update(chunk as Buffer)
    bytes += (chunk as Buffer).length
  }
  return { sha: h.digest("hex"), bytes }
}

async function probeStreams(file: string): Promise<{ width: number; height: number; durationSec: number; hasVideo: boolean; hasAudio: boolean }> {
  const { invoke } = await import("../../editor/adapter/tauri-adapter")
  const { detectFfmpeg } = await import("../../editor/canvas/videoCompose")
  const ffmpeg = await detectFfmpeg()
  const shq = (v: string) => `'${String(v).replace(/'/g, "'\\''")}'`
  if (!ffmpeg) return { width: 0, height: 0, durationSec: 0, hasVideo: false, hasAudio: false }
  const r = await invoke<{ stdout: string; stderr: string; exit_code: number }>("execute_command", {
    command: `${ffmpeg.replace(/ffmpeg$/, "ffprobe")} -v error -show_entries stream=codec_type,width,height -show_entries format=duration -of json ${shq(file)}`,
    timeoutMs: 20000,
  }).catch(() => ({ stdout: "", stderr: "", exit_code: 1 }))
  try {
    const j = JSON.parse(r.stdout) as { streams?: { codec_type?: string; width?: number; height?: number }[]; format?: { duration?: string } }
    const v = (j.streams ?? []).find((s) => s.codec_type === "video")
    return {
      width: Number(v?.width ?? 0),
      height: Number(v?.height ?? 0),
      durationSec: Number(j.format?.duration ?? 0) || 0,
      hasVideo: Boolean(v),
      hasAudio: (j.streams ?? []).some((s) => s.codec_type === "audio"),
    }
  } catch {
    return { width: 0, height: 0, durationSec: 0, hasVideo: false, hasAudio: false }
  }
}

interface TimelineClipLite { id?: string; path?: string; label?: string; duration?: number; inSec?: number; outSec?: number; speed?: number }

function binaryItems(entries: ReturnType<typeof flattenInputs>): ReturnType<typeof flattenInputs> {
  const seen = new Set<string>()
  const out: ReturnType<typeof flattenInputs> = []
  for (const e of entries) {
    const mime = mimeOf(e.output)
    if (!mime || mime.includes("json") || mime.startsWith("text/")) continue
    if (seen.has(e.output.artifactId)) continue
    seen.add(e.output.artifactId)
    out.push(e)
  }
  return out
}

function rejectUnsignedVerdict(ctx: ExecContext): ExecResult | null {
  const list = ctx.inputs?.verdict
  if (!list || list.length === 0) {
    return { ok: false, code: "qc_failed", message: "export 缺少 critic 签名 verdict，拒绝放行", retryable: false }
  }
  let parsed: unknown
  try {
    parsed = JSON.parse(readFileSync(list[0].path, "utf-8"))
  } catch {
    return { ok: false, code: "qc_failed", message: "export 的 verdict 文件不可读", retryable: false }
  }
  const checked = verifySignedCriticVerdict(parsed, ctx.sessionId)
  if (!checked.ok) return { ok: false, code: "qc_failed", message: `export 拒绝放行：${checked.reason}`, retryable: false }
  return null
}

export const exportExecutor: NodeExecutor = {
  type: "export",
  specVersion: NODE_SPECS.export.specVersion,
  async estimate() { return 0 },
  async run(ctx: ExecContext): Promise<ExecResult> {
    const preset = typeof ctx.params?.preset === "string" ? ctx.params.preset : ""
    if (!(EXPORT_PRESETS as readonly string[]).includes(preset)) {
      return { ok: false, code: "bad_input", message: `未知导出预设 ${preset || "(空)"}：可选 ${EXPORT_PRESETS.join(" / ")}`, retryable: false }
    }
    const verdictBlock = rejectUnsignedVerdict(ctx)
    if (verdictBlock) return verdictBlock
    const entries = flattenInputs(ctx)
    const scratch = projectScratchDir(ctx.sessionId, `export-${ctx.node.id}`)
    await mkdir(scratch, { recursive: true })

    // ---- image_pack：包清单（唯一交付出口的图片族形态）
    if (preset === "image_pack") {
      const items = binaryItems(entries)
      if (!items.length) {
        return { ok: false, code: "bad_input", message: "image_pack 没有可交付的图片（输入里只有 json/text 或为空）", retryable: false }
      }
      const manifestItems: Json[] = []
      let totalBytes = 0
      for (const e of items) {
        const hashed = await sha256File(e.output.path).catch(() => null)
        if (!hashed) return { ok: false, code: "bad_input", message: `包内产物不可读：${e.output.artifactId}`, retryable: false }
        totalBytes += hashed.bytes
        manifestItems.push({
          name: `${e.from ?? e.name}-${e.output.artifactId}`.replace(/[^A-Za-z0-9_.-]/g, "_"),
          port: e.output.port,
          artifactId: e.output.artifactId,
          sha256: hashed.sha,
          mime: e.output.mime,
          bytes: hashed.bytes,
          path: e.output.path,
          ...(e.output.durationSec ? { durationSec: e.output.durationSec } : {}),
        })
      }
      const manifest = {
        schema: 1,
        projectId: ctx.project.id,
        nodeId: ctx.node.id,
        preset,
        signature: ctx.signature,
        createdAt: new Date().toISOString(),
        itemCount: manifestItems.length,
        totalBytes,
        items: manifestItems,
      }
      const manifestPath = path.join(scratch, "image_pack.json")
      await writeFile(manifestPath, JSON.stringify(manifest, null, 2), "utf-8")
      const ingested = await ctx.ingest({ path: manifestPath }, { port: "out", mime: "application/json", origin: "derived" })
      const manifestOutput: Output = {
        ...ingested,
        port: "out",
        meta: { preset, itemCount: manifestItems.length, totalBytes, kind: "image_pack" },
      }
      // S20b：manifest 本身也公网化（失败不抛，只记 meta.publishError）。
      const manifestPublished = await publishProjectArtifact(manifestPath, {
        sessionId: ctx.sessionId,
        artifactId: manifestOutput.artifactId,
        mime: "application/json",
      })
      if (isPublishFailure(manifestPublished)) {
        manifestOutput.meta = { ...manifestOutput.meta, publishError: String(manifestPublished.reason).slice(0, 200) }
      } else {
        manifestOutput.url = manifestPublished.url
      }
      // S20b：逐件公网化 —— 每件产一个 image/* 输出，交付卡据此逐张发 image.done（§3.9）。
      // 顺序与 manifestItems 严格一致（二进制去重已在 binaryItems 内完成），确定性。
      const outputs: Output[] = [manifestOutput]
      for (const item of manifestItems as unknown as { artifactId: string; sha256: string; mime: string; bytes: number; path: string }[]) {
        const out: Output = {
          port: "out",
          artifactId: item.artifactId,
          sha256: item.sha256,
          path: item.path,
          mime: item.mime,
          bytes: item.bytes,
          origin: "derived",
        }
        const published = await publishProjectArtifact(item.path, {
          sessionId: ctx.sessionId,
          artifactId: item.artifactId,
          mime: item.mime,
        })
        if (isPublishFailure(published)) out.meta = { publishError: String(published.reason).slice(0, 200) }
        else out.url = published.url
        outputs.push(out)
      }
      return { ok: true, costCoins: 0, outputs }
    }

    // ---- 视频预设：assembled mp4
    const presetMeta = MASTER_PRESETS[preset as MasterPresetId]
    if (!presetMeta) {
      return { ok: false, code: "bad_input", message: `预设 ${preset} 不是 MASTER_PRESETS 的 id，也没有 image_pack 语义`, retryable: false }
    }
    let timelineValue: Record<string, Json> | null = null
    for (const e of entries.filter((x) => isJson(x.output))) {
      const v = await readJsonOutput(e.output)
      if (isObj(v) && Array.isArray(v.clips)) { timelineValue = v; break }
    }
    const clips: AssembleClipInput[] = []
    if (timelineValue) {
      const tlClips = (timelineValue.clips as unknown as TimelineClipLite[]) ?? []
      for (const c of tlClips) {
        if (!c?.path) continue
        clips.push({
          id: c.id,
          path: c.path,
          durationSec: typeof c.duration === "number" && c.duration > 0 ? c.duration : undefined,
          inSec: typeof c.inSec === "number" ? c.inSec : 0,
          outSec: typeof c.outSec === "number" ? c.outSec : undefined,
          speed: typeof c.speed === "number" ? c.speed : 1,
        })
      }
    } else {
      for (const e of entries.filter((x) => isVideo(x.output))) {
        clips.push({ id: e.from ?? e.output.artifactId, path: e.output.path, durationSec: e.output.durationSec })
      }
    }
    if (!clips.length) {
      return { ok: false, code: "bad_input", message: "export 没有视频素材：接上 timeline 产物或 clip 输出", retryable: false }
    }
    const mixOutput = entries.find((e) => isAudio(e.output) && /mix|wav/.test(`${e.name} ${e.from ?? ""} ${mimeOf(e.output)}`))
    const audioOutputs = mixOutput ? [mixOutput] : entries.filter((e) => isAudio(e.output))
    const audio: AssembleAudioInput[] = audioOutputs.map((e) => ({ path: e.output.path, durationSec: e.output.durationSec }))
    // 字幕烧录：subtitle 节点的 meta.burnIn=true 才烧（外挂模式不动画面）。
    const assEntry = entries.find((e) => e.output.port === "ass" && isObj(e.output.meta as Json) && (e.output.meta as Record<string, Json>).burnIn === true)
    const resolution = presetMeta.h >= 1080 ? "1080p" : "720p"

    const outPath = path.join(scratch, `master_${preset}.mp4`)
    const res = await assembleFromClips(clips, audio, {
      workDir: scratch,
      outPath,
      order: clips.map((c) => c.id).filter((v): v is string => Boolean(v)),
      aspect: presetMeta.aspect,
      resolution,
      fps: 30,
      audioRequested: audio.length,
      ...(assEntry ? { assPath: assEntry.output.path } : {}),
    })
    if (res.ok !== true) return { ok: false, code: "bad_input", message: (res as { error: string }).error, retryable: false }

    const ingested = await ctx.ingest({ path: res.path }, { port: "out", mime: "video/mp4", origin: "derived" })
    const probed = await probeStreams(res.path)
    const meta: Record<string, Json> = {
      preset,
      presetLabel: presetMeta.label,
      aspect: presetMeta.aspect,
      resolution,
      width: probed.width,
      height: probed.height,
      durationSec: Math.round(probed.durationSec * 1000) / 1000,
      hasVideo: probed.hasVideo,
      hasAudio: probed.hasAudio,
      subtitleBurnIn: Boolean(assEntry),
      notes: res.notes.join("；").slice(0, 600),
    }
    const outputs: Output[] = [{
      ...ingested,
      port: "out",
      width: probed.width || undefined,
      height: probed.height || undefined,
      durationSec: probed.durationSec || undefined,
      meta,
    }]
    // S20 接线 1：交付前置检查（只查产物：存在/sha256/可解码/时长/音轨）。坏片变节点失败，不冒充交付。
    const gate = await checkExportArtifacts(outputs, { targets: ctx.project.targets })
    if (!gate.ok) {
      return {
        ok: false,
        code: "qc_failed",
        message: "交付检查未过：" + gate.deficiencies.join("；"),
        retryable: false,
      }
    }
    // S20 接线 2：产物公网化。失败不抛、不阻断交付，只记 meta.publishError（≤200 字）。
    const published = await publishProjectArtifact(outputs[0].path, {
      sessionId: ctx.sessionId,
      artifactId: outputs[0].artifactId,
      mime: outputs[0].mime,
    })
    if (isPublishFailure(published)) meta.publishError = String(published.reason).slice(0, 200)
    else outputs[0].url = published.url
    // 剪映草稿 + FCPXML。失败只记在 mp4 meta，不把已通过的成片打成失败。
    outputs.push(...await appendInterchangeOutputs(ctx, outputs[0], {
      clips: clips.map((c, i) => ({
        id: c.id || `clip_${i}`,
        path: c.path,
        durationSec: c.durationSec,
        inSec: c.inSec,
        outSec: c.outSec,
        speed: c.speed,
      })),
      audio: audioOutputs.map((e) => ({ id: e.from ?? e.output.artifactId, path: e.output.path, durationSec: e.output.durationSec })),
      scratch,
      width: presetMeta.w,
      height: presetMeta.h,
      subtitleFiles: entries.filter((e) => e.output.port === "srt" || e.output.port === "ass").map((e) => ({ path: e.output.path, port: e.output.port })),
      timelineSubtitles: timelineValue?.subtitles,
    }))
    return { ok: true, costCoins: 0, outputs }
  },
}
