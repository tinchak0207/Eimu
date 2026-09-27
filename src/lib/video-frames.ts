// 影片抽帧（D-16）：浏览器端把影片均匀抽成 4 帧 JPEG，走既有附件上传路径。
//
// 设计文档锁定的规格（agent-chat-ux-design.md §3.6）：
//   - 均匀 4 帧：第一帧、1/3、2/3、最后一帧。
//   - 上限：时长 60 秒、文件 100 MB，超过就拒收并说明（不静默截断）。
//   - 理由：4 帧够覆盖内容变化，又压得住 Groq 眼睛的成本。
//
// 本文件保持纯逻辑（不依赖 DOM/浏览器 API），可用 node:test 测；
// 真正触碰 <video>/<canvas> 的部分放在本文件末尾的 extractVideoFrames()，
// 由 AgentComposer 传入浏览器对象，node 下不会 import 进来执行。
//
// 注释与提示文案统一简体中文。

import type { AgentAttachmentRef } from "./agent-chat-types";

// ─────────────────────────── 上限常量

/** 时长上限（秒）。超过直接拒收。 */
export const MAX_VIDEO_DURATION_SECONDS = 60;

/** 文件大小上限（字节）。超过直接拒收。 */
export const MAX_VIDEO_FILE_BYTES = 100 * 1024 * 1024; // 100 MB

/** 缩略图长边上限（px），够 Groq 看且省上传带宽。 */
export const MAX_FRAME_EDGE_PX = 512;

/** 抽出的帧数：文档锁 4 帧。 */
export const FRAME_COUNT = 4;

/**
 * 最后一帧的回退量（秒）。
 *
 * 为什么不直接 seek 到 duration：多数浏览器在 seek 到末尾（== duration）时
 * 拿不到最后一帧——要么画到黑帧，要么 seeked 事件不触发。留一点回退量
 * （duration - 0.05s）让浏览器落在真正的最后一个可见画面附近。0.05s 对
 * H.264/AAC 的典型 GOP（0.5~1s）来说足够小，不会跳回上一段，但能骗过
 * 播放器对"seek == duration 等于停在 endofstream、无帧可解"的边角处理。
 */
export const LAST_FRAME_SEEK_BACKOFF_S = 0.05;

// ─────────────────────────── 纯函数（可测）

export interface FrameTimestamp {
  /** 命名序号，0 起。 */
  index: number;
  /** 该帧在视频中的时间点（秒）。 */
  time: number;
  /** 该帧位置的文字描述，例如「约 3.4 秒」，用于预览缩图的 alt。 */
  label: string;
}

/**
 * 计算 4 个抽帧时间点：第一帧、1/3、2/3、最后一帧。
 *
 * 严格照文档：t0 = 0，t1 = duration/3，t2 = 2*duration/3，
 * t3 = duration（经回退与边界钳制后）。
 *
 * 边界处理（都怕极短影片撞出非法值）：
 *   - 至少 4 帧：时长极短的 << 0.05 的片段，各时间点钳制到 [0, duration]。
 *   - t3 最后的钳制：完全退化（时长 ≤ 回退量）时回落为第一帧，不依赖 seek 失败兜底。
 */
