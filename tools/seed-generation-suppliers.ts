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
import { FILMERA_IMAGE_MODEL, FILMERA_VIDEO_MODEL } from "../src/lib/generation-core/filmera-upstream";
import { REGISTRY_CHANNELS } from "../src/lib/supplier-channels.config";

// reblood：这些渠道的调度已整体切到 new-api，supplier 表路由指向 NEWAPI_BASE_URL。
const NEWAPI_MIGRATED_LABELS = new Set(["hublinuxdo", "pixai", "sub2api", "dreamina", "fallback", "tokenmix"]);

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
function registryChannel(label: string) {
  return REGISTRY_CHANNELS.find((channel) => channel.label === label) ?? null;
}

function credentialRef(label: string): string {
  // reblood（2026-08-27）：已迁移 new-api 的渠道 credential 一律指向 NEWAPI_API_KEY，
  // seed 重跑不再把 credential_ref 拉回旧上游 env。
  if (NEWAPI_MIGRATED_LABELS.has(label)) return "NEWAPI_API_KEY";
  // registry 渠道：apiKeyEnv 同時就是 credentialRef（add-supplier-channel 腳本落檔）。
  const registry = registryChannel(label);
  if (registry) return registry.apiKeyEnv;
  if (label === "adobe2api") return "ADOBE2API_API_KEY";
  if (label === "filmera") return "FILMERA_AUTH_TOKEN";
  if (label === "sub2api") return "SUB2API_API_KEY";
  if (label === "fallback") return "IMAGE_API_KEY_FALLBACK";
  if (label === "pixai") return "PIXAI_API_KEY";
  if (label === "primary") return "IMAGE_API_KEY";
  throw new Error(
    `No credential env var mapped for channel "${label}". Add it to credentialRef() before seeding.`,
  );
}

