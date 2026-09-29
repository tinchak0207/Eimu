// `POST /openai/v1/images/generations` 的**真行為斷言**（不是源碼字串守門件）。
//
// 驗的是「分發管道真正會解析的那幾個欄位」：一次 POST 同步回 200、`created` 是秒級整數、
// `data[0].url` 是字串、`response_format` 預設 url；要 b64 時由服務端取件編碼；失敗回
// OpenAI 錯誤信封且訊息帶 task id；超時回 504 且任務仍在後台（輪詢過）。
//
// 沒有 `openai` npm 套件（`npm ls openai` = empty），且紅線禁止為本片新增依賴 →
// 用 fetch + 逐欄斷言驗 OpenAI 形狀（形狀字面量抄自 OpenAI Images API 契約，獨立於本實現）。
//
// 上游一律替身（src/lib/openai-compat/upstream-stub.ts）：零外網、零付費調用。
import test from "node:test";
import assert from "node:assert/strict";
import { NextRequest } from "next/server";

import {
  ARTIFACT_URL,
  AUTH_HEADER,
  PNG_BYTES,
  PLACEHOLDER_BIZ_KEY,
  TASK_ID,
  clearCompatEnv,
  installUpstreamStub,
  resetCompatEnv,
  restoreFetch,
} from "@/lib/openai-compat/upstream-stub";
import { POST } from "./route";

const SUCCEEDED = {
  object: "image_generation.task",
  id: TASK_ID,
  status: "succeeded",
  data: [{ id: "art-1", url: ARTIFACT_URL, mimeType: "image/png" }],
};

function req(body: unknown, headers: Record<string, string> = {}): NextRequest {
  const head = new Headers({ authorization: AUTH_HEADER, "content-type": "application/json", ...headers });
  return new NextRequest("http://localhost/openai/v1/images/generations", {
    method: "POST",
    headers: head,
    body: JSON.stringify(body),
  });
}

test.beforeEach(() => {
  resetCompatEnv();
});

test.afterEach(() => {
  restoreFetch();
});

test.after(() => {
  clearCompatEnv();
});

test("默认 response_format=url：200 + {created, data:[{url}]}，并同步等到任务完成", async () => {
  const calls = installUpstreamStub({ taskSnapshots: [{ status: "queued" }, { status: "running" }, SUCCEEDED] });
  const before = Math.floor(Date.now() / 1000);

  const response = await POST(req({ model: "gpt-image-2", prompt: "一只戴墨镜的猫", size: "1024x1024" }));
  const body = (await response.json()) as Record<string, unknown>;

  assert.equal(response.status, 200, "OpenAI Images 语义是单次 POST 同步 200，不是 202");
  assert.ok(typeof body.created === "number" && Number.isInteger(body.created), "created 必须是秒级整数");
  assert.ok((body.created as number) >= before - 1, "created 必须是本次请求的时间");
  const data = body.data as Array<Record<string, unknown>>;
  assert.ok(Array.isArray(data) && data.length === 1, "data 必须是与 n 对齐的数组");
  assert.equal(typeof data[0].url, "string");
  assert.equal(data[0].url, ARTIFACT_URL);
  assert.ok(!("b64_json" in data[0]), "url 模式不得回 b64_json");
  assert.ok(!("error" in body));
  assert.equal(typeof response.headers.get("x-request-id"), "string", "trace id 必须落进 X-Request-Id");

  // 提交给站内入口的 payload：与 /v1 语义一致，且声明交付形式为 url
  assert.equal(calls.submits.length, 1);
  const submit = calls.submits[0];
  assert.equal(submit.headers.authorization, AUTH_HEADER, "biz key 必须透传给站内入口（两边通用）");
  assert.equal(submit.body.model, "gpt-image-2");
  assert.equal(submit.body.prompt, "一只戴墨镜的猫");
  assert.equal(submit.body.n, 1);
  assert.equal(submit.body.size, "1024x1024");
  assert.equal(submit.body.response_format, "url");
  assert.ok(calls.polls >= 2, "必须轮询任务直到 succeeded");
});

test("response_format=b64_json：服务端取回 artifact 再编码，bytes 逐位元相等", async () => {
  const calls = installUpstreamStub({ taskSnapshots: [SUCCEEDED] });

  const response = await POST(req({ model: "gpt-image-2", prompt: "海边的灯塔", response_format: "b64_json" }));
  const body = (await response.json()) as { data: Array<Record<string, unknown>> };

  assert.equal(response.status, 200);
  const encoded = body.data[0].b64_json;
  assert.equal(typeof encoded, "string");
  assert.ok(!("url" in body.data[0]), "b64 模式不得回 url");
  assert.deepEqual(Buffer.from(encoded as string, "base64"), Buffer.from(PNG_BYTES), "b64 必须就是产物位元组");
  assert.ok(calls.artifactFetches >= 1, "b64 必须由服务端真的取件，不是凭空编");
});

