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

/**
 * 402 统一契约（暴君 2026-09-28 裁决，破坏性变更已核准）：type 与 code 同码，
 * 文案逐字（含充值入口）。测试独立抄写这份文案，不从实现取——实现改字即爆红。
 */
const BALANCE_MESSAGE = "余额不足，本次未扣费。充值：https://eimu.dev/pricing";

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
 * 预检 SQL mock：记录每一次查询。
 * - `team_member_quota`（成员名册，按 user_id 判成员）→ memberRows。
 * - 其余任何查询 → decoyRows：G1 之后预检不该再有任何其他查询，一旦有人把
 *   012 token 映射查询加回来，queries 会记到、下面的负向断言即红。
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

/** 012 映射表残留列（表还在、代码已拔除）：只当「不被查询」的诱饵。 */
const LEGACY_TOKEN_MAPPING_ROW = { biz_key_id: "key-1", token_id: 42, token_key_preview: "" };

function memberRow(overrides: Row = {}): Row {
  return {
    id: "member-1",
    team_user_id: 115,
    member_key_id: "key-1",
    // 成员 = new-api 另一个 user（配额桶在 user 层）；成员 key 的 billingUserId 就是它。
    member_user_id: 115,
    display_name: "成员A",
    enabled: true,
    ...overrides,
  };
}

/** 去注释后的预检源码（负向断言只看代码，不看历史注释）。 */
function precheckCode(): string {
  return readFileSync(join(process.cwd(), "src/lib/generation-core/quota-precheck.ts"), "utf8")
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/^\s*\/\/.*$/gm, "");
}

// ── 开关解析 ──────────────────────────────────────────────────────────────

test("surgery switch parses strictly: only literal 1 enables", () => {
  assert.equal(surgeryQuotaPrecheckEnabled({}), false);
  assert.equal(surgeryQuotaPrecheckEnabled({ [SURGERY_QUOTA_PRECHECK_ENV]: "0" }), false);
  assert.equal(surgeryQuotaPrecheckEnabled({ [SURGERY_QUOTA_PRECHECK_ENV]: "true" }), false);
  assert.equal(surgeryQuotaPrecheckEnabled({ [SURGERY_QUOTA_PRECHECK_ENV]: "2" }), false);
  assert.equal(surgeryQuotaPrecheckEnabled({ [SURGERY_QUOTA_PRECHECK_ENV]: "1" }), true);
  assert.equal(surgeryQuotaPrecheckEnabled({ [SURGERY_QUOTA_PRECHECK_ENV]: " 1 " }), true);
});

// ── 预检三态 ──────────────────────────────────────────────────────────────

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

  // user_id=0 是「无从计费」应急通道：fail-closed 且不发请求。
  const calls: number[] = [];
  const noUser = await checkQuotaAvailable(
    { billingUserId: 0, requiredQuota: 250_000 },
    { fetchUser: userReader(582_377_145, calls) },
  );
  assert.equal(noUser.verdict, "unreachable");
  assert.deepEqual(calls, []);
});

// ── 闸门两态 ──────────────────────────────────────────────────────────────

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

// ── G1（2026-09-23 裁定）：无 token 映射的 key 不再 fail-closed ─────────────
//
// 旧行为：biz_key 无 012 映射 → 503 control_plane_unavailable（fail-closed），
// 后果是「09-17 之后签发的任何 key 首次使用必 503」的地雷类别。
// 新行为：映射依赖整段拔除，无映射的 key 与有映射的 key 逐位同路——只按 user
// 额度闸（额度足 → 0 额快车道放行；不足 → 既有 402 契约）。

