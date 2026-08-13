import test from "node:test";
import assert from "node:assert/strict";

import {
  MAX_CALLBACK_DELIVERY_ATTEMPTS,
  assertSafeCallbackUrl,
  backoffSeconds,
  recordCallbackDeliveryResult,
} from "./callback-outbox.ts";
import type { GenerationSql } from "./database.ts";

// ─────────────────────────────────────────────────────────── backoffSeconds

test("backoffSeconds grows exponentially: min(2^attempt * 5s, 1h)", () => {
  assert.equal(backoffSeconds(1), 10);
  assert.equal(backoffSeconds(2), 20);
  assert.equal(backoffSeconds(3), 40);
  assert.equal(backoffSeconds(4), 80);
  assert.equal(backoffSeconds(5), 160);
});

test("backoffSeconds caps at one hour for large attempt counts", () => {
  assert.equal(backoffSeconds(10), 3600);
  assert.equal(backoffSeconds(50), 3600);
});

test("backoffSeconds treats non-positive attempts as the first attempt", () => {
  assert.equal(backoffSeconds(0), 10);
  assert.equal(backoffSeconds(-3), 10);
});

// ─────────────────────────────────────────────────────────── assertSafeCallbackUrl (SSRF guard)

test("assertSafeCallbackUrl accepts a normal https URL", () => {
  const url = assertSafeCallbackUrl("https://example.com/webhooks/generation");
  assert.equal(url.hostname, "example.com");
});

test("assertSafeCallbackUrl rejects non-https URLs", () => {
  assert.throws(() => assertSafeCallbackUrl("http://example.com/callback"));
});

test("assertSafeCallbackUrl rejects loopback and private/link-local hosts", () => {
  const rejected = [
    "https://localhost/callback",
    "https://127.0.0.1/callback",
    "https://10.0.0.5/callback",
    "https://172.16.0.5/callback",
    "https://172.31.255.255/callback",
    "https://192.168.1.5/callback",
    "https://169.254.169.254/callback", // cloud metadata endpoint
    "https://0.0.0.0/callback",
  ];
  for (const rawUrl of rejected) {
    assert.throws(() => assertSafeCallbackUrl(rawUrl), undefined, `expected ${rawUrl} to be rejected`);
  }
});

test("assertSafeCallbackUrl does not falsely reject a public host that merely contains private-looking digits", () => {
  // 172.32.x is outside the 172.16-31 private range and must not be blocked by an overly broad regex.
  const url = assertSafeCallbackUrl("https://172.32.0.5/callback");
  assert.equal(url.hostname, "172.32.0.5");
});

// ─────────────────────────────────────────────────────────── recordCallbackDeliveryResult

interface RecordedCall {
  sql: string;
  values: unknown[];
}

/**
 * A minimal stand-in for GenerationSql that supports the two shapes
 * recordCallbackDeliveryResult relies on: a plain tagged-template call (the success path,
 * `sql\`...\``) and a `sql.begin(async (tx) => ...)` transaction whose `tx` supports the
 * same tagged-template calling convention. Queries are matched by substring, mirroring the
 * style already used in biz-api-key-rate-limit.test.ts's makeMockSql.
 */
function createMockSql(selectDeliveryCount: number): { sql: GenerationSql; calls: RecordedCall[] } {
  const calls: RecordedCall[] = [];

  const tagged = (async (strings: readonly string[], ...values: unknown[]): Promise<unknown> => {
    const text = strings.join(" ");
    calls.push({ sql: text, values });
    if (text.includes("SELECT delivery_count")) {
      return [{ delivery_count: selectDeliveryCount }];
    }
    return [];
  }) as unknown as GenerationSql;

  (tagged as unknown as { begin: (cb: (tx: GenerationSql) => Promise<unknown>) => Promise<unknown> }).begin = (
    cb: (tx: GenerationSql) => Promise<unknown>,
  ) => cb(tagged);

  return { sql: tagged, calls };
}

