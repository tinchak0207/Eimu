// mPay 訂單查詢客戶端測試：真輸入 → 真輸出（無外網，fake fetch）。

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

// ── URL 與遮蔽 ──────────────────────────────────────────────────────────

test("mapayApiUrl：基底（含尾斜線/不含）都收斂到同層 api.php，已是 api.php 則原樣", () => {
  assert.equal(mapayApiUrl("https://mzf.mapay.cc/xpay/epay/"), "https://mzf.mapay.cc/xpay/epay/api.php");
  assert.equal(mapayApiUrl("https://mzf.mapay.cc/xpay/epay"), "https://mzf.mapay.cc/xpay/epay/api.php");
  assert.equal(mapayApiUrl("https://mzf.mapay.cc/xpay/epay/api.php"), "https://mzf.mapay.cc/xpay/epay/api.php");
});

test("redactMapaySecrets：pid 與 key 的值都不出現在日誌字串裡", () => {
  const redacted = redactMapaySecrets(`{"pid":"1000","key":"abcSECRETxyz","data":[]}`, CONFIG);
  assert.doesNotMatch(redacted, /abcSECRETxyz/);
  assert.doesNotMatch(redacted, /"pid":"1000"/);
  assert.match(redacted, /\*\*\*/);
});

// ── 解析容忍度（成功形狀未定 ⇒ 多種別名都要認） ─────────────────────────

test("信封解析：data 陣列 / list 包裝 / 單筆物件 / 欄位別名 / 付款判定", () => {
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

// 真實響應契約鎖：2026-10-04 生產 act=order&out_trade_no=IMGMU7UH9SFF9A21D 逐字原始響應
// （pid 值在取證日誌中已遮蔽為 ***）。訂單欄位平鋪在信封根層 ⇒ 必須被認成 1 筆已付款。
const REAL_SINGLE_ORDER_RESPONSE =
  '{"code":1,"msg":"查询订单号成功！","trade_no":"20260919114538891000","out_trade_no":"IMGMU7UH9SFF9A21D","type":"alipay","pid":"***","addtime":"2026-09-19 11:45:38","endtime":"2026-09-19 11:49:00","name":"eimu.dev 梦芽 · 轻度尝鲜包 100金币","money":"9.93","param":"starter","buyer":"","status":1}';

test("真實響應（根層平鋪）：解析器認出 1 筆已付款、out_trade_no/money 正確", () => {
  const parsed = parseMapayOrdersResponse(JSON.parse(REAL_SINGLE_ORDER_RESPONSE));
  assert.equal(parsed.orders.length, 1);
  const order = parsed.orders[0];
  assert.equal(order.outTradeNo, "IMGMU7UH9SFF9A21D");
  assert.equal(order.tradeNo, "20260919114538891000");
  assert.equal(order.money, 9.93);
  assert.equal(order.paid, true);
  assert.equal(order.status, "1");
  assert.equal(parsed.empty, false);

  // 走完整單查路徑（fake fetch 回逐字原始字串）：必須找到該筆，不得判「查無此單」。
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

test("normalizeMapayOrder：缺 out_trade_no 的列不收（無法指認）；缺可解析時間不回假時間", () => {
  assert.equal(normalizeMapayOrder({ money: 1 }), null);
  assert.equal(normalizeMapayOrder(null), null);
  const order = normalizeMapayOrder({ out_trade_no: "IMGF", money: 9.9, addtime: "not-a-time" });
  assert.ok(order);
  assert.equal(order?.createdAt, null);
  assert.equal(order?.paidAt, null);
});

// ── 錯誤型別（逾時 / 非 JSON / 非 0 code 都要分開） ─────────────────────

test("fetchMapayOrders：成功回訂單，且原始響應（遮蔽後）落進日誌", async () => {
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

test("fetchMapayOrders：code 非 0（502）→ MapayOrdersError(kind=upstream) 且帶 code", async () => {
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

test("fetchMapayOrders：code=0 錯誤信封（無訂單實體）→ upstream（不當「成功但 data 空」）", async () => {
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

test("fetchMapayOrders：逾時（AbortSignal）→ kind=timeout，不吞成空集合", async () => {
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

test("fetchMapayOrders：config 缺失（無 pid/key）→ kind=config_missing", async () => {
  await assert.rejects(
    () => fetchMapayOrders({}, { env: { MAPAY_PID: "", MAPAY_KEY: "" }, logger: () => undefined }),
    (error: unknown) => error instanceof MapayOrdersError && error.kind === "config_missing",
  );
});

// ── 跨實例中繼（本機無憑證 → 問 Vercel；對帳器跑在控制面走這條） ─────────────

test("mapayOrdersRelayConfig：複用 GENERATION_BILLING_RELAY_URL 的 origin，缺件回 null", () => {
  assert.deepEqual(
    mapayOrdersRelayConfig({
      GENERATION_BILLING_RELAY_URL: "https://image.example/api/internal/generation-billing",
      GENERATION_BILLING_RELAY_SECRET: "shared",
    }),
    { url: "https://image.example/api/internal/mapay-orders", secret: "shared" },
  );
  // 只給 URL、沒有 secret → 通道不可用
  assert.equal(mapayOrdersRelayConfig({ GENERATION_BILLING_RELAY_URL: "https://image.example/x" }), null);
});

test("fetchMapayOrders：本機無憑證 → 經 HMAC（域 mapay-orders）打 Vercel 中繼並採納其結果", async () => {
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
  // 簽名必須以本用途的域分隔前綴簽出（不得沿用 biz-key-sync）
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

test("fetchMapayOrders：無憑證且中繼未配置 → config_missing（不假裝成功、不吐空集合）", async () => {
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

// ── 窗口過濾與單筆查詢 ──────────────────────────────────────────────────

test("fetchMapayOrders：窗口客戶端過濾（窗口外剔除；時間不可解析的保守保留）", async () => {
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

test("fetchMapayOrder：act=order 帶商戶單號，回單筆；成功碼但零訂單回 null（查無此單）", async () => {
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

test("fetchMapayOrder：code=0 錯誤信封（無訂單實體）→ 拋 upstream，不吞成「查無此單」", async () => {
  // 生產實證：act=order 不帶單號回 {"code":0,"msg":"系统订单号 和 商户订单号 二选一"}；
  // 這類回應必須歸錯誤，不得當成「成功但 data 為空」。
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

// 型別探針（變更探針，非行為證明）：正規化訂單形狀不被意外拓寬。
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