import { invoke, createDir, exists } from './adapter/tauri-adapter';
import { type EditorClip, type OverlayClip, type ExportSettings, type MaskSettings } from './adapter/editorStore';
import { hashContent } from './adapter/fxRenderStub';
import { filterToFfmpeg } from './presets/filterPresets';
import type { CommandResult, ComposeProgress } from './compose-engine-types';
import { CRF, HW_BITRATE_1080P, CURVE_PRESETS, shq } from './compose-engine-presets';

function normalizeCurve(mults: number[]): number[] {
  // 调和归一：使 sum(1/m)/n = 1（每段源时长相等时净时长不变）
  const n = mults.length;
  const harm = mults.reduce((s, m) => s + 1 / m, 0) / n;
  return mults.map((m) => m * harm);
}

/** atempo 仅支持 0.5-2，链式拆解任意倍速 */
function atempoChain(speed: number): string {
  const parts: number[] = [];
  let s = speed;
  while (s > 2) { parts.push(2); s /= 2; }
  while (s < 0.5) { parts.push(0.5); s /= 0.5; }
  parts.push(s);
  return parts.map((p) => `atempo=${p.toFixed(4)}`).join(',');
}

export function abortError(): Error {
  return new Error('已停止导出');
}

export function throwIfAborted(signal?: AbortSignal): void {
  if (signal?.aborted) throw abortError();
}

function commandRequestId(prefix: string): string {
  return `${prefix}-${Date.now()}-${Math.random().toString(36).slice(2)}`;
}

export async function run(cmd: string, timeoutMs = 600000, signal?: AbortSignal, requestPrefix = 'editor-export'): Promise<void> {
  throwIfAborted(signal);
  const requestId = commandRequestId(requestPrefix);
  const onAbort = () => {
    void invoke('kill_command', { requestId }).catch(() => {});
  };
  signal?.addEventListener('abort', onAbort, { once: true });
  let r: CommandResult;
  try {
    // Rust 端 timeoutMs 是 u64，浮点会直接反序列化失败
    r = await invoke<CommandResult>('execute_command', { command: cmd, timeoutMs: Math.ceil(timeoutMs), requestId });
  } catch (err) {
    throwIfAborted(signal);
    throw err;
  } finally {
    signal?.removeEventListener('abort', onAbort);
  }
  throwIfAborted(signal);
  if (r.exit_code !== 0) {
    throw new Error(`ffmpeg 失败: ${r.stderr.slice(-400)}`);
  }
}

export async function hasVideoToolbox(ffmpeg: string): Promise<boolean> {
  const r = await invoke<CommandResult>('execute_command', {
    command: `${ffmpeg} -hide_banner -encoders 2>/dev/null | grep -q h264_videotoolbox && echo OK`,
    timeoutMs: 10000,
  }).catch(() => ({ stdout: '', stderr: '', exit_code: 1 }));
  return r.exit_code === 0 && r.stdout.includes('OK');
}

async function hasHevcVideoToolbox(ffmpeg: string): Promise<boolean> {
  const r = await invoke<CommandResult>('execute_command', {
    command: `${ffmpeg} -hide_banner -encoders 2>/dev/null | grep -q hevc_videotoolbox && echo OK`,
    timeoutMs: 10000,
  }).catch(() => ({ stdout: '', stderr: '', exit_code: 1 }));
  return r.exit_code === 0 && r.stdout.includes('OK');
}

export async function finalVideoEncodeArgs(ffmpeg: string, settings: ExportSettings, width: number, height: number): Promise<string> {
  if (settings.format === 'mov_alpha') {
    return '-c:v prores_ks -profile:v 4 -pix_fmt yuva444p10le -vendor apl0';
  }
  if (settings.encoder === 'hevc' && await hasHevcVideoToolbox(ffmpeg)) {
    const pixels = Math.max(1, width * height);
    const scale = pixels / (1920 * 1080);
    const kbps = Math.round(HW_BITRATE_1080P[settings.bitrate] * scale * 0.72);
    return `-c:v hevc_videotoolbox -allow_sw 1 -tag:v hvc1 -b:v ${kbps}k -maxrate ${Math.round(kbps * 1.8)}k -pix_fmt yuv420p`;
  }
  if (await hasVideoToolbox(ffmpeg)) {
    const pixels = Math.max(1, width * height);
    const scale = pixels / (1920 * 1080);
    const kbps = Math.round(HW_BITRATE_1080P[settings.bitrate] * scale);
    return `-c:v h264_videotoolbox -allow_sw 1 -b:v ${kbps}k -maxrate ${Math.round(kbps * 1.8)}k -pix_fmt yuv420p`;
  }
  return `-c:v libx264 -preset veryfast -crf ${CRF[settings.bitrate]}`;
}

