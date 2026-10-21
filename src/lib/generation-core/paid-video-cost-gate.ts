/**
 * 付费视频上游硬闸（2026-09-27 ¥31.2857 事故后立）。
 *
 * ── 事故因果（本闸要堵的地雷）────────────────────────────────────────────
 * `api.xiaoyxiao.xyz` 的 `dreamina-seedance-2.0` 是**按 resolution/seconds 变动**
 * 的动态价模型（上游 billing_expr：`6.25714288 * u("seconds")`，计价随 resolution
 * 分 tier）。前代理对 32 条模型发回圈探针，body 只带 `{"model":…,"seconds":"5"}`
 * 而**未带 resolution** → 上游 resolution 缺省＝**4k** → 一笔即
 * `6.25714288 * 5 = ¥31.2857`（上游日志 logid=3、matched_tier=4k 实锤）。
 * ⇒ 缺省值本身就是要命的定价输入，所以本闸对 resolution 采 **fail-closed**：
 * 缺省／空字串／非白名单值一律拒收，绝不让上游拿到缺省值。
 *
 * 白名单内 7 条全部是 **quota_type=1 按次固定价**（`model_price` 固定、无
 * `billing_usage_schema`），不随 resolution/seconds 变动；非白名单的动态价模型
 * 一律拒收——这就是白名单的设计依据。
 *
 * ── 秒数上限为何放宽到 30（2026-09-27 裁定，决策来源）────────────────────
 * 初始上限 5 是 AGENTS.md「付费上游呼叫硬闸」的通用值，但对本白名单**不是成本
 * 控制**：7 条皆按次固定价（同上），seconds 走 4 或 30 单价一分不差。5 只是
 * 「没登录长时长三元组」的副作用，且会把 catalog 最短时长＝10s 的三条在售 model
 * （seedance-2.0 / seedance-2.5-480p / seedance-2.5-720p）全部挡死。
 * 裁定：`PAID_VIDEO_MAX_SECONDS = 30`（＝catalog 最长时长），并把「已核价三元组」
 * 改为**由 catalog 生成**（见下），避免 catalog 改动后闸门落后。**三条红线**：
 *   ① resolution 缺省／空字串拒收（上游缺省＝4k）；
 *   ② 白名单外 model 拒收；
 *   ③ `seconds > 30` 拒收。
 * （原「4k/2k/1080p 无条件拒收」红线已由暴君 2026-10-20 放开 2k/4k 时撤销；
 *  高清档位的钱由**每档已核价**把住——per_second 模型只认 claim 已给单价的档位。）
 *
 * ── 三元组＝catalog 生成（单一真源，禁止手抄）─────────────────────────────
 * 来源链：`supplier-channels.config.ts` 的 **xiaoyxiao claims**（平台 model id →
 * 上游 model 名，唯一映射真源）× `GENERATION_MODEL_CATALOG`（该平台 model 的
 * `durations` 与 `resolutions`）× 本档 `PAID_VIDEO_ALLOWED_RESOLUTIONS`。
 * 交集即登录；**没有登录＝拒收**（`triple_not_priced`），禁止现场猜档位语义。
 * 后果：catalog 加时长/加档位，闸门自动跟上；catalog 没有的组合永远进不来。
 * 上游单价是站外事实：2026-09-28 V-03 起按（供给 label, 上游 model）存在
 * `supplier-channels.config.ts` 的 claim `unitPriceCny/priceSource`；claim 无价时才回退
 * `PAID_VIDEO_UNIT_PRICE_CNY`（xiaoyxiao 价，附来源原文，保留为兜底）。未核价的
 * 上游 model **不生成任何三元组**（等于不许提交）。
 * `grok-video-1.5` 在白名单内但**无公开 model id ⇒ 无 claim ⇒ 零三元组 ⇒ 一律
 * 拒收**（2026-09-27 暴君裁定「先搁置留 memory」，见 notes/2026-09-27-grok-video-15-shelved.md）。
 *
 * ── 作用域铁律（2026-09-27 暴君追加，违反＝误伤）────────────────────────
 * 本模组**只准在 video 提交路径**上执行。2026-09-28 V-03（docs/architecture/
 * planes.md §4）起，执行点由供给 adapter（`openai-video-upstream.ts`）移到生产平面
 * `worker-service.ts` 的 `submitWithSupplyCostGate`：取得租约后、呼叫供给前，且**只**
 * 在 `job.kind === "video_generate"` 时呼叫；`openai_video` 协议 fail-closed（行为同
 * 搬迁前），其他协议只在上游 model 落入白名单时套价检（metaso/filmera 等现有路径不受影响）。
 * 严禁写进任何共用层：通用 resolution/size 校验、模型目录（catalog）、
 * node-metadata 白名单、scheduler／派单层、或任何被图片路径 import 的模组。
 * 理由：我方 53 条图片 capability 带 `{1k,2k,4k}` 档位（gpt-image-2 家族、
 * image-5、pixai-edit/template/upscale、seedream），全域 4k 禁令＝砍掉可卖
 * 高阶图片档位且会静默失败。白名单只含视频 model，图片 model 不经本闸。
 * （本档 import catalog 与 registry 是**读取**；反向 import 才是违规。）
 */

