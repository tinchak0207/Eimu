// V-07／V-08（2026-09-28）：同步直通路由的錢走 billing-ledger。
//
// 真行為斷言：真 PGlite + 全套真 migration + 真 billing-ledger／sync-charge 函式；
// 只有「外部扣退款」（billing adapter）是測試替身——零付費呼叫、零網關呼叫。
// 斷言對象是帳本列（billing_operation／generation_job 的實際狀態）與替身收到的
// 金額，不是源碼字串。
//
// PGlite 不是 repo 依賴（照 master-ingest-service.test.ts 的慣例）：
//   NODE_PATH=<含 @electric-sql/pglite 的 node_modules> npx --yes tsx --test <本檔>
// 缺席時 SQL 段逐測 skip（誠實聲明，不是通過）；無帳本回落段照跑。

import test, { before } from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { readFileSync, readdirSync } from "node:fs";
import path from "node:path";
import { ImageBillingGatewayError } from "@/lib/image-billing";
import { ensureAccountBaselines } from "./account-ledger";
import { reconcileGenerationBilling } from "./billing-ledger";
import type { GenerationBillingAdapter, GenerationBillingAdjustment } from "./billing-relay";
import { claimNextGenerationJob } from "./job-repository";
import { commitSyncCharge, refundSyncCharge, reserveSyncCharge, type SyncChargeInput } from "./sync-charge";

const REPO = new URL("../../..", import.meta.url).pathname;
const require = createRequire(import.meta.url);
// eslint-disable-next-line @typescript-eslint/no-explicit-any
let pg: { exec: (sql: string) => Promise<unknown>; query: (sql: string, values?: unknown[]) => Promise<{ rows: any[] }> } | null = null;

before(async () => {
  process.env.GENERATION_PROMPT_ENCRYPTION_KEY = Buffer.alloc(32, 9).toString("base64");
  try {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const mod = require("@electric-sql/pglite") as { PGlite: new () => NonNullable<typeof pg> };
    pg = new mod.PGlite();
  } catch {
    return;
  }
  for (const f of readdirSync(path.join(REPO, "db/migrations")).filter((f) => f.endsWith(".sql")).sort()) {
    try {
      await pg.exec(readFileSync(path.join(REPO, "db/migrations", f), "utf8"));
    } catch (e) {
      if (!String((e as Error).message).includes("already exists")) throw e;
    }
  }
});

function skipWithoutPg(t: { skip: (m?: string) => void }): boolean {
  if (!pg) {
    t.skip("PGlite 未安裝（SQL 整合段需要它；跑法見檔頭）");
    return true;
  }
  return false;
}

// postgres.js 形狀 shim（tagged template → $n → PGlite）。
function makeSql() {
  const tagged = async (strings: TemplateStringsArray, ...values: unknown[]) => {
    let text = strings[0];
    for (let i = 0; i < values.length; i++) text += `$${i + 1}` + strings[i + 1];
    const res = await pg!.query(text, values as never[]);
    return res.rows;
  };
  (tagged as unknown as { begin: (fn: (tx: unknown) => Promise<unknown>) => Promise<unknown> }).begin = async (fn) => fn(tagged);
  (tagged as unknown as { json: (v: unknown) => string }).json = (v: unknown) => JSON.stringify(v ?? null);
  return tagged as never;
}

type AdapterCall = GenerationBillingAdjustment;
function fakeAdapter(opts: { reserve?: (c: AdapterCall) => void; refund?: (c: AdapterCall) => void } = {}) {
  const reserves: AdapterCall[] = [];
  const refunds: AdapterCall[] = [];
  const adapter: GenerationBillingAdapter = {
    reserve: async (c) => { reserves.push(c); opts.reserve?.(c); },
    refund: async (c) => { refunds.push(c); opts.refund?.(c); },
  };
  return { adapter, reserves, refunds };
}

let userSeq = 7000;
async function seededUser(sql: never): Promise<number> {
  const userId = ++userSeq;
  // 帳本基線（account_ledger opening）：替身 fetchUser，避免任何網關呼叫。
  await ensureAccountBaselines([userId], { sql, fetchUser: async () => ({ id: userId, quota: 50_000_000 }) as never });
  return userId;
}

function editInput(userId: number, overrides: Partial<SyncChargeInput> = {}): SyncChargeInput {
  return {
    userId,
    quota: 1_500_000,
    action: "images/edits",
    modelId: "pixai-edit",
    kind: "image_edit",
    source: "biz",
    tenantId: "biz:key-sync",
    apiKeyId: "key-sync",
    keyId: "key-sync",
    prompt: "make it blue",
    requestedCount: 1,
    resolution: "1k",
    ...overrides,
  };
}

