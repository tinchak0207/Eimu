/**
 * 生成式后期（对称差 D22／P1-3）：续片 `extend_video` ＋ 局部改片 `edit_video`。
 *
 * ── 对标来源（唯一口径）────────────────────────────────────────────────────
 * `Dramagic对称差-全站-0928.md` §【API 级增补】A：上游 `ListModelCapabilities`
 * 回应里「生成模式是 API 一等栏位」`AvailableGenerationType`，逐字为
 * `reference_frame`／`head_frame`／`head_tail_frame`／`extend_video`／`edit_video`，
 * 后两者**仅 Seedance-2.5 提供**（2.0 系只有 reference_frame／head_tail_frame）。
 * 本模组的型别名逐字沿用上游列举，不改白话（避免「续片」与上游栏位值对不上）。
 *
 * ── 为什么是 workflow 参数而不是新 kind ───────────────────────────────────
 * `generation_job.kind` 是 DB CHECK 约束（db/migrations/009、018），新增值的代价是
 * 一次 migration ＋ seed ＋ 全链（capability / scheduler / 计费投影 / 对帐）改口径。
 * 而续片／改片在**上游语义上仍是 video_generate 的一次提交**（同一个 model、
 * 同一条 /videos 轮询、同一种产物），差别只在请求体多了来源影片与区段栏位。
 * 故本能力＝`kind: "video_generate"` ＋ `workflow.videoPostProduction`，
 * 完全走既有 adapter／worker／成本闸链路（不另造第二套管线）。
 *
 * ── 成本闸（2026-09-27 ¥31.2857 事故后的红线）─────────────────────────────
 * 本模组**只回报事实**，不做放行判定。续片／改片的计费秒数＝**本次新生成的秒数**
 * （续片＝续长；改片＝区段长），不是来源片长；该值必须是 catalog 已登录的时长档位，
 * 否则成本闸会以 `triple_not_priced` 拒收（fail-closed）。闸门唯一真源仍是
 * `paid-video-cost-gate.ts`，本模组不新增任何绕道。
 *
 * ── 上游栏位映射是**未校准**的（诚实标记，禁止当已成事实）───────────────
 * 我方现行视频渠道（xiaoyxiao／gway，new-api relay 的 dreamina seedance）**只被实查过
 * 普通生成**（POST /videos + GET /videos/{id}）；上游是否收 `extend_video`／
 * `edit_video` 请求、栏位叫什么，**零现场证据**（`grep -r extend_video src/` 零命中，
 * 对手的型别是它自家 dramart API 的列举）。因此：
 *   ① 栏位名集中在本档 `VIDEO_POST_PRODUCTION_UPSTREAM_FIELD`（唯一落点，校准时只改这里）；
 *   ② 真提交由 `videoPostProductionUpstreamEnabled()`（env `VIDEO_POST_PRODUCTION_UPSTREAM=1`）
 *      **默认关闭**，未开启时以具名错误拒收——**绝不静默降级成一般生成**：上游
 *      Go 端对未知栏位是 ignore（不报错），默认放行会变成「用户要续片、上游当普通生成」
 *      的付费假交付。开了开关才送，送出去之前一律零成本失败。
 */

import { generationModel } from "../generation-model-catalog";
import type { VideoGenerationType } from "../generation-model-catalog";
import { SupplierRequestError } from "./failure-classifier";
import { PAID_VIDEO_MAX_SECONDS } from "./paid-video-cost-gate";

/** 上游 `AvailableGenerationType` 逐字值（"generate" 为我方代表普通生成的基准值）。 */
export type VideoPostProductionMode = "extend_video" | "edit_video";

/** 型别枚举（＝上游 AvailableGenerationType 中我方已能表达的三种）。 */
export const VIDEO_POST_PRODUCTION_MODES: readonly VideoPostProductionMode[] = ["extend_video", "edit_video"];

