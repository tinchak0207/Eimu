import assert from "node:assert/strict";
import test from "node:test";
import { summarizeChannelBalance } from "./routing-balance-signal.ts";
import type { RoutingEvent } from "./routing-telemetry";

function event(modelId: string, ts: number, attempts: { ok: boolean; reason?: string }[]): RoutingEvent {
  return {
    id: `${modelId}-${ts}`,
    ts,
    requestId: `req-${modelId}-${ts}`,
    pipeline: "biz",
    modelId,
    qualityMode: "standard",
    queue: [],
    attempts: attempts.map((a) => ({ label: "env:metaso", host: "metaso.cn", ms: 100, ...a })),
    outcome: "exhausted",
    totalMs: 1000,
    coins: 0,
    refunded: true,
  } as RoutingEvent;
}

test("連續 ≥2 筆 quota_exhausted 收尾 → exhausted，帶連續筆數", () => {
  const signals = summarizeChannelBalance([
    event("minimax-h3", 1, [{ ok: true }]),
    event("minimax-h3", 2, [{ ok: false, reason: "quota_exhausted" }]),
    event("minimax-h3", 3, [{ ok: false, reason: "quota_exhausted" }, { ok: false, reason: "quota_exhausted" }]),
  ]);
  assert.deepEqual(signals.get("minimax-h3"), { status: "exhausted", consecutiveQuotaFailures: 3 });
});

test("尾部有成功 → 無信號（渠道活著）", () => {
  const signals = summarizeChannelBalance([
    event("m", 1, [{ ok: false, reason: "quota_exhausted" }]),
    event("m", 2, [{ ok: false, reason: "quota_exhausted" }]),
    event("m", 3, [{ ok: true }]),
  ]);
  assert.equal(signals.has("m"), false);
});

test("非欠費失敗收尾 → 不冒充欠費", () => {
  const signals = summarizeChannelBalance([
    event("m", 1, [{ ok: false, reason: "quota_exhausted" }]),
    event("m", 2, [{ ok: false, reason: "overloaded" }]),
    event("m", 3, [{ ok: false, reason: "overloaded" }]),
  ]);
  assert.equal(signals.has("m"), false);
});

test("單筆 quota_exhausted 不觸發（門檻 ≥2）", () => {
  const signals = summarizeChannelBalance([
    event("m", 1, [{ ok: true }]),
    event("m", 2, [{ ok: false, reason: "quota_exhausted" }]),
  ]);
  assert.equal(signals.has("m"), false);
});

test("事件亂序輸入仍按時間序判定（尾部欠費×2 → exhausted）", () => {
  const signals = summarizeChannelBalance([
    event("m", 3, [{ ok: false, reason: "quota_exhausted" }]),
    event("m", 1, [{ ok: true }]),
    event("m", 2, [{ ok: false, reason: "quota_exhausted" }]),
  ]);
  assert.deepEqual(signals.get("m"), { status: "exhausted", consecutiveQuotaFailures: 2 });
});