export function computeFrameTimestamps(duration: number): FrameTimestamp[] {
  const safeDuration = Number.isFinite(duration) ? Math.max(0, duration) : 0;
  // duration 为 NaN/Infinity（未知时长的流）时 safeDuration 归 0，
  // 于是下面所有时间点都落在 0：拿到 4 张首帧，也不会 seek 到 NaN 卡死。

  // 均匀 FRAME_COUNT 帧：i / (FRAME_COUNT - 1) 把 [0,1] 等分，
  // 4 帧正好是 0、1/3、2/3、1，与文档一致；最后一帧减回退量。
  const lastIndex = FRAME_COUNT - 1;
  const timestamps: FrameTimestamp[] = Array.from({ length: FRAME_COUNT }, (_, i) => {
    const time = i === lastIndex ? safeDuration - LAST_FRAME_SEEK_BACKOFF_S : (safeDuration * i) / lastIndex;
    return { index: i, time, label: formatFrameTime(time) };
  });

  // 最后一帧回退后仍必须落在 [0, duration]，
  // 且当 duration ≤ 回退量（极短/退化影片）时直接退回第一帧。
  const maxSeek = timestamps[timestamps.length - 1];
  if (maxSeek) {
    maxSeek.time = Math.min(Math.max(0, maxSeek.time), safeDuration);
    maxSeek.label = formatFrameTime(maxSeek.time);
    if (safeDuration < LAST_FRAME_SEEK_BACKOFF_S) {
      // 时长太短，后面的三个点都坍缩到首帧，没必要 seek / drawImage，直接取首帧。
      for (let i = 1; i < timestamps.length; i++) {
        timestamps[i].time = 0;
        timestamps[i].label = formatFrameTime(0);
      }
    }
  }

  return timestamps;
}

/** 把秒格式成「约 3.4 秒」这类文案（保留一位小数）。导出给节点动作与 API 的帧清单复用同一文案。 */
export function formatFrameTime(seconds: number): string {
  const rounded = Math.round(seconds * 10) / 10;
  return `约 ${rounded} 秒`;
}

/** 文件大小的人类可读文案，用于超限提示。 */
export function formatBytes(bytes: number): string {
  if (!Number.isFinite(bytes)) return "未知大小";
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

/**
 * 校验影片是否符合 D-16 上限，返回拒收原因或 null。
 * 超限必须明确提示（拒收不静默截断），一次列出所有超出的项。
 */
export function validateVideoFile(file: { size: number; duration: number }): string | null {
  const issues: string[] = [];
  if (file.duration > MAX_VIDEO_DURATION_SECONDS) {
    issues.push(
      `时长 ${formatSeconds(file.duration)} 超过上限 60 秒（超出 ${formatSeconds(
        file.duration - MAX_VIDEO_DURATION_SECONDS,
      )}）`,
    );
  }
  if (file.size > MAX_VIDEO_FILE_BYTES) {
    issues.push(
      `文件 ${formatBytes(file.size)} 超过上限 100 MB（超出 ${formatBytes(
        file.size - MAX_VIDEO_FILE_BYTES,
      )}）`,
    );
  }
  return issues.length > 0 ? issues.join("，") : null;
}

function formatSeconds(seconds: number): string {
  return Math.round(seconds * 10) / 10 === 0 ? "0" : `${Math.round(seconds * 10) / 10}`;
}

// ─────────────────────────── 节点动作：截帧 / 序列帧计划（纯函数，可测）

/**
 * 序列帧的帧数上限。
 *
 * 为什么是 24：每一帧都要 seek 一次再 drawImage，浏览器 seek 是 100~300ms
 * 量级；24 帧 ≈ 3~7 秒，仍在「节点动作」可接受的等待内。再高就该走后端合成
 * （本仓不提供该路径），所以到顶**明确拒绝**，绝不静默截断。
 */
export const MAX_SEQUENCE_FRAMES = 24;

/** 抽帧模式：current = 取指定时刻单帧；sequence = 按间隔或帧数抽序列帧。 */
export type FrameActionMode = "current" | "sequence";

export interface FrameExtractionRequest {
  /** 视频总时长（秒）。必须是有限正数。 */
  durationSec: number;
  mode: FrameActionMode;
  /** sequence 用：抽帧间隔（秒）。与 count 二选一。 */
  intervalSec?: number;
  /** sequence 用：均分帧数。与 intervalSec 二选一。 */
  count?: number;
  /** current 用：要取的那一帧在视频中的时刻（秒）。 */
  atSec?: number;
}

/** 计划结果。**任何非法输入都回 ok:false，绝不抛异常**（调用方是路由与 UI，不能靠 try 兜）。 */
export type FrameExtractionPlan =
  | { ok: true; timesSec: number[] }
  | { ok: false; reason: string };

/** 毫秒对齐，杀掉 0.30000000000000004 这类浮点尾巴后再进输出。 */
function alignToMillis(seconds: number): number {
  return Math.round(seconds * 1000) / 1000;
}

function isPositiveFinite(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value) && value > 0;
}

