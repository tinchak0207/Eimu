/**
 * 一键超分档位契约（P1-4／对称差 D10「一键超分到 4K」）。
 *
 * ── 对标来源（唯一口径）────────────────────────────────────────────────────
 * `Dramagic对称差-全站-0928.md` 第 95 行 D10：对手一键超分到 4K（档位 720P／1080P／
 * 2K／4K）；我方有 `upscale`（`PIXAI_UPSCALE`）＋`upscale_audit`，**无 4K 超分产品动线**。
 * 决策表（`Dramagic对称差-决策表-0928.md` P1-4）裁定逐字：「**做**：一键超分＋**开到 4K**」。
 *
 * ── 与对手档位的差异（照它形，能更好才更好，差异写明）──────────────────────
 * 对手列 4 档「720P／1080P／2K／4K」，我方列 3 档「1K／2K／4K」。**不是漏做 720P**：
 * 我方档位的基底尺寸唯一来自上游 `RATIO_SIZES`（只有 `1k`／`2k` 两个键），
 * 加一个 `720p` 键＝送出后被 `app.py:232` 静默回退 1k（＝卖 720P 拿 1K），
 * 那就违反本档第一原则（不制造假的档位）。因此档位面以「真实可表达的基底 × factor」为准，
 * 最低档是 1K（门槛 1024px）；要补 720P 得先在上游长出对应尺寸键，属于上游能力，不是本站改标签能解决的。
 *
 * ── 上游真相（本档所有数字的唯一来源，2026-09-29 逐行实查）─────────────────
 * 上游链：站点路由 → VPS pixai-bridge → PixAI GraphQL `createGenerationTask`。
 *   `/opt/pixai-bridge/server.py:127` `POST /v1/upscale`（FastAPI，无 body 上限）
 *   → `/opt/pixai-bridge/app.py:347-353` `handle_upscale`：只读
 *     `{image, factor, ratio, size}`，`opts = {mediaId: image, upscale: factor, ratio, size}`
 *   → `app.py:230-232`（`resolve_gen_params`）：
 *       `if ratio not in RATIO_SIZES: ratio = "1:1"`
 *       `w, h = RATIO_SIZES[ratio].get(size, RATIO_SIZES[ratio]["1k"])`
 *   → `app.py:251-252`：`if opts["upscale"]: params["upscale"] = int(opts["upscale"])`
 *   → `pixai_pool/pixai_client.py:177-178`：`upscale` 进 `createGenerationTask` parameters。
 *
 * **RATIO_SIZES（`app.py:171-179`）只有 `"1k"` 与 `"2k"` 两个键** ⇒ `size` 传任何其他值
 * （**含 `"4k"`**）不报错，**静默回退到 1k**。这正是本刀最容易被做假的一格：
 * 把 `"4k"` 当 `size` 送上去＝卖 4K 拿 1K。本档把这条变成**有名字的闸**
 * （`assertUpscaleBridgeSizeSupported`，具名码 `upscale_bridge_size_unsupported`）。
 * 我方原程式 `const size = body.size === "2k" ? "2k" : "1k"` 之所以「没事」，只是它刚好
 * 没把 `"4k"` 漏出去；同时它也让 `size:"4k"` 的请求**静默降级成 1k**（没有任何错误码）。
 *
 * ⇒ 4K 只能靠 **基底 2k × factor** 抵达（`factor` 是唯一能把长边推上去的旋钮）。
 * 本档的档位契约因此是「(bridge size, factor) 参数对 ＋ 由真实比例表算出的长边保证」，
 * 不是把一个字串塞进枚举。
 *
 * ── 诚实边界（禁止宣称未验证的成功）───────────────────────────────────────
 * 已由源码证实：`size:"2k"` 在白名单内（无回退）、`factor` 逐值转 int 后送上游。
 * **未经真单校准**：① PixAI 是否接受 `upscale=4`（是否 clamp／拒收）；② 输出像素是否
 * 等于 `基底 × factor`（`upgrade` 语义的另一种读法是「以来源媒体为基」）。两者都会影响
 * 「用户是否真的拿到 ≥3840px」——若②不成立，就会变成付费买到 2K 标成 4K 的假交付。
 * 因此 `4k` 档位默认 **fail-closed**（具名码 `upscale_4k_upstream_unverified`），
 * 由 env `UPSCALE_4K_UPSTREAM=1` 在校准后开启（同 P1-3 `VIDEO_POST_PRODUCTION_UPSTREAM` 手法）。
 * 未开启时 `/v1/models` 的能力投射也只宣告真正可提交的档位（不卖未校准档位）。
 *
 * 本档是**叶模组**：不 import catalog（只用 type-only import）、不 import DB／node 内建，
 * 因此可被 `generation-model-catalog/capabilities.ts` 安全引用（无循环、不污染 client bundle）。
 *
 * ── 后端换血（2026-09-30 暴君指令「4k超分可以走 gpt image 2 执行超分」）───────────
 * PixAI 渠道当日已死（站点风控）⇒ 上面的 `(size, factor)` 参数化只描述 **legacy 后端**
 * （`/v1/upscale` 未设 `UPSCALE_BACKEND` 时的预设），它现在只会回 502。
 * 新后端（控面设 `UPSCALE_BACKEND=gpt-image-2`，实作在 `/v1/upscale`）是 **gpt-image-2
 * 生成式重绘**：档位＝提交 `resolution`、比例＝模型已宣告的可提交比例，上游变体名即
 * `firefly-gpt-image-{resolution}-{ratio}`（`generation-core/adobe2api-upstream.ts:82`）。
 * **语义差别要说清楚**：不是保真像素放大，是重新绘制（内容可能被模型重画）。
 *
 * 这里的**档位门槛**与 fail-closed 政策原样留用（4K 未校准前不贩售），但注意
 * `minOutputLongEdgePx`／`maxOutputLongEdgePx` 是 **PixAI 比例表推出来的 legacy 保证值**，
 * **不可当新后端的保证**：新后端的真实输出尺寸只能以实测 `data[].width/height` 为准，
 * 因此 4K 在新后端上同样 fail-closed（`upscale_4k_upstream_unverified`），
 * 直到有一次真单量到长边 ≥3840px 为止。
 */

