// B 端密钥限流的分发层。
//
// 单机内存限流（consumeRateLimit + rateWindows）在 Vercel 多实例/serverless
// 下不共享状态，真实放行量会高于配置的 rpm —— 这是 biz-api-keys.ts 里
// consumeRateLimit 的注释里如实写明的已知限制。
//
// 若 generation-core 的 Postgres 控制面已配置（GENERATION_DATABASE_URL /
// DATABASE_URL），改用 consumeDistributedRateLimit 做跨实例的原子计数；
// 否则（本地开发或自建部署没有配置数据库）退回进程内内存限流，
// 与旧行为完全一致，不回归 dev 体验。

import { generationDatabaseConfigured, type GenerationSql } from "./generation-core/database";
import { consumeDistributedRateLimit } from "./generation-core/scheduler";
import { consumeRateLimit, type RateWindow } from "./biz-api-keys";

export interface BizRateLimitDecision {
  allowed: boolean;
  /** 被拒时建议的重试等待秒数；放行时为 0。 */
  retryAfterSeconds: number;
}

let loggedMode = false;

/** 只在进程里第一次限流时打一行日志，说明走的是哪条路径，避免刷屏。 */
function logModeOnce(distributed: boolean): void {
  if (loggedMode) return;
  loggedMode = true;
  console.log(
    distributed
      ? "[biz-keys] 限流模式：分布式（Postgres control plane，跨实例共享计数）。"
      : "[biz-keys] 限流模式：进程内内存（未配置 GENERATION_DATABASE_URL，跨实例不共享，仅用于挡明显滥用）。",
  );
}

export interface BizRateLimitDeps {
  /** 仅供测试注入：跳过真实的 env 检测，强制走分布式/内存路径。 */
  distributedConfigured?: boolean;
  /** 仅供测试注入：替换掉 consumeDistributedRateLimit 默认解析的连接。 */
  sql?: GenerationSql;
  now?: Date;
}

/**
 * 对一个 B 端密钥计一次限流请求。
 *
 * 有 Postgres 控制面时走跨实例的原子计数；没有配置，或分布式查询本身
 * 失败（数据库瞬时故障不该把所有请求都拦死）时，退回内存滑动窗口 ——
 * 原地更新传入的 rateWindows，行为与迁移前的 consumeRateLimit 调用点一致。
 */
export async function consumeBizApiKeyRateLimit(
  apiKeyId: string,
  rpm: number,
  rateWindows: Map<string, RateWindow>,
  deps: BizRateLimitDeps = {},
): Promise<BizRateLimitDecision> {
  const distributed = deps.distributedConfigured ?? generationDatabaseConfigured();

  if (distributed) {
    logModeOnce(true);
    try {
      const result = deps.sql
        ? await consumeDistributedRateLimit({ apiKeyId, rpm, now: deps.now }, deps.sql)
        : await consumeDistributedRateLimit({ apiKeyId, rpm, now: deps.now });
      return { allowed: result.allowed, retryAfterSeconds: result.retryAfterSeconds };
    } catch (error) {
      console.error("[biz-keys] 分布式限流查询失败，本次请求退回内存限流。", error);
    }
  } else {
    logModeOnce(false);
  }

  const decision = consumeRateLimit(rateWindows.get(apiKeyId), deps.now?.getTime() ?? Date.now(), rpm);
  rateWindows.set(apiKeyId, decision.window);
  return { allowed: decision.allowed, retryAfterSeconds: decision.retryAfterSeconds };
}

/** 仅供测试使用：重置「已打过一次日志」的标记。 */
export function __resetBizRateLimitLogForTests(): void {
  loggedMode = false;
}
