// local-media-ingest.ts — 本机影片前处理（W1，2026-10-04）
//
// 目的：把「影片原档上传到云端让 agent 看」换成「在本机抽出衍生档，只上行衍生档」。
//   · 本机前处理：读 metadata → 依时长决定关键帧数 → 用既有 video-frames 抽帧 → 抽一张海报。
//   · 上行物：关键帧 JPEG ＋ poster JPEG ＋ probe JSON（体积极小）。
//   · 原档只有在 ingest 失败／降级时才回到今天的 uploadVideoDirect 路径（渐进增强）。
//
// 硬约束（读任何修改前先读）：
//   · 抽帧核心**不重写**——一律经由 `video-frames.ts` 的 `extractFramesAtTimes` / `waitForMetadata`。
//   · `ingestMediaLocally()` **永不抛出**：任何一步失败只记在 `degraded`，回一份尽量完整的结果，
//     让呼叫端能安全退回今天的原档路径（不得中断整条附件流程）。
//   · 本机没有的东西（真正的 fps／容器内的 codec 名／精确音轨）**不冒充**：能拿就拿，
//     拿不到栏位一律 `null`（未知 ≠ 已知无）。probe 栏位语义照 `media-quality-gate.ts` 的
//     `MediaProbe`（`sizeBytes`／`durationSec`／`width`／`height` 同名同义；未知以 null 表达）。
//   · 纯逻辑（计划帧数／边长／位元组加总）与浏览器 I/O 分层：前者可在 node:test 直测，
//     后者包成可注入的 `LocalMediaSession`，测试用假 session 覆盖成功／降级路径。

import {
  MAX_FRAME_EDGE_PX,
  extractFramesAtTimes,
  planFrameExtraction,
  waitForMetadata,
  type FrameExtractionPlan,
  type VideoElementSample,
} from "./video-frames";

// ─────────────────────────── 常量

/** 关键帧数下限（短片的均匀取样仍要几张）。 */
export const MIN_LOCAL_KEYFRAMES = 4;

/** 关键帧数上限（浏览器每个时间点一次 seek，100~300ms；12 帧 ≈ 数秒等待）。 */
export const MAX_LOCAL_KEYFRAMES = 12;

/** 每多少秒多分一帧（短片落在下限、长片往上加、到上限为止）。 */
export const LOCAL_KEYFRAME_SECONDS_PER_FRAME = 15;

/**
 * 衍生档的送行体积软上限。站内附件代理（Vercel）单请求体硬顶 4.5MB，
 * 留边界后与 `AgentComposer` 的 `MAX_FILE_BYTES`（4MB）对齐：超过就标降级，
 * 退回原档直传，绝不让衍生档把代理撞 413。
 */
export const MAX_DERIVED_UPLOAD_BYTES = 4 * 1024 * 1024;

/**
 * 整条 ingest 的总上限（毫秒）。全流程皆为本机记忆体解码（无网路）：最多 12 张关键帧
 * 各一次 seek（约 3-4 秒）＋海报，30 秒远超任何合理耗时。它只在「某一阶段异常卡死」
 * 时兜底，保证 `ingestMediaLocally` 绝不永久 pending，让呼叫端能落到原档降级路径。
 */
export const INGEST_TIMEOUT_MS = 30_000;

/** 海报取样时间点（秒）。取首帧（关键帧用等分中点，不含 0，故不重复）。 */
export const POSTER_TIME_SECONDS = 0;

// ─────────────────────────── 型别

/**
 * 本机 probe。栏位名与语义对齐 `media-quality-gate.ts` 的 `MediaProbe`：
 * `sizeBytes`／`durationSec`／`width`／`height` 同名；拿不到的以 `null` 表示未知。
 */
export interface LocalMediaProbe {
  /** 影片时长（秒）；未知为 null。 */
  durationSec: number | null;
  /** 解码后画面宽（px）；未知为 null。 */
  width: number | null;
  /** 解码后画面高（px）；未知为 null。 */
  height: number | null;
  /** 帧率。浏览器没有可靠的容器 metadata 读法，目前一律 undefined（不冒充）。 */
  fps?: number;
  /** 容器内的视讯 codec 名。浏览器读不到，目前一律 undefined（不冒充）。 */
  videoCodec?: string;
  /** 容器内音讯 codec 名。浏览器读不到，目前一律 undefined（不冒充）。 */
  audioCodec?: string;
  /** 是否含音轨。能确定才给 boolean，确定不了给 null（未知 ≠ 已知无）。 */
  hasAudio: boolean | null;
  /** 整体位元率（bits/s）＝ sizeBytes*8/durationSec；时长未知则 undefined。 */
  bitrate?: number;
  /** 原档位元组（= File.size）。 */
  sizeBytes: number;
}