/** 便于路由/前端做能力宣告：普通生成 + 后期型别。 */
export const VIDEO_GENERATION_TYPES: readonly VideoGenerationType[] = ["generate", "extend_video", "edit_video"];

// ── 具名错误码（规格要求：不支援必须具名拒绝，不得静默降级）─────────────────

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
    /** 路由直接拿去回 HTTP 状态；预设 400＝确定性输入错误（不重放、不烧钱）。 */
    readonly status: number = 400,
  ) {
    super(message);
    this.name = "VideoPostProductionError";
  }
}

// ── 参数契约（来源影片 ＋ 续长／续接点｜来源影片 ＋ 区段 ＋ 改动描述）────────

export interface VideoSourceVideoInput {
  /** 已入库的物件键（两段式上传回写后取得，P1-10）；与 `url` 二择一。 */
  objectKey?: unknown;
  /** 已可直接读取的公网 URL（生成历史的 deliveryUrl、外部素材）。 */
  url?: unknown;
  mimeType?: unknown;
  /** 来源片长（秒）；已知时用于边界检查（续接点／区段不得越界）。 */
  durationSeconds?: unknown;
}

export interface VideoExtendRequest {
  source: VideoSourceVideoInput;
  /** 续长（秒）：本次要新生成的长度，同时是计费秒数。 */
  continueSeconds?: unknown;
  /** 续接点（秒）；缺省＝来源片尾（＝来源片长；片长未知时交给上游预设）。 */
  continueFromSeconds?: unknown;
}

export interface VideoEditRequest {
  source: VideoSourceVideoInput;
  /** 要改的区段起讫（秒），0 ≤ start < end。 */
  startSeconds?: unknown;
  endSeconds?: unknown;
  /** 改动描述（局部改片的主参数）。 */
  instruction?: unknown;
  /** 区段的另一种写法（优先于顶层 start/end/instruction）。 */
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
  /** 解析后的公网 URL（上游实际会收到的值）。 */
  url: string;
  /** 物件键（有带就保留，供溯源／除错）。 */
  objectKey?: string;
  mimeType: string;
  durationSeconds?: number;
}

export type NormalizedVideoPostProduction =
  | {
    mode: "extend_video";
    source: NormalizedVideoSourceVideo;
    /** 本次新生成秒数（＝计费秒数）。 */
    continueSeconds: number;
    /** 续接点（秒）；零＝从来源片首，null＝未指定（交上游预设＝来源片尾）。 */
    continueFromSeconds: number | null;
  }
  | {
    mode: "edit_video";
    source: NormalizedVideoSourceVideo;
    startSeconds: number;
    endSeconds: number;
    instruction: string;
  };

/** objectKey → 公网 URL 的解析器；解不出回 null（呼叫端据此具名拒绝）。 */
export type SourceVideoUrlResolver = (objectKey: string) => string | null;

// ── 能力宣告（唯一真源＝catalog 的 videoGenerationTypes）────────────────────

/**
 * 某平台模型可用的影片生成型别。catalog 未宣告＝只支援普通生成
 * （**不推导、不升格**：能力宣告缺一即不许提交，避免「以为能续片」的付费假交付）。
 */
export function videoGenerationTypesFor(modelId: string): readonly VideoGenerationType[] {
  return generationModel(modelId)?.videoGenerationTypes ?? ["generate"];
}

export function supportsVideoGenerationType(modelId: string, mode: VideoGenerationType): boolean {
  return videoGenerationTypesFor(modelId).includes(mode);
}

/** 不支援即具名抛错（路由 400、adapter 400；两处都不得静默降级）。 */
export function assertVideoGenerationTypeSupported(modelId: string, mode: VideoGenerationType): void {
  if (supportsVideoGenerationType(modelId, mode)) return;
  throw new VideoPostProductionError(
    "video_generation_type_unsupported",
    `模型 ${modelId} 不支援生成型别 ${mode}（可用：${videoGenerationTypesFor(modelId).join("／")}）。`
      + "续片／局部改片目前仅 Seedance-2.5 族（seedance-2.5-480p／seedance-2.5-720p）支援。",
  );
}

