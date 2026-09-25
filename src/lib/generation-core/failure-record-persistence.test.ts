import assert from "node:assert/strict";
import test from "node:test";

import type { GenerationSql } from "./database.ts";
import { classifySupplierFailure, explainFailure } from "./failure-classifier.ts";
import { createFailureRecord, type FailureRecord } from "./failure-record.ts";
import {
  failGenerationAttempt,
  failGenerationJob,
  listGenerationAttemptsForJob,
  mapFailureRecordColumn,
} from "./job-repository.ts";

type Call = { sql: string; values: unknown[] };

function recordingMock(respond?: (sql: string) => unknown[]) {
  const calls: Call[] = [];
  const tagged = (async (strings: TemplateStringsArray, ...values: unknown[]) => {
    const sql = strings.join(" ");
    calls.push({ sql, values });
    return respond?.(sql) ?? [];
  }) as unknown as GenerationSql;
  (tagged as unknown as { begin: (cb: (tx: GenerationSql) => Promise<unknown>) => Promise<unknown> }).begin =
    (cb) => cb(tagged);
  return { sql: tagged, calls };
}

/** 合成上游錯誤：巢狀 cause（三層）+ requestId + metadata + 原生 code/status。 */
function syntheticUpstreamError() {
  const innermost = Object.assign(new Error("ECONNRESET while reading upstream body"), {
    code: "ECONNRESET",
    status: 502,
  });
  const middle = Object.assign(new Error("adobe2api relay failed"), {
    code: 1008,
    status: 503,
    request_id: "req-mid-777",
    cause: innermost,
  });
  return Object.assign(new Error("upstream rejected: content policy"), {
    name: "SupplierRequestError",
    code: "1008",
    status: 451,
    requestId: "req-abc-123",
    metadata: { provider: "adobe2firefly", retryAfter: 17 },
    cause: middle,
  });
}

/** 手工寫出的期望原生值（oracle 來自測試自己的合成錯誤，不來自被測實現）。 */
function expectedNative(stack: string | undefined, middleStack: string | undefined, innerStack: string | undefined) {
  return {
    name: "SupplierRequestError",
    message: "upstream rejected: content policy",
    code: "1008",
    status: 451,
    requestId: "req-abc-123",
    metadata: { provider: "adobe2firefly", retryAfter: 17 },
    responseBody: null,
    stack,
    cause: {
      name: "Error",
      message: "adobe2api relay failed",
      code: 1008,
      status: 503,
      requestId: "req-mid-777",
      metadata: null,
      responseBody: null,
      stack: middleStack,
      cause: {
        name: "Error",
        message: "ECONNRESET while reading upstream body",
        code: "ECONNRESET",
        status: 502,
        requestId: null,
        metadata: null,
        responseBody: null,
        stack: innerStack,
        cause: null,
      },
    },
  };
}

function decodeWrittenFailureRecord(calls: Call[], table: string): FailureRecord {
  const update = calls.find((call) => call.sql.includes(`UPDATE ${table}`));
  assert.ok(update, `應有 ${table} 的 UPDATE`);
  const written = update.values.find(
    (value): value is FailureRecord => Boolean(value) && typeof value === "object" && "native" in (value as object),
  );
  assert.ok(written, `${table} UPDATE 應帶入 failure_record_json`);
  return written;
}

test("FG-01：失敗記錄落 attempt 後逐欄位等價（含巢狀 cause 遞迴層）", async () => {
  const error = syntheticUpstreamError();
  const failure = classifySupplierFailure(error);
  const record = createFailureRecord({ error, explanation: explainFailure(failure) });

  const { sql, calls } = recordingMock(() => []);
  await failGenerationAttempt({
    jobId: "job-1",
    workerId: "worker-a",
    attemptId: "attempt-1",
    failureClass: failure.failureClass,
    failureDetail: failure.detail,
    failureRecord: record,
    providerHttpStatus: failure.httpStatus,
    latencyMs: 12,
  }, sql);

  const written = decodeWrittenFailureRecord(calls, "generation_attempt");
  const innerCause = (error as unknown as { cause: { cause: Error } }).cause.cause;
  const middleCause = (error as unknown as { cause: Error }).cause;
  assert.deepEqual(
    written.native,
    expectedNative(error.stack, middleCause.stack, innerCause.stack),
    "寫入的原生欄位必須逐欄位等價（含三層 cause）",
  );
  assert.equal(written.version, 1);
  assert.equal(typeof written.capturedAt, "string");

  // 帳本路徑不受影響：UPDATE 仍吃未改寫的錯誤原文（產品欄位與原生分欄）。
  const update = calls.find((call) => call.sql.includes("UPDATE generation_attempt"));
  assert.ok(update?.values.includes(failure.detail), "failure_detail 仍寫入錯誤原文");
  const columnFragment = update.sql;
  assert.match(columnFragment, /failure_record_json/);
  assert.match(columnFragment, /failure_detail/);
});

