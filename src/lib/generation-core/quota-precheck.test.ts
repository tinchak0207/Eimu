import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

import { fetchGatewayUser } from "@/lib/gateway-admin";
import { MEMBER_QUOTA_DISABLED_MESSAGE, MEMBER_QUOTA_INSUFFICIENT_MESSAGE } from "./member-quota.ts";
import type { GenerationSql } from "./database.ts";
import {
  SURGERY_QUOTA_PRECHECK_ENV,
  checkQuotaAvailable,
  enforceQuotaGate,
  surgeryQuotaPrecheckEnabled,
} from "./quota-precheck.ts";

type GatewayUserReader = typeof fetchGatewayUser;
type Row = Record<string, unknown>;

const CONTROL_PLANE_ENV = {
  GENERATION_DATABASE_URL: "postgres://fake:fake@127.0.0.1:1/fake",
  GENERATION_CONTROL_PLANE_ENABLED: "true",
  [SURGERY_QUOTA_PRECHECK_ENV]: "1",
};

function withEnv(overrides: Record<string, string | undefined>, fn: () => void | Promise<void>): Promise<void> | void {
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

function neverReader(calls: number[] = []): GatewayUserReader {
  return (async (userId: number) => {
    calls.push(userId);
    return new Promise<never>(() => undefined);
  }) as GatewayUserReader;
}

/**
 * 預檢 SQL mock：記錄每一次查詢。
 * - `team_member_quota`（成員名冊，按 user_id 判成員）→ memberRows。
 * - 其餘任何查詢 → decoyRows：G1 之後預檢不該再有任何其他查詢，一旦有人把
 *   012 token 映射查詢加回來，queries 會記到、下面的負向斷言即紅。
 */
function mockPrecheckSql(memberRows: Row[] = [], decoyRows: Row[] = []) {
  const queries: string[] = [];
  const tagged = (async (strings: TemplateStringsArray, ...values: unknown[]) => {
    const query = strings.join(" | ");
    queries.push(query);
    void values;
    if (query.includes("team_member_quota")) return memberRows;
    return decoyRows;
  }) as unknown as GenerationSql;
  return { sql: tagged, queries };
}

/** 012 映射表殘留列（表還在、代碼已拔除）：只當「不被查詢」的誘餌。 */
const LEGACY_TOKEN_MAPPING_ROW = { biz_key_id: "key-1", token_id: 42, token_key_preview: "" };

function memberRow(overrides: Row = {}): Row {
  return {
    id: "member-1",
    team_user_id: 115,
    member_key_id: "key-1",
    // 成員 = new-api 另一個 user（配額桶在 user 層）；成員 key 的 billingUserId 就是它。
    member_user_id: 115,
    display_name: "成员A",
    enabled: true,
    ...overrides,
  };
}

/** 去註釋後的預檢源碼（負向斷言只看代碼，不看歷史註釋）。 */
function precheckCode(): string {
  return readFileSync(join(process.cwd(), "src/lib/generation-core/quota-precheck.ts"), "utf8")
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/^\s*\/\/.*$/gm, "");
}

// ── 開關解析 ──────────────────────────────────────────────────────────────

test("surgery switch parses strictly: only literal 1 enables", () => {
  assert.equal(surgeryQuotaPrecheckEnabled({}), false);
  assert.equal(surgeryQuotaPrecheckEnabled({ [SURGERY_QUOTA_PRECHECK_ENV]: "0" }), false);
  assert.equal(surgeryQuotaPrecheckEnabled({ [SURGERY_QUOTA_PRECHECK_ENV]: "true" }), false);
  assert.equal(surgeryQuotaPrecheckEnabled({ [SURGERY_QUOTA_PRECHECK_ENV]: "2" }), false);
  assert.equal(surgeryQuotaPrecheckEnabled({ [SURGERY_QUOTA_PRECHECK_ENV]: "1" }), true);
  assert.equal(surgeryQuotaPrecheckEnabled({ [SURGERY_QUOTA_PRECHECK_ENV]: " 1 " }), true);
});

// ── 預檢三態 ──────────────────────────────────────────────────────────────