/** 一张关键帧。 */
export interface LocalMediaKeyframe {
  /** 该帧在影片中的时刻（秒）。 */
  tSec: number;
  /** 抽出的 JPEG。 */
  blob: Blob;
  /** 抽出后长边实际像素（≤ MAX_FRAME_EDGE_PX）。 */
  edgePx: number;
}

/** `ingestMediaLocally` 的产物。 */
export interface LocalMediaIngest {
  probe: LocalMediaProbe;
  keyframes: LocalMediaKeyframe[];
  /** 代表帧 JPEG（首帧）。取不到时为退化的空 Blob（size=0）。 */
  poster: Blob;
  /** 上行衍生档位元组总和（关键帧＋poster＋probe JSON）。 */
  derivedBytes: number;
  /** 原档位元组。 */
  sourceBytes: number;
  /** 任何一步失败的原因；有值即代表呼叫端应退回今天的原档路径。 */
  degraded?: string;
}

export interface LocalMediaIngestOptions {
  signal?: AbortSignal;
  /** 进度回报：stage ∈ metadata|frames|poster|done，pct ∈ [0,1]。永不因回报失败而中断。 */
  onProgress?: (stage: string, pct: number) => void;
  /**
   * 整条 ingest 的总上限（毫秒）。预设 `INGEST_TIMEOUT_MS`；逾时回 `degraded`（绝不
   * 永久 pending）。主要供测试缩短等待，生产用预设即可。
   */
  timeoutMs?: number;
}

export interface LocalMediaMetadata {
  durationSec: number | null;
  width: number | null;
  height: number | null;
  hasAudio: boolean | null;
}

/**
 * 浏览器 I/O 的注入面（测试用假物件覆盖成功／降级分支，node 下不会碰 DOM）。
 * 真实实作见 `createBrowserMediaSession`，底层逐字复用 `video-frames.ts` 的抽帧原语。
 */
export interface LocalMediaSession {
  readMetadata(): Promise<LocalMediaMetadata>;
  extractFrames(
    timesSec: readonly number[],
    onProgress?: (done: number, total: number) => void,
  ): Promise<LocalMediaKeyframe[]>;
  capturePoster(tSec: number): Promise<Blob>;
  dispose(): void;
}

// ─────────────────────────── 纯函式（node:test 可直测）

/**
 * 依时长决定关键帧数：每 `LOCAL_KEYFRAME_SECONDS_PER_FRAME` 秒一帧，
 * 夹在 [MIN_LOCAL_KEYFRAMES, MAX_LOCAL_KEYFRAMES]。非法／非正时长回下限
 * （短片与未知时长都不会算出 NaN／0 帧）。
 */
export function planKeyframeCount(durationSec: number): number {
  if (!Number.isFinite(durationSec) || durationSec <= 0) return MIN_LOCAL_KEYFRAMES;
  const byDuration = Math.ceil(durationSec / LOCAL_KEYFRAME_SECONDS_PER_FRAME);
  return Math.min(MAX_LOCAL_KEYFRAMES, Math.max(MIN_LOCAL_KEYFRAMES, byDuration));
}

/**
 * 依时长算出关键帧时间点。**复用** `planFrameExtraction`（sequence + count，等距中点），
 * 不另写时间轴逻辑：时长未知／超上限／算出 0 帧等都由它回 `ok:false`。
 * 中点取样天然落在 (0, duration) 且严格递增，符合 `extractFramesAtTimes` 的契约。
 */
export function planKeyframeTimes(durationSec: number): FrameExtractionPlan {
  return planFrameExtraction({ durationSec, mode: "sequence", count: planKeyframeCount(durationSec) });
}

/**
 * 抽出后的长边像素。与 `video-frames.captureFrame` 的缩放同式：
 * `scale = min(1, MAX_FRAME_EDGE_PX / max(w,h))`，长边 = round(max*scale)。
 * 来源小于上限时维持原始长边，不放大。
 */
