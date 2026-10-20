import type { SupplierChannelHealthRow } from "@/lib/supplier-health-signal";
import { MAX_QUOTA_USERS, quotaToCoins, sampleRate, type ChannelHealthEntry, type ChannelLiveness, type QuotaCoverage, type RemainingQuotaEntry, type RemainingQuotaProjection } from "./types";

// ── 渠道判活（三态） ─────────────────────────────────────────────────────────
// 与 /v1/model-status 的最终裁决层同源：`readSupplierChannelHealth` 用的条件与
// readSupplierHealthSignal（scheduler withHealthyAccount 的同一把尺）逐字相同，
// 差别只在按渠道分组、且保留诚实第三态。

/**
 * 三态判定只看两件事：有没有能力记录、能不能调度。
 * - 没有任何当前生效能力 → unknown（帐本无据可判，绝不折叠成「不可用」或「健康」）；
 * - 有能力但一个都调度不了 → unavailable；
 * - 至少一条可调度 → available。
 */
export function channelLivenessOf(row: {
  capabilities: number;
  schedulableCapabilities: number;
}): ChannelLiveness {
  if (row.capabilities <= 0) return "unknown";
  if (row.schedulableCapabilities <= 0) return "unavailable";
  return "available";
}

export function projectChannelHealth(rows: SupplierChannelHealthRow[]): ChannelHealthEntry[] {
  return rows
    .map((row) => {
      const successCount = Number(row.success_count ?? 0);
      const failureCount = Number(row.failure_count ?? 0);
      return {
        channelId: String(row.channel_id),
        label: String(row.label ?? row.channel_id),
        liveness: channelLivenessOf({
          capabilities: Number(row.capabilities ?? 0),
          schedulableCapabilities: Number(row.schedulable_capabilities ?? 0),
        }),
        reason: String(row.reason ?? ""),
        capabilities: Number(row.capabilities ?? 0),
        schedulableCapabilities: Number(row.schedulable_capabilities ?? 0),
        successCount,
        failureCount,
        successRate: sampleRate(successCount, successCount + failureCount),
        lastSuccessAt: row.last_success_at ? new Date(String(row.last_success_at)).toISOString() : null,
        lastFailureAt: row.last_failure_at ? new Date(String(row.last_failure_at)).toISOString() : null,
      };
    })
    .sort((a, b) => {
      const order: Record<ChannelLiveness, number> = { unavailable: 0, unknown: 1, available: 2 };
      return order[a.liveness] - order[b.liveness] || a.label.localeCompare(b.label);
    });
}

// ── 剩余额度 ────────────────────────────────────────────────────────────────

/** 未知额度绝不当 0 加总；未知的用户单列计数。 */
export function projectRemainingQuota(
  entries: RemainingQuotaEntry[],
  coverage?: Partial<QuotaCoverage>,
): RemainingQuotaProjection {
  const known = entries.filter((entry) => entry.state === "known" && typeof entry.quota === "number");
  const knownQuota = known.reduce((sum, entry) => sum + (entry.quota ?? 0), 0);
  const coveredCount = entries.length;
  const totalIdentities = Math.max(coverage?.totalIdentities ?? coveredCount, coveredCount);
  return {
    entries: [...entries].sort((a, b) => a.billingUserId - b.billingUserId),
    knownQuota,
    knownCoins: quotaToCoins(knownQuota),
    knownCount: known.length,
    unknownCount: entries.length - known.length,
    coverage: {
      limit: coverage?.limit ?? MAX_QUOTA_USERS,
      coveredCount,
      totalIdentities,
      // 呼叫方说截断，或帐本里的身份数多于实际读取的数量——两种都算截断。
      truncated: coverage?.truncated === true || totalIdentities > coveredCount,
    },
  };
}
