// 對外模型可用性探測（GET /v1/model-status 的純邏輯層）。
//
// 與 admin 的 channels/probe 同源但面向不同消費者：
// - channels/probe 探「單一渠道」是否連通（admin 手動點）。
// - 這裡探「每個生成模型」在生產隊列（buildModelQueue 第一順位端點）下的可用性，
//   讓對外 agent 一眼判斷哪個模型可用、能幹嘛、調哪個端點。
//
// 探測只發 GET {baseURL}/models（渠道的模型清單端點）——不觸發真實生成、不扣費。
// 誠實原則與 channels/probe 一致：某些渠道沒有 /models 端點，硬探只會恆紅騙人，
// 所以明確回報 unknown + note「不支持 /models 探测」而不是假裝探測失敗。
//
// env/pools/overrides/probeFn/now 全部可注入，測試不打真實網絡。

import {
  GENERATION_MODEL_IDS,
  generationCapabilities,
  isSupportedImageModel,
  type MediaKind,
} from "./generation-model-catalog";
import { PIXAI_EDIT_MODEL_ID, PIXAI_UPSCALE_MODEL_ID } from "./image-model-ids.js";
import { buildModelQueue, ENV_CHANNEL_PRIORITIES } from "./channel-registry";
import { REGISTRY_CHANNELS } from "./supplier-channels.config";
import type { AdminPool } from "./admin-pools";
import type { ChannelOverrides } from "./channel-overrides";
import type { EnvLike } from "./sub2api";

export type ModelAvailability = "available" | "unavailable" | "unknown";
export type ModelFunction = "generate" | "edit" | "upscale";
export type ModelMediaType = "image" | "video" | "audio";
export type GenerationEndpoint = "/v1/images/generations" | "/v1/videos/generations";

export interface ProbeEndpointInput {
  baseURL: string;
  apiKey: string;
  label: string;
}

export interface ProbeEndpointResult {
  ok: boolean;
  status?: number;
  ms: number;
  note?: string;
}

export interface ModelStatusEntry {
  id: string;
  media_type: ModelMediaType;
  endpoint: GenerationEndpoint;
  /** 該模型支援的功能：generate 恒有；edit/upscale 只標平台真實有該鏈路的模型。 */
  functions: ModelFunction[];
  availability: ModelAvailability;
  checked_at: string;
  /** 僅 available 時有值（探測成功才測得到延遲）。 */
  latency_ms?: number;
  channel_id?: string;
  /** unknown/unavailable 時給原因（誠實原則）。 */
  note?: string;
}

export interface ModelStatusSummary {
  total: number;
  available: number;
  unavailable: number;
  unknown: number;
  by_media_type: {
    image: { total: number; available: number };
    video: { total: number; available: number };
    audio: { total: number; available: number };
  };
}

export interface ModelStatusSnapshot {
  generated_at: string;
  probe: { method: "channel-models"; cached: boolean; duration_ms: number };
  models: ModelStatusEntry[];
  summary: ModelStatusSummary;
}

export interface ModelStatusProbeOptions {
  env?: EnvLike;
  pools?: AdminPool[];
  overrides?: ChannelOverrides;
  /** 最近 24h 真實表現統計（route 層裁決 availability 用；probe 本體不消費）。 */
  recentStats?: unknown[];
  probeFn?: (endpoint: ProbeEndpointInput) => Promise<ProbeEndpointResult>;
  now?: () => Date;
}

/** 渠道無 /models 能力的集合，與 channels/probe 的 UNPROBEABLE_CHANNEL_IDS 同源。 */
const UNPROBEABLE_CHANNEL_IDS = new Set<string>([]);
const PROBE_TIMEOUT_MS = 10_000;
/** 探測結果緩存 60 秒：避免每次請求都打所有上游。 */
const CACHE_TTL_MS = 60_000;
/** 平行探測的並發上限：20+ 個模型串行太慢，全開又可能打爆上游。 */
const PROBE_CONCURRENCY = 5;
const CACHE_KEY = "all";

const cache = new Map<string, { expiresAt: number; snapshot: ModelStatusSnapshot }>();

/** 僅供測試：清空模組級緩存。 */
export function __resetModelStatusCacheForTests(): void {
  cache.clear();
}

