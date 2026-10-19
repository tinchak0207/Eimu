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
import { MODEL_ROUTES, NEWAPI_ROUTE_LABEL, NEWAPI_SUPERSEDED_LABELS, modelsRoutedTo, routeSupplierId } from "../src/lib/model-routes.config";

// reblood：这些渠道的调度已整体切到 new-api。
// 2026-09-27 暴君裁定：tokenmix 已砍除（含 new-api 渠道 9），从迁移清单移除。
// 2026-10-01 路由收口：NEWAPI_ENABLED 时它们不再各自 seed 成「base_url 全指向同一个
// new-api」的假 supplier（DB 排一次、new-api 再排一次＝双重调度，标签与实际去向不符），
// 一律由单一 supplier `env:newapi` 代表；new-api 内部的渠道顺序在 new-api 后台调。
const NEWAPI_MIGRATED_LABELS = NEWAPI_SUPERSEDED_LABELS;

/**
 * 已退役视频渠道（2026-09-27 暴君裁定；视频唯一权威改为 xiaoyxiao）。
 *
 * DB 端已把这 7 条的 supplier／supplier_account `enabled=false`、capability
 * `is_current=false AND enabled=false`（止损态）。但 seed 每次 worker 重启都会跑
 * `INSERT … ON CONFLICT DO UPDATE SET enabled = EXCLUDED.enabled`，会按 env 默认值
 * 把它们**重新开启**——止损态在第一次重启就会被冲掉。此清单让 seed 直接跳过它们
 * （不 upsert、不认领、不回收），是「停用维持」的代码级保证。
 *
 * 移除本清单任一项＝恢复该渠道供货，必须先有暴君裁定。
 */
const RETIRED_SUPPLIER_LABELS = new Set([
  "filmera",
  "adobe2api-plus",
  "tokenmix",
  "cangyuansuanli",
  "metaso",
  "napi",
  "drama",
]);

/**
 * 渠道级上游模型别名（V-04，seed 进 supplier.configuration_json.modelAliases）。
 * adapter 读取顺序：`supplierModelId ?? configuration.modelAliases[modelId] ?? modelId`
 *（openai-images-adapter.ts `aliasedSupplierModel`）。取代原 supplier-adapter.ts 的
 * `SUB2API_MODEL_ALIASES` + `supplier.id === "env:sub2api"` 写死特例。
 *
 * sub2api（store.tinchak0207.xyz/sub2api）的 images endpoint 只认它自己字典里的
 * 上游模型名。实测（generation_attempt 2026-08-23~27 多笔 400）：平台 id
 * 「gemini-3-image」直传会被拒 `images endpoint requires an image model`；sub2api
 * 对 Nano Banana Pro 的命名是「gemini-3-pro-image」。其余平台 id 与 sub2api 字典一致。
 */
const CHANNEL_MODEL_ALIASES: Record<string, Record<string, string>> = {
  sub2api: { "gemini-3-image": "gemini-3-pro-image" },
};

/**
 * supplier.priority 已不参与调度（2026-10-01 起排序唯一真源＝MODEL_ROUTES 阵列顺序，
 * scheduler 按 array_position 排）。栏位保留只为相容旧读者，一律写常数，别再拿它调序。
 */
const SUPPLIER_PRIORITY_UNUSED = 0;

/** new-api 单一 supplier 的并发（原 5 个假 supplier 合计 1+1+1+2+1=6）。 */
function newApiConcurrency(): number {
  return Math.max(1, Number(process.env.NEWAPI_SUPPLIER_CONCURRENCY ?? 6));
}

type Tier = "first_party" | "managed_pool" | "relay" | "fallback";
type Capability = {
  modelId: string;
  kind: "image_generate" | "image_edit" | "video_generate" | "tts";
  supplierModelId: string | null;
  ratios: string[];
  resolutions: string[];
  editSupport: boolean;
  videoSupport: boolean;
};

/**
 * 凭证环境变数名。
 *
 * 排障记录（2026-08-05）：旧实作对未知 label 一律回 `IMAGE_API_KEY`，于是
 * pixai 渠道会拿 primary 中转的 key 去打 bridge。改成显式穷举 + 兜底报错：
 * 新增渠道时忘记加映射会在 seed 阶段炸掉，而不是静默配一把错的 key，
 * 等到 supplier 调度时才以 401 的形式暴露。
 */
function registryChannel(label: string) {
  return REGISTRY_CHANNELS.find((channel) => channel.label === label) ?? null;
}