export function frameEdgePx(rawWidth: number, rawHeight: number): number {
  const maxDim = Math.max(Number.isFinite(rawWidth) ? rawWidth : 0, Number.isFinite(rawHeight) ? rawHeight : 0);
  if (maxDim <= 0) return 0;
  const scale = Math.min(1, MAX_FRAME_EDGE_PX / maxDim);
  return Math.max(1, Math.round(maxDim * scale));
}

/** 只加总有效（有限、>0）的位元组；其余视为 0（不让 NaN／负值污染总量）。 */
export function computeDerivedBytes(sizes: readonly number[]): number {
  let total = 0;
  for (const size of sizes) {
    if (typeof size === "number" && Number.isFinite(size) && size > 0) total += size;
  }
  return total;
}

/** probe JSON 的 UTF-8 位元组数（与实际上行的档案大小同源）。 */
export function estimateProbeJsonBytes(probe: LocalMediaProbe): number {
  try {
    return new TextEncoder().encode(JSON.stringify(probe)).length;
  } catch {
    return 0;
  }
}

/** ingest 结果能否直接当作「只上行衍生档」用（未降级、且至少有一张关键帧）。 */
export function isIngestUsable(
  result: LocalMediaIngest | null | undefined,
): result is LocalMediaIngest & { keyframes: [LocalMediaKeyframe, ...LocalMediaKeyframe[]] } {
  return result != null && !result.degraded && result.keyframes.length > 0;
}

/**
 * 把 ingest 产物打包成可上行的 File[]：关键帧 JPEG ＋ poster JPEG（非空才收）＋ probe JSON。
 * 顺序稳定（关键帧 → 海报 → probe），呼叫端可直接对应回 refs。
 */
export function toDerivedFiles(result: LocalMediaIngest, fileName: string): File[] {
  const base = fileName.replace(/\.[^.]+$/, "") || "video";
  const files: File[] = [];
  result.keyframes.forEach((frame, index) => {
    files.push(new File([frame.blob], `${base}-keyframe-${index + 1}.jpg`, { type: "image/jpeg" }));
  });
  if (result.poster.size > 0) {
    files.push(new File([result.poster], `${base}-poster.jpg`, { type: "image/jpeg" }));
  }
  files.push(new File([JSON.stringify(result.probe)], `${base}-probe.json`, { type: "application/json" }));
  return files;
}

/**
 * 从 `<video>` 判断有无音轨。**只回能确定的答案**：
 *   · Firefox `mozHasAudio` 为权威（true/false 皆可信）。
 *   · 部分浏览器的 `audioTracks.length` 可信。
 *   · Chromium `webkitAudioDecodedByteCount` 要在解码后才非 0；我们不播放，
 *     量到 0 **不代表无音轨**，故只把 >0 当 true，0 一律回 null（不冒充）。
 *   · 都拿不到 → null。
 */
export function detectHasAudio(video: HTMLVideoElement): boolean | null {
  const v = video as HTMLVideoElement & {
    mozHasAudio?: boolean;
    webkitAudioDecodedByteCount?: number;
    audioTracks?: { length: number };
  };
  if (typeof v.mozHasAudio === "boolean") return v.mozHasAudio;
  if (v.audioTracks && typeof v.audioTracks.length === "number") return v.audioTracks.length > 0;
  if (typeof v.webkitAudioDecodedByteCount === "number") {
    return v.webkitAudioDecodedByteCount > 0 ? true : null;
  }
  return null;
}

// ─────────────────────────── 执行层（可注入 session，永不抛出）