export function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export function formatEta(sec: number): string {
  if (!Number.isFinite(sec) || sec < 0) return '计算中';
  const s = Math.round(sec);
  const m = Math.floor(s / 60);
  const r = s % 60;
  if (m <= 0) return `${r}s`;
  return `${m}m ${String(r).padStart(2, '0')}s`;
}

export function parseFfmpegProgress(text: string): number {
  const matches = [...text.matchAll(/out_time_ms=(\d+)/g)];
  if (matches.length > 0) {
    const ms = Number(matches[matches.length - 1][1]);
    if (Number.isFinite(ms)) return ms / 1_000_000;
  }
  const timeMatches = [...text.matchAll(/out_time=(\d+):(\d+):(\d+(?:\.\d+)?)/g)];
  if (timeMatches.length > 0) {
    const m = timeMatches[timeMatches.length - 1];
    return Number(m[1]) * 3600 + Number(m[2]) * 60 + Number(m[3]);
  }
  return 0;
}

async function fileFingerprint(path: string): Promise<string> {
  const r = await invoke<CommandResult>('execute_command', {
    command: `(stat -f '%m:%z' ${shq(path)} 2>/dev/null || stat -c '%Y:%s' ${shq(path)} 2>/dev/null || echo unknown)`,
    timeoutMs: 5000,
  }).catch(() => ({ stdout: 'unknown', stderr: '', exit_code: 1 }));
  return r.stdout.trim() || 'unknown';
}

async function normalizedClipCachePath(c: EditorClip, w: number, h: number, fps: number): Promise<{ video: string; done: string }> {
  const home = await invoke<string>('get_home_dir');
  const fingerprint = await fileFingerprint(c.path);
  const key = hashContent(JSON.stringify({
    v: 2,
    path: c.path,
    fingerprint,
    duration: c.duration,
    inSec: Number(c.inSec.toFixed(3)),
    outSec: Number(c.outSec.toFixed(3)),
    speed: c.speed ?? 1,
    curvePreset: c.curvePreset ?? '',
    reversed: Boolean(c.reversed),
    flipH: Boolean(c.flipH),
    rotate: c.rotate ?? 0,
    filter: c.filter ?? null,
    disabled: Boolean(c.disabled),
    w,
    h,
    fps,
  }));
  const dir = `${home}/.kunpeng/render-cache/segments/${key}`;
  return { video: `${dir}/segment.mp4`, done: `${dir}/done.json` };
}

export async function ensureDir(path: string): Promise<void> {
  await createDir(path, { recursive: true }).catch(() => {});
  const r = await invoke<CommandResult>('execute_command', {
    command: `mkdir -p ${shq(path)} && test -d ${shq(path)}`,
    timeoutMs: 15000,
  });
  if (r.exit_code !== 0) {
    throw new Error(`创建导出目录失败: ${path}\n${r.stderr || r.stdout}`);
  }
}

function textToBase64(text: string): string {
  const bytes = new TextEncoder().encode(text);
  let bin = '';
  const CHUNK = 8192;
  for (let i = 0; i < bytes.length; i += CHUNK) {
    bin += String.fromCharCode(...bytes.subarray(i, i + CHUNK));
  }
  return btoa(bin);
}

