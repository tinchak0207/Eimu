// 模型定價的 admin 面：GET 回報「每個模型此刻的基準價與有效價」，PATCH 在版本閘
// （expectedVersion 樂觀併發）下全量替換定價覆寫。骨架完全照 channels/route.ts：
// requireAdminSession + errorResponse(UNAUTHORIZED→401) + 共用 buildPricingPayload +
// 稽核記錄（diffJson），PATCH 成功後用剛寫入的值建 payload，不重 list Blob。
//
// 業務不變量（評審 blocker）：合併後任何模型的有效價不得為 0。normalizeModelPricingOverrides
// 會靜默丟棄 < PRICING_COIN_STEP 的 fixedCoins（等於把「想設 0 幣」悄悄還原成基準價），所以這裡在
// normalize 之後、寫入之前，檢查原始 body 與合併後 effective，違規就回 400 並列出 modelId。

import { NextRequest, NextResponse } from "next/server";
import { requireAdminSession } from "@/lib/admin-session";
import { diffJson, nextConfigVersion, recordConfigChange } from "@/lib/admin-audit";
import {
  GENERATION_MODEL_CATALOG,
  PRICING_COIN_STEP,
  applyModelPricingOverrides,
  baseGenerationModel,
  generationCoins,
  generationModel,
  normalizeModelPricingOverrides,
  type GenerationModelDefinition,
  type ModelPricingOverride,
  type ModelPricingOverrides,
} from "@/lib/generation-model-catalog";
import { readModelPricingOverrides, writeModelPricingOverrides } from "@/lib/pricing-overrides";
import { syncModelPricing } from "@/lib/pricing-runtime";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** base / effective 共同的定價形狀：只回四個定價欄位，能力面不屬於定價 payload。 */
interface PricingFields {
  imageCredits?: Record<string, number>;
  videoCreditsPerSecond?: Record<string, number>;
  videoCreditsWithAudioPerSecond?: Record<string, number>;
  fixedCoins?: number;
}

interface PricingModelPayload {
  id: string;
  displayName: string;
  vendor: string;
  kind: "image" | "video";
  resolutions: string[];
  durations: number[];
  supportsAudio: boolean;
  base: PricingFields;
  effective: PricingFields;
  override: ModelPricingOverride | null;
  /** 每個解析度的有效幣價：圖片= 幣/張，影片= 幣/秒（支援音訊另附含音訊價）。 */
  priceLabels: Array<{ resolution: string; coins: number; withAudioCoins?: number }>;
  modified: boolean;
}

function pricingFields(model: GenerationModelDefinition | null): PricingFields {
  if (!model) return {};
  return {
    ...(model.imageCredits !== undefined ? { imageCredits: { ...model.imageCredits } } : {}),
    ...(model.videoCreditsPerSecond !== undefined
      ? { videoCreditsPerSecond: { ...model.videoCreditsPerSecond } }
      : {}),
    ...(model.videoCreditsWithAudioPerSecond !== undefined
      ? { videoCreditsWithAudioPerSecond: { ...model.videoCreditsWithAudioPerSecond } }
      : {}),
    ...(model.fixedCoins !== undefined ? { fixedCoins: model.fixedCoins } : {}),
  };
}

