// media-quality-gate.ts — 事后产物硬检闸门（2026-10-03）
//
// 定位：对**已经生成完成**的档案（影片／图／音讯）做**确定性、非模型意见**的品质量测。
//   · 本档**不呼叫任何模型、不呼叫任何付费上游**；只用本机 `ffprobe`／`ffmpeg`。
//   · 上游对照：`generation-gates.ts` 只做事前 prompt/契约层；`vision-tools.ts` 的审美闸
//     是模型自评。本档补的是「零争议、可审计、抗辩成本为零」的那一格（parity-gap 第 1 格）。
//
// 核心红线（读任何修改前先读这行）：
//   **未知 ≠ 通过。** probe 不可用／逾时／解析不出，一律回 `ok:false` 并带
//   `probe_unavailable`／`unparsable`。把「量不到」当成 pass，等于这道闸门在说谎。
//
// 分层：
//   · 纯函式层 `evaluateMediaQuality(probe, policy)` — 无 I/O，可单元测试。
//   · I/O 层 `probeMedia(target)` — spawn ffprobe／ffmpeg；支援本地路径与 http(s) URL。
//
// 轮子来源：`src/lib/music-tools.ts:185-230` 的 ffprobe 时长实测封装（spawn / 1 秒级
// timeout / SIGKILL / ENOENT「系统未安装」判定 / 退出码处理 / 失败不冒充）。本档
// `runBinary` 逐行照它的骨架扩充（补 stdout+stderr 收集、逾时与退出码分类），不重写。
// （全 repo 最完整的另一支是 `src/vendor-bridges/gateway/lint.ts:187 probeMedia` 与
//  `.../editor/composeEngine.ts:352 probeRenderedVideo`，但两者都在 Tauri/gateway vendor
//  环境（`invoke('execute_command')` / `$WORKSPACE_DIR`），不是 Next 服务端可直用；见回报。）

