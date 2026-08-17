// 渠道註冊表：整個生圖系統的「隊列真相」只能從這裡產生。
//
// 在此之前，隊列邏輯散在四處各自為戰：generate-images 路由（env 端點 + 池合併 +
// 專用分支）、biz-image-pipeline（同一套邏輯的手工拷貝，外加自己一份
// 冷卻記憶）、admin 的 image-upstream-probe（直接調 buildGatewayEndpoints，admin
// 停用了渠道它照樣打）、account-pools 的 routing 診斷（又一份）。/admin 顯示的
// 隊列與生產實際使用的隊列因此可以各說各話——這正是本模組要消滅的病。
//
// 三條硬性質：
//  1. 單一事實來源：所有消費者（user 管線、biz 管線、admin 預覽、探測）都必須
//     透過 buildModelQueue 取得隊列，輸入相同則輸出相同。
//  2. 可控：admin overrides 能啟停/調序 env 渠道（池有自己的 CRUD，
//     不重複管轄），不需要改 env 重新部署。
//  3. 誠實：describeChannels 枚舉「全部」渠道——包含未配置的與被停用的——
//     並標明每一項數值的來源；未配置的渠道顯示為未配置，而不是隱形。

import {
  describeEnvChannels,
  type EnvChannelDescriptor,
  type EnvLike,
  type GatewayEndpoint,
} from "./sub2api";
import { buildGatewayEndpointsWithPools, inferSupportedModels, type AdminPool } from "./admin-pools";
import type { ChannelOverrides } from "./channel-overrides";


/**
 * env 渠道的固定基準優先級。
 *
 * 舊實作用「陣列索引 + 50」現場推算，於是過濾掉一個渠道會讓後面每個渠道的
 * 優先級整體漂移——admin 看到的數字與生產生效的數字對不上。固定常數讓數字
 * 可顯示、可覆寫、且與清單順序徹底解耦。
 *
 * 與舊索引推算的唯一已知偏差：firefly 未配置時 primary 舊值是 50（索引 0），
 * 現在恆為 51——只影響「池優先級恰好是 51 且 firefly 未配置」這一個邊角的
 * 平手判定（池因 source 序仍勝出，與池=50 時的行為一致）。
 */
export const ENV_CHANNEL_PRIORITIES: Record<string, number> = {
  sub2api: 0,
  // Keep Adobe's direct partner-model channel at the same top priority as the
  // account scheduler. describeEnvChannels lists it first, so stable sorting
  // selects the compatible direct route before Sub2API can return an account
  // availability error for the same model.
  adobe2api: 0,
  pixai: 30,
  primary: 51,
  fallback: 90,
};

export interface ChannelDescriptor {
  id: string;
  kind: "env" | "pool";
  label: string;
  /** host + path，永不含 key。 */
  host: string;
  configured: boolean;
  /** 零 overrides 時生產的預設行為。 */
  defaultEnabled: boolean;
  /** 套用 overrides 後的生效狀態——這就是 buildModelQueue 實際遵守的值。 */
  enabled: boolean;
  basePriority: number;
  priority: number;
  supportedModels: string[];
  /** 人話說明配置來源（哪個 env 變數勝出 / admin 池）。 */
  source: string;
  /** 勝出的 base URL 是計費閘道 GATEWAY_BASE_URL——兼職生圖，值得警示。 */
  usesBillingGateway: boolean;
  overridden: { enabled: boolean; priority: boolean };
  /** 本 lambda 實例的冷卻狀態——per-instance，不代表其他實例。 */
  coolingDown: boolean;
}

export function safeEndpointHost(baseURL: string): string {
  try {
    const url = new URL(baseURL);
    return `${url.host}${url.pathname.replace(/\/+$/, "")}`;
  } catch {
    return "invalid-url";
  }
}

/**
 * 對外回應的通道標籤：只透露「是否走了回退通道」，不透露具體供應商名。
 * 內部 label（adobe2api / sub2api / admin 池名等）一律歸一成
 * "primary"，避免客戶端從回應體拼出上游供應鏈。前端只依賴
 * `endpointLabel === "fallback"` 這一個值，因此語義保持不變。
 */
export function publicEndpointLabel(label: string): string {
  return label === "fallback" ? "fallback" : "primary";
}

// ─────────────────────────────────────────────────── 端點健康記憶（circuit breaker）
//
// 單一 Map，user 管線與 biz 管線共用：同一個 lambda 裡一條管線觀察到的端點故障,
// 另一條不必再親自撞一次。狀態是 per-instance 的——admin 介面上任何引用它的地方
// 都必須如實標註這一點，不得偽裝成全域真相。

export const ENDPOINT_FAILURE_THRESHOLD = 2;
export const ENDPOINT_COOLDOWN_MS = 60_000;

const endpointFailures = new Map<string, { failures: number; lastFailedAt: number }>();

function endpointKey(endpoint: { label: string; baseURL: string }): string {
  return `${endpoint.label}@${safeEndpointHost(endpoint.baseURL)}`;
}

