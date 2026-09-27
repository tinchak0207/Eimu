// 運行時（不是源碼字串檢查）測 /api/payments/mapay/notify 的發放通道選擇：
//
// 做法：起一個本地假伺服器同時扮兩個角色（全程 127.0.0.1，無外網、無真實支付）：
//   ① 控面 /image-control/api/internal/mapay-credit —— 用真 HMAC 域驗簽（證明簽名契約），
//      再跑真實入帳核心 runMapayCreditOnce（佔位表＋上游調額＋帳本都在假依賴上）。
//   ② new-api 網關 /api/redemption/* —— 舊流程發碼（fallback）用，記錄有沒有被呼叫。
//
// 判據（一一對應驗收條目）：
//   - 已綁定的單直接入帳、**不發兌換碼**；同一單重放只入帳一次。
//   - 上游調額失敗（quota 未變）→ 退回舊流程發碼。
//   - 舊格式 param（未登入下單）→ 完全不碰入帳通道，行為與從前一致。

import assert from "node:assert/strict";
import test from "node:test";
import { createServer, type Server } from "node:http";
import { NextRequest } from "next/server";

import { BIZ_KEY_SYNC_SIGNATURE_HEADER, BIZ_KEY_SYNC_TIMESTAMP_HEADER, verifyBizKeySync } from "@/lib/biz-key-sync";
import {
  MAPAY_CREDIT_RELAY_SIGNATURE_DOMAIN,
  runMapayCreditOnce,
  type MapayCreditDeps,
  type MapayCreditRecord,
  type MapayCreditStore,
} from "@/lib/mapay-credit";
import { buildMapayOrderParam } from "@/lib/mapay-order-param";
import { signMapayParams } from "@/lib/mapay";
import { mapayPlanQuota } from "@/lib/mapay-redemption";
import { resolvePricingPlan } from "@/lib/plans";
import { GET as notify } from "./route";

const PID = "test-pid";
const MAPAY_KEY = "test-mapay-key";
const RELAY_SECRET = "test-relay-secret";

type FakeState = {
  quota: number;
  adjustFails: boolean;
  adjustCalls: number;
  ledgerCalls: number;
  creditRequests: number;
  redemptionCreates: string[];
  rows: Map<string, MapayCreditRecord>;
};

let server: Server | null = null;
let origin = "";
let state: FakeState = freshState();
const savedEnv: Record<string, string | undefined> = {};

function freshState(): FakeState {
  return {
    quota: 1_000, // 起始额度；断言引用 BASE_QUOTA 常量，不写死数字
    adjustFails: false,
    adjustCalls: 0,
    ledgerCalls: 0,
    creditRequests: 0,
    redemptionCreates: [],
    rows: new Map(),
  };
}

function fakeDeps(): MapayCreditDeps {
  const store: MapayCreditStore = {
    async claim(input) {
      if (state.rows.has(input.orderId)) return false;
      state.rows.set(input.orderId, { ...input, status: "pending" });
      return true;
    },
    async get(orderId) {
      return state.rows.get(orderId) ?? null;
    },
    async mark(orderId, status) {
      const row = state.rows.get(orderId);
      if (row) state.rows.set(orderId, { ...row, status });
    },
  };
  return {
    store,
    async ensureBaseline() {
      return { ready: true, blocked: false };
    },
    async readUpstreamQuota() {
      return state.quota;
    },
    async adjustUpstream(_userId, delta) {
      state.adjustCalls += 1;
      if (state.adjustFails) throw new Error("upstream 500");
      state.quota += delta;
    },
    async recordLedger() {
      state.ledgerCalls += 1;
      return { posted: true };
    },
  };
}

function json(payload: unknown, status = 200) {
  return { status, body: JSON.stringify(payload), type: "application/json" };
}

