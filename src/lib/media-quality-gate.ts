// media-quality-gate.ts — 事後產物硬檢閘門（2026-10-03）
//
// 定位：對**已經生成完成**的檔案（影片／圖／音訊）做**確定性、非模型意見**的品質量測。
//   · 本檔**不呼叫任何模型、不呼叫任何付費上游**；只用本機 `ffprobe`／`ffmpeg`。
//   · 上游對照：`generation-gates.ts` 只做事前 prompt/契約層；`vision-tools.ts` 的審美閘
//     是模型自評。本檔補的是「零爭議、可審計、抗辯成本為零」的那一格（parity-gap 第 1 格）。
//
// 核心紅線（讀任何修改前先讀這行）：
//   **未知 ≠ 通過。** probe 不可用／逾時／解析不出，一律回 `ok:false` 並帶
//   `probe_unavailable`／`unparsable`。把「量不到」當成 pass，等於這道閘門在說謊。
//
// 分層：
//   · 純函式層 `evaluateMediaQuality(probe, policy)` — 無 I/O，可單元測試。
//   · I/O 層 `probeMedia(target)` — spawn ffprobe／ffmpeg；支援本地路徑與 http(s) URL。
//
// 輪子來源：`src/lib/music-tools.ts:185-230` 的 ffprobe 時長實測封裝（spawn / 1 秒級
// timeout / SIGKILL / ENOENT「系統未安裝」判定 / 退出碼處理 / 失敗不冒充）。本檔
// `runBinary` 逐行照它的骨架擴充（補 stdout+stderr 收集、逾時與退出碼分類），不重寫。
// （全 repo 最完整的另一支是 `src/vendor-bridges/gateway/lint.ts:187 probeMedia` 與
//  `.../editor/composeEngine.ts:352 probeRenderedVideo`，但兩者都在 Tauri/gateway vendor
//  環境（`invoke('execute_command')` / `$WORKSPACE_DIR`），不是 Next 服務端可直用；見回報。）

