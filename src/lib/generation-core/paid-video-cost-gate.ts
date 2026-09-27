/**
 * 付費視頻上游硬閘（2026-09-27 ¥31.2857 事故後立）。
 *
 * ── 事故因果（本閘要堵的地雷）────────────────────────────────────────────
 * `api.xiaoyxiao.xyz` 的 `dreamina-seedance-2.0` 是**按 resolution/seconds 變動**
 * 的動態價模型（上游 billing_expr：`6.25714288 * u("seconds")`，計價隨 resolution
 * 分 tier）。前代理對 32 條模型發迴圈探針，body 只帶 `{"model":…,"seconds":"5"}`
 * 而**未帶 resolution** → 上游 resolution 缺省＝**4k** → 一筆即
 * `6.25714288 * 5 = ¥31.2857`（上游日誌 logid=3、matched_tier=4k 實錘）。
 * ⇒ 缺省值本身就是要命的定價輸入，所以本閘對 resolution 採 **fail-closed**：
 * 缺省／空字串／非白名單值一律拒收，絕不讓上游拿到缺省值。
 *
 * 白名單內 7 條全部是 **quota_type=1 按次固定價**（`model_price` 固定、無
 * `billing_usage_schema`），不隨 resolution/seconds 變動；非白名單的動態價模型
 * 一律拒收——這就是白名單的設計依據。
 *
 * ── 作用域鐵律（2026-09-27 暴君追加，違反＝誤傷）────────────────────────
 * 本模組**只准被 video 提交路徑**（`openai-video-upstream.ts`）import。
 * 嚴禁寫進任何共用層：通用 resolution/size 校驗、模型目錄（catalog）、
 * node-metadata 白名單、scheduler／派單層、或任何被圖片路徑 import 的模組。
 * 理由：我方 53 條圖片 capability 帶 `{1k,2k,4k}` 檔位（gpt-image-2 家族、
 * image-5、pixai-edit/template/upscale、seedream），全域 4k 禁令＝砍掉可賣
 * 高階圖片檔位且會靜默失敗。白名單只含視頻 model，圖片 model 不經本閘。
 */

import { SupplierRequestError } from "./failure-classifier";

/** 視頻付費上游單次秒數硬上限（AGENTS.md「付費上游呼叫硬閘」②）。 */
export const PAID_VIDEO_MAX_SECONDS = 5;

/**
 * 允許送給付費視頻上游的 resolution 白名單（上限 ≤720p）。
 * 4k/2k/1080p/540p/360p 一律不在內 ⇒ 直接拒收。
 */
export const PAID_VIDEO_ALLOWED_RESOLUTIONS = ["480p", "720p"] as const;

export type PaidVideoResolution = (typeof PAID_VIDEO_ALLOWED_RESOLUTIONS)[number];

/**
 * 上游 model 白名單（暴君 2026-09-27 裁定，逐字，**唯一真源**）。
 * 白名單外的 model id 一律不許發請求。
 */
export const PAID_VIDEO_MODEL_WHITELIST = [
  "minimax-h3-933-2k-支持真人",
  "minimax-h3-a",
  "seedance-2.0-900-特惠",
  "seedance-2.0-933-特惠",
  "seedance-2.5-1010-特惠",
  "seedance-2.5-900-特惠",
  "grok-video-1.5",
] as const;

export type PaidVideoModelId = (typeof PAID_VIDEO_MODEL_WHITELIST)[number];

/**
 * 已核價三元組（model, resolution, seconds）真源。
 *
 * 計費口徑：全部 `quota_type = 1`（按次）＋ `model_price` 固定 ＋
 * `billing_usage_schema = null` ⇒ 單價**不隨 resolution/seconds 變動**，
 * 故同一 model 在其 `resolutions × seconds` 笛卡爾積內單價相同。
 *
 * 來源：`GET https://api.xiaoyxiao.xyz/api/pricing`（2026-09-27 免登入唯讀實查，
 * HTTP 200 / 28280 bytes / 32 條 model）。每條 source 原文見下方註解。
 *
 * 未校準聲明：900/933/1010 檔位名對應的**分辨率語義**無公開文檔（上游
 * description 不回），故此處的 resolutions 枚舉是**保守取捨**而非已校準事實；
 * `semantics` 欄位標記之。真單校準後方可改為已驗。三元組沒有登錄＝拒收
 * （禁止現場猜）。
 */
