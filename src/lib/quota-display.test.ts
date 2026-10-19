import test from "node:test";
import assert from "node:assert/strict";

import {
  QUOTA_STALE_AFTER_MS,
  QUOTA_UNAVAILABLE_LABEL,
  describeQuota,
  type QuotaDisplay,
} from "./quota-display.ts";

test("authoritative balance is shown verbatim with ok tone, not flagged stale", () => {
  const out = describeQuota({ kind: "authoritative", balanceCoins: 12.5 }, 1_000);
  assert.equal(out.label, "12.5 币");
  assert.equal(out.tone, "ok");
  assert.equal(out.stale, false);
});

test("authoritative zero is a real zero (only unavailable may never show 0)", () => {
  const out = describeQuota({ kind: "authoritative", balanceCoins: 0 }, 1_000);
  assert.equal(out.label, "0 币");
  assert.equal(out.tone, "ok");
});

test("authoritative negative balance is preserved (true state, not clamped)", () => {
  const out = describeQuota({ kind: "authoritative", balanceCoins: -3.5 }, 1_000);
  assert.equal(out.label, "-3.5 币");
  assert.equal(out.tone, "ok");
});

test("unavailable NEVER renders 0 and is flagged unknown", () => {
  const out = describeQuota({ kind: "unavailable", reason: "ledger query failed" }, 1_000);
  assert.equal(out.label, QUOTA_UNAVAILABLE_LABEL);
  assert.equal(out.tone, "unknown");
  assert.equal(out.stale, true);
  // The oracle for this requirement: no digit 0 anywhere in the rendered label.
  assert.equal(/0/.test(out.label), false, `unavailable label must not contain 0: ${out.label}`);
  // The raw reason must not leak into the display label.
  assert.equal(out.label.includes("ledger"), false);
});

test("estimated fresh value keeps ok tone and is marked approximate, not stale", () => {
  const now = 10_000_000;
  const out = describeQuota({ kind: "estimated", balanceCoins: 100, asOf: now - 1_000 }, now);
  assert.equal(out.tone, "ok");
  assert.equal(out.stale, false);
  assert.ok(out.label.includes("约"));
  assert.ok(out.label.includes("100"));
});

test("estimated value older than the threshold is stale and warns", () => {
  const now = 10_000_000;
  const out = describeQuota(
    { kind: "estimated", balanceCoins: 100, asOf: now - QUOTA_STALE_AFTER_MS - 1 },
    now,
  );
  assert.equal(out.tone, "warn");
  assert.equal(out.stale, true);
});

test("estimated exactly at the threshold is still fresh (strictly greater is stale)", () => {
  const now = 10_000_000;
  const out = describeQuota({ kind: "estimated", balanceCoins: 100, asOf: now - QUOTA_STALE_AFTER_MS }, now);
  assert.equal(out.stale, false);
  assert.equal(out.tone, "ok");
});

test("non-finite numbers degrade to unavailable, never render NaN/Infinity", () => {
  const cases: QuotaDisplay[] = [
    describeQuota({ kind: "authoritative", balanceCoins: Number.NaN }, 0),
    describeQuota({ kind: "authoritative", balanceCoins: Number.POSITIVE_INFINITY }, 0),
    describeQuota({ kind: "estimated", balanceCoins: Number.NaN, asOf: 0 }, 0),
  ];
  for (const out of cases) {
    assert.equal(out.label, QUOTA_UNAVAILABLE_LABEL);
    assert.equal(out.tone, "unknown");
    assert.equal(/NaN|Infinity/.test(out.label), false);
  }
});
