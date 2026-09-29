/**
 * 生成式後期（對稱差 D22／P1-3）：續片 `extend_video` ＋ 局部改片 `edit_video`。
 *
 * ── 對標來源（唯一口徑）────────────────────────────────────────────────────
 * `Dramagic對稱差-全站-0928.md` §【API 級增補】A：上游 `ListModelCapabilities`
 * 回應裡「生成模式是 API 一等欄位」`AvailableGenerationType`，逐字為
 * `reference_frame`／`head_frame`／`head_tail_frame`／`extend_video`／`edit_video`，
 * 後兩者**僅 Seedance-2.5 提供**（2.0 系只有 reference_frame／head_tail_frame）。
 * 本模組的型別名逐字沿用上游列舉，不改白話（避免「續片」與上游欄位值對不上）。
 *
 * ── 為什麼是 workflow 參數而不是新 kind ───────────────────────────────────
 * `generation_job.kind` 是 DB CHECK 約束（db/migrations/009、018），新增值的代價是
 * 一次 migration ＋ seed ＋ 全鏈（capability / scheduler / 計費投影 / 對帳）改口徑。
 * 而續片／改片在**上游語義上仍是 video_generate 的一次提交**（同一個 model、
 * 同一條 /videos 輪詢、同一種產物），差別只在請求體多了來源影片與區段欄位。
 * 故本能力＝`kind: "video_generate"` ＋ `workflow.videoPostProduction`，
 * 完全走既有 adapter／worker／成本閘鏈路（不另造第二套管線）。
 *
 * ── 成本閘（2026-09-27 ¥31.2857 事故後的紅線）─────────────────────────────
 * 本模組**只回報事實**，不做放行判定。續片／改片的計費秒數＝**本次新生成的秒數**
 * （續片＝續長；改片＝區段長），不是來源片長；該值必須是 catalog 已登錄的時長檔位，
 * 否則成本閘會以 `triple_not_priced` 拒收（fail-closed）。閘門唯一真源仍是
 * `paid-video-cost-gate.ts`，本模組不新增任何繞道。
 *
 * ── 上游欄位映射是**未校準**的（誠實標記，禁止當已成事實）───────────────
 * 我方現行視頻渠道（xiaoyxiao／gway，new-api relay 的 dreamina seedance）**只被實查過
 * 普通生成**（POST /videos + GET /videos/{id}）；上游是否收 `extend_video`／
 * `edit_video` 請求、欄位叫什麼，**零現場證據**（`grep -r extend_video src/` 零命中，
 * 對手的型別是它自家 dramart API 的列舉）。因此：
 *   ① 欄位名集中在本檔 `VIDEO_POST_PRODUCTION_UPSTREAM_FIELD`（唯一落點，校準時只改這裡）；
 *   ② 真提交由 `videoPostProductionUpstreamEnabled()`（env `VIDEO_POST_PRODUCTION_UPSTREAM=1`）
 *      **默認關閉**，未開啟時以具名錯誤拒收——**絕不靜默降級成一般生成**：上游
 *      Go 端對未知欄位是 ignore（不報錯），默認放行會變成「用戶要續片、上游當普通生成」
 *      的付費假交付。開了開關才送，送出去之前一律零成本失敗。
 */

import { generationModel } from "../generation-model-catalog";
import type { VideoGenerationType } from "../generation-model-catalog";
import { SupplierRequestError } from "./failure-classifier";
import { PAID_VIDEO_MAX_SECONDS } from "./paid-video-cost-gate";

/** 上游 `AvailableGenerationType` 逐字值（"generate" 為我方代表普通生成的基準值）。 */
export type VideoPostProductionMode = "extend_video" | "edit_video";

/** 型別枚舉（＝上游 AvailableGenerationType 中我方已能表達的三種）。 */
export const VIDEO_POST_PRODUCTION_MODES: readonly VideoPostProductionMode[] = ["extend_video", "edit_video"];

/** 便於路由/前端做能力宣告：普通生成 + 後期型別。 */
export const VIDEO_GENERATION_TYPES: readonly VideoGenerationType[] = ["generate", "extend_video", "edit_video"];

// ── 具名錯誤碼（規格要求：不支援必須具名拒絕，不得靜默降級）─────────────────