export interface PricedVideoTriple {
  supplierModelId: PaidVideoModelId;
  /** 按次固定單價（人民幣元）。 */
  unitCostCny: number;
  billingBasis: "per_call";
  /** 已核價的 resolution 檔位。 */
  resolutions: readonly PaidVideoResolution[];
  /** 已核價的秒數檔位。 */
  seconds: readonly number[];
  /** 核價來源原文。 */
  source: string;
  /** 上游檔位名語義是否已由真單校準。 */
  semantics: "upstream-tier-semantics-unverified";
}

// 來源原文（2026-09-27 GET /api/pricing，逐條）：
//   seedance-2.0-900-特惠            quota_type=1 model_price=0.7
//   seedance-2.5-900-特惠            quota_type=1 model_price=0.9
//   minimax-h3-933-2k-支持真人       quota_type=1 model_price=1.1
//   grok-video-1.5                   quota_type=1 model_price=1.1
//   seedance-2.0-933-特惠            quota_type=1 model_price=1.3
//   seedance-2.5-1010-特惠           quota_type=1 model_price=1.6
//   minimax-h3-a                     quota_type=1 model_price=1.6
// 全部 supported_endpoint_types=["openai"]、enable_groups=["default"]、
// billing_usage_schema=null、billing_usage_examples=null。
const PRICING_SOURCE = "GET https://api.xiaoyxiao.xyz/api/pricing 2026-09-27 (quota_type=1, model_price)";

export const PAID_VIDEO_PRICED_TRIPLES: readonly PricedVideoTriple[] = [
  {
    supplierModelId: "seedance-2.0-900-特惠",
    unitCostCny: 0.7,
    billingBasis: "per_call",
    resolutions: ["480p", "720p"],
    seconds: [4, 5],
    source: `${PRICING_SOURCE} → model_name="seedance-2.0-900-特惠", model_price=0.7, billing_usage_schema=null`,
    semantics: "upstream-tier-semantics-unverified",
  },
  {
    supplierModelId: "seedance-2.5-900-特惠",
    unitCostCny: 0.9,
    billingBasis: "per_call",
    // 900 檔位取較低分辨率檔（保守：不假設它支援 720p）。
    resolutions: ["480p"],
    seconds: [4, 5],
    source: `${PRICING_SOURCE} → model_name="seedance-2.5-900-特惠", model_price=0.9, billing_usage_schema=null`,
    semantics: "upstream-tier-semantics-unverified",
  },
  {
    supplierModelId: "seedance-2.0-933-特惠",
    unitCostCny: 1.3,
    billingBasis: "per_call",
    resolutions: ["480p", "720p"],
    seconds: [4, 5],
    source: `${PRICING_SOURCE} → model_name="seedance-2.0-933-特惠", model_price=1.3, billing_usage_schema=null`,
    semantics: "upstream-tier-semantics-unverified",
  },
  {
    supplierModelId: "seedance-2.5-1010-特惠",
    unitCostCny: 1.6,
    billingBasis: "per_call",
    resolutions: ["720p"],
    seconds: [4, 5],
    source: `${PRICING_SOURCE} → model_name="seedance-2.5-1010-特惠", model_price=1.6, billing_usage_schema=null`,
    semantics: "upstream-tier-semantics-unverified",
  },
  {
    supplierModelId: "minimax-h3-933-2k-支持真人",
    unitCostCny: 1.1,
    billingBasis: "per_call",
    // 名稱帶 2k 是上游檔位標籤；我方請求仍只准顯式帶 ≤720p，禁止升到 4k。
    resolutions: ["720p"],
    seconds: [4, 5],
    source: `${PRICING_SOURCE} → model_name="minimax-h3-933-2k-支持真人", model_price=1.1, billing_usage_schema=null`,
    semantics: "upstream-tier-semantics-unverified",
  },
  {
    supplierModelId: "minimax-h3-a",
    unitCostCny: 1.6,
    billingBasis: "per_call",
    resolutions: ["720p"],
    seconds: [4, 5],
    source: `${PRICING_SOURCE} → model_name="minimax-h3-a", model_price=1.6, billing_usage_schema=null`,
    semantics: "upstream-tier-semantics-unverified",
  },
  {
    supplierModelId: "grok-video-1.5",
    unitCostCny: 1.1,
    billingBasis: "per_call",
    resolutions: ["720p"],
    seconds: [4, 5],
    source: `${PRICING_SOURCE} → model_name="grok-video-1.5", model_price=1.1, billing_usage_schema=null`,
    semantics: "upstream-tier-semantics-unverified",
  },
];

