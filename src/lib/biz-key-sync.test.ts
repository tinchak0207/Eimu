import test from "node:test";
import assert from "node:assert/strict";

import {
  bizKeySyncConfig,
  signBizKeySync,
  verifyBizKeySync,
} from "./biz-key-sync.ts";
import { signBillingRelayRequest } from "./generation-core/billing-relay.ts";

const SECRET = "test-shared-secret";

test("a correctly signed request verifies", () => {
  const timestamp = String(Date.now());
  const rawBody = JSON.stringify({ op: "list" });
  const signature = signBizKeySync(SECRET, timestamp, rawBody);

  assert.equal(verifyBizKeySync({ secret: SECRET, timestamp, signature, rawBody }), true);
});

test("a tampered body fails verification", () => {
  const timestamp = String(Date.now());
  const signature = signBizKeySync(SECRET, timestamp, JSON.stringify({ op: "delete", id: "a" }));

  assert.equal(
    verifyBizKeySync({ secret: SECRET, timestamp, signature, rawBody: JSON.stringify({ op: "delete", id: "b" }) }),
    false,
  );
});

test("a wrong secret fails verification", () => {
  const timestamp = String(Date.now());
  const rawBody = JSON.stringify({ op: "list" });
  const signature = signBizKeySync("other-secret", timestamp, rawBody);

  assert.equal(verifyBizKeySync({ secret: SECRET, timestamp, signature, rawBody }), false);
});

test("stale timestamps are rejected outside the skew window", () => {
  const rawBody = JSON.stringify({ op: "list" });
  const stale = String(Date.now() - 6 * 60_000);
  const signature = signBizKeySync(SECRET, stale, rawBody);

  assert.equal(verifyBizKeySync({ secret: SECRET, timestamp: stale, signature, rawBody }), false);

  // 窗口内（1 分钟前）仍然通过：时钟允许小幅偏差。
  const fresh = String(Date.now() - 60_000);
  assert.equal(
    verifyBizKeySync({ secret: SECRET, timestamp: fresh, signature: signBizKeySync(SECRET, fresh, rawBody), rawBody }),
    true,
  );
});

test("missing timestamp or signature fails closed", () => {
  const rawBody = JSON.stringify({ op: "list" });
  const timestamp = String(Date.now());
  const signature = signBizKeySync(SECRET, timestamp, rawBody);

  assert.equal(verifyBizKeySync({ secret: SECRET, timestamp: null, signature, rawBody }), false);
  assert.equal(verifyBizKeySync({ secret: SECRET, timestamp, signature: null, rawBody }), false);
  assert.equal(verifyBizKeySync({ secret: "", timestamp, signature, rawBody }), false);
});

/**
 * 两个方向共用同一把密钥，靠域分隔前缀区分。
 * 少了这层分隔，控制面→Vercel 的扣费报文可以被重放成
 * Vercel→控制面的密钥写入。
 */
test("billing relay signatures are not accepted as key-sync signatures", () => {
  const timestamp = String(Date.now());
  const rawBody = JSON.stringify({ op: "list" });
  const relaySignature = signBillingRelayRequest(SECRET, timestamp, rawBody);

  assert.notEqual(relaySignature, signBizKeySync(SECRET, timestamp, rawBody));
  assert.equal(verifyBizKeySync({ secret: SECRET, timestamp, signature: relaySignature, rawBody }), false);
});

test("sync config requires both the origin and the shared secret", () => {
  assert.equal(bizKeySyncConfig({} as NodeJS.ProcessEnv), null);
  assert.equal(
    bizKeySyncConfig({ GENERATION_CONTROL_PLANE_PROXY_ORIGIN: "https://example.test" } as NodeJS.ProcessEnv),
    null,
  );
  assert.equal(
    bizKeySyncConfig({ GENERATION_BILLING_RELAY_SECRET: SECRET } as NodeJS.ProcessEnv),
    null,
  );

  const config = bizKeySyncConfig({
    GENERATION_CONTROL_PLANE_PROXY_ORIGIN: "https://example.test/",
    GENERATION_BILLING_RELAY_SECRET: SECRET,
  } as NodeJS.ProcessEnv);
  assert.equal(config?.url, "https://example.test/image-control/api/internal/biz-keys");
  assert.equal(config?.secret, SECRET);
});
