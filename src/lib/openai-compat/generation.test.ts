// `src/lib/openai-compat/generation.ts` 的**桥接行为断言**（纯单元，注入时钟与替身）。
//
// 验四件事：
//   ① 轮询只在「任务终态」或「截止时间」结束，瞬断（5xx/非 2xx）不得被当终态；
//   ② 截止时间到 → 回 unsettled（呼叫端才可能回 504，且任务未被取消）；
//   ③ 取件优先走既有 blob 后端，后端不可用才 fallback 到 HTTP（两条路都真的读到位元组）；
//   ④ 等待上限的环境旋钮不吃非法值（0/负/NaN 不得把等待变成 0）。
import test from "node:test";
import assert from "node:assert/strict";

import {
  MAX_WAIT_MS,
  artifactToBase64,
  awaitImageTask,
  resolveMaxWaitMs,
  submitImageTask,
  taskFailureToError,
  taskTimeoutError,
} from "./generation";

const ORIGIN = "https://site.test";
const AUTH = "Bearer sk-biz-placeholder";

test("轮询：瞬断不计终态，任务 succeeded 才收工", async () => {
  let polls = 0;
  const fetcher = (async (input: RequestInfo | URL) => {
    polls += 1;
    const url = String(input);
    if (url.endsWith("/api/v1/images/task-1")) {
      if (polls === 1) return new Response("boom", { status: 503 });
      if (polls === 2) return Response.json({ status: "running" });
      return Response.json({
        status: "succeeded",
        data: [{ id: "art-1", url: "https://cdn.test/a.png", mimeType: "image/png" }],
      });
    }
    return new Response("not found", { status: 404 });
  }) as typeof fetch;

  const result = await awaitImageTask({
    origin: ORIGIN,
    authorization: AUTH,
    taskId: "task-1",
    deadlineAt: 10_000,
    fetchImpl: fetcher,
    now: () => 0,
    sleep: async () => undefined,
  });

  assert.equal(result.settled, true);
  assert.equal(result.settled && result.outcome.status, "succeeded");
  assert.equal(result.settled && result.outcome.status === "succeeded" && result.outcome.artifacts[0].url, "https://cdn.test/a.png");
  assert.equal(polls, 3, "503 那次不得被当成终态");
});

test("轮询：截止时间到 → unsettled（任务仍在后台）", async () => {
  let clock = 0;
  let polls = 0;
  const fetcher = (async () => {
    polls += 1;
    return Response.json({ status: "running" });
  }) as typeof fetch;

  const result = await awaitImageTask({
    origin: ORIGIN,
    authorization: AUTH,
    taskId: "task-1",
    deadlineAt: 5_000,
    fetchImpl: fetcher,
    now: () => clock,
    sleep: async (ms) => {
      clock += ms;
    },
  });

  assert.deepEqual(result, { settled: false });
  assert.ok(polls >= 1, "超时前必须真的轮询过");
  assert.ok(clock >= 5_000, "必须真的等到截止时间，不能提前放弃");
});

test("提交：透传 biz key 与幂等键，回 task id", async () => {
  let seen: { url: string; init?: RequestInit } | null = null;
  const fetcher = (async (input: RequestInfo | URL, init?: RequestInit) => {
    seen = { url: String(input), init };
    return Response.json({ id: "task-9" }, { status: 202 });
  }) as typeof fetch;

  const result = await submitImageTask({
    origin: ORIGIN,
    authorization: AUTH,
    model: "gpt-image-2",
    prompt: "x",
    n: 2,
    size: "1024x1024",
    quality: "hd",
    idempotencyKey: "idem-1",
    fetchImpl: fetcher,
  });

  assert.deepEqual(result, { ok: true, taskId: "task-9" });
  assert.equal(seen?.url, `${ORIGIN}/api/v1/images/generations`);
  const headers = new Headers(seen?.init?.headers);
  assert.equal(headers.get("authorization"), AUTH);
  assert.equal(headers.get("idempotency-key"), "idem-1");
  assert.deepEqual(JSON.parse(String(seen?.init?.body)), {
    model: "gpt-image-2",
    prompt: "x",
    n: 2,
    size: "1024x1024",
    response_format: "url",
    quality: "hd",
  });
});

