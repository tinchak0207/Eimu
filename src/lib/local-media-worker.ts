// local-media-worker.ts — 前端↔桌面壳本机媒体工人薄 adapter（W4，2026-10-04）
//
// 目的：让「浏览器／桌面壳直接发起」的媒体量测／抽帧／转码，在桌面壳内优先走本机 ffmpeg
// （`window.eimuLocal`，契约见 desktop/LOCAL-CAPABILITIES.md），减少 VPS ffmpeg 负载。
//
// 边界（读任何修改前先读）：
//   · 本档只做「侦测 → 呼叫 → 收敛成 { ok }」三件事，**不做 fallback 决策**——
//     回落由呼叫端决定（保持 adapter 单纯，呼叫端知道自己的降级路径）。
//   · **一律不 throw**：任何失败（无 worker／ffmpeg 不可用／worker reject／capabilities 失败／
//     参数错）都回 `{ ok:false, reason }`，绝不中断呼叫端的既有云端路径。
//   · 没有 `window.eimuLocal`（＝纯浏览器环境）时，本档所有函式回 `ok:false`；
//     这正是「不具备本机能力时完全回落今天的云端路径」的判准。
//
// 为什么 `hasLocalMediaWorker()` 是 async：`capabilities()` 是 IPC 呼叫，第一次探测 ffmpeg
// 要等本机子程序跑完；把能力探测的 promise 依 api 物件身分快取起来，后续呼叫即时命中
// （同时自然处理「尚未探测完成」——呼叫端 await 的就是同一条 promise）。

// ─────────────────────────── 失败原因码（呼叫端可据此分流，但不强制）

/** 没有 `window.eimuLocal`：非桌面壳／浏览器环境。 */
export const LOCAL_WORKER_ABSENT = "no_local_worker";
/** worker 存在，但本机没有可用的 ffmpeg。 */
export const LOCAL_FFMPEG_UNAVAILABLE = "ffmpeg_unavailable";
/** 能力探测本身失败（IPC 错误等）；附 worker 回的错误讯息。 */
export const LOCAL_CAPABILITIES_FAILED = "capabilities_failed";

// ─────────────────────────── 型别（镜射桌面壳契约，不 import desktop/——那是另一包的产物）

export interface EimuLocalProbeStream {
  index: number;
  codecType: string;
  codecName: string | null;
  width: number | null;
  height: number | null;
  channels: number | null;
  sampleRate: number | null;
}

export interface EimuLocalProbeResult {
  path: string;
  format: string | null;
  durationSec: number | null;
  sizeBytes: number | null;
  streams: EimuLocalProbeStream[];
}

export interface EimuLocalFrame {
  tSec: number;
  /** 抽出影格在本机临时目录的绝对路径（契约栏位是 `path`，不是 base64）。 */
  path: string;
}

export interface EimuLocalFramePlan {
  count?: number;
  timesSec?: number[];
  maxWidth?: number;
}

export interface EimuLocalTranscodeOpts {
  format?: "mp4" | "webm" | "mkv" | "mov";
  videoCodec?: "libx264" | "libx265" | "libvpx-vp9" | "h264_nvenc" | "hevc_nvenc";
  preset?: string;
  crf?: number;
  audioCodec?: "aac" | "libopus" | "mp3" | "copy";
  audioBitrateKbps?: number;
  maxWidth?: number;
  maxHeight?: number;
  copy?: boolean;
  faststart?: boolean;
  outputPath?: string;
  timeoutMs?: number;
}

export interface EimuLocalTranscodeResult {
  outputPath: string;
}

export interface EimuLocalCapabilities {
  ffmpeg: boolean;
  version: string;
  platform: string;
}

/** preload 注入的 `window.eimuLocal` 之子集（本档只用这四个）。 */
export interface EimuLocalApi {
  capabilities(): Promise<EimuLocalCapabilities>;
  probe(filePath: string): Promise<EimuLocalProbeResult>;
  extractFrames(filePath: string, plan?: EimuLocalFramePlan): Promise<EimuLocalFrame[]>;
  transcode(filePath: string, opts?: EimuLocalTranscodeOpts): Promise<EimuLocalTranscodeResult>;
}

/** 统一回传形状：成功带 `result`，失败带 `reason`（永不 throw）。 */
export type LocalMediaResult<T> = { ok: true; result: T } | { ok: false; reason: string };

// ─────────────────────────── 侦测与能力快取

