// 运行时测 /api/payments/mapay/return 的回跳语义（全程 127.0.0.1 假伺服器，无外网、无真实支付）：
//
//   - 订单已直接入帐 → 回跳带 `mapay=credited`（前端显示「支付成功，已到账」），**不触发兑换**。
//   - 占位结果未定／通道不可用 → `mapay=pending`（发放权留给 notify，不开第二条通道）。
//   - 上游明确没动（failed）→ 退回旧流程发码（`cdk=`）。
//
// 控面侧用真 HMAC 域验签后跑真实入帐核心；new-api 网关是假的，只记录有没有被发码。

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
import { GET as mapayReturn } from "./route";

const PID = "test-pid";
const MAPAY_KEY = "test-mapay-key";
const RELAY_SECRET = "test-relay-secret";
const POPULAR = resolvePricingPlan("popular")!;
const BOUND_PARAM = buildMapayOrderParam("popular", 253, RELAY_SECRET);

type State = {
  adjustFails: boolean;
  channelDown: boolean;
  rows: Map<string, MapayCreditRecord>;
  redemptionCreates: string[];
};

let server: Server | null = null;
let origin = "";
let state: State = freshState();
const savedEnv: Record<string, string | undefined> = {};

function freshState(): State {
  return { adjustFails: false, channelDown: false, rows: new Map(), redemptionCreates: [] };
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
      return 1_000;
    },
    async adjustUpstream() {
      if (state.adjustFails) throw new Error("upstream 500");
    },
    async recordLedger() {
      return { posted: true };
    },
  };
}

test.before(async () => {
  for (const name of [
    "MAPAY_PID",
    "MAPAY_KEY",
    "GENERATION_BILLING_RELAY_SECRET",
    "GENERATION_CONTROL_PLANE_PROXY_ORIGIN",
    "GATEWAY_BASE_URL",
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
        let status = 200;
        let payload: unknown = { ok: false };

        if (url.pathname === "/image-control/api/internal/mapay-credit") {
          const verified = verifyBizKeySync({
            secret: RELAY_SECRET,
            timestamp: req.headers[BIZ_KEY_SYNC_TIMESTAMP_HEADER.toLowerCase()] as string | undefined,
            signature: req.headers[BIZ_KEY_SYNC_SIGNATURE_HEADER.toLowerCase()] as string | undefined,
            rawBody,
            signatureDomain: MAPAY_CREDIT_RELAY_SIGNATURE_DOMAIN,
          });
          if (!verified) {
            status = 401;
          } else {
            const body = JSON.parse(rawBody) as { orderId: string; userId: number; planId: string };
            payload = {
              ok: true,
              outcome: await runMapayCreditOnce(fakeDeps(), {
                orderId: body.orderId,
                userId: body.userId,
                planId: body.planId,
                amountQuota: mapayPlanQuota(POPULAR),
              }),
            };
          }
        } else if (url.pathname === "/api/redemption/search") {
          payload = { success: true, data: { items: [] } };
        } else if (url.pathname === "/api/redemption/") {
          const body = JSON.parse(rawBody) as { name: string };
          state.redemptionCreates.push(body.name);
          payload = { success: true, data: [`CDK-${body.name}`] };
        } else {
          status = 404;
        }

        res.writeHead(status, { "Content-Type": "application/json" });
        res.end(JSON.stringify(payload));
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

function returnRequest(orderId: string, param: string): NextRequest {
  const params: Record<string, string> = {
    pid: PID,
    trade_no: `T${orderId}`,
    out_trade_no: orderId,
    type: "wxpay",
    name: `test ${POPULAR.name} ${POPULAR.coins}金币`,
    money: POPULAR.price.toFixed(2),
    trade_status: "TRADE_SUCCESS",
    param,
  };
  params.sign = signMapayParams(params, MAPAY_KEY);
  params.sign_type = "MD5";
  const url = new URL("http://site.test/api/payments/mapay/return");
  for (const [key, value] of Object.entries(params)) url.searchParams.set(key, value);
  return new NextRequest(url, { method: "GET" });
}

function locationOf(res: Response): URL {
  return new URL(res.headers.get("location") ?? "");
}

test("credited order redirects to ?mapay=credited and never creates a redemption code", async () => {
  state = freshState();
  const res = await mapayReturn(returnRequest("IMG-RETURN-OK", BOUND_PARAM));
  const location = locationOf(res);

  assert.equal(location.pathname, "/pricing");
  assert.equal(location.searchParams.get("mapay"), "credited");
  assert.equal(location.searchParams.get("cdk"), null);
  assert.deepEqual(state.redemptionCreates, [], "已入帐＝不触发兑换");
  assert.equal(state.rows.get("IMG-RETURN-OK")?.status, "applied");
});

test("unavailable channel redirects to ?mapay=pending without opening a second delivery channel", async () => {
  state = freshState();
  const previousOrigin = process.env.GENERATION_CONTROL_PLANE_PROXY_ORIGIN;
  process.env.GENERATION_CONTROL_PLANE_PROXY_ORIGIN = "http://127.0.0.1:1";
  try {
    const res = await mapayReturn(returnRequest("IMG-RETURN-DOWN", BOUND_PARAM));
    const location = locationOf(res);

    assert.equal(location.searchParams.get("mapay"), "pending");
    assert.equal(location.searchParams.get("cdk"), null);
    assert.deepEqual(state.redemptionCreates, [], "通道结果不明＝不发码，交给 notify 定夺");
  } finally {
    process.env.GENERATION_CONTROL_PLANE_PROXY_ORIGIN = previousOrigin;
  }
});

test("upstream did not move (failed) redirects pending without creating a code (return is read-only)", async () => {
  state = freshState();
  state.adjustFails = true;
  const res = await mapayReturn(returnRequest("IMG-RETURN-FAILED", BOUND_PARAM));
  const location = locationOf(res);

  // 回跳只读：不入帐、不创建兑换码。failed 也交给 notify/sweep 发放，不在此开第二条通道。
  assert.equal(location.searchParams.get("mapay"), "pending");
  assert.equal(location.searchParams.get("cdk"), null);
  assert.deepEqual(state.redemptionCreates, [], "发放权只在 notify/sweep");
});

test("legacy param redirects pending without creating a code (return is read-only)", async () => {
  state = freshState();
  const res = await mapayReturn(returnRequest("IMG-RETURN-LEGACY", "popular"));
  const location = locationOf(res);

  // 旧格式同样只读：已存在的兑换码才回显，绝不在这里创建。
  assert.equal(location.searchParams.get("mapay"), "pending");
  assert.equal(location.searchParams.get("cdk"), null);
  assert.deepEqual(state.redemptionCreates, [], "回跳不创建兑换码");
});

test("second return visit after a direct credit still shows credited (no cdk, no double credit)", async () => {
  state = freshState();
  await mapayReturn(returnRequest("IMG-RETURN-REPLAY", BOUND_PARAM));
  const again = await mapayReturn(returnRequest("IMG-RETURN-REPLAY", BOUND_PARAM));
  const location = locationOf(again);

  assert.equal(location.searchParams.get("mapay"), "credited");
  assert.equal(location.searchParams.get("cdk"), null);
  assert.deepEqual(state.redemptionCreates, []);
});