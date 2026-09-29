/**
 * 一鍵超分檔位契約（P1-4／對稱差 D10「一鍵超分到 4K」）。
 *
 * ── 對標來源（唯一口徑）────────────────────────────────────────────────────
 * `Dramagic對稱差-全站-0928.md` 第 95 行 D10：對手一鍵超分到 4K（檔位 720P／1080P／
 * 2K／4K）；我方有 `upscale`（`PIXAI_UPSCALE`）＋`upscale_audit`，**無 4K 超分產品動線**。
 * 決策表（`Dramagic對稱差-決策表-0928.md` P1-4）裁定逐字：「**做**：一鍵超分＋**開到 4K**」。
 *
 * ── 與對手檔位的差異（照它形，能更好才更好，差異寫明）──────────────────────
 * 對手列 4 檔「720P／1080P／2K／4K」，我方列 3 檔「1K／2K／4K」。**不是漏做 720P**：
 * 我方檔位的基底尺寸唯一來自上游 `RATIO_SIZES`（只有 `1k`／`2k` 兩個鍵），
 * 加一個 `720p` 鍵＝送出後被 `app.py:232` 靜默回退 1k（＝賣 720P 拿 1K），
 * 那就違反本檔第一原則（不製造假的檔位）。因此檔位面以「真實可表達的基底 × factor」為準，
 * 最低檔是 1K（門檻 1024px）；要補 720P 得先在上游長出對應尺寸鍵，屬於上游能力，不是本站改標籤能解決的。
 *
 * ── 上游真相（本檔所有數字的唯一來源，2026-09-29 逐行實查）─────────────────
 * 上游鏈：站點路由 → VPS pixai-bridge → PixAI GraphQL `createGenerationTask`。
 *   `/opt/pixai-bridge/server.py:127` `POST /v1/upscale`（FastAPI，無 body 上限）
 *   → `/opt/pixai-bridge/app.py:347-353` `handle_upscale`：只讀
 *     `{image, factor, ratio, size}`，`opts = {mediaId: image, upscale: factor, ratio, size}`
 *   → `app.py:230-232`（`resolve_gen_params`）：
 *       `if ratio not in RATIO_SIZES: ratio = "1:1"`
 *       `w, h = RATIO_SIZES[ratio].get(size, RATIO_SIZES[ratio]["1k"])`
 *   → `app.py:251-252`：`if opts["upscale"]: params["upscale"] = int(opts["upscale"])`
 *   → `pixai_pool/pixai_client.py:177-178`：`upscale` 進 `createGenerationTask` parameters。
 *
 * **RATIO_SIZES（`app.py:171-179`）只有 `"1k"` 與 `"2k"` 兩個鍵** ⇒ `size` 傳任何其他值
 * （**含 `"4k"`**）不報錯，**靜默回退到 1k**。這正是本刀最容易被做假的一格：
 * 把 `"4k"` 當 `size` 送上去＝賣 4K 拿 1K。本檔把這條變成**有名字的閘**
 * （`assertUpscaleBridgeSizeSupported`，具名碼 `upscale_bridge_size_unsupported`）。
 * 我方原程式 `const size = body.size === "2k" ? "2k" : "1k"` 之所以「沒事」，只是它剛好
 * 沒把 `"4k"` 漏出去；同時它也讓 `size:"4k"` 的請求**靜默降級成 1k**（沒有任何錯誤碼）。
 *
 * ⇒ 4K 只能靠 **基底 2k × factor** 抵達（`factor` 是唯一能把長邊推上去的旋鈕）。
 * 本檔的檔位契約因此是「(bridge size, factor) 參數對 ＋ 由真實比例表算出的長邊保證」，
 * 不是把一個字串塞進枚舉。
 *
 * ── 誠實邊界（禁止宣稱未驗證的成功）───────────────────────────────────────
 * 已由源碼證實：`size:"2k"` 在白名單內（無回退）、`factor` 逐值轉 int 後送上游。
 * **未經真單校準**：① PixAI 是否接受 `upscale=4`（是否 clamp／拒收）；② 輸出像素是否
 * 等於 `基底 × factor`（`upgrade` 語義的另一種讀法是「以來源媒體為基」）。兩者都會影響
 * 「用戶是否真的拿到 ≥3840px」——若②不成立，就會變成付費買到 2K 標成 4K 的假交付。
 * 因此 `4k` 檔位默認 **fail-closed**（具名碼 `upscale_4k_upstream_unverified`），
 * 由 env `UPSCALE_4K_UPSTREAM=1` 在校準後開啟（同 P1-3 `VIDEO_POST_PRODUCTION_UPSTREAM` 手法）。
 * 未開啟時 `/v1/models` 的能力投射也只宣告真正可提交的檔位（不賣未校準檔位）。
 *
 * 本檔是**葉模組**：不 import catalog（只用 type-only import）、不 import DB／node 內建，
 * 因此可被 `generation-model-catalog/capabilities.ts` 安全引用（無循環、不污染 client bundle）。
 */

