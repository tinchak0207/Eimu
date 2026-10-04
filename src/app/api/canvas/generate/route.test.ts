// `/api/canvas/generate` 路径测试（真跑路由函式，非源码扫描）——V-09：画布生成改走 durable job。
//
// 钉住的不变量：
//   ① 预设走 durable：每张图 POST /api/generation-jobs（各自 Idempotency-Key、原样转发
//      Authorization + x-user-id）→ 轮询 GET /api/generation-jobs/{id} → 取件；零次打 /api/generate-images；
//   ② 对前端回应形状只加键不改义：{ ok, task_id, images: [{ url, cost_coins, natural_width, natural_height, task_id }] }；
//      images[i].task_id＝产出该图的 durable job id（LOD3 工程透析指针；legacy 无 job＝null），顶层 task_id＝首张的 id；
//   ③ 负面词/参考图角色不静默丢：预组进 prompt（Avoid:/Reference images:）且角色进 referenceMetadata；
//   ④ 只有 durable 不支援的情境（LoRA、模型不收参考图、参考图格式/体积超 durable 限制）仍走 legacy；
//   ⑤ 超时回 504 generation_timeout，且**不**发出任何 DELETE（不取消任务）；
//   ⑥ 轮询遇 5xx 视为瞬时、继续问；任务失败回既有错误形状；部分成功回部分结果。
//
// 离线：global fetch 全量替身（零付费上游呼叫）；时间用 node:test mock timers 推进（不真等 280s）。
// 真执行器：`npx tsx --test src/app/api/canvas/generate/route.test.ts`

import test, { afterEach, beforeEach, mock } from "node:test";
import assert from "node:assert/strict";
import { NextRequest } from "next/server";
import { POST } from "./route";
import { getStyleById, STYLE_LIBRARY } from "@/lib/style-library";

/** 真实注册表 id（不造假风格）。 */
const STYLE_ID = STYLE_LIBRARY[0].id;

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

/** 推进 mock 时钟直到路由回应（每轮先让出微任务/IO，再跳 5s）。 */
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