test.before(async () => {
  for (const name of [
    "MAPAY_PID",
    "MAPAY_KEY",
    "GENERATION_BILLING_RELAY_SECRET",
    "GENERATION_CONTROL_PLANE_PROXY_ORIGIN",
    "GATEWAY_BASE_URL",
    // 舊流程發碼要用的網關管理憑證（假值，不打外網）
    "GATEWAY_ADMIN_ACCESS_TOKEN",
    "GATEWAY_ADMIN_USER_ID",
  ]) {
    savedEnv[name] = process.env[name];
  }

  server = createServer((req, res) => {
    const url = new URL(req.url ?? "/", origin || "http://127.0.0.1");
    const chunks: Buffer[] = [];
    req.on("data", (chunk: Buffer) => chunks.push(chunk));
    req.on("end", () => {
      void (async () => {
        const rawBody = Buffer.concat(chunks).toString("utf8");
        let reply = json({ ok: false }, 404);

        if (url.pathname === "/image-control/api/internal/mapay-credit") {
          state.creditRequests += 1;
          const verified = verifyBizKeySync({
            secret: RELAY_SECRET,
            timestamp: req.headers[BIZ_KEY_SYNC_TIMESTAMP_HEADER.toLowerCase()] as string | undefined,
            signature: req.headers[BIZ_KEY_SYNC_SIGNATURE_HEADER.toLowerCase()] as string | undefined,
            rawBody,
            signatureDomain: MAPAY_CREDIT_RELAY_SIGNATURE_DOMAIN,
          });
          if (!verified) reply = json({ ok: false, message: "签名校验失败。" }, 401);
          else {
            const body = JSON.parse(rawBody) as { orderId: string; userId: number; planId: string };
            const plan = resolvePricingPlan(body.planId);
            const outcome = await runMapayCreditOnce(fakeDeps(), {
              orderId: body.orderId,
              userId: body.userId,
              planId: body.planId,
              amountQuota: plan ? mapayPlanQuota(plan) : 0,
            });
            reply = json({ ok: true, outcome });
          }
        } else if (url.pathname === "/api/redemption/search") {
          // 舊流程發碼前的查重：本測試一律當作沒發過。
          reply = json({ success: true, data: { items: [] } });
        } else if (url.pathname === "/api/redemption/") {
          const body = JSON.parse(rawBody) as { name: string };
          state.redemptionCreates.push(body.name);
          reply = json({ success: true, data: [`CDK-${body.name}`] });
        }

        res.writeHead(reply.status, { "Content-Type": reply.type });
        res.end(reply.body);
      })();
    });
  });

  await new Promise<void>((resolve) => server!.listen(0, "127.0.0.1", resolve));
  const address = server!.address();
  origin = `http://127.0.0.1:${typeof address === "object" && address ? address.port : 0}`;

  process.env.MAPAY_PID = PID;
  process.env.MAPAY_KEY = MAPAY_KEY;
  process.env.GENERATION_BILLING_RELAY_SECRET = RELAY_SECRET;
  process.env.GENERATION_CONTROL_PLANE_PROXY_ORIGIN = origin;
  process.env.GATEWAY_BASE_URL = origin;
  process.env.GATEWAY_ADMIN_ACCESS_TOKEN = "test-admin-token";
  process.env.GATEWAY_ADMIN_USER_ID = "1";
});

test.after(async () => {
  if (server) await new Promise<void>((resolve) => server!.close(() => resolve()));
  for (const [name, value] of Object.entries(savedEnv)) {
    if (value === undefined) delete process.env[name];
    else process.env[name] = value;
  }
});

/** 造一個 mPay 回調（簽名用真 signMapayParams，等同網關發來的合法回調）。 */
function callbackRequest(input: {
  orderId: string;
  param: string;
  userId?: number;
  planId?: string;
  money?: string;
}): NextRequest {
  const planId = input.planId ?? "popular";
  const plan = resolvePricingPlan(planId);
  const params: Record<string, string> = {
    pid: PID,
    trade_no: `T${input.orderId}`,
    out_trade_no: input.orderId,
    type: "wxpay",
    name: `test ${plan?.name ?? planId} ${plan?.coins ?? 0}金币`,
    money: input.money ?? (plan ? plan.price.toFixed(2) : "0.00"),
    trade_status: "TRADE_SUCCESS",
    param: input.param,
  };
  params.sign = signMapayParams(params, MAPAY_KEY);
  params.sign_type = "MD5";
  const url = new URL("http://site.test/api/payments/mapay/notify");
  for (const [key, value] of Object.entries(params)) url.searchParams.set(key, value);
  return new NextRequest(url, { method: "GET" });
}

const BOUND_PARAM = buildMapayOrderParam("popular", 253, RELAY_SECRET);
/** popular 档的额度（quota 单位）：入帳應加的數量，取自 plans.ts 同源口徑。 */
const POPULAR_QUOTA = mapayPlanQuota(resolvePricingPlan("popular")!);
const BASE_QUOTA = 1_000;

