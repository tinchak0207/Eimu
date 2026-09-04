import assert from "node:assert/strict";
import test from "node:test";

import { recoverExpiredCooldowns } from "./scheduler.ts";
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

test("recoverExpiredCooldowns 把已到期 cooldown 的 supplier/account 恢復 healthy，返回恢復數", async () => {
  const { sql, calls } = recordingMock((query) => {
    if (query.includes("UPDATE supplier_account")) return [{ id: "account-1" }, { id: "account-2" }];
    if (query.includes("UPDATE supplier")) return [{ id: "supplier-1" }];
    return [];
  });
  const result = await recoverExpiredCooldowns(sql);

  assert.deepEqual(result, { recovered: 3 });
  const accountUpdate = calls.find((call) => call.sql.includes("UPDATE supplier_account"));
  const supplierUpdate = calls.find((call) => /UPDATE supplier\s/.test(call.sql));
  assert.ok(accountUpdate, "should update supplier_account");
  assert.ok(supplierUpdate, "should update supplier");
  // 只恢復 cooldown 且已到期（disabled 不在 WHERE 條件內，天然被排除）。
  assert.match(accountUpdate.sql, /health_status = 'cooldown'/);
  assert.match(accountUpdate.sql, /cooldown_until IS NOT NULL AND cooldown_until <= now\(\)/);
  assert.match(supplierUpdate.sql, /health_status = 'cooldown'/);
  assert.match(supplierUpdate.sql, /cooldown_until IS NOT NULL AND cooldown_until <= now\(\)/);
  // 不自動恢復 disabled：SQL 不得以 disabled 作為恢復目標。
  assert.doesNotMatch(accountUpdate.sql, /health_status IN \('cooldown','disabled'\)/);
  assert.doesNotMatch(supplierUpdate.sql, /health_status <> 'disabled'/);
});

test("recoverExpiredCooldowns 對 supplier 保守恢復 health_score，不清零歷史分", async () => {
  const { sql, calls } = recordingMock((query) => {
    if (query.includes("UPDATE supplier_account")) return [];
    return [{ id: "supplier-1" }];
  });
  await recoverExpiredCooldowns(sql);
  const supplierUpdate = calls.find((call) => /UPDATE supplier\s/.test(call.sql));
  assert.ok(supplierUpdate);
  assert.match(supplierUpdate.sql, /health_score = LEAST\(1, health_score \* 0\.5 \+ 0\.5\)/);
  // supplier_account 無 health_score 列，不該出現。
  const accountUpdate = calls.find((call) => call.sql.includes("UPDATE supplier_account"));
  assert.ok(accountUpdate);
  assert.doesNotMatch(accountUpdate.sql, /health_score/);
});

test("recoverExpiredCooldowns 恢復時清掉 cooldown_until 並寫 healthy", async () => {
  const { sql, calls } = recordingMock(() => [{ id: "account-1" }]);
  await recoverExpiredCooldowns(sql);
  const accountUpdate = calls.find((call) => call.sql.includes("UPDATE supplier_account"));
  assert.ok(accountUpdate);
  assert.match(accountUpdate.sql, /health_status = 'healthy'/);
  assert.match(accountUpdate.sql, /cooldown_until = NULL/);
});