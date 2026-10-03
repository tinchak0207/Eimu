// local-media-worker.ts — 前端↔桌面殼本機媒體工人薄 adapter（W4，2026-10-04）
//
// 目的：讓「瀏覽器／桌面殼直接發起」的媒體量測／抽幀／轉碼，在桌面殼內優先走本機 ffmpeg
// （`window.eimuLocal`，契約見 desktop/LOCAL-CAPABILITIES.md），減少 VPS ffmpeg 負載。
//
// 邊界（讀任何修改前先讀）：
//   · 本檔只做「偵測 → 呼叫 → 收斂成 { ok }」三件事，**不做 fallback 決策**——
//     回落由呼叫端決定（保持 adapter 單純，呼叫端知道自己的降級路徑）。
//   · **一律不 throw**：任何失敗（無 worker／ffmpeg 不可用／worker reject／capabilities 失敗／
//     參數錯）都回 `{ ok:false, reason }`，絕不中斷呼叫端的既有雲端路徑。
//   · 沒有 `window.eimuLocal`（＝純瀏覽器環境）時，本檔所有函式回 `ok:false`；
//     這正是「不具備本機能力時完全回落今天的雲端路徑」的判準。
//
// 為什麼 `hasLocalMediaWorker()` 是 async：`capabilities()` 是 IPC 呼叫，第一次探測 ffmpeg
// 要等本機子程序跑完；把能力探測的 promise 依 api 物件身分快取起來，後續呼叫即時命中
// （同時自然處理「尚未探測完成」——呼叫端 await 的就是同一條 promise）。

// ─────────────────────────── 失敗原因碼（呼叫端可據此分流，但不強制）

/** 沒有 `window.eimuLocal`：非桌面殼／瀏覽器環境。 */
export const LOCAL_WORKER_ABSENT = "no_local_worker";
/** worker 存在，但本機沒有可用的 ffmpeg。 */
export const LOCAL_FFMPEG_UNAVAILABLE = "ffmpeg_unavailable";
/** 能力探測本身失敗（IPC 錯誤等）；附 worker 回的錯誤訊息。 */
export const LOCAL_CAPABILITIES_FAILED = "capabilities_failed";

// ─────────────────────────── 型別（鏡射桌面殼契約，不 import desktop/——那是另一包的產物）

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
  /** 抽出影格在本機臨時目錄的絕對路徑（契約欄位是 `path`，不是 base64）。 */
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

/** preload 注入的 `window.eimuLocal` 之子集（本檔只用這四個）。 */
export interface EimuLocalApi {
  capabilities(): Promise<EimuLocalCapabilities>;
  probe(filePath: string): Promise<EimuLocalProbeResult>;
  extractFrames(filePath: string, plan?: EimuLocalFramePlan): Promise<EimuLocalFrame[]>;
  transcode(filePath: string, opts?: EimuLocalTranscodeOpts): Promise<EimuLocalTranscodeResult>;
}

/** 統一回傳形狀：成功帶 `result`，失敗帶 `reason`（永不 throw）。 */
export type LocalMediaResult<T> = { ok: true; result: T } | { ok: false; reason: string };

// ─────────────────────────── 偵測與能力快取

function getLocalApi(): EimuLocalApi | null {
  // 桌面殼的 preload 把 eimuLocal 掛在 window 上；在瀏覽器裡 window === globalThis，
  // 在 node（測試）裡也讀得到 globalThis，故兩邊同一條讀法。
  const g = globalThis as typeof globalThis & { eimuLocal?: unknown };
  const api = g.eimuLocal as EimuLocalApi | undefined;
  if (!api || typeof api.capabilities !== "function") return null;
  return api;
}

type CapabilityState = { available: boolean; reason: string };

// 依 api 物件身分快取能力探測結果：換了 api（頁面重載／測試切換假件）就重探。
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

/** 本機媒體工人是否可用（桌面殼內 ＋ 本機 ffmpeg 就緒）。非同步：會等能力探測完成。 */
export async function hasLocalMediaWorker(): Promise<boolean> {
  return (await resolveLocalApi()).ok;
}

function badPath(filePath: unknown): LocalMediaResult<never> | null {
  if (typeof filePath !== "string" || filePath.trim() === "") {
    return { ok: false, reason: "bad_file_path" };
  }
  return null;
}

// ─────────────────────────── 對外三個操作（薄封裝，不決定 fallback）

/** 本機 probe（metadata／streams）。失敗或不可用回 `{ ok:false, reason }`，不 throw。 */
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

/** 本機抽幀（寫入本機臨時目錄，回檔路徑）。失敗或不可用回 `{ ok:false, reason }`，不 throw。 */
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

/** 本機轉碼（回輸出檔絕對路徑）。失敗或不可用回 `{ ok:false, reason }`，不 throw。 */
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