export async function writeTextViaShell(path: string, contents: string): Promise<void> {
  const b64 = textToBase64(contents);
  const script = [
    "python3 - <<'PY'",
    'import base64, pathlib',
    `path = ${JSON.stringify(path)}`,
    `data = ${JSON.stringify(b64)}`,
    'pathlib.Path(path).parent.mkdir(parents=True, exist_ok=True)',
    'pathlib.Path(path).write_bytes(base64.b64decode(data))',
    'PY',
  ].join('\n');
  const r = await invoke<CommandResult>('execute_command', { command: script, timeoutMs: 15000 });
  if (r.exit_code !== 0) {
    throw new Error(`写入导出临时文件失败: ${path}\n${r.stderr || r.stdout}`);
  }
}

export async function hasAudioStream(ffmpeg: string, path: string): Promise<boolean> {
  const ffprobe = ffmpeg.replace(/ffmpeg$/, 'ffprobe');
  const r = await invoke<CommandResult>('execute_command', {
    command: `${ffprobe} -v error -select_streams a:0 -show_entries stream=codec_type -of csv=p=0 "${path}"`,
    timeoutMs: 15000,
  }).catch(() => ({ stdout: '', stderr: '', exit_code: 1 }));
  return r.exit_code === 0 && /audio/.test(r.stdout);
}

function clipNeedsNormalize(c: EditorClip, w: number, h: number, fps: number): boolean {
  void w; void h; void fps;
  return Boolean(
    c.disabled
    || c.speed !== 1
    || c.curvePreset
    || c.reversed
    || c.flipH
    || c.rotate
    || c.filter
    || (c.volume != null && Math.abs(c.volume - 1) > 0.001),
  );
}

/** 单段视频归一化滤镜链（不含音频） */
function clipVideoFilters(c: EditorClip, w: number, h: number, fps: number): string {
  const f: string[] = [];
  if (c.reversed) f.push('reverse');
  if (c.flipH) f.push('hflip');
  if (c.rotate === 90) f.push('transpose=1');
  else if (c.rotate === 180) f.push('transpose=1,transpose=1');
  else if (c.rotate === 270) f.push('transpose=2');
  const color = filterToFfmpeg(c.filter);
  if (color) f.push(color);
  f.push(`scale=${w}:${h}:force_original_aspect_ratio=increase`, `crop=${w}:${h}`, `fps=${fps}`);
  return f.join(',');
}

