import assert from "node:assert/strict";
import test from "node:test";
import { __resetSupplierHealthSignalCacheForTests, readSupplierHealthSignal } from "./supplier-health-signal.js";

type Row = Record<string, unknown>;

function row(overrides: Row = {}): Row {
  return {
    public_model_id: "seedance-2.0",
    kind: "video_generate",
    has_healthy: true,
    reason: "执行侧无可用供应商",
    ...overrides,
  };
}

function fakeSql(rows: Row[]) {
  return (async (strings: TemplateStringsArray, ...args: unknown[]) => {
    void strings;
    void args;
    return rows;
  }) as never;
}

test("执行侧有健康供应商 → availableByModel=true", async () => {
  __resetSupplierHealthSignalCacheForTests();
  const signal = await readSupplierHealthSignal(fakeSql([row()]), { enabled: true });
  assert.equal(signal.availableByModel["seedance-2.0:video_generate"], true);
  assert.equal(signal.reasonByModel["seedance-2.0:video_generate"], undefined);
});

test("执行侧无健康供应商（has_healthy=false）→ false + 带原因", async () => {
  __resetSupplierHealthSignalCacheForTests();
  const signal = await readSupplierHealthSignal(fakeSql([row({ has_healthy: false })]), { enabled: true });
  assert.equal(signal.availableByModel["seedance-2.0:video_generate"], false);
  assert.equal(signal.reasonByModel["seedance-2.0:video_generate"], "执行侧无可用供应商");
});

test("DB 抛错 → fail-open 空信号（不挡 model-status）", async () => {
  __resetSupplierHealthSignalCacheForTests();
  const boom = (async () => {
    throw new Error("db down");
  }) as never;
  const signal = await readSupplierHealthSignal(boom, { enabled: true });
  assert.equal(Object.keys(signal.availableByModel).length, 0);
});

test("H4：零樣本 → probe_only；近期成功 → high；陳舊成功 → low", async () => {
  const { classifyEvidence } = await import("./supplier-health-signal.js");
  const now = Date.parse("2026-10-02T00:00:00Z");
  assert.equal(classifyEvidence(undefined, now), "probe_only");
  assert.equal(classifyEvidence({ successCount: 0, lastSuccessAt: null }, now), "probe_only");
  assert.equal(classifyEvidence({ successCount: 5, lastSuccessAt: "2026-10-01T20:00:00Z" }, now), "high");
  assert.equal(classifyEvidence({ successCount: 5, lastSuccessAt: "2026-09-20T00:00:00Z" }, now), "low");
});

test("H4：餘額為 0 的供應商 → 不可用（即使前置條件過），並帶 evidence", async () => {
  __resetSupplierHealthSignalCacheForTests();
  const signal = await readSupplierHealthSignal(
    fakeSql([row({ zero_balance: true, success_count: 0, last_success_at: null })]),
    { enabled: true },
  );
  assert.equal(signal.availableByModel["seedance-2.0:video_generate"], false);
  assert.match(signal.reasonByModel["seedance-2.0:video_generate"], /余额为 0/);
  assert.equal(signal.evidenceByModel?.["seedance-2.0:video_generate"]?.zeroBalance, true);
});

test("H4：available 保留且帶 evidence（向後相容）", async () => {
  __resetSupplierHealthSignalCacheForTests();
  const signal = await readSupplierHealthSignal(
    fakeSql([row({ success_count: "3", last_success_at: "2026-10-01T00:00:00Z" })]),
    { enabled: true },
  );
  assert.equal(signal.availableByModel["seedance-2.0:video_generate"], true);
  assert.equal(signal.evidenceByModel?.["seedance-2.0:video_generate"]?.successCount, 3);
});