test("bound order is credited directly and no redemption code is created", async () => {
  state = freshState();
  const res = await notify(callbackRequest({ orderId: "IMG-BOUND-1", param: BOUND_PARAM }));

  assert.equal(res.status, 200);
  assert.equal(await res.text(), "success");
  assert.equal(state.quota, BASE_QUOTA + POPULAR_QUOTA, "上游加额一次");
  assert.equal(state.ledgerCalls, 1, "帐本记一笔");
  assert.deepEqual(state.redemptionCreates, [], "不再生成兑换码");
  assert.equal(state.rows.get("IMG-BOUND-1")?.status, "applied");
});

test("replaying the same notify credits only once and still creates no code", async () => {
  state = freshState();
  const first = await notify(callbackRequest({ orderId: "IMG-REPLAY", param: BOUND_PARAM }));
  const replay = await notify(callbackRequest({ orderId: "IMG-REPLAY", param: BOUND_PARAM }));

  assert.equal(await first.text(), "success");
  assert.equal(await replay.text(), "success");
  assert.equal(state.quota, BASE_QUOTA + POPULAR_QUOTA, "重放不重复入帐");
  assert.equal(state.adjustCalls, 1);
  assert.equal(state.ledgerCalls, 1);
  assert.deepEqual(state.redemptionCreates, []);
});

test("upstream adjust failure falls back to the legacy redemption flow", async () => {
  state = freshState();
  state.adjustFails = true;
  const res = await notify(callbackRequest({ orderId: "IMG-FAILED", param: BOUND_PARAM }));

  assert.equal(await res.text(), "success", "钱必须落地：回 success 让网关注销本单");
  assert.equal(state.quota, BASE_QUOTA, "上游没动");
  assert.equal(state.ledgerCalls, 0);
  assert.deepEqual(state.redemptionCreates, ["MPIMG-FAILED"], "退回旧流程发码兜底");
  assert.equal(state.rows.get("IMG-FAILED")?.status, "failed");
});

test("legacy param (not logged in) never touches the credit channel", async () => {
  state = freshState();
  const res = await notify(callbackRequest({ orderId: "IMG-LEGACY", param: "popular" }));

  assert.equal(await res.text(), "success");
  assert.equal(state.creditRequests, 0, "旧格式不走直达入帐");
  assert.deepEqual(state.redemptionCreates, ["MPIMG-LEGACY"], "行为与从前一致：只发码");
  assert.equal(state.quota, BASE_QUOTA);
});

test("tampered userId never reaches the credit channel (rejected like any unresolvable param)", async () => {
  state = freshState();
  const tampered = BOUND_PARAM.replace(".253.", ".254.");
  const res = await notify(callbackRequest({ orderId: "IMG-TAMPER", param: tampered }));

  // 篡改 userId 後簽名不成立：param 既不是合法三段值、也不是任何套餐 id
  // → 走舊流程的同一條判斷（resolvePricingPlan 失敗）＝拒收，絕不把額度記到錯的人頭上。
  assert.equal(res.status, 400);
  assert.equal(await res.text(), "fail");
  assert.equal(state.creditRequests, 0, "验签失败＝绝不碰直达入帐通道");
  assert.deepEqual(state.redemptionCreates, [], "无法解析套餐＝不发码（与改动前一致）");
  assert.equal(state.quota, BASE_QUOTA);
});

test("channel unavailable (relay down) falls back to the legacy redemption flow", async () => {
  state = freshState();
  const previousOrigin = process.env.GENERATION_CONTROL_PLANE_PROXY_ORIGIN;
  // 指向一個沒人監聽的埠：等於控面通道不可用（HMAC 中繼失敗）。
  process.env.GENERATION_CONTROL_PLANE_PROXY_ORIGIN = "http://127.0.0.1:1";
  try {
    const res = await notify(callbackRequest({ orderId: "IMG-CHANNEL-DOWN", param: BOUND_PARAM }));
    assert.equal(await res.text(), "success");
    assert.deepEqual(state.redemptionCreates, ["MPIMG-CHANNEL-DOWN"], "退回旧流程发码兜底");
    assert.equal(state.quota, BASE_QUOTA, "通道不可用＝上游没动");
  } finally {
    process.env.GENERATION_CONTROL_PLANE_PROXY_ORIGIN = previousOrigin;
  }
});