/** Pass1：单段归一化（含变速/曲线变速/倒放音频） */
export async function normalizeClip(
  ffmpeg: string, c: EditorClip, out: string,
  w: number, h: number, fps: number, onProgress?: (p: ComposeProgress) => void, idx?: number, signal?: AbortSignal,
): Promise<void> {
  throwIfAborted(signal);
  const clipNo = (idx ?? 0) + 1;
  const cache = await normalizedClipCachePath(c, w, h, fps);
  const cacheReady = (await exists(cache.done).catch(() => false)) && (await exists(cache.video).catch(() => false));
  if (cacheReady) {
    onProgress?.({ stage: '处理片段', detail: `${clipNo} · 命中缓存` });
    await run(`cp -f ${shq(cache.video)} ${shq(out)}`, 30000, signal, 'editor-segment-cache-copy');
    return;
  }
  onProgress?.({ stage: '处理片段', detail: `${clipNo} · 准备素材` });
  await ensureDir(cache.video.split('/').slice(0, -1).join('/'));
  const cacheTmp = `${cache.video}.tmp-${Date.now()}.mp4`;
  const targetOut = cacheTmp;
  if (c.disabled) {
    const dur = Math.max(0.1, (c.outSec - c.inSec) / (c.speed && c.speed > 0 ? c.speed : 1));
    await run(
      `${ffmpeg} -y -f lavfi -t ${dur.toFixed(3)} -i "color=c=black:s=${w}x${h}:r=${fps}" -f lavfi -t ${dur.toFixed(3)} -i anullsrc=channel_layout=stereo:sample_rate=44100 -map 0:v -map 1:a -c:v libx264 -preset ultrafast -crf 24 -pix_fmt yuv420p -c:a aac -ar 44100 -ac 2 ${shq(targetOut)}`,
      Math.max(120000, dur * 6000),
      signal,
      'editor-disabled-segment',
    );
    await run(`mv -f ${shq(targetOut)} ${shq(cache.video)} && cp -f ${shq(cache.video)} ${shq(out)}`, 30000, signal, 'editor-segment-cache-store');
    await writeTextViaShell(cache.done, JSON.stringify({ createdAt: Date.now(), source: c.path, disabled: true }));
    return;
  }
  const hasAudio = await hasAudioStream(ffmpeg, c.path);
  if (!clipNeedsNormalize(c, w, h, fps) && hasAudio) {
    await run(
      `${ffmpeg} -y -ss ${c.inSec.toFixed(3)} -to ${c.outSec.toFixed(3)} -i ${shq(c.path)} -map 0:v:0 -map 0:a:0? -c copy -avoid_negative_ts make_zero ${shq(targetOut)}`,
      600000,
      signal,
      'editor-fast-trim',
    );
    await run(`mv -f ${shq(targetOut)} ${shq(cache.video)} && cp -f ${shq(cache.video)} ${shq(out)}`, 30000, signal, 'editor-segment-cache-store');
    await writeTextViaShell(cache.done, JSON.stringify({ createdAt: Date.now(), source: c.path }));
    return;
  }
  const trim = `-ss ${c.inSec.toFixed(3)} -to ${c.outSec.toFixed(3)}`;
  const vf = clipVideoFilters(c, w, h, fps);
  const speed = c.speed && c.speed > 0 ? c.speed : 1;
  const curve = c.curvePreset ? CURVE_PRESETS[c.curvePreset] : undefined;

  if (!curve || curve.length < 2) {
    // 恒速：setpts + atempo
    const v = speed !== 1 ? `${vf},setpts=PTS/${speed.toFixed(4)}` : vf;
    const aRev = c.reversed ? 'areverse,' : '';
    const volume = Math.max(0, Math.min(2, c.volume ?? 1));
    const aBase = speed !== 1 ? `${aRev}${atempoChain(speed)}` : (c.reversed ? 'areverse' : 'anull');
    const a = `${aBase},volume=${volume.toFixed(3)}`;
    const dur = Math.max(0.1, c.outSec - c.inSec);
    const input = hasAudio
      ? `${trim} -i ${shq(c.path)}`
      : `${trim} -i ${shq(c.path)} -f lavfi -t ${dur.toFixed(3)} -i anullsrc=channel_layout=stereo:sample_rate=44100`;
    const audioLabel = hasAudio ? '[0:a]' : '[1:a]';
    await run(`${ffmpeg} -y ${input} -filter_complex "[0:v]${v}[v];${audioLabel}${a}[a]" -map "[v]" -map "[a]" -c:v libx264 -preset fast -crf 20 -c:a aac -ar 44100 -ac 2 ${shq(targetOut)}`, 600000, signal, 'editor-normalize');
    await run(`mv -f ${shq(targetOut)} ${shq(cache.video)} && cp -f ${shq(cache.video)} ${shq(out)}`, 30000, signal, 'editor-segment-cache-store');
    await writeTextViaShell(cache.done, JSON.stringify({ createdAt: Date.now(), source: c.path }));
    return;
  }

  // 曲线变速：源区间等分 N 段，每段恒速（调和归一保总时长），trim+concat 单命令完成
  const mults = normalizeCurve(curve).map((m) => m * speed);
  const n = mults.length;
  const span = (c.outSec - c.inSec) / n;
  const dur = Math.max(0.1, c.outSec - c.inSec);
  const segs: string[] = [];
  const labels: string[] = [];
  mults.forEach((m, i) => {
    const s0 = (c.inSec + i * span).toFixed(3);
    const s1 = (c.inSec + (i + 1) * span).toFixed(3);
    const a0 = hasAudio ? s0 : (i * span).toFixed(3);
    const a1 = hasAudio ? s1 : ((i + 1) * span).toFixed(3);
    const aInput = hasAudio ? '[0:a]' : '[1:a]';
    segs.push(
      `[0:v]trim=${s0}:${s1},setpts=(PTS-STARTPTS)/${m.toFixed(4)}[v${i}];` +
      `${aInput}atrim=${a0}:${a1},asetpts=PTS-STARTPTS,${atempoChain(m)}[a${i}]`,
    );
    labels.push(`[v${i}][a${i}]`);
  });
  const volume = Math.max(0, Math.min(2, c.volume ?? 1));
  const fc = `${segs.join(';')};${labels.join('')}concat=n=${n}:v=1:a=1[vc][ac0];[vc]${vf}[v];[ac0]volume=${volume.toFixed(3)}[ac]`;
  const input = hasAudio
    ? `-i ${shq(c.path)}`
    : `-i ${shq(c.path)} -f lavfi -t ${dur.toFixed(3)} -i anullsrc=channel_layout=stereo:sample_rate=44100`;
  await run(`${ffmpeg} -y ${input} -filter_complex "${fc}" -map "[v]" -map "[ac]" -c:v libx264 -preset fast -crf 20 -c:a aac -ar 44100 -ac 2 ${shq(targetOut)}`, 600000, signal, 'editor-normalize');
  await run(`mv -f ${shq(targetOut)} ${shq(cache.video)} && cp -f ${shq(cache.video)} ${shq(out)}`, 30000, signal, 'editor-segment-cache-store');
  await writeTextViaShell(cache.done, JSON.stringify({ createdAt: Date.now(), source: c.path }));
}