import type { UpscaleTier } from "../generation-model-catalog/types";

export type { UpscaleTier };

/** bridge `size` 參數的真實白名單（`app.py:171-179` 的 `RATIO_SIZES` 鍵集，逐字）。 */
export const UPSCALE_BRIDGE_SIZES = ["1k", "2k"] as const;
export type UpscaleBridgeSize = (typeof UPSCALE_BRIDGE_SIZES)[number];

/** 檔位全集（＝產品契約；實際可提交與否由 `servableUpscaleTiers` 判定）。 */
export const UPSCALE_TIERS = ["1k", "2k", "4k"] as const satisfies readonly UpscaleTier[];

/**
 * 上游比例→尺寸表，**逐字轉錄** `/opt/pixai-bridge/app.py:171-179`（2026-09-29 實查）。
 * 這是「4K 保證值」唯一的推導來源（禁止手寫長邊數字）。
 * 注意語義：`RATIO_SIZES[ratio].get(size, RATIO_SIZES[ratio]["1k"])` ⇒ 未知 size 回 1k。
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
  "/opt/pixai-bridge/app.py:171-179 (RATIO_SIZES) + :230-232 (size→w/h) + :251-252 (upscale→int)，2026-09-29 獨讀實查";

/**
 * 檔位的「輸出長邊保證」。輸入＝真實比例表的兩個端點，乘上 factor 後取極值，
 * 所以 `minOutputLongEdgePx` 是**跨全部 7 個比例的保底值**（最壞情況也不會低於門檻）。
 */
function longEdgeBounds(bridgeSize: UpscaleBridgeSize): { min: number; max: number } {
  const edges = Object.values(PIXAI_BRIDGE_UPSCALE_RATIO_SIZES).map((row) => Math.max(row[bridgeSize][0], row[bridgeSize][1]));
  return { min: Math.min(...edges), max: Math.max(...edges) };
}

export type UpscaleUpstreamSemantics =
  /** `size` 在 bridge 白名單內＋`factor` 為歷來唯一在用值，逐值可查。 */
  | "upstream-parameter-verified-semantics-unverified"
  /** factor 值零現場證據（PixAI 是否收、是否 clamp 未知）⇒ 未校準。 */
  | "upstream-factor-unverified";

export interface UpscaleTierContract {
  tier: UpscaleTier;
  /** 送給 bridge 的 `size`（恆在白名單內；4K 檔位送的是 `2k`，靠 factor 推上去）。 */
  bridgeSize: UpscaleBridgeSize;
  /** 送給 bridge 的 `factor`（bridge 逐值轉 int 後進 PixAI `createGenerationTask.upscale`）。 */
  factor: number;
  /** 該檔位的長邊門檻（1k=1024、2k=2048、4k=3840 UHD）。 */
  thresholdPx: number;
  /** 保底輸出長邊（跨真實比例表最壞情況）。 */
  minOutputLongEdgePx: number;
  /** 上限輸出長邊（跨真實比例表最佳情況）。 */
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
    source: `${UPSCALE_SOURCE}；size="${bridgeSize}"、factor=${factor} ⇒ 長邊 ${bounds.min * factor}–${bounds.max * factor}px（門檻 ${thresholdPx}）`,
  };
}