export type VideoPostProductionErrorCode =
  | "video_generation_type_unsupported"
  | "video_post_production_invalid_request"
  | "video_source_video_missing"
  | "video_source_video_unresolved"
  | "video_source_video_not_url"
  | "video_extend_seconds_invalid"
  | "video_extend_point_invalid"
  | "video_edit_segment_invalid"
  | "video_edit_instruction_missing"
  | "video_post_production_seconds_not_priced"
  | "video_post_production_upstream_unverified";

export class VideoPostProductionError extends Error {
  constructor(
    readonly code: VideoPostProductionErrorCode,
    message: string,
    /** 路由直接拿去回 HTTP 狀態；預設 400＝確定性輸入錯誤（不重放、不燒錢）。 */
    readonly status: number = 400,
  ) {
    super(message);
    this.name = "VideoPostProductionError";
  }
}

// ── 參數契約（來源影片 ＋ 續長／續接點｜來源影片 ＋ 區段 ＋ 改動描述）────────

export interface VideoSourceVideoInput {
  /** 已入庫的物件鍵（兩段式上傳回寫後取得，P1-10）；與 `url` 二擇一。 */
  objectKey?: unknown;
  /** 已可直接讀取的公網 URL（生成歷史的 deliveryUrl、外部素材）。 */
  url?: unknown;
  mimeType?: unknown;
  /** 來源片長（秒）；已知時用於邊界檢查（續接點／區段不得越界）。 */
  durationSeconds?: unknown;
}

export interface VideoExtendRequest {
  source: VideoSourceVideoInput;
  /** 續長（秒）：本次要新生成的長度，同時是計費秒數。 */
  continueSeconds?: unknown;
  /** 續接點（秒）；缺省＝來源片尾（＝來源片長；片長未知時交給上游預設）。 */
  continueFromSeconds?: unknown;
}

export interface VideoEditRequest {
  source: VideoSourceVideoInput;
  /** 要改的區段起訖（秒），0 ≤ start < end。 */
  startSeconds?: unknown;
  endSeconds?: unknown;
  /** 改動描述（局部改片的主參數）。 */
  instruction?: unknown;
  /** 區段的另一種寫法（優先於頂層 start/end/instruction）。 */
  segment?: { startSeconds?: unknown; endSeconds?: unknown; instruction?: unknown };
}

export interface VideoPostProductionInput {
  mode?: unknown;
  source?: VideoSourceVideoInput;
  continueSeconds?: unknown;
  continueFromSeconds?: unknown;
  startSeconds?: unknown;
  endSeconds?: unknown;
  instruction?: unknown;
  segment?: VideoEditRequest["segment"];
}

export interface NormalizedVideoSourceVideo {
  /** 解析後的公網 URL（上游實際會收到的值）。 */
  url: string;
  /** 物件鍵（有帶就保留，供溯源／除錯）。 */
  objectKey?: string;
  mimeType: string;
  durationSeconds?: number;
}

export type NormalizedVideoPostProduction =
  | {
    mode: "extend_video";
    source: NormalizedVideoSourceVideo;
    /** 本次新生成秒數（＝計費秒數）。 */
    continueSeconds: number;
    /** 續接點（秒）；零＝從來源片首，null＝未指定（交上游預設＝來源片尾）。 */
    continueFromSeconds: number | null;
  }
  | {
    mode: "edit_video";
    source: NormalizedVideoSourceVideo;
    startSeconds: number;
    endSeconds: number;
    instruction: string;
  };

/** objectKey → 公網 URL 的解析器；解不出回 null（呼叫端據此具名拒絕）。 */
export type SourceVideoUrlResolver = (objectKey: string) => string | null;

// ── 能力宣告（唯一真源＝catalog 的 videoGenerationTypes）────────────────────

/**
 * 某平台模型可用的影片生成型別。catalog 未宣告＝只支援普通生成
 * （**不推導、不升格**：能力宣告缺一即不許提交，避免「以為能續片」的付費假交付）。
 */
export function videoGenerationTypesFor(modelId: string): readonly VideoGenerationType[] {
  return generationModel(modelId)?.videoGenerationTypes ?? ["generate"];
}

export function supportsVideoGenerationType(modelId: string, mode: VideoGenerationType): boolean {
  return videoGenerationTypesFor(modelId).includes(mode);
}

