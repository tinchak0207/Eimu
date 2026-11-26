import { invoke, removeDir, stopBackgroundProcessCommand } from './adapter/tauri-adapter';
import { useEditorStore, EXPORT_RESOLUTIONS, type AudioClip, type ExportSettings } from './adapter/editorStore';
import { detectFfmpeg } from './canvas/videoCompose';
import { xfadeNameOf } from './presets/transitionPresets';
import { buildFxClipDoc, buildTextClipDoc, renderFxTimelineLayer, renderFxTimelineOpaqueSegments, type FxSegmentLayerResult, type FxTimelineProgress } from './adapter/fxRenderStub';
import { toAss } from './subtitleExport';
import { appendArtifact } from './adapter/artifactsStub';
import { buildRenderGraph } from './renderGraph';
import { chooseRenderBackend } from './renderBackends';
import { aspectOutputSize } from './aspect';
import type { CommandResult, ComposeProgress, ExportAnalysis, ExportStrategy, RenderedVideoProbe, RenderedVideoExpectation } from './compose-engine-types';
import { ABR, shq } from './compose-engine-presets';
import { abortError, throwIfAborted, run, sleep, formatEta, ensureDir, writeTextViaShell, normalizeClip, kfExpr, maskAlphaExpr, parseFfmpegProgress, finalVideoEncodeArgs } from './compose-engine-timeline';

export function analyzeEditorExport(): ExportAnalysis {
  const s = useEditorStore.getState();
  const graph = buildRenderGraph();
  const renderBackend = chooseRenderBackend(graph);
  const clips = s.clips.filter((c) => c.path);
  const activeOverlays = s.overlayClips.filter((o) => !o.disabled);
  const activeFxClips = s.fxClips.filter((f) => !f.disabled);
  const activeTextClips = s.textClips.filter((t) => !t.disabled);
  const activeSubtitles = s.subtitles.filter((sub) => !sub.disabled);
  const durationSec = s.totalDuration();
  const hasMainVideo = clips.length > 0;
  const hasOverlays = activeOverlays.length > 0;
  const hasFx = activeFxClips.length > 0;
  const hasText = activeTextClips.length > 0;
  const mutedTracks = new Set(s.audioTracks.filter((t) => t.muted).map((t) => t.id));
  const hasAudio = s.audioClips.some((a) => !a.disabled && !mutedTracks.has(a.trackId));
  const hasSubtitles = activeSubtitles.length > 0;
  const hasVisualEffects = hasOverlays || hasFx || hasText || hasSubtitles;
  const canOpaqueEffectsDirect = !hasMainVideo
    && (hasFx || hasText)
    && !hasOverlays
    && !hasAudio
    && !hasSubtitles
    && (s.exportSettings.format ?? 'mp4') !== 'mov_alpha'
    && (s.exportSettings.background ?? 'black') === 'black';
  const hasTransitions = clips.some((c) => xfadeNameOf(c.transitionAfter.type) !== null && c.transitionAfter.duration > 0);
  const canFastCopy = hasMainVideo
    && clips.length === 1
    && !hasVisualEffects
    && !hasAudio
    && !hasTransitions
    && clips[0].speed === 1
    && !clips[0].reversed
    && !clips[0].flipH
    && !clips[0].rotate
    && !clips[0].filter
    && !clips[0].disabled;
  const canSkipFinalCompose = hasMainVideo
    && !hasVisualEffects
    && !hasAudio
    && !s.exportSettings.denoise
    && !s.exportSettings.loudnorm
    && s.exportSettings.format !== 'mov_alpha';
  let strategy: ExportStrategy = 'standard-compose';
  let recommendation = '完整合成：会按时间轴渲染视频、音频和特效。';
  if (durationSec <= 0.05) {
    strategy = 'empty';
    recommendation = '时间轴没有可导出的内容。';
  } else if (canOpaqueEffectsDirect) {
    strategy = 'opaque-effects-direct';
    recommendation = '黑底 MP4 特效直出：会直接生成普通视频，跳过透明 MOV 和最终叠加。';
  } else if (!hasMainVideo) {
    strategy = 'effects-only';
    recommendation = '无主视频：会自动生成虚拟底片，再叠加特效、花字、音频或字幕。';
  } else if (canFastCopy) {
    strategy = 'simple-copy';
    recommendation = '可走快速导出：当前只有单段纯视频，优先跳过复杂合成。';
  } else if (canSkipFinalCompose) {
    recommendation = '可跳过最终合成：主轨生成后直接封装输出，避免二次重编码。';
  }
  return {
    durationSec,
    hasMainVideo,
    hasOverlays,
    hasFx,
    hasText,
    hasAudio,
    hasSubtitles,
    canFastCopy,
    canSkipFinalCompose,
    needsVirtualBase: !hasMainVideo && durationSec > 0.05,
    strategy,
    recommendation,
    renderBackend,
    renderGraphSummary: {
      nodes: graph.nodes.length,
      durationSec: graph.output.durationSec,
      output: `${graph.output.width}x${graph.output.height}@${graph.output.fps}`,
    },
  };
}

async function readTextIfExists(path: string): Promise<string> {
  const r = await invoke<CommandResult>('execute_command', {
    command: `test -f ${shq(path)} && tail -c 200000 ${shq(path)} || true`,
    timeoutMs: 5000,
  }).catch(() => ({ stdout: '', stderr: '', exit_code: 1 }));
  if (r.exit_code === 0 && r.stdout) return r.stdout;
  return '';
}

