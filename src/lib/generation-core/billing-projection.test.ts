import assert from "node:assert/strict";
import test from "node:test";

import { projectGatePathBilling } from "./billing-projection.ts";
import type { GenerationSql } from "./database.ts";

type Call = { sql: string; values: unknown[] };

/** 病灶 A（2026-08-30）回歸針：failed + 真實上游消耗的 0 額 job 必須記 writeoff、不扣用戶。 */

function failedGateJobRow(overrides: Record<string, unknown> = {}) {
  return {
    id: "job-failed-upstream",
    kind: "image_generate",
    model_id: "gpt-image-2",
    quality: "fast",
    resolution: "1k",
    requested_count: 1,
    workflow_json: null,
    billing_user_id: 7,
    ...overrides,
  };
}

/**
 * 依查詢內容分流的 mock sql：succeeded 掃描 / writeoff 掃描 依注入的回傳，
 * 其餘（INSERT/UPDATE/event）回空陣列；逐筆呼叫記錄進 calls 供斷言。
 */
function mockSql(opts: { succeeded?: Record<string, unknown>[]; writeoff?: Record<string, unknown>[] }) {
  const calls: Call[] = [];
  const tagged = (async (strings: TemplateStringsArray, ...values: unknown[]) => {
    const sql = strings.join(" ");
    calls.push({ sql, values });
    if (sql.includes("job.status = 'succeeded'")) return opts.succeeded ?? [];
    if (sql.includes("job.status = 'failed'")) return opts.writeoff ?? [];
    if (sql.includes("INSERT INTO billing_operation")) return [{ id: "op-claimed" }];
    return [];
  }) as unknown as GenerationSql;
  return { sql: tagged, calls };
}

test("failed job with upstream attempt -> writeoff row written, no commit, no quota debit", async () => {
  const { sql, calls } = mockSql({ writeoff: [failedGateJobRow()] });
  const summary = await projectGatePathBilling({ executorId: "worker-test", sql });

  const insert = calls.find((call) => call.sql.includes("INSERT INTO billing_operation"));
  assert.ok(insert, "should issue a billing_operation INSERT for the writeoff");
  assert.ok(insert.sql.includes("'writeoff'"), "operation should be writeoff");
  assert.ok(insert.sql.includes("'applied'"), "writeoff row should land as applied directly");
  assert.ok(
    insert.values.includes("projection:job-failed-upstream:writeoff:1"),
    "idempotency_ref should be projection:{job}:writeoff:1",
  );
  const amount = Number(insert.values[2]);
  assert.ok(Number.isFinite(amount) && amount > 0, `writeoff amount should be positive (got ${amount})`);

  assert.ok(
    !calls.some((call) => call.sql.includes("INSERT INTO billing_operation") && call.sql.includes("'commit'")),
    "no commit row should be written for a failed job",
  );
  assert.ok(
    !calls.some((call) => call.sql.includes("UPDATE billing_operation")),
    "writeoff lands as a direct applied insert; no pending->applied update flow (succeeded branch) should run",
  );
  assert.ok(calls.some((call) => call.sql.includes("job_events")), "writeoff should emit a job event");
  assert.equal(summary.writeoffs, 1);
  assert.equal(summary.projected, 0, "failed job must not count as projected (no user debit)");
});

test("failed job without upstream attempt -> no writeoff, no insert at all", async () => {
  // 無 attempt（provider_task_id / provider_http_status 皆空）時，查詢的 EXISTS 條件不命中 → 掃描回空。
  const { sql, calls } = mockSql({ writeoff: [] });
  const summary = await projectGatePathBilling({ executorId: "worker-test", sql });

  assert.ok(
    !calls.some((call) => call.sql.includes("INSERT INTO billing_operation")),
    "no writeoff row should be written when the failed job never reached upstream",
  );
  assert.equal(summary.writeoffs, 0);
  assert.equal(summary.projected, 0);
});

/** 從呼叫記錄中撈出 writeoff 掃描查詢的 SQL 文本（含 job.status = 'failed'）。 */
function writeoffScanSql(calls: Call[]): string {
  const call = calls.find((c) => c.sql.includes("job.status = 'failed'"));
  assert.ok(call, "writeoff scan query should be issued");
  return call.sql;
}

test("writeoff scan excludes client-rejected 4xx attempts (401/403/408/422) -> no writeoff for those jobs", async () => {
  // mock 不執行 SQL，真實過濾發生在 DB 端（EXISTS 子查詢）。此處鎖定掃描 SQL 文本，
  // 保證 400-499 被 NOT(...) 排除、且不誤傷 2xx/5xx/NULL（僅 BETWEEN 400 AND 499）。
  const { sql, calls } = mockSql({ writeoff: [failedGateJobRow()] });
  await projectGatePathBilling({ executorId: "worker-test", sql });

  const scan = writeoffScanSql(calls);
  assert.match(
    scan,
    /AND NOT \(attempt\.provider_http_status IS NOT NULL AND attempt\.provider_http_status BETWEEN 400 AND 499\)/,
    "4xx 必須在 EXISTS 子查詢中被 NOT(...) 排除（保守原則：4xx 一律不寫賬）",
  );
  // 既有「有上游記錄」判據必須保留（provider_task_id 或 provider_http_status 任一非空）。
  assert.match(
    scan,
    /provider_task_id IS NOT NULL OR attempt\.provider_http_status IS NOT NULL/,
    "有上游記錄的判據（task_id/http_status 任一非空）必須保留",
  );
});

test("failed job with 5xx attempt (504 timeout) -> writeoff written (real upstream consumption)", async () => {
  // 5xx = 上游側失敗（可能已扣），保留寫賬——掃描命中並寫 writeoff。
  const { sql, calls } = mockSql({ writeoff: [failedGateJobRow()] });
  const summary = await projectGatePathBilling({ executorId: "worker-test", sql });

  const insert = calls.find((call) => call.sql.includes("INSERT INTO billing_operation"));
  assert.ok(insert, "5xx failed job should issue a writeoff INSERT");
  assert.ok(insert.sql.includes("'writeoff'"), "operation should be writeoff");
  assert.equal(summary.writeoffs, 1);
});

test("failed job with attempt having provider_task_id but no http_status -> writeoff written", async () => {
  // 已拿到任務號 = 上游已受理（真實消耗），即使沒有 http_status 也要寫賬。
  const { sql, calls } = mockSql({ writeoff: [failedGateJobRow()] });
  const summary = await projectGatePathBilling({ executorId: "worker-test", sql });

  const insert = calls.find((call) => call.sql.includes("INSERT INTO billing_operation"));
  assert.ok(insert, "failed job with accepted provider task should issue a writeoff INSERT");
  assert.ok(insert.sql.includes("'writeoff'"), "operation should be writeoff");
  assert.equal(summary.writeoffs, 1);
});

test("failed job with 2xx attempt -> writeoff written (upstream succeeded then job failed later)", async () => {
  // 2xx = 上游成功處理過（已消耗），即使 job 後續掛掉也要寫賬。
  const { sql, calls } = mockSql({ writeoff: [failedGateJobRow()] });
  const summary = await projectGatePathBilling({ executorId: "worker-test", sql });

  const insert = calls.find((call) => call.sql.includes("INSERT INTO billing_operation"));
  assert.ok(insert, "2xx failed job should issue a writeoff INSERT");
  assert.ok(insert.sql.includes("'writeoff'"), "operation should be writeoff");
  assert.equal(summary.writeoffs, 1);
});
