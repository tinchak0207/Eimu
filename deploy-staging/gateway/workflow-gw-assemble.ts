import { mkdir } from "node:fs/promises"
import path from "node:path"
import { TTS_AUDIO_DIR, TTS_PUBLIC_BASE } from "./constants-gateway.ts"
import { assertVideoAuthorityMix, videoAuthorityMixArgs } from "./video-authority-mix.ts"
import type { CommandResult, VideoUpstream, AudioUpstream } from "./workflow-gw-submit.ts"

// R7-F（2026-08-29）：成片环后端——Kunpeng composeEngine 轮（gateway/editor/，
// pengfeiqiao/kunpeng pin 872a58b，白名单记账见 repo vendor/kunpeng/PATCHES.md）。
// 沿连线收集上游 video 产物 → title 最前、shotN 升幂排序 → 下载 → setHarnessState
// 注入 clips（真实时长由 ffprobe 逐段探得）→ exportSelectedMainClips（归一化→
// concat copy）→ probeRenderedVideo 校验门 → 落公网目录。拼接本身不另计费
//（costCoins: 0），视频段费用已在各 shot 节点确认。
//
// S8b（2026-10-28）：拼接本体抽成 assembleFromClips(clips, audio, opts)，工程图的
// timeline/export 执行器复用它；镜头顺序来自 opts.order（图的 timeline 节点参数），
// 不再硬编码 id 字符串排序。assembleFilmNode 传入它原来算出的 shotN 顺序，
// 旧签名/旧行为（下载、P0-B 镜头数闸、90% 时长门、混流降级、QC 注记、公网目录）不变。

/** 拼接输入：已落盘的镜头（本地绝对路径）。text 供字幕轨逐镜配对。 */
export interface AssembleClipInput {
  id?: string
  path: string
  /** 媒体全长（秒）；缺省由 ffprobe 探。 */
  durationSec?: number
  /** 有效时长口径的裁剪窗（缺省整段）。 */
  inSec?: number
  outSec?: number
  speed?: number
  role?: string
  text?: string
}

/** 拼接输入：配音/音轨（本地绝对路径，按给出顺序拼接）。 */
export interface AssembleAudioInput {
  path: string
  durationSec?: number
}

export interface AssembleSubtitleCue {
  id?: string
  startSec: number
  endSec: number
  text: string
}

export interface AssembleOptions {
  /** 中间档目录（调用方负责清理）。 */
  workDir: string
  /** 最终成片落盘路径（目录会自动创建）。 */
  outPath: string
  /** 镜头顺序：按 id 或文件名匹配；未列出的按输入顺序追加。缺省=输入顺序。 */
  order?: string[]
  title?: string
  /** 显式字幕轨（给了就不再由台词自动生成）。 */
  subtitles?: AssembleSubtitleCue[]
  /** 预生成的 ASS：烧录进成片（与 exportSelectedMainClips 同一滤镜与编码参数）。 */
  assPath?: string
  aspect?: string
  resolution?: string
  fps?: number
  /** 成片质检（响度正规化 + 结尾冻结修剪），默认开。 */
  qc?: boolean
  /** 调用方宣告要混入的音频条数（缺省=audio.length）；用于既有「未齐降级」判定。 */
  audioRequested?: number
  /** 音频 staging 失败原因（既有降级路径）。 */
  audioError?: string | null
}

export type AssembleResult =
  | { ok: true; path: string; durationSec: number; clipDurations: number[]; notes: string[]; subtitleCues: AssembleSubtitleCue[] }
  | { ok: false; error: string }

const shq = (v: string) => `'${String(v).replace(/'/g, "'\\''")}'`

