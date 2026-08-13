import { closeGenerationSql, getGenerationSql } from "../src/lib/generation-core/database";
import { GENERATION_MODEL_CATALOG } from "../src/lib/generation-model-catalog";
import { ADOBE2API_MODEL_IDS } from "../src/lib/image-model-ids";
import {
  PIXAI_ALL_MODEL_IDS,
  PIXAI_SERVICE_MODEL_IDS,
  isPixaiModelId,
  pixaiBridgeModelId,
} from "../src/lib/pixai-model-map";
import { describeEnvChannels } from "../src/lib/sub2api";

type Tier = "first_party" | "managed_pool" | "relay" | "fallback";
type Capability = {
  modelId: string;
  kind: "image_generate" | "image_edit" | "video_generate";
  supplierModelId: string | null;
  ratios: string[];
  resolutions: string[];
  editSupport: boolean;
  videoSupport: boolean;
};

/**
 * 憑證環境變數名。
 *
 * 排障記錄（2026-08-05）：舊實作對未知 label 一律回 `IMAGE_API_KEY`，於是
 * pixai 渠道會拿 primary 中轉的 key 去打 bridge。改成顯式窮舉 + 兜底報錯：
 * 新增渠道時忘記加映射會在 seed 階段炸掉，而不是靜默配一把錯的 key，
 * 等到 supplier 調度時才以 401 的形式暴露。
 */
function credentialRef(label: string): string {
  if (label === "adobe2api") return "ADOBE2API_API_KEY";
  if (label === "sub2api") return "SUB2API_API_KEY";
  if (label === "fallback") return "IMAGE_API_KEY_FALLBACK";
  if (label === "pixai") return "PIXAI_API_KEY";
  if (label === "primary") return "IMAGE_API_KEY";
  throw new Error(
    `No credential env var mapped for channel "${label}". Add it to credentialRef() before seeding.`,
  );
}

function tier(label: string): Tier {
  if (label === "adobe2api") return "first_party";
  if (label === "sub2api") return "managed_pool";
  if (label === "fallback") return "fallback";
  // pixai 是自營賬號池，與 sub2api 同性質：受管池，優於通用中轉。
  if (label === "pixai") return "managed_pool";
  return "relay";
}

function origin(value: string): string {
  try { return new URL(value).origin; } catch { return value; }
}

/**
 * 每個渠道實際能服務的模型集合。
 *
 * 排障記錄（2026-08-05）：舊實作只給 adobe2api 設白名單，其餘渠道一律認領
 * catalog 裡**所有** image 模型。後果是 pixai 專屬模型被掛到 sub2api
 * （生產上 disabled）與 fallback（share-api.com，根本不認 pixai 模型）名下，
 * 而真正能服務它的 pixai 渠道從未被 seed。調度器按 public_model_id 找
 * capability 時，命中的全是不可用的 supplier → 一律 overloaded。
 *
 * 現在兩個方向都收緊：pixai 渠道只認領 pixai 模型，非 pixai 渠道一律排除
 * pixai 模型。認領範圍與實際能力對齊，是「找不到 supplier」與「supplier
 * 全部不可用」能被區分開的前提。
 */
