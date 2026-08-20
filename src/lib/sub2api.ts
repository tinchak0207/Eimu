export interface GatewayEndpoint {
  apiKey: string;
  baseURL: string;
  label: string;
  modelId?: string;
  supportedModels?: string[];
  protocol?: "adobe2api" | "pixai" | "sensenova";
  isFallback?: boolean;
}

export type EnvLike = Record<string, string | undefined>;
export const LOCAL_TEST_MODE = process.env.NEXT_PUBLIC_LOCAL_TEST_MODE === "true";
import { ADOBE2API_MODEL_IDS } from "./image-model-ids.js";
import {
  PIXAI_HARUKA_V2_MODEL_ID,
  PIXAI_HOSHINO_V2_MODEL_ID,
  PIXAI_REFERENCE_PRO_MODEL_ID,
  PIXAI_TSUBAKI2_MODEL_ID,
  PIXAI_TSUBAKI_V11_MODEL_ID,
} from "./image-model-ids.js";

export const PIXAI_MODEL_IDS = [
  PIXAI_TSUBAKI2_MODEL_ID,
  PIXAI_HARUKA_V2_MODEL_ID,
  PIXAI_REFERENCE_PRO_MODEL_ID,
  PIXAI_TSUBAKI_V11_MODEL_ID,
  PIXAI_HOSHINO_V2_MODEL_ID,
];

function cleanEnvValue(value: string): string {
  return value.replace(/^\uFEFF+/, "").trim();
}

function normalizeBaseURL(baseURL: string): string {
  return cleanEnvValue(baseURL).replace(/\/+$/, "");
}

function normalizeAdobe2ApiBaseURL(baseURL: string): string {
  const normalized = normalizeBaseURL(baseURL);
  if (!normalized) return "";
  return /\/v1$/i.test(normalized) ? normalized : `${normalized}/v1`;
}

export function sub2APIImageGroupId(env: EnvLike): number | null {
  const groupId = Number(cleanEnvValue(env.SUB2API_IMAGE_GROUP_ID ?? ""));
  return Number.isInteger(groupId) && groupId > 0 ? groupId : null;
}

/**
 * 生成開關的唯一判定。舊實作是未清洗的 `env.SUB2API_ENABLED === "true"`：
 * 經 stdin 添加的 env 常帶結尾換行（"true\n"），BOM/大小寫變體同理——開關
 * 靜默失效，sub2api 整條退出隊列，賬號池全部 "never used" 而各層面板照樣
 * 全綠。與 base URL/key 相同標準清洗後再比對；"1"/"yes" 等值仍視為關閉。
 */
export function sub2apiSwitchedOn(env: EnvLike): boolean {
  return cleanEnvValue(env.SUB2API_ENABLED ?? "").toLowerCase() === "true";
}

export async function probeSub2APIGateway(endpoint: GatewayEndpoint): Promise<boolean> {
  try {
    const response = await fetch(`${endpoint.baseURL}/models`, {
      headers: { Authorization: `Bearer ${endpoint.apiKey}` },
      cache: "no-store",
      signal: AbortSignal.timeout(10_000),
    });
    return response.ok;
  } catch {
    return false;
  }
}

export type EnvChannelLabel = "adobe2api" | "sub2api" | "primary" | "fallback" | "pixai";

export interface EnvChannelDescriptor {
  id: `env:${EnvChannelLabel}`;
  label: EnvChannelLabel;
  /** Both a base URL and a key are present after BOM/whitespace cleanup. */
  configured: boolean;
  /**
   * What production does with zero admin overrides. This is where the historical
   * SUB2API_ENABLED trap lived: the raw value had to be exactly "true", so a stray
   * newline/BOM/case variant silently disabled sub2api (now normalized via
   * sub2apiSwitchedOn; non-true words like "1" still mean off). While sub2api is
   * enabled the primary relay is default-off (they are alternatives for the same
   * slot). Enumerating BOTH — instead of collapsing them the way the old builder
   * did — is what lets an admin override flip between them without a deploy.
   */
  defaultEnabled: boolean;
  /** The env var that actually won the ?? chain, for honest display in /admin. */
  source: string;
  /** True when the winning base URL is GATEWAY_BASE_URL — the billing gateway moonlighting as an image relay. */
  usesBillingGateway: boolean;
  endpoint: GatewayEndpoint | null;
}

function pickEnvSource(env: EnvLike, names: string[]): { value: string; source: string } {
  for (const name of names) {
    const raw = env[name];
    if (raw !== undefined) return { value: raw, source: name };
  }
  return { value: "", source: names[0] };
}

/**
 * Single construction source for every env-derived channel, configured or not.
 * `buildGatewayEndpoints` (production default queue) and the admin channel registry
 * both derive from this — if they ever disagree about what an env channel is, the
 * disagreement can only live here, in one place.
 */
