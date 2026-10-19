import test from "node:test";
import assert from "node:assert/strict";

import { estimateCoins, exceedsBudget } from "./task-budget.ts";
import { generationCoins } from "./generation-model-catalog/pricing.ts";

test("estimateCoins reads catalog credits/10 (concrete catalog anchor)", () => {
  // catalog: gpt-image-2 imageCredits 1k=10, 4k=80 ⇒ 1 币 / 8 币
  assert.equal(estimateCoins("gpt-image-2", { resolution: "1k" }), 1);
  assert.equal(estimateCoins("gpt-image-2", { resolution: "4k" }), 8);
});

test("estimateCoins stays in lockstep with the single pricing source", () => {
  for (const modelId of ["gpt-image-2", "gemini-3.1-flash-image"]) {
    assert.equal(estimateCoins(modelId), generationCoins(modelId), `mismatch for ${modelId}`);
  }
});

test("unknown model falls back to the catalog default (documented, not a silent 0)", () => {
  assert.equal(estimateCoins("no-such-model-xyz"), generationCoins("no-such-model-xyz"));
});

test("exceedsBudget is disabled when no cap is configured (today's behaviour)", () => {
  assert.equal(exceedsBudget(9_999, undefined), false);
  assert.equal(exceedsBudget(9_999, null), false);
});

test("exceedsBudget compares against the cap with strict greater-than", () => {
  assert.equal(exceedsBudget(5, 5), false);
  assert.equal(exceedsBudget(5.01, 5), true);
  assert.equal(exceedsBudget(0, 0), false);
  assert.equal(exceedsBudget(1, 0), true);
});

test("exceedsBudget never trips on non-finite inputs (no false blocking)", () => {
  assert.equal(exceedsBudget(Number.NaN, 10), false);
  assert.equal(exceedsBudget(Number.POSITIVE_INFINITY, 10), false);
  assert.equal(exceedsBudget(5, Number.NaN), false);
  assert.equal(exceedsBudget(5, Number.POSITIVE_INFINITY), false);
});