/** 关键帧 x/y → overlay 分段线性 t 表达式（像素坐标，相对叠放起点 startSec） */
export function kfExpr(
  o: OverlayClip, axis: 'x' | 'y', baseW: number, baseH: number, ovW: number, ovH: number,
): string {
  const center = (v: number) => axis === 'x'
    ? `(${baseW}-${ovW})/2+${(v * baseW).toFixed(1)}`
    : `(${baseH}-${ovH})/2+${(v * baseH).toFixed(1)}`;
  const kfs = o.keyframes && o.keyframes.length > 0 ? o.keyframes : null;
  if (!kfs) return center(o.transform[axis]);
  if (kfs.length === 1) return center(kfs[0][axis]);
  // 嵌套 if(lt(t,...)) 分段线性插值；t 是 program 时间，关键帧 t 相对片段开始
  let expr = center(kfs[kfs.length - 1][axis]);
  for (let i = kfs.length - 2; i >= 0; i--) {
    const k0 = kfs[i]; const k1 = kfs[i + 1];
    const t0 = (o.startSec + k0.t).toFixed(3);
    const t1 = (o.startSec + k1.t).toFixed(3);
    const v0 = center(k0[axis]); const v1 = center(k1[axis]);
    const lerp = `(${v0})+((${v1})-(${v0}))*(t-${t0})/(${t1}-${t0})`;
    expr = `if(lt(t,${t1}),if(lt(t,${t0}),${v0},${lerp}),${expr})`;
  }
  return expr;
}

export function maskAlphaExpr(mask?: MaskSettings): string {
  if (!mask?.enabled) return '';
  const cx = Math.max(0, Math.min(1, 0.5 + mask.x));
  const cy = Math.max(0, Math.min(1, 0.5 + mask.y));
  const halfW = Math.max(0.001, Math.min(0.5, mask.width / 2));
  const halfH = Math.max(0.001, Math.min(0.5, mask.height / 2));
  let inside: string;
  if (mask.type === 'circle') {
    inside = `lte(pow((X-W*${cx.toFixed(4)})/(W*${halfW.toFixed(4)}),2)+pow((Y-H*${cy.toFixed(4)})/(H*${halfH.toFixed(4)}),2),1)`;
  } else if (mask.type === 'linear') {
    inside = `lte(Y,H*${cy.toFixed(4)})`;
  } else if (mask.type === 'mirror') {
    inside = `between(X,W*${Math.max(0, cx - halfW).toFixed(4)},W*${Math.min(1, cx + halfW).toFixed(4)})`;
  } else {
    inside = `between(X,W*${Math.max(0, cx - halfW).toFixed(4)},W*${Math.min(1, cx + halfW).toFixed(4)})*between(Y,H*${Math.max(0, cy - halfH).toFixed(4)},H*${Math.min(1, cy + halfH).toFixed(4)})`;
  }
  const alpha = mask.invert ? `if(${inside},0,255)` : `if(${inside},255,0)`;
  return `,format=rgba,geq=r='r(X,Y)':g='g(X,Y)':b='b(X,Y)':a='${alpha}'`;
}