export function describeEnvChannels(env: EnvLike): EnvChannelDescriptor[] {
  const adobe2apiBase = normalizeAdobe2ApiBaseURL(env.ADOBE2API_BASE_URL ?? "");
  const adobe2apiKey = cleanEnvValue(env.ADOBE2API_API_KEY ?? "");
  const adobe2apiConfigured = Boolean(adobe2apiBase && adobe2apiKey);
  const adobe2apiEnabled = cleanEnvValue(env.ADOBE2API_ENABLED ?? "").toLowerCase() === "true";

  const sub2apiBase = normalizeBaseURL(env.SUB2API_BASE_URL ?? "");
  const sub2apiKey = cleanEnvValue(env.SUB2API_API_KEY ?? "");
  const sub2apiConfigured = Boolean(sub2apiBase && sub2apiKey);
  const sub2apiEnabled = sub2apiSwitchedOn(env);

  const primaryBase = pickEnvSource(env, ["IMAGE_API_BASE_URL", "IMAGE_API_BASE_URL_PRIMARY", "GATEWAY_BASE_URL"]);
  const primaryKey = pickEnvSource(env, ["IMAGE_API_KEY", "IMAGE_API_KEY_PRIMARY", "GATEWAY_API_KEY"]);
  const primaryModelId = env.IMAGE_API_MODEL ?? env.IMAGE_API_MODEL_PRIMARY;
  const primaryConfigured = Boolean(normalizeBaseURL(primaryBase.value) && cleanEnvValue(primaryKey.value));

  const fallbackBase = normalizeBaseURL(env.IMAGE_API_BASE_URL_FALLBACK ?? "");
  // Checked on the cleaned value: the old builder tested the raw string here but then
  // filtered on the cleaned one in the primary branch, so a whitespace-only key produced
  // an endpoint in one branch and nothing in the other. Cleaned-check both ways.
  const fallbackConfigured = Boolean(fallbackBase && cleanEnvValue(env.IMAGE_API_KEY_FALLBACK ?? ""));

  const pixaiBase = normalizeBaseURL(env.PIXAI_BASE_URL ?? "");
  const pixaiKey = cleanEnvValue(env.PIXAI_API_KEY ?? "");
  const pixaiConfigured = Boolean(pixaiBase && pixaiKey);

  return [
    {
      id: "env:adobe2api",
      label: "adobe2api",
      configured: adobe2apiConfigured,
      defaultEnabled: adobe2apiConfigured && adobe2apiEnabled,
      source: "ADOBE2API_BASE_URL",
      usesBillingGateway: false,
      endpoint: adobe2apiConfigured
        ? {
            baseURL: adobe2apiBase,
            apiKey: adobe2apiKey,
            label: "adobe2api",
            protocol: "adobe2api",
            supportedModels: [...ADOBE2API_MODEL_IDS],
          }
        : null,
    },
    {
      id: "env:sub2api",
      label: "sub2api",
      configured: sub2apiConfigured,
      defaultEnabled: sub2apiConfigured && sub2apiEnabled,
      source: "SUB2API_BASE_URL",
      usesBillingGateway: false,
      endpoint: sub2apiConfigured ? { baseURL: sub2apiBase, apiKey: sub2apiKey, label: "sub2api" } : null,
    },
    {
      id: "env:primary",
      label: "primary",
      configured: primaryConfigured,
      // The primary relay is the alternative to sub2api for the same slot: default-on
      // only while sub2api is switched off. An admin override can enable both.
      defaultEnabled: primaryConfigured && !sub2apiEnabled,
      source: primaryBase.source,
      usesBillingGateway: primaryBase.source === "GATEWAY_BASE_URL",
      endpoint: primaryConfigured
        ? {
            baseURL: normalizeBaseURL(primaryBase.value),
            apiKey: cleanEnvValue(primaryKey.value),
            label: "primary",
            ...(primaryModelId ? { modelId: cleanEnvValue(primaryModelId) } : {}),
          }
        : null,
    },
    {
      id: "env:fallback",
      label: "fallback",
      configured: fallbackConfigured,
      defaultEnabled: fallbackConfigured,
      source: "IMAGE_API_BASE_URL_FALLBACK",
      usesBillingGateway: false,
      endpoint: fallbackConfigured
        ? {
            baseURL: fallbackBase,
            apiKey: cleanEnvValue(env.IMAGE_API_KEY_FALLBACK ?? ""),
            label: "fallback",
            ...(env.IMAGE_API_MODEL_FALLBACK ? { modelId: cleanEnvValue(env.IMAGE_API_MODEL_FALLBACK) } : {}),
          }
        : null,
    },
    {
      id: "env:pixai",
      label: "pixai",
      configured: pixaiConfigured,
      defaultEnabled: pixaiConfigured,
      source: "PIXAI_BASE_URL",
      usesBillingGateway: false,
      endpoint: pixaiConfigured
        ? {
            baseURL: pixaiBase,
            apiKey: pixaiKey,
            label: "pixai",
            protocol: "pixai",
            supportedModels: [...PIXAI_MODEL_IDS],
          }
        : null,
    },
  ];
}

export function buildGatewayEndpoints(env: EnvLike): GatewayEndpoint[] {
  return describeEnvChannels(env)
    .filter((channel) => channel.defaultEnabled && channel.endpoint)
    .map((channel) => channel.endpoint as GatewayEndpoint);
}

export function shouldBypassAuthForLocalTest(env: EnvLike): boolean {
  return env.NEXT_PUBLIC_LOCAL_TEST_MODE === "true";
}