/** 不支援即具名拋錯（路由 400、adapter 400；兩處都不得靜默降級）。 */
export function assertVideoGenerationTypeSupported(modelId: string, mode: VideoGenerationType): void {
  if (supportsVideoGenerationType(modelId, mode)) return;
  throw new VideoPostProductionError(
    "video_generation_type_unsupported",
    `模型 ${modelId} 不支援生成型別 ${mode}（可用：${videoGenerationTypesFor(modelId).join("／")}）。`
      + "續片／局部改片目前僅 Seedance-2.5 族（seedance-2.5-480p／seedance-2.5-720p）支援。",
  );
}

// ── 純解析／校驗 ────────────────────────────────────────────────────────────

function readString(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

/** 同時吃 camelCase 與 snake_case（B 端 API 用 snake_case，站內 workflow 用 camelCase）。 */
function readAliased(source: Record<string, unknown>, ...keys: string[]): unknown {
  for (const key of keys) {
    if (source[key] !== undefined && source[key] !== null) return source[key];
  }
  return undefined;
}

function readNumber(value: unknown): number | null {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value === "string" && value.trim()) {
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : null;
  }
  return null;
}

function isHttpUrl(value: string): boolean {
  return value.startsWith("https://") || value.startsWith("http://");
}

/**
 * 來源影片定位：`url` 直用；只給 `objectKey` 時走注入的解析器（生產＝
 * `two-phase-upload.publicObjectUrl`，caller 亦可自行先驗擁有權後注入）。
 * 兩者皆無／URL 形狀不合法／objectKey 解不出 → 具名拒絕（不送出假 URL）。
 */
export function resolveSourceVideo(
  source: VideoSourceVideoInput | undefined,
  resolveObjectKeyUrl: SourceVideoUrlResolver,
): NormalizedVideoSourceVideo {
  if (!source || typeof source !== "object") {
    throw new VideoPostProductionError("video_source_video_missing", "缺少來源影片：需要 source_video.url 或 source_video.object_key。");
  }
  const rawUrl = readString(readAliased(source as Record<string, unknown>, "url", "deliveryUrl", "delivery_url"));
  const objectKey = readString(readAliased(source as Record<string, unknown>, "objectKey", "object_key"));
  const mimeType = readString(readAliased(source as Record<string, unknown>, "mimeType", "mime_type")) || "video/mp4";
  const duration = readNumber(readAliased(source as Record<string, unknown>, "durationSeconds", "duration_seconds"));

  let url = rawUrl;
  if (!url && objectKey) {
    const resolved = resolveObjectKeyUrl(objectKey);
    // 解析器回 null ＝物件未入庫／不屬呼叫者／後端未設定：明確拒絕，不猜 URL。
    if (!resolved) {
      throw new VideoPostProductionError(
        "video_source_video_unresolved",
        `來源影片物件鍵 ${objectKey} 無法解析成可讀 URL（未入庫、不屬呼叫者，或物件儲存後端未設定）。`,
      );
    }
    url = resolved;
  }
  if (!url) {
    throw new VideoPostProductionError("video_source_video_missing", "缺少來源影片：需要 source_video.url 或 source_video.object_key。");
  }
  if (!isHttpUrl(url)) {
    throw new VideoPostProductionError("video_source_video_not_url", `來源影片 URL 必須是 http(s)，收到 "${url}"。`);
  }
  if (duration !== null && (!Number.isInteger(duration) || duration <= 0)) {
    throw new VideoPostProductionError("video_post_production_invalid_request", `來源片長必須是正整數秒，收到 ${String(duration)}。`);
  }
  return {
    url,
    ...(objectKey ? { objectKey } : {}),
    mimeType,
    ...(duration !== null ? { durationSeconds: duration } : {}),
  };
}

/**
 * 解析＋校驗（**唯一入口**）：形狀 → 來源影片 → 型別能力 → 生成秒數檔位。
 * 回 null＝本次提交不是生成式後期（走普通生成，零行為變化）。
 * 校驗順序刻意與成本閘一致：先輸入校驗，後成本閘（閘在 worker 提交前跑）。
 */