/** 按 order 重排镜头：id 优先、文件名（去扩展名）次之；未匹配的保持原序追加。 */
export function applyAssembleOrder<T extends { id?: string; path: string }>(clips: T[], order?: string[]): T[] {
  const list = clips.slice()
  if (!order || order.length === 0) return list
  const keyOf = (c: T): string[] => {
    const base = path.basename(c.path)
    return [c.id ?? "", base, base.replace(/\.[^.]+$/, "")].filter(Boolean)
  }
  const used = new Set<number>()
  const out: T[] = []
  for (const name of order) {
    const idx = list.findIndex((c, i) => !used.has(i) && keyOf(c).includes(name))
    if (idx >= 0) {
      used.add(idx)
      out.push(list[idx])
    }
  }
  for (let i = 0; i < list.length; i += 1) if (!used.has(i)) out.push(list[i])
  return out
}

/** 字幕轨生成：逐镜台词只在有真实音频时长时铺满；标题单独占 0..titleEnd。 */
function buildSubtitleCues(
  clips: AssembleClipInput[],
  clipSecs: number[],
  audio: AssembleAudioInput[],
  title?: string,
): AssembleSubtitleCue[] {
  const cues: AssembleSubtitleCue[] = []
  const dialogueIdx: number[] = []
  for (let i = 0; i < clips.length; i += 1) if ((clips[i].text ?? "").trim()) dialogueIdx.push(i)
  const pairByShot = audio.length === clips.length && clips.length > 0
  const pairByLine = !pairByShot && dialogueIdx.length > 0 && audio.length === dialogueIdx.length
  let cursor = 0
  let lineAudio = 0
  for (let i = 0; i < clips.length; i += 1) {
    const text = (clips[i].text ?? "").trim()
    let dur: number | null = null
    if (pairByShot) dur = audio[i]?.durationSec ?? null
    else if (pairByLine && text) dur = audio[lineAudio++]?.durationSec ?? null
    if (text && dur != null && dur > 0) cues.push({ id: `sub_${i}`, startSec: cursor, endSec: cursor + dur, text })
    cursor += clipSecs[i] ?? 0
  }
  const projectTitle = (title ?? "").trim()
  if (projectTitle) {
    const titleEnd = Math.min(3, Math.max(1, clipSecs[0] ?? 3))
    cues.unshift({ id: "title", startSec: 0, endSec: titleEnd, text: projectTitle })
  }
  return cues
}

/**
 * 把一组已落盘镜头 + 音频拼成成片（原 assembleFilmNode 的主体，逐段等价）。
 * 错误字符串与旧路径一致（未检测到 ffmpeg / 读不到时长 / 90% 时长门）。
 */
