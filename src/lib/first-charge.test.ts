// 首充专享档（plan id `first-charge`）的资格判准与「限一次」执法：真行为断言，不扫源码字串。
//
// 判据一一对应验收条目：
//   - 资格三态：帐本没有 recharge 行 → eligible；有 recharge 行 → ineligible_recharged；
//     买过本档（名额被别的单占了）→ ineligible_claimed。
//   - 并发：两单同时冲，只有一个拿到 300 币，另一个按 ¥7 对应正价折算（约 70 币）；
//     同一张单重试仍是全额（上游调额不幂等，重试不该被惩罚）。
//   - 资格判不了（查询抛错）→ 不给 4 倍优惠，按正价折算，且原因写进 detail。
//
// 依赖全用假 store（没有真 DB、没有支付、没有上游调用）。

import assert from "node:assert/strict";
import test from "node:test";

import {
  FIRST_CHARGE_FULL_QUOTA,
  FIRST_CHARGE_FALLBACK_QUOTA,
  checkFirstChargeEligibility,
  firstChargeEligibilityOf,
  resolveFirstChargeGrant,
  type FirstChargeDeps,
  type FirstChargeStore,
} from "@/lib/first-charge";
import {
  FIRST_CHARGE_COINS,
  FIRST_CHARGE_FALLBACK_COINS,
  FIRST_CHARGE_PLAN,
  FIRST_CHARGE_PLAN_ID,
  FIRST_CHARGE_PRICE,
  PLANS,
  resolvePricingPlan,
} from "@/lib/plans";
import { QUOTA_PER_COIN } from "@/lib/quota-constants";

/** 假 store：两个事实（有没有充值过、名额被谁占了），行为与 Postgres 实现同构。 */
function fakeDeps(options: { hasRecharge?: boolean; claim?: { outTradeNo: string } | null; throwOnRead?: boolean } = {}) {
  const state = {
    hasRecharge: options.hasRecharge ?? false,
    claim: options.claim ?? null,
    claimCalls: 0,
  };
  const store: FirstChargeStore = {
    async hasRecharge() {
      if (options.throwOnRead) throw new Error("store down");
      return state.hasRecharge;
    },
    async readClaim() {
      if (options.throwOnRead) throw new Error("store down");
      return state.claim ? { outTradeNo: state.claim.outTradeNo, coins: FIRST_CHARGE_COINS } : null;
    },
    async claimSlot(_userId, outTradeNo, coins) {
      state.claimCalls += 1;
      if (state.claim) return false; // 名额已被占（与 ON CONFLICT DO NOTHING 同语义）
      state.claim = { outTradeNo };
      assert.equal(coins, FIRST_CHARGE_COINS);
      return true;
    },
  };
  const deps: FirstChargeDeps = { store };
  return { deps, state };
}

test("no recharge row and no prior claim → eligible", async () => {
  const { deps } = fakeDeps();
  const result = await checkFirstChargeEligibility({ userId: 42 }, deps);
  assert.equal(result.eligible, true);
  assert.equal(result.status, "eligible");

  const grant = await resolveFirstChargeGrant({ userId: 42, outTradeNo: "IMG-A" }, deps);
  assert.equal(grant.eligible, true);
  assert.equal(grant.coins, FIRST_CHARGE_COINS);
  assert.equal(grant.amountQuota, FIRST_CHARGE_FULL_QUOTA);
  assert.equal(grant.detail, undefined, "全额发放不必写 detail");
});

test("has a recharge row in the ledger → ineligible, one-time offer not given", async () => {
  const { deps } = fakeDeps({ hasRecharge: true });
  const result = await checkFirstChargeEligibility({ userId: 42 }, deps);
  assert.equal(result.eligible, false);
  assert.equal(result.status, "ineligible_recharged");

  const grant = await resolveFirstChargeGrant({ userId: 42, outTradeNo: "IMG-B" }, deps);
  assert.equal(grant.eligible, false);
  assert.equal(grant.coins, FIRST_CHARGE_FALLBACK_COINS);
  assert.equal(grant.amountQuota, FIRST_CHARGE_FALLBACK_QUOTA);
  assert.notEqual(grant.coins, FIRST_CHARGE_COINS);
  assert.match(String(grant.detail), /已有充值记录/);
});

test("already bought first-charge (slot held by another order) → ineligible", async () => {
  const { deps } = fakeDeps({ claim: { outTradeNo: "IMG-FIRST" } });
  const result = await checkFirstChargeEligibility({ userId: 42 }, deps);
  assert.equal(result.eligible, false);
  assert.equal(result.status, "ineligible_claimed");

  const grant = await resolveFirstChargeGrant({ userId: 42, outTradeNo: "IMG-SECOND" }, deps);
  assert.equal(grant.coins, FIRST_CHARGE_FALLBACK_COINS);
  assert.match(String(grant.detail), /已购买过首充专享|占用/);
});