export const UPSCALE_TIER_CONTRACTS: Readonly<Record<UpscaleTier, UpscaleTierContract>> = {
  // 1k／2k：size 在白名單、factor=2 是歷來唯一在用值（前端 runUpscale 固定 factor 2）。
  "1k": tierContract("1k", "1k", 2, 1024, "upstream-parameter-verified-semantics-unverified"),
  "2k": tierContract("2k", "2k", 2, 2048, "upstream-parameter-verified-semantics-unverified"),
  // 4k：尺寸靠 2k 基底 ×factor 4 保證 ≥4608px；factor=4 零現場證據 ⇒ 未校準。
  "4k": tierContract("4k", "2k", 4, 3840, "upstream-factor-unverified"),
};

/** 檔位的輸出長邊門檻（對外可引用的單一真源）。 */
export const UPSCALE_TIER_THRESHOLDS_PX: Readonly<Record<UpscaleTier, number>> = {
  "1k": UPSCALE_TIER_CONTRACTS["1k"].thresholdPx,
  "2k": UPSCALE_TIER_CONTRACTS["2k"].thresholdPx,
  "4k": UPSCALE_TIER_CONTRACTS["4k"].thresholdPx,
};

// ── 體積上限（與既有上限同源；4K 的輸入／輸出體積必須與它們一致）─────────────
//
// 輸入：C 端 `/api/pixai/upscale` → `/image-control/v1/upscale`，邊緣是
//   `imagesite-nginx` 的 `location ^~ /image-control/`（宿主 `default.conf:368-383`），
//   `client_max_body_size 25m`（`default.conf:382`）⇒ 請求體（含 base64 輸入圖）>25MiB
//   在 nginx 就被 413 擋下。這是我方真實的**請求體**上限，故超分輸入以此為界。
// 輸出：平台要把上游結果抓回本地校驗／落庫時的真實硬上限＝
//   `generation-core/artifact-service.ts` 的 `ARTIFACT_MAX_DOWNLOAD_BYTES`（25 MiB）。
//   兩者同值但約束不同，故各自具名；一致性由測試釘住（禁靜默漂移）。
export const UPSCALE_INPUT_MAX_BYTES = 25 * 1024 * 1024;
export const UPSCALE_OUTPUT_MAX_BYTES = 25 * 1024 * 1024;
export const UPSCALE_INPUT_MAX_BYTES_SOURCE =
  "imagesite-nginx /opt/imagesite/nginx/conf.d/default.conf:382 (location ^~ /image-control/ client_max_body_size 25m)";
export const UPSCALE_OUTPUT_MAX_BYTES_SOURCE =
  "generation-core/artifact-service.ts ARTIFACT_MAX_DOWNLOAD_BYTES (上游結果抓回的單檔硬上限)";

// ── 具名錯誤碼（規格要求：不支援必須具名拒絕，不得靜默降級）───────────────────

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
    /** 路由直接拿去回 HTTP 狀態；400＝確定性輸入錯誤，413＝體積超限（皆不重放、不燒錢）。 */
    readonly status: number = 400,
  ) {
    super(message);
    this.name = "UpscaleTierError";
  }
}

// ── 檔位可用性（4K 未校準 ⇒ 默認 fail-closed，env 開關在校準後開啟）──────────

/**
 * 4K 上游語義是否已由真單校準。默認關閉：`factor=4` 零現場證據，
 * 未知值被上游靜默忽略／降級的風險已在 P1-3 的 `VIDEO_POST_PRODUCTION_UPSTREAM` 上吃過一次。
 */
export function upscaleFourKUpstreamEnabled(): boolean {
  const value = (process.env.UPSCALE_4K_UPSTREAM ?? "").trim().toLowerCase();
  return value === "1" || value === "true";
}

/** 檔位是否可提交：白名單內＋上游語義已校準。 */
export function isUpscaleTierServable(tier: UpscaleTier): boolean {
  const contract = UPSCALE_TIER_CONTRACTS[tier];
  if (contract.semantics === "upstream-factor-unverified") return upscaleFourKUpstreamEnabled();
  return true;
}

/** 可提交檔位（聲明序）。`declared` 省略＝以檔位全集為聲明面。 */
export function servableUpscaleTiers(declared: readonly UpscaleTier[] = UPSCALE_TIERS): readonly UpscaleTier[] {
  return declared.filter(isUpscaleTierServable);
}

/** 一鍵預設檔位＝最高可提交檔位（4K 校準開啟後免改碼自動變 4K，這就是「一鍵超分到 4K」）。 */
export function defaultUpscaleTier(declared: readonly UpscaleTier[] = UPSCALE_TIERS): UpscaleTier {
  const servable = servableUpscaleTiers(declared);
  return servable.length ? servable[servable.length - 1] : "1k";
}