test("precheck verdict available when users.quota covers the required amount (boundary inclusive)", async () => {
  const calls: number[] = [];
  const verdict = await checkQuotaAvailable(
    { billingUserId: 87, requiredQuota: 500_000 },
    { fetchUser: userReader(582_377_145, calls) },
  );
  assert.deepEqual(calls, [87]);
  assert.deepEqual(verdict, { verdict: "available", quota: 582_377_145 });

  const boundary = await checkQuotaAvailable(
    { billingUserId: 87, requiredQuota: 582_377_145 },
    { fetchUser: userReader(582_377_145) },
  );
  assert.equal(boundary.verdict, "available");
});

test("precheck verdict insufficient keeps the real balance and requirement", async () => {
  const verdict = await checkQuotaAvailable(
    { billingUserId: 115, requiredQuota: 250_000 },
    { fetchUser: userReader(100_000) },
  );
  assert.deepEqual(verdict, { verdict: "insufficient", quota: 100_000, requiredQuota: 250_000 });
});

test("precheck verdict unreachable on gateway error, missing user, timeout, or unusable billing user", async () => {
  const thrown = await checkQuotaAvailable(
    { billingUserId: 82, requiredQuota: 250_000 },
    { fetchUser: userReader(new Error("fetch failed")) },
  );
  assert.equal(thrown.verdict, "unreachable");
  assert.ok(thrown.reason.includes("fetch failed"));

  const missing = await checkQuotaAvailable(
    { billingUserId: 82, requiredQuota: 250_000 },
    { fetchUser: userReader(null) },
  );
  assert.equal(missing.verdict, "unreachable");

  const timedOut = await checkQuotaAvailable(
    { billingUserId: 82, requiredQuota: 250_000 },
    { fetchUser: neverReader(), timeoutMs: 10 },
  );
  assert.equal(timedOut.verdict, "unreachable");
  assert.ok(timedOut.reason.includes("timed out"));

  // user_id=0 是「無從計費」應急通道：fail-closed 且不發請求。
  const calls: number[] = [];
  const noUser = await checkQuotaAvailable(
    { billingUserId: 0, requiredQuota: 250_000 },
    { fetchUser: userReader(582_377_145, calls) },
  );
  assert.equal(noUser.verdict, "unreachable");
  assert.deepEqual(calls, []);
});

// ── 閘門兩態 ──────────────────────────────────────────────────────────────

test("gate OFF = incumbent path verbatim: original amount, zero extra IO", async () => {
  await withEnv({ [SURGERY_QUOTA_PRECHECK_ENV]: undefined }, async () => {
    const calls: number[] = [];
    const { sql, queries } = mockPrecheckSql();
    const decision = await enforceQuotaGate(
      { bizKeyId: "key-1", billingUserId: 87, baseBillingAmount: 1_250_000 },
      { fetchUser: userReader(582_377_145, calls), sql },
    );
    assert.deepEqual(decision, { ok: true, billingAmount: 1_250_000 });
    assert.deepEqual(calls, []);
    assert.deepEqual(queries, []);
  });
});

test("gate ON with zero-amount submission passes through without IO (TTS today)", async () => {
  await withEnv(CONTROL_PLANE_ENV, async () => {
    const calls: number[] = [];
    const { sql, queries } = mockPrecheckSql();
    const decision = await enforceQuotaGate(
      { bizKeyId: "key-1", billingUserId: 87, baseBillingAmount: 0 },
      { fetchUser: userReader(0, calls), sql },
    );
    assert.deepEqual(decision, { ok: true, billingAmount: 0 });
    assert.deepEqual(calls, []);
    assert.deepEqual(queries, []);
  });
});

// ── G1（2026-09-23 裁定）：無 token 映射的 key 不再 fail-closed ─────────────
//
// 舊行為：biz_key 無 012 映射 → 503 control_plane_unavailable（fail-closed），
// 後果是「09-17 之後簽發的任何 key 首次使用必 503」的地雷類別。
// 新行為：映射依賴整段拔除，無映射的 key 與有映射的 key 逐位同路——只按 user
// 額度閘（額度足 → 0 額快車道放行；不足 → 既有 402 契約）。