test("(a) 无 token 映射 + user 额度足 → 放行（0 额快车道，不再 503）", async (t) => {
  await withEnv(CONTROL_PLANE_ENV, async () => {
    const errorLog = t.mock.method(console, "error", () => {});
    t.mock.method(console, "log", () => {});
    const calls: number[] = [];
    // decoyRows 摆著 012 映射列：若预检还查映射表就会拿到它，本测试即暴露。
    const { sql, queries } = mockPrecheckSql([], [LEGACY_TOKEN_MAPPING_ROW]);
    const decision = await enforceQuotaGate(
      { bizKeyId: "key-without-mapping", billingUserId: 87, baseBillingAmount: 250_000 },
      { fetchUser: userReader(582_377_145, calls), sql },
    );
    assert.deepEqual(decision, { ok: true, billingAmount: 250_000 }, "无映射的 key 必须照常走 user 额度并放行，金额等于应预扣");
    assert.deepEqual(calls, [87], "必须真的读了 user 额度（旧行为是不发请求直接 503）");
    assert.equal(queries.length, 1, "预检只剩成员名册一跳");
    assert.ok(queries[0].includes("team_member_quota"));
    assert.ok(queries.every((q) => !q.includes("biz_key_newapi_token")), "不得再查 012 映射表");
    const logged = errorLog.mock.calls.map((call) => call.arguments.join(" ")).join("\n");
    assert.ok(!logged.includes("no new-api token mapping"));
    assert.ok(!logged.includes("fail-closed"));
  });
});

test("(b) 无 token 映射 + user 额度不足 → 402 统一契约（文案逐字）", async (t) => {
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
      assert.equal(decision.type, "insufficient_balance");
      assert.equal(decision.code, "insufficient_balance");
      assert.equal(decision.message, BALANCE_MESSAGE, "402 文案逐字（统一契约）");
    }
  });
});

test("(c) 有映射的 key 行为逐位不变（旧三态回归：放行/402/回落）", async (t) => {
  await withEnv(CONTROL_PLANE_ENV, async () => {
    t.mock.method(console, "log", () => {});
    t.mock.method(console, "error", () => {});
    // 「有映射」在解耦后只剩下 DB 有那一列的事实；预检决策必须与无映射逐位相等。
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

    assert.deepEqual(unmapped.pass, { ok: true, billingAmount: 250_000 });
    assert.deepEqual(mapped.pass, unmapped.pass, "有映射 vs 无映射：放行面逐位相等");
    assert.deepEqual(mapped.short, unmapped.short, "有映射 vs 无映射：402 面逐位相等");
    assert.deepEqual(mapped.short.ok === false ? mapped.short.message : "", BALANCE_MESSAGE);
    assert.deepEqual(mapped.down, unmapped.down, "有映射 vs 无映射：回落面逐位相等");
    assert.deepEqual(mapped.down, { ok: true, billingAmount: 250_000 });
    for (const { queries } of [unmapped, mapped]) {
      assert.ok(queries.every((q) => !q.includes("biz_key_newapi_token")), "任何一态都不得查映射表");
    }
  });
});

test("gate ON with sufficient quota returns the reserve amount (not 0)", async (t) => {
  await withEnv(CONTROL_PLANE_ENV, async () => {
    t.mock.method(console, "log", () => {});
    const { sql, queries } = mockPrecheckSql();
    const decision = await enforceQuotaGate(
      { bizKeyId: "key-1", billingUserId: 87, baseBillingAmount: 250_000 },
      { fetchUser: userReader(582_377_145), sql },
    );
    assert.deepEqual(decision, { ok: true, billingAmount: 250_000 });
    // 一跳：成员名册（未登记成员 = 不受成员配额执法）；映射表已不再被查。
    assert.equal(queries.length, 1);
    assert.ok(queries[0].includes("team_member_quota"));
  });
});

test("gate ON with insufficient quota rejects under the unified 402 contract", async (t) => {
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
      assert.equal(decision.type, "insufficient_balance");
      assert.equal(decision.code, "insufficient_balance");
      assert.equal(decision.message, BALANCE_MESSAGE);
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
    assert.equal(queries.length, 1, "只剩成员名册一跳");
  });
});

// ── (e) 负向钉：映射 fail-closed 路径与映射模组不得回来 ────────────────────

