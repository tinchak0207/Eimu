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

// ─────────────────────────────────────────── 測試替身

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

/** 一把形狀正確的 B 端密鑰：前綴 + 32 位十六進制。 */
const FULL_KEY = "sk-biz-7f3a9c1d2e4b5a6f7c8d9e0f1a2b3c4d";

// ─────────────────────────────────────────── 核心驗收：401／402／400 各一行

test("拒絕記錄器對 401、402、400 各寫一行，reason 為各自的穩定碼", async () => {
  const { rows, store } = collectingStore();
  const record = createApiRejectionRecorder(store);

  record({ rawKey: null, path: "/v1/images/generations", status: 401, reason: "missing_api_key" });
  record({ userId: 42, rawKey: FULL_KEY, path: "/v1/images/generations", model: "gpt-image-2", status: 402, reason: "insufficient_quota" });
  record({ userId: 42, rawKey: FULL_KEY, path: "/v1/images/edits", model: "gpt-image-2", status: 400, reason: "missing_prompt" });

  // 記錄是 fire-and-forget 的，等微任務佇列排空再斷言。
  await new Promise((resolve) => setImmediate(resolve));

  assert.equal(rows.length, 3, "三個非 2xx 出口各一行");
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

test("任何欄位都不含完整 key，key_prefix 只有前 8 位", async () => {
  const { rows, store } = collectingStore();
  const record = createApiRejectionRecorder(store);

  record({ rawKey: FULL_KEY, path: "/v1/models", status: 401, reason: "invalid_api_key" });
  await new Promise((resolve) => setImmediate(resolve));

  assert.equal(rows.length, 1);
  assert.equal(rows[0].keyPrefix, FULL_KEY.slice(0, API_REJECTION_KEY_PREFIX_CHARS));
  assert.equal(rows[0].keyPrefix, "sk-biz-7");

  const serialized = JSON.stringify(rows);
  assert.ok(!serialized.includes(FULL_KEY), "整行序列化後不得出現完整密鑰");
  assert.ok(!serialized.includes(FULL_KEY.slice(API_REJECTION_KEY_PREFIX_CHARS)), "前綴之後的隨機段一律不落地");
  assert.equal(rows[0].path, "/v1/models");
});

test("payload 只有審計欄位，不會夾帶 prompt 之類的請求內容", async () => {
  const { rows, store } = collectingStore();
  const record = createApiRejectionRecorder(store);

  // 呼叫端即使把整個請求物件塞進來（多餘欄位），也只會取到審計欄位。
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
  assert.ok(!JSON.stringify(rows[0]).includes("pink cat"), "prompt 內容不落地");
});

// ─────────────────────────────────────────── 靜默：寫入失敗不得影響請求

test("儲存層拒絕時記錄器不 throw，也不留下未處理的 rejection", async () => {
  const failures: unknown[] = [];
  const record = createApiRejectionRecorder({
    async insert() {
      throw new Error("database is down");
    },
  });

  assert.doesNotThrow(() => record({ rawKey: FULL_KEY, path: "/v1/models", status: 401, reason: "invalid_api_key" }));

  // 儲存層的 promise 已被捕獲，這裡不會冒出 unhandledRejection。
  process.on("unhandledRejection", (reason) => failures.push(reason));
  await new Promise((resolve) => setTimeout(resolve, 20));
  assert.deepEqual(failures, []);
});

test("儲存層慢時記錄器立即返回（遙測不佔請求的 RTT）", () => {
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
  assert.ok(Date.now() - started < 50, "呼叫端不該等儲存層");
  assert.ok(released, "寫入已發出但被擱置");
  released!();
});

test("形狀不合法的輸入不落地", async () => {
  const { rows, store } = collectingStore();
  const record = createApiRejectionRecorder(store);

  record({ rawKey: FULL_KEY, path: "", status: 500, reason: "boom" });
  record({ rawKey: FULL_KEY, path: "/v1/models", status: 200.5, reason: "boom" });
  await new Promise((resolve) => setImmediate(resolve));

  assert.equal(rows.length, 0);
});

// ─────────────────────────────────────────── 正規化

test("apiKeyPrefix：只取前 8 位，缺 key 回 null", () => {
  assert.equal(apiKeyPrefix(FULL_KEY), "sk-biz-7");
  assert.equal(apiKeyPrefix("  sk-biz-abcdefgh  "), "sk-biz-a");
  assert.equal(apiKeyPrefix("short"), "short");
  assert.equal(apiKeyPrefix(null), null);
  assert.equal(apiKeyPrefix(undefined), null);
  assert.equal(apiKeyPrefix("   "), null);
});

test("normalizeApiRejection 去掉 query（可能帶 token）與控制字元，並截斷長欄位", () => {
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
  assert.equal(row!.userId, null, "userId 0 不是合法計費主體");
});

test("normalizeApiRejection 在缺 path 或 status 非整數時回 null", () => {
  assert.equal(normalizeApiRejection({ path: "  ", status: 400, reason: "x" }), null);
  assert.equal(normalizeApiRejection({ path: "/v1/models", status: Number.NaN, reason: "x" }), null);
});

test("reason 缺漏時落成 unknown，不寫空字串", () => {
  const row = normalizeApiRejection({ path: "/v1/models", status: 401, reason: "  " });
  assert.equal(row!.reason, "unknown");
});

// ─────────────────────────────────────────── 出口攔截（真實 Response 物件）

/** 沒裝資料庫時 recordApiRejection 是 no-op，所以攔截層的測試接上真正的記錄器 + 收集器。 */
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

test("攔截層對 401、402、400 的實際回應各記一行，reason 取自回應體的 code", async () => {
  const { rows, record } = collectingRecorder();
  const ctx = { rawKey: FULL_KEY, userId: 99, model: "gpt-image-2" };

  const statuses = [
    [401, "invalid_api_key"],
    [402, "insufficient_quota"],
    [400, "unsupported_size"],
  ] as const;

  for (const [status, code] of statuses) {
    const response = await withApiRejectionTelemetry("/v1/images/generations", ctx, async () => openAiError(status, code), record);
    // 攔截不得改變客戶看到的回應。
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
  assert.ok(!JSON.stringify(rows).includes(FULL_KEY), "攔截層落地時也只留前 8 位");
});

test("攔截層不動成功回應與 202 任務提交", async () => {
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
  assert.deepEqual(rows, [], "成功路徑不進拒絕表");
});

test("回應體不是 JSON 時 reason 退回 http_<status>，且仍記下這一行", async () => {
  const { rows, record } = collectingRecorder();
  const html = new Response("<html>502 bad gateway</html>", { status: 502, headers: { "content-type": "text/html" } });

  const response = await withApiRejectionTelemetry("/v1/images/{id}", { rawKey: null, userId: null, model: null }, async () => html, record);

  assert.equal(response.status, 502);
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(rows.length, 1);
  assert.equal(rows[0].reason, "http_502");
  assert.equal(await response.text(), "<html>502 bad gateway</html>", "原回應仍可讀取");
});

test("rejectionReasonFromResponse 對無 code 的 JSON 也回兜底碼", async () => {
  assert.equal(await rejectionReasonFromResponse(Response.json({ oops: true }, { status: 400 })), "http_400");
});