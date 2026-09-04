import assert from "node:assert/strict";
import test from "node:test";

import { extendGenerationDeadlineJob, extendGenerationQueueDeadline } from "./job-repository.ts";
import type { GenerationSql } from "./database.ts";

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

test("extendGenerationDeadlineJob 返回實際寫入的新 deadline_at（供內存同步，病灶 D）", async () => {
  const startedAt = new Date("2026-08-30T00:00:00.000Z");
  const written = new Date("2026-08-30T00:15:00.000Z");
  const { sql, calls } = recordingMock((query) => {
    if (query.includes("UPDATE generation_job")) return [{ deadline_at: written }];
    return [];
  });
  const result = await extendGenerationDeadlineJob({ id: "job-1", startedAt }, "worker-a", 15 * 60_000, sql);

  assert.ok(result instanceof Date);
  assert.equal(result.getTime(), written.getTime());
  const update = calls.find((call) => call.sql.includes("UPDATE generation_job"));
  assert.ok(update);
  assert.match(update.sql, /GREATEST\(deadline_at/);
  assert.match(update.sql, /RETURNING deadline_at/);
});

test("extendGenerationDeadlineJob 無 started_at 或未更新時返回 null", async () => {
  const { sql } = recordingMock(() => []);
  const result = await extendGenerationDeadlineJob({ id: "job-1", startedAt: null }, "worker-a", 15 * 60_000, sql);
  assert.equal(result, null);
});

test("extendGenerationQueueDeadline 相對 now 順延並返回新 deadline（排隊期退避，病灶 D）", async () => {
  const written = new Date("2026-08-30T00:05:00.000Z");
  const { sql, calls } = recordingMock((query) => {
    if (query.includes("UPDATE generation_job")) return [{ deadline_at: written }];
    return [];
  });
  const result = await extendGenerationQueueDeadline({ id: "job-1", startedAt: new Date("2026-08-30T00:00:00.000Z") }, "worker-a", 5 * 60_000, sql);

  assert.ok(result instanceof Date);
  assert.equal(result.getTime(), written.getTime());
  const update = calls.find((call) => call.sql.includes("UPDATE generation_job"));
  assert.ok(update);
  // 相對 now 增量（GREATEST(deadline_at, now() + interval)），重複調用仍會推後。
  assert.match(update.sql, /GREATEST\(deadline_at, now\(\) \+/);
  assert.match(update.sql, /RETURNING deadline_at/);
});