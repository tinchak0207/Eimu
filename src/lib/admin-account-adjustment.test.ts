// 管理员调额测试：占位表/上游/帐本用内存替身，幂等语义照生产 SQL 实现
// （占位 PK=Idempotency-Key、同笔 failed 可重占；帐本 idempotency_ref UNIQUE）。

import assert from "node:assert/strict";
import test from "node:test";

import { QUOTA_PER_COIN } from "@/lib/quota-constants";
import { ledgerRef } from "@/lib/generation-core/account-ledger";
import {
  adminAdjustmentSourceRef,
  applyAdminAccountAdjustment,
  parseAdminAdjustmentRequest,
  type AdminAdjustmentClaim,
  type AdminAdjustmentDeps,
  type AdminAdjustmentInput,
} from "./admin-account-adjustment.ts";

interface World {
  quota: Map<number, number>;
  claims: Map<string, AdminAdjustmentClaim>;
  ledger: Map<string, { userId: number; amount: number; note: string }>;
  adjustCalls: number;
  deps: AdminAdjustmentDeps;
}

function world(options: {
  quota?: Record<number, number>;
  adjust?: (userId: number, delta: number, w: World) => Promise<void>;
  baseline?: { ready: boolean; blocked: boolean; reason?: string };
  readQuota?: (userId: number, w: World) => Promise<number | null>;
} = {}): World {
  const w = {
    quota: new Map(Object.entries(options.quota ?? { 7: 1_000_000 }).map(([k, v]) => [Number(k), v])),
    claims: new Map<string, AdminAdjustmentClaim>(),
    ledger: new Map(),
    adjustCalls: 0,
  } as World;
  w.deps = {
    store: {
      async readClaim(key) {
        const claim = w.claims.get(key);
        return claim ? { ...claim } : null;
      },
      async claim({ idempotencyKey, userId, amountQuota }) {
        const current = w.claims.get(idempotencyKey);
        if (current === undefined) {
          w.claims.set(idempotencyKey, { status: "pending", userId, amountQuota, detail: null });
          return true;
        }
        if (current.status === "failed" && current.userId === userId && current.amountQuota === amountQuota) {
          w.claims.set(idempotencyKey, { ...current, status: "pending", detail: null });
          return true;
        }
        return false;
      },
      async mark(key, status, detail) {
        const current = w.claims.get(key)!;
        w.claims.set(key, { ...current, status, detail: detail ?? null });
      },
    },
    async ensureBaseline() {
      return options.baseline ?? { ready: true, blocked: false };
    },
    async readUpstreamQuota(userId) {
      if (options.readQuota) return options.readQuota(userId, w);
      return w.quota.get(userId) ?? null;
    },
    async adjustUpstream(userId, delta) {
      w.adjustCalls += 1;
      if (options.adjust) return options.adjust(userId, delta, w);
      w.quota.set(userId, (w.quota.get(userId) ?? 0) + delta);
    },
    async recordLedger({ userId, amountQuota, sourceRef, note }) {
      const ref = ledgerRef.adjustment(sourceRef);
      if (w.ledger.has(ref)) return { posted: false, reason: "重放" };
      w.ledger.set(ref, { userId, amount: amountQuota, note });
      return { posted: true };
    },
    async readLedgerBalanceQuota(userId) {
      let sum = 0;
      for (const entry of w.ledger.values()) if (entry.userId === userId) sum += entry.amount;
      return sum;
    },
  };
  return w;
}

function input(overrides: Partial<AdminAdjustmentInput> = {}): AdminAdjustmentInput {
  const coins = overrides.coins ?? 10;
  return {
    idempotencyKey: "k-1",
    userId: 7,
    coins,
    amountQuota: Math.round(coins * QUOTA_PER_COIN),
    note: "补偿 9/30 故障",
    ...overrides,
  };
}

test("happy path：上游与帐本两层都写，回帐本余额（币）", async () => {
  const w = world();
  const result = await applyAdminAccountAdjustment(input(), "root", w.deps);
  assert.equal(result.status, "applied");
  assert.equal(result.ledger_posted, true);
  assert.equal(result.balance_coins, 10);
  assert.equal(w.quota.get(7), 1_000_000 + 10 * QUOTA_PER_COIN);
  const row = w.ledger.get(ledgerRef.adjustment(adminAdjustmentSourceRef("k-1")));
  assert.ok(row);
  assert.equal(row.amount, 10 * QUOTA_PER_COIN);
  assert.match(row.note, /root/);
  assert.match(row.note, /补偿 9\/30 故障/);
  assert.equal(w.claims.get("k-1")?.status, "applied");
});

test("负数调额：上游减额、帐本记负数", async () => {
  const w = world();
  const result = await applyAdminAccountAdjustment(input({ coins: -1 }), "root", w.deps);
  assert.equal(result.status, "applied");
  assert.equal(w.quota.get(7), 1_000_000 - QUOTA_PER_COIN);
  assert.equal(result.balance_coins, -1);
});

test("重放同一个键：already_applied，上游与帐本都不双算", async () => {
  const w = world();
  await applyAdminAccountAdjustment(input(), "root", w.deps);
  const again = await applyAdminAccountAdjustment(input(), "root", w.deps);
  assert.equal(again.status, "already_applied");
  assert.equal(again.balance_coins, 10);
  assert.equal(w.adjustCalls, 1);
  assert.equal(w.quota.get(7), 1_000_000 + 10 * QUOTA_PER_COIN);
  assert.equal(w.ledger.size, 1);
});

