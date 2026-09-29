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
 * ── 秒數上限為何放寬到 30（2026-09-27 裁定，決策來源）────────────────────
 * 初始上限 5 是 AGENTS.md「付費上游呼叫硬閘」的通用值，但對本白名單**不是成本
 * 控制**：7 條皆按次固定價（同上），seconds 走 4 或 30 單價一分不差。5 只是
 * 「沒登錄長時長三元組」的副作用，且會把 catalog 最短時長＝10s 的三條在售 model
 * （seedance-2.0 / seedance-2.5-480p / seedance-2.5-720p）全部擋死。
 * 裁定：`PAID_VIDEO_MAX_SECONDS = 30`（＝catalog 最長時長），並把「已核價三元組」
 * 改為**由 catalog 生成**（見下），避免 catalog 改動後閘門落後。**三條紅線一字
 * 不改**：
 *   ① 4k/2k/1080p 無條件拒收（上限仍 ≤720p）；
 *   ② resolution 缺省／空字串拒收（上游缺省＝4k）；
 *   ③ 白名單外 model 拒收；`seconds > 30` 拒收。
 *
 * ── 三元組＝catalog 生成（單一真源，禁止手抄）─────────────────────────────
 * 來源鏈：`supplier-channels.config.ts` 的 **xiaoyxiao claims**（平台 model id →
 * 上游 model 名，唯一映射真源）× `GENERATION_MODEL_CATALOG`（該平台 model 的
 * `durations` 與 `resolutions`）× 本檔 `PAID_VIDEO_ALLOWED_RESOLUTIONS`（≤720p）。
 * 交集即登錄；**沒有登錄＝拒收**（`triple_not_priced`），禁止現場猜檔位語義。
 * 後果：catalog 加時長/加檔位，閘門自動跟上；catalog 沒有的組合永遠進不來。
 * 上游單價是站外事實：2026-09-28 V-03 起按（供給 label, 上游 model）存在
 * `supplier-channels.config.ts` 的 claim `unitPriceCny/priceSource`；claim 無價時才回退
 * `PAID_VIDEO_UNIT_PRICE_CNY`（xiaoyxiao 價，附來源原文，保留為兜底）。未核價的
 * 上游 model **不生成任何三元組**（等於不許提交）。
 * `grok-video-1.5` 在白名單內但**無公開 model id ⇒ 無 claim ⇒ 零三元組 ⇒ 一律
 * 拒收**（2026-09-27 暴君裁定「先搁置留 memory」，見 notes/2026-09-27-grok-video-15-shelved.md）。
 *
 * ── 作用域鐵律（2026-09-27 暴君追加，違反＝誤傷）────────────────────────
 * 本模組**只准在 video 提交路徑**上執行。2026-09-28 V-03（docs/architecture/
 * planes.md §4）起，執行點由供給 adapter（`openai-video-upstream.ts`）移到生產平面
 * `worker-service.ts` 的 `submitWithSupplyCostGate`：取得租約後、呼叫供給前，且**只**
 * 在 `job.kind === "video_generate"` 時呼叫；`openai_video` 協議 fail-closed（行為同
 * 搬遷前），其他協議只在上游 model 落入白名單時套價檢（metaso/filmera 等現有路徑不受影響）。
 * 嚴禁寫進任何共用層：通用 resolution/size 校驗、模型目錄（catalog）、
 * node-metadata 白名單、scheduler／派單層、或任何被圖片路徑 import 的模組。
 * 理由：我方 53 條圖片 capability 帶 `{1k,2k,4k}` 檔位（gpt-image-2 家族、
 * image-5、pixai-edit/template/upscale、seedream），全域 4k 禁令＝砍掉可賣
 * 高階圖片檔位且會靜默失敗。白名單只含視頻 model，圖片 model 不經本閘。
 * （本檔 import catalog 與 registry 是**讀取**；反向 import 才是違規。）
 */

import { GENERATION_MODEL_CATALOG } from "../generation-model-catalog";
import { REGISTRY_CHANNELS } from "../supplier-channels.config";
import { SupplierRequestError } from "./failure-classifier";

/**
 * 單次秒數硬上限。
 *
 * 2026-09-27 裁定：5 → 10 → **30（＝catalog 最長時長）**。白名單皆按次固定價，
 * 秒數不影響單價 ⇒ 放寬零成本。`seconds > 30` 仍拒收。
 */
export const PAID_VIDEO_MAX_SECONDS = 30;

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
 * 上游按次單價（人民幣元／次）＋來源。**站外事實，無法從 catalog 推導**，故顯式。
 *
 * 來源原文（`GET https://api.xiaoyxiao.xyz/api/pricing`，2026-09-27 免登入唯讀實查，
 * HTTP 200 / 28280 bytes / 32 model）：
 *   seedance-2.0-900-特惠        quota_type=1 model_price=0.7
 *   seedance-2.5-900-特惠        quota_type=1 model_price=0.9
 *   minimax-h3-933-2k-支持真人   quota_type=1 model_price=1.1
 *   grok-video-1.5               quota_type=1 model_price=1.1
 *   seedance-2.0-933-特惠        quota_type=1 model_price=1.3
 *   seedance-2.5-1010-特惠       quota_type=1 model_price=1.6
 *   minimax-h3-a                 quota_type=1 model_price=1.6
 * 全部 `billing_usage_schema=null`、`billing_usage_examples=null`、`quota_type=1`
 * ⇒ 按次固定價，**不隨 resolution/seconds 變動**（放寬秒數的依據）。
 */