import type { UpscaleTier } from "../generation-model-catalog/types";

export type { UpscaleTier };

/** bridge `size` 参数的真实白名单（`app.py:171-179` 的 `RATIO_SIZES` 键集，逐字）。 */
export const UPSCALE_BRIDGE_SIZES = ["1k", "2k"] as const;
export type UpscaleBridgeSize = (typeof UPSCALE_BRIDGE_SIZES)[number];

/** 档位全集（＝产品契约；实际可提交与否由 `servableUpscaleTiers` 判定）。 */
export const UPSCALE_TIERS = ["1k", "2k", "4k"] as const satisfies readonly UpscaleTier[];

/**
 * 上游比例→尺寸表，**逐字转录** `/opt/pixai-bridge/app.py:171-179`（2026-09-29 实查）。
 * 这是「4K 保证值」唯一的推导来源（禁止手写长边数字）。
 * 注意语义：`RATIO_SIZES[ratio].get(size, RATIO_SIZES[ratio]["1k"])` ⇒ 未知 size 回 1k。
 */
export const PIXAI_BRIDGE_UPSCALE_RATIO_SIZES: Readonly<
  Record<string, Readonly<Record<UpscaleBridgeSize, readonly [number, number]>>>
> = {
  "1:1": { "1k": [768, 768], "2k": [1152, 1152] },
  "3:2": { "1k": [1152, 768], "2k": [1728, 1152] },
  "2:3": { "1k": [768, 1152], "2k": [1152, 1728] },
  "9:16": { "1k": [768, 1365], "2k": [1152, 2048] },
  "16:9": { "1k": [1365, 768], "2k": [2048, 1152] },
  "4:3": { "1k": [1024, 768], "2k": [1536, 1152] },
  "3:4": { "1k": [768, 1024], "2k": [1152, 1536] },
};

const UPSCALE_SOURCE =
  "/opt/pixai-bridge/app.py:171-179 (RATIO_SIZES) + :230-232 (size→w/h) + :251-252 (upscale→int)，2026-09-29 独读实查";

/**
 * 档位的「输出长边保证」。输入＝真实比例表的两个端点，乘上 factor 后取极值，
 * 所以 `minOutputLongEdgePx` 是**跨全部 7 个比例的保底值**（最坏情况也不会低于门槛）。
 */
function longEdgeBounds(bridgeSize: UpscaleBridgeSize): { min: number; max: number } {
  const edges = Object.values(PIXAI_BRIDGE_UPSCALE_RATIO_SIZES).map((row) => Math.max(row[bridgeSize][0], row[bridgeSize][1]));
  return { min: Math.min(...edges), max: Math.max(...edges) };
}