async function appendExportDebug(event: string, data: Record<string, unknown>): Promise<void> {
  const home = await invoke<string>('get_home_dir').catch(() => '');
  if (!home) return;
  const path = `${home}/.kunpeng/render-debug/latest.jsonl`;
  const line = JSON.stringify({ time: new Date().toISOString(), event, ...data }) + '\n';
  await invoke('append_file', { path, content: line }).catch(() => null);
}

/** Strong post-render gate shared by the editor and Director Stage. */
export async function probeRenderedVideo(
  ffmpeg: string,
  path: string,
  expected: RenderedVideoExpectation = {},
): Promise<RenderedVideoProbe> {
  const ffprobe = ffmpeg.replace(/ffmpeg$/, 'ffprobe');
  const result = await invoke<CommandResult>('execute_command', {
    command: `${ffprobe} -v error -select_streams v:0 -show_entries stream=codec_name,width,height -show_entries format=format_name,duration,size -of json ${shq(path)}`,
    timeoutMs: 15000,
  }).catch((error) => ({ stdout: '', stderr: String(error), exit_code: 1 }));
  if (result.exit_code !== 0 || !result.stdout.trim()) {
    throw new Error(`成片校验失败：ffprobe 无法读取输出文件。${result.stderr.slice(-300)}`);
  }
  let raw: { streams?: Array<{ codec_name?: string; width?: number; height?: number }>; format?: { format_name?: string; duration?: string; size?: string } };
  try {
    raw = JSON.parse(result.stdout) as typeof raw;
  } catch {
    throw new Error('成片校验失败：媒体信息不是有效 JSON');
  }
  const stream = raw.streams?.[0];
  const probe: RenderedVideoProbe = {
    formatName: raw.format?.format_name ?? '',
    codecName: stream?.codec_name ?? '',
    width: Number(stream?.width ?? 0),
    height: Number(stream?.height ?? 0),
    durationSec: Number(raw.format?.duration ?? 0),
    size: Number(raw.format?.size ?? 0),
  };
  if (!probe.codecName || probe.width <= 0 || probe.height <= 0 || probe.durationSec <= 0 || probe.size < 1024) {
    throw new Error(`成片校验失败：视频轨信息不完整（${probe.codecName || '无编码'}，${probe.width}x${probe.height}，${probe.durationSec.toFixed(2)}s）`);
  }
  const compatibleContainer = expected.format === 'mp4'
    ? /mp4|mov|m4a|3gp/i.test(probe.formatName) && !/avi/i.test(probe.formatName)
    : expected.format === 'mov' ? /mov|mp4/i.test(probe.formatName) && !/avi/i.test(probe.formatName) : true;
  if (!compatibleContainer) throw new Error(`成片校验失败：期望 ${expected.format?.toUpperCase()}，实际容器为 ${probe.formatName || '未知'}`);
  if (expected.width && probe.width !== expected.width) throw new Error(`成片校验失败：期望宽度 ${expected.width}，实际 ${probe.width}`);
  if (expected.height && probe.height !== expected.height) throw new Error(`成片校验失败：期望高度 ${expected.height}，实际 ${probe.height}`);
  if (expected.durationSec) {
    const tolerance = expected.durationToleranceSec ?? Math.max(0.35, expected.durationSec * 0.03);
    if (Math.abs(probe.durationSec - expected.durationSec) > tolerance) {
      throw new Error(`成片校验失败：期望 ${expected.durationSec.toFixed(2)}s，实际 ${probe.durationSec.toFixed(2)}s`);
    }
  }
  const decode = await invoke<CommandResult>('execute_command', {
    command: `${ffmpeg} -v error -xerror -i ${shq(path)} -map 0:v:0 -frames:v 1 -f null -`,
    timeoutMs: 30000,
  }).catch((error) => ({ stdout: '', stderr: String(error), exit_code: 1 }));
  if (decode.exit_code !== 0) throw new Error(`成片校验失败：首帧无法解码。${decode.stderr.slice(-300)}`);
  return probe;
}

