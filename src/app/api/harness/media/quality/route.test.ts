// POST /api/harness/media/quality 的真行為測試。
//
// 驗的是「route 真的跑硬檢」而不是「route 存在」：
//   · 未帶密鑰 → 401（正負對照）。
//   · 直接給 probe：走 evaluateMediaQuality 分支（verdict 完全由傳入的 probe 決定，
//     代表**沒有** 去 spawn ffprobe——若 spawn 了，量到的數字不可能剛好是我們的假值）。
//   · media_url 探測不可用：回 probe_unavailable 且 ok:false（**不是** ok:true 假通過）。
//   · policy 未知 → 400；兩者都沒給 → 400。

process.env.NODE_ENV = "test"; // 無物件儲存後端時允許記憶體降級（blob-backend 既有契約）

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

/** 呼叫方自己 ffprobe 的結果（**故意不含 `ok` 欄位**：MediaProbe 沒有 ok，verdict 才有）。 */
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

test("未帶密鑰：401，錯誤體是 authentication_error / missing_api_key", async () => {
  const response = await POST(req({ body: { probe: CALLER_PROBE } }));
  assert.equal(response.status, 401);
  const payload = await bodyOf(response);
  assert.equal(payload.error?.type, "authentication_error");
  assert.equal(payload.error?.code, "missing_api_key");
});

test("直接給 probe：走 evaluate 分支——verdict 完全由傳入 probe 決定（未 spawn ffprobe）", async () => {
  const response = await POST(req({ headers: AUTH, body: { probe: CALLER_PROBE, policy: "video_default" } }));
  assert.equal(response.status, 200);
  const payload = await bodyOf(response);
  assert.equal(payload.ok, false, "64x64 低於 video_default 的 320x240 下限，必須 ok:false");
  assert.equal(payload.policyId, "video_default");
  // measured 逐欄等於我們傳入的假值 ⇒ 證明 evaluate 用的是我們的 probe，沒有去實測。
  assert.equal(payload.measured?.status, "ok");
  assert.equal(payload.measured?.width, 64);
  assert.equal(payload.measured?.height, 64);
  assert.equal(payload.measured?.duration_sec, 3.5);
  assert.equal(payload.measured?.byte_size, 48_000);
  const codes = (payload.failures ?? []).map((failure) => failure.code).sort();
  assert.deepEqual(codes, ["height_below_min", "width_below_min"]);
});

test("probe 為 unparsable：原樣帶出呼叫方的 error 字串（未知不當通過）", async () => {
  const unparsable = { ...CALLER_PROBE, status: "unparsable", error: "ffprobe 輸出不是有效 JSON：<broken>" };
  const response = await POST(req({ headers: AUTH, body: { probe: unparsable } }));
  assert.equal(response.status, 200);
  const payload = await bodyOf(response);
  assert.equal(payload.ok, false);
  assert.equal(payload.failures?.[0].code, "unparsable");
  assert.match(payload.failures?.[0].detail ?? "", /不是有效 JSON/);
});

test("media_url 探測不可用：回 probe_unavailable 且 ok:false（誠實——不是 ok:true 假通過）", async () => {
  // 連不上的位址 ⇒ probeMedia 回 probe_unavailable（無論本機有沒有 ffprobe 都成立）。
  const response = await POST(req({ headers: AUTH, body: { media_url: "http://127.0.0.1:1/does-not-exist.mp4" } }));
  assert.equal(response.status, 200);
  const payload = await bodyOf(response);
  assert.equal(payload.ok, false, "量測沒發生不得回 ok:true");
  assert.equal(payload.measured?.status, "probe_unavailable");
  assert.equal(payload.failures?.[0].code, "probe_unavailable");
  assert.equal(payload.policyId, "video_default", "未給 policy 時預設 video_default");
});

test("policy 未知：400 invalid_policy（含原型鏈幻影 constructor）", async () => {
  for (const policy of ["not-a-policy", "constructor"]) {
    const response = await POST(req({ headers: AUTH, body: { probe: CALLER_PROBE, policy } }));
    assert.equal(response.status, 400, `policy=${policy} 應 400`);
    assert.equal((await bodyOf(response)).error?.code, "invalid_policy");
  }
});

test("兩種量測輸入都沒給：400 missing_measurement_input", async () => {
  const response = await POST(req({ headers: AUTH, body: {} }));
  assert.equal(response.status, 400);
  assert.equal((await bodyOf(response)).error?.code, "missing_measurement_input");
});

test("probe 非物件：400 invalid_probe", async () => {
  const response = await POST(req({ headers: AUTH, body: { probe: "not-an-object" } }));
  assert.equal(response.status, 400);
  assert.equal((await bodyOf(response)).error?.code, "invalid_probe");
});