/**
 * 把「抽帧意图」算成具体时间点列表（节点动作的纯逻辑层，node 可测）。
 *
 * 规则（与上传统抽帧共用同一条「绝不 seek 到 duration」的坑位经验）：
 *   - current：atSec 单点。atSec === duration 时回退 LAST_FRAME_SEEK_BACKOFF_S
 *     （seek 到末尾多数浏览器拿不到画面）；atSec > duration 直接拒绝。
 *   - sequence + intervalSec：t = 0, interval, 2*interval … 严格小于 duration 的全收
 *     （末点不 seek 到片尾）。帧数 = ceil(duration/interval)，超上限拒绝。
 *   - sequence + count：把 [0, duration) 均分 count 份，末点回退 LAST_FRAME_SEEK_BACKOFF_S，
 *     与 computeFrameTimestamps 的末帧规矩一致。
 *   - intervalSec 与 count 同时给 / 都不给 → 拒绝（不猜用户意图）。
 *
 * 输出全部毫秒对齐、单调递增、落在 [0, duration)；浮点撞点去重后不回退成重复帧。
 */
export function planFrameExtraction(req: FrameExtractionRequest): FrameExtractionPlan {
  const durationSec = req?.durationSec;
  if (!isPositiveFinite(durationSec)) {
    return { ok: false, reason: "视频时长未知或不是正数，无法计算抽帧时间点。" };
  }

  if (req.mode === "current") {
    const atSec = req.atSec;
    if (typeof atSec !== "number" || !Number.isFinite(atSec)) {
      return { ok: false, reason: "提取当前帧需要给出 atSec（秒）。" };
    }
    if (atSec < 0) {
      return { ok: false, reason: `提取时刻 ${alignToMillis(atSec)} 秒不能为负。` };
    }
    if (atSec > durationSec) {
      return {
        ok: false,
        reason: `提取时刻 ${alignToMillis(atSec)} 秒超过视频长度 ${alignToMillis(durationSec)} 秒。`,
      };
    }
    const clamped =
      atSec >= durationSec ? Math.max(0, durationSec - LAST_FRAME_SEEK_BACKOFF_S) : atSec;
    return { ok: true, timesSec: [alignToMillis(clamped)] };
  }

  if (req.mode !== "sequence") {
    return { ok: false, reason: `未知的抽帧模式：${String(req.mode)}。` };
  }

  const hasInterval = req.intervalSec !== undefined;
  const hasCount = req.count !== undefined;
  if (hasInterval && hasCount) {
    return { ok: false, reason: "intervalSec 与 count 只能给一个，不能同时指定。" };
  }
  if (!hasInterval && !hasCount) {
    return { ok: false, reason: "序列帧需要给出 intervalSec（按间隔）或 count（按帧数）。" };
  }

  if (hasInterval) {
    const intervalSec = req.intervalSec;
    if (!isPositiveFinite(intervalSec)) {
      return { ok: false, reason: `抽帧间隔必须是正数，收到 ${String(intervalSec)}。` };
    }
    const expected = Math.ceil(durationSec / intervalSec);
    if (expected > MAX_SEQUENCE_FRAMES) {
      return {
        ok: false,
        reason: `按间隔 ${alignToMillis(intervalSec)} 秒会抽出 ${expected} 帧，超过上限 ${MAX_SEQUENCE_FRAMES} 帧，请把间隔调大。`,
      };
    }
    const timesSec: number[] = [];
    for (let i = 0; i < expected; i++) {
      const t = alignToMillis(i * intervalSec);
      if (t >= durationSec) break; // 绝不 seek 到 duration 本身
      if (timesSec.length > 0 && t <= timesSec[timesSec.length - 1]) continue; // 浮点撞点去重
      timesSec.push(t);
    }
    return { ok: true, timesSec };
  }

  const count = req.count;
  if (typeof count !== "number" || !Number.isInteger(count) || count <= 0) {
    return { ok: false, reason: `帧数必须是正整数，收到 ${String(count)}。` };
  }
  if (count > MAX_SEQUENCE_FRAMES) {
    return { ok: false, reason: `帧数 ${count} 超过上限 ${MAX_SEQUENCE_FRAMES} 帧，请调小。` };
  }
  if (count === 1) {
    return { ok: true, timesSec: [0] };
  }
  const maxSeek = durationSec - LAST_FRAME_SEEK_BACKOFF_S;
  const timesSec: number[] = [];
  for (let i = 0; i < count; i++) {
    const raw = i === count - 1 ? maxSeek : (durationSec * i) / (count - 1);
    const t = alignToMillis(Math.min(Math.max(0, raw), Math.max(0, maxSeek)));
    if (timesSec.length > 0 && t <= timesSec[timesSec.length - 1]) continue; // 极短影片去重
    timesSec.push(t);
  }
  return { ok: true, timesSec };
}

