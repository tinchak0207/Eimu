// mPay 订单查询客户端测试：真输入 → 真输出（无外网，fake fetch）。

import assert from "node:assert/strict";
import test from "node:test";

import type { MapayConfig } from "./mapay.ts";
import { verifyBizKeySync } from "./biz-key-sync.ts";
import {
  MAPAY_ORDERS_RELAY_SIGNATURE_DOMAIN,
  MapayOrdersError,
  fetchMapayOrder,
  fetchMapayOrders,
  mapayApiUrl,
  mapayOrdersRelayConfig,
  normalizeMapayOrder,
  parseMapayOrdersResponse,
  redactMapaySecrets,
  type MapayOrder,
} from "./mapay-orders.ts";

const CONFIG: MapayConfig = {
  pid: "1000",
  key: "abcSECRETxyz",
  gatewayUrl: "https://mzf.mapay.cc/xpay/epay/",
  siteUrl: "https://eimu.dev",
};

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
}

// ── URL 与遮蔽 ──────────────────────────────────────────────────────────

test("mapayApiUrl：基底（含尾斜线/不含）都收敛到同层 api.php，已是 api.php 则原样", () => {
  assert.equal(mapayApiUrl("https://mzf.mapay.cc/xpay/epay/"), "https://mzf.mapay.cc/xpay/epay/api.php");
  assert.equal(mapayApiUrl("https://mzf.mapay.cc/xpay/epay"), "https://mzf.mapay.cc/xpay/epay/api.php");
  assert.equal(mapayApiUrl("https://mzf.mapay.cc/xpay/epay/api.php"), "https://mzf.mapay.cc/xpay/epay/api.php");
});

test("redactMapaySecrets：pid 与 key 的值都不出现在日志字串里", () => {
  const redacted = redactMapaySecrets(`{"pid":"1000","key":"abcSECRETxyz","data":[]}`, CONFIG);
  assert.doesNotMatch(redacted, /abcSECRETxyz/);
  assert.doesNotMatch(redacted, /"pid":"1000"/);
  assert.match(redacted, /\*\*\*/);
});

// ── 解析容忍度（成功形状未定 ⇒ 多种别名都要认） ─────────────────────────

test("信封解析：data 阵列 / list 包装 / 单笔物件 / 栏位别名 / 付款判定", () => {
  const fromArray = parseMapayOrdersResponse({
    code: 1,
    data: [
      { out_trade_no: "IMGAAA", trade_no: "T1", money: "9.93", status: "TRADE_SUCCESS", name: "梦芽 100金币", addtime: "2026-09-19 11:45:38", endtime: 1758253740 },
    ],
  });
  assert.equal(fromArray.orders.length, 1);
  assert.equal(fromArray.orders[0].outTradeNo, "IMGAAA");
  assert.equal(fromArray.orders[0].money, 9.93);
  assert.equal(fromArray.orders[0].paid, true);
  assert.equal(fromArray.orders[0].paidAt, new Date(1758253740 * 1000).toISOString());

  const fromList = parseMapayOrdersResponse({ code: 0, list: [{ out_trade_no: "IMGBBB", amount: 7, trade_status: "1" }] });
  assert.equal(fromList.orders[0].money, 7);
  assert.equal(fromList.orders[0].paid, true);

  const single = parseMapayOrdersResponse({ code: 0, data: { out_trade_no: "IMGCCC", status: "WAIT_BUYER_PAY" } });
  assert.equal(single.orders.length, 1);
  assert.equal(single.orders[0].paid, false);

  const empty = parseMapayOrdersResponse({ code: 0, msg: "没有找到商户信息", data: [] });
  assert.equal(empty.empty, true);
  assert.equal(empty.orders.length, 0);
});

// 真实响应契约锁：2026-10-04 生产 act=order&out_trade_no=IMGMU7UH9SFF9A21D 逐字原始响应
// （pid 值在取证日志中已遮蔽为 ***）。订单栏位平铺在信封根层 ⇒ 必须被认成 1 笔已付款。
const REAL_SINGLE_ORDER_RESPONSE =
  '{"code":1,"msg":"查询订单号成功！","trade_no":"20260919114538891000","out_trade_no":"IMGMU7UH9SFF9A21D","type":"alipay","pid":"***","addtime":"2026-09-19 11:45:38","endtime":"2026-09-19 11:49:00","name":"eimu.dev 梦芽 · 轻度尝鲜包 100金币","money":"9.93","param":"starter","buyer":"","status":1}';