export const PAID_VIDEO_UNIT_PRICE_CNY: Record<PaidVideoModelId, number> = {
  "seedance-2.0-900-特惠": 0.7,
  "seedance-2.5-900-特惠": 0.9,
  "minimax-h3-933-2k-支持真人": 1.1,
  "grok-video-1.5": 1.1,
  "seedance-2.0-933-特惠": 1.3,
  "seedance-2.5-1010-特惠": 1.6,
  "minimax-h3-a": 1.6,
};

const PRICING_SOURCE = "GET https://api.xiaoyxiao.xyz/api/pricing 2026-09-27 (quota_type=1, model_price)";

/** 已核價三元組（model, resolution, seconds）。 */
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

function isAllowedResolution(value: string): value is PaidVideoResolution {
  return (PAID_VIDEO_ALLOWED_RESOLUTIONS as readonly string[]).includes(value);
}

interface ClaimPrice {
  unitCostCny: number;
  source: string;
}

/**
 * 按（供給 label, 上游 model）查 claim 核價（V-03）；claim 無價回退
 * `PAID_VIDEO_UNIT_PRICE_CNY`（兜底表，xiaoyxiao 價）；兩者皆無回 null（＝未核價）。
 * label 未知（未帶 label 的呼叫）直接用兜底表。
 */
export function resolvePaidVideoUnitPrice(supplierLabel: string | null | undefined, supplierModelId: string): ClaimPrice | null {
  if (supplierLabel) {
    const channel = REGISTRY_CHANNELS.find((entry) => entry.label === supplierLabel);
    const claim = channel?.claims.find(
      (entry) => entry.supplierModelId === supplierModelId && typeof entry.unitPriceCny === "number",
    );
    if (claim && typeof claim.unitPriceCny === "number") {
      return { unitCostCny: claim.unitPriceCny, source: claim.priceSource ?? `supplier-channels.config ${supplierLabel}` };
    }
  }
  const fallback = PAID_VIDEO_UNIT_PRICE_CNY[supplierModelId as PaidVideoModelId];
  return fallback === undefined ? null : { unitCostCny: fallback, source: PRICING_SOURCE };
}

/**
 * 由 registry claims（平台 id → 上游 model）× catalog（durations/resolutions）
 * 生成已核價三元組。未核價、未映射（如 grok-video-1.5）、或交集為空的組合
 * **不生成** ⇒ 提交時以 `triple_not_priced` 拒收。
 *
 * V-03：掃**所有** registry 渠道的 claims（同名同映射的供給去重，不重複生成），
 * 三元組只定「可提交的檔位組合」；單價在判定時按（供給 label, 上游 model）另查。
 */
function buildPricedVideoTriples(): PricedVideoTriple[] {
  const triples: PricedVideoTriple[] = [];
  const seen = new Set<string>();
  for (const channel of REGISTRY_CHANNELS) {
    for (const claim of channel.claims) {
      if (!claim.kinds.includes("video_generate")) continue;
      const upstreamModel = claim.supplierModelId;
      // 上游 model 必須在白名單內（白名單是硬上界；registry 不得繞過）
      if (!upstreamModel || !(PAID_VIDEO_MODEL_WHITELIST as readonly string[]).includes(upstreamModel)) continue;
      const dedupeKey = `${upstreamModel}\u0000${claim.modelId}`;
      if (seen.has(dedupeKey)) continue;
      const price = resolvePaidVideoUnitPrice(channel.label, upstreamModel);
      if (!price) continue; // 未核價＝不許提交
      const catalogModel = GENERATION_MODEL_CATALOG[claim.modelId];
      if (!catalogModel) continue;
      const resolutions = (catalogModel.resolutions ?? []).filter(isAllowedResolution);
      const seconds = (catalogModel.durations ?? []).filter(
        (value) => Number.isInteger(value) && value >= 1 && value <= PAID_VIDEO_MAX_SECONDS,
      );
      if (!resolutions.length || !seconds.length) continue;
      seen.add(dedupeKey);
      triples.push({
        supplierModelId: upstreamModel as PaidVideoModelId,
        unitCostCny: price.unitCostCny,
        billingBasis: "per_call",
        resolutions: [...resolutions],
        seconds: [...seconds],
        source: `${price.source} → model_name="${upstreamModel}", model_price=${price.unitCostCny}, billing_usage_schema=null；`
          + `seconds/resolutions 取自 catalog "${claim.modelId}"`,
        semantics: "upstream-tier-semantics-unverified",
      });
    }
  }
  return triples;
}

export const PAID_VIDEO_PRICED_TRIPLES: readonly PricedVideoTriple[] = buildPricedVideoTriples();

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
  /** 供給 label（＝registry channel label）；按（label, model）查 claim 核價。缺省時由 `env:<label>` 形狀的 supplierId 推出。 */
  supplierLabel?: string | null;
  jobId?: string;
}