import { spawn } from "node:child_process";
import { rm, stat, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

// ── 型别 ─────────────────────────────────────────────────────────────────────

export type ProbeStatus = "ok" | "probe_unavailable" | "unparsable";

export interface MediaVideoStream {
  codec: string;
  width: number | null;
  height: number | null;
}

export interface MediaAudioStream {
  codec: string;
  /** volumedetect 实测平均音量 dB；纯数位静音为 -Infinity；量不到为 null。 */
  meanVolumeDb: number | null;
  maxVolumeDb: number | null;
}

/** probeMedia 的产物：`status!=="ok"` 时其余栏位无意义。 */
export interface MediaProbe {
  status: ProbeStatus;
  /** status!=="ok" 时的分类原因（ENOENT／逾时／退出码／parse 失败）。 */
  error: string | null;
  container: string | null;
  durationSec: number | null;
  sizeBytes: number | null;
  video: MediaVideoStream | null;
  audio: MediaAudioStream | null;
}

export interface QualityPolicy {
  id: string;
  /** 是否需要一个可解码的视觉流（影片与图片皆真）。 */
  requireVideoStream: boolean;
  /** 容器名是否必须解析得出。 */
  requireContainer: boolean;
  minWidth: number;
  minHeight: number;
  minDurationSec: number | null;
  maxDurationSec: number | null;
  /** 是否必须存在音轨（影片政策可要求）。 */
  requireAudioStream: boolean;
  /** 是否检非静音（音讯政策用）。 */
  requireNonSilent: boolean;
  /** 平均音量门槛（dB）；`mean <= 此值` 视为静音。 */
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

// ── 政策表（门槛集中一处可调） ────────────────────────────────────────────────

export const QUALITY_POLICIES: Readonly<Record<string, QualityPolicy>> = {
  /** 一般影片：视觉流 + 尺寸 + 时长 + 非空档；音轨可选（生成影片常无声）。 */
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
  /** 与 video_default 同阈值，但**必须有音轨**（成片/配音交付用）。 */
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
  /** 图片：只有视觉流 + 尺寸 + 非空档；无时长/音轨概念。 */
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
  /** 纯音讯：必须有音轨、必须非静音、有最短时长。 */
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

// ── 纯函式层（无 I/O） ───────────────────────────────────────────────────────

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
 * 对一次实测结果套政策。**确定性**：同输入必同输出，无时间/随机/模型依赖。
 * 未知量永不当 pass：probe 失败、或政策要求但量不到的栏位，一律进 `failures`。
 */
export function evaluateMediaQuality(probe: MediaProbe, policy: QualityPolicy): QualityVerdict {
  const measured = measuredFrom(probe);
  const failures: QualityFailure[] = [];

  const verdict = (): QualityVerdict => ({ ok: failures.length === 0, measured, failures, policyId: policy.id });

  // 0. probe 自身是否可用 —— 红线：量不到不是通过。
  if (probe.status === "probe_unavailable") {
    failures.push({ code: "probe_unavailable", detail: probe.error ?? "媒体探测不可用（ffprobe 未安装／逾时／无法读取）" });
    return verdict();
  }
  if (probe.status === "unparsable") {
    failures.push({ code: "unparsable", detail: probe.error ?? "媒体探测输出无法解析" });
    return verdict();
  }

  // 1. 档案位元组 > 0。
  if (probe.sizeBytes === null) {
    failures.push({ code: "empty_file", detail: "档案大小量不到" });
  } else if (probe.sizeBytes < policy.minBytes) {
    failures.push({ code: "empty_file", detail: `档案 ${probe.sizeBytes} bytes < 下限 ${policy.minBytes}` });
  }

  // 2. 容器。
  if (policy.requireContainer && !probe.container) {
    failures.push({ code: "container_missing", detail: "容器名解析不出" });
  }

  // 3. 视觉流存在 + 宽高。
  if (policy.requireVideoStream && !probe.video) {
    failures.push({ code: "video_stream_missing", detail: "无可解码的视觉流" });
  }
  if (probe.video) {
    const { width, height } = probe.video;
    if (policy.minWidth > 0 || policy.minHeight > 0) {
      if (width === null || height === null) {
        failures.push({ code: "dimensions_unparsable", detail: "视觉流宽高解析不出" });
      } else {
        if (width < policy.minWidth) failures.push({ code: "width_below_min", detail: `宽 ${width} < 下限 ${policy.minWidth}` });
        if (height < policy.minHeight) failures.push({ code: "height_below_min", detail: `高 ${height} < 下限 ${policy.minHeight}` });
      }
    }
  }

  // 4. 时长落在 [min, max]（政策有界时；量不到 = fail，不是 skip）。
  if (policy.minDurationSec !== null || policy.maxDurationSec !== null) {
    if (probe.durationSec === null) {
      failures.push({ code: "duration_unparsable", detail: "时长解析不出" });
    } else {
      if (policy.minDurationSec !== null && probe.durationSec < policy.minDurationSec) {
        failures.push({ code: "duration_below_min", detail: `时长 ${probe.durationSec}s < 下限 ${policy.minDurationSec}s` });
      }
      if (policy.maxDurationSec !== null && probe.durationSec > policy.maxDurationSec) {
        failures.push({ code: "duration_above_max", detail: `时长 ${probe.durationSec}s > 上限 ${policy.maxDurationSec}s` });
      }
    }
  }

  // 5. 音轨存在。
  if (policy.requireAudioStream && !probe.audio) {
    failures.push({ code: "audio_stream_missing", detail: "政策要求音轨但档案无音轨" });
  }

  // 6. 非静音（音讯政策）。
  if (policy.requireNonSilent && probe.audio) {
    const mv = probe.audio.meanVolumeDb;
    if (mv === null) {
      failures.push({ code: "volume_unparsable", detail: "平均音量量不到" });
    } else if (mv <= policy.minMeanVolumeDb) {
      failures.push({ code: "silent_audio", detail: `平均音量 ${mv} dB <= 门槛 ${policy.minMeanVolumeDb} dB` });
    }
  }

  return verdict();
}

// ── I/O 层 ───────────────────────────────────────────────────────────────────

type RunResult = { ok: true; stdout: string; stderr: string } | { ok: false; error: string; timedOut: boolean };

/**
 * spawn 一支外部程式并收敛结果；骨架逐行照 `music-tools.ts:191-215`：
 * stdio ignore/pipe/ignore（此处 stderr 也要，故 pipe）、stdout 累积、定时 SIGKILL、
 * ENOENT → 「不存在（系统未安装）」、非零退出码 → 带 stderr 片段。
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
      resolve({ ok: false, error: e.code === "ENOENT" ? `${bin} 不存在（系统未安装）` : e.message, timedOut: false });
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      if (timedOut) {
        resolve({ ok: false, error: `${bin} 超时（${timeoutMs} ms）`, timedOut: true });
        return;
      }
      if (code === 0) resolve({ ok: true, stdout, stderr });
      else resolve({ ok: false, error: `${bin} 退出码 ${code ?? "null"}，stderr：${stderr.trim().slice(0, 200)}`, timedOut: false });
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

/** volumedetect：ffmpeg 把 `mean_volume:` / `max_volume:` 写在 stderr。 */
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

/** 素材解析：本地路径直用；http(s) URL 下载到 os.tmpdir()（fetch + AbortSignal.timeout）。 */
async function resolveLocal(target: string, timeoutMs: number): Promise<{ path: string; tmp: string | null }> {
  if (!/^https?:\/\//i.test(target)) {
    return { path: target, tmp: null };
  }
  const res = await fetch(target, { signal: AbortSignal.timeout(timeoutMs) });
  if (!res.ok) throw new Error(`素材下载失败 HTTP ${res.status}`);
  const buf = Buffer.from(await res.arrayBuffer());
  if (buf.byteLength > 200 * 1024 * 1024) throw new Error("素材下载超过 200MB 上限");
  const ext = (path.extname(new URL(target).pathname) || ".bin").slice(0, 8).replace(/[^.a-zA-Z0-9]/g, "") || ".bin";
  const local = path.join(os.tmpdir(), `mq-probe-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}${ext}`);
  await writeFile(local, buf);
  return { path: local, tmp: local };
}

/**
 * 实测一个媒体档案（本地路径或 http(s) URL）。任何失败回带分类的 `MediaProbe`
 * （status!=="ok"），**不 throw、不冒充**。`timeoutMs` 套用于每个子程序与 URL 下载。
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
      return unparsable(`ffprobe 输出不是有效 JSON：${probe.stdout.trim().slice(0, 200)}`);
    }

    const streams = Array.isArray(json.streams) ? json.streams : [];
    if (!json.format && streams.length === 0) {
      return unparsable("ffprobe 输出无 format 也无 streams");
    }

    const v = streams.find((s) => s?.codec_type === "video");
    const a = streams.find((s) => s?.codec_type === "audio");

    const durationRaw = json.format?.duration;
    const durationNum = durationRaw != null ? Number(durationRaw) : NaN;
    let sizeNum = json.format?.size != null ? Number(json.format.size) : NaN;
    if (!Number.isFinite(sizeNum)) {
      // format.size 缺席时回退档案实际位元组（本地档案，确定性）。
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