test("真实响应（根层平铺）：解析器认出 1 笔已付款、out_trade_no/money 正确", () => {
  const parsed = parseMapayOrdersResponse(JSON.parse(REAL_SINGLE_ORDER_RESPONSE));
  assert.equal(parsed.orders.length, 1);
  const order = parsed.orders[0];
  assert.equal(order.outTradeNo, "IMGMU7UH9SFF9A21D");
  assert.equal(order.tradeNo, "20260919114538891000");
  assert.equal(order.money, 9.93);
  assert.equal(order.paid, true);
  assert.equal(order.status, "1");
  assert.equal(parsed.empty, false);

  // 走完整单查路径（fake fetch 回逐字原始字串）：必须找到该笔，不得判「查无此单」。
  return (async () => {
    const found = await fetchMapayOrder("IMGMU7UH9SFF9A21D", {
      config: CONFIG,
      logger: () => undefined,
      fetchImpl: async () => new Response(REAL_SINGLE_ORDER_RESPONSE, { status: 200 }),
    });
    assert.equal(found?.outTradeNo, "IMGMU7UH9SFF9A21D");
    assert.equal(found?.money, 9.93);
    assert.equal(found?.paid, true);
  })();
});

test("normalizeMapayOrder：缺 out_trade_no 的列不收（无法指认）；缺可解析时间不回假时间", () => {
  assert.equal(normalizeMapayOrder({ money: 1 }), null);
  assert.equal(normalizeMapayOrder(null), null);
  const order = normalizeMapayOrder({ out_trade_no: "IMGF", money: 9.9, addtime: "not-a-time" });
  assert.ok(order);
  assert.equal(order?.createdAt, null);
  assert.equal(order?.paidAt, null);
});

// ── 错误型别（逾时 / 非 JSON / 非 0 code 都要分开） ─────────────────────

test("fetchMapayOrders：成功回订单，且原始响应（遮蔽后）落进日志", async () => {
  const logs: string[] = [];
  const result = await fetchMapayOrders(
    {},
    {
      config: CONFIG,
      logger: (m) => logs.push(m),
      fetchImpl: async (input) => {
        const url = new URL(String(input));
        assert.equal(url.pathname, "/xpay/epay/api.php");
        assert.equal(url.searchParams.get("act"), "order");
        assert.equal(url.searchParams.get("pid"), "1000");
        return jsonResponse({ code: 1, data: [{ out_trade_no: "IMG123", money: 9.9, status: "TRADE_SUCCESS" }] });
      },
    },
  );
  assert.equal(result.orders.length, 1);
  assert.equal(result.endpoint, "order");
  assert.equal(logs.length, 1);
  assert.match(logs[0], /raw=.*IMG123/);
  assert.doesNotMatch(logs[0], /abcSECRETxyz/);
});

test("fetchMapayOrders：code 非 0（502）→ MapayOrdersError(kind=upstream) 且带 code", async () => {
  await assert.rejects(
    () =>
      fetchMapayOrders(
        {},
        {
          config: CONFIG,
          logger: () => undefined,
          fetchImpl: async () => jsonResponse({ code: 502, message: "请输入商户ID" }),
        },
      ),
    (error: unknown) => {
      assert.ok(error instanceof MapayOrdersError);
      assert.equal(error.kind, "upstream");
      assert.equal(error.upstreamCode, 502);
      return true;
    },
  );
});

test("fetchMapayOrders：code=0 错误信封（无订单实体）→ upstream（不当「成功但 data 空」）", async () => {
  await assert.rejects(
    () =>
      fetchMapayOrders(
        {},
        {
          config: CONFIG,
          logger: () => undefined,
          fetchImpl: async () => jsonResponse({ code: 0, msg: "没有找到商户信息" }),
        },
      ),
    (error: unknown) => error instanceof MapayOrdersError && error.kind === "upstream" && error.upstreamCode === 0,
  );
});

