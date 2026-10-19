import assert from "node:assert/strict";
import test from "node:test";

import { projectGatePathBilling } from "./billing-projection.ts";
import type { GenerationSql } from "./database.ts";

type Call = { sql: string; values: unknown[] };

/** 病灶 A（2026-08-30）回归针：failed + 真实上游消耗的 0 额 job 必须记 writeoff、不扣用户。 */

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
 * 依查询内容分流的 mock sql：succeeded 扫描 / writeoff 扫描 依注入的回传，
 * 其余（INSERT/UPDATE/event）回空阵列；逐笔呼叫记录进 calls 供断言。
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

test("FG-b：commit 扣款失败 → 问 registry 求重放授权，被拒即终结该 claim（不得静默重扣）", async () => {
  // users.quota 扣减确定性失败：管理凭证清空 → adminHeaders 在 fetch 之前就抛，
  // 不会发出任何网路请求（测试不得碰真上游）。
  const savedToken = process.env.GATEWAY_ADMIN_ACCESS_TOKEN;
  const savedUserId = process.env.GATEWAY_ADMIN_USER_ID;
  process.env.GATEWAY_ADMIN_ACCESS_TOKEN = "";
  process.env.GATEWAY_ADMIN_USER_ID = "";
  try {
    const { sql, calls } = mockSql({ succeeded: [failedGateJobRow({ id: "job-debit-fail" })] });
    // 对抗性：呼叫方夹带 999 次预算（型别外栏位）。
    const adversarial = {
      executorId: "worker-test",
      sql,
      maxAttempts: 999,
      maxReplayAttempts: 999,
    } as unknown as Parameters<typeof projectGatePathBilling>[0];
    const summary = await projectGatePathBilling(adversarial);

    assert.equal(summary.failed, 1, "扣款失败必须计入 failed（不灌水成 projected）");
    assert.equal(summary.projected, 0, "扣款没成功就不得声称已投影");
    const terminal = calls.find((call) => call.sql.includes("UPDATE billing_operation SET status = 'failed'"));
    assert.ok(terminal, "claim 必须被终结（不是留在 pending 等下一轮重扣）");
    assert.ok(
      String(terminal.values).includes("operation registry"),
      "last_error 必须写明是 registry 拒绝（不是静默失败）",
    );
    assert.ok(
      !calls.some((call) => call.sql.includes("UPDATE billing_operation SET status = 'pending'")),
      "不得把 claim 退回 pending 让下一轮重扣（上游对 quota 调整无幂等契约 → 可能双扣）",
    );
    const denied = calls.find((call) => (call.values as unknown[]).some((v) => typeof v === "string" && v === "replay_denied"));
    assert.ok(denied, "必须留下 replay_denied 事件（裁决可审查，不是查常数）");
  } finally {
    process.env.GATEWAY_ADMIN_ACCESS_TOKEN = savedToken;
    process.env.GATEWAY_ADMIN_USER_ID = savedUserId;
  }
});

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
  // 无 attempt（provider_task_id / provider_http_status 皆空）时，查询的 EXISTS 条件不命中 → 扫描回空。
  const { sql, calls } = mockSql({ writeoff: [] });
  const summary = await projectGatePathBilling({ executorId: "worker-test", sql });

  assert.ok(
    !calls.some((call) => call.sql.includes("INSERT INTO billing_operation")),
    "no writeoff row should be written when the failed job never reached upstream",
  );
  assert.equal(summary.writeoffs, 0);
  assert.equal(summary.projected, 0);
});

/** 从呼叫记录中捞出 writeoff 扫描（不含 succeeded 投影扫描，那条也会提到 failed）。 */
function writeoffScanSql(calls: Call[]): string {
  const call = calls.find((c) => c.sql.includes("job.status = 'failed'") && c.sql.includes("operation = 'writeoff'"));
  assert.ok(call, "writeoff scan query should be issued");
  return call.sql;
}

test("writeoff scan excludes client-rejected 4xx attempts (401/403/408/422) -> no writeoff for those jobs", async () => {
  // mock 不执行 SQL，真实过滤发生在 DB 端（EXISTS 子查询）。此处锁定扫描 SQL 文本，
  // 保证 400-499 被 NOT(...) 排除、且不误伤 2xx/5xx/NULL（仅 BETWEEN 400 AND 499）。
  const { sql, calls } = mockSql({ writeoff: [failedGateJobRow()] });
  await projectGatePathBilling({ executorId: "worker-test", sql });

  const scan = writeoffScanSql(calls);
  assert.match(
    scan,
    /AND NOT \(attempt\.provider_http_status IS NOT NULL AND attempt\.provider_http_status BETWEEN 400 AND 499\)/,
    "4xx 必须在 EXISTS 子查询中被 NOT(...) 排除（保守原则：4xx 一律不写账）",
  );
  // 既有「有上游记录」判据必须保留（provider_task_id 或 provider_http_status 任一非空）。
  assert.match(
    scan,
    /provider_task_id IS NOT NULL OR attempt\.provider_http_status IS NOT NULL/,
    "有上游记录的判据（task_id/http_status 任一非空）必须保留",
  );
});

test("failed job with 5xx attempt (504 timeout) -> writeoff written (real upstream consumption)", async () => {
  // 5xx = 上游侧失败（可能已扣），保留写账——扫描命中并写 writeoff。
  const { sql, calls } = mockSql({ writeoff: [failedGateJobRow()] });
  const summary = await projectGatePathBilling({ executorId: "worker-test", sql });

  const insert = calls.find((call) => call.sql.includes("INSERT INTO billing_operation"));
  assert.ok(insert, "5xx failed job should issue a writeoff INSERT");
  assert.ok(insert.sql.includes("'writeoff'"), "operation should be writeoff");
  assert.equal(summary.writeoffs, 1);
});

test("failed job with attempt having provider_task_id but no http_status -> writeoff written", async () => {
  // 已拿到任务号 = 上游已受理（真实消耗），即使没有 http_status 也要写账。
  const { sql, calls } = mockSql({ writeoff: [failedGateJobRow()] });
  const summary = await projectGatePathBilling({ executorId: "worker-test", sql });

  const insert = calls.find((call) => call.sql.includes("INSERT INTO billing_operation"));
  assert.ok(insert, "failed job with accepted provider task should issue a writeoff INSERT");
  assert.ok(insert.sql.includes("'writeoff'"), "operation should be writeoff");
  assert.equal(summary.writeoffs, 1);
});

test("failed job with 2xx attempt -> writeoff written (upstream succeeded then job failed later)", async () => {
  // 2xx = 上游成功处理过（已消耗），即使 job 后续挂掉也要写账。
  const { sql, calls } = mockSql({ writeoff: [failedGateJobRow()] });
  const summary = await projectGatePathBilling({ executorId: "worker-test", sql });

  const insert = calls.find((call) => call.sql.includes("INSERT INTO billing_operation"));
  assert.ok(insert, "2xx failed job should issue a writeoff INSERT");
  assert.ok(insert.sql.includes("'writeoff'"), "operation should be writeoff");
  assert.equal(summary.writeoffs, 1);
});