import { GENERATION_MODEL_CATALOG } from "../generation-model-catalog";
import { REGISTRY_CHANNELS } from "../supplier-channels.config";
import { SupplierRequestError } from "./failure-classifier";

/**
 * 单次秒数硬上限。
 *
 * 2026-09-27 裁定：5 → 10 → **30（＝catalog 最长时长）**。白名单皆按次固定价，
 * 秒数不影响单价 ⇒ 放宽零成本。`seconds > 30` 仍拒收。
 */
export const PAID_VIDEO_MAX_SECONDS = 30;

/**
 * 允许送给付费视频上游的 resolution 白名单。
 * 540p/360p 不在内 ⇒ 直接拒收。
 *
 * 2026-10-20：DMC auto-hd 超分实测四档全部出片（720p/1080p/2k/4k），暴君明令
 * 放开 2k/4k 商品面 ⇒ 白名单加入 1080p/2k/4k。档位不是白名单即通行：
 * `per_second` 报价的模型只认 claim `unitPriceCnyPerSecond` 已给单价的档位
 * （缺价档位＝不许提交），`per_call` 模型仍按 catalog resolutions 受各供给
 * capability 收窄。
 */
export const PAID_VIDEO_ALLOWED_RESOLUTIONS = ["480p", "720p", "1080p", "2k", "4k"] as const;

export type PaidVideoResolution = (typeof PAID_VIDEO_ALLOWED_RESOLUTIONS)[number];

/**
 * 上游 model 白名单（暴君 2026-09-27 裁定，逐字，**唯一真源**）。
 * 白名单外的 model id 一律不许发请求。
 */
