// tier-pricing 的 admin 面：GET 回報現況（各 tier 的 model×resolution 單價、金鑰/租戶
// tier 指派、基準幣價、版本），PATCH 在版本閘（expectedVersion 樂觀併發）下全量替換
// tier-pricing 文件。骨架照 admin/model-pricing/route.ts：requireAdminSession +
// errorResponse(UNAUTHORIZED→401) + buildTierPricingPayload + 稽核記錄（diffJson），
// PATCH 成功後用剛寫入的值建 payload，不重 list Blob。
//
// 業務不變量：tier 幣價不得為 0。normalizeTierPricingDocument 會靜默丟棄
// < PRICING_COIN_STEP 的幣價（等於把「想設 0 幣拿貨」悄悄還原成基準價），所以這裡在
// normalize 之後、寫入之前，檢查原始 body 的 tier 幣價，違規就回 400 並列出 modelId。

import { NextRequest, NextResponse } from "next/server";
import { requireAdminSession } from "@/lib/admin-session";
import { diffJson, nextConfigVersion, recordConfigChange } from "@/lib/admin-audit";
import {
  GENERATION_MODEL_CATALOG,
  PRICING_COIN_STEP,
  baseGenerationModel,
  generationCoins,
  type GenerationModelDefinition,
} from "@/lib/generation-model-catalog";
import {
  TIER_IDS,
  normalizeTierPricingDocument,
  type TierPricingDocument,
} from "@/lib/tier-pricing";
import { readTierPricingDocument, writeTierPricingDocument } from "@/lib/tier-pricing-store";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const preferredRegion = "sfo1"; // 上游（VPS：new-api／閘道／image-data-api blob／控制面）都在矽谷，同區省一趟橫跨美國（2026-10-01 效能審計）

interface TierPricingModelPayload {
  id: string;
  displayName: string;
  vendor: string;
  kind: "image" | "video" | "audio";
  resolutions: string[];
  /** 該解析度的基準幣價（generation coins，圖片= 幣/張，影片= 幣/秒）。 */
  baseCoins: Record<string, number>;
}

