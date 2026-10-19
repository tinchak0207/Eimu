// 渠道注册表：整个生图系统的「队列真相」只能从这里产生。
//
// 在此之前，队列逻辑散在四处各自为战：generate-images 路由（env 端点 + 池合并 +
// 专用分支）、biz-image-pipeline（同一套逻辑的手工拷贝，外加自己一份
// 冷却记忆）、admin 的 image-upstream-probe（直接调 buildGatewayEndpoints，admin
// 停用了渠道它照样打）、account-pools 的 routing 诊断（又一份）。/admin 显示的
// 队列与生产实际使用的队列因此可以各说各话——这正是本模组要消灭的病。
//
// 三条硬性质：
//  1. 单一事实来源：所有消费者（user 管线、biz 管线、admin 预览、探测）都必须
//     透过 buildModelQueue 取得队列，输入相同则输出相同。
//  2. 可控：admin overrides 能启停/调序 env 渠道（池有自己的 CRUD，
//     不重复管辖），不需要改 env 重新部署。
//  3. 诚实：describeChannels 枚举「全部」渠道——包含未配置的与被停用的——
//     并标明每一项数值的来源；未配置的渠道显示为未配置，而不是隐形。

import {
  describeEnvChannels,
  type EnvChannelDescriptor,
  type EnvLike,
  type GatewayEndpoint,
} from "./sub2api";
import { buildGatewayEndpointsWithPools, inferSupportedModels, type AdminPool } from "./admin-pools";
import type { ChannelOverrides } from "./channel-overrides";
import { REGISTRY_CHANNELS } from "./supplier-channels.config";

/**
 * env 渠道的固定基准优先级。
 *
 * 旧实作用「阵列索引 + 50」现场推算，于是过滤掉一个渠道会让后面每个渠道的
 * 优先级整体漂移——admin 看到的数字与生产生效的数字对不上。固定常数让数字
 * 可显示、可覆写、且与清单顺序彻底解耦。
 *
 * 与旧索引推算的唯一已知偏差：firefly 未配置时 primary 旧值是 50（索引 0），
 * 现在恒为 51——只影响「池优先级恰好是 51 且 firefly 未配置」这一个边角的
 * 平手判定（池因 source 序仍胜出，与池=50 时的行为一致）。
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
  // registry 渠道（supplier-channels.config.ts）的站点队列优先级。
  ...Object.fromEntries(REGISTRY_CHANNELS.map((channel) => [channel.label, channel.sitePriority])),
};

export interface ChannelDescriptor {
  id: string;
  kind: "env" | "pool";
  label: string;
  /** host + path，永不含 key。 */
  host: string;
  configured: boolean;
  /** 零 overrides 时生产的预设行为。 */
  defaultEnabled: boolean;
  /** 套用 overrides 后的生效状态——这就是 buildModelQueue 实际遵守的值。 */
  enabled: boolean;
  basePriority: number;
  priority: number;
  supportedModels: string[];
  /** 人话说明配置来源（哪个 env 变数胜出 / admin 池）。 */
  source: string;
  /** 胜出的 base URL 是计费闸道 GATEWAY_BASE_URL——兼职生图，值得警示。 */
  usesBillingGateway: boolean;
  overridden: { enabled: boolean; priority: boolean };
  /** 本 lambda 实例的冷却状态——per-instance，不代表其他实例。 */
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
 * 对外回应的通道标签：只透露「是否走了回退通道」，不透露具体供应商名。
 * 内部 label（adobe2api / sub2api / admin 池名等）一律归一成
 * "primary"，避免客户端从回应体拼出上游供应链。前端只依赖
 * `endpointLabel === "fallback"` 这一个值，因此语义保持不变。
 */
export function publicEndpointLabel(label: string): string {
  return label === "fallback" ? "fallback" : "primary";
}

// ─────────────────────────────────────────────────── 端点健康记忆（circuit breaker）
//
// 单一 Map，user 管线与 biz 管线共用：同一个 lambda 里一条管线观察到的端点故障,
// 另一条不必再亲自撞一次。状态是 per-instance 的——admin 介面上任何引用它的地方
// 都必须如实标注这一点，不得伪装成全域真相。

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

/** 冷却中的端点降到队尾而非剔除——全都在冷却时，用户仍然要有东西可试。 */
export function prioritizeHealthyEndpoints<T extends { label: string; baseURL: string }>(endpoints: T[]): T[] {
  const healthy: T[] = [];
  const cooling: T[] = [];
  for (const endpoint of endpoints) {
    if (isEndpointCoolingDown(endpoint)) cooling.push(endpoint);
    else healthy.push(endpoint);
  }
  return [...healthy, ...cooling];
}

/** 仅供测试重置共享冷却状态。 */
export function __resetChannelHealthForTests(): void {
  endpointFailures.clear();
}

// ─────────────────────────────────────────────────── 队列构建（唯一入口）

function envChannelOverride(overrides: ChannelOverrides, channel: EnvChannelDescriptor) {
  return overrides[channel.id] ?? {};
}

/**
 * 生产与 admin 共用的唯一队列函式。
 *
 * 不在这里套 prioritizeHealthyEndpoints：冷却重排是 per-instance 的执行期关注,
 * 由呼叫端在取得队列后自行套用；admin 预览因此拿到的是「静态顺序」，并须在
 * UI 上如实标注。
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

// ─────────────────────────────────────────────────── 渠道描述（admin 显示用）

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
      // 与合并时完全相同的推断（inferSupportedModels），admin 看到的就是过滤用的。
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
      // 池的启停/优先级由自己的 CRUD 管辖，overrides 不重复治理——双重事实来源
      // 只会重演混乱。
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

/** admin overrides 允许出现的渠道 id 白名单（池不在内——池有自己的 CRUD）。 */
export function overridableChannelIds(): string[] {
  return [
    "env:sub2api",
    "env:adobe2api",
    "env:pixai",
    "env:primary",
    "env:fallback",
    ...REGISTRY_CHANNELS.map((channel) => `env:${channel.label}`),
  ];
}