// ─────────────────────────── 浏览器侧抽帧（AgentComposer 调用）

/** 视频元素（带原样本）的 typed 引用，避免重复拼接标签。 */
export interface VideoElementSample {
  video: HTMLVideoElement;
  sample: AgentAttachmentRef;
}

/**
 * 从 <video> 元素抽出 4 帧 JPEG（纯浏览器，无法在 node 下测试）。
 *
 * 真实的坑，逐个处理（每处都有注释）：
 *   1. 必须等 loadedmetadata 才能读 duration。
 *   2. seek 后必须等 seeked 事件再 drawImage，否则画到的是上一帧。
 *   3. video.muted = true + playsInline，否则部分浏览器不给解码。
 *   4. canvas 按视频原始宽高比缩到长边 MAX_FRAME_EDGE_PX。
 *
 * Object URL 的生命周期归调用方：抽完帧后预览区还要让原片可播（D-16），
 * 这里 revoke 会把预览一起弄哑。调用方在移除／送出附件时自己 revoke。
 *
 * @param sample 由 AgentComposer 用 URL.createObjectURL 建成（含 Object URL）。
 * @param onProgress 每完成一帧回调一次（参数 = 已完成帧数），便于 UI 显示进度。
 *   agent 聊天区不用进度条也可以不传。
 * @returns 4 张 JPEG blob，顺序与 frameTimestamps 一致。
 */
export async function extractVideoFrames(
  sample: VideoElementSample,
  onProgress?: (done: number, total: number) => void,
): Promise<Blob[]> {
  const { video, sample: s } = sample;

  // 1) 关键坑：不能依赖 duration 提前可读，必须在 loadedmetadata 之后再动手。
  if (video.readyState < 1) {
    await new Promise<void>((resolve, reject) => {
      const onLoaded = () => {
        video.removeEventListener("loadedmetadata", onLoaded);
        resolve();
      };
      const onError = () => {
        video.removeEventListener("error", onError);
        reject(new Error("视频解码失败，无法读取。"));
      };
      video.addEventListener("loadedmetadata", onLoaded);
      video.addEventListener("error", onError);
    });
  }

  const duration = Number.isFinite(video.duration) ? video.duration : 0;
  // 已传 size/时长到校验层，这里假定通过；再查一遍防御（上限来自同一常量）。
  const rejectReason = validateVideoFile({ size: s.size ?? 0, duration });
  if (rejectReason) throw new Error(`视频超出上限：${rejectReason}`);

  const timestamps = computeFrameTimestamps(duration);
  // 进度分母取实际要跑的帧数，而不是常量：两者一旦不一致，
  // UI 会卡在 3/4 或跳到 5/4，都是假进度。
  const total = timestamps.length;

  // 3) 必须静音 + 内联播放，否则部分浏览器不给解码（seek 无画面可 draw）。
  video.muted = true;
  (video as HTMLVideoElement & { playsInline?: boolean }).playsInline = true;

  const frames: Blob[] = [];
  onProgress?.(0, total);
  for (const f of timestamps) {
    await seekTo(video, f.time);
    frames.push(await captureFrame(video));
    onProgress?.(frames.length, total);
  }
  return frames;
}