import { spawn } from "node:child_process";
import { rm, stat, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

// ── 型別 ─────────────────────────────────────────────────────────────────────

export type ProbeStatus = "ok" | "probe_unavailable" | "unparsable";

export interface MediaVideoStream {
  codec: string;
  width: number | null;
  height: number | null;
}

export interface MediaAudioStream {
  codec: string;
  /** volumedetect 實測平均音量 dB；純數位靜音為 -Infinity；量不到為 null。 */
  meanVolumeDb: number | null;
  maxVolumeDb: number | null;
}

/** probeMedia 的產物：`status!=="ok"` 時其餘欄位無意義。 */
export interface MediaProbe {
  status: ProbeStatus;
  /** status!=="ok" 時的分類原因（ENOENT／逾時／退出碼／parse 失敗）。 */
  error: string | null;
  container: string | null;
  durationSec: number | null;
  sizeBytes: number | null;
  video: MediaVideoStream | null;
  audio: MediaAudioStream | null;
}

export interface QualityPolicy {
  id: string;
  /** 是否需要一個可解碼的視覺流（影片與圖片皆真）。 */
  requireVideoStream: boolean;
  /** 容器名是否必須解析得出。 */
  requireContainer: boolean;
  minWidth: number;
  minHeight: number;
  minDurationSec: number | null;
  maxDurationSec: number | null;
  /** 是否必須存在音軌（影片政策可要求）。 */
  requireAudioStream: boolean;
  /** 是否檢非靜音（音訊政策用）。 */
  requireNonSilent: boolean;
  /** 平均音量門檻（dB）；`mean <= 此值` 視為靜音。 */
  minMeanVolumeDb: number;
  minBytes: number;
}

export interface QualityFailure {
  code: string;
  detail: string;
}

export interface QualityVerdict {
  ok: boolean;
  measured: Record<string, number | string | null>;
  failures: QualityFailure[];
  policyId: string;
}

// ── 政策表（門檻集中一處可調） ────────────────────────────────────────────────

export const QUALITY_POLICIES: Readonly<Record<string, QualityPolicy>> = {
  /** 一般影片：視覺流 + 尺寸 + 時長 + 非空檔；音軌可選（生成影片常無聲）。 */
  video_default: {
    id: "video_default",
    requireVideoStream: true,
    requireContainer: true,
    minWidth: 320,
    minHeight: 240,
    minDurationSec: 0.2,
    maxDurationSec: 600,
    requireAudioStream: false,
    requireNonSilent: false,
    minMeanVolumeDb: -60,
    minBytes: 1024,
  },
  /** 與 video_default 同閾值，但**必須有音軌**（成片/配音交付用）。 */
  video_with_audio: {
    id: "video_with_audio",
    requireVideoStream: true,
    requireContainer: true,
    minWidth: 320,
    minHeight: 240,
    minDurationSec: 0.2,
    maxDurationSec: 600,
    requireAudioStream: true,
    requireNonSilent: false,
    minMeanVolumeDb: -60,
    minBytes: 1024,
  },
  /** 圖片：只有視覺流 + 尺寸 + 非空檔；無時長/音軌概念。 */
  image_default: {
    id: "image_default",
    requireVideoStream: true,
    requireContainer: false,
    minWidth: 256,
    minHeight: 256,
    minDurationSec: null,
    maxDurationSec: null,
    requireAudioStream: false,
    requireNonSilent: false,
    minMeanVolumeDb: -60,
    minBytes: 64,
  },
  /** 純音訊：必須有音軌、必須非靜音、有最短時長。 */
  audio_default: {
    id: "audio_default",
    requireVideoStream: false,
    requireContainer: false,
    minWidth: 0,
    minHeight: 0,
    minDurationSec: 0.1,
    maxDurationSec: 1800,
    requireAudioStream: true,
    requireNonSilent: true,
    minMeanVolumeDb: -60,
    minBytes: 256,
  },
};

// ── 純函式層（無 I/O） ───────────────────────────────────────────────────────

function measuredFrom(probe: MediaProbe): Record<string, number | string | null> {
  return {
    status: probe.status,
    container: probe.container,
    codec: probe.video?.codec ?? null,
    width: probe.video?.width ?? null,
    height: probe.video?.height ?? null,
    duration_sec: probe.durationSec,
    byte_size: probe.sizeBytes,
    has_audio: probe.audio !== null ? 1 : 0,
    audio_codec: probe.audio?.codec ?? null,
    mean_volume_db: probe.audio?.meanVolumeDb ?? null,
    max_volume_db: probe.audio?.maxVolumeDb ?? null,
  };
}

/**
 * 對一次實測結果套政策。**確定性**：同輸入必同輸出，無時間/隨機/模型依賴。
 * 未知量永不當 pass：probe 失敗、或政策要求但量不到的欄位，一律進 `failures`。
 */
export function evaluateMediaQuality(probe: MediaProbe, policy: QualityPolicy): QualityVerdict {
  const measured = measuredFrom(probe);
  const failures: QualityFailure[] = [];

  const verdict = (): QualityVerdict => ({ ok: failures.length === 0, measured, failures, policyId: policy.id });

  // 0. probe 自身是否可用 —— 紅線：量不到不是通過。
  if (probe.status === "probe_unavailable") {
    failures.push({ code: "probe_unavailable", detail: probe.error ?? "媒體探測不可用（ffprobe 未安裝／逾時／無法讀取）" });
    return verdict();
  }
  if (probe.status === "unparsable") {
    failures.push({ code: "unparsable", detail: probe.error ?? "媒體探測輸出無法解析" });
    return verdict();
  }

  // 1. 檔案位元組 > 0。
  if (probe.sizeBytes === null) {
    failures.push({ code: "empty_file", detail: "檔案大小量不到" });
  } else if (probe.sizeBytes < policy.minBytes) {
    failures.push({ code: "empty_file", detail: `檔案 ${probe.sizeBytes} bytes < 下限 ${policy.minBytes}` });
  }

  // 2. 容器。
  if (policy.requireContainer && !probe.container) {
    failures.push({ code: "container_missing", detail: "容器名解析不出" });
  }

  // 3. 視覺流存在 + 寬高。
  if (policy.requireVideoStream && !probe.video) {
    failures.push({ code: "video_stream_missing", detail: "無可解碼的視覺流" });
  }
  if (probe.video) {
    const { width, height } = probe.video;
    if (policy.minWidth > 0 || policy.minHeight > 0) {
      if (width === null || height === null) {
        failures.push({ code: "dimensions_unparsable", detail: "視覺流寬高解析不出" });
      } else {
        if (width < policy.minWidth) failures.push({ code: "width_below_min", detail: `寬 ${width} < 下限 ${policy.minWidth}` });
        if (height < policy.minHeight) failures.push({ code: "height_below_min", detail: `高 ${height} < 下限 ${policy.minHeight}` });
      }
    }
  }

  // 4. 時長落在 [min, max]（政策有界時；量不到 = fail，不是 skip）。
  if (policy.minDurationSec !== null || policy.maxDurationSec !== null) {
    if (probe.durationSec === null) {
      failures.push({ code: "duration_unparsable", detail: "時長解析不出" });
    } else {
      if (policy.minDurationSec !== null && probe.durationSec < policy.minDurationSec) {
        failures.push({ code: "duration_below_min", detail: `時長 ${probe.durationSec}s < 下限 ${policy.minDurationSec}s` });
      }
      if (policy.maxDurationSec !== null && probe.durationSec > policy.maxDurationSec) {
        failures.push({ code: "duration_above_max", detail: `時長 ${probe.durationSec}s > 上限 ${policy.maxDurationSec}s` });
      }
    }
  }

  // 5. 音軌存在。
  if (policy.requireAudioStream && !probe.audio) {
    failures.push({ code: "audio_stream_missing", detail: "政策要求音軌但檔案無音軌" });
  }

  // 6. 非靜音（音訊政策）。
  if (policy.requireNonSilent && probe.audio) {
    const mv = probe.audio.meanVolumeDb;
    if (mv === null) {
      failures.push({ code: "volume_unparsable", detail: "平均音量量不到" });
    } else if (mv <= policy.minMeanVolumeDb) {
      failures.push({ code: "silent_audio", detail: `平均音量 ${mv} dB <= 門檻 ${policy.minMeanVolumeDb} dB` });
    }
  }

  return verdict();
}

// ── I/O 層 ───────────────────────────────────────────────────────────────────

type RunResult = { ok: true; stdout: string; stderr: string } | { ok: false; error: string; timedOut: boolean };

/**
 * spawn 一支外部程式並收斂結果；骨架逐行照 `music-tools.ts:191-215`：
 * stdio ignore/pipe/ignore（此處 stderr 也要，故 pipe）、stdout 累積、定時 SIGKILL、
 * ENOENT → 「不存在（系統未安裝）」、非零退出碼 → 帶 stderr 片段。
 */
function runBinary(bin: string, args: string[], timeoutMs: number): Promise<RunResult> {
  return new Promise((resolve) => {
    let child: ReturnType<typeof spawn>;
    try {
      child = spawn(bin, args, { stdio: ["ignore", "pipe", "pipe"] });
    } catch (e) {
      resolve({ ok: false, error: e instanceof Error ? e.message : String(e), timedOut: false });
      return;
    }
    let stdout = "";
    let stderr = "";
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      child.kill("SIGKILL");
    }, timeoutMs);
    child.stdout?.on("data", (d: Buffer) => {
      stdout += d.toString();
    });
    child.stderr?.on("data", (d: Buffer) => {
      stderr += d.toString();
    });
    child.on("error", (e: NodeJS.ErrnoException) => {
      clearTimeout(timer);
      resolve({ ok: false, error: e.code === "ENOENT" ? `${bin} 不存在（系統未安裝）` : e.message, timedOut: false });
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      if (timedOut) {
        resolve({ ok: false, error: `${bin} 超時（${timeoutMs} ms）`, timedOut: true });
        return;
      }
      if (code === 0) resolve({ ok: true, stdout, stderr });
      else resolve({ ok: false, error: `${bin} 退出碼 ${code ?? "null"}，stderr：${stderr.trim().slice(0, 200)}`, timedOut: false });
    });
  });
}