export type UpscaleUpstreamSemantics =
  /** `size` 在 bridge 白名单内＋`factor` 为历来唯一在用值，逐值可查。 */
  | "upstream-parameter-verified-semantics-unverified"
  /** factor 值零现场证据（PixAI 是否收、是否 clamp 未知）⇒ 未校准。 */
  | "upstream-factor-unverified";

export interface UpscaleTierContract {
  tier: UpscaleTier;
  /** 送给 bridge 的 `size`（恒在白名单内；4K 档位送的是 `2k`，靠 factor 推上去）。 */
  bridgeSize: UpscaleBridgeSize;
  /** 送给 bridge 的 `factor`（bridge 逐值转 int 后进 PixAI `createGenerationTask.upscale`）。 */
  factor: number;
  /** 该档位的长边门槛（1k=1024、2k=2048、4k=3840 UHD）。 */
  thresholdPx: number;
  /** 保底输出长边（跨真实比例表最坏情况）。 */
  minOutputLongEdgePx: number;
  /** 上限输出长边（跨真实比例表最佳情况）。 */
  maxOutputLongEdgePx: number;
  semantics: UpscaleUpstreamSemantics;
  source: string;
}

function tierContract(
  tier: UpscaleTier,
  bridgeSize: UpscaleBridgeSize,
  factor: number,
  thresholdPx: number,
  semantics: UpscaleUpstreamSemantics,
): UpscaleTierContract {
  const bounds = longEdgeBounds(bridgeSize);
  return {
    tier,
    bridgeSize,
    factor,
    thresholdPx,
    minOutputLongEdgePx: bounds.min * factor,
    maxOutputLongEdgePx: bounds.max * factor,
    semantics,
    source: `${UPSCALE_SOURCE}；size="${bridgeSize}"、factor=${factor} ⇒ 长边 ${bounds.min * factor}–${bounds.max * factor}px（门槛 ${thresholdPx}）`,
  };
}

export const UPSCALE_TIER_CONTRACTS: Readonly<Record<UpscaleTier, UpscaleTierContract>> = {
  // 1k／2k：size 在白名单、factor=2 是历来唯一在用值（前端 runUpscale 固定 factor 2）。
  "1k": tierContract("1k", "1k", 2, 1024, "upstream-parameter-verified-semantics-unverified"),
  "2k": tierContract("2k", "2k", 2, 2048, "upstream-parameter-verified-semantics-unverified"),
  // 4k：尺寸靠 2k 基底 ×factor 4 保证 ≥4608px；factor=4 零现场证据 ⇒ 未校准。
  "4k": tierContract("4k", "2k", 4, 3840, "upstream-factor-unverified"),
};

/** 档位的输出长边门槛（对外可引用的单一真源）。 */
export const UPSCALE_TIER_THRESHOLDS_PX: Readonly<Record<UpscaleTier, number>> = {
  "1k": UPSCALE_TIER_CONTRACTS["1k"].thresholdPx,
  "2k": UPSCALE_TIER_CONTRACTS["2k"].thresholdPx,
  "4k": UPSCALE_TIER_CONTRACTS["4k"].thresholdPx,
};

// ── 体积上限（与既有上限同源；4K 的输入／输出体积必须与它们一致）─────────────
//
// 输入：C 端 `/api/pixai/upscale` → `/image-control/v1/upscale`，边缘是
//   `imagesite-nginx` 的 `location ^~ /image-control/`（宿主 `default.conf:368-383`），
//   `client_max_body_size 25m`（`default.conf:382`）⇒ 请求体（含 base64 输入图）>25MiB
//   在 nginx 就被 413 挡下。这是我方真实的**请求体**上限，故超分输入以此为界。
// 输出：平台要把上游结果抓回本地校验／落库时的真实硬上限＝
//   `generation-core/artifact-service.ts` 的 `ARTIFACT_MAX_DOWNLOAD_BYTES`（25 MiB）。
//   两者同值但约束不同，故各自具名；一致性由测试钉住（禁静默漂移）。
export const UPSCALE_INPUT_MAX_BYTES = 25 * 1024 * 1024;
export const UPSCALE_OUTPUT_MAX_BYTES = 25 * 1024 * 1024;
export const UPSCALE_INPUT_MAX_BYTES_SOURCE =
  "imagesite-nginx /opt/imagesite/nginx/conf.d/default.conf:382 (location ^~ /image-control/ client_max_body_size 25m)";
