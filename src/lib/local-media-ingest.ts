// local-media-ingest.ts — 本機影片前處理（W1，2026-10-04）
//
// 目的：把「影片原檔上傳到雲端讓 agent 看」換成「在本機抽出衍生檔，只上行衍生檔」。
//   · 本機前處理：讀 metadata → 依時長決定關鍵幀數 → 用既有 video-frames 抽幀 → 抽一張海報。
//   · 上行物：關鍵幀 JPEG ＋ poster JPEG ＋ probe JSON（体积极小）。
//   · 原檔只有在 ingest 失敗／降級時才回到今天的 uploadVideoDirect 路徑（漸進增強）。
//
// 硬約束（讀任何修改前先讀）：
//   · 抽幀核心**不重寫**——一律經由 `video-frames.ts` 的 `extractFramesAtTimes` / `waitForMetadata`。
//   · `ingestMediaLocally()` **永不拋出**：任何一步失敗只記在 `degraded`，回一份盡量完整的結果，
//     讓呼叫端能安全退回今天的原檔路徑（不得中斷整條附件流程）。
//   · 本機沒有的東西（真正的 fps／容器內的 codec 名／精確音軌）**不冒充**：能拿就拿，
//     拿不到欄位一律 `null`（未知 ≠ 已知無）。probe 欄位語義照 `media-quality-gate.ts` 的
//     `MediaProbe`（`sizeBytes`／`durationSec`／`width`／`height` 同名同義；未知以 null 表達）。
//   · 純邏輯（計劃幀數／邊長／位元組加總）與瀏覽器 I/O 分層：前者可在 node:test 直測，
//     後者包成可注入的 `LocalMediaSession`，測試用假 session 覆蓋成功／降級路徑。

import {
  MAX_FRAME_EDGE_PX,
  extractFramesAtTimes,
  planFrameExtraction,
  waitForMetadata,
  type FrameExtractionPlan,
  type VideoElementSample,
} from "./video-frames";

// ─────────────────────────── 常量

/** 關鍵幀數下限（短片的均勻取樣仍要幾張）。 */
export const MIN_LOCAL_KEYFRAMES = 4;

/** 關鍵幀數上限（瀏覽器每個時間點一次 seek，100~300ms；12 幀 ≈ 數秒等待）。 */
export const MAX_LOCAL_KEYFRAMES = 12;

/** 每多少秒多分一幀（短片落在下限、長片往上加、到上限為止）。 */
export const LOCAL_KEYFRAME_SECONDS_PER_FRAME = 15;

/**
 * 衍生檔的送行體積軟上限。站內附件代理（Vercel）單請求體硬頂 4.5MB，
 * 留邊界後與 `AgentComposer` 的 `MAX_FILE_BYTES`（4MB）對齊：超過就標降級，
 * 退回原檔直傳，絕不讓衍生檔把代理撞 413。
 */
export const MAX_DERIVED_UPLOAD_BYTES = 4 * 1024 * 1024;

/** 海報取樣時間點（秒）。取首幀（關鍵幀用等分中點，不含 0，故不重複）。 */
export const POSTER_TIME_SECONDS = 0;

// ─────────────────────────── 型別

/**
 * 本機 probe。欄位名與語義對齊 `media-quality-gate.ts` 的 `MediaProbe`：
 * `sizeBytes`／`durationSec`／`width`／`height` 同名；拿不到的以 `null` 表示未知。
 */
export interface LocalMediaProbe {
  /** 影片時長（秒）；未知為 null。 */
  durationSec: number | null;
  /** 解碼後畫面寬（px）；未知為 null。 */
  width: number | null;
  /** 解碼後畫面高（px）；未知為 null。 */
  height: number | null;
  /** 幀率。瀏覽器沒有可靠的容器 metadata 讀法，目前一律 undefined（不冒充）。 */
  fps?: number;
  /** 容器內的視訊 codec 名。瀏覽器讀不到，目前一律 undefined（不冒充）。 */
  videoCodec?: string;
  /** 容器內音訊 codec 名。瀏覽器讀不到，目前一律 undefined（不冒充）。 */
  audioCodec?: string;
  /** 是否含音軌。能確定才給 boolean，確定不了給 null（未知 ≠ 已知無）。 */
  hasAudio: boolean | null;
  /** 整體位元率（bits/s）＝ sizeBytes*8/durationSec；時長未知則 undefined。 */
  bitrate?: number;
  /** 原檔位元組（= File.size）。 */
  sizeBytes: number;
}