export async function runFfmpegWithProgress(args: {
  ffmpeg: string;
  command: string;
  timeoutMs: number;
  progressPath: string;
  logPath: string;
  exitPath: string;
  outputPath: string;
  durationSec: number;
  stageName?: string;
  expectation?: RenderedVideoExpectation;
  signal?: AbortSignal;
  onProgress?: (p: ComposeProgress) => void;
}): Promise<void> {
  const start = Date.now();
  const stageName = args.stageName ?? '最终合成';
  const workerScript = `${args.command} > ${shq(args.logPath)} 2>&1; echo $? > ${shq(args.exitPath)}`;
  const launch = [
    `rm -f ${shq(args.progressPath)} ${shq(args.logPath)} ${shq(args.exitPath)}`,
    `nohup sh -c ${shq(workerScript)} </dev/null >/dev/null 2>&1 & echo $!`,
  ].join('; ');
  const launched = await invoke<CommandResult>('execute_command', { command: launch, timeoutMs: 30000 });
  const pid = launched.stdout.trim().split(/\s+/).pop();
  if (!pid || launched.exit_code !== 0) {
    throw new Error(`启动最终合成失败: ${launched.stderr || launched.stdout}`);
  }
  await appendExportDebug('final-start', {
    pid,
    progressPath: args.progressPath,
    logPath: args.logPath,
    exitPath: args.exitPath,
    outputPath: args.outputPath,
  });

  const stopProcess = async (force = false) => {
    await invoke<CommandResult>('execute_command', {
      command: stopBackgroundProcessCommand(pid, force),
      timeoutMs: 5000,
    }).catch(() => null);
  };

  let lastSec = 0;
  const completeFromOutput = async (elapsedSec: number, event: string) => {
    try {
      await probeRenderedVideo(args.ffmpeg, args.outputPath, args.expectation);
    } catch {
      return false;
    }
    args.onProgress?.({ stage: stageName, detail: `100% · 已运行 ${formatEta(elapsedSec)}`, percent: 100, elapsedSec, etaSec: 0 });
    await appendExportDebug(event, { elapsedSec, logPath: args.logPath, outputPath: args.outputPath });
    return true;
  };

  while (true) {
    if (args.signal?.aborted) {
      await stopProcess(false);
      await sleep(600);
      await stopProcess(true);
      throw abortError();
    }
    const elapsedSec = (Date.now() - start) / 1000;
    if (elapsedSec * 1000 > args.timeoutMs) {
      await stopProcess(false);
      await appendExportDebug('final-timeout', { elapsedSec, logPath: args.logPath });
      throw new Error(`最终合成超时，已运行 ${formatEta(elapsedSec)}。日志：${args.logPath}`);
    }

    const progressText = await readTextIfExists(args.progressPath);
    const outSec = parseFfmpegProgress(progressText);
    if (outSec > 0) lastSec = Math.max(lastSec, outSec);
    if (progressText.includes('progress=end') && await completeFromOutput(elapsedSec, 'final-output-complete-from-progress')) {
      return;
    }
    const percent = args.durationSec > 0 ? Math.max(0, Math.min(99.5, (lastSec / args.durationSec) * 100)) : undefined;
    const etaSec = percent && percent > 1 ? elapsedSec * (100 - percent) / percent : undefined;
    args.onProgress?.({
      stage: stageName,
      detail: percent != null
        ? `${percent.toFixed(1)}% · 已运行 ${formatEta(elapsedSec)} · 预计剩余 ${formatEta(etaSec ?? -1)}`
        : `已运行 ${formatEta(elapsedSec)}`,
      percent,
      elapsedSec,
      etaSec,
    });

    const exitText = await readTextIfExists(args.exitPath);
    if (exitText.trim()) {
      const code = Number(exitText.trim());
      if (code === 0) {
        await probeRenderedVideo(args.ffmpeg, args.outputPath, args.expectation);
        args.onProgress?.({ stage: stageName, detail: `100% · 已运行 ${formatEta(elapsedSec)}`, percent: 100, elapsedSec, etaSec: 0 });
        await appendExportDebug('final-complete', { elapsedSec, logPath: args.logPath });
        return;
      }
      const log = await readTextIfExists(args.logPath);
      await appendExportDebug('final-failed', { code, elapsedSec, logPath: args.logPath, logTail: log.slice(-1600) });
      throw new Error(`ffmpeg 失败（日志：${args.logPath}）: ${log.slice(-1200) || `exit ${code}`}`);
    }

    const alive = await invoke<CommandResult>('execute_command', { command: `kill -0 ${pid} 2>/dev/null && echo OK || true`, timeoutMs: 3000 })
      .catch(() => ({ stdout: '', stderr: '', exit_code: 1 }));
    if (!alive.stdout.includes('OK')) {
      for (let i = 0; i < 80; i++) {
        const exitAgain = await readTextIfExists(args.exitPath);
        if (exitAgain.trim()) {
          const code = Number(exitAgain.trim());
          if (code === 0) {
            await probeRenderedVideo(args.ffmpeg, args.outputPath, args.expectation);
            args.onProgress?.({ stage: stageName, detail: `100% · 已运行 ${formatEta(elapsedSec)}`, percent: 100, elapsedSec, etaSec: 0 });
            await appendExportDebug('final-complete-late', { elapsedSec, logPath: args.logPath });
            return;
          }
          const log = await readTextIfExists(args.logPath);
          await appendExportDebug('final-failed-late', { code, elapsedSec, logPath: args.logPath, logTail: log.slice(-1600) });
          throw new Error(`ffmpeg 失败（日志：${args.logPath}）: ${log.slice(-1200) || `exit ${code}`}`);
        }
        const progressAgain = await readTextIfExists(args.progressPath);
        if (progressAgain.includes('progress=end') && await completeFromOutput(elapsedSec, 'final-output-complete-after-progress-late')) return;
        if (await completeFromOutput(elapsedSec, 'final-output-complete-after-process-lost')) return;
        await sleep(250);
      }
      if (await completeFromOutput(elapsedSec, 'final-output-complete-after-lost')) return;
      const log = await readTextIfExists(args.logPath);
      await appendExportDebug('final-lost', { elapsedSec, logPath: args.logPath, exitPath: args.exitPath, logTail: log.slice(-1600) });
      throw new Error(`最终合成状态读取超时（日志：${args.logPath}）: ${log.slice(-1200) || '已等待最终文件和状态文件，但暂时没有读到完成信息'}`);
    }
    await sleep(1000);
  }
}

