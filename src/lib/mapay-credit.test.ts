import test from "node:test";
import assert from "node:assert/strict";

import { BIZ_KEY_SYNC_SIGNATURE_HEADER, BIZ_KEY_SYNC_TIMESTAMP_HEADER, verifyBizKeySync } from "./biz-key-sync.ts";
import {
  MAPAY_CREDIT_RELAY_SIGNATURE_DOMAIN,
  creditMapayOrderViaRelay,
  mapayDeliveryFor,
  runMapayCreditOnce,
  type MapayCreditDeps,
  type MapayCreditInput,
  type MapayCreditRecord,
  type MapayCreditStatus,
  type MapayCreditStore,
} from "./mapay-credit.ts";

// ─────────────────────────────────────────── 假的占位表（镜像 SQL 语义：只插不覆盖）

function memoryStore() {
  const rows = new Map<string, MapayCreditRecord>();
  const store: MapayCreditStore = {
    async claim(input) {
      if (rows.has(input.orderId)) return false;
      rows.set(input.orderId, { ...input, status: "pending" });
      return true;
    },
    async get(orderId) {
      return rows.get(orderId) ?? null;
    },
    async mark(orderId, status: Exclude<MapayCreditStatus, "pending">, detail) {
      const row = rows.get(orderId);
      if (row) rows.set(orderId, { ...row, status });
      void detail;
    },
  };
  return { store, rows };
}

function fakeDeps(options: { quota?: number; adjustFails?: boolean; quotaMovesOnFailure?: boolean; baselineBlocked?: boolean } = {}) {
  const upstream = { quota: options.quota ?? 1_000 };
  const calls = { adjust: 0, ledger: 0, adjustDelta: [] as number[] };
  const { store, rows } = memoryStore();
  const deps: MapayCreditDeps = {
    store,
    async ensureBaseline() {
      return options.baselineBlocked ? { ready: false, blocked: true, reason: "帐本储存层未配置" } : { ready: true, blocked: false };
    },
    async readUpstreamQuota() {
      return upstream.quota;
    },
    async adjustUpstream(_userId, delta) {
      calls.adjust += 1;
      calls.adjustDelta.push(delta);
      if (options.adjustFails) {
        if (options.quotaMovesOnFailure) upstream.quota += delta;
        throw new Error("upstream 500");
      }
      upstream.quota += delta;
    },
    async recordLedger() {
      calls.ledger += 1;
      return { posted: true };
    },
  };
  return { deps, upstream, calls, rows };
}

const ORDER: MapayCreditInput = { orderId: "IMG1ABCDEF", userId: 253, planId: "popular", amountQuota: 500_000 };

test("credits once and records one ledger row", async () => {
  const { deps, upstream, calls } = fakeDeps();
  const outcome = await runMapayCreditOnce(deps, ORDER);

  assert.equal(outcome, "credited");
  assert.equal(upstream.quota, 501_000);
  assert.deepEqual(calls.adjustDelta, [500_000]);
  assert.equal(calls.ledger, 1);
});

test("replaying the same order credits only once", async () => {
  const { deps, upstream, calls, rows } = fakeDeps();
  assert.equal(await runMapayCreditOnce(deps, ORDER), "credited");
  assert.equal(await runMapayCreditOnce(deps, ORDER), "already_credited");

  assert.equal(upstream.quota, 501_000, "上游只加一次");
  assert.equal(calls.adjust, 1, "上游调额只发生一次");
  assert.equal(calls.ledger, 1, "帐本只记一笔");
  assert.equal(rows.get(ORDER.orderId)?.status, "applied");
});

test("concurrent replays of the same order credit only once", async () => {
  const { deps, upstream, calls } = fakeDeps();
  const outcomes = await Promise.all([
    runMapayCreditOnce(deps, ORDER),
    runMapayCreditOnce(deps, ORDER),
  ]);

  assert.deepEqual([...outcomes].sort(), ["credited", "in_flight"].sort());
  assert.equal(upstream.quota, 501_000);
  assert.equal(calls.adjust, 1);
});

test("upstream failure with unchanged quota reports failed and never retries (caller falls back to cdk)", async () => {
  const { deps, upstream, calls, rows } = fakeDeps({ adjustFails: true });
  assert.equal(await runMapayCreditOnce(deps, ORDER), "failed");
  assert.equal(upstream.quota, 1_000);
  assert.equal(rows.get(ORDER.orderId)?.status, "failed");
  assert.equal(calls.ledger, 0, "上游没动就不记帐本");

  // 重放不得再试上游（占位只插不覆盖）：否则会和已退回旧流程生成的兑换码叠成双份。
  assert.equal(await runMapayCreditOnce(deps, ORDER), "failed");
  assert.equal(calls.adjust, 1);
});

test("upstream failure with moved quota reports in_flight (no second delivery channel)", async () => {
  const { deps, upstream, rows } = fakeDeps({ adjustFails: true, quotaMovesOnFailure: true });
  assert.equal(await runMapayCreditOnce(deps, ORDER), "in_flight");
  assert.equal(upstream.quota, 501_000);
  assert.equal(rows.get(ORDER.orderId)?.status, "unknown");
  assert.equal(await runMapayCreditOnce(deps, ORDER), "in_flight");
});

