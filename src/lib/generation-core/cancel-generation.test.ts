import assert from "node:assert/strict";
import test from "node:test";

import { cancelGenerationJob } from "./job-repository.ts";
import { JOB_EVENT } from "./job-events.ts";
import type { GenerationSql } from "./database.ts";

type Call = { sql: string; values: unknown[] };

// 照 billing-ledger.test.ts 的 mock GenerationSql 模式。
// cancelGenerationJob 全部語義壓在一條 CTE UPDATE 上：可取消態回傳
// { id, previous_status }，否則空集（上層 route 映射 409 already_terminal）。
function mockSql(options: { cancellable: boolean; previousStatus: string }) {
  const calls: Call[] = [];
  const tagged = (async (strings: TemplateStringsArray, ...values: unknown[]) => {
    const text = strings.join(" ");
    calls.push({ sql: text, values });
    if (text.includes("SET status = 'cancelled'")) {
      return options.cancellable
        ? [{ id: "job-1", previous_status: options.previousStatus }]
        : [];
    }
    return [];
  }) as unknown as GenerationSql;
  (tagged as unknown as { begin: (cb: (tx: GenerationSql) => Promise<unknown>) => Promise<unknown> }).begin =
    (cb) => cb(tagged);
  return { sql: tagged, calls };
}

test("cancel of a queued job succeeds, reports previous status and appends job_cancelled", async () => {
  const { sql, calls } = mockSql({ cancellable: true, previousStatus: "queued" });
  const result = await cancelGenerationJob("job-1", "web:7", sql);
  assert.deepEqual(result, { cancelled: true, previousStatus: "queued" });
  assert.ok(calls.some((call) =>
    call.sql.includes("INSERT INTO job_events") && call.values.includes(JOB_EVENT.jobCancelled)));
  assert.ok(calls.some((call) =>
    call.sql.includes("SET status = 'cancelled'")
      && call.sql.includes("'pending_billing', 'queued', 'leased', 'submitting', 'running'")));
});

test("cancel of a running job is allowed (worker discards in-flight output; reconcile settles billing)", async () => {
  const { sql, calls } = mockSql({ cancellable: true, previousStatus: "running" });
  const result = await cancelGenerationJob("job-1", "biz:key-1", sql);
  assert.deepEqual(result, { cancelled: true, previousStatus: "running" });
  assert.ok(calls.some((call) => call.values.includes("biz:key-1")));
});

test("cancel of a terminal (succeeded) job is rejected -> route maps to 409 already_terminal", async () => {
  const { sql, calls } = mockSql({ cancellable: false, previousStatus: "succeeded" });
  const result = await cancelGenerationJob("job-1", "web:7", sql);
  assert.deepEqual(result, { cancelled: false, previousStatus: null });
  assert.ok(!calls.some((call) => call.sql.includes("INSERT INTO job_events")));
});