export const PAID_VIDEO_MODEL_WHITELIST = [
  "minimax-h3-933-2k-支持真人",
  "minimax-h3-a",
  // 2026-10-12：miaowuai 认领的 minimax-h3 上游模型（quota_type=1 按次固定价，非动态价）。
  "minimax-h3-max",
  "seedance-2.0-900-特惠",
  "seedance-2.0-933-特惠",
  "seedance-2.5-1010-特惠",
  "seedance-2.5-900-特惠",
  "grok-video-1.5",
  // 2026-10-13：miaowuai 认领的 seedance-2.0-mini。**按秒计价**（video_api.pricing.unit
  // =per_second：480p ¥0.09/s、720p ¥0.2/s），非按次固定价——单价由 registry claim 的
  // `unitPriceCnyPerSecond` 提供，无兜底表值。秒数/分辨率上限仍由本闸红线约束。
  "seedance-2.0-mini",
  // 2026-10-13：agnes 免费兜底档（agnes 平台自有免费额度，上游成本 ¥0）。它本身**不付费**
  //（单价 0），列进白名单的目的是走本闸的 fail-closed 审：只要它经 openai_video 协议提交，
  // 就仍然被约束在 ≤720p、seconds ≤30，且闸日志留下一笔可稽核记录；单价由 agnes-video
  // 供给 claim 的 unitPriceCny:0 提供（不进兜底表）。
  "agnes-video-2.5-flash",
  // 2026-10-13：dmc（dmc.cc，2026-10-18 改址 api.ll2.cn）认领的 minimax-h3 上游模型名。
  // **按秒计价**（H3 768P model_price=0.007353 USD/s × usd_exchange_rate=6.8 = ¥0.05/s）。
  // 单价由 dmc 供给 claim 的 `unitPriceCnyPerSecond`（720p/1080p/2k/4k 分档，
  // H3 ¥0.05/s ＋ auto-hd 超分 2026-10-20 实测价）提供，不进兜底表。
  "MiniMax-H3",
] as const;

export type PaidVideoModelId = (typeof PAID_VIDEO_MODEL_WHITELIST)[number];

/**
 * 上游按次单价（人民币元／次）＋来源。**站外事实，无法从 catalog 推导**，故显式。
 *
 * ⚠ 只含**按次固定价**模型（quota_type=1、billing_usage_schema=null、不随
 * resolution/seconds 变动）；**按秒计价**模型（seedance-2.0-mini）不在此表——其单价
 * 只能由该供给 claim 的 `unitPriceCnyPerSecond` 提供，缺失即未核价（拒收）。
 *
 * 来源原文（`GET https://api.xiaoyxiao.xyz/api/pricing`，2026-09-27 免登入唯读实查，
 * HTTP 200 / 28280 bytes / 32 model）：
 *   seedance-2.0-900-特惠        quota_type=1 model_price=0.7
 *   seedance-2.5-900-特惠        quota_type=1 model_price=0.9
 *   minimax-h3-933-2k-支持真人   quota_type=1 model_price=1.1
 *   grok-video-1.5               quota_type=1 model_price=1.1
 *   seedance-2.0-933-特惠        quota_type=1 model_price=1.3
 *   seedance-2.5-1010-特惠       quota_type=1 model_price=1.6
 *   minimax-h3-a                 quota_type=1 model_price=1.6
 * 全部 `billing_usage_schema=null`、`billing_usage_examples=null`、`quota_type=1`
 * ⇒ 按次固定价，**不随 resolution/seconds 变动**（放宽秒数的依据）。
 */
export const PAID_VIDEO_UNIT_PRICE_CNY: Partial<Record<PaidVideoModelId, number>> = {
  "seedance-2.0-900-特惠": 0.7,
  "seedance-2.5-900-特惠": 0.9,
  "minimax-h3-933-2k-支持真人": 1.1,
  "grok-video-1.5": 1.1,
  "seedance-2.0-933-特惠": 1.3,
  "seedance-2.5-1010-特惠": 1.6,
  "minimax-h3-a": 1.6,
  // miaowuai 认领（2026-10-12 /api/pricing 实查，× usd_exchange_rate=7）。
  "minimax-h3-max": 2.0,
};

const PRICING_SOURCE = "GET https://api.xiaoyxiao.xyz/api/pricing 2026-09-27 (quota_type=1, model_price)";