test("fetchMapayOrders：非 JSON → kind=non_json；HTTP 500 → kind=http", async () => {
  await assert.rejects(
    () => fetchMapayOrders({}, { config: CONFIG, logger: () => undefined, fetchImpl: async () => new Response("<html>oops", { status: 200 }) }),
    (error: unknown) => error instanceof MapayOrdersError && error.kind === "non_json",
  );
  await assert.rejects(
    () => fetchMapayOrders({}, { config: CONFIG, logger: () => undefined, fetchImpl: async () => new Response("boom", { status: 500 }) }),
    (error: unknown) => error instanceof MapayOrdersError && error.kind === "http" && error.httpStatus === 500,
  );
});

test("fetchMapayOrders：逾时（AbortSignal）→ kind=timeout，不吞成空集合", async () => {
  await assert.rejects(
    () =>
      fetchMapayOrders(
        {},
        {
          config: CONFIG,
          logger: () => undefined,
          fetchImpl: async () => {
            const error = new Error("The operation was aborted due to timeout");
            error.name = "TimeoutError";
            throw error;
          },
        },
      ),
    (error: unknown) => error instanceof MapayOrdersError && error.kind === "timeout",
  );
});

test("fetchMapayOrders：config 缺失（无 pid/key）→ kind=config_missing", async () => {
  await assert.rejects(
    () => fetchMapayOrders({}, { env: { MAPAY_PID: "", MAPAY_KEY: "" }, logger: () => undefined }),
    (error: unknown) => error instanceof MapayOrdersError && error.kind === "config_missing",
  );
});

// ── 跨实例中继（本机无凭证 → 问 Vercel；对帐器跑在控制面走这条） ─────────────

test("mapayOrdersRelayConfig：复用 GENERATION_BILLING_RELAY_URL 的 origin，缺件回 null", () => {
  assert.deepEqual(
    mapayOrdersRelayConfig({
      GENERATION_BILLING_RELAY_URL: "https://image.example/api/internal/generation-billing",
      GENERATION_BILLING_RELAY_SECRET: "shared",
    }),
    { url: "https://image.example/api/internal/mapay-orders", secret: "shared" },
  );
  // 只给 URL、没有 secret → 通道不可用
  assert.equal(mapayOrdersRelayConfig({ GENERATION_BILLING_RELAY_URL: "https://image.example/x" }), null);
});

test("fetchMapayOrders：本机无凭证 → 经 HMAC（域 mapay-orders）打 Vercel 中继并采纳其结果", async () => {
  const secret = "shared-relay-secret";
  let seenUrl = "";
  let seenTimestamp = "";
  let seenSignature = "";
  let seenBody = "";
  const relayed = {
    orders: [
      {
        outTradeNo: "IMGREL",
        tradeNo: null,
        money: 9.9,
        status: "TRADE_SUCCESS",
        paid: true,
        name: null,
        type: null,
        createdAt: null,
        paidAt: null,
        raw: {},
      },
    ],
    empty: false,
    code: 1,
    message: null,
    endpoint: "order" as const,
  };
  const result = await fetchMapayOrders(
    { since: "2026-09-01T00:00:00Z" },
    {
      env: {
        MAPAY_PID: "",
        MAPAY_KEY: "",
        GENERATION_BILLING_RELAY_URL: "https://image.example/api/internal/generation-billing",
        GENERATION_BILLING_RELAY_SECRET: secret,
      },
      fetchImpl: async (input, init) => {
        seenUrl = String(input);
        const headers = new Headers(init?.headers as HeadersInit);
        seenTimestamp = headers.get("X-Biz-Key-Sync-Timestamp") ?? "";
        seenSignature = headers.get("X-Biz-Key-Sync-Signature") ?? "";
        seenBody = String(init?.body);
        return jsonResponse({ ok: true, result: relayed });
      },
    },
  );
  assert.equal(seenUrl, "https://image.example/api/internal/mapay-orders");
  assert.equal(result.orders[0].outTradeNo, "IMGREL");
  assert.deepEqual(JSON.parse(seenBody), { op: "orders", since: "2026-09-01T00:00:00.000Z" });
  // 签名必须以本用途的域分隔前缀签出（不得沿用 biz-key-sync）
  assert.equal(
    verifyBizKeySync({
      secret,
      timestamp: seenTimestamp,
      signature: seenSignature,
      rawBody: seenBody,
      signatureDomain: MAPAY_ORDERS_RELAY_SIGNATURE_DOMAIN,
    }),
    true,
  );
});