export async function assembleFromClips(
  clips: AssembleClipInput[],
  audio: AssembleAudioInput[],
  opts: AssembleOptions,
): Promise<AssembleResult> {
  const { setHarnessState, DEFAULT_EXPORT_SETTINGS } = await import("./editor/adapter/editorStore")
  const { exportSelectedMainClips, probeRenderedVideo } = await import("./editor/composeEngine")
  const { detectFfmpeg } = await import("./editor/canvas/videoCompose")
  const { invoke } = await import("./editor/adapter/tauri-adapter")

  const ffmpeg = await detectFfmpeg()
  if (!ffmpeg) return { ok: false, error: "未检测到 ffmpeg：成片拼接后端不可用" }

  const ordered = applyAssembleOrder(clips, opts.order)
  const clipSecs: number[] = []
  const fullSecs: number[] = []
  let totalInputSec = 0
  for (const c of ordered) {
    let sec = c.durationSec != null && c.durationSec > 0 ? c.durationSec : 0
    if (!(sec > 0)) {
      const probe = await invoke<CommandResult>("execute_command", {
        command: `${ffmpeg.replace(/ffmpeg$/, "ffprobe")} -v error -show_entries format=duration -of csv=p=0 ${shq(c.path)}`,
        timeoutMs: 15000,
      })
      const dur = Number.parseFloat((probe.stdout || "").trim())
      sec = Number.isFinite(dur) && dur > 0 ? dur : 0
    }
    if (sec <= 0) return { ok: false, error: "成片环读不到镜头时长（ffprobe 失败），拒绝盲拼" }
    fullSecs.push(sec)
    const speed = c.speed && c.speed > 0 ? c.speed : 1
    const inS = c.inSec ?? 0
    const outS = c.outSec ?? sec
    const eff = outS > inS ? (outS - inS) / speed : sec
    clipSecs.push(eff)
    totalInputSec += eff
  }

  const subtitleCues = opts.subtitles
    ?? (opts.assPath ? [] : buildSubtitleCues(ordered, clipSecs, audio, opts.title))

  setHarnessState({
    clips: ordered.map((c, i) => ({
      id: `h${i}`,
      path: c.path,
      label: `seg${i}`,
      duration: fullSecs[i],
      inSec: c.inSec ?? 0,
      outSec: c.outSec ?? fullSecs[i],
      ...(c.speed && c.speed > 0 ? { speed: c.speed } : {}),
      transitionAfter: { type: "none", duration: 0 },
    })),
    aspect: (opts.aspect ?? "16:9") as never,
    exportSettings: { ...DEFAULT_EXPORT_SETTINGS, resolution: (opts.resolution ?? "720p") as never, fps: (opts.fps ?? 24) as never },
    subtitles: subtitleCues as never,
  })
  const clipIds = ordered.map((_, i) => `h${i}`)
  const outPath = await exportSelectedMainClips(clipIds)
  const probe = await probeRenderedVideo(ffmpeg, outPath)
  // 校验门：成片时长不得低于各段输入时长总和的 90%（归一化重编码允许微小误差）
  const minSec = Math.floor(totalInputSec * 0.9)
  if (probe.durationSec < minSec) {
    return { ok: false, error: `成片校验未通过：成片 ${probe.durationSec}s 低于输入总长 ${totalInputSec}s 的 90%` }
  }

  const notes: string[] = []
  // 配音混流（2026-08-30）：音频非空时把音轨混进成片。禁 -shortest（不准截断视频）；
  // 混流任何一步失败降级纯视频成片，notes 注明，不整单报错。
  const audioRequested = opts.audioRequested ?? audio.length
  let mixedPath = outPath
  let mixNote = ""
  if (audioRequested > 0) {
    try {
      if (opts.audioError || audio.length !== audioRequested) throw new Error(opts.audioError || "配音素材未齐")
      const audioPaths = audio.map((a) => a.path)
      let totalAudioSec = 0
      for (const a of audio) if (a.durationSec != null && a.durationSec > 0) totalAudioSec += a.durationSec
      let trackPath = audioPaths[0]
      if (audioPaths.length > 1) {
        const listPath = path.join(opts.workDir, "audio-list.txt")
        await Bun.write(listPath, audioPaths.map((p) => `file '${p.replace(/'/g, "'\\''")}'`).join("\n") + "\n")
        trackPath = path.join(opts.workDir, "audio-merged.m4a")
        const merged = await invoke<CommandResult>("execute_command", {
          command: `${ffmpeg} -y -f concat -safe 0 -i ${shq(listPath)} -c:a aac ${shq(trackPath)}`,
          timeoutMs: 120000,
        })
        if (merged.exit_code !== 0) throw new Error(`多轨合并失败: ${(merged.stderr || "").slice(-200)}`)
      }
      const mixedOut = path.join(opts.workDir, "film-mixed.mp4")
      const mixArgs = videoAuthorityMixArgs(probe.durationSec)
      assertVideoAuthorityMix(mixArgs)
      const mixed = await invoke<CommandResult>("execute_command", {
        command: `${ffmpeg} -y -i ${shq(outPath)} -i ${shq(trackPath)} ${mixArgs.map((arg) => shq(arg)).join(" ")} ${shq(mixedOut)}`,
        timeoutMs: 300000,
      })
      if (mixed.exit_code !== 0) throw new Error(`混流失败: ${(mixed.stderr || "").slice(-200)}`)
      mixedPath = mixedOut
      // P0-B（2026-08-31）：配音时长明显短于成片时长 = 覆盖不足，本次事故音轨只有
      // 0.936 秒配 15.04 秒成片，混流「成功」但实质失能。不阻断交付（降级不是硬
      // 失败，跟现有「混流失败降级纯视频」的宽容度一致），仅把警讯写进 mixNote。
      if (totalAudioSec > 0 && totalAudioSec < probe.durationSec * 0.5) {
        mixNote = `配音时长（${totalAudioSec.toFixed(1)}s）明显短于成片时长（${probe.durationSec}s），已交付但音轨覆盖不足，请检查配音节点`
        console.log(`[workflow] assembleFilm audio too short: audio=${totalAudioSec}s film=${probe.durationSec}s`)
      }
    } catch (e) {
      mixNote = "配音混流失败，已交付无音轨版本"
      console.log(`[workflow] assembleFilm audio mix degraded: ${String((e as Error).message ?? e).slice(0, 200)}`)
    }
  }
  // 2026-10-02 成片质检门（e2e 评测：-38.5 LUFS 未正规化、结尾 1.3s 冻结照样导出）：
  // 响度正规化到 -16 LUFS + 修剪结尾冻结/黑帧；修不了则交付原片并在 message 如实注明。永不抛错。
  if (opts.qc !== false) {
    try {
      const { qcAndFixFilm } = await import("./film-qc")
      const qc = await qcAndFixFilm(ffmpeg, mixedPath, path.join(opts.workDir, "film-qc.mp4"))
      mixedPath = qc.path
      if (qc.notes.length) mixNote = [mixNote, ...qc.notes].filter(Boolean).join("；")
      console.log(`[workflow] assembleFilm QC: changed=${qc.changed} lufs=${qc.before.lufs}->${qc.after?.lufs ?? "-"} dur=${qc.before.durationSec}->${qc.after?.durationSec ?? "-"} notes=${qc.notes.join("|").slice(0, 200)}`)
    } catch (e) {
      console.log(`[workflow] assembleFilm QC skipped: ${String((e as Error).message ?? e).slice(0, 160)}`)
    }
  }
  // 预生成 ASS 烧录：与 exportSelectedMainClips L349-355 同一滤镜/编码参数（视频重编码、音频直通）。
  if (opts.assPath) {
    const burned = path.join(opts.workDir, "film-subtitled.mp4")
    const burnedRes = await invoke<CommandResult>("execute_command", {
      command: `${ffmpeg} -y -i ${shq(mixedPath)} -vf "subtitles='${opts.assPath.replace(/'/g, "\\'")}'" -c:v libx264 -preset medium -crf 20 -pix_fmt yuv420p -c:a copy -movflags +faststart ${shq(burned)}`,
      timeoutMs: 600000,
    })
    if (burnedRes.exit_code !== 0) return { ok: false, error: `字幕烧录失败：${(burnedRes.stderr || "").slice(-200)}` }
    mixedPath = burned
  }
  if (mixNote) notes.push(mixNote)

  await mkdir(path.dirname(opts.outPath), { recursive: true })
  await Bun.write(opts.outPath, Bun.file(mixedPath))
  return { ok: true, path: opts.outPath, durationSec: probe.durationSec, clipDurations: clipSecs, notes, subtitleCues }
}

