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
