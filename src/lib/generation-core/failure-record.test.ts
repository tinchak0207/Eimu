import assert from "node:assert/strict";
import test from "node:test";

import { classifySupplierFailure, explainFailure, humanMessageForFailureClass } from "./failure-classifier.ts";
import {
  attachExplanation,
  captureNativeFailure,
  createFailureRecord,
  FAILURE_RECORD_VERSION,
  parseFailureRecord,
  serializeFailureRecord,
} from "./failure-record.ts";

/**
 * FG-01 驗收：合成一個含巢狀 cause + requestId 的上游錯誤，逐欄位（含遞迴層）
 * 斷言原生欄位被逐字保留。oracle = 測試自己手工構造的上游錯誤物件（獨立於被測實現）。
 */
function syntheticUpstreamError() {
  const innermost = Object.assign(new Error("ECONNRESET while reading upstream body"), {
    code: "ECONNRESET",
    status: 502,
  });
  const middle = Object.assign(new Error("adobe2api relay failed"), {
    code: 1008,
    statusCode: 503,
    request_id: "req-mid-777",
    details: { attempt: 2, upstream: "firefly" },
    cause: innermost,
  });
  const outer = Object.assign(new Error("upstream rejected: content policy"), {
    name: "SupplierRequestError",
    code: "1008",
    status: 451,
    requestId: "req-abc-123",
    metadata: { provider: "adobe2firefly", retryAfter: 17, tags: ["legal", "moderation"] },
    responseBody: '{"error":{"code":"1008","message":"legal_error"}}',
    cause: middle,
  });
  return { outer, middle, innermost };
}

test("FG-01：原生欄位逐字保留，cause 遞迴到最內層", () => {
  const { outer, middle, innermost } = syntheticUpstreamError();
  const native = captureNativeFailure(outer);

  assert.deepEqual(native, {
    name: "SupplierRequestError",
    message: "upstream rejected: content policy",
    code: "1008",
    status: 451,
    requestId: "req-abc-123",
    responseBody: '{"error":{"code":"1008","message":"legal_error"}}',
    metadata: { provider: "adobe2firefly", retryAfter: 17, tags: ["legal", "moderation"] },
    stack: outer.stack,
    cause: {
      name: "Error",
      message: "adobe2api relay failed",
      code: 1008,
      status: 503,
      requestId: "req-mid-777",
      responseBody: null,
      metadata: { attempt: 2, upstream: "firefly" },
      stack: middle.stack,
      cause: {
        name: "Error",
        message: "ECONNRESET while reading upstream body",
        code: "ECONNRESET",
        status: 502,
        requestId: null,
        responseBody: null,
        metadata: null,
        stack: innermost.stack,
        cause: null,
      },
    },
  });
  // 型別不合併：字串碼保持字串，數字碼保持數字（禁止 coerce 造成事實失真）。
  assert.equal(typeof native.code, "string");
  assert.equal(typeof native.cause?.code, "number");
});

test("FG-01：產品解釋寫入不改動原生欄位（同一物件、逐欄位等價）", () => {
  const { outer } = syntheticUpstreamError();
  const classified = classifySupplierFailure(outer);
  const record = createFailureRecord({ error: outer, explanation: explainFailure(classified) });

  const nativeBefore = structuredClone(record.native);
  const record2 = attachExplanation(record, explainFailure(classified));

  // 原生節點是同一個物件（不是複製品），且內容逐欄位等價（含遞迴層）。
  assert.equal(record2.native, record.native, "explanation 不得重建 native 物件");
  assert.deepEqual(record2.native, nativeBefore);
  assert.deepEqual(record.native, nativeBefore, "原 record 的原生欄位不得被改寫");

  // 產品的解釋只住在 explanation：原生 message 未被產品文案覆蓋。
  assert.equal(record2.explanation?.failureClass, "content_rejected");
  assert.equal(record2.explanation?.detail, "upstream rejected: content policy");
  assert.equal(record2.explanation?.humanMessage, humanMessageForFailureClass("content_rejected"));
  assert.notEqual(record2.explanation?.humanMessage, record2.native.message);
  assert.equal(record2.native.cause?.cause?.message, "ECONNRESET while reading upstream body");
});

test("FG-01 對抗性：迴圈 metadata 不得拋錯，且不得靜默丟欄位", () => {
  const metadata: Record<string, unknown> = { provider: "adobe2firefly" };
  metadata.self = metadata;
  metadata.when = new Date("2026-09-23T00:00:00.000Z");
  const error = Object.assign(new Error("upstream blew up"), { code: "X-1", metadata });

  const native = captureNativeFailure(error);
  assert.equal(native.code, "X-1");
  assert.equal(native.message, "upstream blew up");
  // 可序列化的欄位原樣保留。
  assert.equal(native.metadata?.provider, "adobe2firefly");
  // 不可序列化的欄位以可辨識字串代替，不是消失。
  assert.equal(native.metadata?.self, "[unserializable:object]");
  assert.equal(typeof native.metadata?.when, "string");
  // 整個記錄仍可序列化（落 jsonb 不會炸）。
  assert.ok(serializeFailureRecord(createFailureRecord({ error })).length > 0);
});

test("FG-01：序列化 → 解析逐欄位等價（含遞迴層），且版本閘可辨識地拒絕未知版本", () => {
  const { outer } = syntheticUpstreamError();
  const record = createFailureRecord({ error: outer, explanation: explainFailure(classifySupplierFailure(outer)) });

  const parsed = parseFailureRecord(serializeFailureRecord(record));
  assert.equal(parsed.ok, true);
  assert.ok(parsed.ok);
  assert.deepEqual(parsed.record, record);
  assert.equal(parsed.record.version, FAILURE_RECORD_VERSION);
  assert.equal(parsed.record.native.cause?.cause?.code, "ECONNRESET");

  const bumped = parseFailureRecord(JSON.stringify({ ...record, version: FAILURE_RECORD_VERSION + 1 }));
  assert.equal(bumped.ok, false);
  assert.ok(!bumped.ok);
  assert.equal(bumped.reason, "unsupported_version");
  assert.equal(bumped.version, FAILURE_RECORD_VERSION + 1);

  const garbage = parseFailureRecord("not json at all");
  assert.ok(!garbage.ok);
  assert.equal(garbage.reason, "malformed");

  const missing = parseFailureRecord(null);
  assert.ok(!missing.ok);
  assert.equal(missing.reason, "missing");
});

test("FG-01 對抗性：迴圈 cause 不得無限遞迴或拋錯（且深度有上限）", () => {
  const looped = Object.assign(new Error("self referencing failure"), { code: "LOOP" });
  (looped as unknown as { cause: unknown }).cause = looped;

  const native = captureNativeFailure(looped);
  assert.equal(native.code, "LOOP");
  assert.equal(native.cause?.message, "[circular cause]");

  // 深度上限：12 層 cause 不會被全部展開（避免打爆 jsonb 與日誌）。
  let deep: Error = new Error("level-0");
  for (let index = 1; index <= 12; index += 1) {
    deep = Object.assign(new Error(`level-${index}`), { cause: deep });
  }
  let depth = 0;
  let cursor: ReturnType<typeof captureNativeFailure> | null = captureNativeFailure(deep);
  while (cursor) {
    depth += 1;
    cursor = cursor.cause ?? null;
  }
  assert.ok(depth <= 10, `cause 展開深度應被限制，實際 ${depth}`);
  assert.ok(depth >= 2);
});