// ── 輸入解析 ────────────────────────────────────────────────────────────────

export type UpscaleSizeInterpretation =
  /** 檔位字串（`"2k"`／`"4k"`…）；B 端 `/v1/upscale` 的 `size` 語義。 */
  | { kind: "tier"; tier: UpscaleTier; raw: string }
  /** 像素尺寸 `"WxH"`；C 端 `runUpscale` 傳的是**原圖**尺寸，只用於計費，不是檔位。 */
  | { kind: "pixels"; width: number; height: number; raw: string }
  | { kind: "empty" }
  | { kind: "unknown"; raw: string };

const TIER_BY_LOWER = new Map<string, UpscaleTier>(UPSCALE_TIERS.map((tier) => [tier, tier]));

/**
 * `size` 在兩個入口有**兩種語義**（B 端＝檔位、C 端＝原圖像素），
 * 這裡一次講清楚，避免把 `"1024x1024"` 當檔位或把 `"4k"` 當像素。
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
 * bridge `size` 送出前的硬閘：白名單外（**尤其 `"4k"`**）一律具名拒收。
 * 為什麼不可放行：`app.py:232` 對未知 size **靜默回退 1k**——放行等於賣 4K 拿 1K。
 */
export function assertUpscaleBridgeSizeSupported(size: unknown): UpscaleBridgeSize {
  const raw = typeof size === "string" ? size.trim() : "";
  if ((UPSCALE_BRIDGE_SIZES as readonly string[]).includes(raw)) return raw as UpscaleBridgeSize;
  throw new UpscaleTierError(
    "upscale_bridge_size_unsupported",
    `bridge size "${raw}" 不在上游白名單 ${UPSCALE_BRIDGE_SIZES.join("／")}`
      + `——上游對未知 size 會靜默回退 1k（${UPSCALE_SOURCE}），放行即售假，故拒收。`
      + `4K 要用檔位契約的 (size="2k", factor=4) 表達。`,
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
    /** true＝請求未指定檔位，走了「一鍵」預設。 */
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
 * 檔位解析（**唯一入口**）：未指定 → 一鍵預設（最高可提交）；未知 → 具名拒；
 * 未校準 → 具名拒（**不靜默降級、不靜默升格**）。
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
      message: `不支援的超分檔位 "${interpreted.raw}"（可用檔位：${declared.join("／")}；像素尺寸寫法如 "1024x1024" 只作計費提示）。`,
    };
  }
  const contract = UPSCALE_TIER_CONTRACTS[interpreted.tier];
  if (contract.semantics === "upstream-factor-unverified" && !upscaleFourKUpstreamEnabled()) {
    return {
      ok: false,
      code: "upscale_4k_upstream_unverified",
      status: 400,
      message: `檔位 ${interpreted.tier} 的上游參數化已備（size="${contract.bridgeSize}"、factor=${contract.factor}、`
        + `保底長邊 ${contract.minOutputLongEdgePx}px），但 factor 的輸出色語義尚未由真單校準`
        + `（semantics=${contract.semantics}）；為避免「付費買到 2K 標成 4K」的假交付，本次拒絕提交。`
        + `校準後設 UPSCALE_4K_UPSTREAM=1 開啟。`,
    };
  }
  return tierResolution(interpreted.tier, false);
}

// ── 體積 ────────────────────────────────────────────────────────────────────

/**
 * 量測超分輸入的位元組數：`data:` URL 可解碼實測；http(s) URL 是上游自取 →
 * 回 null（**未知不回 0**，避免「以 0 冒充實測值」）。非字串／其他形狀回 null。
 */
export function measureUpscaleInputBytes(image: unknown): number | null {
  if (typeof image !== "string") return null;
  const match = /^data:([^;,]*);base64,([\s\S]*)$/i.exec(image.trim());
  if (!match) return null;
  const payload = match[2].replace(/\s+/g, "");
  if (!payload) return 0;
  // base64 長度→位元組：每 4 字元 3 位元組，扣除 padding。
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
      `超分輸入 ${measured} bytes 超出上限 ${UPSCALE_INPUT_MAX_BYTES}（來源：${UPSCALE_INPUT_MAX_BYTES_SOURCE}）。`,
      413,
    );
  }
  return measured;
}