export const UPSCALE_OUTPUT_MAX_BYTES_SOURCE =
  "generation-core/artifact-service.ts ARTIFACT_MAX_DOWNLOAD_BYTES (上游结果抓回的单档硬上限)";

// ── 具名错误码（规格要求：不支援必须具名拒绝，不得静默降级）───────────────────

export type UpscaleTierErrorCode =
  | "upscale_image_missing"
  | "upscale_media_kind_unsupported"
  | "upscale_video_upstream_unsupported"
  | "upscale_tier_unsupported"
  | "upscale_tier_not_declared_by_model"
  | "upscale_4k_upstream_unverified"
  | "upscale_bridge_size_unsupported"
  | "upscale_factor_conflict"
  | "upscale_input_too_large"
  | "upscale_output_too_large";

export class UpscaleTierError extends Error {
  constructor(
    readonly code: UpscaleTierErrorCode,
    message: string,
    /** 路由直接拿去回 HTTP 状态；400＝确定性输入错误，413＝体积超限（皆不重放、不烧钱）。 */
    readonly status: number = 400,
  ) {
    super(message);
    this.name = "UpscaleTierError";
  }
}

// ── 档位可用性（4K 未校准 ⇒ 默认 fail-closed，env 开关在校准后开启）──────────

/**
 * 4K 上游语义是否已由真单校准。默认关闭：`factor=4` 零现场证据，
 * 未知值被上游静默忽略／降级的风险已在 P1-3 的 `VIDEO_POST_PRODUCTION_UPSTREAM` 上吃过一次。
 */
export function upscaleFourKUpstreamEnabled(): boolean {
  const value = (process.env.UPSCALE_4K_UPSTREAM ?? "").trim().toLowerCase();
  return value === "1" || value === "true";
}

/** 档位是否可提交：白名单内＋上游语义已校准。 */
export function isUpscaleTierServable(tier: UpscaleTier): boolean {
  const contract = UPSCALE_TIER_CONTRACTS[tier];
  if (contract.semantics === "upstream-factor-unverified") return upscaleFourKUpstreamEnabled();
  return true;
}

/** 可提交档位（声明序）。`declared` 省略＝以档位全集为声明面。 */
export function servableUpscaleTiers(declared: readonly UpscaleTier[] = UPSCALE_TIERS): readonly UpscaleTier[] {
  return declared.filter(isUpscaleTierServable);
}

/** 一键预设档位＝最高可提交档位（4K 校准开启后免改码自动变 4K，这就是「一键超分到 4K」）。 */
export function defaultUpscaleTier(declared: readonly UpscaleTier[] = UPSCALE_TIERS): UpscaleTier {
  const servable = servableUpscaleTiers(declared);
  return servable.length ? servable[servable.length - 1] : "1k";
}

// ── 输入解析 ────────────────────────────────────────────────────────────────

export type UpscaleSizeInterpretation =
  /** 档位字串（`"2k"`／`"4k"`…）；B 端 `/v1/upscale` 的 `size` 语义。 */
  | { kind: "tier"; tier: UpscaleTier; raw: string }
  /** 像素尺寸 `"WxH"`；C 端 `runUpscale` 传的是**原图**尺寸，只用于计费，不是档位。 */
  | { kind: "pixels"; width: number; height: number; raw: string }
  | { kind: "empty" }
  | { kind: "unknown"; raw: string };

const TIER_BY_LOWER = new Map<string, UpscaleTier>(UPSCALE_TIERS.map((tier) => [tier, tier]));

/**
 * `size` 在两个入口有**两种语义**（B 端＝档位、C 端＝原图像素），
 * 这里一次讲清楚，避免把 `"1024x1024"` 当档位或把 `"4k"` 当像素。
 */
export function interpretUpscaleSize(value: unknown): UpscaleSizeInterpretation {
  const raw = typeof value === "string" ? value.trim() : "";
  if (!raw) return { kind: "empty" };
  const pixelMatch = /^(\d{1,5})\s*[x×]\s*(\d{1,5})$/i.exec(raw);
  if (pixelMatch) {
    const width = Number(pixelMatch[1]);
    const height = Number(pixelMatch[2]);
    if (width > 0 && height > 0) return { kind: "pixels", width, height, raw };
  }
  const tier = TIER_BY_LOWER.get(raw.toLowerCase());
  if (tier) return { kind: "tier", tier, raw };
  return { kind: "unknown", raw };
}

