// 模型定价的 admin 面：GET 回报「每个模型此刻的基准价与有效价」，PATCH 在版本闸
// （expectedVersion 乐观并发）下全量替换定价覆写。骨架完全照 channels/route.ts：
// requireAdminSession + errorResponse(UNAUTHORIZED→401) + 共用 buildPricingPayload +
// 稽核记录（diffJson），PATCH 成功后用刚写入的值建 payload，不重 list Blob。
//
// 业务不变量（评审 blocker）：合并后任何模型的有效价不得为 0。normalizeModelPricingOverrides
// 会静默丢弃 < PRICING_COIN_STEP 的 fixedCoins（等于把「想设 0 币」悄悄还原成基准价），所以这里在
// normalize 之后、写入之前，检查原始 body 与合并后 effective，违规就回 400 并列出 modelId。

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
export const preferredRegion = "sfo1"; // 上游（VPS：new-api／闸道／image-data-api blob／控制面）都在矽谷，同区省一趟横跨美国（2026-10-01 效能审计）

/** base / effective 共同的定价形状：只回四个定价栏位，能力面不属于定价 payload。 */
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
  kind: "image" | "video" | "audio";
  resolutions: string[];
  durations: number[];
  supportsAudio: boolean;
  base: PricingFields;
  effective: PricingFields;
  override: ModelPricingOverride | null;
  /** 每个解析度的有效币价：图片= 币/张，影片= 币/秒（支援音讯另附含音讯价）。 */
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
 * GET 与 PATCH（成功、409）共用的完整 payload。overrides 用 fresh 读：admin 要看的是
 * 最新版本；`known`（PATCH 成功后传入刚写入的值）跳过重读——Blob list() 不保证写后
 * 读一致，重新 list 可能拿回旧世代。
 *
 * 拿到 overrides 后先 applyModelPricingOverrides 灌进 catalog，确保本 payload 的
 * effective/priceLabels 与扣费路径（generationCoins）看到的是同一份定价——「显示新价、
 * 扣费还旧价」正是要消灭的分裂。
 */
async function buildPricingPayload(known?: { overrides: ModelPricingOverrides; version: string | null }) {
  const { overrides, version } = known
    ? known
    : await readModelPricingOverrides({ fresh: true });

  applyModelPricingOverrides(overrides);

  const models: PricingModelPayload[] = [];
  // 遍历 catalog 全部条目（含非生成模型的服务定价键，如 adobe-firefly-fill /
  // pixai-upscale）；用户端模型选单仍以 SUPPORTED_GENERATION_MODEL_IDS 为准，不受影响。
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
    // 把最新覆写从 Blob/记忆体灌进 catalog 的 effective 状态，再读 fresh 版本给 payload。
    await syncModelPricing();
    return NextResponse.json(await buildPricingPayload());
  } catch (error) {
    return errorResponse(error);
  }
}

/**
 * 业务不变量：合并后任何模型的有效价不得为 0。
 * 1) 原始 fixedCoins 覆写 < 0.1（含 0 / 负数）→ 违规。normalize 会静默丢弃它，
 *    必须对 raw body 检查，否则「设 0 币」被无声还原成基准价。
 * 2) credit 表覆写把所有解析度都合并成 0 → generationCoins 为 0，违规。
 *    此检查在 applyModelPricingOverrides(overrides) 之后呼叫，反映合并后状态。
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
    // 全量替换语意下，漏送 overrides 等于清空全部定价——必须是显式的物件。
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

    // 丢更新防护：fresh 读最新版本，不符即 409 并附最新完整 payload 让 UI 重载。
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

    // 不变量检查需要看到「合并后」的有效价：先 apply 进 catalog，违规就还原成上一版再回 400。
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

    // 写入失败时把 catalog 还原成上一版，避免「记忆体已是新价、存档却失败」的状态分裂。
    let writtenVersion: string;
    try {
      const result = await writeModelPricingOverrides(overrides);
      writtenVersion = result.version;
    } catch (error) {
      applyModelPricingOverrides(previousOverrides);
      throw error;
    }

    // 稽核纪录：独立整数序列只活在稽核表（见 admin-audit.ts 档头注解）。失败不抛错。
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