/** 已核价三元组（model, resolution, seconds）。 */
export interface PricedVideoTriple {
  supplierModelId: PaidVideoModelId;
  /**
   * 成本上界（人民币元／单）。`per_call`：按次固定单价（＝真实单价）；
   * `per_second`：**最坏单次成本上界**＝最高每秒价 × 硬上限秒数（`PAID_VIDEO_MAX_SECONDS`）。
   */
  unitCostCny: number;
  billingBasis: "per_call" | "per_second";
  /** `per_second` 才有：每档分辨率单价（¥／秒），键＝resolution。 */
  perSecondByResolution?: Record<string, number>;
  /** 已核价的 resolution 档位。 */
  resolutions: readonly PaidVideoResolution[];
  /** 已核价的秒数档位。 */
  seconds: readonly number[];
  /** 核价来源原文。 */
  source: string;
  /** 上游档位名语义是否已由真单校准。 */
  semantics: "upstream-tier-semantics-unverified";
}

function isAllowedResolution(value: string): value is PaidVideoResolution {
  return (PAID_VIDEO_ALLOWED_RESOLUTIONS as readonly string[]).includes(value);
}

/** 每档分辨率单价表（¥／秒）的清洗：只留有限正数；全非法或非物件回 null。 */
function sanitizePerSecondRates(value: unknown): Record<string, number> | null {
  if (!value || typeof value !== "object") return null;
  const out: Record<string, number> = {};
  for (const [resolution, rate] of Object.entries(value as Record<string, unknown>)) {
    if (typeof rate === "number" && Number.isFinite(rate) && rate > 0) out[resolution] = rate;
  }
  return Object.keys(out).length ? out : null;
}

/**
 * per_second 的最坏单次成本上界＝最高每秒价 × 硬上限秒数。闸门只要成本上界
 * （真实秒数/分辨率在上游提交时才定），故用型号级上界，与具体三元组无关。
 */
function worstCasePerSecondCostCny(perSecond: Record<string, number>): number {
  const maxRate = Math.max(...Object.values(perSecond));
  return Math.round(maxRate * PAID_VIDEO_MAX_SECONDS * 10000) / 10000;
}

interface ClaimPrice {
  /** 见 {@link PricedVideoTriple.unitCostCny} 的语义。 */
  unitCostCny: number;
  source: string;
  billingBasis: "per_call" | "per_second";
  perSecondByResolution?: Record<string, number>;
}

/**
 * 按（供给 label, 上游 model）查 claim 核价（V-03）：按次固定价读 `unitPriceCny`，
 * 按秒计价读 `unitPriceCnyPerSecond`（最坏上界由 {@link worstCasePerSecondCostCny} 折算）；
 * claim 无价回退 `PAID_VIDEO_UNIT_PRICE_CNY`（兜底表只含按次模型）；两者皆无回 null（＝未核价）。
 * label 未知（未带 label 的呼叫）直接用兜底表。
 */
export function resolvePaidVideoUnitPrice(supplierLabel: string | null | undefined, supplierModelId: string): ClaimPrice | null {
  if (supplierLabel) {
    const channel = REGISTRY_CHANNELS.find((entry) => entry.label === supplierLabel);
    const claim = channel?.claims.find((entry) => entry.supplierModelId === supplierModelId);
    if (claim) {
      const fallbackSource = claim.priceSource ?? `supplier-channels.config ${supplierLabel}`;
      if (typeof claim.unitPriceCny === "number") {
        return { unitCostCny: claim.unitPriceCny, source: fallbackSource, billingBasis: "per_call" };
      }
      const perSecond = sanitizePerSecondRates(claim.unitPriceCnyPerSecond);
      if (perSecond) {
        return {
          unitCostCny: worstCasePerSecondCostCny(perSecond),
          source: fallbackSource,
          billingBasis: "per_second",
          perSecondByResolution: perSecond,
        };
      }
    }
  }
  const fallback = PAID_VIDEO_UNIT_PRICE_CNY[supplierModelId as PaidVideoModelId];
  return fallback === undefined ? null : { unitCostCny: fallback, source: PRICING_SOURCE, billingBasis: "per_call" };
}