function exportTimeoutMs(durationSec: number, complexity = 1): number {
  // 给长片和多层 overlay 更宽的窗口：至少 30 分钟，最多 6 小时。
  const byDuration = durationSec * 1000 * Math.max(18, 8 * complexity);
  return Math.round(Math.max(30 * 60_000, Math.min(6 * 60 * 60_000, byDuration)));
}

export async function exportSelectedMainClips(
  clipIds: string[],
  options: { outputPath?: string; signal?: AbortSignal; onProgress?: (p: ComposeProgress) => void } = {},
): Promise<string> {
  throwIfAborted(options.signal);
  const s = useEditorStore.getState();
  const selected = s.clips.filter((clip) => clip.path && clipIds.includes(clip.id));
  if (selected.length === 0) throw new Error('请先选择主视频轨上的片段');
  const ffmpeg = await detectFfmpeg();
  if (!ffmpeg) throw new Error('未检测到 ffmpeg。请先安装（macOS: brew install ffmpeg；Windows: winget install ffmpeg）');

  const settings = s.exportSettings;
  const res = EXPORT_RESOLUTIONS[settings.resolution];
  const { width: W, height: H } = aspectOutputSize(s.aspect, res);
  const fps = settings.fps;
  const workspace = await invoke<string>('ensure_workspace');
  const outDir = `${workspace}/videos`;
  const tmp = `${outDir}/.selected-export-${Date.now()}`;
  await ensureDir(outDir);
  await ensureDir(tmp);
  let outPath = options.outputPath || `${outDir}/kunpeng_selected_${Date.now()}.mp4`;
  if (options.outputPath) await ensureDir(options.outputPath.split('/').slice(0, -1).join('/'));

  try {
    const segPaths: string[] = [];
    for (let i = 0; i < selected.length; i += 1) {
      const seg = `${tmp}/selected_${i}.mp4`;
      options.onProgress?.({ stage: '导出所选片段', detail: `${i + 1}/${selected.length}`, percent: 10 + (i / selected.length) * 70 });
      await normalizeClip(ffmpeg, selected[i], seg, W, H, fps, options.onProgress, i, options.signal);
      segPaths.push(seg);
    }
    if (segPaths.length === 1) {
      await run(`${ffmpeg} -y -i ${shq(segPaths[0])} -map 0 -c copy -movflags +faststart ${shq(outPath)}`, 120000, options.signal, 'editor-selected-copy');
    } else {
      const listFile = `${tmp}/concat.txt`;
      await writeTextViaShell(listFile, segPaths.map((p) => `file '${p}'`).join('\n'));
      await run(`${ffmpeg} -y -f concat -safe 0 -i ${shq(listFile)} -c copy -movflags +faststart ${shq(outPath)}`, 600000, options.signal, 'editor-selected-concat');
    }
    // 字幕烧录（2026-10-02 接线）：逐行复制 composeEditorTimeline 既有实现——
    // ASS 生成（L1021-1026）＋ `subtitles=` 滤镜（L1106-1110）；无字幕时零行为变更。
    // 复用同一 toAss 轮子与同一滤镜表达式，不新造字幕管线。
    const subCues = s.subtitles.filter((x) => !x.disabled);
    if (subCues.length > 0) {
      options.onProgress?.({ stage: '烧录字幕', detail: `${subCues.length} 条`, percent: 88 });
      const assPath = `${tmp}/subs.ass`;
      await writeTextViaShell(assPath, toAss(subCues, s.aspect));
      const burnedPath = `${tmp}/selected-sub.mp4`;
      await run(
        `${ffmpeg} -y -i ${shq(outPath)} -vf "subtitles='${assPath.replace(/'/g, "\\'")}'" -c:v libx264 -preset medium -crf 20 -pix_fmt yuv420p -c:a copy -movflags +faststart ${shq(burnedPath)}`,
        600000,
        options.signal,
        'editor-selected-subtitle',
      );
      await run(`mv -f ${shq(burnedPath)} ${shq(outPath)}`, 30000, options.signal, 'editor-selected-subtitle-move');
    }
    options.onProgress?.({ stage: '导出所选片段', detail: '100%', percent: 100 });
    await appendArtifact({ path: outPath, type: 'video', prompt: `导出所选片段 ${selected.length} 段`, createdAt: Date.now(), size: 0 } as never);
    return outPath;
  } finally {
    await removeDir(tmp, { recursive: true }).catch(() => {});
  }
}