test("(a) 無 token 映射 + user 額度足 → 放行（0 額快車道，不再 503）", async (t) => {
  await withEnv(CONTROL_PLANE_ENV, async () => {
    const errorLog = t.mock.method(console, "error", () => {});
    t.mock.method(console, "log", () => {});
    const calls: number[] = [];
    // decoyRows 擺著 012 映射列：若預檢還查映射表就會拿到它，本測試即暴露。
    const { sql, queries } = mockPrecheckSql([], [LEGACY_TOKEN_MAPPING_ROW]);
    const decision = await enforceQuotaGate(
      { bizKeyId: "key-without-mapping", billingUserId: 87, baseBillingAmount: 250_000 },
      { fetchUser: userReader(582_377_145, calls), sql },
    );
    assert.deepEqual(decision, { ok: true, billingAmount: 0 }, "無映射的 key 必須照常走 user 額度並放行");
    assert.deepEqual(calls, [87], "必須真的讀了 user 額度（舊行為是不發請求直接 503）");
    assert.equal(queries.length, 1, "預檢只剩成員名冊一跳");
    assert.ok(queries[0].includes("team_member_quota"));
    assert.ok(queries.every((q) => !q.includes("biz_key_newapi_token")), "不得再查 012 映射表");
    const logged = errorLog.mock.calls.map((call) => call.arguments.join(" ")).join("\n");
    assert.ok(!logged.includes("no new-api token mapping"));
    assert.ok(!logged.includes("fail-closed"));
  });
});

test("(b) 無 token 映射 + user 額度不足 → 既有 402 契約（文案逐字）", async (t) => {
  await withEnv(CONTROL_PLANE_ENV, async () => {
    t.mock.method(console, "log", () => {});
    const { sql } = mockPrecheckSql([], [LEGACY_TOKEN_MAPPING_ROW]);
    const decision = await enforceQuotaGate(
      { bizKeyId: "key-without-mapping", billingUserId: 115, baseBillingAmount: 250_000 },
      { fetchUser: userReader(100_000), sql },
    );
    assert.equal(decision.ok, false);
    if (!decision.ok) {
      assert.equal(decision.status, 402);
      assert.equal(decision.type, "insufficient_quota");
      assert.equal(decision.code, "insufficient_quota");
      assert.equal(decision.message, "余额不足，请先充值。", "402 文案與既有契約一字不改");
    }
  });
});

test("(c) 有映射的 key 行為逐位不變（舊三態回歸：放行/402/回落）", async (t) => {
  await withEnv(CONTROL_PLANE_ENV, async () => {
    t.mock.method(console, "log", () => {});
    t.mock.method(console, "error", () => {});
    // 「有映射」在解耦後只剩下 DB 有那一列的事實；預檢決策必須與無映射逐位相等。
    const run = async (decoy: Row[]) => {
      const { sql, queries } = mockPrecheckSql([], decoy);
      const pass = await enforceQuotaGate(
        { bizKeyId: "key-1", billingUserId: 87, baseBillingAmount: 250_000 },
        { fetchUser: userReader(582_377_145), sql },
      );
      const short = await enforceQuotaGate(
        { bizKeyId: "key-1", billingUserId: 87, baseBillingAmount: 250_000 },
        { fetchUser: userReader(100_000), sql },
      );
      const down = await enforceQuotaGate(
        { bizKeyId: "key-1", billingUserId: 87, baseBillingAmount: 250_000 },
        { fetchUser: userReader(new Error("connect ECONNREFUSED")), sql },
      );
      return { pass, short, down, queries };
    };

    const unmapped = await run([]);
    const mapped = await run([LEGACY_TOKEN_MAPPING_ROW]);

    assert.deepEqual(unmapped.pass, { ok: true, billingAmount: 0 });
    assert.deepEqual(mapped.pass, unmapped.pass, "有映射 vs 無映射：放行面逐位相等");
    assert.deepEqual(mapped.short, unmapped.short, "有映射 vs 無映射：402 面逐位相等");
    assert.deepEqual(mapped.short.ok === false ? mapped.short.message : "", "余额不足，请先充值。");
    assert.deepEqual(mapped.down, unmapped.down, "有映射 vs 無映射：回落面逐位相等");
    assert.deepEqual(mapped.down, { ok: true, billingAmount: 250_000 });
    for (const { queries } of [unmapped, mapped]) {
      assert.ok(queries.every((q) => !q.includes("biz_key_newapi_token")), "任何一態都不得查映射表");
    }
  });
});

