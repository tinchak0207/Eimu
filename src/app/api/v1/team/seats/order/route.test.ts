// POST /v1/team/seats/order 路由真行为断言测试（鉴权 / 拒单 / 不得以 0 元成立订单）。

import assert from "node:assert/strict";
import test from "node:test";
import { NextRequest } from "next/server";

import { hashBizApiKey } from "@/lib/biz-api-keys";
import { __resetBizKeyStoreForTests } from "@/lib/biz-api-key-store";

import { POST } from "./route";

const VALID_KEY = `sk-biz-${"b2c3d4e5f6071829".repeat(2)}`;
const VALID_USER_ID = 117;
const AUTH = { authorization: `Bearer ${VALID_KEY}` };

function reset() {
  delete process.env.GENERATION_DATABASE_URL;
  delete process.env.DATABASE_URL;
  delete process.env.GENERATION_CONTROL_PLANE_ENABLED;
  process.env.BIZ_API_KEY_HASHES = `${hashBizApiKey(VALID_KEY)}:${VALID_USER_ID}`;
  __resetBizKeyStoreForTests();
}

function req(init: { headers?: Record<string, string>; body?: unknown } = {}): NextRequest {
  const headers = new Headers(init.headers);
  if (init.body !== undefined) headers.set("content-type", "application/json");
  return new NextRequest("http://localhost/api/v1/team/seats/order", {
    method: "POST",
    headers,
    body: init.body === undefined ? undefined : JSON.stringify(init.body),
  });
}

interface SeatOrderBody {
  success?: boolean;
  error?: { code: string; message: string };
  quote?: unknown;
  pending_order?: unknown;
  payment?: { payable: boolean; wired: boolean };
  checkout?: { method: string; path: string };
  todo?: string[];
}

async function bodyOf(response: Response): Promise<SeatOrderBody> {
  return (await response.json()) as SeatOrderBody;
}

test("未带密钥 → 401，且不泄漏报价/订单", async () => {
  reset();
  const response = await POST(req({ body: { tier: "team", cycle: "month", seats: 5 } }));
  assert.equal(response.status, 401);
  const body = await bodyOf(response);
  assert.equal(body.success, false);
  assert.equal(body.pending_order, undefined);
});

test("席位数非法 → 400 invalid_seats（不产生订单）", async () => {
  reset();
  for (const seats of [0, -3, 1.5, "5"]) {
    const response = await POST(req({ headers: AUTH, body: { tier: "team", cycle: "month", seats } }));
    assert.equal(response.status, 400, `seats=${String(seats)}`);
    const body = await bodyOf(response);
    assert.equal(body.error?.code, "invalid_seats");
    assert.equal(body.pending_order, undefined);
  }
});

test("真源已配置 → 200 可支付：回报价 + 待支付订单 + 收银台入口（金额来自同源价表，绝非 0 元）", async () => {
  reset();
  const response = await POST(req({ headers: AUTH, body: { tier: "team", cycle: "month", seats: 5 } }));
  assert.equal(response.status, 200);
  const body = await bodyOf(response);
  assert.equal(body.success, true);
  assert.equal(body.payment?.payable, true, "全链已接线：报价合法即可支付");
  assert.equal(body.payment?.wired, true);
  const pending = body.pending_order as { money?: string; param?: string; out_trade_no?: string } | undefined;
  assert.equal(pending?.money, "425.00", "85 元/席位 × 5 席（同源价表）");
  assert.equal(pending?.param?.startsWith("seat:"), true);
  assert.equal(pending?.out_trade_no?.startsWith("TS"), true);
  assert.equal(body.checkout?.path?.startsWith("/api/payments/mapay/checkout?plan=seat"), true, "收银台入口");
});

test("未知档位/周期 → 400，各回自己的码", async () => {
  reset();
  const badTier = await POST(req({ headers: AUTH, body: { tier: "enterprise", cycle: "month", seats: 2 } }));
  assert.equal(badTier.status, 400);
  assert.equal((await bodyOf(badTier)).error?.code, "unknown_tier");

  const badCycle = await POST(req({ headers: AUTH, body: { tier: "team", cycle: "monthly", seats: 2 } }));
  assert.equal(badCycle.status, 400);
  assert.equal((await bodyOf(badCycle)).error?.code, "invalid_cycle");

  const badJson = await POST(
    new NextRequest("http://localhost/api/v1/team/seats/order", {
      method: "POST",
      headers: new Headers(AUTH),
      body: "not-json",
    }),
  );
  assert.equal(badJson.status, 400);
  assert.equal((await bodyOf(badJson)).error?.code, "invalid_json");
});