async function ops(jobId: string) {
  const r = await pg!.query(
    "SELECT operation, amount::int AS amount, status FROM billing_operation WHERE job_id = $1 ORDER BY operation",
    [jobId],
  );
  return Object.fromEntries(r.rows.map((row: { operation: string; amount: number; status: string }) => [row.operation, row]));
}
async function jobRow(jobId: string) {
  return (await pg!.query("SELECT status, tenant_id, kind, completed_count FROM generation_job WHERE id = $1", [jobId])).rows[0];
}

test("扣費成功後上游失敗 → 帳本先有 pending refund op，回應後執行退款 → op applied、job refunded、替身只收到一次全額 credit", async (t) => {
  if (skipWithoutPg(t)) return;
  const sql = makeSql();
  const userId = await seededUser(sql);
  const { adapter, reserves, refunds } = fakeAdapter();

  const charged = await reserveSyncCharge(editInput(userId), { sql, adapter });
  assert.ok(charged.ok);
  const jobId = charged.charge.jobId;
  assert.equal(charged.charge.ledger, true);
  assert.deepEqual(reserves.map((c) => [c.jobId, c.userId, c.amount]), [[jobId, userId, 1_500_000]]);
  assert.equal((await ops(jobId)).reserve.status, "applied");
  const running = await jobRow(jobId);
  assert.equal(running.status, "running");
  assert.equal(running.tenant_id, "sync:biz:key-sync");
  // 同步 job 絕不進隊列：worker 撈不到它（否則會再打一次付費上游）。
  assert.equal(await claimNextGenerationJob("worker-test", 30_000, sql), null);

  const settle = await refundSyncCharge(charged.charge, { status: 502 }, { sql, adapter });
  // 回應前帳本已記「欠用戶 1.5M」：進程此刻死掉也有 op 可撈。
  assert.deepEqual((await ops(jobId)).refund, { operation: "refund", amount: 1_500_000, status: "pending" });
  assert.equal((await jobRow(jobId)).status, "failed");
  assert.equal(refunds.length, 0);

  await settle();
  assert.deepEqual(refunds.map((c) => [c.jobId, c.userId, c.amount]), [[jobId, userId, 1_500_000]]);
  assert.equal((await ops(jobId)).refund.status, "applied");
  assert.equal((await jobRow(jobId)).status, "refunded");
});

test("退款被 429 打回 → op 留 pending（不吞），reconcileGenerationBilling 下一輪撈到並補退一次", async (t) => {
  if (skipWithoutPg(t)) return;
  const sql = makeSql();
  const userId = await seededUser(sql);
  let refundFails = true;
  const { adapter, refunds } = fakeAdapter({
    refund: () => {
      if (refundFails) throw new ImageBillingGatewayError("rate limited", 429, "0");
    },
  });
  const charged = await reserveSyncCharge(editInput(userId), { sql, adapter });
  assert.ok(charged.ok);
  const jobId = charged.charge.jobId;

  const errors: unknown[][] = [];
  const origError = console.error;
  console.error = (...args: unknown[]) => { errors.push(args); };
  try {
    await (await refundSyncCharge(charged.charge, { status: 500 }, { sql, adapter }))();
  } finally {
    console.error = origError;
  }
  assert.equal((await ops(jobId)).refund.status, "pending");
  assert.ok(errors.some((a) => String(a[0]).includes("refund pending")), "退款未落地必須 console.error");

  refundFails = false;
  await pg!.query("UPDATE billing_operation SET next_attempt_at = now() WHERE job_id = $1", [jobId]);
  await reconcileGenerationBilling({ executorId: "reconcile-test", adapter, sql });
  assert.equal((await ops(jobId)).refund.status, "applied");
  assert.equal((await jobRow(jobId)).status, "refunded");
  assert.equal(refunds.filter((c) => c.amount === 1_500_000).length, 2, "一次 429 失敗 + 一次補退成功");
});

test("部分交付（4 出 3）→ commit 實耗 3/4、未交付 1/4 落 refund op 並退回；job 保持 succeeded", async (t) => {
  if (skipWithoutPg(t)) return;
  const sql = makeSql();
  const userId = await seededUser(sql);
  const { adapter, refunds } = fakeAdapter();
  const charged = await reserveSyncCharge(
    editInput(userId, { action: "template-generations", modelId: "pixai-template", kind: "image_generate", quota: 400_000, requestedCount: 4 }),
    { sql, adapter },
  );
  assert.ok(charged.ok);
  const jobId = charged.charge.jobId;

  const settle = await commitSyncCharge(charged.charge, { delivered: 3 }, { sql, adapter });
  const before = await ops(jobId);
  assert.deepEqual(before.commit, { operation: "commit", amount: 300_000, status: "applied" });
  assert.deepEqual(before.refund, { operation: "refund", amount: 100_000, status: "pending" });
  await settle();
  assert.equal((await ops(jobId)).refund.status, "applied");
  assert.deepEqual(refunds.map((c) => c.amount), [100_000]);
  const done = await jobRow(jobId);
  assert.equal(done.status, "succeeded");
  assert.equal(done.completed_count, 3);

  // reconcile 對 succeeded job 補 commit 全額 → 已有 commit 列，ON CONFLICT 不重記。
  await reconcileGenerationBilling({ executorId: "reconcile-test", adapter, sql });
  assert.equal((await ops(jobId)).commit.amount, 300_000);
});

