// 对外模型可用性探测（GET /v1/model-status 的纯逻辑层）。
//
// 与 admin 的 channels/probe 同源但面向不同消费者：
// - channels/probe 探「单一渠道」是否连通（admin 手动点）。
// - 这里探「每个生成模型」在生产队列（buildModelQueue 第一顺位端点）下的可用性，
//   让对外 agent 一眼判断哪个模型可用、能干嘛、调哪个端点。
//
// 探测只发 GET {baseURL}/models（渠道的模型清单端点）——不触发真实生成、不扣费。
// 诚实原则与 channels/probe 一致：某些渠道没有 /models 端点，硬探只会恒红骗人，
// 所以明确回报 unknown + note「不支持 /models 探测」而不是假装探测失败。
//
// env/pools/overrides/probeFn/now 全部可注入，测试不打真实网络。

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
  /** /models 回应里的模型 id 清单；回应不是 OpenAI 清单格式时为 undefined。 */
  modelIds?: string[];
}

export interface ModelStatusEntry {
  id: string;
  media_type: ModelMediaType;
  endpoint: GenerationEndpoint;
  /** 该模型支援的功能：generate 恒有；edit/upscale 只标平台真实有该链路的模型。 */
  functions: ModelFunction[];
  availability: ModelAvailability;
  checked_at: string;
  /** 仅 available 时有值（探测成功才测得到延迟）。 */
  latency_ms?: number;
  channel_id?: string;
  /** unknown/unavailable 时给原因（诚实原则）。 */
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
  /** 最近 24h 真实表现统计（route 层裁决 availability 用；probe 本体不消费）。 */
  recentStats?: unknown[];
  probeFn?: (endpoint: ProbeEndpointInput) => Promise<ProbeEndpointResult>;
  now?: () => Date;
}

/** 渠道无 /models 能力的集合，与 channels/probe 的 UNPROBEABLE_CHANNEL_IDS 同源。 */
const UNPROBEABLE_CHANNEL_IDS = new Set<string>([]);
const PROBE_TIMEOUT_MS = 10_000;
/** 探测结果缓存 60 秒：避免每次请求都打所有上游。 */
const CACHE_TTL_MS = 60_000;
/** 平行探测的并发上限：20+ 个模型串行太慢，全开又可能打爆上游。 */
const PROBE_CONCURRENCY = 5;
const CACHE_KEY = "all";

const cache = new Map<string, { expiresAt: number; snapshot: ModelStatusSnapshot }>();

/** 仅供测试：清空模组级缓存。 */
export function __resetModelStatusCacheForTests(): void {
  cache.clear();
}

/**
 * 功能标注（数据驱动，不硬编假能力）：
 * - generate 恒有。
 * - edit：registry claims 宣称 image_edit 的模型（2026-09-13 起 B 端
 *   /v1/images/edits 已接 durable 改图管线）＋平台改图链路 PIXAI_EDIT_MODEL_ID。
 *   与调度事实源同源：标了 edit 的模型，capability 预检才有行可查。
 * - upscale：只有平台真实的放大链路模型（PIXAI_UPSCALE_MODEL_ID，走 /v1/upscale）才标。
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

/** 预设探测实作：对 {baseURL}/models 发 GET（Bearer、10 秒超时、no-store）。 */
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
    const payload = (await response.json().catch(() => null)) as { data?: Array<{ id?: unknown }> } | null;
    const modelIds = Array.isArray(payload?.data)
      ? payload.data.map((model) => model?.id).filter((id): id is string => typeof id === "string")
      : undefined;
    return { ok: true, status: response.status, ms, modelIds };
  } catch (error) {
    const ms = Date.now() - startedAt;
    const note = error instanceof Error && error.name === "TimeoutError" ? "连接超时（10 秒）" : "无法连接上游";
    return { ok: false, ms, note };
  }
}

/**
 * 该渠道上这个模型的上游模型名（registry claims；null＝同名直传）。非 registry 渠道（admin 池）
 * 回 undefined——没有 claim 就无从核对清单，只看 /models 是否 200。
 */
function expectedSupplierModelId(label: string, modelId: string): string | undefined {
  const claim = REGISTRY_CHANNELS.find((channel) => channel.label === label)?.claims.find(
    (candidate) => candidate.modelId === modelId,
  );
  if (!claim) return undefined;
  return claim.supplierModelId ?? modelId;
}

/** 把 GatewayEndpoint.label 对回渠道 id（env:sub2api / 池名）。 */
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
 * 单一模型的可用性探测（不经缓存，供测试直接调用）。
 * 队列取 buildModelQueue 的第一顺位端点——与真实生成路由同源。
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

  // 按队列顺位逐个探，任一渠道通即 available——与真实生成的 failover 同源。
  // 只探第一顺位会把「主渠道封 IP、备用渠道健在」误判成整个模型不可用
  // （2026-10-02 事故：xiaoyxiao nginx 对 VPS IP 全路径 403，gway 备用正常，
  // 4 个视频模型全被报 unavailable，agent 误以为影片通道全灭）。
  const failures: string[] = [];
  let unprobeableChannelId: string | undefined;
  // note 是对外字串，禁止内嵌渠道 id（env:xxx／池名／endpoint 名）——对外只用
  // 非标识的 queue 序号（渠道1／渠道2）区隔多笔失败，避免泄漏内部供应商识别资讯。
  let queuePosition = 0;
  for (const endpoint of queue) {
    queuePosition += 1;
    const channelId = channelIdFromEndpointLabel(endpoint.label);
    if (UNPROBEABLE_CHANNEL_IDS.has(channelId)) {
      unprobeableChannelId ??= channelId;
      continue;
    }
    const result = await probeFn({ baseURL: endpoint.baseURL, apiKey: endpoint.apiKey, label: endpoint.label });
    // /models 200 ≠ 有这个模型（2026-10-02 hublinuxdo 实锤：200 但清单 20 个全是 LLM、零生图模型，
    // gpt-image-2 等被报 available）。registry 有 claim 的渠道必须在清单里看到上游模型名才算通。
    const expected = expectedSupplierModelId(endpoint.label, modelId);
    if (result.ok && expected && !result.modelIds?.includes(expected)) {
      failures.push(
        `渠道${queuePosition}: ${result.modelIds ? `/models 未列出上游模型 ${expected}` : "/models 回应不是模型清单，无法核对"}`,
      );
      continue;
    }
    if (result.ok) {
      const entry = { ...base, availability: "available" as const, channel_id: channelId, latency_ms: result.ms };
      return failures.length > 0 ? { ...entry, note: `主渠道不可达，已由备用渠道承接（${failures.join("；")}）` } : entry;
    }
    failures.push(`渠道${queuePosition}: ${result.note ?? "上游不可达"}`);
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

/** 带并发上限的 map（Promise.all 的受限版，避免 20+ 上游同时被打）。 */
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
 * 全部生成模型（image+video，与 /v1/models 同源清单）的可用性快照。
 * 模组级缓存 60 秒：第二次调用直接回 cached=true 的快照，不重探。
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