function baseCoinsFor(model: GenerationModelDefinition): Record<string, number> {
  const coins: Record<string, number> = {};
  for (const resolution of model.resolutions) {
    coins[resolution] =
      model.kind === "video"
        ? generationCoins(model.id, { resolution, durationSeconds: 1 })
        : generationCoins(model.id, { resolution });
  }
  return coins;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * GET 與 PATCH（成功、409）共用的完整 payload。doc 用 fresh 讀：admin 要看的是最新版；
 * `known`（PATCH 成功後傳入剛寫入的值）跳過重讀——Blob list() 不保證寫後讀一致。
 */
async function buildTierPricingPayload(known?: { doc: TierPricingDocument; version: string | null }) {
  const { doc, version } = known
    ? known
    : await readTierPricingDocument({ fresh: true });

  const models: TierPricingModelPayload[] = [];
  for (const modelId of Object.keys(GENERATION_MODEL_CATALOG)) {
    const base = baseGenerationModel(modelId);
    if (!base) continue;
    models.push({
      id: modelId,
      displayName: base.displayName,
      vendor: base.vendor,
      kind: base.kind,
      resolutions: [...base.resolutions],
      baseCoins: baseCoinsFor(base),
    });
  }

  return {
    tierIds: TIER_IDS,
    models,
    tiers: doc.tiers,
    assignments: doc.assignments,
    version,
    storage: process.env.BLOB_READ_WRITE_TOKEN ? ("blob" as const) : ("memory" as const),
    propagationNote:
      "保存后本实例立即生效；其他温实例最长 15 秒后刷新；已设 tier 的金钥按覆写价扣费，无 tier 金钥照旧用基准价。",
  };
}

function errorResponse(error: unknown) {
  if (error instanceof Error && error.message === "UNAUTHORIZED") {
    return NextResponse.json({ success: false, message: "请先登录管理员后台。" }, { status: 401 });
  }
  const message = error instanceof Error ? error.message : "操作失败。";
  return NextResponse.json({ success: false, message }, { status: 500 });
}

/**
 * 業務不變量：tier 幣價不得低於 PRICING_COIN_STEP（0 / 負值 = 想設「0 幣拿貨」）。
 * normalize 會靜默丟棄它，必須對 raw body 檢查，否則被無聲還原成基準價。
 */
function findInvalidTierPrices(rawTiers: unknown): string[] {
  if (!isRecord(rawTiers)) return [];
  const violations = new Set<string>();
  for (const table of Object.values(rawTiers)) {
    if (!isRecord(table)) continue;
    for (const [modelId, prices] of Object.entries(table)) {
      if (!isRecord(prices)) continue;
      for (const value of Object.values(prices)) {
        if (typeof value === "number" && value < PRICING_COIN_STEP) violations.add(modelId);
      }
    }
  }
  return [...violations];
}

export async function GET() {
  try {
    await requireAdminSession();
    return NextResponse.json(await buildTierPricingPayload());
  } catch (error) {
    return errorResponse(error);
  }
}

export async function PATCH(req: NextRequest) {
  try {
    const session = await requireAdminSession();

    const body = (await req.json().catch(() => null)) as
      | { tiers?: unknown; assignments?: unknown; expectedVersion?: unknown }
      | null;
    if (!body || typeof body !== "object") {
      return NextResponse.json({ success: false, message: "请求体必须是 JSON 对象。" }, { status: 400 });
    }
    // 全量替換語意下，漏送 tiers / assignments 等於清空該段——必須是顯式的物件。
    if (typeof body.tiers !== "object" || body.tiers === null || Array.isArray(body.tiers)) {
      return NextResponse.json({ success: false, message: "tiers 必须是对象。" }, { status: 400 });
    }
    if (typeof body.assignments !== "object" || body.assignments === null || Array.isArray(body.assignments)) {
      return NextResponse.json({ success: false, message: "assignments 必须是对象。" }, { status: 400 });
    }
    if (body.expectedVersion !== null && typeof body.expectedVersion !== "string") {
      return NextResponse.json(
        { success: false, message: "expectedVersion 必须是字符串或 null。" },
        { status: 400 },
      );
    }

    const doc = normalizeTierPricingDocument({ tiers: body.tiers, assignments: body.assignments });

    // 丟更新防護：fresh 讀最新版本，不符即 409 並附最新完整 payload 讓 UI 重載。
    const { doc: previousDoc, version: currentVersion } = await readTierPricingDocument({ fresh: true });
    if (body.expectedVersion !== currentVersion) {
      return NextResponse.json(
        {
          ...(await buildTierPricingPayload()),
          success: false,
          message: "分層价目已被其他会话更新，页面数据已刷新，请确认后重新保存。",
        },
        { status: 409 },
      );
    }

    const violations = findInvalidTierPrices(body.tiers);
    if (violations.length > 0) {
      return NextResponse.json(
        {
          success: false,
          message: `定价无效：模型 ${violations.join("、")} 的 tier 单价不能低于 ${PRICING_COIN_STEP} 币（0 币拿货会导致免费下发）。`,
        },
        { status: 400 },
      );
    }

    const { version: writtenVersion } = await writeTierPricingDocument(doc);

    const auditVersion = await nextConfigVersion("tier-pricing");
    await recordConfigChange({
      configKey: "tier-pricing",
      version: auditVersion,
      actor: session.username,
      action: "update",
      previousVersion: auditVersion > 1 ? auditVersion - 1 : null,
      diff: diffJson(previousDoc, doc),
      fullSnapshot: doc,
    });

    return NextResponse.json(await buildTierPricingPayload({ doc, version: writtenVersion }));
  } catch (error) {
    return errorResponse(error);
  }
}