test("预设走 durable：count=2 → 两次提交（各自幂等键、转发身分）→ 轮询取件，回应形状不变", async () => {
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

  const res = await drive(POST(canvasRequest({ prompt: "  一只猫  ", model: "gpt-image-2", size: "16:9", quality: "high", count: 2 })));
  assert.equal(res.status, 200);
  const payload = await res.json();
  assert.deepEqual(Object.keys(payload).sort(), ["images", "ok", "task_id"]);
  assert.equal(payload.ok, true);
  assert.equal(payload.images.length, 2);
  for (const image of payload.images) {
    assert.deepEqual(Object.keys(image).sort(), ["cost_coins", "natural_height", "natural_width", "task_id", "url"]);
    assert.match(image.url, /^https:\/\/cdn\.test\/job-\d\.png$/);
    assert.equal(image.natural_width, null);
    // 每张图的 task_id 就是产出它的 job（url 由 job id 派生，两者必须一致）。
    assert.equal(image.url, `https://cdn.test/${image.task_id}.png`);
  }
  assert.equal(payload.task_id, payload.images[0].task_id);

  assert.equal(calls.filter(isLegacy).length, 0, "不得打 legacy 引擎");
  const submits = calls.filter(isSubmit);
  assert.equal(submits.length, 2);
  const keys = new Set(submits.map((c) => c.headers.get("idempotency-key")));
  assert.equal(keys.size, 2, "每张图一把独立幂等键");
  for (const submit of submits) {
    assert.equal(submit.headers.get("authorization"), "Bearer session-token-test");
    assert.equal(submit.headers.get("x-user-id"), "42");
    assert.deepEqual(submit.body, {
      prompt: "一只猫",
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

test("负面词＋角色参考图：durable multipart，prompt 预组 Avoid/Reference images，角色进 referenceMetadata", async () => {
  handler = (call) => (isSubmit(call) ? json({ success: true, data: projection("job-ref", "succeeded") }, 202) : json({}, 404));

  const res = await drive(
    POST(
      canvasRequest({
        prompt: "海边的女孩",
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
  assert.match(prompt, /Prompt:\n海边的女孩/);
  assert.match(prompt, /Reference images:\n- 小美 as character/);
  assert.match(prompt, /Avoid:\n多手指/);
  assert.deepEqual(JSON.parse(String(form.get("referenceMetadata"))), [{ name: "小美", role: "character" }]);
  assert.equal(form.getAll("referenceImages").length, 1);
  assert.equal(form.get("outputResolution"), "1k");
  assert.equal(form.get("modelId"), "gpt-image-2");
});

test("LoRA → 仍走 legacy（durable 无 adapter 消费 LoRA），不打 generation-jobs", async () => {
  handler = (call) => (isLegacy(call) ? json({ imageUrl: "https://cdn.test/legacy.png" }) : json({}, 404));
  const res = await drive(POST(canvasRequest({ prompt: "猫", model: "pixai-tsubaki2", loraModelVersionIds: ["lora-1"] })));
  assert.equal(res.status, 200);
  const payload = await res.json();
  assert.equal(payload.images[0].url, "https://cdn.test/legacy.png");
  // legacy 没有 durable job：不编造指针（逐张与顶层都是 null）。
  assert.equal(payload.images[0].task_id, null);
  assert.equal(payload.task_id, null);
  assert.equal(calls.filter(isSubmit).length, 0);
  const legacy = calls.find(isLegacy)!;
  assert.deepEqual((legacy.body as { loraModelVersionIds: string[] }).loraModelVersionIds, ["lora-1"]);
});

test("模型不收参考图（adobe-firefly）＋带参考图 → 仍走 legacy", async () => {
  handler = (call) => (isLegacy(call) ? json({ imageUrl: "https://cdn.test/legacy.png" }) : json({}, 404));
  const res = await drive(POST(canvasRequest({ prompt: "猫", model: "adobe-firefly", source_image: PNG_1X1 })));
  assert.equal(res.status, 200);
  assert.equal(calls.filter(isSubmit).length, 0);
  assert.equal(calls.filter(isLegacy).length, 1);
});

test("参考图格式 durable 不收（GIF）→ 仍走 legacy", async () => {
  handler = (call) => (isLegacy(call) ? json({ imageUrl: "https://cdn.test/legacy.png" }) : json({}, 404));
  const res = await drive(POST(canvasRequest({ prompt: "猫", model: "gpt-image-2", source_image: GIF_1X1 })));
  assert.equal(res.status, 200);
  assert.equal(calls.filter(isSubmit).length, 0);
  assert.equal(calls.filter(isLegacy).length, 1);
});

test("超时：任务一直 running → 504 generation_timeout，且不发 DELETE（不取消任务）", async () => {
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

test("轮询 502 视为瞬时继续问；任务失败回 502 generation_failed 带任务错误讯息", async () => {
  let pollCount = 0;
  handler = (call) => {
    if (isSubmit(call)) return json({ success: true, data: projection("job-x", "queued") }, 202);
    if (isPoll(call)) {
      pollCount += 1;
      if (pollCount === 1) return new Response("<html>bad gateway</html>", { status: 502 });
      return json(projection("job-x", "failed", { errorCode: "upstream_error", errorMessage: "上游拒绝此提示词" }));
    }
    return json({}, 404);
  };
  const res = await drive(POST(canvasRequest({ prompt: "x", model: "gpt-image-2" })));
  assert.equal(res.status, 502);
  const payload = await res.json();
  assert.equal(payload.code, "generation_failed");
  assert.equal(payload.error, "上游拒绝此提示词");
  assert.equal(pollCount, 2);
});

test("部分成功：一张成功一张提交被拒 → 回部分结果", async () => {
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

// ───────────────────────── 风格一等 id（P1-8／对称差 D34）

test("风格：合法 style_id → 送上游的 prompt 已素材化（含风格实文、无 {prompt}），回应明示 style_id/source", async () => {
  handler = (call) => {
    if (isSubmit(call)) return json({ success: true, data: projection("job-s", "queued") }, 202);
    if (isPoll(call)) return json(projection(call.url.split("/").pop()!, "succeeded"));
    return json({ error: "unexpected" }, 404);
  };
  const style = getStyleById(STYLE_ID)!;
  const styleText = style.prompt.split("{prompt}")[0].trim();
  const res = await drive(
    POST(canvasRequest({ prompt: "一台跑车", style_id: STYLE_ID, negative_prompt: "noisy" })),
  );
  assert.equal(res.status, 200);
  const payload = await res.json();
  assert.equal(payload.style_id, STYLE_ID);
  assert.equal(payload.style_source, "request");

  const submit = calls.find(isSubmit);
  assert.ok(submit, "应有一次 durable 提交");
  const sentPrompt = (submit!.body as { prompt: string }).prompt;
  assert.equal(sentPrompt.includes("{prompt}"), false, "占位符不得漏到上游");
  assert.equal(sentPrompt.includes(styleText), true, "风格的固定实文必须进 prompt");
  assert.equal(sentPrompt.includes("一台跑车"), true, "用户提示词仍必须在");
  // 风格 negative 与用户 "noisy"（风格 negative 的子字串）⇒ 依轮子语义收敛，不重复堆叠。
  assert.equal(sentPrompt.split("noisy").length - 1, 1, "重复堆叠会让同一片段出现两次");
});

test("风格：未知 style_id → 400 style_id_unknown，且完全不碰下游（不烧钱）", async () => {
  const res = await drive(POST(canvasRequest({ prompt: "x", style_id: "不存在的风格" })));
  assert.equal(res.status, 400);
  const payload = await res.json();
  assert.equal(payload.code, "style_id_unknown");
  assert.equal(calls.length, 0, "值域把关必须发生在任何下游请求之前");
});

test("风格：不带 style_id → 不吐风格键（回应形状与旧版逐位一致）", async () => {
  handler = (call) => {
    if (isSubmit(call)) return json({ success: true, data: projection("job-n", "queued") }, 202);
    if (isPoll(call)) return json(projection(call.url.split("/").pop()!, "succeeded"));
    return json({ error: "unexpected" }, 404);
  };
  const res = await drive(POST(canvasRequest({ prompt: "一台跑车" })));
  const payload = await res.json();
  assert.equal("style_id" in payload, false);
  assert.equal("style_source" in payload, false);
  const submit = calls.find(isSubmit)!;
  assert.equal((submit.body as { prompt: string }).prompt, "一台跑车", "无风格 ⇒ prompt 逐位不变");
});
