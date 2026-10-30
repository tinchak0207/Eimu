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

  const { setHarnessState, DEFAULT_EXPORT_SETTINGS } = await import("./editor/adapter/editorStore")
  const { exportSelectedMainClips, probeRenderedVideo } = await import("./editor/composeEngine")
  const { detectFfmpeg } = await import("./editor/canvas/videoCompose")
  const shq = (v: string) => `'${String(v).replace(/'/g, "'\\''")}'`
  const { invoke } = await import("./editor/adapter/tauri-adapter")

  const ffmpeg = await detectFfmpeg()
  if (!ffmpeg) return { nodeId, ok: false, error: "未检测到 ffmpeg：成片拼接后端不可用" }

  const workDir = path.join(TTS_AUDIO_DIR, `film-src-${Date.now()}`)
  await mkdir(workDir, { recursive: true })
  try {
    const clipIds: string[] = []
    const clipSecs: number[] = []
    let totalInputSec = 0
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
      totalInputSec += sec
      clipIds.push(`h${i}`)
      clipSecs.push(sec)
    }
    // 字幕轨 + 标题字：台词时间只用已探到的 TTS/音频时长。没有真实时长不铺满镜头。
    // 标题单独占 0..titleEnd，不改台词的 startSec。
    const subTextOfShot = (videoRole: string): string => {
      const shotRole = videoRole.replace(/_video$/, "")
      const scriptNode = graph?.nodes.find((n) => n.role === shotRole && n.kind === "text")
      const md = scriptNode?.metadata
      const raw = typeof md?.content === "string" ? md.content : typeof md?.text === "string" ? md.text : typeof md?.prompt === "string" ? md.prompt : ""
      return raw.trim()
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
    const subtitleCues: { id: string; startSec: number; endSec: number; text: string }[] = []
    {
      const dialogueIdx: number[] = []
      for (let i = 0; i < sources.length; i += 1) {
        if (subTextOfShot(sources[i].role)) dialogueIdx.push(i)
      }
      const pairByShot = stagedAudios.length === sources.length && sources.length > 0
      const pairByLine = !pairByShot && dialogueIdx.length > 0 && stagedAudios.length === dialogueIdx.length
      let cursor = 0
      let lineAudio = 0
      for (let i = 0; i < sources.length; i += 1) {
        const text = subTextOfShot(sources[i].role)
        let dur: number | null = null
        if (pairByShot) dur = stagedAudios[i]?.durationSec ?? null
        else if (pairByLine && text) dur = stagedAudios[lineAudio++]?.durationSec ?? null
        if (text && dur != null && dur > 0) {
          subtitleCues.push({ id: `sub_${i}`, startSec: cursor, endSec: cursor + dur, text })
        }
        cursor += clipSecs[i]
      }
      if (projectTitle) {
        const titleEnd = Math.min(3, Math.max(1, clipSecs[0] ?? 3))
        subtitleCues.unshift({ id: "title", startSec: 0, endSec: titleEnd, text: projectTitle })
      }
    }
    setHarnessState({
      clips: sources.map((_, i) => ({
        id: `h${i}`,
        path: path.join(workDir, `clip_${i}.mp4`),
        label: `seg${i}`,
        duration: clipSecs[i],
        inSec: 0,
        outSec: clipSecs[i],
        transitionAfter: { type: "none", duration: 0 },
      })),
      aspect: "16:9",
      exportSettings: { ...DEFAULT_EXPORT_SETTINGS, resolution: "720p", fps: 24 },
      subtitles: subtitleCues,
    })
    const outPath = await exportSelectedMainClips(clipIds)
    const probe = await probeRenderedVideo(ffmpeg, outPath)
    // 校验门：成片时长不得低于各段输入时长总和的 90%（归一化重编码允许微小误差）
    const minSec = Math.floor(totalInputSec * 0.9)
    if (probe.durationSec < minSec) {
      return { nodeId, ok: false, error: `成片校验未通过：成片 ${probe.durationSec}s 低于输入总长 ${totalInputSec}s 的 90%` }
    }
    // 配音混流（2026-08-30）：audioList 非空时把 TTS 音轨混进成片。禁 -shortest
    //（不准截断视频）；混流任何一步失败降级纯视频成片，message 注明，不整单报错。
    let mixedPath = outPath
    let mixNote = ""
    if (audioList.length > 0) {
      try {
        if (audioStageError || stagedAudios.length !== audioList.length) {
          throw new Error(audioStageError || "配音素材未齐")
        }
        const audioPaths = stagedAudios.map((a) => a.path)
        let totalAudioSec = 0
        for (const a of stagedAudios) {
          if (a.durationSec != null && a.durationSec > 0) totalAudioSec += a.durationSec
        }
        let trackPath = audioPaths[0]
        if (audioPaths.length > 1) {
          const listPath = path.join(workDir, "audio-list.txt")
          await Bun.write(listPath, audioPaths.map((p) => `file '${p.replace(/'/g, "'\\''")}'`).join("\n") + "\n")
          trackPath = path.join(workDir, "audio-merged.m4a")
          const merged = await invoke<CommandResult>("execute_command", {
            command: `${ffmpeg} -y -f concat -safe 0 -i ${shq(listPath)} -c:a aac ${shq(trackPath)}`,
            timeoutMs: 120000,
          })
          if (merged.exit_code !== 0) throw new Error(`多轨合并失败: ${(merged.stderr || "").slice(-200)}`)
        }
        const mixedOut = path.join(workDir, "film-mixed.mp4")
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
    try {
      const { qcAndFixFilm } = await import("./film-qc")
      const qc = await qcAndFixFilm(ffmpeg, mixedPath, path.join(workDir, "film-qc.mp4"))
      mixedPath = qc.path
      if (qc.notes.length) mixNote = [mixNote, ...qc.notes].filter(Boolean).join("；")
      console.log(`[workflow] assembleFilm QC: changed=${qc.changed} lufs=${qc.before.lufs}->${qc.after?.lufs ?? "-"} dur=${qc.before.durationSec}->${qc.after?.durationSec ?? "-"} notes=${qc.notes.join("|").slice(0, 200)}`)
    } catch (e) {
      console.log(`[workflow] assembleFilm QC skipped: ${String((e as Error).message ?? e).slice(0, 160)}`)
    }
    const fileName = `film_${Date.now().toString(36)}.mp4`
    await mkdir(TTS_AUDIO_DIR, { recursive: true })
    await Bun.write(path.join(TTS_AUDIO_DIR, fileName), Bun.file(mixedPath))
    return { nodeId, ok: true, content: `${TTS_PUBLIC_BASE}/${fileName}`, costCoins: 0, ...(mixNote ? { message: mixNote } : {}) }
  } finally {
    const { rm } = await import("node:fs/promises")
    await rm(workDir, { recursive: true, force: true }).catch(() => {})
  }
}
