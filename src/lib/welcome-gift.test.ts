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
  runWelcomeGiftDevCatchUp,
  welcomeGiftBackfillCandidates,
  welcomeGiftExcludedUserIds,
  welcomeGiftNotice,
  welcomeGiftRef,
  type WelcomeClaimStatus,
  type WelcomeGiftDeps,
} from "./welcome-gift.ts";

interface World {
  quota: Map<number, number>;
  claims: Map<number, WelcomeClaimStatus>;
  noticed: Set<number>;
  ledger: Map<string, { userId: number; amount: number }>;
  succeeded: Set<number>;
  adjustCalls: number;
  /** 补发候选查询最近一次收到的内部排除名单（证明 env 口径真的传到了 store）。 */
  lastExcluded?: number[];
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
    noticed: new Set<number>(),
    ledger: new Map<string, { userId: number; amount: number }>(),
    succeeded: new Set(options.succeeded ?? []),
    adjustCalls: 0,
  } as World;
  const tick = () => new Promise((resolve) => setImmediate(resolve));
  w.deps = {
    store: {
      async readClaim(userId) {
        await tick();
        const status = w.claims.get(userId);
        return status ? { status, noticed: w.noticed.has(userId) } : null;
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
      async markNoticed(userId) {
        if (w.claims.get(userId) !== "applied" || w.noticed.has(userId)) return false;
        w.noticed.add(userId);
        return true;
      },
      async listDevGiftCandidates(excludedUserIds, limit) {
        w.lastExcluded = excludedUserIds;
        const excluded = new Set(excludedUserIds);
        return (options.biz ?? [])
          .filter((id) => !excluded.has(id))
          // 未领过 = 没有占位行，或上次 failed（可重占）；applied/pending/unknown 不动。
          .filter((id) => {
            const status = w.claims.get(id);
            return status === undefined || status === "failed";
          })
          .filter((id) => !w.succeeded.has(id))
          .sort((a, b) => a - b)
          .slice(0, limit);
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

test("新用户首次命中即发：上游 +N、帐本记一笔 adjustment、通知待送", async () => {
  const w = world();
  const result = await grantWelcomeGift(301, w.deps);
  assert.equal(result.status, "granted");
  assert.equal(result.amountQuota, WELCOME_GIFT_QUOTA);
  assert.equal(w.quota.get(301), WELCOME_GIFT_QUOTA);
  assert.deepEqual(w.ledger.get("adjustment:welcome:301:v1"), { userId: 301, amount: WELCOME_GIFT_QUOTA });
  assert.equal(w.claims.get(301), "applied");
  assert.equal(result.noticePending, true);
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
  // 通知未回执前 already_granted 仍标 noticePending；回执后不再待送。
  assert.equal(second.noticePending, true);
  assert.equal(await w.deps.store.markNoticed(302), true);
  assert.equal(await w.deps.store.markNoticed(302), false);
  assert.equal((await grantWelcomeGift(302, w.deps)).noticePending, false);
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
  assert.equal(result.noticePending, false);
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

test("回溯：只发给从未成功出图的普通启用用户；排除管理员/禁用/内部账号；持有 biz key 的外部用户要进候选；重放不双发", async () => {
  const users: GatewayAdminUser[] = [
    { id: 1, username: "root", quota: 0, role: 100, status: 1 },
    { id: 10, username: "fresh", quota: 0, role: 1, status: 1 },
    { id: 11, username: "made-images", quota: 0, role: 1, status: 1 },
    { id: 12, username: "disabled", quota: 0, role: 1, status: 2 },
    { id: 13, username: "dev-with-biz-key", quota: 0, role: 1, status: 1 },
    { id: 14, username: "fresh-2", quota: 0, role: 1, status: 1 },
  ];
  // 新口径：biz key 不再等于「内部」——13 要进候选；排除名单只认内部账号。
  assert.deepEqual(welcomeGiftBackfillCandidates(users, []), [10, 11, 13, 14]);
  assert.deepEqual(welcomeGiftBackfillCandidates(users, [13]), [10, 11, 14]);

  const w = world({ users, succeeded: [11], biz: [13] });
  const dry = await backfillWelcomeGifts(w.deps, { dryRun: true });
  assert.equal(dry.counts.eligible, 3, "10/13/14 可发，11 已出图");
  assert.equal(w.adjustCalls, 0, "dryRun 不动上游");

  const run = await backfillWelcomeGifts(w.deps);
  assert.deepEqual(run.userIds.granted, [10, 13, 14]);
  assert.deepEqual(run.userIds.ineligible, [11]);
  assert.equal(run.excluded, 2, "仅 role=100 与 status=2 被排除");

  const replay = await backfillWelcomeGifts(w.deps);
  assert.deepEqual(replay.userIds.already_granted, [10, 13, 14]);
  assert.equal(w.adjustCalls, 3);
  assert.equal(w.ledger.size, 3);
  // 13 是 biz 开发者，同样拿到了额度（回归：不再按 biz key 排除）。
  assert.equal(w.quota.get(13), WELCOME_GIFT_QUOTA);
});

test("开发者补发：biz key ∧ 未领 ∧ 未出图 → 发；内部 id → 不發；已领/已出图 → 不發", async () => {
  const previous = process.env.INTERNAL_USER_IDS;
  process.env.INTERNAL_USER_IDS = "9001";
  try {
    assert.deepEqual(welcomeGiftExcludedUserIds(), [9001], "排除名单读 env INTERNAL_USER_IDS");

    const w = world({ biz: [9001, 9002, 9003, 9004], succeeded: [9004] });
    w.claims.set(9003, "applied");

    const report = await runWelcomeGiftDevCatchUp(w.deps);
    assert.deepEqual(report, { scanned: 1, granted: 1, skipped: 0, failed: 0 });
    assert.deepEqual(w.lastExcluded, [9001], "内部名单真的传进候选查询");
    assert.equal(w.quota.get(9002), WELCOME_GIFT_QUOTA);
    assert.equal(w.claims.get(9002), "applied");
    assert.equal(w.ledger.size, 1);
    assert.equal(w.adjustCalls, 1);

    // 内部 id：不动上游、不占位、不进帐本。
    assert.equal(w.quota.has(9001), false);
    assert.equal(w.claims.has(9001), false);
    // 已领过：不动上游（占位表状态一字不改）。
    assert.equal(w.claims.get(9003), "applied");
    // 已成功出图：不发。
    assert.equal(w.quota.has(9004), false);
    assert.equal(w.ledger.size, 1);
  } finally {
    if (previous === undefined) delete process.env.INTERNAL_USER_IDS;
    else process.env.INTERNAL_USER_IDS = previous;
  }
});

test("开发者补发：每轮上限 20 人（按 user id 升序取前 20）", async () => {
  const biz = Array.from({ length: 25 }, (_, index) => 8100 + index);
  const w = world({ biz });
  const report = await runWelcomeGiftDevCatchUp(w.deps);
  assert.equal(report.scanned, 20);
  assert.equal(report.granted, 20);
  assert.equal(w.adjustCalls, 20);
  assert.equal(w.quota.has(8100), true);
  assert.equal(w.quota.has(8119), true);
  assert.equal(w.quota.has(8120), false, "第 21 人留到下一轮");
  assert.equal(w.quota.has(8124), false);
});

test("登录编排：通知待送 → 写一条站内通知并回执；回执成功后不再待送；无需通知时不写", async () => {
  const { ensureWelcomeGiftOnLogin } = await import("./welcome-gift-login.ts");
  const written: { userId: number; title: string }[] = [];
  const acks: number[] = [];
  const base = { userId: 401, amountQuota: WELCOME_GIFT_QUOTA, coins: WELCOME_GIFT_COINS };
  const deps = (noticePending: boolean, ackOk = true) => ({
    grant: async () => ({ ...base, status: "granted" as const, noticePending }),
    ack: async (userId: number) => {
      acks.push(userId);
      return ackOk;
    },
    notify: async (userId: number, notice: { title: string }) => {
      written.push({ userId, title: notice.title });
    },
  });

  const delivered = await ensureWelcomeGiftOnLogin(401, {}, deps(true));
  assert.equal(delivered?.noticePending, false);
  assert.deepEqual(written, [{ userId: 401, title: `新人礼：已送你 ${WELCOME_GIFT_COINS} 币，够生成约 5 张图` }]);
  assert.deepEqual(acks, [401]);

  const ackFailed = await ensureWelcomeGiftOnLogin(401, {}, deps(true, false));
  assert.equal(ackFailed?.noticePending, true, "回执失败＝下次再送，不假装送达");

  written.length = 0;
  acks.length = 0;
  const nothingToSay = await ensureWelcomeGiftOnLogin(401, {}, deps(false));
  assert.equal(nothingToSay?.status, "granted");
  assert.equal(written.length, 0);
  assert.equal(acks.length, 0);
});