test("全數交付 → 只有 commit 全額、沒有 refund op、替身零 credit", async (t) => {
  if (skipWithoutPg(t)) return;
  const sql = makeSql();
  const userId = await seededUser(sql);
  const { adapter, refunds } = fakeAdapter();
  const charged = await reserveSyncCharge(editInput(userId, { action: "upscale", modelId: "pixai-upscale" }), { sql, adapter });
  assert.ok(charged.ok);
  await (await commitSyncCharge(charged.charge, { delivered: 1 }, { sql, adapter }))();
  const o = await ops(charged.charge.jobId);
  assert.equal(o.commit.amount, 1_500_000);
  assert.equal(o.refund, undefined);
  assert.equal(refunds.length, 0);
});

test("扣款被網關確定拒絕（4xx）→ 402 insufficient_quota 同形；reserve op failed、job failed、不入隊", async (t) => {
  if (skipWithoutPg(t)) return;
  const sql = makeSql();
  const userId = await seededUser(sql);
  const { adapter } = fakeAdapter({ reserve: () => { throw new ImageBillingGatewayError("余额不足", 403); } });
  const charged = await reserveSyncCharge(editInput(userId), { sql, adapter });
  assert.equal(charged.ok, false);
  if (charged.ok) return;
  assert.equal(charged.status, 402);
  assert.deepEqual(charged.body, { error: { message: "余额不足", type: "insufficient_quota", code: "insufficient_quota" } });
  const r = await pg!.query(
    "SELECT j.status, o.status AS op FROM generation_job j JOIN billing_operation o ON o.job_id = j.id WHERE j.billing_user_id = $1",
    [userId],
  );
  assert.deepEqual(r.rows, [{ status: "failed", op: "failed" }]);
  assert.equal(await claimNextGenerationJob("worker-test", 30_000, sql), null);
});

test("扣款結果不明（5xx）→ 402；reserve op unknown、job billing_unknown（交既有 zombie reclaim 全額退），不入隊", async (t) => {
  if (skipWithoutPg(t)) return;
  const sql = makeSql();
  const userId = await seededUser(sql);
  const { adapter } = fakeAdapter({ reserve: () => { throw new ImageBillingGatewayError("gateway 502", 502); } });
  const charged = await reserveSyncCharge(editInput(userId), { sql, adapter });
  assert.equal(charged.ok, false);
  const r = await pg!.query(
    "SELECT j.status, o.status AS op FROM generation_job j JOIN billing_operation o ON o.job_id = j.id WHERE j.billing_user_id = $1",
    [userId],
  );
  assert.deepEqual(r.rows, [{ status: "billing_unknown", op: "unknown" }]);
  assert.equal(await claimNextGenerationJob("worker-test", 30_000, sql), null);
});

test("無帳本實例（Vercel 副本）：回落 adapter 直扣直退；退款失敗 console.error 而非吞掉", async () => {
  const { adapter, reserves } = fakeAdapter({ refund: () => { throw new Error("relay down"); } });
  const charged = await reserveSyncCharge(editInput(42), { adapter, databaseConfigured: false });
  assert.ok(charged.ok);
  assert.equal(charged.charge.ledger, false);
  assert.match(reserves[0].jobId, /^pixai-images-edits-/);
  const errors: unknown[][] = [];
  const origError = console.error;
  console.error = (...args: unknown[]) => { errors.push(args); };
  try {
    await (await refundSyncCharge(charged.charge, { status: 502 }, { adapter, databaseConfigured: false }))();
  } finally {
    console.error = origError;
  }
  assert.equal(errors.length, 1);
  assert.match(String(errors[0][0]), /refund failed \(no ledger\).*quota=1500000/);
});

test("零價或 env 應急 key（userId=0）→ 不扣、不建 job", async () => {
  const { adapter, reserves } = fakeAdapter();
  const free = await reserveSyncCharge(editInput(42, { quota: 0 }), { adapter, databaseConfigured: false });
  assert.ok(free.ok && free.charge.reservedQuota === 0);
  const origWarn = console.warn;
  console.warn = () => undefined;
  try {
    const envKey = await reserveSyncCharge(editInput(0), { adapter, databaseConfigured: true });
    assert.ok(envKey.ok && envKey.charge.reservedQuota === 0);
  } finally {
    console.warn = origWarn;
  }
  assert.equal(reserves.length, 0);
});