/**
 * bridge `size` 送出前的硬闸：白名单外（**尤其 `"4k"`**）一律具名拒收。
 * 为什么不可放行：`app.py:232` 对未知 size **静默回退 1k**——放行等于卖 4K 拿 1K。
 */
export function assertUpscaleBridgeSizeSupported(size: unknown): UpscaleBridgeSize {
  const raw = typeof size === "string" ? size.trim() : "";
  if ((UPSCALE_BRIDGE_SIZES as readonly string[]).includes(raw)) return raw as UpscaleBridgeSize;
  throw new UpscaleTierError(
    "upscale_bridge_size_unsupported",
    `bridge size "${raw}" 不在上游白名单 ${UPSCALE_BRIDGE_SIZES.join("／")}`
      + `——上游对未知 size 会静默回退 1k（${UPSCALE_SOURCE}），放行即售假，故拒收。`
      + `4K 要用档位契约的 (size="2k", factor=4) 表达。`,
  );
}

export type UpscaleTierResolution =
  | {
    ok: true;
    tier: UpscaleTier;
    bridgeSize: UpscaleBridgeSize;
    factor: number;
    thresholdPx: number;
    minOutputLongEdgePx: number;
    maxOutputLongEdgePx: number;
    semantics: UpscaleUpstreamSemantics;
    source: string;
    /** true＝请求未指定档位，走了「一键」预设。 */
    defaulted: boolean;
  }
  | { ok: false; code: UpscaleTierErrorCode; message: string; status: number };

function tierResolution(tier: UpscaleTier, defaulted: boolean): UpscaleTierResolution {
  const contract = UPSCALE_TIER_CONTRACTS[tier];
  return {
    ok: true,
    tier,
    bridgeSize: contract.bridgeSize,
    factor: contract.factor,
    thresholdPx: contract.thresholdPx,
    minOutputLongEdgePx: contract.minOutputLongEdgePx,
    maxOutputLongEdgePx: contract.maxOutputLongEdgePx,
    semantics: contract.semantics,
    source: contract.source,
    defaulted,
  };
}

/**
 * 档位解析（**唯一入口**）：未指定 → 一键预设（最高可提交）；未知 → 具名拒；
 * 未校准 → 具名拒（**不静默降级、不静默升格**）。
 */
export function resolveUpscaleTier(
  requested?: unknown,
  declared: readonly UpscaleTier[] = UPSCALE_TIERS,
): UpscaleTierResolution {
  const interpreted = interpretUpscaleSize(requested);
  if (interpreted.kind === "pixels") {
    return tierResolution(defaultUpscaleTier(declared), true);
  }
  if (interpreted.kind === "empty") {
    return tierResolution(defaultUpscaleTier(declared), true);
  }
  if (interpreted.kind === "unknown") {
    return {
      ok: false,
      code: "upscale_tier_unsupported",
      status: 400,
      message: `不支援的超分档位 "${interpreted.raw}"（可用档位：${declared.join("／")}；像素尺寸写法如 "1024x1024" 只作计费提示）。`,
    };
  }
  const contract = UPSCALE_TIER_CONTRACTS[interpreted.tier];
  if (contract.semantics === "upstream-factor-unverified" && !upscaleFourKUpstreamEnabled()) {
    return {
      ok: false,
      code: "upscale_4k_upstream_unverified",
      status: 400,
      message: `档位 ${interpreted.tier} 的上游参数化已备（size="${contract.bridgeSize}"、factor=${contract.factor}、`
        + `保底长边 ${contract.minOutputLongEdgePx}px），但 factor 的输出色语义尚未由真单校准`
        + `（semantics=${contract.semantics}）；为避免「付费买到 2K 标成 4K」的假交付，本次拒绝提交。`
        + `校准后设 UPSCALE_4K_UPSTREAM=1 开启。`,
    };
  }
  return tierResolution(interpreted.tier, false);
}

// ── 体积 ────────────────────────────────────────────────────────────────────

/**
 * 量测超分输入的位元组数：`data:` URL 可解码实测；http(s) URL 是上游自取 →
 * 回 null（**未知不回 0**，避免「以 0 冒充实测值」）。非字串／其他形状回 null。
 */
