/**
 * waveform — 音频波形峰值提取（施工片 B3 轮子移植，2026-08-31）。
 *
 * 源：kunpeng-vendor @872a58b src/lib/editor/waveform.ts 逐行移植；
 * drawWaveform 跳过（canvas UI gateway 侧用不上，明文白名单）。
 * 算法本体（8kHz mono s16le 解码、50 桶/秒峰值、内存+inflight+磁盘三级缓存）
 * 一字节不动。
 *
 * 改写白名单（仅此三处，均为 IO 管道，不触算法）：
 *   1. @tauri-apps/api/tauri invoke → ./editor/adapter/tauri-adapter invoke
 *      （execute_command 同签名，返回 {stdout,stderr,exit_code} 同构）。
 *   2. @tauri-apps/api/fs + @tauri-apps/api/path homeDir → node:fs/promises +
 *      tauri-adapter homeDir()（=process.env.HOME），缓存根 $HOME/.kunpeng/waveforms。
 *   3. detectFfmpeg import '@/lib/canvas/videoCompose' → './editor/canvas/videoCompose'
 *      （gateway 上已在位，候选表第一位 ~/.kunpeng/bin/ffmpeg）。
 */
import { readFile, writeFile, rm, access, mkdir } from 'node:fs/promises';
import path from 'node:path';
import { invoke, homeDir } from './editor/adapter/tauri-adapter';
import { detectFfmpeg } from './editor/canvas/videoCompose';

interface CommandResult { stdout: string; stderr: string; exit_code: number }

const SAMPLE_RATE = 8000;
/** 每秒峰值桶数（时间轴 1 桶 ≈ 20ms，缩放绘制再聚合） */
export const PEAKS_PER_SEC = 50;

function hashPath(p: string): string {
  let h = 5381;
  for (let i = 0; i < p.length; i++) h = ((h << 5) + h + p.charCodeAt(i)) >>> 0;
  return h.toString(36);
}

const memCache = new Map<string, number[]>();
const inflight = new Map<string, Promise<number[] | null>>();

/** 解码媒体音轨为 s16le PCM（8kHz mono），返回临时文件绝对路径；无音轨返回 null */
export async function extractPcm(mediaPath: string): Promise<string | null> {
  const ffmpeg = await detectFfmpeg();
  if (!ffmpeg) return null;
  const home = await homeDir();
  const dir = path.join(home, '.kunpeng/waveforms');
  const abs = path.join(dir, `.pcm-${hashPath(mediaPath)}.raw`);
  await mkdir(dir, { recursive: true }).catch(() => {});
  const r = await invoke<CommandResult>('execute_command', {
    command: `${ffmpeg} -y -i "${mediaPath}" -vn -ac 1 -ar ${SAMPLE_RATE} -f s16le "${abs}"`,
    timeoutMs: 120000,
  }).catch(() => ({ stdout: '', stderr: '', exit_code: 1 } as CommandResult));
  if (r.exit_code !== 0) return null;
  return abs;
}

/** PCM 文件 → 峰值数组（0..1，PEAKS_PER_SEC 桶/秒） */
export async function pcmToPeaks(pcmAbsPath: string): Promise<number[]> {
  // 白名单改写 2：readBinaryFile→readFile；new Uint8Array(buffer) 复制出独立
  // backing（byteOffset=0），保持 vendor 原行 Int16Array 构造语义不变。
  const bytes = new Uint8Array(await readFile(pcmAbsPath));
  const samples = new Int16Array(bytes.buffer, bytes.byteOffset, Math.floor(bytes.byteLength / 2));
  const perBucket = Math.floor(SAMPLE_RATE / PEAKS_PER_SEC);
  const peaks: number[] = [];
  for (let i = 0; i < samples.length; i += perBucket) {
    let max = 0;
    const end = Math.min(i + perBucket, samples.length);
    for (let j = i; j < end; j++) {
      const v = Math.abs(samples[j]);
      if (v > max) max = v;
    }
    peaks.push(Number((max / 32768).toFixed(3)));
  }
  return peaks;
}

/** 获取媒体波形峰值（内存 + inflight + 磁盘三级缓存） */
export async function getWaveform(mediaPath: string): Promise<number[] | null> {
  const hit = memCache.get(mediaPath);
  if (hit) return hit;
  const existing = inflight.get(mediaPath);
  if (existing) return existing;

  const task = (async (): Promise<number[] | null> => {
    try {
      const home = await homeDir();
      const cacheAbs = path.join(home, '.kunpeng/waveforms', `${hashPath(mediaPath)}.json`);
      if (await access(cacheAbs).then(() => true, () => false)) {
        const peaks = JSON.parse(await readFile(cacheAbs, 'utf8')) as number[];
        memCache.set(mediaPath, peaks);
        return peaks;
      }
      const pcm = await extractPcm(mediaPath);
      if (!pcm) return null;
      const peaks = await pcmToPeaks(pcm);
      await rm(pcm, { force: true }).catch(() => {});
      await writeFile(cacheAbs, JSON.stringify(peaks));
      memCache.set(mediaPath, peaks);
      return peaks;
    } catch {
      return null;
    } finally {
      inflight.delete(mediaPath);
    }
  })();

  inflight.set(mediaPath, task);
  return task;
}