export function parseVideoPostProduction(
  input: unknown,
  options: {
    modelId: string;
    resolveObjectKeyUrl: SourceVideoUrlResolver;
  },
): NormalizedVideoPostProduction | null {
  if (!input || typeof input !== "object" || Array.isArray(input)) return null;
  const raw = input as Record<string, unknown>;
  const modeRaw = readString(readAliased(raw, "mode", "type", "generationType", "generation_type"));
  if (!modeRaw) {
    throw new VideoPostProductionError("video_post_production_invalid_request", "生成式後期缺少 mode（extend_video／edit_video）。");
  }
  if (modeRaw !== "extend_video" && modeRaw !== "edit_video") {
    throw new VideoPostProductionError(
      "video_post_production_invalid_request",
      `未知的生成式後期型別 "${modeRaw}"（本平台已表達的型別：${VIDEO_POST_PRODUCTION_MODES.join("／")}）。`,
    );
  }

  // 能力閘先做：不支援的模型連參數都不必細看（錯誤碼固定為 unsupported，訊息不含用戶輸入）。
  assertVideoGenerationTypeSupported(options.modelId, modeRaw);

  const source = resolveSourceVideo(
    (readAliased(raw, "source", "sourceVideo", "source_video") ?? raw.source) as VideoSourceVideoInput | undefined,
    options.resolveObjectKeyUrl,
  );
  const durations = generationModel(options.modelId)?.durations ?? [];

  if (modeRaw === "extend_video") {
    const continueSeconds = readNumber(readAliased(raw, "continueSeconds", "continue_seconds", "extendSeconds", "extend_seconds"));
    if (continueSeconds === null) {
      throw new VideoPostProductionError("video_extend_seconds_invalid", "續片必須帶 continue_seconds（續長，秒）。");
    }
    if (!Number.isInteger(continueSeconds) || continueSeconds < 1 || continueSeconds > PAID_VIDEO_MAX_SECONDS) {
      throw new VideoPostProductionError(
        "video_extend_seconds_invalid",
        `續長必須是 1–${PAID_VIDEO_MAX_SECONDS} 的整數秒，收到 ${continueSeconds}。`,
      );
    }
    const rawFrom = readNumber(readAliased(raw, "continueFromSeconds", "continue_from_seconds", "extendFromSeconds", "extend_from_seconds"));
    let continueFromSeconds: number | null = null;
    if (rawFrom !== null) {
      if (!Number.isInteger(rawFrom) || rawFrom < 0) {
        throw new VideoPostProductionError("video_extend_point_invalid", `續接點必須是非負整數秒，收到 ${rawFrom}。`);
      }
      if (source.durationSeconds !== undefined && rawFrom > source.durationSeconds) {
        throw new VideoPostProductionError(
          "video_extend_point_invalid",
          `續接點 ${rawFrom}s 超出來源片長 ${source.durationSeconds}s。`,
        );
      }
      continueFromSeconds = rawFrom;
    }
    assertGeneratedSecondsIsPriced(options.modelId, continueSeconds, durations);
    return { mode: "extend_video", source, continueSeconds, continueFromSeconds };
  }

  const segment = (readAliased(raw, "segment", "editSegment", "edit_segment") ?? raw.segment) as
    | VideoEditRequest["segment"]
    | undefined;
  const segmentRecord = segment && typeof segment === "object" && !Array.isArray(segment)
    ? (segment as Record<string, unknown>)
    : undefined;
  const start = readNumber(segmentRecord ? readAliased(segmentRecord, "startSeconds", "start_seconds", "start") : readAliased(raw, "startSeconds", "start_seconds", "start"));
  const end = readNumber(segmentRecord ? readAliased(segmentRecord, "endSeconds", "end_seconds", "end") : readAliased(raw, "endSeconds", "end_seconds", "end"));
  if (start === null || end === null) {
    throw new VideoPostProductionError("video_edit_segment_invalid", "局部改片必須帶要改區段的 start_seconds 與 end_seconds。");
  }
  if (!Number.isInteger(start) || start < 0) {
    throw new VideoPostProductionError("video_edit_segment_invalid", `區段起點必須是非負整數秒，收到 ${start}。`);
  }
  if (!Number.isInteger(end) || end <= start) {
    throw new VideoPostProductionError("video_edit_segment_invalid", `區段終點必須是大於起點的整數秒（收到 start=${start}、end=${end}）。`);
  }
  if (source.durationSeconds !== undefined && end > source.durationSeconds) {
    throw new VideoPostProductionError(
      "video_edit_segment_invalid",
      `區段終點 ${end}s 超出來源片長 ${source.durationSeconds}s。`,
    );
  }
  const instruction = readString(
    segmentRecord ? readAliased(segmentRecord, "instruction", "prompt", "description") : readAliased(raw, "instruction", "editInstruction", "edit_instruction"),
  );
  if (!instruction) {
    throw new VideoPostProductionError("video_edit_instruction_missing", "局部改片必須帶 instruction（改動描述）。");
  }
  if (instruction.length > 2_000) {
    throw new VideoPostProductionError("video_edit_instruction_missing", "改動描述不得超過 2000 字元。");
  }
  assertGeneratedSecondsIsPriced(options.modelId, end - start, durations);
  return { mode: "edit_video", source, startSeconds: start, endSeconds: end, instruction };
}