function credentialRef(label: string): string {
  // reblood（2026-08-27）：已迁移 new-api 的渠道 credential 一律指向 NEWAPI_API_KEY，
  // seed 重跑不再把 credential_ref 拉回旧上游 env。
  if (label === NEWAPI_ROUTE_LABEL || NEWAPI_MIGRATED_LABELS.has(label)) return "NEWAPI_API_KEY";
  // registry 渠道：apiKeyEnv 同时就是 credentialRef（add-supplier-channel 脚本落档）。
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
  // pixai 是自营账号池，与 sub2api 同性质：受管池，优于通用中转。
  if (label === "pixai") return "managed_pool";
  return "relay";
}

function origin(value: string): string {
  try { return new URL(value).origin; } catch { return value; }
}

/**
 * 每个渠道实际能服务的模型集合。
 *
 * 排障记录（2026-08-05）：旧实作只给 adobe2api 设白名单，其余渠道一律认领
 * catalog 里**所有** image 模型。后果是 pixai 专属模型被挂到 sub2api
 * （生产上 disabled）与 fallback（share-api.com，根本不认 pixai 模型）名下，
 * 而真正能服务它的 pixai 渠道从未被 seed。调度器按 public_model_id 找
 * capability 时，命中的全是不可用的 supplier → 一律 overloaded。
 *
 * 现在两个方向都收紧：pixai 渠道只认领 pixai 模型，非 pixai 渠道一律排除
 * pixai 模型。认领范围与实际能力对齐，是「找不到 supplier」与「supplier
 * 全部不可用」能被区分开的前提。
 */