function tier(label: string): Tier {
  const registry = registryChannel(label);
  if (registry) return registry.tier;
  if (label === "adobe2api") return "first_party";
  if (label === "filmera") return "managed_pool";
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
  // registry 渠道：認領範圍 = config 檔裡登記的 claims，逐 claim 逐 kind 產出
  // capability；ratios/resolutions 照抄平台 catalog，不在 catalog 的模型跳過並
  // 提醒（不擋 seed——寧可少認領也不虛報能力）。
  const registry = registryChannel(label);
  if (registry) {
    const result: Capability[] = [];
    for (const claim of registry.claims) {
      const model = GENERATION_MODEL_CATALOG[claim.modelId];
      if (!model) {
        console.warn(`[generation-seed] registry channel "${label}": model "${claim.modelId}" not in GENERATION_MODEL_CATALOG, skipped.`);
        continue;
      }
      for (const kind of claim.kinds) {
        result.push({
          modelId: claim.modelId,
          kind,
          supplierModelId: claim.supplierModelId,
          ratios: [...model.aspectRatios],
          resolutions: [...model.resolutions],
          editSupport: claim.kinds.includes("image_edit"),
          videoSupport: claim.kinds.includes("video_generate"),
        });
      }
    }
    return result;
  }
  if (label === "filmera") {
    const result: Capability[] = [];
    for (const [platformId, filmeraModel] of Object.entries(FILMERA_IMAGE_MODEL)) {
      const model = GENERATION_MODEL_CATALOG[platformId];
      if (!model) continue;
      result.push({ modelId: platformId, kind: "image_generate", supplierModelId: filmeraModel, ratios: [...model.aspectRatios], resolutions: [...model.resolutions], editSupport: false, videoSupport: false });
    }
    for (const [platformId, filmeraModel] of Object.entries(FILMERA_VIDEO_MODEL)) {
      const model = GENERATION_MODEL_CATALOG[platformId];
      if (!model) continue;
      result.push({ modelId: platformId, kind: "video_generate", supplierModelId: filmeraModel, ratios: [...model.aspectRatios], resolutions: [...model.resolutions], editSupport: false, videoSupport: true });
    }
    return result;
  }
  const allowed = label === "adobe2api"
    ? new Set<string>(ADOBE2API_MODEL_IDS)
    : label === "pixai"
      ? new Set<string>(PIXAI_ALL_MODEL_IDS)
      : null;
  // gemini 系圖像模型只由 hublinuxdo(chat)/adobe2api(firefly 映射)/filmera/pixai
  // 實測服務。通用渠道上游直接拒絕（"images endpoint requires an image model"），
  // 認領必敗且燒掉 job 的嘗試預算（2026-08-27 生產實錄：nano-banana 兩單被
  // sub2api 必敗嘗試吃光重試次數後退款）。
  const GENERIC_CHANNEL_REJECTED_IMAGE_MODEL_IDS = new Set([
    "gemini-3-image",
    "gemini-3.1-flash-image",
    "gemini-2.5-flash-image",
    // blender 節點能力標籤（片AA）只由 blender_bridge 供應商認領——generic 渠道
    // 上游必拒（認領必敗且燒 job 嘗試預算，同上方 gemini 系收緊語義）。
    "blender-render-eevee",
    "blender-render-cycles",
  ]);
  const result: Capability[] = [];
  for (const model of Object.values(GENERATION_MODEL_CATALOG)) {
    if (allowed && !allowed.has(model.id)) continue;
    if (!allowed && isPixaiModelId(model.id)) continue;
    if (!allowed && model.kind !== "image") continue;
    if (!allowed && GENERIC_CHANNEL_REJECTED_IMAGE_MODEL_IDS.has(model.id)) continue;
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
    // 不篩 is_current：渠道可能曾認領後被 retireUnclaimed 收回（is_current=false
    // 留檔）。只查在役行會讓復活場景的 nextVersion 從 1 重算，撞歷史行唯一約束。
    const existing = await tx<Record<string, unknown>[]>`
      SELECT * FROM supplier_capability
      WHERE supplier_id = ${supplierId} AND public_model_id = ${capability.modelId}
        AND kind = ${capability.kind}
      ORDER BY contract_version DESC
      LIMIT 1
      FOR UPDATE
    `;
    const row = existing[0];
    const unchanged = row &&
      (row.supplier_model_id ?? null) === capability.supplierModelId &&
      sameArray(row.ratios, capability.ratios) &&
      sameArray(row.resolutions, capability.resolutions) &&
      Boolean(row.edit_support) === capability.editSupport &&
      Boolean(row.video_support) === capability.videoSupport;
    if (row && unchanged && row.is_current) return;
    if (row && unchanged) {
      await tx`UPDATE supplier_capability SET is_current = true, enabled = true, updated_at = now() WHERE id = ${Number(row.id)}`;
      return;
    }
    const nextVersion = row ? Number(row.contract_version) + 1 : 1;
    if (row?.is_current) {
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

/**
 * 渠道級併發上限（supplier 與 default account 共用）。
 *
 * seed 在每次 worker 重啟都會把 DB 里的 supplier/account.concurrency_limit
 * 重置成這裡的返回值（ON CONFLICT DO UPDATE concurrency_limit = EXCLUDED...）
 * —— 2026-08-29 實錄：直接 UPDATE DB 放開 metaso 到 6，worker 一重啟就被沖回 1，
 * 突發視頻單全部卡在 capacity_saturated 0/1。要調併發先改這張表再部署。
 *
 * metaso（第三方 metaso API，穩定）暴君裁定放 6；pixai（自營賬號池）上限 2；
 * 其餘渠道維持 env 默認（1）。capability 層的 concurrency_limit 是粘性列
 * （seed 只在新建 capability 時寫），不受此重置影響。
 */
function channelConcurrency(label: string): number {
  if (label === "metaso") return 6;
  if (label === "pixai") return 2;
  return Math.max(1, Number(process.env.GENERATION_SUPPLIER_CONCURRENCY ?? 1));
}

async function main() {
  const sql = getGenerationSql();
  const channels = describeEnvChannels(process.env).filter((channel) => channel.configured && channel.endpoint);
  if (!channels.length) throw new Error("No configured Image Studio channels were found to seed.");
  const newApiBase = (process.env.NEWAPI_BASE_URL ?? "").trim().replace(/\/+$/, "");
  const newApiEnabled = (process.env.NEWAPI_ENABLED ?? "").trim().toLowerCase() === "true" && Boolean(newApiBase);
  for (const channel of channels) {
    const endpoint = channel.endpoint!;
    const id = channel.id;
    // reblood：已迁移渠道的 endpoint.baseURL 改指 new-api（adapter 按 base_url 分流），
    // 原上游 URL 由 new-api 内部的 channel/model_mapping 负责。
    if (newApiEnabled && NEWAPI_MIGRATED_LABELS.has(channel.label)) {
      endpoint.baseURL = newApiBase;
    }
    const accountId = `${id}:default`;
    const isAdobe = endpoint.protocol === "adobe2api";
    const isFilmera = endpoint.protocol === "filmera";
    const registry = registryChannel(channel.label);
    const channelConfig: Record<string, unknown> = { channelId: channel.id, source: channel.source };
    if (registry) {
      // adapter 據此把 chatImageModels 的上游模型改走 /chat/completions 生圖。
      channelConfig.chatImageModels = registry.chatImageModels;
    }
    if (isFilmera) {
      channelConfig.supabaseUrl = process.env.FILMERA_SUPABASE_URL ?? "";
      channelConfig.anonKey = process.env.FILMERA_ANON_KEY ?? "";
      channelConfig.projectId = process.env.FILMERA_PROJECT_ID ?? "";
      channelConfig.nodeId = process.env.FILMERA_NODE_ID ?? "";
      channelConfig.videoNodeId = process.env.FILMERA_VIDEO_NODE_ID ?? "";
    }
    await sql`
      INSERT INTO supplier (
        id, label, adapter_type, supply_tier, failure_domain, base_url, credential_ref,
        enabled, priority, concurrency_limit, quality_score, unit_cost, configuration_json, config_version
      ) VALUES (
        ${id}, ${channel.label}, ${isAdobe ? "adobe2api" : isFilmera ? "filmera" : registry?.adapterType ?? "openai_images"}, ${tier(channel.label)},
        ${origin(endpoint.baseURL)}, ${endpoint.baseURL}, ${credentialRef(channel.label)}, ${channel.defaultEnabled},
        ${registry ? registry.seedPriority : channel.label === "adobe2api" ? 10 : channel.label === "filmera" ? 15 : channel.label === "sub2api" ? 20 : channel.label === "primary" ? 30 : 40},
        ${channelConcurrency(channel.label)}, 1, 0,
        ${sql.json(channelConfig as never)}, 1
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
        ${channelConcurrency(channel.label)},
        ${isAdobe ? "degraded" : "healthy"}, ${isAdobe ? null : "not_applicable"},
        ${isAdobe ? "unknown" : isFilmera ? "unknown" : "healthy"}, ${isAdobe || isFilmera ? null : new Date()},
        ${sql.json({
          // healthPath 按 adapter 分派（片Y 稿 §D）：blender_bridge 節點走橋
          // /v1/health（README 契約：帶 gpu/queue_depth），非 LOCAL（blender-modal，
          // 片X 對齊 pending）暫寫 "health"；其餘渠道維持 ADOBE2API_HEALTH_PATH
          // 寫死點原行為。注意用 registry.adapterType 判定——registry 渠道的
          // endpoint 無 protocol 欄（registryChannelToDescriptor 不設），稿中
          // endpoint.protocol 條件對 registry 渠道恆 false，現場核實後改用 registry。
          healthPath:
            registry?.adapterType === "blender_bridge"
              ? registry.baseUrlEnv.includes("LOCAL")
                ? "v1/health"
                : "health"
              : process.env.ADOBE2API_HEALTH_PATH ?? "health",
          minimumSuccessRate5m: 0.8,
        } as never)}
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