// ─────────────────────────── 节点动作：按计划抽帧（浏览器侧执行层）

/** 一帧的抽取结果：blob + 时间点，供节点动作落成画布图片。 */
export interface ExtractedFrameAt {
  index: number;
  /** 该帧在视频中的时间点（秒），来自 planFrameExtraction。 */
  timeSec: number;
  /** 预览 alt 用的中文文案（与帧批抽同一格式）。 */
  label: string;
  blob: Blob;
}

/**
 * 按 planFrameExtraction 给出的时间点抽帧（节点动作的执行层）。
 *
 * 复用既有视频抽帧的同一套原语（waitForMetadata / seekTo / captureFrame），
 * **不重写** video→canvas→blob 流程；与 extractVideoFrames 的唯一差别是
 * 时间点由调用方给（支持截帧/序列帧），而不是写死 4 帧。
 *
 * 为什么不在这里调 validateVideoFile：那是**上传统**的 60 秒 / 100MB 闸门；
 * 节点动作抽的是已生成视频的帧，代价由计划层的 MAX_SEQUENCE_FRAMES 兜住，
 * 不应对长视频直接拒收（也不改上传统的行为）。
 *
 * Object URL 生命周期仍归调用方（同 extractVideoFrames 的注释）。
 *
 * @param timesSec 毫秒对齐、单调递增、落在 [0, duration) 的时间点（plan 的输出）。
 * @returns 与 timesSec 等长、顺序一致的帧。
 */
export async function extractFramesAtTimes(
  sample: VideoElementSample,
  timesSec: number[],
  onProgress?: (done: number, total: number) => void,
): Promise<ExtractedFrameAt[]> {
  const { video } = sample;
  const total = timesSec.length;
  if (total === 0) return [];

  // 同 extractVideoFrames 的坑：读 duration / seek 前必须等 loadedmetadata。
  await waitForMetadata(video);
  video.muted = true;
  (video as HTMLVideoElement & { playsInline?: boolean }).playsInline = true;

  const frames: ExtractedFrameAt[] = [];
  onProgress?.(0, total);
  for (let i = 0; i < total; i++) {
    const timeSec = timesSec[i];
    await seekTo(video, timeSec);
    frames.push({ index: i, timeSec, label: formatFrameTime(timeSec), blob: await captureFrame(video) });
    onProgress?.(frames.length, total);
  }
  return frames;
}

/** 判断一个 File 是否要走抽帧路径（MIME 优先，扩展名兜底：部分系统给空 MIME）。 */
export function isVideoFile(file: { type?: string; name?: string }): boolean {
  if (file.type?.startsWith("video/")) return true;
  return /\.(mp4|mov|m4v|webm)$/i.test(file.name ?? "");
}

/** 抽帧结果：4 张 JPEG + 各自的时间点文案（缩图 alt 用）。 */
export interface ExtractedFrames {
  files: File[];
  timestamps: FrameTimestamp[];
}

/**
 * 从一个视频 File 抽出 4 帧 JPEG，直接给成可上传的 File。
 *
 * 调用方负责 objectUrl 的 revoke（预览要留着播原片，见 extractVideoFrames 注释）。
 * 超限（60 秒 / 100 MB）在 metadata 到手后立刻抛错，且错误文案就是拒收原因——
 * 绝不静默截断成前 60 秒。
 */
