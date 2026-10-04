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

/** 合成上游错误：巢状 cause（三层）+ requestId + metadata + 原生 code/status。 */
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

/** 手工写出的期望原生值（oracle 来自测试自己的合成错误，不来自被测实现）。 */
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
  assert.ok(update, `应有 ${table} 的 UPDATE`);
  const written = update.values.find(
    (value): value is FailureRecord => Boolean(value) && typeof value === "object" && "native" in (value as object),
  );
  assert.ok(written, `${table} UPDATE 应带入 failure_record_json`);
  return written;
}

test("FG-01：失败记录落 attempt 后逐栏位等价（含巢状 cause 递回层）", async () => {
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
    "写入的原生栏位必须逐栏位等价（含三层 cause）",
  );
  assert.equal(written.version, 1);
  assert.equal(typeof written.capturedAt, "string");

  // 帐本路径不受影响：UPDATE 仍吃未改写的错误原文（产品栏位与原生分栏）。
  const update = calls.find((call) => call.sql.includes("UPDATE generation_attempt"));
  assert.ok(update?.values.includes(failure.detail), "failure_detail 仍写入错误原文");
  const columnFragment = update.sql;
  assert.match(columnFragment, /failure_record_json/);
  assert.match(columnFragment, /failure_detail/);
});

test("FG-01：落库 → 读回逐栏位等价（含递回层）；产品解释未覆写原生", async () => {
  const error = syntheticUpstreamError();
  const failure = classifySupplierFailure(error);
  const record = createFailureRecord({ error, explanation: explainFailure(failure) });

  // 写入（走真实写入函数，取回它交给 DB 的值）。
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

  // 读回（走真实读取函数；mock 原样回吐 jsonb，等价于 DB 的 jsonb 往返）。
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
  assert.ok(readBack, "读回必须拿到 FailureRecord");
  assert.deepEqual(
    readBack.native,
    expectedNative(error.stack, (error as unknown as { cause: Error }).cause.stack, (error as unknown as { cause: { cause: Error } }).cause.cause.stack),
  );
  assert.equal(readBack.native.cause?.cause?.code, "ECONNRESET");
  assert.equal(readBack.native.cause?.cause?.status, 502);

  // 产品解释另存，不覆写原生：解释栏位与原生栏位同时存在且各自独立。
  assert.equal(readBack.explanation?.failureClass, "content_rejected");
  assert.equal(readBack.native.message, "upstream rejected: content policy");
  assert.equal(readBack.native.code, "1008");
  assert.equal(readBack.native.cause?.message, "adobe2api relay failed");
  assert.notEqual(readBack.explanation?.humanMessage, readBack.native.message);
});

test("FG-01：终态失败（job 级）同样落版本化记录，且帐本仍记未改写原文", async () => {
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

  // append-only 帐本：job_failed 事件的 upstream_raw = 未改写的错误原文。
  const eventInsert = calls.find((call) => call.sql.includes("INSERT INTO job_events"));
  assert.ok(eventInsert, "应写入 job_events");
  assert.ok(eventInsert.values.includes(failure.detail), "upstream_raw 必须是错误原文");
  assert.ok(!eventInsert.values.includes(failure.explanation?.humanMessage ?? "??"), "帐本不得写入产品人话");
});

test("FG-01：版本闸——未知版本的 jsonb 不得被静默读成当前版本", async () => {
  const error = syntheticUpstreamError();
  const record = createFailureRecord({ error });

  assert.deepEqual(mapFailureRecordColumn(record)?.native, record.native);
  assert.equal(mapFailureRecordColumn({ ...record, version: 2 }), null, "未知版本必须拒绝解析");
  assert.equal(mapFailureRecordColumn("not-json"), null);
  assert.equal(mapFailureRecordColumn(null), null);
  assert.equal(mapFailureRecordColumn(undefined), null);

  // 读回时若栏位坏掉/版本未知 → failureRecord 为 null，但产品栏位照常可读（不影响既有消费面）。
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