/**
 * 生成秒數必須是 catalog 已登錄檔位 —— 否則成本閘在 `triple_not_priced` 拒收，
 * 不如在建單前就講清楚（同一個檔位真源，錯誤更早更準）。
 */
function assertGeneratedSecondsIsPriced(modelId: string, seconds: number, durations: readonly number[]): void {
  if (durations.includes(seconds)) return;
  throw new VideoPostProductionError(
    "video_post_production_seconds_not_priced",
    `本次生成秒數 ${seconds}s 不在模型 ${modelId} 的已登錄時長檔位（${durations.join("／")}）`
      + "——未登錄＝未核價，成本閘會拒收，故在此先拒。",
  );
}

/** 本次新生成秒數（＝應送成本閘、應送上游的秒數）。 */
export function videoPostProductionGeneratedSeconds(postProduction: NormalizedVideoPostProduction): number {
  return postProduction.mode === "extend_video"
    ? postProduction.continueSeconds
    : postProduction.endSeconds - postProduction.startSeconds;
}

/**
 * 局部改片若沒另給 prompt，用改動描述當 prompt（產品的「一句話改這一小段」）。
 * 其他情況原樣回傳（不偷偷改寫用戶的 prompt）。
 */
export function effectiveVideoPrompt(prompt: string, postProduction: NormalizedVideoPostProduction | null): string {
  const trimmed = prompt.trim();
  if (trimmed) return trimmed;
  return postProduction?.mode === "edit_video" ? postProduction.instruction : trimmed;
}

// ── upstream 欄位映射（未校準的唯一落點）───────────────────────────────────

/**
 * 續片／改片的上游欄位名。**狀態＝未校準**（見檔頭）。校準方式：暴君點名後對
 * 上游出一筆真單，用回應形狀驗欄位語義，然後**只改本表**，並把
 * `VIDEO_POST_PRODUCTION_UPSTREAM_SEMANTICS` 改字串＋補真單 request id 到註解。
 *
 * 命名依據（保守對齊既有欄位慣例，非抄自任何上游文檔）：來源影片走
 * `reference_*_urls` 家族（既有普通生成用 `reference_image_urls`），續長／續接點
 * 走動詞前綴 `extend_*`，區段化改片走單一物件 `edit_segment`（起訖＋描述同進同出）。
 */
export const VIDEO_POST_PRODUCTION_UPSTREAM_FIELD = {
  sourceVideoUrls: "reference_video_urls",
  extendSeconds: "extend_seconds",
  extendFromSeconds: "extend_from_seconds",
  editSegment: "edit_segment",
} as const;

export const VIDEO_POST_PRODUCTION_UPSTREAM_SEMANTICS = "upstream-field-mapping-unverified" as const;

/** 真提交開關（默認關閉；校準完成後由暴君下令開，同 NEWAPI_VIDEO_KERNEL 影子期手法）。 */
export function videoPostProductionUpstreamEnabled(): boolean {
  const value = (process.env.VIDEO_POST_PRODUCTION_UPSTREAM ?? "").trim().toLowerCase();
  return value === "1" || value === "true";
}

/**
 * 提交前硬閘：映射未校準＝**拒收**（具名錯誤、零上游成本）。
 * 為什麼不能「先送送看」：上游 Go 端忽略未知欄位且不報錯 ⇒ 會變成
 * 「用戶要續片、上游當普通生成」的付費假交付，正是規格禁止的靜默降級。
 */
