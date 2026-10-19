// decideQuota 的真实行为断言（E1-b D-2 的端点层证据）：
//   基线经回读确认 → 200＋池口径可用余额；
//   基线不成立（回读不到／new-api 不可达）→ **503，绝不 200 假零**；
//   帐本读取抛错 → 503；
//   帐本未配置（C 端站点副本）→ 回落 users.quota；上游不可得 → 503。
// 走的是与生产同一条决策路径（deps 注入），不是源码字串守门件。

import { test } from "node:test";
import assert from "node:assert/strict";
import { decideQuota } from "./decision";
import { QUOTA_PER_COIN } from "@/lib/quota-constants";

const enabled = { ledgerEnabled: () => true };

test("D-2：基线回读不成立（baselineQuota=null）→ 503 quota_unavailable，不得回 200 的 0 币", async () => {
  const decision = await decideQuota(40, {
    ...enabled,
    ensureOpening: async () => ({
      billingUserId: 40,
      seeded: false,
      baselineQuota: null,
      reason: "基线回读失败",
      failure: "ledger_unavailable",
      verified: false,
    }),
    readPools: async () => {
      throw new Error("readPools 不得在基线不成立时被呼叫");
    },
  });
  assert.equal(decision.status, 503);
  assert.equal((decision.body as { error: { code: string } }).error.code, "quota_unavailable");
  const body = JSON.stringify(decision.body);
  assert.doesNotMatch(body, /balance_coins/, "503 回应体不得带任何余额数字（假零的入口）");
});

test("D-2：基线就绪＋池有过期残额 → 200 回**可用**口径（不是 Σ 全额，也不是 0）", async () => {
  const decision = await decideQuota(40, {
    ...enabled,
    ensureOpening: async () => ({
      billingUserId: 40,
      seeded: false,
      baselineQuota: 5_000_000,
      reason: "已有基线（重放）",
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

test("D-2：帐本路径任何抛错（连不上 DB）→ 503，不得冒 200", async () => {
  const decision = await decideQuota(40, {
    ...enabled,
    ensureOpening: async () => {
      throw new Error("connection refused");
    },
  });
  assert.equal(decision.status, 503);
});

test("降级：帐本未配置（Vercel 站点副本）→ 回落 users.quota；上游不可得仍 503 不假零", async () => {
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
