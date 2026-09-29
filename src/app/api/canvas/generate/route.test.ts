// `/api/canvas/generate` 路徑測試（真跑路由函式，非源碼掃描）——V-09：畫布生成改走 durable job。
//
// 釘住的不變量：
//   ① 預設走 durable：每張圖 POST /api/generation-jobs（各自 Idempotency-Key、原樣轉發
//      Authorization + x-user-id）→ 輪詢 GET /api/generation-jobs/{id} → 取件；零次打 /api/generate-images；
//   ② 對前端回應形狀一字不變：{ ok, task_id: null, images: [{ url, cost_coins, natural_width, natural_height }] }；
//   ③ 負面詞/參考圖角色不靜默丟：預組進 prompt（Avoid:/Reference images:）且角色進 referenceMetadata；
//   ④ 只有 durable 不支援的情境（LoRA、模型不收參考圖、參考圖格式/體積超 durable 限制）仍走 legacy；
//   ⑤ 超時回 504 generation_timeout，且**不**發出任何 DELETE（不取消任務）；
//   ⑥ 輪詢遇 5xx 視為瞬時、繼續問；任務失敗回既有錯誤形狀；部分成功回部分結果。
//
// 離線：global fetch 全量替身（零付費上游呼叫）；時間用 node:test mock timers 推進（不真等 280s）。
// 真執行器：`npx tsx --test src/app/api/canvas/generate/route.test.ts`

import test, { afterEach, beforeEach, mock } from "node:test";
import assert from "node:assert/strict";
import { NextRequest } from "next/server";
import { POST } from "./route";

const PNG_1X1 =
  "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==";
const GIF_1X1 = "data:image/gif;base64,R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7";

interface Recorded {
  method: string;
  url: string;
  headers: Headers;
  body: unknown;
}

type Handler = (call: Recorded) => Response | Promise<Response>;

const realFetch = globalThis.fetch;
let calls: Recorded[] = [];
let handler: Handler;

function json(data: unknown, status = 200): Response {
  return new Response(JSON.stringify(data), { status, headers: { "content-type": "application/json" } });
}

function projection(taskId: string, status: string, extra: Record<string, unknown> = {}) {
  return {
    taskId,
    status,
    modelId: "gpt-image-2",
    kind: "image_generate",
    results:
      status === "succeeded"
        ? [{ resultId: `r-${taskId}`, taskId, outputIndex: 0, url: `https://cdn.test/${taskId}.png`, mimeType: "image/png", width: 1024, height: 1024 }]
        : [],
    ...extra,
  };
}

beforeEach(() => {
  calls = [];
  handler = () => json({ error: "unexpected" }, 404);
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
    const method = (init?.method ?? "GET").toUpperCase();
    let body: unknown = init?.body;
    if (typeof body === "string") {
      try { body = JSON.parse(body); } catch { /* keep raw */ }
    }
    const call: Recorded = { method, url, headers: new Headers(init?.headers), body };
    calls.push(call);
    return handler(call);
  }) as typeof fetch;
  mock.timers.enable({ apis: ["setTimeout", "Date"], now: Date.now() });
});

afterEach(() => {
  mock.timers.reset();
  globalThis.fetch = realFetch;
});

/** 推進 mock 時鐘直到路由回應（每輪先讓出微任務/IO，再跳 5s）。 */
async function drive(promise: Promise<Response>): Promise<Response> {
  let done = false;
  void promise.then(() => { done = true; }, () => { done = true; });
  for (let i = 0; i < 1000 && !done; i += 1) {
    for (let k = 0; k < 10 && !done; k += 1) await new Promise((resolve) => setImmediate(resolve));
    if (!done) mock.timers.tick(5_000);
  }
  return promise;
}

function canvasRequest(body: Record<string, unknown>, auth = true): NextRequest {
  const headers: Record<string, string> = { "content-type": "application/json" };
  if (auth) {
    headers.authorization = "Bearer session-token-test";
    headers["x-user-id"] = "42";
  }
  return new NextRequest("http://canvas.test/api/canvas/generate", {
    method: "POST",
    headers,
    body: JSON.stringify(body),
  });
}

const isSubmit = (c: Recorded) => c.method === "POST" && c.url === "http://canvas.test/api/generation-jobs";
const isPoll = (c: Recorded) => c.method === "GET" && c.url.startsWith("http://canvas.test/api/generation-jobs/");
const isLegacy = (c: Recorded) => c.url.includes("/api/generate-images");