/**
 * 功能標註（數據驅動，不硬編假能力）：
 * - generate 恒有。
 * - edit：registry claims 宣稱 image_edit 的模型（2026-09-13 起 B 端
 *   /v1/images/edits 已接 durable 改圖管線）＋平台改圖鏈路 PIXAI_EDIT_MODEL_ID。
 *   與調度事實源同源：標了 edit 的模型，capability 預檢才有行可查。
 * - upscale：只有平台真實的放大鏈路模型（PIXAI_UPSCALE_MODEL_ID，走 /v1/upscale）才標。
 * - video 模型一律不含 edit/upscale（除非真有）。
 */
const EDIT_CLAIM_MODEL_IDS = new Set(
  REGISTRY_CHANNELS.flatMap((channel) => channel.claims)
    .filter((claim) => claim.kinds.includes("image_edit"))
    .map((claim) => claim.modelId),
);

export function annotateModelFunctions(modelId: string, mediaType: MediaKind): ModelFunction[] {
  const functions: ModelFunction[] = ["generate"];
  if (mediaType !== "image") return functions;
  if (modelId === PIXAI_EDIT_MODEL_ID || EDIT_CLAIM_MODEL_IDS.has(modelId)) functions.push("edit");
  if (modelId === PIXAI_UPSCALE_MODEL_ID) functions.push("upscale");
  return functions;
}

/** 預設探測實作：對 {baseURL}/models 發 GET（Bearer、10 秒超時、no-store）。 */
export async function probeEndpointModels(endpoint: ProbeEndpointInput): Promise<ProbeEndpointResult> {
  const startedAt = Date.now();
  try {
    const response = await fetch(`${endpoint.baseURL}/models`, {
      headers: { Authorization: `Bearer ${endpoint.apiKey}` },
      cache: "no-store",
      signal: AbortSignal.timeout(PROBE_TIMEOUT_MS),
    });
    const ms = Date.now() - startedAt;
    if (!response.ok) {
      return { ok: false, status: response.status, ms, note: `上游返回 HTTP ${response.status}` };
    }
    return { ok: true, status: response.status, ms };
  } catch (error) {
    const ms = Date.now() - startedAt;
    const note = error instanceof Error && error.name === "TimeoutError" ? "连接超时（10 秒）" : "无法连接上游";
    return { ok: false, ms, note };
  }
}

/** 把 GatewayEndpoint.label 對回渠道 id（env:sub2api / 池名）。 */
function channelIdFromEndpointLabel(label: string): string {
  if (label in ENV_CHANNEL_PRIORITIES) return `env:${label}`;
  return label; // admin 池：池名即渠道 id
}

function mediaTypeFor(modelId: string): ModelMediaType {
  const capabilities = generationCapabilities(modelId);
  if (capabilities) return capabilities.mediaType;
  return isSupportedImageModel(modelId) ? "image" : "video";
}

/**
 * 單一模型的可用性探測（不經緩存，供測試直接調用）。
 * 隊列取 buildModelQueue 的第一順位端點——與真實生成路由同源。
 */