test("blocked baseline fails without touching upstream", async () => {
  const { deps, upstream, calls } = fakeDeps({ baselineBlocked: true });
  assert.equal(await runMapayCreditOnce(deps, ORDER), "failed");
  assert.equal(upstream.quota, 1_000);
  assert.equal(calls.adjust, 0);
});

test("non-positive quota is rejected before claiming", async () => {
  const { deps, rows } = fakeDeps();
  assert.equal(await runMapayCreditOnce(deps, { ...ORDER, amountQuota: 0 }), "failed");
  assert.equal(rows.size, 0);
});

// ─────────────────────────────────────────── Vercel → 控面签名通道（契约：域 + 报文 + 结果词表）

test("relay signs with the mapay-credit domain and maps control-plane outcomes", async () => {
  const previous = {
    origin: process.env.GENERATION_CONTROL_PLANE_PROXY_ORIGIN,
    secret: process.env.GENERATION_BILLING_RELAY_SECRET,
  };
  process.env.GENERATION_CONTROL_PLANE_PROXY_ORIGIN = "https://control-plane.test";
  process.env.GENERATION_BILLING_RELAY_SECRET = "test-relay-secret";

  try {
    const { deps } = fakeDeps();
    const seen: Array<{ url: string; body: Record<string, unknown> }> = [];
    // 假控面：按 internal/mapay-credit 的契约验签（域 mapay-credit）并跑真实入帐核心。
    const fetchImpl = (async (input: string | URL | Request, init?: RequestInit) => {
      const rawBody = String(init?.body ?? "");
      const headers = new Headers(init?.headers);
      const verified = verifyBizKeySync({
        secret: process.env.GENERATION_BILLING_RELAY_SECRET ?? "",
        timestamp: headers.get(BIZ_KEY_SYNC_TIMESTAMP_HEADER),
        signature: headers.get(BIZ_KEY_SYNC_SIGNATURE_HEADER),
        rawBody,
        signatureDomain: MAPAY_CREDIT_RELAY_SIGNATURE_DOMAIN,
      });
      if (!verified) return new Response(JSON.stringify({ ok: false }), { status: 401 });

      const body = JSON.parse(rawBody) as Record<string, unknown>;
      seen.push({ url: String(input), body });
      const outcome = await runMapayCreditOnce(deps, {
        orderId: String(body.orderId),
        userId: Number(body.userId),
        planId: String(body.planId),
        amountQuota: 500_000,
      });
      return new Response(JSON.stringify({ ok: true, outcome }), { status: 200 });
    }) as unknown as typeof fetch;

    const first = await creditMapayOrderViaRelay(
      { orderId: ORDER.orderId, userId: ORDER.userId, planId: ORDER.planId },
      { fetchImpl },
    );
    const replay = await creditMapayOrderViaRelay(
      { orderId: ORDER.orderId, userId: ORDER.userId, planId: ORDER.planId },
      { fetchImpl },
    );

    assert.equal(first, "credited");
    assert.equal(replay, "already_credited");
    assert.equal(seen.length, 2);
    assert.match(seen[0].url, /\/image-control\/api\/internal\/mapay-credit$/);
    assert.deepEqual(seen[0].body, { op: "credit", orderId: ORDER.orderId, userId: ORDER.userId, planId: ORDER.planId });
  } finally {
    if (previous.origin === undefined) delete process.env.GENERATION_CONTROL_PLANE_PROXY_ORIGIN;
    else process.env.GENERATION_CONTROL_PLANE_PROXY_ORIGIN = previous.origin;
    if (previous.secret === undefined) delete process.env.GENERATION_BILLING_RELAY_SECRET;
    else process.env.GENERATION_BILLING_RELAY_SECRET = previous.secret;
  }
});

test("relay reports unavailable when the channel env is missing", async () => {
  const previous = process.env.GENERATION_CONTROL_PLANE_PROXY_ORIGIN;
  delete process.env.GENERATION_CONTROL_PLANE_PROXY_ORIGIN;
  try {
    assert.equal(
      await creditMapayOrderViaRelay({ orderId: "IMG1", userId: 1, planId: "popular" }),
      "unavailable",
    );
  } finally {
    if (previous !== undefined) process.env.GENERATION_CONTROL_PLANE_PROXY_ORIGIN = previous;
  }
});

test("delivery channel table: settled → direct, in_flight → hold, failed/unavailable → redemption", () => {
  assert.equal(mapayDeliveryFor("credited"), "direct");
  assert.equal(mapayDeliveryFor("already_credited"), "direct");
  assert.equal(mapayDeliveryFor("in_flight"), "hold");
  assert.equal(mapayDeliveryFor("failed"), "redemption");
  assert.equal(mapayDeliveryFor("unavailable"), "redemption");
  assert.equal(mapayDeliveryFor("none"), "none");
});