test("預設走 durable：count=2 → 兩次提交（各自冪等鍵、轉發身分）→ 輪詢取件，回應形狀不變", async () => {
  let n = 0;
  const polls = new Map<string, number>();
  handler = (call) => {
    if (isSubmit(call)) {
      n += 1;
      return json({ success: true, data: projection(`job-${n}`, "queued") }, 202);
    }
    if (isPoll(call)) {
      const id = call.url.split("/").pop()!;
      const seen = (polls.get(id) ?? 0) + 1;
      polls.set(id, seen);
      return json(projection(id, seen >= 2 ? "succeeded" : "running"));
    }
    return json({ error: "unexpected" }, 404);
  };

  const res = await drive(POST(canvasRequest({ prompt: "  一隻貓  ", model: "gpt-image-2", size: "16:9", quality: "high", count: 2 })));
  assert.equal(res.status, 200);
  const payload = await res.json();
  assert.deepEqual(Object.keys(payload).sort(), ["images", "ok", "task_id"]);
  assert.equal(payload.ok, true);
  assert.equal(payload.task_id, null);
  assert.equal(payload.images.length, 2);
  for (const image of payload.images) {
    assert.deepEqual(Object.keys(image).sort(), ["cost_coins", "natural_height", "natural_width", "url"]);
    assert.match(image.url, /^https:\/\/cdn\.test\/job-\d\.png$/);
    assert.equal(image.natural_width, null);
  }

  assert.equal(calls.filter(isLegacy).length, 0, "不得打 legacy 引擎");
  const submits = calls.filter(isSubmit);
  assert.equal(submits.length, 2);
  const keys = new Set(submits.map((c) => c.headers.get("idempotency-key")));
  assert.equal(keys.size, 2, "每張圖一把獨立冪等鍵");
  for (const submit of submits) {
    assert.equal(submit.headers.get("authorization"), "Bearer session-token-test");
    assert.equal(submit.headers.get("x-user-id"), "42");
    assert.deepEqual(submit.body, {
      prompt: "一隻貓",
      modelId: "gpt-image-2",
      qualityMode: "quality",
      aspectRatio: "16:9",
      outputResolution: "2k",
    });
  }
  const pollCalls = calls.filter(isPoll);
  assert.ok(pollCalls.length >= 4);
  for (const poll of pollCalls) {
    assert.equal(poll.headers.get("authorization"), "Bearer session-token-test");
    assert.equal(poll.headers.get("x-user-id"), "42");
  }
});

test("負面詞＋角色參考圖：durable multipart，prompt 預組 Avoid/Reference images，角色進 referenceMetadata", async () => {
  handler = (call) => (isSubmit(call) ? json({ success: true, data: projection("job-ref", "succeeded") }, 202) : json({}, 404));

  const res = await drive(
    POST(
      canvasRequest({
        prompt: "海邊的女孩",
        model: "gpt-image-2",
        negative_prompt: "多手指",
        reference_images: [{ url: PNG_1X1, role: "character", name: "小美" }],
      }),
    ),
  );
  assert.equal(res.status, 200);
  const payload = await res.json();
  assert.equal(payload.images[0].url, "https://cdn.test/job-ref.png");
  assert.equal(calls.filter(isLegacy).length, 0);

  const submit = calls.find(isSubmit)!;
  assert.ok(submit.body instanceof FormData);
  const form = submit.body as FormData;
  const prompt = String(form.get("prompt"));
  assert.match(prompt, /Prompt:\n海邊的女孩/);
  assert.match(prompt, /Reference images:\n- 小美 as character/);
  assert.match(prompt, /Avoid:\n多手指/);
  assert.deepEqual(JSON.parse(String(form.get("referenceMetadata"))), [{ name: "小美", role: "character" }]);
  assert.equal(form.getAll("referenceImages").length, 1);
  assert.equal(form.get("outputResolution"), "1k");
  assert.equal(form.get("modelId"), "gpt-image-2");
});