function channelCapabilities(label: string): Capability[] {
  const allowed = label === "adobe2api"
    ? new Set<string>(ADOBE2API_MODEL_IDS)
    : label === "pixai"
      ? new Set<string>(PIXAI_ALL_MODEL_IDS)
      : null;
  const result: Capability[] = [];
  for (const model of Object.values(GENERATION_MODEL_CATALOG)) {
    if (allowed && !allowed.has(model.id)) continue;
    // 通用渠道（primary/sub2api/fallback）不得認領 pixai 專屬模型。
    if (!allowed && isPixaiModelId(model.id)) continue;
    if (!allowed && model.kind !== "image") continue;
    if (model.kind === "video") {
      result.push({
        modelId: model.id,
        kind: "video_generate",
        supplierModelId: null,
        ratios: [...model.aspectRatios],
        resolutions: [...model.resolutions],
        editSupport: false,
        videoSupport: true,
      });
      continue;
    }
    // 映射層落地點：supplier-adapter 用 `supplier.supplierModelId ?? input.modelId`
    // 決定發給上游的模型名。pixai 渠道必須寫入 bridge 認的名字，其餘渠道保持
    // null（同名直傳）。服務類條目（pixai-edit/pixai-upscale/pixai-template）
    // 不是 bridge 的模型名，留 null 由路由自行決定 bridge 端點。
    const bridgeModelId = label === "pixai" && !PIXAI_SERVICE_MODEL_IDS.includes(model.id)
      ? pixaiBridgeModelId(model.id)
      : null;
    result.push({
      modelId: model.id,
      kind: "image_generate",
      supplierModelId: bridgeModelId,
      ratios: [...model.aspectRatios],
      resolutions: [...model.resolutions],
      editSupport: false,
      videoSupport: false,
    });
    if (model.id !== "sensenova-u1-fast") {
      result.push({
        modelId: model.id,
        kind: "image_edit",
        supplierModelId: bridgeModelId,
        ratios: [...model.aspectRatios],
        resolutions: [...model.resolutions],
        editSupport: true,
        videoSupport: false,
      });
    }
  }
  return result;
}

function sameArray(left: unknown, right: string[]): boolean {
  return Array.isArray(left) && left.length === right.length && left.every((item, index) => item === right[index]);
}

async function upsertCapability(sql: ReturnType<typeof getGenerationSql>, supplierId: string, capability: Capability) {
  await sql.begin(async (tx) => {
    const current = await tx<Record<string, unknown>[]>`
      SELECT * FROM supplier_capability
      WHERE supplier_id = ${supplierId} AND public_model_id = ${capability.modelId}
        AND kind = ${capability.kind} AND is_current
      FOR UPDATE
    `;
    const row = current[0];
    const unchanged = row &&
      (row.supplier_model_id ?? null) === capability.supplierModelId &&
      sameArray(row.ratios, capability.ratios) &&
      sameArray(row.resolutions, capability.resolutions) &&
      Boolean(row.edit_support) === capability.editSupport &&
      Boolean(row.video_support) === capability.videoSupport;
    if (unchanged) return;
    const nextVersion = row ? Number(row.contract_version) + 1 : 1;
    if (row) {
      await tx`UPDATE supplier_capability SET is_current = false, updated_at = now() WHERE id = ${Number(row.id)}`;
    }
    await tx`
      INSERT INTO supplier_capability (
        supplier_id, contract_version, is_current, public_model_id, supplier_model_id, kind,
        ratios, resolutions, edit_support, video_support, concurrency_limit, enabled
      ) VALUES (
        ${supplierId}, ${nextVersion}, true, ${capability.modelId}, ${capability.supplierModelId}, ${capability.kind},
        ${capability.ratios}, ${capability.resolutions}, ${capability.editSupport}, ${capability.videoSupport},
        ${Math.max(1, Number(process.env.GENERATION_CAPABILITY_CONCURRENCY ?? 1))}, true
      )
    `;
  });
}

/**
 * 收回渠道已不再認領的 capability 行。
 *
 * 排障記錄（2026-08-05）：seed 只做 upsert，從不撤銷。收緊白名單後，
 * fallback/sub2api 名下那些 pixai capability 依然 `is_current = true`，
 * 調度器照樣會命中它們 —— 白名單的修正等於沒生效。撤銷這一步是「認領範圍
 * 收緊」真正落到調度結果上的環節。
 *
 * 用 is_current = false 而不是 DELETE：capability id 被 supplier_lease 與
 * generation_attempt 引用，歷史記錄必須留着。
 */
async function retireUnclaimedCapabilities(
  sql: ReturnType<typeof getGenerationSql>,
  supplierId: string,
  claimed: Capability[],
): Promise<number> {
  // 分隔符用空格：模型 ID 與 kind 都只含小寫字母/數字/點/連字號，拼出來的鍵不會撞。
  const keys = claimed.map((capability) => `${capability.modelId} ${capability.kind}`);
  const rows = await sql<{ id: number }[]>`
    UPDATE supplier_capability
    SET is_current = false, enabled = false, updated_at = now()
    WHERE supplier_id = ${supplierId}
      AND is_current
      AND NOT ((public_model_id || ' ' || kind) = ANY(${keys}::text[]))
    RETURNING id
  `;
  return rows.length;
}

