import test from "node:test";
import assert from "node:assert/strict";

import {
  buildMapayOrderParam,
  parseMapayOrderParam,
  resolveMapayOrderBinding,
} from "./mapay-order-param.ts";

const SECRET = "test-secret-not-a-real-key";
const ENV = { GENERATION_BILLING_RELAY_SECRET: SECRET };

test("buildMapayOrderParam is three segments and round-trips", () => {
  const param = buildMapayOrderParam("popular", 253, SECRET);
  assert.equal(param.split(".").length, 3);
  assert.match(param, /^popular\.253\.[0-9a-f]{8}$/);

  const parsed = parseMapayOrderParam(param, SECRET);
  assert.deepEqual(parsed, { planId: "popular", userId: 253 });
});

test("custom plan id (custom:<coins>) survives the round-trip", () => {
  const param = buildMapayOrderParam("custom:20000", 82, SECRET);
  assert.deepEqual(parseMapayOrderParam(param, SECRET), { planId: "custom:20000", userId: 82 });
});

test("wrong secret is rejected", () => {
  const param = buildMapayOrderParam("starter", 117, SECRET);
  assert.equal(parseMapayOrderParam(param, "another-secret"), null);
});

test("tampered userId is rejected (signature stays bound to the original user)", () => {
  const param = buildMapayOrderParam("popular", 253, SECRET);
  const tampered = param.replace(".253.", ".254.");
  assert.notEqual(tampered, param);
  assert.equal(parseMapayOrderParam(tampered, SECRET), null);
});

test("tampered planId and tampered signature are rejected", () => {
  const param = buildMapayOrderParam("popular", 253, SECRET);
  assert.equal(parseMapayOrderParam(param.replace("popular", "pro"), SECRET), null);
  const [, , sig] = param.split(".");
  const flipped = (sig[0] === "0" ? "1" : "0") + sig.slice(1);
  assert.equal(parseMapayOrderParam(`popular.253.${flipped}`, SECRET), null);
});

test("legacy param / malformed values fall through to null (old flow unchanged)", () => {
  for (const legacy of ["popular", "starter", "custom:20000", "", "  ", "popular.253", "popular.253.", ".253.deadbeef"]) {
    assert.equal(parseMapayOrderParam(legacy, SECRET), null, `expected null for ${JSON.stringify(legacy)}`);
  }
  assert.equal(parseMapayOrderParam(null, SECRET), null);
  assert.equal(parseMapayOrderParam(undefined, SECRET), null);
});

test("resolveMapayOrderBinding: only a well-signed param is bound; everything else takes the old flow", () => {
  const bound = buildMapayOrderParam("pro", 117, SECRET);
  assert.deepEqual(resolveMapayOrderBinding(bound, ENV), { planId: "pro", userId: 117 });

  // 舊格式（未登入下單）＝未綁
  for (const legacy of ["popular", "custom:20000", null, undefined]) {
    assert.equal(resolveMapayOrderBinding(legacy, ENV), null, `expected unbound for ${JSON.stringify(legacy)}`);
  }
  // 驗簽失敗／篡改 userId＝未綁（走舊流程，絕不把額度記到錯的人頭上）
  assert.equal(resolveMapayOrderBinding(bound.replace(".117.", ".118."), ENV), null);
  assert.equal(resolveMapayOrderBinding(buildMapayOrderParam("pro", 117, "other"), ENV), null);
  // 密鑰未配置＝未綁
  assert.equal(resolveMapayOrderBinding(bound, {}), null);
});