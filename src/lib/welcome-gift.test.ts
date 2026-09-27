// 新人礼测试：真实行为断言（真输入 → 真输出），占位表/上游/帐本都用内存替身，
// 但幂等语义（UNIQUE 占位、帐本 ON CONFLICT DO NOTHING）照生产语义实现。

import assert from "node:assert/strict";
import test from "node:test";

import { imageGenerationCoins, DEFAULT_IMAGE_MODEL_ID } from "@/lib/provider-config";
import { QUOTA_PER_COIN } from "@/lib/quota-constants";
import type { GatewayAdminUser } from "@/lib/gateway-admin";
import {
  WELCOME_GIFT_COINS,
  WELCOME_GIFT_IMAGE_COUNT,
  WELCOME_GIFT_QUOTA,
  backfillWelcomeGifts,
  grantWelcomeGift,
  welcomeGiftBackfillCandidates,
  welcomeGiftNotice,
  welcomeGiftRef,
  type WelcomeClaimStatus,
  type WelcomeGiftDeps,
} from "./welcome-gift.ts";

interface World {
  quota: Map<number, number>;
  claims: Map<number, WelcomeClaimStatus>;
  ledger: Map<string, { userId: number; amount: number }>;
  succeeded: Set<number>;
  notices: { userId: number; title: string }[];
  adjustCalls: number;
  deps: WelcomeGiftDeps;
}

function world(options: {
  users?: GatewayAdminUser[];
  succeeded?: number[];
  biz?: number[];
  adjust?: (userId: number, delta: number, w: World) => Promise<void>;
  baseline?: { ready: boolean; blocked: boolean };
} = {}): World {
  const w = {
    quota: new Map<number, number>(),
    claims: new Map<number, WelcomeClaimStatus>(),
    ledger: new Map<string, { userId: number; amount: number }>(),
    succeeded: new Set(options.succeeded ?? []),
    notices: [] as { userId: number; title: string }[],
    adjustCalls: 0,
  } as World;
  const tick = () => new Promise((resolve) => setImmediate(resolve));
  w.deps = {
    store: {
      async readClaim(userId) {
        await tick();
        return w.claims.get(userId) ?? null;
      },
      async hasSucceededGeneration(userId) {
        await tick();
        return w.succeeded.has(userId);
      },
      async claim(userId) {
        await tick();
        // 与生产 SQL 同义：不存在 → 插 pending；存在且 failed → 改 pending；否则不占。
        const current = w.claims.get(userId);
        if (current === undefined || current === "failed") {
          w.claims.set(userId, "pending");
          return true;
        }
        return false;
      },
      async mark(userId, status) {
        w.claims.set(userId, status);
      },
      async listBizBillingUserIds() {
        return options.biz ?? [];
      },
    },
    async ensureBaseline() {
      return options.baseline ?? { ready: true, blocked: false };
    },
    async readUpstreamQuota(userId) {
      return w.quota.get(userId) ?? 0;
    },
    async adjustUpstream(userId, delta) {
      w.adjustCalls += 1;
      if (options.adjust) return options.adjust(userId, delta, w);
      await tick();
      w.quota.set(userId, (w.quota.get(userId) ?? 0) + delta);
    },
    async recordLedger({ userId, amountQuota, sourceRef }) {
      // 生产帐本 idempotency_ref = ledgerRef.adjustment(sourceRef)，UNIQUE + ON CONFLICT DO NOTHING。
      const ref = `adjustment:${sourceRef}`;
      if (w.ledger.has(ref)) return { posted: false, reason: "duplicate" };
      w.ledger.set(ref, { userId, amount: amountQuota });
      return { posted: true };
    },
    async notify(userId, notice) {
      w.notices.push({ userId, title: notice.title });
    },
    async listUsers() {
      return options.users ?? [];
    },
  };
  return w;
}

test("额度常量＝5 张默认模型标准图的真实定价（不写死魔数）", () => {
  const perImage = imageGenerationCoins(DEFAULT_IMAGE_MODEL_ID);
  assert.equal(WELCOME_GIFT_IMAGE_COUNT, 5);
  assert.equal(WELCOME_GIFT_COINS, 5 * perImage);
  assert.equal(WELCOME_GIFT_QUOTA, Math.round(5 * perImage * QUOTA_PER_COIN));
  assert.equal(welcomeGiftRef(246), "welcome:246:v1");
  const notice = welcomeGiftNotice();
  assert.equal(notice.title, `新人礼：已送你 ${WELCOME_GIFT_COINS} 币，够生成约 5 张图`);
});

test("新用户首次命中即发：上游 +N、帐本记一笔 adjustment、写一条站内通知", async () => {
  const w = world();
  const result = await grantWelcomeGift(301, w.deps);
  assert.equal(result.status, "granted");
  assert.equal(result.amountQuota, WELCOME_GIFT_QUOTA);
  assert.equal(w.quota.get(301), WELCOME_GIFT_QUOTA);
  assert.deepEqual(w.ledger.get("adjustment:welcome:301:v1"), { userId: 301, amount: WELCOME_GIFT_QUOTA });
  assert.equal(w.claims.get(301), "applied");
  assert.equal(w.notices.length, 1);
});