test("gate ON with sufficient quota skips the blocking reserve (billingAmount = 0)", async (t) => {
  await withEnv(CONTROL_PLANE_ENV, async () => {
    t.mock.method(console, "log", () => {});
    const { sql, queries } = mockPrecheckSql();
    const decision = await enforceQuotaGate(
      { bizKeyId: "key-1", billingUserId: 87, baseBillingAmount: 250_000 },
      { fetchUser: userReader(582_377_145), sql },
    );
    assert.deepEqual(decision, { ok: true, billingAmount: 0 });
    // 一跳：成員名冊（未登記成員 = 不受成員配額執法）；映射表已不再被查。
    assert.equal(queries.length, 1);
    assert.ok(queries[0].includes("team_member_quota"));
  });
});

test("gate ON with insufficient quota rejects under the existing 402 contract", async (t) => {
  await withEnv(CONTROL_PLANE_ENV, async () => {
    t.mock.method(console, "error", () => {});
    const { sql } = mockPrecheckSql();
    const decision = await enforceQuotaGate(
      { bizKeyId: "key-1", billingUserId: 115, baseBillingAmount: 250_000 },
      { fetchUser: userReader(100_000), sql },
    );
    assert.equal(decision.ok, false);
    if (!decision.ok) {
      assert.equal(decision.status, 402);
      assert.equal(decision.type, "insufficient_quota");
      assert.equal(decision.code, "insufficient_quota");
      assert.equal(decision.message, "余额不足，请先充值。");
    }
  });
});

test("(d) unreachable new-api falls back to the incumbent reserve path unchanged (ok:true)", async (t) => {
  await withEnv(CONTROL_PLANE_ENV, async () => {
    const errorLog = t.mock.method(console, "error", () => {});
    const { sql } = mockPrecheckSql();
    const decision = await enforceQuotaGate(
      { bizKeyId: "key-1", billingUserId: 82, baseBillingAmount: 250_000 },
      { fetchUser: userReader(new Error("connect ECONNREFUSED")), sql },
    );
    assert.deepEqual(decision, { ok: true, billingAmount: 250_000 });
    const logged = errorLog.mock.calls.map((call) => call.arguments.join(" ")).join("\n");
    assert.ok(logged.includes("falling back to incumbent reserve"));
  });
});

test("gate ON with unusable billing user (user_id=0) falls back without a gateway call", async () => {
  await withEnv(CONTROL_PLANE_ENV, async () => {
    const calls: number[] = [];
    const { sql, queries } = mockPrecheckSql();
    const decision = await enforceQuotaGate(
      { bizKeyId: "key-1", billingUserId: 0, baseBillingAmount: 250_000 },
      { fetchUser: userReader(582_377_145, calls), sql },
    );
    assert.deepEqual(decision, { ok: true, billingAmount: 250_000 });
    assert.deepEqual(calls, []);
    assert.equal(queries.length, 1, "只剩成員名冊一跳");
  });
});

// ── (e) 負向釘：映射 fail-closed 路徑與映射模組不得回來 ────────────────────

test("(e) 負向釘：預檢源碼不得再有 012 映射 fail-closed 路徑，映射模組檔已刪", () => {
  const source = precheckCode();
  for (const forbidden of [
    "biz_key_newapi_token",
    "findNewApiTokenIdForBizKey",
    "biz-key-token-mapping",
    "no new-api token mapping",
    "migration 012 contract",
    "tokenId",
  ]) {
    assert.ok(!source.includes(forbidden), `預檢代碼不得再出現 ${forbidden}`);
  }
  // 503 control_plane_unavailable 只准留在受管成員分支（B1-v2 不變量），且必須在
  // 成員判定之後 —— 映射面不得再有 fail-closed 出口（舊出口在成員判定之前）。
  const memberLookupAt = source.indexOf("?? findMemberByUserId)(input.billingUserId");
  assert.ok(memberLookupAt > 0, "應能定位成員判定呼叫點");
  const exits = [...source.matchAll(/\.\.\.CONTROL_PLANE_UNAVAILABLE/g)].map((m) => m.index ?? -1);
  assert.ok(exits.length >= 1, "成員分支的 503 fail-closed 必須保留（B1-v2 不變量）");
  for (const at of exits) assert.ok(at > memberLookupAt, "503 出口必須在成員判定之後（映射面不得再有）");
  // 映射模組本體已刪（DB 表與 migration 012 只作歷史留存）。
  assert.throws(() => readFileSync(join(process.cwd(), "src/lib/generation-core/biz-key-token-mapping.ts"), "utf8"));
});