/** 一張關鍵幀。 */
export interface LocalMediaKeyframe {
  /** 該幀在影片中的時刻（秒）。 */
  tSec: number;
  /** 抽出的 JPEG。 */
  blob: Blob;
  /** 抽出後長邊實際像素（≤ MAX_FRAME_EDGE_PX）。 */
  edgePx: number;
}

/** `ingestMediaLocally` 的產物。 */
export interface LocalMediaIngest {
  probe: LocalMediaProbe;
  keyframes: LocalMediaKeyframe[];
  /** 代表幀 JPEG（首幀）。取不到時為退化的空 Blob（size=0）。 */
  poster: Blob;
  /** 上行衍生檔位元組總和（關鍵幀＋poster＋probe JSON）。 */
  derivedBytes: number;
  /** 原檔位元組。 */
  sourceBytes: number;
  /** 任何一步失敗的原因；有值即代表呼叫端應退回今天的原檔路徑。 */
  degraded?: string;
}

export interface LocalMediaIngestOptions {
  signal?: AbortSignal;
  /** 進度回報：stage ∈ metadata|frames|poster|done，pct ∈ [0,1]。永不因回報失敗而中斷。 */
  onProgress?: (stage: string, pct: number) => void;
}

export interface LocalMediaMetadata {
  durationSec: number | null;
  width: number | null;
  height: number | null;
  hasAudio: boolean | null;
}

/**
 * 瀏覽器 I/O 的注入面（測試用假物件覆蓋成功／降級分支，node 下不會碰 DOM）。
 * 真實實作見 `createBrowserMediaSession`，底層逐字複用 `video-frames.ts` 的抽幀原語。
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

// ─────────────────────────── 純函式（node:test 可直測）

/**
 * 依時長決定關鍵幀數：每 `LOCAL_KEYFRAME_SECONDS_PER_FRAME` 秒一幀，
 * 夾在 [MIN_LOCAL_KEYFRAMES, MAX_LOCAL_KEYFRAMES]。非法／非正時長回下限
 * （短片與未知時長都不會算出 NaN／0 幀）。
 */
export function planKeyframeCount(durationSec: number): number {
  if (!Number.isFinite(durationSec) || durationSec <= 0) return MIN_LOCAL_KEYFRAMES;
  const byDuration = Math.ceil(durationSec / LOCAL_KEYFRAME_SECONDS_PER_FRAME);
  return Math.min(MAX_LOCAL_KEYFRAMES, Math.max(MIN_LOCAL_KEYFRAMES, byDuration));
}

/**
 * 依時長算出關鍵幀時間點。**複用** `planFrameExtraction`（sequence + count，等距中點），
 * 不另寫時間軸邏輯：時長未知／超上限／算出 0 幀等都由它回 `ok:false`。
 * 中點取樣天然落在 (0, duration) 且嚴格遞增，符合 `extractFramesAtTimes` 的契約。
 */
export function planKeyframeTimes(durationSec: number): FrameExtractionPlan {
  return planFrameExtraction({ durationSec, mode: "sequence", count: planKeyframeCount(durationSec) });
}

/**
 * 抽出後的長邊像素。與 `video-frames.captureFrame` 的縮放同式：
 * `scale = min(1, MAX_FRAME_EDGE_PX / max(w,h))`，長邊 = round(max*scale)。
 * 來源小於上限時維持原始長邊，不放大。
 */
export function frameEdgePx(rawWidth: number, rawHeight: number): number {
  const maxDim = Math.max(Number.isFinite(rawWidth) ? rawWidth : 0, Number.isFinite(rawHeight) ? rawHeight : 0);
  if (maxDim <= 0) return 0;
  const scale = Math.min(1, MAX_FRAME_EDGE_PX / maxDim);
  return Math.max(1, Math.round(maxDim * scale));
}

/** 只加總有效（有限、>0）的位元組；其餘視為 0（不讓 NaN／負值污染總量）。 */
export function computeDerivedBytes(sizes: readonly number[]): number {
  let total = 0;
  for (const size of sizes) {
    if (typeof size === "number" && Number.isFinite(size) && size > 0) total += size;
  }
  return total;
}

/** probe JSON 的 UTF-8 位元組數（與實際上行的檔案大小同源）。 */
export function estimateProbeJsonBytes(probe: LocalMediaProbe): number {
  try {
    return new TextEncoder().encode(JSON.stringify(probe)).length;
  } catch {
    return 0;
  }
}

/** ingest 結果能否直接當作「只上行衍生檔」用（未降級、且至少有一張關鍵幀）。 */
export function isIngestUsable(
  result: LocalMediaIngest | null | undefined,
): result is LocalMediaIngest & { keyframes: [LocalMediaKeyframe, ...LocalMediaKeyframe[]] } {
  return result != null && !result.degraded && result.keyframes.length > 0;
}