export async function probeModelStatus(
  modelId: string,
  options: ModelStatusProbeOptions = {},
): Promise<ModelStatusEntry> {
  const env = options.env ?? process.env;
  const pools = options.pools ?? [];
  const overrides = options.overrides ?? {};
  const probeFn = options.probeFn ?? probeEndpointModels;
  const now = options.now ?? (() => new Date());

  const mediaType = mediaTypeFor(modelId);
  const endpoint: GenerationEndpoint = mediaType === "video" ? "/v1/videos/generations" : "/v1/images/generations";
  const functions = annotateModelFunctions(modelId, mediaType);
  const base = {
    id: modelId,
    media_type: mediaType,
    endpoint,
    functions,
    checked_at: now().toISOString(),
  };

  const queue = buildModelQueue(modelId, env, pools, overrides);
  if (queue.length === 0) {
    return { ...base, availability: "unavailable" as const, note: "无可用渠道" };
  }

  // 按隊列順位逐個探，任一渠道通即 available——與真實生成的 failover 同源。
  // 只探第一順位會把「主渠道封 IP、備用渠道健在」誤判成整個模型不可用
  // （2026-10-02 事故：xiaoyxiao nginx 對 VPS IP 全路徑 403，gway 備用正常，
  // 4 個視頻模型全被報 unavailable，agent 誤以為影片通道全滅）。
  const failures: string[] = [];
  let unprobeableChannelId: string | undefined;
  for (const endpoint of queue) {
    const channelId = channelIdFromEndpointLabel(endpoint.label);
    if (UNPROBEABLE_CHANNEL_IDS.has(channelId)) {
      unprobeableChannelId ??= channelId;
      continue;
    }
    const result = await probeFn({ baseURL: endpoint.baseURL, apiKey: endpoint.apiKey, label: endpoint.label });
    if (result.ok) {
      const entry = { ...base, availability: "available" as const, channel_id: channelId, latency_ms: result.ms };
      return failures.length > 0 ? { ...entry, note: `主渠道不可达，已由备用渠道承接（${failures.join("；")}）` } : entry;
    }
    failures.push(`${channelId}: ${result.note ?? "上游不可达"}`);
  }

  if (unprobeableChannelId) {
    return { ...base, availability: "unknown" as const, channel_id: unprobeableChannelId, note: "不支持 /models 探测" };
  }
  return {
    ...base,
    availability: "unavailable" as const,
    channel_id: channelIdFromEndpointLabel(queue[0].label),
    note: `全部 ${queue.length} 个渠道不可达（${failures.join("；")}）`,
  };
}

function computeSummary(models: ModelStatusEntry[]): ModelStatusSummary {
  const byMediaType: ModelStatusSummary["by_media_type"] = {
    image: { total: 0, available: 0 },
    video: { total: 0, available: 0 },
    audio: { total: 0, available: 0 },
  };
  let available = 0;
  let unavailable = 0;
  let unknown = 0;
  for (const model of models) {
    const bucket = byMediaType[model.media_type];
    bucket.total += 1;
    if (model.availability === "available") {
      bucket.available += 1;
      available += 1;
    } else if (model.availability === "unavailable") {
      unavailable += 1;
    } else {
      unknown += 1;
    }
  }
  return { total: models.length, available, unavailable, unknown, by_media_type: byMediaType };
}

/** 帶並發上限的 map（Promise.all 的受限版，避免 20+ 上游同時被打）。 */
async function mapLimit<T, R>(items: readonly T[], limit: number, fn: (item: T) => Promise<R>): Promise<R[]> {
  const results: R[] = new Array(items.length);
  let next = 0;
  const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (next < items.length) {
      const index = next;
      next += 1;
      results[index] = await fn(items[index]);
    }
  });
  await Promise.all(workers);
  return results;
}

/**
 * 全部生成模型（image+video，與 /v1/models 同源清單）的可用性快照。
 * 模組級緩存 60 秒：第二次調用直接回 cached=true 的快照，不重探。
 */
export async function probeAllModelsStatus(options: ModelStatusProbeOptions = {}): Promise<ModelStatusSnapshot> {
  const env = options.env ?? process.env;
  const pools = options.pools ?? [];
  const overrides = options.overrides ?? {};
  const probeFn = options.probeFn ?? probeEndpointModels;
  const now = options.now ?? (() => new Date());

  const cached = cache.get(CACHE_KEY);
  if (cached && cached.expiresAt > now().getTime()) {
    return { ...cached.snapshot, probe: { ...cached.snapshot.probe, cached: true } };
  }

  const startedAt = Date.now();
  const modelIds = [...new Set(GENERATION_MODEL_IDS)];
  const models = await mapLimit(modelIds, PROBE_CONCURRENCY, (modelId) =>
    probeModelStatus(modelId, { env, pools, overrides, probeFn, now }),
  );
  const durationMs = Date.now() - startedAt;

  const snapshot: ModelStatusSnapshot = {
    generated_at: now().toISOString(),
    probe: { method: "channel-models", cached: false, duration_ms: durationMs },
    models,
    summary: computeSummary(models),
  };
  cache.set(CACHE_KEY, { expiresAt: now().getTime() + CACHE_TTL_MS, snapshot });
  return snapshot;
}
