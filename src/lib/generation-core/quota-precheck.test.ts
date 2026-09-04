import assert from "node:assert/strict";
import test from "node:test";

import { fetchGatewayUser } from "@/lib/gateway-admin";
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

function mockMappingSql(rows: Row[] = []) {
  const queries: string[] = [];
  const tagged = (async (strings: TemplateStringsArray, ...values: unknown[]) => {
    queries.push(strings.join(" | "));
    void values;
    return rows;
  }) as unknown as GenerationSql;
  return { sql: tagged, queries };
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
    const { sql, queries } = mockMappingSql([]);
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
    const { sql, queries } = mockMappingSql([]);
    const decision = await enforceQuotaGate(
      { bizKeyId: "key-1", billingUserId: 87, baseBillingAmount: 0 },
      { fetchUser: userReader(0, calls), sql },
    );
    assert.deepEqual(decision, { ok: true, billingAmount: 0 });
    assert.deepEqual(calls, []);
    assert.deepEqual(queries, []);
  });
});

test("gate ON fails closed on missing token mapping with the existing contract error", async (t) => {
  await withEnv(CONTROL_PLANE_ENV, async () => {
    const errorLog = t.mock.method(console, "error", () => {});
    const calls: number[] = [];
    const { sql } = mockMappingSql([]);
    const decision = await enforceQuotaGate(
      { bizKeyId: "key-without-mapping", billingUserId: 87, baseBillingAmount: 250_000 },
      { fetchUser: userReader(582_377_145, calls), sql },
    );
    assert.equal(decision.ok, false);
    if (!decision.ok) {
      assert.equal(decision.status, 503);
      assert.equal(decision.type, "api_error");
      assert.equal(decision.code, "control_plane_unavailable");
      assert.equal(decision.message, "Generation control plane is temporarily unavailable.");
    }
    assert.deepEqual(calls, []);
    const logged = errorLog.mock.calls.map((call) => call.arguments.join(" ")).join("\n");
    assert.ok(logged.includes("no new-api token mapping"));
    assert.ok(logged.includes("key-without-mapping"));
  });
});

test("gate ON with mapping and sufficient quota skips the blocking reserve (billingAmount = 0)", async (t) => {
  await withEnv(CONTROL_PLANE_ENV, async () => {
    t.mock.method(console, "log", () => {});
    const { sql, queries } = mockMappingSql([{ biz_key_id: "key-1", token_id: 42, token_key_preview: "" }]);
    const decision = await enforceQuotaGate(
      { bizKeyId: "key-1", billingUserId: 87, baseBillingAmount: 250_000 },
      { fetchUser: userReader(582_377_145), sql },
    );
    assert.deepEqual(decision, { ok: true, billingAmount: 0 });
    assert.equal(queries.length, 1);
  });
});

test("gate ON with insufficient quota rejects under the existing 402 contract", async (t) => {
  await withEnv(CONTROL_PLANE_ENV, async () => {
    t.mock.method(console, "error", () => {});
    const { sql } = mockMappingSql([{ biz_key_id: "key-1", token_id: 42, token_key_preview: "" }]);
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

test("gate ON with unreachable new-api falls back to the incumbent reserve path unchanged", async (t) => {
  await withEnv(CONTROL_PLANE_ENV, async () => {
    const errorLog = t.mock.method(console, "error", () => {});
    const { sql } = mockMappingSql([{ biz_key_id: "key-1", token_id: 42, token_key_preview: "" }]);
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
    const { sql } = mockMappingSql([{ biz_key_id: "key-1", token_id: 42, token_key_preview: "" }]);
    const decision = await enforceQuotaGate(
      { bizKeyId: "key-1", billingUserId: 0, baseBillingAmount: 250_000 },
      { fetchUser: userReader(582_377_145, calls), sql },
    );
    assert.deepEqual(decision, { ok: true, billingAmount: 250_000 });
    assert.deepEqual(calls, []);
  });
});