function unavailable(error: string): MediaProbe {
  return { status: "probe_unavailable", error, container: null, durationSec: null, sizeBytes: null, video: null, audio: null };
}

function unparsable(error: string): MediaProbe {
  return { status: "unparsable", error, container: null, durationSec: null, sizeBytes: null, video: null, audio: null };
}

function parseDb(raw: string | undefined): number | null {
  if (!raw) return null;
  const t = raw.trim().toLowerCase();
  if (t === "-inf") return Number.NEGATIVE_INFINITY;
  if (t === "inf") return Number.POSITIVE_INFINITY;
  const n = Number(t);
  return Number.isFinite(n) ? n : null;
}

/** volumedetect：ffmpeg 把 `mean_volume:` / `max_volume:` 寫在 stderr。 */
async function measureVolume(localPath: string, timeoutMs: number): Promise<{ mean: number | null; max: number | null }> {
  const r = await runBinary(
    "ffmpeg",
    ["-hide_banner", "-nostats", "-i", localPath, "-vn", "-af", "volumedetect", "-f", "null", "-"],
    timeoutMs,
  );
  if (!r.ok) return { mean: null, max: null };
  const text = `${r.stdout}\n${r.stderr}`;
  const mean = /mean_volume:\s*(-?[\d.]+|-inf|inf)\s*dB/i.exec(text);
  const max = /max_volume:\s*(-?[\d.]+|-inf|inf)\s*dB/i.exec(text);
  return { mean: parseDb(mean?.[1]), max: parseDb(max?.[1]) };
}

