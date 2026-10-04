// W5b：单次任务预算闸（伺服器硬停）的纯函式层测试。
//
// 全部在 enforceQuotaGate 这一层打——注入假的配额读取（readAvailableQuota /
// fetchUser）与假的成员名册 SQL，**不连任何真 DB**。三个不变量：
//   ① 没传 cap ⇒ 行为与今天逐位元组相同（零回归）；
//   ② cap 足额 ⇒ 照常放行（0 额快车道）；
//   ③ cap 超限 ⇒ 402 `task_budget_exceeded`，body 带 estimated_coins / cap_coins，
//      且在读任何帐本／上游之前就停（硬停不是「读完再说」）。
//
// runner：`npx --yes tsx --test <档案>`（repo 的 npm test 脚本）。node:test + node:assert。

import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

import { fetchGatewayUser } from "@/lib/gateway-admin";
import type { GenerationSql } from "./database.ts";
import {
  SURGERY_QUOTA_PRECHECK_ENV,
  TASK_BUDGET_EXCEEDED_ERROR,
  enforceQuotaGate,
} from "./quota-precheck.ts";

type GatewayUserReader = typeof fetchGatewayUser;
type Row = Record<string, unknown>;

const CONTROL_PLANE_ENV = {
  GENERATION_DATABASE_URL: "postgres://fake:fake@127.0.0.1:1/fake",
  GENERATION_CONTROL_PLANE_ENABLED: "true",
  [SURGERY_QUOTA_PRECHECK_ENV]: "1",
};

/** 1 币 = 500000 quota（quota-constants 单一真源）。 */
const QUOTA_PER_COIN = 500_000;

/**
 * 402 预算文案（测试独立抄写，不从实现取——实现改字即爆红），与既有
 * insufficient_balance 同一中文句式（只差「余额不足」→「超过预算上限」）。
 */
const BUDGET_MESSAGE = "本次生成费用超过单次任务预算上限，本次未扣费。";