function errText(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

function emptyPoster(): Blob {
  return new Blob([], { type: "image/jpeg" });
}

const UNKNOWN_PROBE = (sourceBytes: number): LocalMediaProbe => ({
  durationSec: null,
  width: null,
  height: null,
  hasAudio: null,
  sizeBytes: sourceBytes,
});

/** 一份全降级结果（session 都建不起来时用）。永不抛出。 */
function degradedResult(sourceBytes: number, reason: string): LocalMediaIngest {
  return {
    probe: UNKNOWN_PROBE(sourceBytes),
    keyframes: [],
    poster: emptyPoster(),
    derivedBytes: 0,
    sourceBytes,
    degraded: reason,
  };
}

/**
 * 跑完整条本机前处理。**任何一步失败只记 `degraded`，绝不抛出**；
 * 后续能做的步骤继续做（例如抽帧失败仍试著拿海报），回一份尽量完整的结果。
 */
export async function runLocalMediaIngest(
  file: File,
  session: LocalMediaSession,
  opts: LocalMediaIngestOptions = {},
): Promise<LocalMediaIngest> {
  const sourceBytes = Number.isFinite(file.size) ? file.size : 0;
  const reasons: string[] = [];
  const note = (reason: string) => {
    if (!reasons.includes(reason)) reasons.push(reason);
  };
  const report = (stage: string, pct: number) => {
    try {
      opts.onProgress?.(stage, pct);
    } catch {
      // 进度回报不该弄坏管线。
    }
  };
  const aborted = () => opts.signal?.aborted === true;

  const probe = UNKNOWN_PROBE(sourceBytes);

  // 1) metadata（duration / 尺寸 / 音轨）。
  let metadata: LocalMediaMetadata | null = null;
  if (aborted()) {
    note("aborted: 已取消");
  } else {
    report("metadata", 0);
    try {
      metadata = await session.readMetadata();
      if (metadata.durationSec != null && Number.isFinite(metadata.durationSec) && metadata.durationSec > 0) {
        probe.durationSec = metadata.durationSec;
        probe.bitrate = Math.round((sourceBytes * 8) / metadata.durationSec);
      }
      probe.width = metadata.width ?? null;
      probe.height = metadata.height ?? null;
      probe.hasAudio = metadata.hasAudio ?? null;
      report("metadata", 1);
    } catch (e) {
      note(`metadata: ${errText(e)}`);
    }
  }

  // 2) 计划关键帧时间点（时长未知／超上限 → plan 本身回 ok:false）。
  let timesSec: number[] = [];
  if (probe.durationSec != null) {
    const plan = planKeyframeTimes(probe.durationSec);
    if (plan.ok) timesSec = plan.timesSec;
    else note(`plan: ${plan.reason}`);
  } else if (!aborted()) {
    note("plan: 时长未知，无法计算关键帧时间点");
  }

  // 3) 抽关键帧（复用既有 extractFramesAtTimes）。
  const keyframes: LocalMediaKeyframe[] = [];
  if (timesSec.length > 0) {
    if (aborted()) {
      note("aborted: 已取消");
    } else {
      report("frames", 0);
      try {
        const frames = await session.extractFrames(timesSec, (done, total) =>
          report("frames", total > 0 ? done / total : 0),
        );
        keyframes.push(...frames);
        report("frames", 1);
      } catch (e) {
        note(`frames: ${errText(e)}`);
      }
    }
  }

  // 4) 海报（首帧）。取不到就退回第一张关键帧。
  let poster = emptyPoster();
  if (aborted()) {
    note("aborted: 已取消");
  } else {
    report("poster", 0);
    try {
      poster = await session.capturePoster(POSTER_TIME_SECONDS);
      report("poster", 1);
    } catch (e) {
      note(`poster: ${errText(e)}`);
      const first = keyframes[0];
      if (first) poster = first.blob;
    }
  }

  const derivedBytes = computeDerivedBytes([
    ...keyframes.map((frame) => frame.blob.size),
    poster.size,
    estimateProbeJsonBytes(probe),
  ]);

  if (reasons.length === 0 && keyframes.length === 0) {
    note("no_keyframes: 本机未抽出任何关键帧");
  }
  if (reasons.length === 0 && derivedBytes > MAX_DERIVED_UPLOAD_BYTES) {
    note(
      `derived_too_large: 衍生档 ${derivedBytes} bytes 超过上行闸门 ${MAX_DERIVED_UPLOAD_BYTES} bytes`,
    );
  }

  const result: LocalMediaIngest = { probe, keyframes, poster, derivedBytes, sourceBytes };
  if (reasons.length > 0) result.degraded = reasons.join("；");
  report("done", 1);
  return result;
}

// ─────────────────────────── 浏览器 session（复用 video-frames 抽帧原语）

/**
 * 真实浏览器 I/O：一个 `<video>` ＋一个 Object URL 跑完整条流程（不重复解码整个档）。
 * Object URL 由本 session 建立与释放，与呼叫端自己的预览 URL 各自独立（互不 revoke）。
 */
function createBrowserMediaSession(file: File): LocalMediaSession {
  const objectUrl = URL.createObjectURL(file);
  const video = document.createElement("video");
  video.preload = "metadata";
  video.muted = true;
  (video as HTMLVideoElement & { playsInline?: boolean }).playsInline = true;
  video.src = objectUrl;

  let metadataReady = false;
  // 失败同样要记住：<video> 的 error 只发一次，失败后**绝不重挂监听**，
  // 后续任何呼叫直接回同一个失败（否则第二次等待会永久 pending、整条 ingest 卡死）。
  let metadataError: Error | null = null;

  const sample = (): VideoElementSample => ({
    video,
    sample: {
      kind: "video",
      url: objectUrl,
      name: file.name,
      mime: file.type || "video/mp4",
      size: file.size,
    },
  });

  const ensureMetadata = async (): Promise<void> => {
    if (metadataReady) return;
    // 已失败：直接回同一失败，不重挂监听（该 <video> 的 error 不会再发）。
    if (metadataError) throw metadataError;
    try {
      await waitForMetadata(video);
      metadataReady = true;
    } catch (e) {
      metadataError = e instanceof Error ? e : new Error(String(e));
      throw metadataError;
    }
  };

  return {
    async readMetadata() {
      await ensureMetadata();
      const duration = Number.isFinite(video.duration) ? video.duration : null;
      return {
        durationSec: duration,
        width: video.videoWidth > 0 ? video.videoWidth : null,
        height: video.videoHeight > 0 ? video.videoHeight : null,
        hasAudio: detectHasAudio(video),
      };
    },
    async extractFrames(timesSec, onProgress) {
      await ensureMetadata();
      const extracted = await extractFramesAtTimes(sample(), [...timesSec], onProgress);
      const edgePx = frameEdgePx(video.videoWidth, video.videoHeight);
      return extracted.map((frame) => ({ tSec: frame.timeSec, blob: frame.blob, edgePx }));
    },
    async capturePoster(tSec) {
      await ensureMetadata();
      const [frame] = await extractFramesAtTimes(sample(), [tSec]);
      if (!frame) throw new Error("海报取帧失败：没有可用画面。");
      return frame.blob;
    },
    dispose() {
      try {
        video.removeAttribute("src");
        video.load();
      } catch {
        // 卸载期的次要错误不影响结果。
      }
      URL.revokeObjectURL(objectUrl);
    },
  };
}

// ─────────────────────────── 对外主函式

/**
 * 本机前处理入口（W1）。**永不抛出**：连 session 都建不起来也回一份带 `degraded` 的结果。
 * 呼叫端判断 `isIngestUsable(result)` 为真才走「只上行衍生档」，否则退回今天的原档路径。
 */
export async function ingestMediaLocally(
  file: File,
  opts: LocalMediaIngestOptions = {},
): Promise<LocalMediaIngest> {
  const sourceBytes = Number.isFinite(file.size) ? file.size : 0;
  const timeoutMs = Number.isFinite(opts.timeoutMs) && (opts.timeoutMs as number) > 0
    ? (opts.timeoutMs as number)
    : INGEST_TIMEOUT_MS;
  // 逾时对外只是一个保险：以内部 controller 通知 run 停止后续阶段（合作式中断），
  // 同时用 race 硬性保证「回传」——任一步卡在 await 也绝不让呼叫端永久 pending。
  const controller = new AbortController();
  const externalSignal = opts.signal;
  const onExternalAbort = (): void => controller.abort();
  if (externalSignal) {
    if (externalSignal.aborted) controller.abort();
    else externalSignal.addEventListener("abort", onExternalAbort, { once: true });
  }
  let timer: ReturnType<typeof setTimeout> | undefined;
  let session: LocalMediaSession | null = null;
  try {
    session = createBrowserMediaSession(file);
    const runOpts: LocalMediaIngestOptions = { ...opts, signal: controller.signal };
    const timeout = new Promise<LocalMediaIngest>((resolve) => {
      timer = setTimeout(() => {
        controller.abort();
        resolve(degradedResult(sourceBytes, `timeout: ingest 超过 ${timeoutMs}ms 未完成`));
      }, timeoutMs);
    });
    return await Promise.race([runLocalMediaIngest(file, session, runOpts), timeout]);
  } catch (e) {
    return degradedResult(sourceBytes, `session: ${errText(e)}`);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
    externalSignal?.removeEventListener("abort", onExternalAbort);
    try {
      session?.dispose();
    } catch {
      // dispose 失败不改变已算出的结果。
    }
  }
}