export function measureUpscaleInputBytes(image: unknown): number | null {
  if (typeof image !== "string") return null;
  const match = /^data:([^;,]*);base64,([\s\S]*)$/i.exec(image.trim());
  if (!match) return null;
  const payload = match[2].replace(/\s+/g, "");
  if (!payload) return 0;
  // base64 长度→位元组：每 4 字元 3 位元组，扣除 padding。
  const padding = payload.endsWith("==") ? 2 : payload.endsWith("=") ? 1 : 0;
  return Math.max(0, Math.floor((payload.length * 3) / 4) - padding);
}

export function assertUpscaleInputWithinLimits(input: { image: unknown; declaredBytes?: number | null }): number | null {
  const measured = typeof input.declaredBytes === "number" && Number.isFinite(input.declaredBytes)
    ? input.declaredBytes
    : measureUpscaleInputBytes(input.image);
  if (measured === null) return null;
  if (measured > UPSCALE_INPUT_MAX_BYTES) {
    throw new UpscaleTierError(
      "upscale_input_too_large",
      `超分输入 ${measured} bytes 超出上限 ${UPSCALE_INPUT_MAX_BYTES}（来源：${UPSCALE_INPUT_MAX_BYTES_SOURCE}）。`,
      413,
    );
  }
  return measured;
}

export function assertUpscaleOutputWithinLimits(bytes: number): void {
  if (!Number.isFinite(bytes) || bytes < 0) {
    throw new UpscaleTierError("upscale_output_too_large", `超分输出体积 ${String(bytes)} 不是有效位元组数。`, 400);
  }
  if (bytes > UPSCALE_OUTPUT_MAX_BYTES) {
    throw new UpscaleTierError(
      "upscale_output_too_large",
      `超分输出 ${bytes} bytes 超出上限 ${UPSCALE_OUTPUT_MAX_BYTES}（来源：${UPSCALE_OUTPUT_MAX_BYTES_SOURCE}）。`,
      413,
    );
  }
}

// ── 一键提交解析（两个入口共用：B 端 /v1/upscale、C 端 /api/pixai/upscale）────

export interface NormalizedUpscaleSubmission {
  image: string;
  tier: UpscaleTier;
  /** 送 bridge 的 `size`（恒在白名单内）。 */
  bridgeSize: UpscaleBridgeSize;
  /** 送 bridge 的 `factor`。 */
  factor: number;
  /** 呼叫端自带的**原图像素尺寸**（C 端计费提示）；无则 null。 */
  requestedPixelSize: { width: number; height: number } | null;
  /** 量到的输入位元组（http(s) 输入回 null＝未量测）。 */
  inputBytes: number | null;
  minOutputLongEdgePx: number;
  maxOutputLongEdgePx: number;
  semantics: UpscaleUpstreamSemantics;
  source: string;
  /** true＝档位由「一键」预设带入。 */
  defaultedTier: boolean;
}

function readAliased(source: Record<string, unknown>, ...keys: string[]): unknown {
  for (const key of keys) {
    if (source[key] !== undefined && source[key] !== null) return source[key];
  }
  return undefined;
}

/** 读倍率输入（`factor`／`upscale`／`scale`）；缺省回 null，非法（NaN）回 NaN 让上层拒。 */
function readFactor(value: unknown): number | null {
  if (value === undefined || value === null || value === "") return null;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : Number.NaN;
}

/**
 * 倍率→档位：找 factor 相符的档位，取**最高**者（factor=4 只有 4k；factor=2 取 2k）。
 * 找不到（3／1／100 这种没有档位卖的倍率）回 null ⇒ 具名拒，**不把任意倍率丢给上游**。
 */
function tierForFactor(factor: number): UpscaleTier | null {
  const matches = UPSCALE_TIERS.filter((tier) => UPSCALE_TIER_CONTRACTS[tier].factor === factor);
  return matches.length ? matches[matches.length - 1] : null;
}

/**
 * 旧呼叫端同时带 `size` 与 `factor` 时的语义（MCP `upscale` 工具就广告 factor 1–4、
 * size 1k／2k）：`size` 是**基底档**、`factor` 是**倍率**，两者合起来正好就是档位契约的
 * `(bridgeSize, factor)` 参数对。所以先按这一对**精确配对档位**：
 *   ("1k",2)⇒1k、("2k",2)⇒2k、("2k",4)⇒**4k**（＝旧的 4 倍路径被正名成 4K 档位，再过闸）。
 * 配不到＝没有这个产品档位（如 ("1k",4) 的 3 倍级中间态）⇒ 具名拒，不静默改成别的档位。
 */