export function assertUpscaleOutputWithinLimits(bytes: number): void {
  if (!Number.isFinite(bytes) || bytes < 0) {
    throw new UpscaleTierError("upscale_output_too_large", `超分輸出體積 ${String(bytes)} 不是有效位元組數。`, 400);
  }
  if (bytes > UPSCALE_OUTPUT_MAX_BYTES) {
    throw new UpscaleTierError(
      "upscale_output_too_large",
      `超分輸出 ${bytes} bytes 超出上限 ${UPSCALE_OUTPUT_MAX_BYTES}（來源：${UPSCALE_OUTPUT_MAX_BYTES_SOURCE}）。`,
      413,
    );
  }
}

// ── 一鍵提交解析（兩個入口共用：B 端 /v1/upscale、C 端 /api/pixai/upscale）────

export interface NormalizedUpscaleSubmission {
  image: string;
  tier: UpscaleTier;
  /** 送 bridge 的 `size`（恆在白名單內）。 */
  bridgeSize: UpscaleBridgeSize;
  /** 送 bridge 的 `factor`。 */
  factor: number;
  /** 呼叫端自帶的**原圖像素尺寸**（C 端計費提示）；無則 null。 */
  requestedPixelSize: { width: number; height: number } | null;
  /** 量到的輸入位元組（http(s) 輸入回 null＝未量測）。 */
  inputBytes: number | null;
  minOutputLongEdgePx: number;
  maxOutputLongEdgePx: number;
  semantics: UpscaleUpstreamSemantics;
  source: string;
  /** true＝檔位由「一鍵」預設帶入。 */
  defaultedTier: boolean;
}

function readAliased(source: Record<string, unknown>, ...keys: string[]): unknown {
  for (const key of keys) {
    if (source[key] !== undefined && source[key] !== null) return source[key];
  }
  return undefined;
}

/** 讀倍率輸入（`factor`／`upscale`／`scale`）；缺省回 null，非法（NaN）回 NaN 讓上層拒。 */
function readFactor(value: unknown): number | null {
  if (value === undefined || value === null || value === "") return null;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : Number.NaN;
}

/**
 * 倍率→檔位：找 factor 相符的檔位，取**最高**者（factor=4 只有 4k；factor=2 取 2k）。
 * 找不到（3／1／100 這種沒有檔位賣的倍率）回 null ⇒ 具名拒，**不把任意倍率丟給上游**。
 */
function tierForFactor(factor: number): UpscaleTier | null {
  const matches = UPSCALE_TIERS.filter((tier) => UPSCALE_TIER_CONTRACTS[tier].factor === factor);
  return matches.length ? matches[matches.length - 1] : null;
}

/**
 * 舊呼叫端同時帶 `size` 與 `factor` 時的語義（MCP `upscale` 工具就廣告 factor 1–4、
 * size 1k／2k）：`size` 是**基底檔**、`factor` 是**倍率**，兩者合起來正好就是檔位契約的
 * `(bridgeSize, factor)` 參數對。所以先按這一對**精確配對檔位**：
 *   ("1k",2)⇒1k、("2k",2)⇒2k、("2k",4)⇒**4k**（＝舊的 4 倍路徑被正名成 4K 檔位，再過閘）。
 * 配不到＝沒有這個產品檔位（如 ("1k",4) 的 3 倍級中間態）⇒ 具名拒，不靜默改成別的檔位。
 */
function tierForLegacyPair(baseTier: UpscaleTier, factor: number): UpscaleTier | null {
  const base = UPSCALE_TIER_CONTRACTS[baseTier];
  return UPSCALE_TIERS.find(
    (tier) => UPSCALE_TIER_CONTRACTS[tier].bridgeSize === base.bridgeSize && UPSCALE_TIER_CONTRACTS[tier].factor === factor,
  ) ?? null;
}

/**
 * 「一鍵」＝不需要逐步配置：檔位可省（走最高可提交檔位）、factor 由檔位契約決定。
 * 舊呼叫端（MCP `upscale` 工具廣告 factor 1–4 ＋ size 1k／2k）也吃得下：`(size, factor)`
 * 會被精確配對到檔位（(`2k`,4)⇒4k），配不到就具名拒——**絕不把任意倍率丟給上游，也絕不
 * 把顯式檔位靜默改掉**。
 *
 * 檢查順序刻意由便宜到貴、由確定到不確定：輸入形狀 → 媒體種類 → 檔位 → 響應模型宣告 → 體積。
 */
