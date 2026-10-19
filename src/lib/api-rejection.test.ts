import test from "node:test";
import assert from "node:assert/strict";

import {
  API_REJECTION_KEY_PREFIX_CHARS,
  apiKeyPrefix,
  createApiRejectionRecorder,
  normalizeApiRejection,
  rejectionReasonFromResponse,
  withApiRejectionTelemetry,
  type ApiRejectionRecord,
} from "./api-rejection.ts";

// ─────────────────────────────────────────── 测试替身

function collectingStore() {
  const rows: ApiRejectionRecord[] = [];
  return {
    rows,
    store: {
      async insert(row: ApiRejectionRecord) {
        rows.push(row);
      },
    },
  };
}

/** 一把形状正确的 B 端密钥：前缀 + 32 位十六进制。 */
const FULL_KEY = "sk-biz-7f3a9c1d2e4b5a6f7c8d9e0f1a2b3c4d";

// ─────────────────────────────────────────── 核心验收：401／402／400 各一行

test("拒绝记录器对 401、402、400 各写一行，reason 为各自的稳定码", async () => {
  const { rows, store } = collectingStore();
  const record = createApiRejectionRecorder(store);

  record({ rawKey: null, path: "/v1/images/generations", status: 401, reason: "missing_api_key" });
  record({ userId: 42, rawKey: FULL_KEY, path: "/v1/images/generations", model: "gpt-image-2", status: 402, reason: "insufficient_quota" });
  record({ userId: 42, rawKey: FULL_KEY, path: "/v1/images/edits", model: "gpt-image-2", status: 400, reason: "missing_prompt" });

  // 记录是 fire-and-forget 的，等微任务伫列排空再断言。
  await new Promise((resolve) => setImmediate(resolve));

  assert.equal(rows.length, 3, "三个非 2xx 出口各一行");
  assert.deepEqual(
    rows.map((row) => row.status),
    [401, 402, 400],
  );
  assert.deepEqual(
    rows.map((row) => row.reason),
    ["missing_api_key", "insufficient_quota", "missing_prompt"],
  );
  assert.deepEqual(
    rows.map((row) => row.model),
    [null, "gpt-image-2", "gpt-image-2"],
  );
  assert.deepEqual(
    rows.map((row) => row.userId),
    [null, 42, 42],
  );
});

test("任何栏位都不含完整 key，key_prefix 只有前 8 位", async () => {
  const { rows, store } = collectingStore();
  const record = createApiRejectionRecorder(store);

  record({ rawKey: FULL_KEY, path: "/v1/models", status: 401, reason: "invalid_api_key" });
  await new Promise((resolve) => setImmediate(resolve));

  assert.equal(rows.length, 1);
  assert.equal(rows[0].keyPrefix, FULL_KEY.slice(0, API_REJECTION_KEY_PREFIX_CHARS));
  assert.equal(rows[0].keyPrefix, "sk-biz-7");

  const serialized = JSON.stringify(rows);
  assert.ok(!serialized.includes(FULL_KEY), "整行序列化后不得出现完整密钥");
  assert.ok(!serialized.includes(FULL_KEY.slice(API_REJECTION_KEY_PREFIX_CHARS)), "前缀之后的随机段一律不落地");
  assert.equal(rows[0].path, "/v1/models");
});

test("payload 只有审计栏位，不会夹带 prompt 之类的请求内容", async () => {
  const { rows, store } = collectingStore();
  const record = createApiRejectionRecorder(store);

  // 呼叫端即使把整个请求物件塞进来（多余栏位），也只会取到审计栏位。
  const PROMPT = "a pink cat holding a lemon on the moon";
  record({
    userId: 7,
    rawKey: FULL_KEY,
    path: "/v1/images/generations",
    model: "gpt-image-2",
    status: 400,
    reason: "prompt_too_long",
    prompt: PROMPT,
    body: { prompt: PROMPT },
  } as Parameters<typeof record>[0]);
  await new Promise((resolve) => setImmediate(resolve));

  assert.deepEqual(Object.keys(rows[0]).sort(), ["keyPrefix", "model", "path", "reason", "status", "userId"]);
  assert.ok(!JSON.stringify(rows[0]).includes("pink cat"), "prompt 内容不落地");
});

// ─────────────────────────────────────────── 静默：写入失败不得影响请求

test("储存层拒绝时记录器不 throw，也不留下未处理的 rejection", async () => {
  const failures: unknown[] = [];
  const record = createApiRejectionRecorder({
    async insert() {
      throw new Error("database is down");
    },
  });

  assert.doesNotThrow(() => record({ rawKey: FULL_KEY, path: "/v1/models", status: 401, reason: "invalid_api_key" }));

  // 储存层的 promise 已被捕获，这里不会冒出 unhandledRejection。
  process.on("unhandledRejection", (reason) => failures.push(reason));
  await new Promise((resolve) => setTimeout(resolve, 20));
  assert.deepEqual(failures, []);
});

test("储存层慢时记录器立即返回（遥测不占请求的 RTT）", () => {
  let released: (() => void) | null = null;
  const record = createApiRejectionRecorder({
    insert() {
      return new Promise<void>((resolve) => {
        released = resolve;
      });
    },
  });

  const started = Date.now();
  record({ rawKey: FULL_KEY, path: "/v1/models", status: 429, reason: "rate_limit_exceeded" });
  assert.ok(Date.now() - started < 50, "呼叫端不该等储存层");
  assert.ok(released, "写入已发出但被搁置");
  released!();
});