test("recordCallbackDeliveryResult: pending -> delivered on 2xx success", async () => {
  const { sql, calls } = createMockSql(0);

  await recordCallbackDeliveryResult({ id: "delivery-1", ok: true, responseCode: 204 }, sql);

  assert.equal(calls.length, 1, "success path should not open a transaction / extra SELECT");
  const [call] = calls;
  assert.match(call.sql, /status = 'delivered'/);
  assert.match(call.sql, /delivered_at = now\(\)/);
  assert.deepEqual(call.values, [204, "delivery-1"]);
});

test("recordCallbackDeliveryResult: pending -> pending with exponential backoff on failure", async () => {
  const { sql, calls } = createMockSql(2); // current delivery_count = 2 -> nextCount = 3

  const before = Date.now();
  await recordCallbackDeliveryResult(
    { id: "delivery-2", ok: false, responseCode: 500, error: "upstream 500" },
    sql,
  );
  const after = Date.now();

  assert.equal(calls.length, 2, "failure path selects the current count then writes one update");
  const [selectCall, updateCall] = calls;
  assert.match(selectCall.sql, /SELECT delivery_count FROM callback_delivery/);
  assert.match(selectCall.sql, /FOR UPDATE/);

  assert.match(updateCall.sql, /status = 'pending'/);
  assert.doesNotMatch(updateCall.sql, /dead_letter/);

  const [nextCount, responseCode, lastError, nextAttemptAt, id] = updateCall.values;
  assert.equal(nextCount, 3);
  assert.equal(responseCode, 500);
  assert.equal(lastError, "upstream 500");
  assert.equal(id, "delivery-2");
  assert.ok(nextAttemptAt instanceof Date);
  const expectedDelaySeconds = backoffSeconds(3);
  const actualDelayMs = (nextAttemptAt as Date).getTime() - before;
  assert.ok(
    actualDelayMs >= expectedDelaySeconds * 1000 - 50 && actualDelayMs <= (after - before) + expectedDelaySeconds * 1000 + 50,
    `expected ~${expectedDelaySeconds}s backoff, got ${actualDelayMs}ms`,
  );
});

test("recordCallbackDeliveryResult: pending -> dead_letter once max attempts is reached", async () => {
  const startingCount = MAX_CALLBACK_DELIVERY_ATTEMPTS - 1; // nextCount will hit the max exactly
  const { sql, calls } = createMockSql(startingCount);

  await recordCallbackDeliveryResult(
    { id: "delivery-3", ok: false, error: "still failing" },
    sql,
  );

  assert.equal(calls.length, 2);
  const [, updateCall] = calls;
  assert.match(updateCall.sql, /status = 'dead_letter'/);
  assert.doesNotMatch(updateCall.sql, /status = 'pending'/);

  const [nextCount, responseCode, lastError, id] = updateCall.values;
  assert.equal(nextCount, MAX_CALLBACK_DELIVERY_ATTEMPTS);
  assert.equal(responseCode, null);
  assert.equal(lastError, "still failing");
  assert.equal(id, "delivery-3");
});

test("recordCallbackDeliveryResult: a missing row (already deleted/claimed elsewhere) is a safe no-op", async () => {
  const calls: RecordedCall[] = [];
  const tagged = (async (strings: readonly string[], ...values: unknown[]): Promise<unknown> => {
    const text = strings.join(" ");
    calls.push({ sql: text, values });
    if (text.includes("SELECT delivery_count")) return [];
    return [];
  }) as unknown as GenerationSql;
  (tagged as unknown as { begin: (cb: (tx: GenerationSql) => Promise<unknown>) => Promise<unknown> }).begin = (
    cb: (tx: GenerationSql) => Promise<unknown>,
  ) => cb(tagged);

  await recordCallbackDeliveryResult({ id: "missing", ok: false, error: "irrelevant" }, tagged);

  assert.equal(calls.length, 1, "only the SELECT should run; no UPDATE for a row that no longer exists");
});