/**
 * 把 ingest 產物打包成可上行的 File[]：關鍵幀 JPEG ＋ poster JPEG（非空才收）＋ probe JSON。
 * 順序穩定（關鍵幀 → 海報 → probe），呼叫端可直接對應回 refs。
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
 * 從 `<video>` 判斷有無音軌。**只回能確定的答案**：
 *   · Firefox `mozHasAudio` 為權威（true/false 皆可信）。
 *   · 部分瀏覽器的 `audioTracks.length` 可信。
 *   · Chromium `webkitAudioDecodedByteCount` 要在解碼後才非 0；我們不播放，
 *     量到 0 **不代表無音軌**，故只把 >0 當 true，0 一律回 null（不冒充）。
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

// ─────────────────────────── 執行層（可注入 session，永不拋出）

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

/** 一份全降級結果（session 都建不起來時用）。永不拋出。 */
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
 * 跑完整條本機前處理。**任何一步失敗只記 `degraded`，絕不拋出**；
 * 後續能做的步驟繼續做（例如抽幀失敗仍試著拿海報），回一份盡量完整的結果。
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
      // 進度回報不該弄壞管線。
    }
  };
  const aborted = () => opts.signal?.aborted === true;

  const probe = UNKNOWN_PROBE(sourceBytes);

  // 1) metadata（duration / 尺寸 / 音軌）。
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

  // 2) 計劃關鍵幀時間點（時長未知／超上限 → plan 本身回 ok:false）。
  let timesSec: number[] = [];
  if (probe.durationSec != null) {
    const plan = planKeyframeTimes(probe.durationSec);
    if (plan.ok) timesSec = plan.timesSec;
    else note(`plan: ${plan.reason}`);
  } else if (!aborted()) {
    note("plan: 時長未知，無法計算關鍵幀時間點");
  }

  // 3) 抽關鍵幀（複用既有 extractFramesAtTimes）。
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

  // 4) 海報（首幀）。取不到就退回第一張關鍵幀。
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
    note("no_keyframes: 本機未抽出任何關鍵幀");
  }
  if (reasons.length === 0 && derivedBytes > MAX_DERIVED_UPLOAD_BYTES) {
    note(
      `derived_too_large: 衍生檔 ${derivedBytes} bytes 超過上行閘門 ${MAX_DERIVED_UPLOAD_BYTES} bytes`,
    );
  }

  const result: LocalMediaIngest = { probe, keyframes, poster, derivedBytes, sourceBytes };
  if (reasons.length > 0) result.degraded = reasons.join("；");
  report("done", 1);
  return result;
}

// ─────────────────────────── 瀏覽器 session（複用 video-frames 抽幀原語）

/**
 * 真實瀏覽器 I/O：一個 `<video>` ＋一個 Object URL 跑完整條流程（不重複解碼整個檔）。
 * Object URL 由本 session 建立與釋放，與呼叫端自己的預覽 URL 各自獨立（互不 revoke）。
 */
function createBrowserMediaSession(file: File): LocalMediaSession {
  const objectUrl = URL.createObjectURL(file);
  const video = document.createElement("video");
  video.preload = "metadata";
  video.muted = true;
  (video as HTMLVideoElement & { playsInline?: boolean }).playsInline = true;
  video.src = objectUrl;

  let metadataReady = false;

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
    await waitForMetadata(video);
    metadataReady = true;
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
      if (!frame) throw new Error("海報取幀失敗：沒有可用畫面。");
      return frame.blob;
    },
    dispose() {
      try {
        video.removeAttribute("src");
        video.load();
      } catch {
        // 卸載期的次要錯誤不影響結果。
      }
      URL.revokeObjectURL(objectUrl);
    },
  };
}

// ─────────────────────────── 對外主函式

/**
 * 本機前處理入口（W1）。**永不拋出**：連 session 都建不起來也回一份帶 `degraded` 的結果。
 * 呼叫端判斷 `isIngestUsable(result)` 為真才走「只上行衍生檔」，否則退回今天的原檔路徑。
 */
export async function ingestMediaLocally(
  file: File,
  opts: LocalMediaIngestOptions = {},
): Promise<LocalMediaIngest> {
  const sourceBytes = Number.isFinite(file.size) ? file.size : 0;
  let session: LocalMediaSession | null = null;
  try {
    session = createBrowserMediaSession(file);
    return await runLocalMediaIngest(file, session, opts);
  } catch (e) {
    return degradedResult(sourceBytes, `session: ${errText(e)}`);
  } finally {
    try {
      session?.dispose();
    } catch {
      // dispose 失敗不改變已算出的結果。
    }
  }
}