// ── 纯解析／校验 ────────────────────────────────────────────────────────────

function readString(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

/** 同时吃 camelCase 与 snake_case（B 端 API 用 snake_case，站内 workflow 用 camelCase）。 */
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
 * 来源影片定位：`url` 直用；只给 `objectKey` 时走注入的解析器（生产＝
 * `two-phase-upload.publicObjectUrl`，caller 亦可自行先验拥有权后注入）。
 * 两者皆无／URL 形状不合法／objectKey 解不出 → 具名拒绝（不送出假 URL）。
 */
export function resolveSourceVideo(
  source: VideoSourceVideoInput | undefined,
  resolveObjectKeyUrl: SourceVideoUrlResolver,
): NormalizedVideoSourceVideo {
  if (!source || typeof source !== "object") {
    throw new VideoPostProductionError("video_source_video_missing", "缺少来源影片：需要 source_video.url 或 source_video.object_key。");
  }
  const rawUrl = readString(readAliased(source as Record<string, unknown>, "url", "deliveryUrl", "delivery_url"));
  const objectKey = readString(readAliased(source as Record<string, unknown>, "objectKey", "object_key"));
  const mimeType = readString(readAliased(source as Record<string, unknown>, "mimeType", "mime_type")) || "video/mp4";
  const duration = readNumber(readAliased(source as Record<string, unknown>, "durationSeconds", "duration_seconds"));

  let url = rawUrl;
  if (!url && objectKey) {
    const resolved = resolveObjectKeyUrl(objectKey);
    // 解析器回 null ＝物件未入库／不属呼叫者／后端未设定：明确拒绝，不猜 URL。
    if (!resolved) {
      throw new VideoPostProductionError(
        "video_source_video_unresolved",
        `来源影片物件键 ${objectKey} 无法解析成可读 URL（未入库、不属呼叫者，或物件储存后端未设定）。`,
      );
    }
    url = resolved;
  }
  if (!url) {
    throw new VideoPostProductionError("video_source_video_missing", "缺少来源影片：需要 source_video.url 或 source_video.object_key。");
  }
  if (!isHttpUrl(url)) {
    throw new VideoPostProductionError("video_source_video_not_url", `来源影片 URL 必须是 http(s)，收到 "${url}"。`);
  }
  if (duration !== null && (!Number.isInteger(duration) || duration <= 0)) {
    throw new VideoPostProductionError("video_post_production_invalid_request", `来源片长必须是正整数秒，收到 ${String(duration)}。`);
  }
  return {
    url,
    ...(objectKey ? { objectKey } : {}),
    mimeType,
    ...(duration !== null ? { durationSeconds: duration } : {}),
  };
}

/**
 * 解析＋校验（**唯一入口**）：形状 → 来源影片 → 型别能力 → 生成秒数档位。
 * 回 null＝本次提交不是生成式后期（走普通生成，零行为变化）。
 * 校验顺序刻意与成本闸一致：先输入校验，后成本闸（闸在 worker 提交前跑）。
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
    throw new VideoPostProductionError("video_post_production_invalid_request", "生成式后期缺少 mode（extend_video／edit_video）。");
  }
  if (modeRaw !== "extend_video" && modeRaw !== "edit_video") {
    throw new VideoPostProductionError(
      "video_post_production_invalid_request",
      `未知的生成式后期型别 "${modeRaw}"（本平台已表达的型别：${VIDEO_POST_PRODUCTION_MODES.join("／")}）。`,
    );
  }

  // 能力闸先做：不支援的模型连参数都不必细看（错误码固定为 unsupported，讯息不含用户输入）。
  assertVideoGenerationTypeSupported(options.modelId, modeRaw);

  const source = resolveSourceVideo(
    (readAliased(raw, "source", "sourceVideo", "source_video") ?? raw.source) as VideoSourceVideoInput | undefined,
    options.resolveObjectKeyUrl,
  );
  const durations = generationModel(options.modelId)?.durations ?? [];

  if (modeRaw === "extend_video") {
    const continueSeconds = readNumber(readAliased(raw, "continueSeconds", "continue_seconds", "extendSeconds", "extend_seconds"));
    if (continueSeconds === null) {
      throw new VideoPostProductionError("video_extend_seconds_invalid", "续片必须带 continue_seconds（续长，秒）。");
    }
    if (!Number.isInteger(continueSeconds) || continueSeconds < 1 || continueSeconds > PAID_VIDEO_MAX_SECONDS) {
      throw new VideoPostProductionError(
        "video_extend_seconds_invalid",
        `续长必须是 1–${PAID_VIDEO_MAX_SECONDS} 的整数秒，收到 ${continueSeconds}。`,
      );
    }
    const rawFrom = readNumber(readAliased(raw, "continueFromSeconds", "continue_from_seconds", "extendFromSeconds", "extend_from_seconds"));
    let continueFromSeconds: number | null = null;
    if (rawFrom !== null) {
      if (!Number.isInteger(rawFrom) || rawFrom < 0) {
        throw new VideoPostProductionError("video_extend_point_invalid", `续接点必须是非负整数秒，收到 ${rawFrom}。`);
      }
      if (source.durationSeconds !== undefined && rawFrom > source.durationSeconds) {
        throw new VideoPostProductionError(
          "video_extend_point_invalid",
          `续接点 ${rawFrom}s 超出来源片长 ${source.durationSeconds}s。`,
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
    throw new VideoPostProductionError("video_edit_segment_invalid", "局部改片必须带要改区段的 start_seconds 与 end_seconds。");
  }
  if (!Number.isInteger(start) || start < 0) {
    throw new VideoPostProductionError("video_edit_segment_invalid", `区段起点必须是非负整数秒，收到 ${start}。`);
  }
  if (!Number.isInteger(end) || end <= start) {
    throw new VideoPostProductionError("video_edit_segment_invalid", `区段终点必须是大于起点的整数秒（收到 start=${start}、end=${end}）。`);
  }
  if (source.durationSeconds !== undefined && end > source.durationSeconds) {
    throw new VideoPostProductionError(
      "video_edit_segment_invalid",
      `区段终点 ${end}s 超出来源片长 ${source.durationSeconds}s。`,
    );
  }
  const instruction = readString(
    segmentRecord ? readAliased(segmentRecord, "instruction", "prompt", "description") : readAliased(raw, "instruction", "editInstruction", "edit_instruction"),
  );
  if (!instruction) {
    throw new VideoPostProductionError("video_edit_instruction_missing", "局部改片必须带 instruction（改动描述）。");
  }
  if (instruction.length > 2_000) {
    throw new VideoPostProductionError("video_edit_instruction_missing", "改动描述不得超过 2000 字元。");
  }
  assertGeneratedSecondsIsPriced(options.modelId, end - start, durations);
  return { mode: "edit_video", source, startSeconds: start, endSeconds: end, instruction };
}

/**
 * 生成秒数必须是 catalog 已登录档位 —— 否则成本闸在 `triple_not_priced` 拒收，
 * 不如在建单前就讲清楚（同一个档位真源，错误更早更准）。
 */
function assertGeneratedSecondsIsPriced(modelId: string, seconds: number, durations: readonly number[]): void {
  if (durations.includes(seconds)) return;
  throw new VideoPostProductionError(
    "video_post_production_seconds_not_priced",
    `本次生成秒数 ${seconds}s 不在模型 ${modelId} 的已登录时长档位（${durations.join("／")}）`
      + "——未登录＝未核价，成本闸会拒收，故在此先拒。",
  );
}

/** 本次新生成秒数（＝应送成本闸、应送上游的秒数）。 */
export function videoPostProductionGeneratedSeconds(postProduction: NormalizedVideoPostProduction): number {
  return postProduction.mode === "extend_video"
    ? postProduction.continueSeconds
    : postProduction.endSeconds - postProduction.startSeconds;
}

/**
 * 局部改片若没另给 prompt，用改动描述当 prompt（产品的「一句话改这一小段」）。
 * 其他情况原样回传（不偷偷改写用户的 prompt）。
 */
export function effectiveVideoPrompt(prompt: string, postProduction: NormalizedVideoPostProduction | null): string {
  const trimmed = prompt.trim();
  if (trimmed) return trimmed;
  return postProduction?.mode === "edit_video" ? postProduction.instruction : trimmed;
}

// ── upstream 栏位映射（未校准的唯一落点）───────────────────────────────────

/**
 * 续片／改片的上游栏位名。**状态＝未校准**（见档头）。校准方式：项目负责人点名后对
 * 上游出一笔真单，用回应形状验栏位语义，然后**只改本表**，并把
 * `VIDEO_POST_PRODUCTION_UPSTREAM_SEMANTICS` 改字串＋补真单 request id 到注解。
 *
 * 命名依据（保守对齐既有栏位惯例，非抄自任何上游文档）：来源影片走
 * `reference_*_urls` 家族（既有普通生成用 `reference_image_urls`），续长／续接点
 * 走动词前缀 `extend_*`，区段化改片走单一物件 `edit_segment`（起讫＋描述同进同出）。
 */
export const VIDEO_POST_PRODUCTION_UPSTREAM_FIELD = {
  sourceVideoUrls: "reference_video_urls",
  extendSeconds: "extend_seconds",
  extendFromSeconds: "extend_from_seconds",
  editSegment: "edit_segment",
} as const;

export const VIDEO_POST_PRODUCTION_UPSTREAM_SEMANTICS = "upstream-field-mapping-unverified" as const;

/** 真提交开关（默认关闭；校准完成后由项目负责人下令开，同 NEWAPI_VIDEO_KERNEL 影子期手法）。 */
export function videoPostProductionUpstreamEnabled(): boolean {
  const value = (process.env.VIDEO_POST_PRODUCTION_UPSTREAM ?? "").trim().toLowerCase();
  return value === "1" || value === "true";
}

/**
 * 提交前硬闸：映射未校准＝**拒收**（具名错误、零上游成本）。
 * 为什么不能「先送送看」：上游 Go 端忽略未知栏位且不报错 ⇒ 会变成
 * 「用户要续片、上游当普通生成」的付费假交付，正是规格禁止的静默降级。
 */
export function assertVideoPostProductionUpstreamReady(postProduction: NormalizedVideoPostProduction): void {
  if (videoPostProductionUpstreamEnabled()) return;
  throw new SupplierRequestError(
    `video_post_production_upstream_unverified: 生成式后期（${postProduction.mode}）的上游栏位映射尚未由真单校准`
      + `（${VIDEO_POST_PRODUCTION_UPSTREAM_SEMANTICS}）；为避免上游忽略未知栏位而静默降级成普通生成，本次拒绝提交。`
      + "校准后设 VIDEO_POST_PRODUCTION_UPSTREAM=1 开启。",
    400,
  );
}

/**
 * 把生成式后期栏位并进上游请求体（纯函式，供测试直接断言）。
 * 只在 openai_video 协议（xiaoyxiao／gway）的请求体上使用；不碰任何图片路径。
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
 * 读取 job.workflow 里的已正规化后期参数（worker/adapter 端；**不再重跑校验**——
 * 校验已在建单前做过，此处只做形状检查，形状坏＝明确抛错不吞）。
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
      throw new SupplierRequestError("video-post-production: edit_video 的区段或改动描述非法。", 400);
    }
    return { mode: "edit_video", source, startSeconds, endSeconds, instruction };
  }
  throw new SupplierRequestError(`video-post-production: 未知 mode "${String(candidate.mode)}"。`, 400);
}