function tierForLegacyPair(baseTier: UpscaleTier, factor: number): UpscaleTier | null {
  const base = UPSCALE_TIER_CONTRACTS[baseTier];
  return UPSCALE_TIERS.find(
    (tier) => UPSCALE_TIER_CONTRACTS[tier].bridgeSize === base.bridgeSize && UPSCALE_TIER_CONTRACTS[tier].factor === factor,
  ) ?? null;
}

/**
 * 「一键」＝不需要逐步配置：档位可省（走最高可提交档位）、factor 由档位契约决定。
 * 旧呼叫端（MCP `upscale` 工具广告 factor 1–4 ＋ size 1k／2k）也吃得下：`(size, factor)`
 * 会被精确配对到档位（(`2k`,4)⇒4k），配不到就具名拒——**绝不把任意倍率丢给上游，也绝不
 * 把显式档位静默改掉**。
 *
 * 检查顺序刻意由便宜到贵、由确定到不确定：输入形状 → 媒体种类 → 档位 → 响应模型宣告 → 体积。
 */
export function resolveUpscaleSubmission(options: {
  /** 该平台模型能力宣告的档位（＝catalog `upscaleTiers`；缺省＝全集）。 */
  declaredTiers?: readonly UpscaleTier[];
  input: unknown;
  modelId?: string;
}): NormalizedUpscaleSubmission {
  const declared = options.declaredTiers ?? UPSCALE_TIERS;
  const raw = (options.input && typeof options.input === "object" && !Array.isArray(options.input))
    ? options.input as Record<string, unknown>
    : {};

  const image = typeof raw.image === "string" ? raw.image.trim() : "";
  if (!image) {
    throw new UpscaleTierError("upscale_image_missing", "缺少待超分图像：需要 image（公网 URL、mediaId 或 data: base64）。");
  }

  const mediaKind = String(readAliased(raw, "mediaKind", "media_kind", "mediaType", "media_type", "kind", "type") ?? "")
    .trim()
    .toLowerCase();
  if (mediaKind === "video" || mediaKind === "mp4" || mediaKind === "webm") {
    throw new UpscaleTierError(
      "upscale_video_upstream_unsupported",
      "视频超分在上游无可用通道：pixai-bridge /v1/upscale 只做图像（PixAI 图像放大链），"
        + "我方没有任何视频超分上游（对称差 D10 的 720P／1080P／2K／4K 视频档位因而无对应通道）——本平台不做假交付，故拒收。",
    );
  }
  if (mediaKind === "audio") {
    throw new UpscaleTierError("upscale_media_kind_unsupported", `超分仅支援图像，收到媒体种类 "${mediaKind}"。`);
  }

  // ── 档位解析（语义优先序，禁静默降级）─────────────────────────────────────
  // ① 显式档位键（upscale_tier／tier／output_resolution）：档位说话；同时给了不同的
  //    factor ＝呼叫端自相矛盾 ⇒ 具名拒（不得把 4k 悄悄改成 2k）。
  // ② 旧 `size` 键：B 端是桥的**基底档**语义（1k／2k），与 factor 合起来精确配对档位
  //    （(`2k`,4)⇒4k）；C 端是原图 `WxH`（只作计费提示，不当档位）。
  // ③ 只给 factor：以倍率选档位（4⇒4k、2⇒2k），没有档位贩售该倍率 ⇒ 具名拒。
  // ④ 什么都没给：一键预设＝最高可提交档位。
  const explicitTier = interpretUpscaleSize(
    readAliased(raw, "upscaleTier", "upscale_tier", "tier", "outputResolution", "output_resolution"),
  );
  const sizeInterpretation = interpretUpscaleSize(raw.size);
  const requestedFactor = readFactor(readAliased(raw, "factor", "upscale", "scale"));
  const factorLabel = String(readAliased(raw, "factor", "upscale", "scale") ?? "");

  const conflict = (message: string): never => {
    throw new UpscaleTierError("upscale_factor_conflict", message);
  };
  const contractSummary = UPSCALE_TIERS
    .map((tier) => `${tier}=size"${UPSCALE_TIER_CONTRACTS[tier].bridgeSize}"×${UPSCALE_TIER_CONTRACTS[tier].factor}`)
    .join("、");

  let resolution: UpscaleTierResolution;
  if (explicitTier.kind === "tier") {
    const contract = UPSCALE_TIER_CONTRACTS[explicitTier.tier];
    if (requestedFactor !== null && requestedFactor !== contract.factor) {
      conflict(
        `档位 ${explicitTier.tier} 固定 factor=${contract.factor}，与同时给的 factor=${factorLabel} 矛盾（档位契约：${contractSummary}）。`,
      );
    }
    resolution = resolveUpscaleTier(explicitTier.tier, declared);
  } else if (explicitTier.kind === "unknown") {
    resolution = resolveUpscaleTier(explicitTier.raw, declared);
  } else if (sizeInterpretation.kind === "tier") {
    if (requestedFactor !== null) {
      const paired = Number.isFinite(requestedFactor) ? tierForLegacyPair(sizeInterpretation.tier, requestedFactor) : null;
      if (!paired) {
        conflict(
          `(size="${sizeInterpretation.raw}", factor=${factorLabel}) 不是本平台贩售的档位组合（档位契约：${contractSummary}）。`,
        );
      }
      resolution = resolveUpscaleTier(paired, declared);
    } else {
      resolution = resolveUpscaleTier(sizeInterpretation.tier, declared);
    }
  } else if (sizeInterpretation.kind === "unknown") {
    resolution = resolveUpscaleTier(sizeInterpretation.raw, declared);
  } else if (requestedFactor !== null) {
    const byFactor = Number.isFinite(requestedFactor) ? tierForFactor(requestedFactor) : null;
    if (!byFactor) {
      conflict(
        `factor=${factorLabel} 没有任何档位贩售此倍率（合法倍率：`
          + `${[...new Set(UPSCALE_TIERS.map((tier) => UPSCALE_TIER_CONTRACTS[tier].factor))].sort((a, b) => a - b).join("／")}；档位契约：${contractSummary}）。`,
      );
    }
    resolution = resolveUpscaleTier(byFactor, declared);
  } else {
    resolution = resolveUpscaleTier(undefined, declared);
  }
  if (!resolution.ok) throw new UpscaleTierError(resolution.code, resolution.message, resolution.status);

  if (!declared.includes(resolution.tier)) {
    throw new UpscaleTierError(
      "upscale_tier_not_declared_by_model",
      `模型 ${options.modelId ?? "(unknown)"} 的能力宣告不含档位 ${resolution.tier}（已宣告：${declared.join("／")}）——未宣告即不许提交。`,
    );
  }

  const inputBytes = assertUpscaleInputWithinLimits({ image });
  const pixelSize = interpretUpscaleSize(readAliased(raw, "sourceSize", "source_size", "pixelSize", "pixel_size", "size"));

  return {
    image,
    tier: resolution.tier,
    bridgeSize: resolution.bridgeSize,
    factor: resolution.factor,
    requestedPixelSize: pixelSize.kind === "pixels" ? { width: pixelSize.width, height: pixelSize.height } : null,
    inputBytes,
    minOutputLongEdgePx: resolution.minOutputLongEdgePx,
    maxOutputLongEdgePx: resolution.maxOutputLongEdgePx,
    semantics: resolution.semantics,
    source: resolution.source,
    defaultedTier: resolution.defaulted,
  };
}

/**
 * 档位契约的自检（测试与运维共用；不在模组载入时抛，避免部署期炸站）。
 * 回问题清单：空＝契约自洽（每个档位的保底长边都真的达到自己的门槛）。
 */
export function upscaleTierContractViolations(): string[] {
  const violations: string[] = [];
  for (const tier of UPSCALE_TIERS) {
    const contract = UPSCALE_TIER_CONTRACTS[tier];
    if (contract.minOutputLongEdgePx < contract.thresholdPx) {
      violations.push(
        `档位 ${tier} 的保底长边 ${contract.minOutputLongEdgePx}px 低于门槛 ${contract.thresholdPx}px`
          + `（最低比例下的输出其实到不了该档位）。`,
      );
    }
    if (!(UPSCALE_BRIDGE_SIZES as readonly string[]).includes(contract.bridgeSize)) {
      violations.push(`档位 ${tier} 的 bridgeSize "${contract.bridgeSize}" 不在上游白名单 ${UPSCALE_BRIDGE_SIZES.join("／")}。`);
    }
  }
  return violations;
}