export type PaidVideoRejectionReason =
  | "resolution_missing"
  | "resolution_not_allowed"
  | "model_not_whitelisted"
  | "seconds_missing_or_invalid"
  | "triple_not_priced";

export interface PaidVideoSubmissionFacts {
  supplierModelId?: string | null;
  resolution?: string | null;
  /** 上游將收到的秒數（整數）。 */
  seconds?: number | string | null;
  supplierId?: string;
  jobId?: string;
}

export type PaidVideoGateDecision =
  | { allowed: true; triple: PricedVideoTriple }
  | { allowed: false; reason: PaidVideoRejectionReason; detail: string };

function isAllowedResolution(value: string): value is PaidVideoResolution {
  return (PAID_VIDEO_ALLOWED_RESOLUTIONS as readonly string[]).includes(value);
}

export function isPaidVideoModelWhitelisted(value: string | null | undefined): value is PaidVideoModelId {
  return typeof value === "string" && (PAID_VIDEO_MODEL_WHITELIST as readonly string[]).includes(value);
}

/**
 * 純函式判定（測試可直接調用，不拋錯也不寫日誌）。
 * 檢查順序：resolution → model → seconds → 三元組核價，全部 fail-closed。
 */
export function evaluatePaidVideoSubmission(facts: PaidVideoSubmissionFacts): PaidVideoGateDecision {
  const rawResolution = typeof facts.resolution === "string" ? facts.resolution.trim() : "";
  if (!rawResolution) {
    return {
      allowed: false,
      reason: "resolution_missing",
      detail: "resolution 缺省或空字串：上游缺省＝4k（¥31.2857/5s 事故形狀），fail-closed 拒收。",
    };
  }
  if (!isAllowedResolution(rawResolution)) {
    return {
      allowed: false,
      reason: "resolution_not_allowed",
      detail: `resolution "${rawResolution}" 不在白名單 ${PAID_VIDEO_ALLOWED_RESOLUTIONS.join("/")}（4k/2k/1080p 一律拒收）。`,
    };
  }

  const model = typeof facts.supplierModelId === "string" ? facts.supplierModelId.trim() : "";
  if (!isPaidVideoModelWhitelisted(model)) {
    return {
      allowed: false,
      reason: "model_not_whitelisted",
      detail: `model "${model || "(empty)"}" 不在視頻付費白名單（白名單外的動態價模型＝¥31.2857 事故成因）。`,
    };
  }

  const seconds = typeof facts.seconds === "string" ? Number(facts.seconds) : facts.seconds;
  if (
    typeof seconds !== "number"
    || !Number.isInteger(seconds)
    || seconds < 1
    || seconds > PAID_VIDEO_MAX_SECONDS
  ) {
    return {
      allowed: false,
      reason: "seconds_missing_or_invalid",
      detail: `seconds "${String(facts.seconds ?? "")}" 必須是 1–${PAID_VIDEO_MAX_SECONDS} 的整數。`,
    };
  }

  const triple = PAID_VIDEO_PRICED_TRIPLES.find(
    (entry) =>
      entry.supplierModelId === model
      && entry.resolutions.includes(rawResolution)
      && entry.seconds.includes(seconds),
  );
  if (!triple) {
    return {
      allowed: false,
      reason: "triple_not_priced",
      detail: `三元組 (model="${model}", resolution="${rawResolution}", seconds=${seconds}) 無核價記錄，拒收（禁止現場猜價／猜檔位語義）。`,
    };
  }
  return { allowed: true, triple };
}

/**
 * 提交硬閘：拒收時寫結構化稽核日誌並拋 SupplierRequestError(400)。
 * 400 ⇒ 確定性失敗，不會被當成暫時性錯誤重放（不重複燒錢）。
 */
export function assertPaidVideoSubmissionAllowed(facts: PaidVideoSubmissionFacts): PricedVideoTriple {
  const decision = evaluatePaidVideoSubmission(facts);
  if (decision.allowed) return decision.triple;
  console.warn(
    "[paid-video-cost-gate] rejected",
    JSON.stringify({
      reason: decision.reason,
      detail: decision.detail,
      supplierModelId: facts.supplierModelId ?? null,
      resolution: facts.resolution ?? null,
      seconds: facts.seconds ?? null,
      supplierId: facts.supplierId ?? null,
      jobId: facts.jobId ?? null,
    }),
  );
  throw new SupplierRequestError(`paid-video-cost-gate: ${decision.reason}: ${decision.detail}`, 400);
}