function withEnv(
  overrides: Record<string, string | undefined>,
  fn: () => void | Promise<void>,
): Promise<void> | void {
  const saved: Record<string, string | undefined> = {};
  for (const key of Object.keys(overrides)) saved[key] = process.env[key];
  for (const [key, value] of Object.entries(overrides)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  const restore = () => {
    for (const [key, value] of Object.entries(saved)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  };
  try {
    const result = fn();
    if (result instanceof Promise) return result.finally(restore);
    restore();
  } catch (error) {
    restore();
    throw error;
  }
}

function userReader(quota: number | Error | null, calls: number[] = []): GatewayUserReader {
  return (async (userId: number) => {
    calls.push(userId);
    if (quota instanceof Error) throw quota;
    if (quota === null) return null;
    return { id: userId, username: "biz-user", quota, used_quota: 0 };
  }) as GatewayUserReader;
}

/**
 * 帐本读取注入点：一律回 null（= 帐本不可用）⇒ 预检确定性走 fetchUser 回落路径，
 * 测试绝不尝试碰真 DB。calls 用来证明预算超限时连这一跳都没发生。
 */
function noLedgerReader(calls: number[] = []) {
  return async (billingUserId: number): Promise<number | null> => {
    calls.push(billingUserId);
    return null;
  };
}

/** 成员名册 mock：任何查询都回空（非成员），只记录查询数（预算超限时应为 0）。 */
function mockPrecheckSql(rows: Row[] = []) {
  const queries: string[] = [];
  const tagged = (async (strings: TemplateStringsArray, ...values: unknown[]) => {
    queries.push(strings.join(" | "));
    void values;
    return rows;
  }) as unknown as GenerationSql;
  return { sql: tagged, queries };
}

// ── ① 零回归：没传 cap ─────────────────────────────────────────────────────

test("no cap: decision is identical whether the field is omitted or explicitly undefined", async (t) => {
  await withEnv(CONTROL_PLANE_ENV, async () => {
    t.mock.method(console, "log", () => {});
    const { sql } = mockPrecheckSql();
    const base = { bizKeyId: "key-1", billingUserId: 87, baseBillingAmount: 2 * QUOTA_PER_COIN };
    const omitted = await enforceQuotaGate(base, {
      fetchUser: userReader(582_377_145),
      sql,
      readAvailableQuota: noLedgerReader(),
    });
    const explicit = await enforceQuotaGate(
      { ...base, budgetCapCoins: undefined },
      { fetchUser: userReader(582_377_145), sql, readAvailableQuota: noLedgerReader() },
    );
    assert.deepEqual(omitted, { ok: true, billingAmount: 0 });
    assert.deepEqual(explicit, omitted, "omitted cap vs budgetCapCoins:undefined must be byte-identical");
  });
});

test("no cap: an insufficient balance still rejects as insufficient_balance (budget code never appears)", async (t) => {
  await withEnv(CONTROL_PLANE_ENV, async () => {
    t.mock.method(console, "log", () => {});
    const { sql } = mockPrecheckSql();
    const decision = await enforceQuotaGate(
      { bizKeyId: "key-1", billingUserId: 115, baseBillingAmount: 2 * QUOTA_PER_COIN },
      { fetchUser: userReader(100_000), sql, readAvailableQuota: noLedgerReader() },
    );
    assert.equal(decision.ok, false);
    if (!decision.ok) {
      assert.equal(decision.code, "insufficient_balance");
      assert.notEqual(decision.code, "task_budget_exceeded");
    }
  });
});

// ── ② cap 足额 ⇒ 放行 ──────────────────────────────────────────────────────

test("cap covers the estimate ⇒ allowed (boundary inclusive, `>` not `>=`)", async (t) => {
  await withEnv(CONTROL_PLANE_ENV, async () => {
    t.mock.method(console, "log", () => {});
    const { sql } = mockPrecheckSql();
    const deps = {
      fetchUser: userReader(582_377_145),
      sql,
      readAvailableQuota: noLedgerReader(),
    };
    // 1 币任务，cap = 1 币：恰好等于上限，必须放行（strict greater-than）。
    const boundary = await enforceQuotaGate(
      { bizKeyId: "key-1", billingUserId: 87, baseBillingAmount: QUOTA_PER_COIN, budgetCapCoins: 1 },
      deps,
    );
    assert.deepEqual(boundary, { ok: true, billingAmount: 0 });

    // cap 宽裕 → 放行。
    const roomy = await enforceQuotaGate(
      { bizKeyId: "key-1", billingUserId: 87, baseBillingAmount: QUOTA_PER_COIN, budgetCapCoins: 5 },
      { fetchUser: userReader(582_377_145), sql, readAvailableQuota: noLedgerReader() },
    );
    assert.deepEqual(roomy, { ok: true, billingAmount: 0 });
  });
});

// ── ③ cap 超限 ⇒ 402 task_budget_exceeded ＋ 结构化数字，且零帐本 IO ─────────

test("estimate exceeds cap ⇒ 402 task_budget_exceeded carrying estimated_coins/cap_coins, before any ledger read", async (t) => {
  await withEnv(CONTROL_PLANE_ENV, async () => {
    t.mock.method(console, "log", () => {});
    const ledgerCalls: number[] = [];
    const userCalls: number[] = [];
    const { sql, queries } = mockPrecheckSql();
    // 2 币任务 vs cap 1 币 → 超限。上游余额故意设成充足：预算硬停与余额无关。
    const decision = await enforceQuotaGate(
      { bizKeyId: "key-1", billingUserId: 87, baseBillingAmount: 2 * QUOTA_PER_COIN, budgetCapCoins: 1 },
      { fetchUser: userReader(582_377_145, userCalls), sql, readAvailableQuota: noLedgerReader(ledgerCalls) },
    );
    assert.deepEqual(decision, {
      ok: false,
      status: 402,
      type: "task_budget_exceeded",
      code: "task_budget_exceeded",
      message: BUDGET_MESSAGE,
      estimated_coins: 2,
      cap_coins: 1,
    });
    // 硬停语义：在读帐本／上游／成员名册之前就停，不为一个注定被挡的任务花 IO。
    assert.deepEqual(ledgerCalls, []);
    assert.deepEqual(userCalls, []);
    assert.deepEqual(queries, []);
    // 文案与 insufficient_balance 同族但不同码（不是余额问题，不导向充值页）。
    assert.equal(TASK_BUDGET_EXCEEDED_ERROR.status, decision.status);
    assert.notEqual(decision.code, "insufficient_balance");
  });
});

// ── ④ 非有限数输入不得误触 ─────────────────────────────────────────────────

test("non-finite cap (NaN/Infinity/-Infinity) never trips the budget gate", async (t) => {
  await withEnv(CONTROL_PLANE_ENV, async () => {
    t.mock.method(console, "log", () => {});
    const { sql } = mockPrecheckSql();
    for (const cap of [Number.NaN, Number.POSITIVE_INFINITY, Number.NEGATIVE_INFINITY]) {
      const decision = await enforceQuotaGate(
        { bizKeyId: "key-1", billingUserId: 87, baseBillingAmount: 2 * QUOTA_PER_COIN, budgetCapCoins: cap },
        { fetchUser: userReader(582_377_145), sql, readAvailableQuota: noLedgerReader() },
      );
      assert.deepEqual(decision, { ok: true, billingAmount: 0 }, `cap=${cap} must not block a real task`);
    }
  });
});

// ── ⑤ cap 与 SURGERY_QUOTA_PRECHECK 开关解耦：宣告上限是硬天花板 ────────────

test("budget hard stop fires with the precheck switch OFF; no cap stays verbatim under the same switch", async () => {
  await withEnv({ [SURGERY_QUOTA_PRECHECK_ENV]: undefined }, async () => {
    const { sql } = mockPrecheckSql();
    // 开关关掉 + cap 超限 → 仍硬停（宣告的安全上限不因影子期开关失效）。
    const blocked = await enforceQuotaGate(
      { bizKeyId: "key-1", billingUserId: 87, baseBillingAmount: 2 * QUOTA_PER_COIN, budgetCapCoins: 1 },
      { fetchUser: userReader(582_377_145), sql, readAvailableQuota: noLedgerReader() },
    );
    assert.equal(blocked.ok, false);
    if (!blocked.ok) assert.equal(blocked.code, "task_budget_exceeded");

    // 开关关掉 + 没 cap → 与今天同义：原金额直通，零 IO。
    const passthrough = await enforceQuotaGate(
      { bizKeyId: "key-1", billingUserId: 87, baseBillingAmount: 2 * QUOTA_PER_COIN },
      { fetchUser: userReader(582_377_145), sql, readAvailableQuota: noLedgerReader() },
    );
    assert.deepEqual(passthrough, { ok: true, billingAmount: 2 * QUOTA_PER_COIN });
  });
});

// ── ⑥ 路由接线探针（source-scan；变更探针，非行为 oracle）────────────────────
//
// 只证明「两条示范路由有接上 cap 这条线」；真正的 E2E 402（真帐户、真请求）
// 属未验证项，见回报。行为正确性由上面 ①②③④⑤ 的纯函式层保证。

test("route wiring probe: images & videos routes accept cap_coins, forward it, and render the budget 402 body", () => {
  for (const rel of [
    "src/app/api/v1/images/generations/route.ts",
    "src/app/api/v1/videos/generations/route.ts",
  ]) {
    const source = readFileSync(join(process.cwd(), rel), "utf8");
    assert.match(source, /cap_coins\??:\s*unknown/, `${rel}: 必须在请求体型别宣告 cap_coins`);
    assert.match(source, /budgetCapCoins,/, `${rel}: 必须把 cap 传进 enforceQuotaGate`);
    assert.match(source, /gate\.code === "task_budget_exceeded"/, `${rel}: 必须分流预算超限`);
    assert.match(source, /estimated_coins:\s*gate\.estimated_coins/, `${rel}: 402 body 必须带 estimated_coins`);
    assert.match(source, /cap_coins:\s*gate\.cap_coins/, `${rel}: 402 body 必须带 cap_coins`);
  }
});