/** 素材解析：本地路徑直用；http(s) URL 下載到 os.tmpdir()（fetch + AbortSignal.timeout）。 */
async function resolveLocal(target: string, timeoutMs: number): Promise<{ path: string; tmp: string | null }> {
  if (!/^https?:\/\//i.test(target)) {
    return { path: target, tmp: null };
  }
  const res = await fetch(target, { signal: AbortSignal.timeout(timeoutMs) });
  if (!res.ok) throw new Error(`素材下載失敗 HTTP ${res.status}`);
  const buf = Buffer.from(await res.arrayBuffer());
  if (buf.byteLength > 200 * 1024 * 1024) throw new Error("素材下載超過 200MB 上限");
  const ext = (path.extname(new URL(target).pathname) || ".bin").slice(0, 8).replace(/[^.a-zA-Z0-9]/g, "") || ".bin";
  const local = path.join(os.tmpdir(), `mq-probe-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}${ext}`);
  await writeFile(local, buf);
  return { path: local, tmp: local };
}

/**
 * 實測一個媒體檔案（本地路徑或 http(s) URL）。任何失敗回帶分類的 `MediaProbe`
 * （status!=="ok"），**不 throw、不冒充**。`timeoutMs` 套用於每個子程序與 URL 下載。
 */
export async function probeMedia(target: string, timeoutMs = 15_000): Promise<MediaProbe> {
  let local: { path: string; tmp: string | null };
  try {
    local = await resolveLocal(target, timeoutMs);
  } catch (e) {
    return unavailable(e instanceof Error ? e.message : String(e));
  }

  try {
    // ffprobe：容器 + 全部流的 codec_type/codec_name/width/height。
    const probe = await runBinary(
      "ffprobe",
      ["-v", "error", "-show_entries", "format=format_name,duration,size:stream=codec_type,codec_name,width,height", "-of", "json", local.path],
      timeoutMs,
    );
    if (!probe.ok) return unavailable(probe.error);

    let json: {
      format?: { format_name?: string; duration?: string; size?: string };
      streams?: Array<{ codec_type?: string; codec_name?: string; width?: number; height?: number }>;
    };
    try {
      json = JSON.parse(probe.stdout) as typeof json;
    } catch {
      return unparsable(`ffprobe 輸出不是有效 JSON：${probe.stdout.trim().slice(0, 200)}`);
    }

    const streams = Array.isArray(json.streams) ? json.streams : [];
    if (!json.format && streams.length === 0) {
      return unparsable("ffprobe 輸出無 format 也無 streams");
    }

    const v = streams.find((s) => s?.codec_type === "video");
    const a = streams.find((s) => s?.codec_type === "audio");

    const durationRaw = json.format?.duration;
    const durationNum = durationRaw != null ? Number(durationRaw) : NaN;
    let sizeNum = json.format?.size != null ? Number(json.format.size) : NaN;
    if (!Number.isFinite(sizeNum)) {
      // format.size 缺席時回退檔案實際位元組（本地檔案，確定性）。
      sizeNum = await stat(local.path).then((s) => s.size).catch(() => NaN);
    }

    const video: MediaVideoStream | null = v
      ? {
          codec: typeof v.codec_name === "string" ? v.codec_name : "unknown",
          width: typeof v.width === "number" && Number.isFinite(v.width) ? v.width : null,
          height: typeof v.height === "number" && Number.isFinite(v.height) ? v.height : null,
        }
      : null;

    let audio: MediaAudioStream | null = null;
    if (a) {
      const vol = await measureVolume(local.path, timeoutMs);
      audio = { codec: typeof a.codec_name === "string" ? a.codec_name : "unknown", meanVolumeDb: vol.mean, maxVolumeDb: vol.max };
    }

    return {
      status: "ok",
      error: null,
      container: typeof json.format?.format_name === "string" ? json.format.format_name : null,
      durationSec: Number.isFinite(durationNum) && durationNum > 0 ? durationNum : null,
      sizeBytes: Number.isFinite(sizeNum) ? sizeNum : null,
      video,
      audio,
    };
  } catch (e) {
    return unparsable(e instanceof Error ? e.message : String(e));
  } finally {
    if (local.tmp) await rm(local.tmp, { force: true }).catch(() => {});
  }
}