test("幂等：连发两次只入帐一次（第二次 already_granted，上游不再加额）", async () => {
  const w = world();
  const first = await grantWelcomeGift(302, w.deps);
  const second = await grantWelcomeGift(302, w.deps);
  assert.equal(first.status, "granted");
  assert.equal(second.status, "already_granted");
  assert.equal(w.adjustCalls, 1);
  assert.equal(w.quota.get(302), WELCOME_GIFT_QUOTA);
  assert.equal(w.ledger.size, 1);
  assert.equal(w.notices.length, 1);
});

test("幂等：并发两次登录（同时命中）也只加额一次", async () => {
  const w = world();
  const results = await Promise.all([grantWelcomeGift(303, w.deps), grantWelcomeGift(303, w.deps)]);
  assert.ok(results.every((r) => r.status === "granted" || r.status === "in_flight" || r.status === "already_granted"));
  assert.equal(results.filter((r) => r.status === "granted").length, 1);
  assert.equal(w.adjustCalls, 1);
  assert.equal(w.quota.get(303), WELCOME_GIFT_QUOTA);
  assert.equal(w.ledger.size, 1);
});

test("已有成功出图的用户不发：上游、帐本、通知都不动", async () => {
  const w = world({ succeeded: [304] });
  const result = await grantWelcomeGift(304, w.deps);
  assert.equal(result.status, "ineligible");
  assert.equal(w.adjustCalls, 0);
  assert.equal(w.ledger.size, 0);
  assert.equal(w.notices.length, 0);
  assert.equal(w.claims.has(304), false);
});

test("基线不可得：不动上游，占位释放为 failed，下次可重试并只发一次", async () => {
  const blocked = world({ baseline: { ready: false, blocked: true } });
  const first = await grantWelcomeGift(305, blocked.deps);
  assert.equal(first.status, "unavailable");
  assert.equal(blocked.adjustCalls, 0);
  assert.equal(blocked.claims.get(305), "failed");

  blocked.deps.ensureBaseline = async () => ({ ready: true, blocked: false });
  const retry = await grantWelcomeGift(305, blocked.deps);
  assert.equal(retry.status, "granted");
  assert.equal(blocked.adjustCalls, 1);
  assert.equal(blocked.quota.get(305), WELCOME_GIFT_QUOTA);
});

test("上游明确没动（抛错且 quota 未变）→ failed 可重试；结果不明（quota 已变）→ unknown 不再自动动上游", async () => {
  const untouched = world({ adjust: async () => { throw new Error("upstream said no"); } });
  const a = await grantWelcomeGift(306, untouched.deps);
  assert.equal(a.status, "unavailable");
  assert.equal(untouched.claims.get(306), "failed");

  const ambiguous = world({
    adjust: async (userId, delta, w) => {
      w.quota.set(userId, (w.quota.get(userId) ?? 0) + delta);
      throw new Error("socket hang up after apply");
    },
  });
  const b = await grantWelcomeGift(307, ambiguous.deps);
  assert.equal(b.status, "in_flight");
  assert.equal(ambiguous.claims.get(307), "unknown");
  const again = await grantWelcomeGift(307, ambiguous.deps);
  assert.equal(again.status, "in_flight");
  assert.equal(ambiguous.adjustCalls, 1, "unknown 状态不得再次动上游（宁可少发不可双发）");
  assert.equal(ambiguous.quota.get(307), WELCOME_GIFT_QUOTA);
});

test("回溯：只发给从未成功出图的普通启用用户；排除管理员/禁用/B 端计费账户；重放不双发", async () => {
  const users: GatewayAdminUser[] = [
    { id: 1, username: "root", quota: 0, role: 100, status: 1 },
    { id: 10, username: "fresh", quota: 0, role: 1, status: 1 },
    { id: 11, username: "made-images", quota: 0, role: 1, status: 1 },
    { id: 12, username: "disabled", quota: 0, role: 1, status: 2 },
    { id: 13, username: "biz-a", quota: 0, role: 1, status: 1 },
    { id: 14, username: "fresh-2", quota: 0, role: 1, status: 1 },
  ];
  assert.deepEqual(welcomeGiftBackfillCandidates(users, [13]), [10, 11, 14]);

  const w = world({ users, succeeded: [11], biz: [13] });
  const dry = await backfillWelcomeGifts(w.deps, { dryRun: true });
  assert.equal(dry.counts.eligible, 2);
  assert.equal(w.adjustCalls, 0, "dryRun 不动上游");

  const run = await backfillWelcomeGifts(w.deps);
  assert.deepEqual(run.userIds.granted, [10, 14]);
  assert.deepEqual(run.userIds.ineligible, [11]);
  assert.equal(run.excluded, 3);

  const replay = await backfillWelcomeGifts(w.deps);
  assert.deepEqual(replay.userIds.already_granted, [10, 14]);
  assert.equal(w.adjustCalls, 2);
  assert.equal(w.ledger.size, 2);
});