function channelCapabilities(label: string): Capability[] {
  // new-api 单一 supplier：认领范围＝MODEL_ROUTES 里含 "newapi" 那一步的模型。
  // 上游模型名透传（new-api 内部 model_mapping 负责），故 supplierModelId 恒 null。
  if (label === NEWAPI_ROUTE_LABEL) {
    const result: Capability[] = [];
    for (const modelId of modelsRoutedTo(NEWAPI_ROUTE_LABEL)) {
      const model = GENERATION_MODEL_CATALOG[modelId];
      if (!model) {
        console.warn(`[generation-seed] newapi: routed model "${modelId}" not in GENERATION_MODEL_CATALOG, skipped.`);
        continue;
      }
      const base = { modelId, supplierModelId: null, ratios: [...model.aspectRatios], resolutions: [...model.resolutions] };
      if (model.kind === "video") {
        result.push({ ...base, kind: "video_generate", editSupport: false, videoSupport: true });
      } else if (model.kind === "image") {
        result.push({ ...base, kind: "image_generate", editSupport: false, videoSupport: false });
        result.push({ ...base, kind: "image_edit", editSupport: true, videoSupport: false });
      }
    }
    return result;
  }
  // registry 渠道：认领范围 = config 档里登记的 claims，逐 claim 逐 kind 产出
  // capability；ratios 照抄平台 catalog，resolutions 优先用 claim.resolutions
  // （上游真实可交付档位，避免原生出片渠道虚报超分档），缺省才照抄 catalog；
  // 不在 catalog 的模型跳过并提醒（不挡 seed——宁可少认领也不虚报能力）。
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
          resolutions: claim.resolutions ? [...claim.resolutions] : [...model.resolutions],
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
  // gemini 系图像模型只由 hublinuxdo(chat)/adobe2api(firefly 映射)/filmera/pixai
  // 实测服务。通用渠道上游直接拒绝（"images endpoint requires an image model"），
  // 认领必败且烧掉 job 的尝试预算（2026-08-27 生产实录：nano-banana 两单被
  // sub2api 必败尝试吃光重试次数后退款）。
  const GENERIC_CHANNEL_REJECTED_IMAGE_MODEL_IDS = new Set([
    "gemini-3-image",
    "gemini-3.1-flash-image",
    "gemini-2.5-flash-image",
    // blender 节点能力标签（片AA）只由 blender_bridge 供应商认领——generic 渠道
    // 上游必拒（认领必败且烧 job 尝试预算，同上方 gemini 系收紧语义）。
    "blender-render-eevee",
    "blender-render-cycles",
  ]);
  const result: Capability[] = [];
  for (const model of Object.values(GENERATION_MODEL_CATALOG)) {
    if (allowed && !allowed.has(model.id)) continue;
    if (!allowed && isPixaiModelId(model.id)) continue;
    if (!allowed && model.kind !== "image") continue;
    if (!allowed && GENERIC_CHANNEL_REJECTED_IMAGE_MODEL_IDS.has(model.id)) continue;
    // 2026-09-27 暴君裁定「adobe2api 留图、停视频」：本渠道所有 video_generate
    // 认领一律不产出 ⇒ retireUnclaimedCapabilities 会把既有 video capability
    // 逐条 enabled=false + is_current=false（含 seedance-2.0/-fast、veo-3.1/-fast、
    // kling-3.0/-omni、firefly-video、luma 全族、runway-gen-4/4.5）。图片
    // （image_generate/image_edit，16+16 条）认领逐条不动。视频唯一权威＝xiaoyxiao。
    if (label === "adobe2api" && model.kind === "video") continue;
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
    // 映射层落地点：supplier-adapter 用 `supplier.supplierModelId ?? input.modelId`
    // 决定发给上游的模型名。pixai 渠道必须写入 bridge 认的名字，其余渠道保持
    // null（同名直传）。服务类条目（pixai-edit/pixai-upscale/pixai-template）
    // 不是 bridge 的模型名，留 null 由路由自行决定 bridge 端点。
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

async function upsertCapability(
  sql: ReturnType<typeof getGenerationSql>,
  supplierId: string,
  capability: Capability,
  concurrencyLimit: number,
) {
  await sql.begin(async (tx) => {
    // 不筛 is_current：渠道可能曾认领后被 retireUnclaimed 收回（is_current=false
    // 留档）。只查在役行会让复活场景的 nextVersion 从 1 重算，撞历史行唯一约束。
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
        ${concurrencyLimit}, true
      )
    `;
  });
}

/**
 * 收回渠道已不再认领的 capability 行。
 *
 * 排障记录（2026-08-05）：seed 只做 upsert，从不撤销。收紧白名单后，
 * fallback/sub2api 名下那些 pixai capability 依然 `is_current = true`，
 * 调度器照样会命中它们 —— 白名单的修正等于没生效。撤销这一步是「认领范围
 * 收紧」真正落到调度结果上的环节。
 *
 * 用 is_current = false 而不是 DELETE：capability id 被 supplier_lease 与
 * generation_attempt 引用，历史记录必须留着。
 */
async function retireUnclaimedCapabilities(
  sql: ReturnType<typeof getGenerationSql>,
  supplierId: string,
  claimed: Capability[],
): Promise<number> {
  // 分隔符用空格：模型 ID 与 kind 都只含小写字母/数字/点/连字号，拼出来的键不会撞。
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
 * 仅新插入的 supplier / default account 写入并发。
 * 已存在行不在 ON CONFLICT 里覆盖 concurrency_limit。
 * dmc、xiaoyxiao、gway、miaowuai 新行默认 4。metaso 不再单独设 6。
 * pixai 新行上限 2；其余渠道维持 env 默认（1）。
 */
function channelConcurrency(label: string): number {
  if (label === NEWAPI_ROUTE_LABEL) return newApiConcurrency();
  if (label === "dmc" || label === "xiaoyxiao" || label === "gway" || label === "miaowuai") return 4;
  if (label === "pixai") return 2;
  return Math.max(1, Number(process.env.GENERATION_SUPPLIER_CONCURRENCY ?? 1));
}

async function main() {
  const sql = getGenerationSql();
  const channels = describeEnvChannels(process.env).filter((channel) => channel.configured && channel.endpoint);
  if (!channels.length) throw new Error("No configured Image Studio channels were found to seed.");
  const newApiBase = (process.env.NEWAPI_BASE_URL ?? "").trim().replace(/\/+$/, "");
  const newApiEnabled = (process.env.NEWAPI_ENABLED ?? "").trim().toLowerCase() === "true" && Boolean(newApiBase);
  if (newApiEnabled) {
    channels.push({
      id: `env:${NEWAPI_ROUTE_LABEL}`,
      label: NEWAPI_ROUTE_LABEL,
      configured: true,
      defaultEnabled: true,
      source: "NEWAPI_BASE_URL",
      usesBillingGateway: false,
      endpoint: { baseURL: newApiBase, apiKey: "", label: NEWAPI_ROUTE_LABEL },
    });
  }
  const seededIds: string[] = [];
  const seededClaims = new Set<string>();
  for (const channel of channels) {
    // 退役渠道（见 RETIRED_SUPPLIER_LABELS）：seed 不碰，避免把 DB 的停用态冲回。
    if (RETIRED_SUPPLIER_LABELS.has(channel.label)) {
      console.log(`[generation-seed] ${channel.label}: retired (video supply moved to xiaoyxiao), skipped`);
      continue;
    }
    // 已并入 env:newapi 的旧渠道：不再 seed，交给下方孤儿清扫停用。
    if (newApiEnabled && NEWAPI_MIGRATED_LABELS.has(channel.label)) {
      console.log(`[generation-seed] ${channel.label}: superseded by ${routeSupplierId(NEWAPI_ROUTE_LABEL)}, skipped`);
      continue;
    }
    const endpoint = channel.endpoint!;
    const id = channel.id;
    const accountId = `${id}:default`;
    const isAdobe = endpoint.protocol === "adobe2api";
    const isFilmera = endpoint.protocol === "filmera";
    const registry = registryChannel(channel.label);
    const channelConfig: Record<string, unknown> = { channelId: channel.id, source: channel.source };
    if (registry) {
      // adapter 据此把 chatImageModels 的上游模型改走 /chat/completions 生图。
      channelConfig.chatImageModels = registry.chatImageModels;
      // 上游拒收 quality 栏位的渠道（agnes：text image queue 契约）。
      if (registry.omitQualityBody) channelConfig.omitQualityBody = true;
    }
    const modelAliases = CHANNEL_MODEL_ALIASES[channel.label];
    if (modelAliases) channelConfig.modelAliases = { ...modelAliases };
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
        ${id}, ${channel.label}, ${isAdobe ? "adobe2api" : isFilmera ? "filmera" : registry?.adapter?.protocol ?? registry?.adapterType ?? "openai_images"}, ${tier(channel.label)},
        ${origin(endpoint.baseURL)}, ${endpoint.baseURL}, ${credentialRef(channel.label)}, ${channel.defaultEnabled},
        ${SUPPLIER_PRIORITY_UNUSED},
        ${channelConcurrency(channel.label)}, 1, 0,
        ${sql.json(channelConfig as never)}, 1
      )
      ON CONFLICT (id) DO UPDATE SET
        label = EXCLUDED.label, adapter_type = EXCLUDED.adapter_type, supply_tier = EXCLUDED.supply_tier,
        failure_domain = EXCLUDED.failure_domain, base_url = EXCLUDED.base_url,
        credential_ref = EXCLUDED.credential_ref, enabled = EXCLUDED.enabled,
        priority = EXCLUDED.priority,
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
          // healthPath 按 adapter 分派（片Y 稿 §D）：blender_bridge 节点走桥
          // /v1/health（README 契约：带 gpu/queue_depth），非 LOCAL（blender-modal，
          // 片X 对齐 pending）暂写 "health"；其余渠道维持 ADOBE2API_HEALTH_PATH
          // 写死点原行为。注意用 registry.adapterType 判定——registry 渠道的
          // endpoint 无 protocol 栏（registryChannelToDescriptor 不设），稿中
          // endpoint.protocol 条件对 registry 渠道恒 false，现场核实后改用 registry。
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
        configuration_json = EXCLUDED.configuration_json,
        updated_at = now()
    `;
    const capabilities = channelCapabilities(channel.label);
    const capabilityConcurrency = channel.label === NEWAPI_ROUTE_LABEL
      ? newApiConcurrency()
      : Math.max(1, Number(process.env.GENERATION_CAPABILITY_CONCURRENCY ?? 1));
    for (const capability of capabilities) {
      await upsertCapability(sql, id, capability, capabilityConcurrency);
      seededClaims.add(`${capability.modelId} ${channel.label}`);
    }
    seededIds.push(id);
    const retired = await retireUnclaimedCapabilities(sql, id, capabilities);
    console.log(
      `[generation-seed] ${channel.label}: ${capabilities.length} capability contracts`
      + (retired ? `, ${retired} stale contracts retired` : ""),
    );
  }

  // 孤儿清扫：本轮没 seed 到的 supplier（退役、已并入 newapi、env 已撤、config 已删）
  // 一律 enabled=false。过去 seed 只 upsert 不收尾，config 删掉的渠道在 DB 里永远开著
  //（2026-10-01 实录：env:dreamina 已无任何代码来源，仍以「healthy」排在 image-5-pro 第一位）。
  const swept = await sql<{ id: string }[]>`
    UPDATE supplier SET enabled = false, updated_at = now()
    WHERE enabled AND NOT (id = ANY(${seededIds}::text[]))
    RETURNING id
  `;
  if (swept.length) console.log(`[generation-seed] disabled orphan suppliers: ${swept.map((row) => row.id).join(", ")}`);

  // 路由自检：MODEL_ROUTES 里每一步都必须有本轮 seed 出的 capability，否则那一步永远选不中。
  for (const [modelId, route] of Object.entries(MODEL_ROUTES)) {
    for (const label of route) {
      if (!seededClaims.has(`${modelId} ${label}`)) {
        console.warn(`[generation-seed] route step ${modelId} → ${label} has no seeded capability (channel unconfigured/disabled or not claiming this model).`);
      }
    }
  }
  await closeGenerationSql();
}

main().catch(async (error) => {
  console.error("[generation-seed] failed", error);
  await closeGenerationSql();
  process.exitCode = 1;
});