// ── 成員點數配額（REQ-B1，user 層）：消耗面先判成員 user 額度再走既有計費戶檢查 ──

/** 成員 user 配額桶的權威讀數（new-api users.quota / used_quota）。 */
function memberQuotaReader(
  snapshot: { granted: number; used: number; remaining: number; unlimited?: boolean } | null,
  calls: number[] = [],
  order?: string[],
) {
  return async (memberUserId: number) => {
    calls.push(memberUserId);
    order?.push("member");
    if (!snapshot) return null;
    return {
      memberUserId,
      granted: snapshot.granted,
      used: snapshot.used,
      remaining: snapshot.remaining,
      unlimited: snapshot.unlimited === true,
    };
  };
}

test("成員額度不足 → 402 契約碼不變，文案與主帳不足明確區分", async (t) => {
  await withEnv(CONTROL_PLANE_ENV, async () => {
    t.mock.method(console, "log", () => {});
    const order: string[] = [];
    const calls: number[] = [];
    const { sql } = mockPrecheckSql([memberRow()]);
    const decision = await enforceQuotaGate(
      { bizKeyId: "key-1", billingUserId: 115, baseBillingAmount: 250_000 },
      {
        // 上游有回應，但成員 user 那桶只剩 100_000 —— 必須以「成員額度不足」拒單。
        fetchUser: userReader(582_377_145),
        sql,
        readMemberQuota: memberQuotaReader(
          { granted: 1_000_000, used: 900_000, remaining: 100_000 },
          calls,
          order,
        ),
      },
    );
    assert.equal(decision.ok, false);
    if (!decision.ok) {
      assert.equal(decision.status, 402);
      assert.equal(decision.type, "insufficient_quota");
      assert.equal(decision.code, "insufficient_quota");
      assert.equal(decision.message, MEMBER_QUOTA_INSUFFICIENT_MESSAGE);
      assert.notEqual(decision.message, "余额不足，请先充值。");
    }
    assert.deepEqual(order, ["member"], "成員額度不足時必須已判過成員額度");
    assert.deepEqual(calls, [115], "成員讀數按 user_id 讀（成員 key 的計費 user）");
  });
});

test("先判成員額度再走既有計費戶檢查：次序可證，且計費戶不足用既有文案", async (t) => {
  await withEnv(CONTROL_PLANE_ENV, async () => {
    t.mock.method(console, "log", () => {});
    const order: string[] = [];
    const calls: number[] = [];
    const { sql } = mockPrecheckSql([memberRow()]);
    const decision = await enforceQuotaGate(
      { bizKeyId: "key-1", billingUserId: 115, baseBillingAmount: 250_000 },
      {
        // 成員桶充足（剩 500 幣），計費戶只剩 0.2 幣 → 既有「餘額不足」文案。
        fetchUser: (async (userId: number) => {
          calls.push(userId);
          order.push("billing");
          return { id: userId, username: "biz-user", quota: 100_000, used_quota: 0 };
        }) as unknown as typeof fetchGatewayUser,
        sql,
        readMemberQuota: memberQuotaReader(
          { granted: 250_000_000, used: 0, remaining: 250_000_000 },
          [],
          order,
        ),
      },
    );
    assert.equal(decision.ok, false);
    if (!decision.ok) {
      assert.equal(decision.status, 402);
      assert.equal(decision.code, "insufficient_quota");
      assert.equal(decision.message, "余额不足，请先充值。", "主帳不足維持既有契約文案，一字不改");
    }
    assert.deepEqual(order, ["member", "billing"], "先成員額度、後既有計費戶檢查");
    assert.deepEqual(calls, [115]);
  });
});