async function main() {
  const sql = getGenerationSql();
  const channels = describeEnvChannels(process.env).filter((channel) => channel.configured && channel.endpoint);
  if (!channels.length) throw new Error("No configured Image Studio channels were found to seed.");
  for (const channel of channels) {
    const endpoint = channel.endpoint!;
    const id = channel.id;
    const accountId = `${id}:default`;
    const isAdobe = endpoint.protocol === "adobe2api";
    await sql`
      INSERT INTO supplier (
        id, label, adapter_type, supply_tier, failure_domain, base_url, credential_ref,
        enabled, priority, concurrency_limit, quality_score, unit_cost, configuration_json, config_version
      ) VALUES (
        ${id}, ${channel.label}, ${isAdobe ? "adobe2api" : "openai_images"}, ${tier(channel.label)},
        ${origin(endpoint.baseURL)}, ${endpoint.baseURL}, ${credentialRef(channel.label)}, ${channel.defaultEnabled},
        ${channel.label === "adobe2api" ? 10 : channel.label === "sub2api" ? 20 : channel.label === "primary" ? 30 : 40},
        ${Math.max(1, Number(process.env.GENERATION_SUPPLIER_CONCURRENCY ?? 1))}, 1, 0,
        ${sql.json({ channelId: channel.id, source: channel.source } as never)}, 1
      )
      ON CONFLICT (id) DO UPDATE SET
        label = EXCLUDED.label, adapter_type = EXCLUDED.adapter_type, supply_tier = EXCLUDED.supply_tier,
        failure_domain = EXCLUDED.failure_domain, base_url = EXCLUDED.base_url,
        credential_ref = EXCLUDED.credential_ref, enabled = EXCLUDED.enabled,
        priority = EXCLUDED.priority, concurrency_limit = EXCLUDED.concurrency_limit,
        configuration_json = EXCLUDED.configuration_json, config_version = supplier.config_version + 1,
        updated_at = now()
    `;
    await sql`
      INSERT INTO supplier_account (
        id, supplier_id, label, credential_ref, enabled, concurrency_limit, health_status,
        token_source, refresh_status, health_observed_at, configuration_json
      ) VALUES (
        ${accountId}, ${id}, ${`${channel.label} default account`}, ${credentialRef(channel.label)}, true,
        ${Math.max(1, Number(process.env.GENERATION_ACCOUNT_CONCURRENCY ?? 1))},
        ${isAdobe ? "degraded" : "healthy"}, ${isAdobe ? null : "not_applicable"},
        ${isAdobe ? "unknown" : "healthy"}, ${isAdobe ? null : new Date()},
        ${sql.json({ healthPath: process.env.ADOBE2API_HEALTH_PATH ?? "health", minimumSuccessRate5m: 0.8 } as never)}
      )
      ON CONFLICT (id) DO UPDATE SET
        label = EXCLUDED.label, credential_ref = EXCLUDED.credential_ref, enabled = EXCLUDED.enabled,
        concurrency_limit = EXCLUDED.concurrency_limit, configuration_json = EXCLUDED.configuration_json,
        updated_at = now()
    `;
    const capabilities = channelCapabilities(channel.label);
    for (const capability of capabilities) {
      await upsertCapability(sql, id, capability);
    }
    const retired = await retireUnclaimedCapabilities(sql, id, capabilities);
    console.log(
      `[generation-seed] ${channel.label}: ${capabilities.length} capability contracts`
      + (retired ? `, ${retired} stale contracts retired` : ""),
    );
  }
  await closeGenerationSql();
}

main().catch(async (error) => {
  console.error("[generation-seed] failed", error);
  await closeGenerationSql();
  process.exitCode = 1;
});
