// decideQuota 的真實行為斷言（E1-b D-2 的端點層證據）：
//   基線經回讀確認 → 200＋池口徑可用餘額；
//   基線不成立（回讀不到／new-api 不可達）→ **503，絕不 200 假零**；
//   帳本讀取拋錯 → 503；
//   帳本未配置（C 端站點副本）→ 回落 users.quota；上游不可得 → 503。
// 走的是與生產同一條決策路徑（deps 注入），不是源碼字串守門件。

import { test } from "node:test";
import assert from "node:assert/strict";
import { decideQuota } from "./decision";
import { QUOTA_PER_COIN } from "@/lib/quota-constants";

const enabled = { ledgerEnabled: () => true };

test("D-2：基線回讀不成立（baselineQuota=null）→ 503 quota_unavailable，不得回 200 的 0 幣", async () => {
  const decision = await decideQuota(40, {
    ...enabled,
    ensureOpening: async () => ({
      billingUserId: 40,
      seeded: false,
      baselineQuota: null,
      reason: "基線回讀失敗",
      failure: "ledger_unavailable",
      verified: false,
    }),
    readPools: async () => {
      throw new Error("readPools 不得在基線不成立時被呼叫");
    },
  });
  assert.equal(decision.status, 503);
  assert.equal((decision.body as { error: { code: string } }).error.code, "quota_unavailable");
  const body = JSON.stringify(decision.body);
  assert.doesNotMatch(body, /balance_coins/, "503 回應體不得帶任何餘額數字（假零的入口）");
});

test("D-2：基線就緒＋池有過期殘額 → 200 回**可用**口徑（不是 Σ 全額，也不是 0）", async () => {
  const decision = await decideQuota(40, {
    ...enabled,
    ensureOpening: async () => ({
      billingUserId: 40,
      seeded: false,
      baselineQuota: 5_000_000,
      reason: "已有基線（重放）",
      failure: null,
      verified: true,
    }),
    readPools: async () => ({
      entries: [],
      terms: [],
      undatedSubscriptionRows: 0,
      permanentQuota: 3_400_000,
      subscriptionQuota: 0,
      expiredSubscriptionQuota: 800_000,
      availableQuota: 3_400_000,
    }),
  });
  assert.equal(decision.status, 200);
  assert.equal((decision.body as { balance_coins: number }).balance_coins, 3_400_000 / QUOTA_PER_COIN);
  assert.equal((decision.body as { success: boolean }).success, true);
});

test("D-2：帳本路徑任何拋錯（連不上 DB）→ 503，不得冒 200", async () => {
  const decision = await decideQuota(40, {
    ...enabled,
    ensureOpening: async () => {
      throw new Error("connection refused");
    },
  });
  assert.equal(decision.status, 503);
});

test("降級：帳本未配置（Vercel 站點副本）→ 回落 users.quota；上游不可得仍 503 不假零", async () => {
  const ok = await decideQuota(40, {
    ledgerEnabled: () => false,
    fetchUser: async () => ({ quota: 7_500_000 } as never),
  });
  assert.equal(ok.status, 200);
  assert.equal((ok.body as { balance_coins: number }).balance_coins, 7_500_000 / QUOTA_PER_COIN);

  const gone = await decideQuota(40, {
    ledgerEnabled: () => false,
    fetchUser: async () => {
      throw new Error("upstream down");
    },
  });
  assert.equal(gone.status, 503);
});