test("FG-01：落庫 → 讀回逐欄位等價（含遞迴層）；產品解釋未覆寫原生", async () => {
  const error = syntheticUpstreamError();
  const failure = classifySupplierFailure(error);
  const record = createFailureRecord({ error, explanation: explainFailure(failure) });

  // 寫入（走真實寫入函數，取回它交給 DB 的值）。
  const writer = recordingMock(() => []);
  await failGenerationAttempt({
    jobId: "job-1",
    workerId: "worker-a",
    attemptId: "attempt-1",
    failureClass: failure.failureClass,
    failureDetail: failure.detail,
    failureRecord: record,
    providerHttpStatus: failure.httpStatus,
    latencyMs: 12,
  }, writer.sql);
  const written = decodeWrittenFailureRecord(writer.calls, "generation_attempt");

  // 讀回（走真實讀取函數；mock 原樣回吐 jsonb，等價於 DB 的 jsonb 往返）。
  const reader = recordingMock((query) => {
    if (query.includes("FROM generation_attempt")) {
      return [{
        attempt_no: 1,
        output_index: 0,
        status: "failed",
        provider_http_status: 451,
        latency_ms: 12,
        failure_class: "content_rejected",
        failure_detail: failure.detail,
        failure_record_json: written,
        supplier_label: "adobe2api",
        supplier_base_url: "https://upstream.example",
      }];
    }
    return [];
  });
  const summaries = await listGenerationAttemptsForJob("job-1", reader.sql);
  assert.equal(summaries.length, 1);
  const readBack = summaries[0].failureRecord;
  assert.ok(readBack, "讀回必須拿到 FailureRecord");
  assert.deepEqual(
    readBack.native,
    expectedNative(error.stack, (error as unknown as { cause: Error }).cause.stack, (error as unknown as { cause: { cause: Error } }).cause.cause.stack),
  );
  assert.equal(readBack.native.cause?.cause?.code, "ECONNRESET");
  assert.equal(readBack.native.cause?.cause?.status, 502);

  // 產品解釋另存，不覆寫原生：解釋欄位與原生欄位同時存在且各自獨立。
  assert.equal(readBack.explanation?.failureClass, "content_rejected");
  assert.equal(readBack.native.message, "upstream rejected: content policy");
  assert.equal(readBack.native.code, "1008");
  assert.equal(readBack.native.cause?.message, "adobe2api relay failed");
  assert.notEqual(readBack.explanation?.humanMessage, readBack.native.message);
});

test("FG-01：終態失敗（job 級）同樣落版本化記錄，且帳本仍記未改寫原文", async () => {
  const error = syntheticUpstreamError();
  const failure = classifySupplierFailure(error);
  const record = createFailureRecord({ error, explanation: explainFailure(failure) });

  const { sql, calls } = recordingMock((query) => {
    if (query.includes("UPDATE generation_job")) return [{ id: "job-1" }];
    return [];
  });
  await failGenerationJob({
    jobId: "job-1",
    workerId: "worker-a",
    failureClass: failure.failureClass,
    failureDetail: failure.detail,
    failureRecord: record,
  }, sql);

  const written = decodeWrittenFailureRecord(calls, "generation_job");
  assert.deepEqual(written.native, expectedNative(
    error.stack,
    (error as unknown as { cause: Error }).cause.stack,
    (error as unknown as { cause: { cause: Error } }).cause.cause.stack,
  ));

  // append-only 帳本：job_failed 事件的 upstream_raw = 未改寫的錯誤原文。
  const eventInsert = calls.find((call) => call.sql.includes("INSERT INTO job_events"));
  assert.ok(eventInsert, "應寫入 job_events");
  assert.ok(eventInsert.values.includes(failure.detail), "upstream_raw 必須是錯誤原文");
  assert.ok(!eventInsert.values.includes(failure.explanation?.humanMessage ?? "??"), "帳本不得寫入產品人話");
});

test("FG-01：版本閘——未知版本的 jsonb 不得被靜默讀成當前版本", async () => {
  const error = syntheticUpstreamError();
  const record = createFailureRecord({ error });

  assert.deepEqual(mapFailureRecordColumn(record)?.native, record.native);
  assert.equal(mapFailureRecordColumn({ ...record, version: 2 }), null, "未知版本必須拒絕解析");
  assert.equal(mapFailureRecordColumn("not-json"), null);
  assert.equal(mapFailureRecordColumn(null), null);
  assert.equal(mapFailureRecordColumn(undefined), null);

  // 讀回時若欄位壞掉/版本未知 → failureRecord 為 null，但產品欄位照常可讀（不影響既有消費面）。
  const reader = recordingMock((query) => {
    if (query.includes("FROM generation_attempt")) {
      return [{
        attempt_no: 1,
        output_index: 0,
        status: "failed",
        provider_http_status: 502,
        latency_ms: 5,
        failure_class: "overloaded",
        failure_detail: "upstream said 502",
        failure_record_json: { version: 99, native: { name: "x", message: "y" }, capturedAt: "2026-09-23T00:00:00.000Z" },
        supplier_label: "adobe2api",
        supplier_base_url: "https://upstream.example",
      }];
    }
    return [];
  });
  const [summary] = await listGenerationAttemptsForJob("job-1", reader.sql);
  assert.equal(summary.failureRecord, null);
  assert.equal(summary.failureDetail, "upstream said 502");
  assert.equal(summary.failureClass, "overloaded");
});