test("形状不合法的输入不落地", async () => {
  const { rows, store } = collectingStore();
  const record = createApiRejectionRecorder(store);

  record({ rawKey: FULL_KEY, path: "", status: 500, reason: "boom" });
  record({ rawKey: FULL_KEY, path: "/v1/models", status: 200.5, reason: "boom" });
  await new Promise((resolve) => setImmediate(resolve));

  assert.equal(rows.length, 0);
});

// ─────────────────────────────────────────── 正规化

test("apiKeyPrefix：只取前 8 位，缺 key 回 null", () => {
  assert.equal(apiKeyPrefix(FULL_KEY), "sk-biz-7");
  assert.equal(apiKeyPrefix("  sk-biz-abcdefgh  "), "sk-biz-a");
  assert.equal(apiKeyPrefix("short"), "short");
  assert.equal(apiKeyPrefix(null), null);
  assert.equal(apiKeyPrefix(undefined), null);
  assert.equal(apiKeyPrefix("   "), null);
});

test("normalizeApiRejection 去掉 query（可能带 token）与控制字元，并截断长栏位", () => {
  const row = normalizeApiRejection({
    userId: 0,
    rawKey: FULL_KEY,
    path: "/v1/images/generations?token=leaky#frag",
    model: "x".repeat(400),
    status: 400,
    reason: "bad\nreason",
  });

  assert.ok(row);
  assert.equal(row!.path, "/v1/images/generations");
  assert.equal(row!.model!.length, 128);
  assert.equal(row!.reason, "badreason");
  assert.equal(row!.userId, null, "userId 0 不是合法计费主体");
});

test("normalizeApiRejection 在缺 path 或 status 非整数时回 null", () => {
  assert.equal(normalizeApiRejection({ path: "  ", status: 400, reason: "x" }), null);
  assert.equal(normalizeApiRejection({ path: "/v1/models", status: Number.NaN, reason: "x" }), null);
});

test("reason 缺漏时落成 unknown，不写空字串", () => {
  const row = normalizeApiRejection({ path: "/v1/models", status: 401, reason: "  " });
  assert.equal(row!.reason, "unknown");
});

// ─────────────────────────────────────────── 出口拦截（真实 Response 物件）

/** 没装资料库时 recordApiRejection 是 no-op，所以拦截层的测试接上真正的记录器 + 收集器。 */
function collectingRecorder() {
  const { rows, store } = collectingStore();
  return { rows, record: createApiRejectionRecorder(store) };
}

function openAiError(status: number, code: string, message = "boom"): Response {
  return new Response(
    JSON.stringify({ error: { message, type: "invalid_request_error", code, param: null, trace_id: "t" } }),
    { status, headers: { "content-type": "application/json" } },
  );
}

test("拦截层对 401、402、400 的实际回应各记一行，reason 取自回应体的 code", async () => {
  const { rows, record } = collectingRecorder();
  const ctx = { rawKey: FULL_KEY, userId: 99, model: "gpt-image-2" };

  const statuses = [
    [401, "invalid_api_key"],
    [402, "insufficient_quota"],
    [400, "unsupported_size"],
  ] as const;

  for (const [status, code] of statuses) {
    const response = await withApiRejectionTelemetry("/v1/images/generations", ctx, async () => openAiError(status, code), record);
    // 拦截不得改变客户看到的回应。
    assert.equal(response.status, status);
    assert.equal((await response.json()).error.code, code);
  }

  await new Promise((resolve) => setImmediate(resolve));

  assert.equal(rows.length, 3);
  assert.deepEqual(rows.map((row) => row.status), [401, 402, 400]);
  assert.deepEqual(rows.map((row) => row.reason), ["invalid_api_key", "insufficient_quota", "unsupported_size"]);
  assert.deepEqual(rows.map((row) => row.path), ["/v1/images/generations", "/v1/images/generations", "/v1/images/generations"]);
  assert.deepEqual(rows.map((row) => row.userId), [99, 99, 99]);
  assert.ok(rows.every((row) => row.keyPrefix === FULL_KEY.slice(0, API_REJECTION_KEY_PREFIX_CHARS)));
  assert.ok(!JSON.stringify(rows).includes(FULL_KEY), "拦截层落地时也只留前 8 位");
});

test("拦截层不动成功回应与 202 任务提交", async () => {
  const { rows, record } = collectingRecorder();
  const ctx = { rawKey: null, userId: 1, model: null };

  const ok = await withApiRejectionTelemetry("/v1/models", ctx, async () => Response.json({ object: "list" }), record);
  const accepted = await withApiRejectionTelemetry(
    "/v1/images/generations",
    ctx,
    async () => Response.json({ id: "job_1" }, { status: 202 }),
    record,
  );

  assert.equal(ok.status, 200);
  assert.equal(accepted.status, 202);
  assert.deepEqual(rows, [], "成功路径不进拒绝表");
});

test("回应体不是 JSON 时 reason 退回 http_<status>，且仍记下这一行", async () => {
  const { rows, record } = collectingRecorder();
  const html = new Response("<html>502 bad gateway</html>", { status: 502, headers: { "content-type": "text/html" } });

  const response = await withApiRejectionTelemetry("/v1/images/{id}", { rawKey: null, userId: null, model: null }, async () => html, record);

  assert.equal(response.status, 502);
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(rows.length, 1);
  assert.equal(rows[0].reason, "http_502");
  assert.equal(await response.text(), "<html>502 bad gateway</html>", "原回应仍可读取");
});

test("rejectionReasonFromResponse 对无 code 的 JSON 也回兜底码", async () => {
  assert.equal(await rejectionReasonFromResponse(Response.json({ oops: true }, { status: 400 })), "http_400");
});