/** 主入口：导出当前剪辑时间轴为成片 mp4 */
export async function composeEditorTimeline(
  onProgress?: (p: ComposeProgress) => void,
  options: { outputPath?: string; signal?: AbortSignal } = {},
): Promise<string> {
  throwIfAborted(options.signal);
  const s = useEditorStore.getState();
  const clips = s.clips.filter((c) => c.path);
  const analysis = analyzeEditorExport();
  if (analysis.durationSec <= 0.05) throw new Error('时间轴没有可导出的内容');
  const ffmpeg = await detectFfmpeg();
  if (!ffmpeg) throw new Error('未检测到 ffmpeg。请先安装（macOS: brew install ffmpeg；Windows: winget install ffmpeg）');

  const settings: ExportSettings = s.exportSettings;
  const exportFormat = settings.format ?? 'mp4';
  const exportBackground = settings.background ?? 'black';
  const res = EXPORT_RESOLUTIONS[settings.resolution];
  const { width: W, height: H } = aspectOutputSize(s.aspect, res);
  const fps = settings.fps;

  const workspace = await invoke<string>('ensure_workspace');
  const outDir = `${workspace}/videos`;
  const tmp = `${outDir}/.editor-tmp-${Date.now()}`;
  await ensureDir(outDir);
  await ensureDir(tmp);
  const outExt = exportFormat === 'mov_alpha' ? 'mov' : 'mp4';
  const outPath = options.outputPath || `${outDir}/export_${Date.now()}.${outExt}`;
  if (options.outputPath) {
    await ensureDir(outPath.split('/').slice(0, -1).join('/'));
  }

  if (analysis.canFastCopy && exportFormat !== 'mov_alpha') {
    const c = clips[0];
    onProgress?.({ stage: '快速导出', detail: '纯视频裁切，跳过重编码', percent: 20 });
    const finalTmpPath = `${tmp}/fast-copy.mp4`;
    await run(
      `${ffmpeg} -y -ss ${c.inSec.toFixed(3)} -to ${c.outSec.toFixed(3)} -i "${c.path}" -map 0:v:0 -map 0:a:0? -c copy -avoid_negative_ts make_zero -movflags +faststart ${shq(finalTmpPath)}`,
      Math.max(120000, (c.outSec - c.inSec) * 1000 * 2),
      options.signal,
      'editor-fast-export',
    );
    await run(`mv -f ${shq(finalTmpPath)} ${shq(outPath)}`, 30000, options.signal, 'editor-export-move');
    onProgress?.({ stage: '快速导出', detail: '100%', percent: 100 });
    await appendArtifact({ path: outPath, type: 'video', prompt: '剪辑快速导出', createdAt: Date.now(), size: 0 } as never);
    await removeDir(tmp, { recursive: true }).catch(() => {});
    return outPath;
  }

  try {
    onProgress?.({ stage: '分析时间轴', detail: analysis.recommendation, percent: 2 });
    // ── Pass1 逐段归一化 ──
    const segPaths: string[] = [];
    for (let i = 0; i < clips.length; i++) {
      throwIfAborted(options.signal);
      const seg = `${tmp}/seg_${i}.mp4`;
      await normalizeClip(ffmpeg, clips[i], seg, W, H, fps, (p) => {
        const base = 4;
        const span = 12;
        const percent = clips.length > 0 ? base + ((i + 0.5) / clips.length) * span : base;
        onProgress?.({ ...p, percent: p.percent ?? percent });
      }, i, options.signal);
      segPaths.push(seg);
    }

    // ── Pass2 拼接（cut→concat copy；含转场→xfade 链） ──
    onProgress?.({ stage: '拼接转场' });
    throwIfAborted(options.signal);
    const effLens = clips.map((c) => s.clipLength(c));
    const hasTransition = clips.slice(0, -1).some((c) => xfadeNameOf(c.transitionAfter.type) !== null && c.transitionAfter.duration > 0);
    const alphaOutput = exportFormat === 'mov_alpha';
    const transparentVirtualBase = alphaOutput && clips.length === 0;
    let basePath = `${tmp}/base.${transparentVirtualBase ? 'mov' : 'mp4'}`;
    if (clips.length === 0) {
      const bg = alphaOutput || exportBackground === 'transparent' ? 'black@0.0' : 'black';
      const duration = Math.max(0.1, analysis.durationSec);
      onProgress?.({ stage: '生成虚拟底片', detail: `${duration.toFixed(1)}s · ${bg.includes('@0') ? '透明底' : '黑底'}`, percent: 8 });
      const baseVideoArgs = transparentVirtualBase
        ? '-vf format=argb -c:v qtrle -pix_fmt argb'
        : '-c:v libx264 -preset ultrafast -crf 24 -pix_fmt yuv420p';
      await run(
        `${ffmpeg} -y -f lavfi -t ${duration.toFixed(3)} -i "color=c=${bg}:s=${W}x${H}:r=${fps},format=rgba" -f lavfi -t ${duration.toFixed(3)} -i anullsrc=channel_layout=stereo:sample_rate=44100 -map 0:v -map 1:a ${baseVideoArgs} -c:a aac -ar 44100 -ac 2 "${basePath}"`,
        Math.max(120000, duration * 10000),
        options.signal,
        'editor-virtual-base',
      );
    } else if (!hasTransition || clips.length === 1) {
      const listFile = `${tmp}/concat.txt`;
      await writeTextViaShell(listFile, segPaths.map((p) => `file '${p}'`).join('\n'));
      await run(`${ffmpeg} -y -f concat -safe 0 -i "${listFile}" -c copy "${basePath}"`, 600000, options.signal, 'editor-concat');
    } else {
      const inputs = segPaths.map((p) => `-i "${p}"`).join(' ');
      let vPrev = '[0:v]'; let aPrev = '[0:a]'; let offset = 0;
      let fc = '';
      for (let i = 1; i < segPaths.length; i++) {
        const tr = clips[i - 1].transitionAfter;
        const xf = xfadeNameOf(tr.type);
        const d = xf ? Math.min(tr.duration || 0.5, effLens[i - 1], effLens[i]) : 0;
        const vOut = i === segPaths.length - 1 ? '[vout]' : `[vx${i}]`;
        const aOut = i === segPaths.length - 1 ? '[aout]' : `[ax${i}]`;
        if (xf && d > 0.01) {
          offset += effLens[i - 1] - d;
          fc += `${vPrev}[${i}:v]xfade=transition=${xf}:duration=${d.toFixed(2)}:offset=${offset.toFixed(3)}${vOut};`;
          fc += `${aPrev}[${i}:a]acrossfade=d=${d.toFixed(2)}${aOut};`;
        } else {
          offset += effLens[i - 1];
          fc += `${vPrev}[${i}:v]concat=n=2:v=1:a=0${vOut};`;
          fc += `${aPrev}[${i}:a]concat=n=2:v=0:a=1${aOut};`;
        }
        vPrev = vOut; aPrev = aOut;
      }
      await run(`${ffmpeg} -y ${inputs} -filter_complex "${fc.slice(0, -1)}" -map "[vout]" -map "[aout]" -c:v libx264 -preset fast -crf 20 -c:a aac "${basePath}"`, 600000, options.signal, 'editor-transition');
    }

    const mutedTracks = new Set(s.audioTracks.filter((t) => t.muted).map((t) => t.id));
    const activeAudioClips = s.audioClips.filter((a) => !a.disabled && !mutedTracks.has(a.trackId));
    const canSkipFinalCompose = clips.length > 0
      && exportFormat !== 'mov_alpha'
      && s.overlayClips.every((x) => x.disabled)
      && s.textClips.every((x) => x.disabled)
      && s.fxClips.every((x) => x.disabled)
      && s.subtitles.every((x) => x.disabled)
      && activeAudioClips.length === 0
      && !settings.denoise
      && !settings.loudnorm;
    if (canSkipFinalCompose) {
      onProgress?.({ stage: '跳过最终合成', detail: '无覆盖层/字幕/混音，直接输出主轨', percent: 96 });
      await run(`${ffmpeg} -y -i ${shq(basePath)} -map 0 -c copy -movflags +faststart ${shq(outPath)}`, 120000, options.signal, 'editor-base-copy');
      onProgress?.({ stage: '完成导出', detail: '100%', percent: 100 });
      await appendArtifact({ path: outPath, type: 'video', prompt: '剪辑快速导出', createdAt: Date.now(), size: 0 } as never);
      return outPath;
    }

    // ── 花字/特效总轨渲染：Worker 直接渲染整条透明特效时间线 ──
    const fxW = Math.min(W, 1920); // 舞台 16:9，9:16 时整体居中叠放
    const total = s.totalDuration();
    const mainLen = effLens.reduce((a, b) => a + b, 0);
    const renderDuration = Math.max(total, mainLen, 0.1);
    const fxItems = [
      ...s.textClips.filter((t) => !t.disabled).map((t) => ({
        id: t.id,
        startSec: t.startSec,
        durationSec: Math.max(0.2, t.endSec - t.startSec),
        doc: buildTextClipDoc(t),
      })),
      ...s.fxClips.filter((f) => !f.disabled).map((f) => ({
        id: f.id,
        startSec: f.startSec,
        durationSec: Math.max(0.2, f.duration),
        doc: buildFxClipDoc(f),
      })),
    ];
    let fxTrackPath: string | null = null;
    let fxSegmentLayers: FxSegmentLayerResult[] = [];
    const useOpaqueFxBase = clips.length === 0
      && exportFormat !== 'mov_alpha'
      && exportBackground !== 'transparent'
      && s.overlayClips.every((x) => x.disabled)
      && fxItems.length > 0;
    if (fxItems.length > 0) {
      const fxRenderFps = Math.min(fps, 30);
      onProgress?.({
        stage: '渲染特效总轨',
        detail: `${fxItems.length} 个特效`,
        percent: 18,
      });
      throwIfAborted(options.signal);
      const progressBridge = (p: FxTimelineProgress) => {
        const done = p.done ?? 0;
        const totalFrames = p.total ?? 0;
        const framePercent = totalFrames > 0 ? Math.max(0, Math.min(1, done / totalFrames)) : 0;
        const percent = p.stage === 'done'
          ? 72
          : p.stage === 'encode' || p.stage === 'concat'
            ? 66 + framePercent * 5
            : 20 + framePercent * 45;
        const detail = p.detail
          ?? (totalFrames > 0 ? `${done}/${totalFrames}` : '准备渲染透明轨');
        onProgress?.({
          stage: '渲染特效总轨',
          detail,
          percent,
          elapsedSec: p.elapsedSec,
        });
      };
      const opaqueSegments = exportFormat !== 'mov_alpha' && exportBackground !== 'transparent'
        ? await renderFxTimelineOpaqueSegments(fxItems, fxW, fxRenderFps, options.signal, progressBridge)
        : null;
      const layer = opaqueSegments
        ? null
        : await renderFxTimelineLayer(fxItems, fxW, fxRenderFps, renderDuration, options.signal, progressBridge, useOpaqueFxBase);
      throwIfAborted(options.signal);
      if (opaqueSegments) {
        fxSegmentLayers = opaqueSegments;
        fxTrackPath = null;
      } else if (useOpaqueFxBase && layer?.alphaMovPath) {
        basePath = layer.alphaMovPath;
        fxTrackPath = null;
      } else {
        fxTrackPath = layer?.alphaMovPath ?? null;
      }
      if (opaqueSegments) {
        const cacheById = new Map(opaqueSegments.map((x) => [x.id, x.framesDir]));
        for (const t of s.textClips.filter((x) => !x.disabled)) {
          const cachePath = cacheById.get(t.id);
          if (cachePath) s.updateTextClip(t.id, { renderCachePath: cachePath });
        }
        for (const f of s.fxClips.filter((x) => !x.disabled)) {
          const cachePath = cacheById.get(f.id);
          if (cachePath) s.updateFxClip(f.id, { renderCachePath: cachePath });
        }
      } else {
        const cachePath = layer?.framesDir;
        for (const t of s.textClips.filter((x) => !x.disabled)) s.updateTextClip(t.id, { renderCachePath: cachePath });
        for (const f of s.fxClips.filter((x) => !x.disabled)) s.updateFxClip(f.id, { renderCachePath: cachePath });
      }
    }

    // ── 字幕 ASS ──
    let assPath: string | null = null;
    if (s.subtitles.some((x) => !x.disabled)) {
      assPath = `${tmp}/subs.ass`;
      await writeTextViaShell(assPath, toAss(s.subtitles.filter((x) => !x.disabled), s.aspect));
    }

    if (useOpaqueFxBase
      && fxTrackPath === null
      && fxSegmentLayers.length === 0
      && assPath === null
      && activeAudioClips.length === 0
      && !settings.denoise
      && !settings.loudnorm) {
      onProgress?.({ stage: '完成导出', detail: '黑底特效视频直接输出', percent: 96 });
      await run(`${ffmpeg} -y -i ${shq(basePath)} -map 0 -c copy -movflags +faststart ${shq(outPath)}`, 120000, options.signal, 'editor-fx-base-copy');
      onProgress?.({ stage: '完成导出', detail: '100%', percent: 100 });
      await appendArtifact({ path: outPath, type: 'video', prompt: '剪辑黑底特效导出', createdAt: Date.now(), size: 0 } as never);
      return outPath;
    }

    // ── Pass3 终合成：PiP + PNG 序列 + 音频图 + 字幕 + 码率 ──
    onProgress?.({ stage: '最终合成', detail: '长视频会多花一些时间' });
    throwIfAborted(options.signal);
    const inputs: string[] = [`-i "${basePath}"`];
    const fc: string[] = [];
    let vCur = '[0:v]';
    let inIdx = 1;

    // 黑场补尾（overlay/text 超出主轨）
    if (clips.length > 0 && total > mainLen + 0.05) {
      fc.push(`${vCur}tpad=stop_mode=add:stop_duration=${(total - mainLen).toFixed(2)}[vpad]`);
      vCur = '[vpad]';
    }

    // PiP（trackIndex 1 先叠，0 在最上层）
    const overlays = [...s.overlayClips].filter((x) => !x.disabled).sort((a, b) => b.trackIndex - a.trackIndex);
    for (const o of overlays) {
      const ovLen = Math.max(0.1, o.outSec - o.inSec);
      // 静态值：scale/opacity 取首关键帧或 transform（导出近似，见文件头注释）
      const st = o.keyframes?.[0] ?? o.transform;
      const ovW = Math.round(W * Math.max(0.02, Math.min(1, st.scale)));
      if (o.kind === 'image') {
        inputs.push(`-loop 1 -t ${ovLen.toFixed(2)} -i "${o.path}"`);
      } else {
        inputs.push(`-ss ${o.inSec.toFixed(3)} -to ${o.outSec.toFixed(3)} -i "${o.path}"`);
      }
      const lbl = `ov${inIdx}`;
      const rot = o.transform.rotation ? `,rotate=${(o.transform.rotation * Math.PI / 180).toFixed(4)}:c=none:ow=rotw(${(o.transform.rotation * Math.PI / 180).toFixed(4)}):oh=roth(${(o.transform.rotation * Math.PI / 180).toFixed(4)})` : '';
      const mask = maskAlphaExpr(o.mask);
      const alpha = st.opacity < 1 ? `,format=rgba,colorchannelmixer=aa=${st.opacity.toFixed(2)}` : '';
      fc.push(`[${inIdx}:v]scale=${ovW}:-2${rot}${mask}${alpha},setpts=PTS-STARTPTS+${o.startSec.toFixed(3)}/TB[${lbl}]`);
      // x/y 表达式中 overlay 实宽高用 ffmpeg 运行时变量 w/h（kfExpr 以 0 占位后替换）
      const xExpr = o.keyframes?.length
        ? kfExpr(o, 'x', W, H, 0, 0).replaceAll(`(${W}-0)/2`, `(${W}-w)/2`)
        : `(${W}-w)/2+${(o.transform.x * W).toFixed(1)}`;
      const yExpr = o.keyframes?.length
        ? kfExpr(o, 'y', W, H, 0, 0).replaceAll(`(${H}-0)/2`, `(${H}-h)/2`)
        : `(${H}-h)/2+${(o.transform.y * H).toFixed(1)}`;
      const next = `[v${inIdx}]`;
      fc.push(`${vCur}[${lbl}]overlay=x='${xExpr}':y='${yExpr}':enable='between(t,${o.startSec.toFixed(3)},${(o.startSec + ovLen).toFixed(3)})'${next}`);
      vCur = next;
      inIdx++;
    }

    // 花字/特效总透明轨：多层先预合成为 1 路，避免最终合成解码/叠加十几路 ProRes alpha。
    if (fxTrackPath) {
      inputs.push(`-i ${shq(fxTrackPath)}`);
      const lbl = `fx${inIdx}`;
      fc.push(`[${inIdx}:v]format=rgba,setpts=PTS-STARTPTS[${lbl}]`);
      const next = `[v${inIdx}]`;
      fc.push(`${vCur}[${lbl}]overlay=x=(W-w)/2:y=(H-h)/2:format=auto${next}`);
      vCur = next;
      inIdx++;
    }
    for (const fxLayer of fxSegmentLayers) {
      inputs.push(`-i ${shq(fxLayer.alphaMovPath)}`);
      const lbl = `fxseg${inIdx}`;
      fc.push(`[${inIdx}:v]setpts=PTS-STARTPTS+${fxLayer.startSec.toFixed(3)}/TB[${lbl}]`);
      const next = `[v${inIdx}]`;
      fc.push(`${vCur}[${lbl}]overlay=x=(W-w)/2:y=(H-h)/2:enable='between(t,${fxLayer.startSec.toFixed(3)},${(fxLayer.startSec + fxLayer.durationSec).toFixed(3)})'${next}`);
      vCur = next;
      inIdx++;
    }

    // 字幕烧录
    if (assPath) {
      fc.push(`${vCur}subtitles='${assPath.replace(/'/g, "\\'")}'[vsub]`);
      vCur = '[vsub]';
    }

    // 音频图：主轨音频 + audioClips
    const audios: AudioClip[] = activeAudioClips;
    let aCur = '[0:a]';
    if (audios.length > 0) {
      const aLabels: string[] = ['[a0]'];
      fc.push(`[0:a]anull[a0]`);
      for (const a of audios) {
        inputs.push(`-i "${a.path}"`);
        const lbl = `[aa${inIdx}]`;
        const fadeIn = a.fadeInSec ? `,afade=t=in:st=0:d=${a.fadeInSec.toFixed(2)}` : '';
        const len = Math.max(0.1, a.outSec - a.inSec);
        const fadeOut = a.fadeOutSec ? `,afade=t=out:st=${Math.max(0, len - a.fadeOutSec).toFixed(2)}:d=${a.fadeOutSec.toFixed(2)}` : '';
        const delayMs = Math.round(a.startSec * 1000);
        fc.push(`[${inIdx}:a]atrim=${a.inSec.toFixed(3)}:${a.outSec.toFixed(3)},asetpts=PTS-STARTPTS,volume=${a.volume.toFixed(2)}${fadeIn}${fadeOut},adelay=${delayMs}|${delayMs}${lbl}`);
        aLabels.push(lbl);
        inIdx++;
      }
      fc.push(`${aLabels.join('')}amix=inputs=${aLabels.length}:duration=first:normalize=0[amix]`);
      aCur = '[amix]';
    }
    // 响度统一 / 降噪
    const post: string[] = [];
    if (settings.denoise) post.push('afftdn=nf=-25');
    if (settings.loudnorm) post.push('loudnorm=I=-16:TP=-1.5:LRA=11');
    if (post.length > 0) {
      fc.push(`${aCur}${post.join(',')}[afinal]`);
      aCur = '[afinal]';
    }

    const overlayComplexity = 1 + overlays.length + (fxTrackPath ? 1 : 0) + fxSegmentLayers.length * 0.25 + audios.length * 0.35 + (assPath ? 0.5 : 0);
    const finalTimeout = exportTimeoutMs(Math.max(total, mainLen), overlayComplexity);
    const videoMap = vCur === '[0:v]' ? '0:v' : vCur;
    const audioMap = aCur === '[0:a]' ? '0:a' : aCur;
    const filterArg = fc.length > 0 ? `-filter_complex "${fc.join(';')}" ` : '';
    const progressPath = `${tmp}/final-progress.txt`;
    const logPath = `${tmp}/final-ffmpeg.log`;
    const exitPath = `${tmp}/final-exit.txt`;
    const finalTmpPath = `${tmp}/final-output.${alphaOutput ? 'mov' : 'mp4'}`;
    const videoEncodeArgs = await finalVideoEncodeArgs(ffmpeg, settings, W, H);
    const movflags = alphaOutput ? '' : '-movflags +faststart';
    const cmd = `${ffmpeg} -y -nostats -progress ${shq(progressPath)} ${inputs.join(' ')} ${filterArg}-map "${videoMap}" -map "${audioMap}" ${videoEncodeArgs} -r ${fps} -c:a aac -b:a ${ABR[settings.bitrate]} ${movflags} ${shq(finalTmpPath)}`;
    await runFfmpegWithProgress({
      ffmpeg,
      command: cmd,
      timeoutMs: finalTimeout,
      progressPath,
      logPath,
      exitPath,
      outputPath: finalTmpPath,
      durationSec: renderDuration,
      expectation: { format: alphaOutput ? 'mov' : 'mp4', width: W, height: H, durationSec: renderDuration },
      signal: options.signal,
      onProgress,
    });
    await run(`mv -f ${shq(finalTmpPath)} ${shq(outPath)}`, 30000, options.signal, 'editor-export-move');

    await appendArtifact({ path: outPath, type: 'video', prompt: '剪辑成片导出', createdAt: Date.now(), size: 0 } as never);
    return outPath;
  } finally {
    await removeDir(tmp, { recursive: true }).catch(() => {});
  }
}
