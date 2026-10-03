// W5b：單次任務預算閘（伺服器硬停）的純函式層測試。
//
// 全部在 enforceQuotaGate 這一層打——注入假的配額讀取（readAvailableQuota /
// fetchUser）與假的成員名冊 SQL，**不連任何真 DB**。三個不變量：
//   ① 沒傳 cap ⇒ 行為與今天逐位元組相同（零回歸）；
//   ② cap 足額 ⇒ 照常放行（0 額快車道）；
//   ③ cap 超限 ⇒ 402 `task_budget_exceeded`，body 帶 estimated_coins / cap_coins，
//      且在讀任何帳本／上游之前就停（硬停不是「讀完再說」）。
//
// runner：`npx --yes tsx --test <檔案>`（repo 的 npm test 腳本）。node:test + node:assert。

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

/** 1 幣 = 500000 quota（quota-constants 單一真源）。 */
const QUOTA_PER_COIN = 500_000;

/**
 * 402 預算文案（測試獨立抄寫，不從實現取——實現改字即爆紅），與既有
 * insufficient_balance 同一中文句式（只差「餘額不足」→「超過預算上限」）。
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
 * 帳本讀取注入點：一律回 null（= 帳本不可用）⇒ 預檢確定性走 fetchUser 回落路徑，
 * 測試絕不嘗試碰真 DB。calls 用來證明預算超限時連這一跳都沒發生。
 */
function noLedgerReader(calls: number[] = []) {
  return async (billingUserId: number): Promise<number | null> => {
    calls.push(billingUserId);
    return null;
  };
}

/** 成員名冊 mock：任何查詢都回空（非成員），只記錄查詢數（預算超限時應為 0）。 */
function mockPrecheckSql(rows: Row[] = []) {
  const queries: string[] = [];
  const tagged = (async (strings: TemplateStringsArray, ...values: unknown[]) => {
    queries.push(strings.join(" | "));
    void values;
    return rows;
  }) as unknown as GenerationSql;
  return { sql: tagged, queries };
}

// ── ① 零回歸：沒傳 cap ─────────────────────────────────────────────────────

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

// ── ② cap 足額 ⇒ 放行 ──────────────────────────────────────────────────────

test("cap covers the estimate ⇒ allowed (boundary inclusive, `>` not `>=`)", async (t) => {
  await withEnv(CONTROL_PLANE_ENV, async () => {
    t.mock.method(console, "log", () => {});
    const { sql } = mockPrecheckSql();
    const deps = {
      fetchUser: userReader(582_377_145),
      sql,
      readAvailableQuota: noLedgerReader(),
    };
    // 1 幣任務，cap = 1 幣：恰好等於上限，必須放行（strict greater-than）。
    const boundary = await enforceQuotaGate(
      { bizKeyId: "key-1", billingUserId: 87, baseBillingAmount: QUOTA_PER_COIN, budgetCapCoins: 1 },
      deps,
    );
    assert.deepEqual(boundary, { ok: true, billingAmount: 0 });

    // cap 寬裕 → 放行。
    const roomy = await enforceQuotaGate(
      { bizKeyId: "key-1", billingUserId: 87, baseBillingAmount: QUOTA_PER_COIN, budgetCapCoins: 5 },
      { fetchUser: userReader(582_377_145), sql, readAvailableQuota: noLedgerReader() },
    );
    assert.deepEqual(roomy, { ok: true, billingAmount: 0 });
  });
});

// ── ③ cap 超限 ⇒ 402 task_budget_exceeded ＋ 結構化數字，且零帳本 IO ─────────

test("estimate exceeds cap ⇒ 402 task_budget_exceeded carrying estimated_coins/cap_coins, before any ledger read", async (t) => {
  await withEnv(CONTROL_PLANE_ENV, async () => {
    t.mock.method(console, "log", () => {});
    const ledgerCalls: number[] = [];
    const userCalls: number[] = [];
    const { sql, queries } = mockPrecheckSql();
    // 2 幣任務 vs cap 1 幣 → 超限。上游餘額故意設成充足：預算硬停與餘額無關。
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
    // 硬停語義：在讀帳本／上游／成員名冊之前就停，不為一個註定被擋的任務花 IO。
    assert.deepEqual(ledgerCalls, []);
    assert.deepEqual(userCalls, []);
    assert.deepEqual(queries, []);
    // 文案與 insufficient_balance 同族但不同碼（不是餘額問題，不導向充值頁）。
    assert.equal(TASK_BUDGET_EXCEEDED_ERROR.status, decision.status);
    assert.notEqual(decision.code, "insufficient_balance");
  });
});

// ── ④ 非有限數輸入不得誤觸 ─────────────────────────────────────────────────

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

// ── ⑤ cap 與 SURGERY_QUOTA_PRECHECK 開關解耦：宣告上限是硬天花板 ────────────

test("budget hard stop fires with the precheck switch OFF; no cap stays verbatim under the same switch", async () => {
  await withEnv({ [SURGERY_QUOTA_PRECHECK_ENV]: undefined }, async () => {
    const { sql } = mockPrecheckSql();
    // 開關關掉 + cap 超限 → 仍硬停（宣告的安全上限不因影子期開關失效）。
    const blocked = await enforceQuotaGate(
      { bizKeyId: "key-1", billingUserId: 87, baseBillingAmount: 2 * QUOTA_PER_COIN, budgetCapCoins: 1 },
      { fetchUser: userReader(582_377_145), sql, readAvailableQuota: noLedgerReader() },
    );
    assert.equal(blocked.ok, false);
    if (!blocked.ok) assert.equal(blocked.code, "task_budget_exceeded");

    // 開關關掉 + 沒 cap → 與今天同義：原金額直通，零 IO。
    const passthrough = await enforceQuotaGate(
      { bizKeyId: "key-1", billingUserId: 87, baseBillingAmount: 2 * QUOTA_PER_COIN },
      { fetchUser: userReader(582_377_145), sql, readAvailableQuota: noLedgerReader() },
    );
    assert.deepEqual(passthrough, { ok: true, billingAmount: 2 * QUOTA_PER_COIN });
  });
});

// ── ⑥ 路由接線探針（source-scan；變更探針，非行為 oracle）────────────────────
//
// 只證明「兩條示範路由有接上 cap 這條線」；真正的 E2E 402（真帳戶、真請求）
// 屬未驗證項，見回報。行為正確性由上面 ①②③④⑤ 的純函式層保證。

test("route wiring probe: images & videos routes accept cap_coins, forward it, and render the budget 402 body", () => {
  for (const rel of [
    "src/app/api/v1/images/generations/route.ts",
    "src/app/api/v1/videos/generations/route.ts",
  ]) {
    const source = readFileSync(join(process.cwd(), rel), "utf8");
    assert.match(source, /cap_coins\??:\s*unknown/, `${rel}: 必須在請求體型別宣告 cap_coins`);
    assert.match(source, /budgetCapCoins,/, `${rel}: 必須把 cap 傳進 enforceQuotaGate`);
    assert.match(source, /gate\.code === "task_budget_exceeded"/, `${rel}: 必須分流預算超限`);
    assert.match(source, /estimated_coins:\s*gate\.estimated_coins/, `${rel}: 402 body 必須帶 estimated_coins`);
    assert.match(source, /cap_coins:\s*gate\.cap_coins/, `${rel}: 402 body 必須帶 cap_coins`);
  }
});