export function isEndpointCoolingDown(endpoint: { label: string; baseURL: string }): boolean {
  const entry = endpointFailures.get(endpointKey(endpoint));
  if (!entry) return false;
  if (Date.now() - entry.lastFailedAt > ENDPOINT_COOLDOWN_MS) {
    endpointFailures.delete(endpointKey(endpoint));
    return false;
  }
  return entry.failures >= ENDPOINT_FAILURE_THRESHOLD;
}

export function recordEndpointFailure(endpoint: { label: string; baseURL: string }): void {
  const key = endpointKey(endpoint);
  const entry = endpointFailures.get(key);
  endpointFailures.set(key, {
    failures: entry && Date.now() - entry.lastFailedAt <= ENDPOINT_COOLDOWN_MS ? entry.failures + 1 : 1,
    lastFailedAt: Date.now(),
  });
}

export function recordEndpointSuccess(endpoint: { label: string; baseURL: string }): void {
  endpointFailures.delete(endpointKey(endpoint));
}

/** 冷卻中的端點降到隊尾而非剔除——全都在冷卻時，用戶仍然要有東西可試。 */
export function prioritizeHealthyEndpoints<T extends { label: string; baseURL: string }>(endpoints: T[]): T[] {
  const healthy: T[] = [];
  const cooling: T[] = [];
  for (const endpoint of endpoints) {
    if (isEndpointCoolingDown(endpoint)) cooling.push(endpoint);
    else healthy.push(endpoint);
  }
  return [...healthy, ...cooling];
}

/** 僅供測試重置共享冷卻狀態。 */
export function __resetChannelHealthForTests(): void {
  endpointFailures.clear();
}

// ─────────────────────────────────────────────────── 隊列構建（唯一入口）

function envChannelOverride(overrides: ChannelOverrides, channel: EnvChannelDescriptor) {
  return overrides[channel.id] ?? {};
}

/**
 * 生產與 admin 共用的唯一隊列函式。
 *
 * 不在這裡套 prioritizeHealthyEndpoints：冷卻重排是 per-instance 的執行期關注,
 * 由呼叫端在取得隊列後自行套用；admin 預覽因此拿到的是「靜態順序」，並須在
 * UI 上如實標註。
 */
export function buildModelQueue(
  modelId: string,
  env: EnvLike,
  pools: AdminPool[],
  overrides: ChannelOverrides,
): GatewayEndpoint[] {
  const envChannels = describeEnvChannels(env);
  const enabledEnvEndpoints: GatewayEndpoint[] = [];
  const environmentPriorities: Record<string, number> = {};

  for (const channel of envChannels) {
    const override = envChannelOverride(overrides, channel);
    const enabled = override.enabled ?? channel.defaultEnabled;
    environmentPriorities[channel.label] = override.priority ?? ENV_CHANNEL_PRIORITIES[channel.label];
    if (enabled && channel.endpoint) enabledEnvEndpoints.push(channel.endpoint);
  }

  return buildGatewayEndpointsWithPools(pools, enabledEnvEndpoints, modelId, environmentPriorities);
}

// ─────────────────────────────────────────────────── 渠道描述（admin 顯示用）

export function describeChannels(
  env: EnvLike,
  pools: AdminPool[],
  overrides: ChannelOverrides,
): ChannelDescriptor[] {
  const channels: ChannelDescriptor[] = [];

  for (const channel of describeEnvChannels(env)) {
    const override = envChannelOverride(overrides, channel);
    const basePriority = ENV_CHANNEL_PRIORITIES[channel.label];
    const endpoint = channel.endpoint;
    channels.push({
      id: channel.id,
      kind: "env",
      label: channel.label,
      host: endpoint ? safeEndpointHost(endpoint.baseURL) : "",
      configured: channel.configured,
      defaultEnabled: channel.defaultEnabled,
      enabled: override.enabled ?? channel.defaultEnabled,
      basePriority,
      priority: override.priority ?? basePriority,
      // 與合併時完全相同的推斷（inferSupportedModels），admin 看到的就是過濾用的。
      supportedModels: endpoint ? inferSupportedModels(endpoint) : [],
      source: channel.source,
      usesBillingGateway: channel.usesBillingGateway,
      overridden: { enabled: override.enabled !== undefined, priority: override.priority !== undefined },
      coolingDown: endpoint ? isEndpointCoolingDown(endpoint) : false,
    });
  }

  for (const pool of pools) {
    channels.push({
      id: `pool:${pool.id}`,
      kind: "pool",
      label: pool.name,
      host: safeEndpointHost(pool.baseURL),
      configured: true,
      defaultEnabled: pool.enabled,
      // 池的啟停/優先級由自己的 CRUD 管轄，overrides 不重複治理——雙重事實來源
      // 只會重演混亂。
      enabled: pool.enabled,
      basePriority: pool.priority,
      priority: pool.priority,
      supportedModels: inferSupportedModels(pool),
      source: "admin 池",
      usesBillingGateway: false,
      overridden: { enabled: false, priority: false },
      coolingDown: isEndpointCoolingDown({ label: pool.name, baseURL: pool.baseURL }),
    });
  }

  return channels;
}

/** admin overrides 允許出現的渠道 id 白名單（池不在內——池有自己的 CRUD）。 */
export function overridableChannelIds(): string[] {
  return ["env:sub2api", "env:adobe2api", "env:pixai", "env:primary", "env:fallback"];
}