export async function assembleFilmNode(
  node: { id?: string; kind: string; metadata: Record<string, unknown> },
  upstream: Map<string, string>,
  graph?: { nodes: { id: string; role: string; kind: string; metadata: Record<string, unknown> }[]; connections: { from: string; to: string }[] },
  session?: { sessionTitle?: string | null } | null,
): Promise<{ nodeId: string; ok: boolean; content?: string; costCoins?: number; message?: string; error?: string }> {
  const nodeId = (node as { id?: string }).id || ""
  const incoming = (graph?.connections ?? []).filter((c) => c.to === nodeId).map((c) => c.from)
  const allVideoUpstream = incoming
    .map((from) => graph?.nodes.find((n) => n.id === from))
    .filter((n): n is VideoUpstream => Boolean(n) && typeof n.id === "string" && n.kind === "video")
  const sources = allVideoUpstream
    .map((n) => ({ id: n.id, role: n.role, url: upstream.get(n.id) }))
    .filter((s): s is { id: string; role: string; url: string } => Boolean(s.url))
  // 配音混流素材：上游 audio 节点（TTS mp3）的内容 URL，成片后自动混入音轨。
  const audioList = incoming
    .map((from) => graph?.nodes.find((n) => n.id === from))
    .filter((n): n is AudioUpstream => Boolean(n) && typeof n.id === "string" && n.kind === "audio")
    .map((n) => upstream.get(n.id))
    .filter((u): u is string => Boolean(u))
  if (!sources.length) {
    return { nodeId, ok: false, error: "成片环没有已完成的镜头输入：请先完成各视频节点，再执行成片" }
  }
  // P0-B 硬闸门（2026-08-31）：宣告的镜头数（上游 video 节点总数）必须等于实际拿到
  // 产物的数量。缺一个都不能拼——修复本次事故「宣告4镜头、实际1镜头仍标success」。
  if (sources.length < allVideoUpstream.length) {
    const missing = allVideoUpstream.filter((n) => !upstream.get(n.id)).map((n) => n.id)
    return {
      nodeId,
      ok: false,
      error: `成片环镜头数量不足：宣告 ${allVideoUpstream.length} 个镜头，仅 ${sources.length} 个完成（缺：${missing.join("、")}）。请先完成全部镜头节点再执行成片`,
    }
  }
  const orderOf = (id: string): number => {
    if (id.includes("title")) return -1
    const m = id.match(/shot(\d+)/)
    return m ? Number(m[1]) : 900
  }
  sources.sort((a, b) => orderOf(a.id) - orderOf(b.id))

  const { invoke } = await import("./editor/adapter/tauri-adapter")
  const { detectFfmpeg } = await import("./editor/canvas/videoCompose")
  const ffmpeg = await detectFfmpeg()
  if (!ffmpeg) return { nodeId, ok: false, error: "未检测到 ffmpeg：成片拼接后端不可用" }

  const workDir = path.join(TTS_AUDIO_DIR, `film-src-${Date.now()}`)
  await mkdir(workDir, { recursive: true })
  try {
    const clips: AssembleClipInput[] = []
    // 字幕轨：台词时间只用已探到的 TTS/音频时长。没有真实时长不铺满镜头。
    const subTextOfShot = (videoRole: string): string => {
      const shotRole = videoRole.replace(/_video$/, "")
      const scriptNode = graph?.nodes.find((n) => n.role === shotRole && n.kind === "text")
      const md = scriptNode?.metadata
      const raw = typeof md?.content === "string" ? md.content : typeof md?.text === "string" ? md.text : typeof md?.prompt === "string" ? md.prompt : ""
      return raw.trim()
    }
    for (let i = 0; i < sources.length; i += 1) {
      const clipPath = path.join(workDir, `clip_${i}.mp4`)
      // 平台产物 URL 直接映射本盘路径（store.tinchak0207.xyz = image-data-api 的公网面，
      // VPS 内 fetch 公网回环慢且不稳）；非平台 URL 才走网络下载。
      const diskBase = "/opt/image-data-api/data"
      const m = sources[i].url.match(/^https:\/\/store\.tinchak0207\.xyz\/image-data\/files\/(.+)$/)
      if (m) {
        const cp = await invoke<CommandResult>("execute_command", { command: `cp ${shq(path.join(diskBase, m[1]))} ${shq(clipPath)}`, timeoutMs: 30000 })
        if (cp.exit_code !== 0) return { nodeId, ok: false, error: "成片环读取镜头素材失败（本地产物缺失）" }
      } else {
        const res = await fetch(sources[i].url, { signal: AbortSignal.timeout(120_000) })
        if (!res.ok) return { nodeId, ok: false, error: `成片环下载镜头素材失败（http ${res.status}）` }
        await Bun.write(clipPath, res)
      }
      const probe = await invoke<CommandResult>("execute_command", {
        command: `${ffmpeg.replace(/ffmpeg$/, "ffprobe")} -v error -show_entries format=duration -of csv=p=0 ${shq(clipPath)}`,
        timeoutMs: 15000,
      })
      const dur = Number.parseFloat((probe.stdout || "").trim())
      const sec = Number.isFinite(dur) && dur > 0 ? dur : 0
      if (sec <= 0) return { nodeId, ok: false, error: "成片环读不到镜头时长（ffprobe 失败），拒绝盲拼" }
      clips.push({ id: sources[i].id, path: clipPath, durationSec: sec, role: sources[i].role, text: subTextOfShot(sources[i].role) })
    }
    type StagedAudio = { path: string; durationSec: number | null }
    const stagedAudios: StagedAudio[] = []
    let audioStageError: string | null = null
    if (audioList.length > 0) {
      try {
        for (let i = 0; i < audioList.length; i += 1) {
          const aPath = path.join(workDir, `audio_${i}.mp3`)
          const mTts = audioList[i].match(/^https:\/\/store\.tinchak0207\.xyz\/agent\/v1\/audio\/([^/?#]+)$/)
          const mDisk = audioList[i].match(/^https:\/\/store\.tinchak0207\.xyz\/image-data\/files\/(.+)$/)
          if (mTts && !mTts[1].includes("..")) {
            const cp = await invoke<CommandResult>("execute_command", { command: `cp ${shq(path.join(TTS_AUDIO_DIR, mTts[1]))} ${shq(aPath)}`, timeoutMs: 30000 })
            if (cp.exit_code !== 0) throw new Error("平台音频本盘缺失")
          } else if (mDisk && !mDisk[1].includes("..")) {
            const cp = await invoke<CommandResult>("execute_command", { command: `cp ${shq(path.join("/opt/image-data-api/data", mDisk[1]))} ${shq(aPath)}`, timeoutMs: 30000 })
            if (cp.exit_code !== 0) throw new Error("平台音频本盘缺失")
          } else {
            const res = await fetch(audioList[i], { signal: AbortSignal.timeout(120_000) })
            if (!res.ok) throw new Error(`音频下载失败（http ${res.status}）`)
            await Bun.write(aPath, res)
          }
          const aProbe = await invoke<CommandResult>("execute_command", {
            command: `${ffmpeg.replace(/ffmpeg$/, "ffprobe")} -v error -show_entries format=duration -of csv=p=0 ${shq(aPath)}`,
            timeoutMs: 15000,
          })
          const aDur = Number.parseFloat((aProbe.stdout || "").trim())
          stagedAudios.push({ path: aPath, durationSec: Number.isFinite(aDur) && aDur > 0 ? aDur : null })
        }
      } catch (e) {
        audioStageError = String((e as Error).message ?? e).slice(0, 200)
        stagedAudios.length = 0
        console.log(`[workflow] assembleFilm audio stage deferred: ${audioStageError}`)
      }
    }
    const projectTitle = String(
      node.metadata?.project_title ?? session?.sessionTitle ?? "",
    ).trim()
    const fileName = `film_${Date.now().toString(36)}.mp4`
    await mkdir(TTS_AUDIO_DIR, { recursive: true })
    const res = await assembleFromClips(clips, stagedAudios, {
      workDir,
      outPath: path.join(TTS_AUDIO_DIR, fileName),
      order: sources.map((s) => s.id),
      title: projectTitle,
      audioRequested: audioList.length,
      audioError: audioStageError,
    })
    if (res.ok !== true) return { nodeId, ok: false, error: (res as { error: string }).error }
    const message = res.notes.filter(Boolean).join("；")
    return { nodeId, ok: true, content: `${TTS_PUBLIC_BASE}/${fileName}`, costCoins: 0, ...(message ? { message } : {}) }
  } finally {
    const { rm } = await import("node:fs/promises")
    await rm(workDir, { recursive: true, force: true }).catch(() => {})
  }
}