test("fetchMapayOrders：无凭证且中继未配置 → config_missing（不假装成功、不吐空集合）", async () => {
  await assert.rejects(
    () =>
      fetchMapayOrders(
        {},
        {
          env: { MAPAY_PID: "", MAPAY_KEY: "", GENERATION_BILLING_RELAY_SECRET: "x" }, // 缺 relay URL origin
          logger: () => undefined,
        },
      ),
    (error: unknown) => error instanceof MapayOrdersError && error.kind === "config_missing",
  );
});

// ── 窗口过滤与单笔查询 ──────────────────────────────────────────────────

test("fetchMapayOrders：窗口客户端过滤（窗口外剔除；时间不可解析的保守保留）", async () => {
  const orders: Record<string, unknown>[] = [
    { out_trade_no: "OLD", status: "TRADE_SUCCESS", addtime: "2026-01-01 00:00:00" },
    { out_trade_no: "IN", status: "TRADE_SUCCESS", addtime: "2026-09-19 11:45:38" },
    { out_trade_no: "NO_TIME", status: "TRADE_SUCCESS" },
  ];
  const result = await fetchMapayOrders(
    { since: "2026-09-01T00:00:00Z", until: "2026-10-04T00:00:00Z" },
    { config: CONFIG, logger: () => undefined, fetchImpl: async () => jsonResponse({ code: 1, data: orders }) },
  );
  const ids = result.orders.map((o) => o.outTradeNo);
  assert.deepEqual(ids, ["IN", "NO_TIME"]);
});

test("fetchMapayOrder：act=order 带商户单号，回单笔；成功码但零订单回 null（查无此单）", async () => {
  let seenUrl = "";
  const found = await fetchMapayOrder("IMGMU7UH9SFF9A21D", {
    config: CONFIG,
    logger: () => undefined,
    fetchImpl: async (input) => {
      seenUrl = String(input);
      return jsonResponse({ code: 1, data: [{ out_trade_no: "IMGMU7UH9SFF9A21D", money: 9.93, status: "TRADE_SUCCESS" }] });
    },
  });
  assert.match(seenUrl, /act=order/);
  assert.match(seenUrl, /out_trade_no=IMGMU7UH9SFF9A21D/);
  assert.equal(found?.money, 9.93);

  const missing = await fetchMapayOrder("NOPE", {
    config: CONFIG,
    logger: () => undefined,
    fetchImpl: async () => jsonResponse({ code: 1, data: [] }),
  });
  assert.equal(missing, null);
});

test("fetchMapayOrder：code=0 错误信封（无订单实体）→ 抛 upstream，不吞成「查无此单」", async () => {
  // 生产实证：act=order 不带单号回 {"code":0,"msg":"系统订单号 和 商户订单号 二选一"}；
  // 这类回应必须归错误，不得当成「成功但 data 为空」。
  await assert.rejects(
    () =>
      fetchMapayOrder("IMGMU7UH9SFF9A21D", {
        config: CONFIG,
        logger: () => undefined,
        fetchImpl: async () => jsonResponse({ code: 0, msg: "系统订单号 和 商户订单号 二选一" }),
      }),
    (error: unknown) => {
      assert.ok(error instanceof MapayOrdersError);
      assert.equal(error.kind, "upstream");
      assert.equal(error.upstreamCode, 0);
      assert.match(error.message, /二选一/);
      return true;
    },
  );
});

// 型别探针（变更探针，非行为证明）：正规化订单形状不被意外拓宽。
const _shape: MapayOrder = {
  outTradeNo: "x",
  tradeNo: null,
  money: null,
  status: "",
  paid: false,
  name: null,
  type: null,
  createdAt: null,
  paidAt: null,
  raw: {},
};
void _shape;