test("提交：上游 4xx 的三栏原样透传（不重新分类）", async () => {
  const fetcher = (async () =>
    Response.json(
      {
        error: {
          message: "不支持的模型 foo。可用模型请调用 GET /v1/models。",
          type: "invalid_request_error",
          code: "model_not_found",
          param: null,
          trace_id: "t",
        },
      },
      { status: 400 },
    )) as typeof fetch;

  const result = await submitImageTask({
    origin: ORIGIN,
    authorization: AUTH,
    model: "foo",
    prompt: "x",
    n: 1,
    size: "1024x1024",
    fetchImpl: fetcher,
  });

  assert.equal(result.ok, false);
  assert.equal(result.ok === false && result.error.code, "model_not_found");
  assert.equal(result.ok === false && result.error.status, 400);
  assert.equal(result.ok === false && result.error.type, "invalid_request_error");
});

test("提交：上游不可达 → 503 control_plane_unreachable（不说谎成成功）", async () => {
  const fetcher = (async () => {
    throw new Error("ECONNREFUSED");
  }) as typeof fetch;

  const result = await submitImageTask({
    origin: ORIGIN,
    authorization: AUTH,
    model: "gpt-image-2",
    prompt: "x",
    n: 1,
    size: "1024x1024",
    fetchImpl: fetcher,
  });

  assert.equal(result.ok, false);
  assert.equal(result.ok === false && result.error.status, 503);
  assert.equal(result.ok === false && result.error.code, "control_plane_unreachable");
});

const BYTES = new Uint8Array([1, 2, 3, 4, 5]);

test("取件：优先走既有 blob 后端（真的从 stream 里读到位元组）", async () => {
  let httpCalls = 0;
  const fetcher = (async () => {
    httpCalls += 1;
    return new Response(BYTES, { status: 200 });
  }) as typeof fetch;

  const b64 = await artifactToBase64("https://cdn.test/a.png", {
    fetchImpl: fetcher,
    blobGetImpl: async () => ({ statusCode: 200, stream: new Response(BYTES).body }),
  });

  assert.deepEqual(Buffer.from(b64, "base64"), Buffer.from(BYTES));
  assert.equal(httpCalls, 0, "blob 后端可用时不得再打一次 HTTP");
});

test("取件：blob 后端不可用（非 blob URL）→ fallback HTTP", async () => {
  let httpCalls = 0;
  const fetcher = (async () => {
    httpCalls += 1;
    return new Response(BYTES, { status: 200, headers: { "content-type": "image/png" } });
  }) as typeof fetch;

  const b64 = await artifactToBase64("https://upstream.example/x.png", {
    fetchImpl: fetcher,
    blobGetImpl: async () => {
      throw new Error("not a blob url");
    },
  });

  assert.deepEqual(Buffer.from(b64, "base64"), Buffer.from(BYTES));
  assert.equal(httpCalls, 1);
});

test("取件失败：抛错（呼叫端才可能诚实回 502，不是回空 b64）", async () => {
  await assert.rejects(
    () =>
      artifactToBase64("https://upstream.example/x.png", {
        fetchImpl: (async () => new Response("nope", { status: 404 })) as typeof fetch,
        blobGetImpl: async () => null,
      }),
    /404/,
  );
});

test("错误映射：终态带 task id 与「未扣费」；超时码是 generation_timeout", () => {
  const failed = taskFailureToError({ status: "failed", message: "上游全挂", code: "overloaded" }, "task-1");
  assert.equal(failed.status, 502);
  assert.equal(failed.code, "overloaded");
  assert.match(failed.message, /task-1/);
  assert.match(failed.message, /未扣费/);

  const cancelled = taskFailureToError({ status: "cancelled", message: "已取消", code: "" }, "task-2");
  assert.equal(cancelled.status, 400);
  assert.equal(cancelled.code, "generation_cancelled");

  const timeout = taskTimeoutError("task-3");
  assert.equal(timeout.status, 504);
  assert.equal(timeout.code, "generation_timeout");
  assert.match(timeout.message, /task-3/);
});

test("等待上限旋钮：非法值一律忽略，正当值生效", () => {
  assert.equal(resolveMaxWaitMs({}), MAX_WAIT_MS);
  assert.equal(resolveMaxWaitMs({ OPENAI_COMPAT_MAX_WAIT_MS: "0" }), MAX_WAIT_MS);
  assert.equal(resolveMaxWaitMs({ OPENAI_COMPAT_MAX_WAIT_MS: "-5" }), MAX_WAIT_MS);
  assert.equal(resolveMaxWaitMs({ OPENAI_COMPAT_MAX_WAIT_MS: "abc" }), MAX_WAIT_MS);
  assert.equal(resolveMaxWaitMs({ OPENAI_COMPAT_MAX_WAIT_MS: "45000" }), 45_000);
});