export function assertVideoPostProductionUpstreamReady(postProduction: NormalizedVideoPostProduction): void {
  if (videoPostProductionUpstreamEnabled()) return;
  throw new SupplierRequestError(
    `video_post_production_upstream_unverified: 生成式後期（${postProduction.mode}）的上游欄位映射尚未由真單校準`
      + `（${VIDEO_POST_PRODUCTION_UPSTREAM_SEMANTICS}）；為避免上游忽略未知欄位而靜默降級成普通生成，本次拒絕提交。`
      + "校準後設 VIDEO_POST_PRODUCTION_UPSTREAM=1 開啟。",
    400,
  );
}

/**
 * 把生成式後期欄位併進上游請求體（純函式，供測試直接斷言）。
 * 只在 openai_video 協議（xiaoyxiao／gway）的請求體上使用；不碰任何圖片路徑。
 */
export function applyVideoPostProductionToUpstreamBody(
  body: Record<string, unknown>,
  postProduction: NormalizedVideoPostProduction,
): Record<string, unknown> {
  const next: Record<string, unknown> = {
    ...body,
    [VIDEO_POST_PRODUCTION_UPSTREAM_FIELD.sourceVideoUrls]: [postProduction.source.url],
  };
  if (postProduction.mode === "extend_video") {
    next[VIDEO_POST_PRODUCTION_UPSTREAM_FIELD.extendSeconds] = postProduction.continueSeconds;
    if (postProduction.continueFromSeconds !== null) {
      next[VIDEO_POST_PRODUCTION_UPSTREAM_FIELD.extendFromSeconds] = postProduction.continueFromSeconds;
    }
    return next;
  }
  next[VIDEO_POST_PRODUCTION_UPSTREAM_FIELD.editSegment] = {
    start_seconds: postProduction.startSeconds,
    end_seconds: postProduction.endSeconds,
    instruction: postProduction.instruction,
  };
  return next;
}

/**
 * 讀取 job.workflow 裡的已正規化後期參數（worker/adapter 端；**不再重跑校驗**——
 * 校驗已在建單前做過，此處只做形狀檢查，形狀壞＝明確拋錯不吞）。
 */
export function readNormalizedVideoPostProduction(workflow: Record<string, unknown>): NormalizedVideoPostProduction | null {
  const raw = workflow.videoPostProduction;
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null;
  const candidate = raw as Partial<NormalizedVideoPostProduction> & { mode?: unknown };
  const source = candidate.source as NormalizedVideoSourceVideo | undefined;
  if (!source || typeof source.url !== "string" || !source.url) {
    throw new SupplierRequestError("video-post-production: workflow.videoPostProduction.source.url 缺失或非字串。", 400);
  }
  if (candidate.mode === "extend_video") {
    const seconds = (candidate as { continueSeconds?: unknown }).continueSeconds;
    if (typeof seconds !== "number" || !Number.isInteger(seconds) || seconds < 1) {
      throw new SupplierRequestError("video-post-production: extend_video 的 continueSeconds 非法。", 400);
    }
    const from = (candidate as { continueFromSeconds?: unknown }).continueFromSeconds;
    return {
      mode: "extend_video",
      source,
      continueSeconds: seconds,
      continueFromSeconds: typeof from === "number" && Number.isInteger(from) ? from : null,
    };
  }
  if (candidate.mode === "edit_video") {
    const { startSeconds, endSeconds, instruction } = candidate as {
      startSeconds?: unknown;
      endSeconds?: unknown;
      instruction?: unknown;
    };
    if (
      typeof startSeconds !== "number" || typeof endSeconds !== "number"
      || !Number.isInteger(startSeconds) || !Number.isInteger(endSeconds) || endSeconds <= startSeconds
      || typeof instruction !== "string" || !instruction
    ) {
      throw new SupplierRequestError("video-post-production: edit_video 的區段或改動描述非法。", 400);
    }
    return { mode: "edit_video", source, startSeconds, endSeconds, instruction };
  }
  throw new SupplierRequestError(`video-post-production: 未知 mode "${String(candidate.mode)}"。`, 400);
}