test("(e) 负向钉：预检源码不得再有 012 映射 fail-closed 路径，映射模组档已删", () => {
  const source = precheckCode();
  for (const forbidden of [
    "biz_key_newapi_token",
    "findNewApiTokenIdForBizKey",
    "biz-key-token-mapping",
    "no new-api token mapping",
    "migration 012 contract",
    "tokenId",
  ]) {
    assert.ok(!source.includes(forbidden), `预检代码不得再出现 ${forbidden}`);
  }
  // 503 control_plane_unavailable 只准留在受管成员分支（B1-v2 不变量），且必须在
  // 成员判定之后 —— 映射面不得再有 fail-closed 出口（旧出口在成员判定之前）。
  const memberLookupAt = source.indexOf("?? findMemberByUserId)(input.billingUserId");
  assert.ok(memberLookupAt > 0, "应能定位成员判定呼叫点");
  const exits = [...source.matchAll(/\.\.\.CONTROL_PLANE_UNAVAILABLE/g)].map((m) => m.index ?? -1);
  assert.ok(exits.length >= 1, "成员分支的 503 fail-closed 必须保留（B1-v2 不变量）");
  for (const at of exits) assert.ok(at > memberLookupAt, "503 出口必须在成员判定之后（映射面不得再有）");
  // 映射模组本体已删（DB 表与 migration 012 只作历史留存）。
  assert.throws(() => readFileSync(join(process.cwd(), "src/lib/generation-core/biz-key-token-mapping.ts"), "utf8"));
});

// ── 成员点数配额（REQ-B1，user 层）：消耗面先判成员 user 额度再走既有计费户检查 ──

/** 成员 user 配额桶的权威读数（new-api users.quota / used_quota）。 */
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

test("成员额度不足 → 402 契约码不变，文案与主帐不足明确区分", async (t) => {
  await withEnv(CONTROL_PLANE_ENV, async () => {
    t.mock.method(console, "log", () => {});
    const order: string[] = [];
    const calls: number[] = [];
    const { sql } = mockPrecheckSql([memberRow()]);
    const decision = await enforceQuotaGate(
      { bizKeyId: "key-1", billingUserId: 115, baseBillingAmount: 250_000 },
      {
        // 上游有回应，但成员 user 那桶只剩 100_000 —— 必须以「成员额度不足」拒单。
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
      // 码统一（客户端只认一套 402），文案保留成员专属指引——不叫成员去充值页。
      assert.equal(decision.type, "insufficient_balance");
      assert.equal(decision.code, "insufficient_balance");
      assert.equal(decision.message, MEMBER_QUOTA_INSUFFICIENT_MESSAGE);
      assert.notEqual(decision.message, BALANCE_MESSAGE);
    }
    assert.deepEqual(order, ["member"], "成员额度不足时必须已判过成员额度");
    assert.deepEqual(calls, [115], "成员读数按 user_id 读（成员 key 的计费 user）");
  });
});

test("先判成员额度再走既有计费户检查：次序可证，且计费户不足用既有文案", async (t) => {
  await withEnv(CONTROL_PLANE_ENV, async () => {
    t.mock.method(console, "log", () => {});
    const order: string[] = [];
    const calls: number[] = [];
    const { sql } = mockPrecheckSql([memberRow()]);
    const decision = await enforceQuotaGate(
      { bizKeyId: "key-1", billingUserId: 115, baseBillingAmount: 250_000 },
      {
        // 成员桶充足（剩 500 币），计费户只剩 0.2 币 → 既有「余额不足」文案。
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
      assert.equal(decision.code, "insufficient_balance");
      assert.equal(decision.message, BALANCE_MESSAGE, "主帐不足 = 统一契约文案，逐字");
    }
    assert.deepEqual(order, ["member", "billing"], "先成员额度、后既有计费户检查");
    assert.deepEqual(calls, [115]);
  });
});

test("成员额度与计费户都充足 → 回传应预扣金额（不是 0）", async (t) => {
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
    assert.deepEqual(decision, { ok: true, billingAmount: 250_000 });
  });
});

test("受管成员的额度读不到／unlimited → 503 fail-closed，不静默放行", async (t) => {
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

test("成员额度被停用 → 402（同契约码，文案指向团队主帐号）", async (t) => {
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
      assert.equal(decision.code, "insufficient_balance");
      assert.equal(decision.message, MEMBER_QUOTA_DISABLED_MESSAGE);
    }
  });
});

test("成员额度读数带超时：慢上游不卡任务路径，超时即 fail-closed", async (t) => {
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

test("未登记为成员的 key 完全不读成员额度（零回归：行为与手术前逐位等价）", async (t) => {
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
    assert.deepEqual(decision, { ok: true, billingAmount: 250_000 });
    assert.deepEqual(memberCalls, [], "非成员 key 不得新增任何成员额度读取");
  });
});