export type PaidVideoGateDecision =
  | { allowed: true; triple: PricedVideoTriple | null; exemptSupplierId?: string }
  | { allowed: false; reason: PaidVideoRejectionReason; detail: string };

/**
 * 成本閘豁免名單（2026-09-27 立）：
 * 這三個渠道已於 2026-09-27 全數退役（`supplier.enabled=false`，不承接任何生產
 * 流量），只作為 `openai_video` 的**協議夾具**存在（sd4/sd7/napi/drama 的請求體
 * 形狀測試需要它們）。豁免它們是為了保住那些協議回歸；**任何在線或新接入的渠道
 * 一律受閘（fail-closed）**——它們的模型名不在白名單，一旦被重新啟用，會直接
 * 落到白名單檢查被拒收，繞不過。
 */
export const PAID_VIDEO_GATE_EXEMPT_SUPPLIER_IDS = [
  "env:cangyuansuanli",
  "env:napi",
  "env:drama",
] as const;

function isPaidVideoGateExemptSupplier(supplierId: string | undefined): boolean {
  return (
    typeof supplierId === "string"
    && (PAID_VIDEO_GATE_EXEMPT_SUPPLIER_IDS as readonly string[]).includes(supplierId)
  );
}

export function isPaidVideoModelWhitelisted(value: string | null | undefined): value is PaidVideoModelId {
  return typeof value === "string" && (PAID_VIDEO_MODEL_WHITELIST as readonly string[]).includes(value);
}

/**
 * 純函式判定（測試可直接調用，不拋錯也不寫日誌）。
 * 檢查順序：豁免渠道 → resolution → model → seconds → 三元組核價，其餘全 fail-closed。
 */
export function evaluatePaidVideoSubmission(facts: PaidVideoSubmissionFacts): PaidVideoGateDecision {
  if (isPaidVideoGateExemptSupplier(facts.supplierId)) {
    return { allowed: true, triple: null, exemptSupplierId: facts.supplierId };
  }
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
      detail: `三元組 (model="${model}", resolution="${rawResolution}", seconds=${seconds}) 未由 catalog 核價生成，拒收（禁止現場猜價／猜檔位語義）。`,
    };
  }
  // V-03：單價按（供給 label, 上游 model）取 claim 核價，無則兜底表。
  const label = facts.supplierLabel
    ?? (typeof facts.supplierId === "string" && facts.supplierId.startsWith("env:") ? facts.supplierId.slice(4) : null);
  const price = resolvePaidVideoUnitPrice(label, model);
  if (!price) {
    return {
      allowed: false,
      reason: "triple_not_priced",
      detail: `供給 "${label ?? "(unknown)"}" 的 model "${model}" 無核價（claim 與兜底表皆無），拒收。`,
    };
  }
  if (price.unitCostCny === triple.unitCostCny && triple.source.startsWith(price.source)) {
    return { allowed: true, triple };
  }
  return {
    allowed: true,
    triple: {
      ...triple,
      unitCostCny: price.unitCostCny,
      source: `${price.source} → supplier="${label ?? "(unknown)"}", model_name="${model}", model_price=${price.unitCostCny}`,
    },
  };
}

/**
 * 提交硬閘：拒收時寫結構化稽核日誌並拋 SupplierRequestError(400)。
 * 400 ⇒ 確定性失敗，不會被當成暫時性錯誤重放（不重複燒錢）。
 */
export function assertPaidVideoSubmissionAllowed(facts: PaidVideoSubmissionFacts): PricedVideoTriple | null {
  const decision = evaluatePaidVideoSubmission(facts);
  if (decision.allowed) {
    if (decision.exemptSupplierId) {
      console.warn(
        "[paid-video-cost-gate] exempt-retired-channel",
        JSON.stringify({
          supplierId: decision.exemptSupplierId,
          supplierModelId: facts.supplierModelId ?? null,
          resolution: facts.resolution ?? null,
          seconds: facts.seconds ?? null,
          jobId: facts.jobId ?? null,
        }),
      );
    }
    return decision.triple;
  }
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

/**
 * 生產平面入口（V-03，worker-service 在取得租約後、呼叫供給前呼叫；只用於 video_generate）。
 * - `failClosed`（`openai_video` 協議）：一律過閘，白名單外即拒——與搬遷前行為一致。
 * - 否則：只有上游 model 落在白名單內才過閘；不在白名單的既有視頻路徑（metaso/filmera 等）放行不審。
 * 回傳 null＝未審（非白名單的非 fail-closed 協議）或豁免。
 */
export function enforcePaidVideoCostGate(
  facts: PaidVideoSubmissionFacts,
  options: { failClosed: boolean },
): PricedVideoTriple | null {
  if (!options.failClosed && !isPaidVideoModelWhitelisted(
    typeof facts.supplierModelId === "string" ? facts.supplierModelId.trim() : facts.supplierModelId,
  )) {
    return null;
  }
  return assertPaidVideoSubmissionAllowed(facts);
}
