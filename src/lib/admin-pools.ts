import type { GatewayEndpoint } from "./sub2api";
import {
  DEFAULT_IMAGE_MODEL_ID,
  NANO_BANANA_2_MODEL_ID,
  SUPPORTED_GENERATION_MODEL_IDS,
} from "./image-model-ids.js";

export type AdminPoolKind = "sub2api" | "relay"; // sub2api is retained for previously saved relay entries.

export interface AdminPool {
  id: string;
  kind: AdminPoolKind;
  name: string;
  baseURL: string;
  apiKey: string;
  modelId?: string;
  supportedModels?: string[];
  enabled: boolean;
  priority: number;
  createdAt: number;
  updatedAt: number;
}

export interface PublicAdminPool extends Omit<AdminPool, "apiKey" | "supportedModels"> {
  supportedModels: string[];
  maskedApiKey: string;
  hasApiKey: boolean;
}

export interface EnvironmentEndpointSummary {
  name: string;
  baseURL: string;
  modelId?: string;
  supportedModels: string[];
  priority: number;
}

export interface NormalizedPoolDraft {
  kind: AdminPoolKind;
  name: string;
  baseURL: string;
  apiKey: string;
  supportedModels: string[];
  enabled: boolean;
  priority: number;
}

function requiredString(value: unknown, label: string, maxLength: number): string {
  if (typeof value !== "string" || !value.trim()) throw new Error(`${label}不能为空。`);
  const result = value.trim();
  if (result.length > maxLength) throw new Error(`${label}过长。`);
  return result;
}

function normalizePoolBaseURL(value: unknown): string {
  const input = requiredString(value, "Base URL", 300).replace(/\/+$/, "");
  let url: URL;
  try {
    url = new URL(input);
  } catch {
    throw new Error("Base URL 格式不正确。");
  }
  if (!new Set(["http:", "https:"]).has(url.protocol) || url.username || url.password || url.search || url.hash) {
    throw new Error("Base URL 只支持不含账号、参数和片段的 HTTP(S) 地址。");
  }
  return url.toString().replace(/\/+$/, "");
}

export function normalizePoolDraft(input: Record<string, unknown>, existingApiKey = ""): NormalizedPoolDraft {
  if (input.kind !== "relay") throw new Error("这里只支持 Base URL + API Key 中转渠道。");
  const apiKey = typeof input.apiKey === "string" && input.apiKey.trim()
    ? input.apiKey.trim()
    : existingApiKey;
  if (!apiKey) throw new Error("API Key 不能为空。");
  if (apiKey.length > 500) throw new Error("API Key 过长。");

  const supportedModels = Array.isArray(input.supportedModels)
    ? [...new Set(input.supportedModels.filter((model): model is string => typeof model === "string" && isSupportedGenerationModelId(model)))]
    : inferSupportedModels({ name: String(input.name ?? ""), modelId: typeof input.modelId === "string" ? input.modelId : undefined });
  if (supportedModels.length === 0) throw new Error("至少选择一个支持模型。");
  const priority = Number(input.priority ?? 50);
  if (!Number.isInteger(priority) || priority < 1 || priority > 99) throw new Error("优先级必须是 1 到 99 的整数。");

  return {
    kind: input.kind,
    name: requiredString(input.name, "名称", 40),
    baseURL: normalizePoolBaseURL(input.baseURL),
    apiKey,
    supportedModels,
    enabled: input.enabled !== false,
    priority,
  };
}

export function maskPoolApiKey(apiKey: string): string {
  return apiKey.length <= 8 ? "*".repeat(apiKey.length) : `${apiKey.slice(0, 4)}${"*".repeat(10)}${apiKey.slice(-4)}`;
}

export function toPublicAdminPool(pool: AdminPool): PublicAdminPool {
  const { apiKey, ...safe } = pool;
  return { ...safe, supportedModels: inferSupportedModels(pool), maskedApiKey: maskPoolApiKey(apiKey), hasApiKey: Boolean(apiKey) };
}

function isSupportedGenerationModelId(modelId: string): boolean {
  return SUPPORTED_GENERATION_MODEL_IDS.includes(modelId as (typeof SUPPORTED_GENERATION_MODEL_IDS)[number]);
}

export function inferSupportedModels(input: { name?: string; modelId?: string; supportedModels?: string[] }): string[] {
  const explicit = input.supportedModels?.filter(isSupportedGenerationModelId);
  if (explicit?.length) return [...new Set(explicit)];
  if (input.modelId && isSupportedGenerationModelId(input.modelId)) return [input.modelId];
  const hint = `${input.name ?? ""} ${input.modelId ?? ""}`.toLowerCase();
  if (hint.includes("banana") || hint.includes("gemini")) return [NANO_BANANA_2_MODEL_ID];
  if (hint.includes("sub2api") || hint.includes("gpt") || hint.includes("openai")) return [DEFAULT_IMAGE_MODEL_ID];
  if (input.modelId) return [DEFAULT_IMAGE_MODEL_ID];
  return [DEFAULT_IMAGE_MODEL_ID];
}

export function environmentEndpointPriority(endpoint: GatewayEndpoint, index: number): number {
  if (endpoint.label === "sub2api") return 0;
  return endpoint.label === "fallback" ? 90 : Math.min(89, 50 + index);
}

export function summarizeEnvironmentEndpoints(endpoints: GatewayEndpoint[]): EnvironmentEndpointSummary[] {
  return endpoints.map((endpoint, index) => ({
    name: endpoint.label,
    baseURL: endpoint.baseURL,
    ...(endpoint.modelId ? { modelId: endpoint.modelId } : {}),
    supportedModels: inferSupportedModels(endpoint),
    priority: environmentEndpointPriority(endpoint, index),
  }));
}

export function buildGatewayEndpointsWithPools(
  pools: AdminPool[],
  environmentEndpoints: GatewayEndpoint[],
  requestedModelId: string,
  /**
   * Fixed per-label priorities from the channel registry (admin overrides included).
   * Without this, env priorities derive from the array index (50 + index), so merely
   * filtering out a disabled channel would shift every later channel's priority — the
   * displayed number and the effective number would disagree, which is the exact
   * display-vs-production split this refactor exists to kill.
   */
  environmentPriorities?: Partial<Record<string, number>>,
): GatewayEndpoint[] {
  const managed = pools
    .filter((pool) => pool.enabled && inferSupportedModels(pool).includes(requestedModelId))
    .map((pool) => ({
      endpoint: {
        baseURL: pool.baseURL,
        apiKey: pool.apiKey,
        label: pool.name,
        supportedModels: inferSupportedModels(pool),
      } satisfies GatewayEndpoint,
      priority: pool.priority,
      source: 0,
      order: pool.createdAt,
    }));
  const environment = environmentEndpoints
    .map((endpoint, index) => ({
      endpoint: { ...endpoint, supportedModels: inferSupportedModels(endpoint) },
      priority: environmentPriorities?.[endpoint.label] ?? environmentEndpointPriority(endpoint, index),
      source: 1,
      order: index,
    }))
    .filter((item) => item.endpoint.supportedModels.includes(requestedModelId));
  const seen = new Set<string>();
  return [...managed, ...environment]
    .sort((a, b) => a.priority - b.priority || a.source - b.source || a.order - b.order)
    .filter(({ endpoint }) => {
      const key = `${endpoint.baseURL}\0${endpoint.apiKey}`;
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    })
    .map(({ endpoint }, index) => ({ ...endpoint, isFallback: index > 0 }));
}