export async function extractFramesFromFile(
  file: File,
  objectUrl: string,
  onProgress?: (done: number, total: number) => void,
): Promise<ExtractedFrames> {
  const video = document.createElement("video");
  video.preload = "metadata";
  video.muted = true;
  (video as HTMLVideoElement & { playsInline?: boolean }).playsInline = true;
  video.src = objectUrl;

  const sample: AgentAttachmentRef = {
    kind: "video",
    url: objectUrl,
    name: file.name,
    mime: file.type || "video/mp4",
    size: file.size,
  };

  const blobs = await extractVideoFrames({ video, sample }, onProgress);
  const timestamps = computeFrameTimestamps(Number.isFinite(video.duration) ? video.duration : 0);
  const base = file.name.replace(/\.[^.]+$/, "") || "video";

  return {
    files: blobs.map(
      (blob, i) => new File([blob], `${base}-frame-${i + 1}.jpg`, { type: "image/jpeg" }),
    ),
    timestamps,
  };
}

/**
 * 等 loadedmetadata（读 duration / seek 前必须）。
 *
 * extractVideoFrames 内联着同一段（上传统路径依赖它，硬约束禁改其行为），
 * 这里独立一份给节点动作的 extractFramesAtTimes 用；两段语义逐字相同。
 */
async function waitForMetadata(video: HTMLVideoElement): Promise<void> {
  if (video.readyState >= 1) return;
  await new Promise<void>((resolve, reject) => {
    const onLoaded = () => {
      video.removeEventListener("loadedmetadata", onLoaded);
      resolve();
    };
    const onError = () => {
      video.removeEventListener("error", onError);
      reject(new Error("视频解码失败，无法读取。"));
    };
    video.addEventListener("loadedmetadata", onLoaded);
    video.addEventListener("error", onError);
  });
}

/** 等待 video 跳到指定时间（等 seeked，否则 draw 到的是上一帧）。 */
async function seekTo(video: HTMLVideoElement, time: number): Promise<void> {
  return new Promise<void>((resolve) => {
    let done = false;
    const finish = () => {
      if (done) return;
      done = true;
      video.removeEventListener("seeked", onSeeked);
      video.removeEventListener("error", onError);
      resolve();
    };
    const onSeeked = () => finish();
    const onError = () => finish();
    video.addEventListener("seeked", onSeeked);
    video.addEventListener("error", onError);
    video.currentTime = time;
    // 老 Safari 对「已经在这个时间点」的 seek 不触发 seeked，会永远等下去。
    // 延迟一拍确认位置已到，再自己 resolve；仍要等这一拍，否则 drawImage 读到上一帧。
    if (video.readyState >= 2) {
      setTimeout(() => {
        if (!done && Math.abs(video.currentTime - time) <= 0.001) finish();
      }, 64);
    }
  });
}

/**
 * 单帧 capture：canvas 缩到长边 512、按原始宽高比，导出 JPEG。
 * 真实坑：canvas 只能画同源/可跨域资源，Object URL 是同源的；另外
 * canvas 的尺寸是 CSS 像素，与视频的 internal 分辨率不同时，只要
 * drawImage 用 video element 本身即可拿到完整的解码帧。
 */
async function captureFrame(video: HTMLVideoElement): Promise<Blob> {
  const raw = video.videoWidth;
  const rawH = video.videoHeight;
  if (!raw || !rawH) throw new Error("取帧失败：视频没有画面尺寸。");

  const scale = Math.min(1, MAX_FRAME_EDGE_PX / Math.max(raw, rawH));
  const width = Math.max(1, Math.round(raw * scale));
  const height = Math.max(1, Math.round(rawH * scale));

  const canvas = document.createElement("canvas");
  canvas.width = width;
  canvas.height = height;
  const ctx = canvas.getContext("2d");
  if (!ctx) throw new Error("取帧失败：浏览器不支持 canvas 2D。");

  // 垫白再画：JPEG 没有 alpha，带透明通道的 WebM 不垫底会导出成黑块。
  ctx.fillStyle = "#FFFFFF";
  ctx.fillRect(0, 0, width, height);
  ctx.drawImage(video, 0, 0, width, height);

  // 质量 0.8：视觉模型够看，体积又只有 1.0 的一半左右。
  return new Promise<Blob>((resolve, reject) => {
    canvas.toBlob((blob) => {
      if (!blob) return reject(new Error("取帧失败：无法导出图像。"));
      resolve(blob);
    }, "image/jpeg", 0.8);
  });
}