export function resolveUpscaleSubmission(options: {
  /** 該平台模型能力宣告的檔位（＝catalog `upscaleTiers`；缺省＝全集）。 */
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
    throw new UpscaleTierError("upscale_image_missing", "缺少待超分圖像：需要 image（公網 URL、mediaId 或 data: base64）。");
  }

  const mediaKind = String(readAliased(raw, "mediaKind", "media_kind", "mediaType", "media_type", "kind", "type") ?? "")
    .trim()
    .toLowerCase();
  if (mediaKind === "video" || mediaKind === "mp4" || mediaKind === "webm") {
    throw new UpscaleTierError(
      "upscale_video_upstream_unsupported",
      "視頻超分在上游無可用通道：pixai-bridge /v1/upscale 只做圖像（PixAI 圖像放大鏈），"
        + "我方沒有任何視頻超分上游（對稱差 D10 的 720P／1080P／2K／4K 視頻檔位因而無對應通道）——本平台不做假交付，故拒收。",
    );
  }
  if (mediaKind === "audio") {
    throw new UpscaleTierError("upscale_media_kind_unsupported", `超分僅支援圖像，收到媒體種類 "${mediaKind}"。`);
  }

  // ── 檔位解析（語義優先序，禁靜默降級）─────────────────────────────────────
  // ① 顯式檔位鍵（upscale_tier／tier／output_resolution）：檔位說話；同時給了不同的
  //    factor ＝呼叫端自相矛盾 ⇒ 具名拒（不得把 4k 悄悄改成 2k）。
  // ② 舊 `size` 鍵：B 端是橋的**基底檔**語義（1k／2k），與 factor 合起來精確配對檔位
  //    （(`2k`,4)⇒4k）；C 端是原圖 `WxH`（只作計費提示，不當檔位）。
  // ③ 只給 factor：以倍率選檔位（4⇒4k、2⇒2k），沒有檔位販售該倍率 ⇒ 具名拒。
  // ④ 什麼都沒給：一鍵預設＝最高可提交檔位。
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
        `檔位 ${explicitTier.tier} 固定 factor=${contract.factor}，與同時給的 factor=${factorLabel} 矛盾（檔位契約：${contractSummary}）。`,
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
          `(size="${sizeInterpretation.raw}", factor=${factorLabel}) 不是本平台販售的檔位組合（檔位契約：${contractSummary}）。`,
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
        `factor=${factorLabel} 沒有任何檔位販售此倍率（合法倍率：`
          + `${[...new Set(UPSCALE_TIERS.map((tier) => UPSCALE_TIER_CONTRACTS[tier].factor))].sort((a, b) => a - b).join("／")}；檔位契約：${contractSummary}）。`,
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
      `模型 ${options.modelId ?? "(unknown)"} 的能力宣告不含檔位 ${resolution.tier}（已宣告：${declared.join("／")}）——未宣告即不許提交。`,
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
 * 檔位契約的自檢（測試與運維共用；不在模組載入時拋，避免部署期炸站）。
 * 回問題清單：空＝契約自洽（每個檔位的保底長邊都真的達到自己的門檻）。
 */
export function upscaleTierContractViolations(): string[] {
  const violations: string[] = [];
  for (const tier of UPSCALE_TIERS) {
    const contract = UPSCALE_TIER_CONTRACTS[tier];
    if (contract.minOutputLongEdgePx < contract.thresholdPx) {
      violations.push(
        `檔位 ${tier} 的保底長邊 ${contract.minOutputLongEdgePx}px 低於門檻 ${contract.thresholdPx}px`
          + `（最低比例下的輸出其實到不了該檔位）。`,
      );
    }
    if (!(UPSCALE_BRIDGE_SIZES as readonly string[]).includes(contract.bridgeSize)) {
      violations.push(`檔位 ${tier} 的 bridgeSize "${contract.bridgeSize}" 不在上游白名單 ${UPSCALE_BRIDGE_SIZES.join("／")}。`);
    }
  }
  return violations;
}