test("retrying the same order still gets the full first-charge coins", async () => {
  const { deps } = fakeDeps({ claim: { outTradeNo: "IMG-SAME" } });
  const grant = await resolveFirstChargeGrant({ userId: 42, outTradeNo: "IMG-SAME" }, deps);
  assert.equal(grant.eligible, true);
  assert.equal(grant.coins, FIRST_CHARGE_COINS);
  assert.equal(grant.amountQuota, FIRST_CHARGE_FULL_QUOTA);
});

test("concurrent orders: exactly one keeps the 300 coins, the loser is settled at standard rate", async () => {
  const { deps, state } = fakeDeps();
  const [a, b] = await Promise.all([
    resolveFirstChargeGrant({ userId: 7, outTradeNo: "IMG-C1" }, deps),
    resolveFirstChargeGrant({ userId: 7, outTradeNo: "IMG-C2" }, deps),
  ]);

  const winners = [a, b].filter((grant) => grant.eligible);
  const losers = [a, b].filter((grant) => !grant.eligible);
  assert.equal(winners.length, 1, "只有一单拿到首充全额");
  assert.equal(losers.length, 1, "另一单按正价折算");
  assert.equal(winners[0].coins, FIRST_CHARGE_COINS);
  assert.equal(losers[0].coins, FIRST_CHARGE_FALLBACK_COINS);
  assert.match(String(losers[0].detail), /占用/);
  assert.equal(state.claimCalls, 2, "两单都尝试登记名额（限一次由主键裁决）");
  // 钱只按一份全额 + 一份折算发出去，绝不双份 300。
  assert.equal(winners[0].amountQuota + losers[0].amountQuota, FIRST_CHARGE_FULL_QUOTA + FIRST_CHARGE_FALLBACK_QUOTA);
});

test("eligibility channel unknown (store error) never yields the 4x discount", async () => {
  const { deps } = fakeDeps({ throwOnRead: true });
  const result = await checkFirstChargeEligibility({ userId: 42 }, deps);
  assert.equal(result.eligible, false);
  assert.equal(result.status, "unknown");

  const grant = await resolveFirstChargeGrant({ userId: 42, outTradeNo: "IMG-D" }, deps);
  assert.equal(grant.eligible, false);
  assert.equal(grant.coins, FIRST_CHARGE_FALLBACK_COINS);
});

test("pure eligibility predicate reads only the two facts (order-scoped claim)", () => {
  assert.equal(
    firstChargeEligibilityOf({ hasRechargeLedgerRow: false, claimedOutTradeNo: null }).status,
    "eligible",
  );
  assert.equal(
    firstChargeEligibilityOf({ hasRechargeLedgerRow: true, claimedOutTradeNo: null }).status,
    "ineligible_recharged",
  );
  assert.equal(
    firstChargeEligibilityOf({ hasRechargeLedgerRow: false, claimedOutTradeNo: "IMG-X", outTradeNo: "IMG-Y" }).status,
    "ineligible_claimed",
  );
  assert.equal(
    firstChargeEligibilityOf({ hasRechargeLedgerRow: false, claimedOutTradeNo: "IMG-X", outTradeNo: "IMG-X" }).status,
    "eligible",
  );
});

test("first-charge plan is a one-time offer outside the regular price ladder (prices untouched)", () => {
  // 正价三档一字未动（本片只允许新增）。
  assert.deepEqual(
    PLANS.map((plan) => [plan.id, plan.price, plan.coins]),
    [
      ["starter", 9.9, 100],
      ["popular", 29.9, 500],
      ["pro", 69, 1500],
    ],
  );
  assert.equal(PLANS.some((plan) => plan.id === FIRST_CHARGE_PLAN_ID), false, "不得出现在正价列表");

  // checkout / notify / 入帐共用同一个解析器，首充档必须解析得到，否则收钱不履约。
  assert.equal(resolvePricingPlan(FIRST_CHARGE_PLAN_ID)?.id, FIRST_CHARGE_PLAN_ID);
  assert.equal(FIRST_CHARGE_PLAN.price, FIRST_CHARGE_PRICE);
  assert.equal(FIRST_CHARGE_PLAN.coins, FIRST_CHARGE_COINS);
  assert.equal(FIRST_CHARGE_FULL_QUOTA, FIRST_CHARGE_COINS * QUOTA_PER_COIN);

  // 资格不符时的口径 = ¥7 按最便宜正价档折算（向下取整，不吃用户的钱）。
  assert.equal(FIRST_CHARGE_FALLBACK_COINS, Math.floor((FIRST_CHARGE_PRICE / PLANS[0].price) * PLANS[0].coins));
  assert.equal(FIRST_CHARGE_FALLBACK_QUOTA, Math.round(FIRST_CHARGE_FALLBACK_COINS * QUOTA_PER_COIN));
  assert.ok(FIRST_CHARGE_FALLBACK_COINS > 0 && FIRST_CHARGE_FALLBACK_COINS < FIRST_CHARGE_COINS);
  // 4 倍划算：单位币价必须显著低于最便宜正价档。
  assert.ok(
    FIRST_CHARGE_PLAN.price / FIRST_CHARGE_PLAN.coins < PLANS[0].price / PLANS[0].coins,
    "首充单价必须优于正价最便宜档",
  );
});