/**
 * 由 registry claims（平台 id → 上游 model）× catalog（durations/resolutions）
 * 生成已核价三元组。未核价、未映射（如 grok-video-1.5）、或交集为空的组合
 * **不生成** ⇒ 提交时以 `triple_not_priced` 拒收。
 *
 * V-03：扫**所有** registry 渠道的 claims（同名同映射的供给去重，不重复生成），
 * 三元组只定「可提交的档位组合」；单价在判定时按（供给 label, 上游 model）另查。
 */
function buildPricedVideoTriples(): PricedVideoTriple[] {
  const triples: PricedVideoTriple[] = [];
  const seen = new Set<string>();
  for (const channel of REGISTRY_CHANNELS) {
    for (const claim of channel.claims) {
      if (!claim.kinds.includes("video_generate")) continue;
      const upstreamModel = claim.supplierModelId;
      // 上游 model 必须在白名单内（白名单是硬上界；registry 不得绕过）
      if (!upstreamModel || !(PAID_VIDEO_MODEL_WHITELIST as readonly string[]).includes(upstreamModel)) continue;
      const dedupeKey = `${upstreamModel}\u0000${claim.modelId}`;
      if (seen.has(dedupeKey)) continue;
      const price = resolvePaidVideoUnitPrice(channel.label, upstreamModel);
      if (!price) continue; // 未核价＝不许提交
      const catalogModel = GENERATION_MODEL_CATALOG[claim.modelId];
      if (!catalogModel) continue;
      let resolutions = (catalogModel.resolutions ?? []).filter(isAllowedResolution);
      // per_second：只认该 claim 已给单价的档位（缺价档位＝不许提交）。
      if (price.billingBasis === "per_second") {
        resolutions = resolutions.filter((resolution) => price.perSecondByResolution?.[resolution] !== undefined);
      }
      const seconds = (catalogModel.durations ?? []).filter(
        (value) => Number.isInteger(value) && value >= 1 && value <= PAID_VIDEO_MAX_SECONDS,
      );
      if (!resolutions.length || !seconds.length) continue;
      seen.add(dedupeKey);
      triples.push({
        supplierModelId: upstreamModel as PaidVideoModelId,
        unitCostCny: price.unitCostCny,
        billingBasis: price.billingBasis,
        ...(price.perSecondByResolution ? { perSecondByResolution: price.perSecondByResolution } : {}),
        resolutions: [...resolutions],
        seconds: [...seconds],
        source: `${price.source} → model_name="${upstreamModel}", billing_basis=${price.billingBasis}, unit_cost_cny=${price.unitCostCny}；`
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
  /** 上游将收到的秒数（整数）。 */
  seconds?: number | string | null;
  supplierId?: string;
  /** 供给 label（＝registry channel label）；按（label, model）查 claim 核价。缺省时由 `env:<label>` 形状的 supplierId 推出。 */
  supplierLabel?: string | null;
  jobId?: string;
}

export type PaidVideoGateDecision =
  | { allowed: true; triple: PricedVideoTriple | null; exemptSupplierId?: string }
  | { allowed: false; reason: PaidVideoRejectionReason; detail: string };

/**
 * 成本闸豁免名单（2026-09-27 立）：
 * 这三个渠道已于 2026-09-27 全数退役（`supplier.enabled=false`，不承接任何生产
 * 流量），只作为 `openai_video` 的**协议夹具**存在（sd4/sd7/napi/drama 的请求体
 * 形状测试需要它们）。豁免它们是为了保住那些协议回归；**任何在线或新接入的渠道
 * 一律受闸（fail-closed）**——它们的模型名不在白名单，一旦被重新启用，会直接
 * 落到白名单检查被拒收，绕不过。
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
 * 纯函式判定（测试可直接调用，不抛错也不写日志）。
 * 检查顺序：豁免渠道 → resolution → model → seconds → 三元组核价，其余全 fail-closed。
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
      detail: "resolution 缺省或空字串：上游缺省＝4k（¥31.2857/5s 事故形状），fail-closed 拒收。",
    };
  }
  if (!isAllowedResolution(rawResolution)) {
    return {
      allowed: false,
      reason: "resolution_not_allowed",
      detail: `resolution "${rawResolution}" 不在白名单 ${PAID_VIDEO_ALLOWED_RESOLUTIONS.join("/")}（白名单外档位一律拒收）。`,
    };
  }

  const model = typeof facts.supplierModelId === "string" ? facts.supplierModelId.trim() : "";
  if (!isPaidVideoModelWhitelisted(model)) {
    return {
      allowed: false,
      reason: "model_not_whitelisted",
      detail: `model "${model || "(empty)"}" 不在视频付费白名单（白名单外的动态价模型＝¥31.2857 事故成因）。`,
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
      detail: `seconds "${String(facts.seconds ?? "")}" 必须是 1–${PAID_VIDEO_MAX_SECONDS} 的整数。`,
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
      detail: `三元组 (model="${model}", resolution="${rawResolution}", seconds=${seconds}) 未由 catalog 核价生成，拒收（禁止现场猜价／猜档位语义）。`,
    };
  }
  // V-03：单价按（供给 label, 上游 model）取 claim 核价，无则兜底表。
  const label = facts.supplierLabel
    ?? (typeof facts.supplierId === "string" && facts.supplierId.startsWith("env:") ? facts.supplierId.slice(4) : null);
  const price = resolvePaidVideoUnitPrice(label, model);
  if (!price) {
    return {
      allowed: false,
      reason: "triple_not_priced",
      detail: `供给 "${label ?? "(unknown)"}" 的 model "${model}" 无核价（claim 与兜底表皆无），拒收。`,
    };
  }
  // 提交渠道的计费基未必与生成该三元组的渠道相同（同一上游 model 可能按次／按秒被不同
  // 供给认领）；以提交渠道 claim 为准。per_second 还要确认提交档位本身有单价。
  const channelResolutions = price.billingBasis === "per_second"
    ? triple.resolutions.filter((resolution) => price.perSecondByResolution?.[resolution] !== undefined)
    : triple.resolutions;
  if (price.billingBasis === "per_second" && !channelResolutions.includes(rawResolution as PaidVideoResolution)) {
    return {
      allowed: false,
      reason: "triple_not_priced",
      detail: `供给 "${label ?? "(unknown)"}" 的 model "${model}" 在 resolution "${rawResolution}" 无按秒单价，拒收。`,
    };
  }
  if (
    price.billingBasis === triple.billingBasis
    && price.unitCostCny === triple.unitCostCny
    && triple.source.startsWith(price.source)
  ) {
    return { allowed: true, triple };
  }
  return {
    allowed: true,
    triple: {
      ...triple,
      billingBasis: price.billingBasis,
      unitCostCny: price.unitCostCny,
      resolutions: channelResolutions,
      ...(price.perSecondByResolution ? { perSecondByResolution: price.perSecondByResolution } : {}),
      source: `${price.source} → supplier="${label ?? "(unknown)"}", model_name="${model}", billing_basis=${price.billingBasis}, unit_cost_cny=${price.unitCostCny}`,
    },
  };
}

/**
 * 提交硬闸：拒收时写结构化稽核日志并抛 SupplierRequestError(400)。
 * 400 ⇒ 确定性失败，不会被当成暂时性错误重放（不重复烧钱）。
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
 * 生产平面入口（V-03，worker-service 在取得租约后、呼叫供给前呼叫；只用于 video_generate）。
 * `failClosed` / 白名单不再放行：无论协议标志，一律走 assertPaidVideoSubmissionAllowed。
 * 回传 null 只可能来自闸门内部的豁免三元组为空，不是「未审放行」。
 */
export function enforcePaidVideoCostGate(
  facts: PaidVideoSubmissionFacts,
  options: { failClosed: boolean },
): PricedVideoTriple | null {
  void options.failClosed;
  return assertPaidVideoSubmissionAllowed(facts);
}