test("LoRA → 仍走 legacy（durable 無 adapter 消費 LoRA），不打 generation-jobs", async () => {
  handler = (call) => (isLegacy(call) ? json({ imageUrl: "https://cdn.test/legacy.png" }) : json({}, 404));
  const res = await drive(POST(canvasRequest({ prompt: "貓", model: "pixai-tsubaki2", loraModelVersionIds: ["lora-1"] })));
  assert.equal(res.status, 200);
  const payload = await res.json();
  assert.equal(payload.images[0].url, "https://cdn.test/legacy.png");
  assert.equal(calls.filter(isSubmit).length, 0);
  const legacy = calls.find(isLegacy)!;
  assert.deepEqual((legacy.body as { loraModelVersionIds: string[] }).loraModelVersionIds, ["lora-1"]);
});

test("模型不收參考圖（adobe-firefly）＋帶參考圖 → 仍走 legacy", async () => {
  handler = (call) => (isLegacy(call) ? json({ imageUrl: "https://cdn.test/legacy.png" }) : json({}, 404));
  const res = await drive(POST(canvasRequest({ prompt: "貓", model: "adobe-firefly", source_image: PNG_1X1 })));
  assert.equal(res.status, 200);
  assert.equal(calls.filter(isSubmit).length, 0);
  assert.equal(calls.filter(isLegacy).length, 1);
});

test("參考圖格式 durable 不收（GIF）→ 仍走 legacy", async () => {
  handler = (call) => (isLegacy(call) ? json({ imageUrl: "https://cdn.test/legacy.png" }) : json({}, 404));
  const res = await drive(POST(canvasRequest({ prompt: "貓", model: "gpt-image-2", source_image: GIF_1X1 })));
  assert.equal(res.status, 200);
  assert.equal(calls.filter(isSubmit).length, 0);
  assert.equal(calls.filter(isLegacy).length, 1);
});

test("超時：任務一直 running → 504 generation_timeout，且不發 DELETE（不取消任務）", async () => {
  handler = (call) => {
    if (isSubmit(call)) return json({ success: true, data: projection("job-slow", "queued") }, 202);
    if (isPoll(call)) return json(projection("job-slow", "running"));
    return json({}, 404);
  };
  const res = await drive(POST(canvasRequest({ prompt: "慢", model: "gpt-image-2" })));
  assert.equal(res.status, 504);
  const payload = await res.json();
  assert.deepEqual(Object.keys(payload).sort(), ["code", "error", "ok"]);
  assert.equal(payload.ok, false);
  assert.equal(payload.code, "generation_timeout");
  assert.equal(calls.filter((c) => c.method === "DELETE").length, 0);
  assert.equal(calls.filter(isLegacy).length, 0);
});

test("輪詢 502 視為瞬時繼續問；任務失敗回 502 generation_failed 帶任務錯誤訊息", async () => {
  let pollCount = 0;
  handler = (call) => {
    if (isSubmit(call)) return json({ success: true, data: projection("job-x", "queued") }, 202);
    if (isPoll(call)) {
      pollCount += 1;
      if (pollCount === 1) return new Response("<html>bad gateway</html>", { status: 502 });
      return json(projection("job-x", "failed", { errorCode: "upstream_error", errorMessage: "上游拒絕此提示詞" }));
    }
    return json({}, 404);
  };
  const res = await drive(POST(canvasRequest({ prompt: "x", model: "gpt-image-2" })));
  assert.equal(res.status, 502);
  const payload = await res.json();
  assert.equal(payload.code, "generation_failed");
  assert.equal(payload.error, "上游拒絕此提示詞");
  assert.equal(pollCount, 2);
});

test("部分成功：一張成功一張提交被拒 → 回部分結果", async () => {
  let n = 0;
  handler = (call) => {
    if (isSubmit(call)) {
      n += 1;
      return n === 1
        ? json({ success: true, data: projection("job-ok", "succeeded") }, 202)
        : json({ success: false, error: "额度不足", code: "insufficient_quota" }, 402);
    }
    return json({}, 404);
  };
  const res = await drive(POST(canvasRequest({ prompt: "x", model: "gpt-image-2", count: 2 })));
  assert.equal(res.status, 200);
  const payload = await res.json();
  assert.equal(payload.images.length, 1);
  assert.equal(payload.images[0].url, "https://cdn.test/job-ok.png");
});

test("缺身分 header → 401，不打任何下游", async () => {
  const res = await drive(POST(canvasRequest({ prompt: "x" }, false)));
  assert.equal(res.status, 401);
  assert.equal(calls.filter((c) => isSubmit(c) || isLegacy(c)).length, 0);
});
