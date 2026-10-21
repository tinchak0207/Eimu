import { computePoolBalances, type PoolBalances } from "../subscription-sku";
import { getGenerationSql, type GenerationSql } from "../database";
import { computeAccountBalance } from "./schema";
import { readAccountLedger } from "./storage";
import type { AccountBalance, LedgerEntry } from "./types";

/** 对外余额的唯一读法：取该身份帐本 → Σ amount。 */
export async function readAccountBalance(
  billingUserId: number,
  deps: { sql?: GenerationSql } = {},
): Promise<AccountBalance & { skippedRows: number }> {
  const entries = await readAccountLedger(billingUserId, deps);
  return computeAccountBalance(entries, billingUserId);
}

/**
 * 池余额的唯一读法（REQ-D3）：取该身份帐本 → 按池分堆 + **读取时 lazy 判定过期**。
 * 纯函式在 subscription-sku.ts（computePoolBalances），本函式只负责把帐本喂进去。
 */
export async function readPoolBalances(
  billingUserId: number,
  deps: { sql?: GenerationSql; nowMs?: number } = {},
): Promise<PoolBalances & { entries: LedgerEntry[] }> {
  const entries = await readAccountLedger(billingUserId, deps);
  const balances = computePoolBalances(entries, deps.nowMs ?? Date.now());
  return { ...balances, entries };
}

/**
 * **可用余额**（不变量 ①）：永久池 + 未过期订阅池。对外读取口与配额预检共用这一条。
 * 回 null ＝ 读不出来（储存层未配置／查询失败）——呼叫端据此走既有降级路径，
 * 绝不让「读不到」被当成 0 或当成「足够」。
 */
export async function readAvailableQuota(
  billingUserId: number,
  deps: { sql?: GenerationSql; nowMs?: number } = {},
): Promise<number | null> {
  try {
    const balances = await readPoolBalances(billingUserId, deps);
    return balances.availableQuota;
  } catch (error) {
    console.error(
      `[account-ledger] 可用余额读取失败 user=${billingUserId}：${error instanceof Error ? error.message : String(error)}`,
    );
    return null;
  }
}