function getLocalApi(): EimuLocalApi | null {
  // 桌面壳的 preload 把 eimuLocal 挂在 window 上；在浏览器里 window === globalThis，
  // 在 node（测试）里也读得到 globalThis，故两边同一条读法。
  const g = globalThis as typeof globalThis & { eimuLocal?: unknown };
  const api = g.eimuLocal as EimuLocalApi | undefined;
  if (!api || typeof api.capabilities !== "function") return null;
  return api;
}

type CapabilityState = { available: boolean; reason: string };

// 依 api 物件身分快取能力探测结果：换了 api（页面重载／测试切换假件）就重探。
let cachedApi: EimuLocalApi | null = null;
let cachedCapabilities: Promise<CapabilityState> | null = null;

function probeCapabilities(api: EimuLocalApi): Promise<CapabilityState> {
  if (api !== cachedApi || cachedCapabilities === null) {
    cachedApi = api;
    cachedCapabilities = api.capabilities().then(
      (caps): CapabilityState => ({ available: Boolean(caps?.ffmpeg), reason: LOCAL_FFMPEG_UNAVAILABLE }),
      (e): CapabilityState => ({ available: false, reason: `${LOCAL_CAPABILITIES_FAILED}: ${errText(e)}` }),
    );
  }
  return cachedCapabilities;
}

function errText(e: unknown): string {
  if (e instanceof Error && e.message) return e.message;
  if (typeof e === "string" && e) return e;
  return "local_worker_failed";
}

type Resolved =
  | { ok: true; api: EimuLocalApi }
  | { ok: false; reason: string };

/** 共用前置：有 api 且 ffmpeg 可用才 ok。永不 throw。 */
async function resolveLocalApi(): Promise<Resolved> {
  const api = getLocalApi();
  if (!api) return { ok: false, reason: LOCAL_WORKER_ABSENT };
  const caps = await probeCapabilities(api);
  if (!caps.available) return { ok: false, reason: caps.reason };
  return { ok: true, api };
}

/** 本机媒体工人是否可用（桌面壳内 ＋ 本机 ffmpeg 就绪）。非同步：会等能力探测完成。 */
export async function hasLocalMediaWorker(): Promise<boolean> {
  return (await resolveLocalApi()).ok;
}

function badPath(filePath: unknown): LocalMediaResult<never> | null {
  if (typeof filePath !== "string" || filePath.trim() === "") {
    return { ok: false, reason: "bad_file_path" };
  }
  return null;
}

// ─────────────────────────── 对外三个操作（薄封装，不决定 fallback）

/** 本机 probe（metadata／streams）。失败或不可用回 `{ ok:false, reason }`，不 throw。 */
export async function probeLocally(filePath: string): Promise<LocalMediaResult<EimuLocalProbeResult>> {
  const bad = badPath(filePath);
  if (bad) return bad;
  const resolved = await resolveLocalApi();
  if (!resolved.ok) return { ok: false, reason: resolved.reason };
  try {
    const result = await resolved.api.probe(filePath);
    return { ok: true, result };
  } catch (e) {
    return { ok: false, reason: errText(e) };
  }
}

/** 本机抽帧（写入本机临时目录，回档路径）。失败或不可用回 `{ ok:false, reason }`，不 throw。 */
export async function extractFramesLocally(
  filePath: string,
  plan?: EimuLocalFramePlan,
): Promise<LocalMediaResult<EimuLocalFrame[]>> {
  const bad = badPath(filePath);
  if (bad) return bad;
  const resolved = await resolveLocalApi();
  if (!resolved.ok) return { ok: false, reason: resolved.reason };
  try {
    const result = await resolved.api.extractFrames(filePath, plan);
    return { ok: true, result };
  } catch (e) {
    return { ok: false, reason: errText(e) };
  }
}

/** 本机转码（回输出档绝对路径）。失败或不可用回 `{ ok:false, reason }`，不 throw。 */
export async function transcodeLocally(
  filePath: string,
  opts?: EimuLocalTranscodeOpts,
): Promise<LocalMediaResult<EimuLocalTranscodeResult>> {
  const bad = badPath(filePath);
  if (bad) return bad;
  const resolved = await resolveLocalApi();
  if (!resolved.ok) return { ok: false, reason: resolved.reason };
  try {
    const result = await resolved.api.transcode(filePath, opts);
    return { ok: true, result };
  } catch (e) {
    return { ok: false, reason: errText(e) };
  }
}