test("上游拒单：状态码与 error{message,type,code} 原样透传，不重新分类", async () => {
  installUpstreamStub({
    submitStatus: 402,
    submitError: {
      error: {
        message: "余额不足，本次未扣费。充值：https://eimu.dev/pricing",
        type: "insufficient_balance",
        code: "insufficient_balance",
        param: null,
        trace_id: "trace-upstream",
      },
    },
    taskSnapshots: [SUCCEEDED],
  });

  const response = await POST(req({ model: "gpt-image-2", prompt: "x" }));
  const body = (await response.json()) as { error: Record<string, unknown> };

  assert.equal(response.status, 402);
  assert.equal(body.error.code, "insufficient_balance");
  assert.equal(body.error.type, "insufficient_balance");
  assert.match(String(body.error.message), /余额不足/);
  assert.equal(body.error.param, null, "OpenAI 信封的 param 字段必须在");
  assert.equal(typeof body.error.trace_id, "string");
});

test("任务失败：502 + error.message 带 task id（未出图＝未扣费）", async () => {
  const calls = installUpstreamStub({
    taskSnapshots: [{ status: "failed", error: { code: "overloaded", message: "所有上游额度打满" } }],
  });

  const response = await POST(req({ model: "gpt-image-2", prompt: "x" }));
  const body = (await response.json()) as { error: Record<string, unknown> };

  assert.equal(response.status, 502);
  assert.equal(body.error.type, "api_error");
  assert.equal(body.error.code, "overloaded", "上游稳定码（failureClass）必须透传，不泛化成一句 generation_failed");
  assert.match(String(body.error.message), new RegExp(TASK_ID), "失败必须让客户拿得到 task id");
  assert.match(String(body.error.message), /未扣费/);
  assert.equal(calls.polls, 1, "终态只读一次");
});

test("等待超时：504，error.message 附 task id，任务仍在后台（未被取消）", async () => {
  process.env.OPENAI_COMPAT_MAX_WAIT_MS = "30";
  const calls = installUpstreamStub({ taskSnapshots: [{ status: "running" }] });

  const response = await POST(req({ model: "gpt-image-2", prompt: "x" }));
  const body = (await response.json()) as { error: Record<string, unknown> };

  assert.equal(response.status, 504);
  assert.equal(body.error.code, "generation_timeout");
  assert.match(String(body.error.message), new RegExp(TASK_ID));
  assert.ok(calls.polls >= 1, "超时前必须真的轮询过");
  assert.equal(calls.submits.length, 1, "超时不重提交（任务在后台继续跑）");
});

test("非生图模型：400 model_not_supported，且不碰上游", async () => {
  const calls = installUpstreamStub({ taskSnapshots: [SUCCEEDED] });

  const response = await POST(req({ model: "dall-e-3", prompt: "x" }));
  const body = (await response.json()) as { error: Record<string, unknown> };

  assert.equal(response.status, 400);
  assert.equal(body.error.code, "model_not_supported");
  assert.equal(calls.submits.length, 0, "模型闸必须在提交之前");
});

test("无认证：401 authentication_error（占位 key 也先过闸）", async () => {
  installUpstreamStub({ taskSnapshots: [SUCCEEDED] });
  const head = new Headers({ "content-type": "application/json" });
  const response = await POST(
    new NextRequest("http://localhost/openai/v1/images/generations", {
      method: "POST",
      headers: head,
      body: JSON.stringify({ model: "gpt-image-2", prompt: "x" }),
    }),
  );
  const body = (await response.json()) as { error: Record<string, unknown> };
  assert.equal(response.status, 401);
  assert.equal(body.error.type, "authentication_error");
});

test("prompt 缺失：400 missing_prompt", async () => {
  installUpstreamStub({ taskSnapshots: [SUCCEEDED] });
  const response = await POST(req({ model: "gpt-image-2" }));
  const body = (await response.json()) as { error: Record<string, unknown> };
  assert.equal(response.status, 400);
  assert.equal(body.error.code, "missing_prompt");
});

test("占位 key 不得泄漏进响应体（卫生）", async () => {
  installUpstreamStub({ taskSnapshots: [SUCCEEDED] });
  const response = await POST(req({ model: "nope", prompt: "x" }));
  const text = await response.text();
  assert.ok(!text.includes(PLACEHOLDER_BIZ_KEY.slice(0, 20)), "响应体不得回显 key");
});