test("成員額度與計費戶都充足 → 0 額快車道（billingAmount = 0）", async (t) => {
  await withEnv(CONTROL_PLANE_ENV, async () => {
    t.mock.method(console, "log", () => {});
    const { sql } = mockPrecheckSql([memberRow()]);
    const decision = await enforceQuotaGate(
      { bizKeyId: "key-1", billingUserId: 115, baseBillingAmount: 250_000 },
      {
        fetchUser: userReader(582_377_145),
        sql,
        readMemberQuota: memberQuotaReader({ granted: 250_000_000, used: 0, remaining: 250_000_000 }),
      },
    );
    assert.deepEqual(decision, { ok: true, billingAmount: 0 });
  });
});

test("受管成員的額度讀不到／unlimited → 503 fail-closed，不靜默放行", async (t) => {
  await withEnv(CONTROL_PLANE_ENV, async () => {
    const errorLog = t.mock.method(console, "error", () => {});
    const { sql } = mockPrecheckSql([memberRow()]);

    for (const reader of [
      memberQuotaReader(null),
      memberQuotaReader({ granted: 0, used: 0, remaining: 0, unlimited: true }),
    ]) {
      const decision = await enforceQuotaGate(
        { bizKeyId: "key-1", billingUserId: 115, baseBillingAmount: 250_000 },
        { fetchUser: userReader(582_377_145), sql, readMemberQuota: reader },
      );
      assert.equal(decision.ok, false);
      if (!decision.ok) {
        assert.equal(decision.status, 503);
        assert.equal(decision.code, "control_plane_unavailable");
      }
    }
    const logged = errorLog.mock.calls.map((call) => call.arguments.join(" ")).join("\n");
    assert.ok(logged.includes("no enforceable member quota"));
  });
});

test("成員額度被停用 → 402（同契約碼，文案指向團隊主帳號）", async (t) => {
  await withEnv(CONTROL_PLANE_ENV, async () => {
    t.mock.method(console, "log", () => {});
    const { sql } = mockPrecheckSql([memberRow({ enabled: false })]);
    const decision = await enforceQuotaGate(
      { bizKeyId: "key-1", billingUserId: 115, baseBillingAmount: 250_000 },
      {
        fetchUser: userReader(582_377_145),
        sql,
        readMemberQuota: memberQuotaReader({ granted: 250_000_000, used: 0, remaining: 250_000_000 }),
      },
    );
    assert.equal(decision.ok, false);
    if (!decision.ok) {
      assert.equal(decision.status, 402);
      assert.equal(decision.code, "insufficient_quota");
      assert.equal(decision.message, MEMBER_QUOTA_DISABLED_MESSAGE);
    }
  });
});

test("成員額度讀數帶超時：慢上游不卡任務路徑，超時即 fail-closed", async (t) => {
  await withEnv(CONTROL_PLANE_ENV, async () => {
    const errorLog = t.mock.method(console, "error", () => {});
    const { sql } = mockPrecheckSql([memberRow()]);
    const started = Date.now();
    const decision = await enforceQuotaGate(
      { bizKeyId: "key-1", billingUserId: 115, baseBillingAmount: 250_000 },
      {
        fetchUser: userReader(582_377_145),
        sql,
        timeoutMs: 10,
        readMemberQuota: () => new Promise<never>(() => undefined),
      },
    );
    assert.ok(Date.now() - started < 2_000, "成员额度读不得无限等待");
    assert.equal(decision.ok, false);
    if (!decision.ok) {
      assert.equal(decision.status, 503);
      assert.equal(decision.code, "control_plane_unavailable");
    }
    const logged = errorLog.mock.calls.map((call) => call.arguments.join(" ")).join("\n");
    assert.ok(logged.includes("read timed out"));
  });
});

test("未登記為成員的 key 完全不讀成員額度（零回歸：行為與手術前逐位等價）", async (t) => {
  await withEnv(CONTROL_PLANE_ENV, async () => {
    t.mock.method(console, "log", () => {});
    const memberCalls: number[] = [];
    const { sql } = mockPrecheckSql([]);
    const decision = await enforceQuotaGate(
      { bizKeyId: "key-1", billingUserId: 115, baseBillingAmount: 250_000 },
      {
        fetchUser: userReader(582_377_145),
        sql,
        readMemberQuota: memberQuotaReader({ granted: 0, used: 0, remaining: 0 }, memberCalls),
      },
    );
    assert.deepEqual(decision, { ok: true, billingAmount: 0 });
    assert.deepEqual(memberCalls, [], "非成員 key 不得新增任何成員額度讀取");
  });
});