function priceLabelsFor(model: GenerationModelDefinition): PricingModelPayload["priceLabels"] {
  const labels: PricingModelPayload["priceLabels"] = [];
  for (const resolution of model.resolutions) {
    const entry: PricingModelPayload["priceLabels"][number] = {
      resolution,
      coins:
        model.kind === "video"
          ? generationCoins(model.id, { resolution, durationSeconds: 1 })
          : generationCoins(model.id, { resolution }),
    };
    if (model.kind === "video" && model.supportsAudio === true) {
      entry.withAudioCoins = generationCoins(model.id, {
        resolution,
        durationSeconds: 1,
        generateAudio: true,
      });
    }
    labels.push(entry);
  }
  return labels;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * GET 與 PATCH（成功、409）共用的完整 payload。overrides 用 fresh 讀：admin 要看的是
 * 最新版本；`known`（PATCH 成功後傳入剛寫入的值）跳過重讀——Blob list() 不保證寫後
 * 讀一致，重新 list 可能拿回舊世代。
 *
 * 拿到 overrides 後先 applyModelPricingOverrides 灌進 catalog，確保本 payload 的
 * effective/priceLabels 與扣費路徑（generationCoins）看到的是同一份定價——「顯示新價、
 * 扣費還舊價」正是要消滅的分裂。
 */
async function buildPricingPayload(known?: { overrides: ModelPricingOverrides; version: string | null }) {
  const { overrides, version } = known
    ? known
    : await readModelPricingOverrides({ fresh: true });

  applyModelPricingOverrides(overrides);

  const models: PricingModelPayload[] = [];
  // 遍歷 catalog 全部條目（含非生成模型的服務定價鍵，如 adobe-firefly-fill /
  // pixai-upscale）；用戶端模型選單仍以 SUPPORTED_GENERATION_MODEL_IDS 為準，不受影響。
  for (const modelId of Object.keys(GENERATION_MODEL_CATALOG)) {
    const base = baseGenerationModel(modelId);
    const effective = generationModel(modelId);
    if (!base || !effective) continue;

    const rawOverride = overrides[modelId];
    const override = rawOverride && Object.keys(rawOverride).length > 0 ? rawOverride : null;

    models.push({
      id: modelId,
      displayName: base.displayName,
      vendor: base.vendor,
      kind: base.kind,
      resolutions: [...base.resolutions],
      durations: base.durations ? [...base.durations] : [],
      supportsAudio: base.supportsAudio === true,
      base: pricingFields(base),
      effective: pricingFields(effective),
      override,
      priceLabels: priceLabelsFor(effective),
      modified: Object.prototype.hasOwnProperty.call(overrides, modelId),
    });
  }

  return {
    models,
    overrides,
    overridesVersion: version,
    storage: process.env.BLOB_READ_WRITE_TOKEN ? ("blob" as const) : ("memory" as const),
    propagationNote:
      "保存后本实例立即生效；其他温实例最长 15 秒后刷新；用户端页面最长 60 秒或刷新后按新价展示。",
  };
}

function errorResponse(error: unknown) {
  if (error instanceof Error && error.message === "UNAUTHORIZED") {
    return NextResponse.json({ success: false, message: "请先登录管理员后台。" }, { status: 401 });
  }
  const message = error instanceof Error ? error.message : "操作失败。";
  return NextResponse.json({ success: false, message }, { status: 500 });
}

export async function GET() {
  try {
    await requireAdminSession();
    // 把最新覆寫從 Blob/記憶體灌進 catalog 的 effective 狀態，再讀 fresh 版本給 payload。
    await syncModelPricing();
    return NextResponse.json(await buildPricingPayload());
  } catch (error) {
    return errorResponse(error);
  }
}

/**
 * 業務不變量：合併後任何模型的有效價不得為 0。
 * 1) 原始 fixedCoins 覆寫 < 0.1（含 0 / 負數）→ 違規。normalize 會靜默丟棄它，
 *    必須對 raw body 檢查，否則「設 0 幣」被無聲還原成基準價。
 * 2) credit 表覆寫把所有解析度都合併成 0 → generationCoins 為 0，違規。
 *    此檢查在 applyModelPricingOverrides(overrides) 之後呼叫，反映合併後狀態。
 */
function findInvalidPricingOverrides(raw: unknown, overrides: ModelPricingOverrides): string[] {
  if (!isRecord(raw)) return [];
  const violations = new Set<string>();

  for (const [modelId, entry] of Object.entries(raw)) {
    if (!isRecord(entry)) continue;

    if (typeof entry.fixedCoins === "number" && entry.fixedCoins < PRICING_COIN_STEP) {
      violations.add(modelId);
      continue;
    }

    const base = baseGenerationModel(modelId);
    if (base && overrides[modelId]) {
      const zeroEverywhere = base.resolutions.every((resolution) =>
        generationCoins(modelId, { resolution, durationSeconds: 1 }) <= 0,
      );
      if (zeroEverywhere) violations.add(modelId);
    }
  }

  return [...violations];
}

export async function PATCH(req: NextRequest) {
  try {
    const session = await requireAdminSession();

    const body = (await req.json().catch(() => null)) as
      | { overrides?: unknown; expectedVersion?: unknown }
      | null;
    if (!body || typeof body !== "object") {
      return NextResponse.json({ success: false, message: "请求体必须是 JSON 对象。" }, { status: 400 });
    }
    // 全量替換語意下，漏送 overrides 等於清空全部定價——必須是顯式的物件。
    if (typeof body.overrides !== "object" || body.overrides === null || Array.isArray(body.overrides)) {
      return NextResponse.json({ success: false, message: "overrides 必须是对象。" }, { status: 400 });
    }
    if (body.expectedVersion !== null && typeof body.expectedVersion !== "string") {
      return NextResponse.json(
        { success: false, message: "expectedVersion 必须是字符串或 null。" },
        { status: 400 },
      );
    }

    const overrides = normalizeModelPricingOverrides(body.overrides);

    // 丟更新防護：fresh 讀最新版本，不符即 409 並附最新完整 payload 讓 UI 重載。
    const { overrides: previousOverrides, version: currentVersion } = await readModelPricingOverrides({ fresh: true });
    if (body.expectedVersion !== currentVersion) {
      return NextResponse.json(
        {
          ...(await buildPricingPayload()),
          success: false,
          message: "模型定价已被其他会话更新，页面数据已刷新，请确认后重新保存。",
        },
        { status: 409 },
      );
    }

    // 不變量檢查需要看到「合併後」的有效價：先 apply 進 catalog，違規就還原成上一版再回 400。
    applyModelPricingOverrides(overrides);
    const violations = findInvalidPricingOverrides(body.overrides, overrides);
    if (violations.length > 0) {
      applyModelPricingOverrides(previousOverrides);
      return NextResponse.json(
        {
          success: false,
          message: `定价无效：模型 ${violations.join("、")} 的有效价格不能为 0（fixedCoins 不得小于 ${PRICING_COIN_STEP}，且不能把所有分辨率的价格清成 0）。`,
        },
        { status: 400 },
      );
    }

    // 寫入失敗時把 catalog 還原成上一版，避免「記憶體已是新價、存檔卻失敗」的狀態分裂。
    let writtenVersion: string;
    try {
      const result = await writeModelPricingOverrides(overrides);
      writtenVersion = result.version;
    } catch (error) {
      applyModelPricingOverrides(previousOverrides);
      throw error;
    }

    // 稽核紀錄：獨立整數序列只活在稽核表（見 admin-audit.ts 檔頭註解）。失敗不拋錯。
    const auditVersion = await nextConfigVersion("model-pricing-overrides");
    await recordConfigChange({
      configKey: "model-pricing-overrides",
      version: auditVersion,
      actor: session.username,
      action: "update",
      previousVersion: auditVersion > 1 ? auditVersion - 1 : null,
      diff: diffJson(previousOverrides, overrides),
      fullSnapshot: overrides,
    });

    return NextResponse.json(await buildPricingPayload({ overrides, version: writtenVersion }));
  } catch (error) {
    return errorResponse(error);
  }
}