test("并发同键：只动一次上游", async () => {
  const w = world();
  const results = await Promise.all([
    applyAdminAccountAdjustment(input(), "root", w.deps),
    applyAdminAccountAdjustment(input(), "root", w.deps),
  ]);
  assert.equal(w.adjustCalls, 1);
  assert.deepEqual(results.map((r) => r.status).sort(), ["applied", "in_flight"].sort());
});

test("上游抛错且 quota 未变：failed，同一个键可重试且只加一次", async () => {
  let failOnce = true;
  const w = world({
    adjust: async (userId, delta, ww) => {
      if (failOnce) {
        failOnce = false;
        throw new Error("upstream 500");
      }
      ww.quota.set(userId, (ww.quota.get(userId) ?? 0) + delta);
    },
  });
  const first = await applyAdminAccountAdjustment(input(), "root", w.deps);
  assert.equal(first.status, "failed");
  assert.equal(w.claims.get("k-1")?.status, "failed");
  assert.equal(w.ledger.size, 0);

  const retry = await applyAdminAccountAdjustment(input(), "root", w.deps);
  assert.equal(retry.status, "applied");
  assert.equal(w.adjustCalls, 2);
  assert.equal(w.quota.get(7), 1_000_000 + 10 * QUOTA_PER_COIN);
  assert.equal(w.ledger.size, 1);
});

test("上游抛错但 quota 已变：unknown，不自动重试", async () => {
  const w = world({
    adjust: async (userId, delta, ww) => {
      ww.quota.set(userId, (ww.quota.get(userId) ?? 0) + delta);
      throw new Error("timeout after write");
    },
  });
  const first = await applyAdminAccountAdjustment(input(), "root", w.deps);
  assert.equal(first.status, "in_flight");
  assert.equal(w.claims.get("k-1")?.status, "unknown");
  assert.equal(w.ledger.size, 0);

  const again = await applyAdminAccountAdjustment(input(), "root", w.deps);
  assert.equal(again.status, "in_flight");
  assert.equal(w.adjustCalls, 1);
});

test("上游抛错且 quota 读不到：unknown，不自动重试", async () => {
  let reads = 0;
  const w = world({
    readQuota: async (userId, ww) => (++reads === 1 ? ww.quota.get(userId) ?? null : null),
    adjust: async () => {
      throw new Error("connection reset");
    },
  });
  const first = await applyAdminAccountAdjustment(input(), "root", w.deps);
  assert.equal(first.status, "in_flight");
  assert.equal(w.claims.get("k-1")?.status, "unknown");
  await applyAdminAccountAdjustment(input(), "root", w.deps);
  assert.equal(w.adjustCalls, 1);
});

test("基线 blocked：上游不动，占位改 failed", async () => {
  const w = world({ baseline: { ready: false, blocked: true, reason: "upstream_unavailable" } });
  const result = await applyAdminAccountAdjustment(input(), "root", w.deps);
  assert.equal(result.status, "failed");
  assert.equal(w.adjustCalls, 0);
  assert.equal(w.quota.get(7), 1_000_000);
  assert.equal(w.claims.get("k-1")?.status, "failed");
  assert.equal(w.ledger.size, 0);
});

test("同键换 userId 或金额：conflict，不动上游", async () => {
  const w = world({ quota: { 7: 1_000_000, 8: 0 } });
  await applyAdminAccountAdjustment(input(), "root", w.deps);
  const otherUser = await applyAdminAccountAdjustment(input({ userId: 8 }), "root", w.deps);
  assert.equal(otherUser.status, "conflict");
  const otherAmount = await applyAdminAccountAdjustment(input({ coins: 20 }), "root", w.deps);
  assert.equal(otherAmount.status, "conflict");
  assert.equal(w.adjustCalls, 1);
  assert.equal(w.quota.get(8), 0);
});

test("failed 的键换金额重试：仍是 conflict（不把旧键挪用到另一笔）", async () => {
  const w = world({ baseline: { ready: false, blocked: true } });
  await applyAdminAccountAdjustment(input(), "root", w.deps);
  const result = await applyAdminAccountAdjustment(input({ coins: 99 }), "root", w.deps);
  assert.equal(result.status, "conflict");
  assert.equal(w.adjustCalls, 0);
});

test("请求校验：缺键/非法 userId/coins/note → error", () => {
  const ok = { userId: 7, coins: 1.5, note: "x" };
  assert.ok("error" in parseAdminAdjustmentRequest(null, ok));
  assert.ok("error" in parseAdminAdjustmentRequest("  ", ok));
  assert.ok("error" in parseAdminAdjustmentRequest("bad key!", ok));
  assert.ok("error" in parseAdminAdjustmentRequest("k", { ...ok, userId: 0 }));
  assert.ok("error" in parseAdminAdjustmentRequest("k", { ...ok, userId: 1.5 }));
  assert.ok("error" in parseAdminAdjustmentRequest("k", { ...ok, coins: 0 }));
  assert.ok("error" in parseAdminAdjustmentRequest("k", { ...ok, coins: 100_001 }));
  assert.ok("error" in parseAdminAdjustmentRequest("k", { ...ok, coins: "5" }));
  assert.ok("error" in parseAdminAdjustmentRequest("k", { ...ok, note: "" }));
  assert.ok("error" in parseAdminAdjustmentRequest("k", { ...ok, note: "x".repeat(501) }));
  const parsed = parseAdminAdjustmentRequest("k-1", { ...ok, coins: -100_000 });
  assert.ok("input" in parsed);
  assert.equal(parsed.input.amountQuota, -100_000 * QUOTA_PER_COIN);
});
