// POST /api/harness/media/quality 的真行为测试。
//
// 验的是「route 真的跑硬检」而不是「route 存在」：
//   · 未带密钥 → 401（正负对照）。
//   · 直接给 probe：走 evaluateMediaQuality 分支（verdict 完全由传入的 probe 决定，
//     代表**没有** 去 spawn ffprobe——若 spawn 了，量到的数字不可能刚好是我们的假值）。
//   · media_url 探测不可用：回 probe_unavailable 且 ok:false（**不是** ok:true 假通过）。
//   · policy 未知 → 400；两者都没给 → 400。

process.env.NODE_ENV = "test"; // 无物件储存后端时允许记忆体降级（blob-backend 既有契约）

import test from "node:test";
import assert from "node:assert/strict";
import { NextRequest } from "next/server";

import { hashBizApiKey } from "@/lib/biz-api-keys";
import { __resetBizKeyStoreForTests } from "@/lib/biz-api-key-store";
import { POST } from "./route";

const VALID_KEY = `sk-biz-${"f0e1d2c3b4a59687".repeat(2)}`;
const VALID_USER_ID = 9202;

function reset() {
  delete process.env.GENERATION_DATABASE_URL;
  delete process.env.DATABASE_URL;
  process.env.BIZ_API_KEY_HASHES = `${hashBizApiKey(VALID_KEY)}:${VALID_USER_ID}`;
  __resetBizKeyStoreForTests();
}

function req(init: { headers?: Record<string, string>; body?: unknown; raw?: string } = {}): NextRequest {
  const headers = new Headers(init.headers);
  headers.set("content-type", "application/json");
  return new NextRequest("http://localhost/api/harness/media/quality", {
    method: "POST",
    headers,
    body: init.raw ?? JSON.stringify(init.body ?? {}),
  });
}

async function bodyOf(response: Response) {
  return (await response.json()) as {
    ok?: boolean;
    measured?: Record<string, unknown>;
    failures?: Array<{ code: string; detail: string }>;
    policyId?: string;
    error?: { message: string; type: string; code: string };
  };
}

const AUTH = { authorization: `Bearer ${VALID_KEY}` };

/** 呼叫方自己 ffprobe 的结果（**故意不含 `ok` 栏位**：MediaProbe 没有 ok，verdict 才有）。 */
const CALLER_PROBE = {
  status: "ok",
  error: null,
  container: "mov,mp4,m4a,3gp,3g2,mj2",
  durationSec: 3.5,
  sizeBytes: 48_000,
  video: { codec: "h264", width: 64, height: 64 },
  audio: null,
};

test.beforeEach(reset);
test.after(() => {
  delete process.env.BIZ_API_KEY_HASHES;
  __resetBizKeyStoreForTests();
});

test("未带密钥：401，错误体是 authentication_error / missing_api_key", async () => {
  const response = await POST(req({ body: { probe: CALLER_PROBE } }));
  assert.equal(response.status, 401);
  const payload = await bodyOf(response);
  assert.equal(payload.error?.type, "authentication_error");
  assert.equal(payload.error?.code, "missing_api_key");
});

test("直接给 probe：走 evaluate 分支——verdict 完全由传入 probe 决定（未 spawn ffprobe）", async () => {
  const response = await POST(req({ headers: AUTH, body: { probe: CALLER_PROBE, policy: "video_default" } }));
  assert.equal(response.status, 200);
  const payload = await bodyOf(response);
  assert.equal(payload.ok, false, "64x64 低于 video_default 的 320x240 下限，必须 ok:false");
  assert.equal(payload.policyId, "video_default");
  // measured 逐栏等于我们传入的假值 ⇒ 证明 evaluate 用的是我们的 probe，没有去实测。
  assert.equal(payload.measured?.status, "ok");
  assert.equal(payload.measured?.width, 64);
  assert.equal(payload.measured?.height, 64);
  assert.equal(payload.measured?.duration_sec, 3.5);
  assert.equal(payload.measured?.byte_size, 48_000);
  const codes = (payload.failures ?? []).map((failure) => failure.code).sort();
  assert.deepEqual(codes, ["height_below_min", "width_below_min"]);
});

test("probe 为 unparsable：原样带出呼叫方的 error 字串（未知不当通过）", async () => {
  const unparsable = { ...CALLER_PROBE, status: "unparsable", error: "ffprobe 输出不是有效 JSON：<broken>" };
  const response = await POST(req({ headers: AUTH, body: { probe: unparsable } }));
  assert.equal(response.status, 200);
  const payload = await bodyOf(response);
  assert.equal(payload.ok, false);
  assert.equal(payload.failures?.[0].code, "unparsable");
  assert.match(payload.failures?.[0].detail ?? "", /不是有效 JSON/);
});

test("media_url 探测不可用：回 probe_unavailable 且 ok:false（诚实——不是 ok:true 假通过）", async () => {
  // 连不上的位址 ⇒ probeMedia 回 probe_unavailable（无论本机有没有 ffprobe 都成立）。
  const response = await POST(req({ headers: AUTH, body: { media_url: "http://127.0.0.1:1/does-not-exist.mp4" } }));
  assert.equal(response.status, 200);
  const payload = await bodyOf(response);
  assert.equal(payload.ok, false, "量测没发生不得回 ok:true");
  assert.equal(payload.measured?.status, "probe_unavailable");
  assert.equal(payload.failures?.[0].code, "probe_unavailable");
  assert.equal(payload.policyId, "video_default", "未给 policy 时预设 video_default");
});

test("policy 未知：400 invalid_policy（含原型链幻影 constructor）", async () => {
  for (const policy of ["not-a-policy", "constructor"]) {
    const response = await POST(req({ headers: AUTH, body: { probe: CALLER_PROBE, policy } }));
    assert.equal(response.status, 400, `policy=${policy} 应 400`);
    assert.equal((await bodyOf(response)).error?.code, "invalid_policy");
  }
});

test("两种量测输入都没给：400 missing_measurement_input", async () => {
  const response = await POST(req({ headers: AUTH, body: {} }));
  assert.equal(response.status, 400);
  assert.equal((await bodyOf(response)).error?.code, "missing_measurement_input");
});

test("probe 非物件：400 invalid_probe", async () => {
  const response = await POST(req({ headers: AUTH, body: { probe: "not-an-object" } }));
  assert.equal(response.status, 400);
  assert.equal((await bodyOf(response)).error?.code, "invalid_probe");
});
