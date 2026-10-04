import test from "node:test";
import assert from "node:assert/strict";

import { getGatewayBaseUrl } from "./new-api-auth-server.ts";

const originalNodeEnv = process.env.NODE_ENV;
const originalGateway = process.env.GATEWAY_BASE_URL;

function restoreEnv() {
  if (originalNodeEnv === undefined) delete process.env.NODE_ENV;
  else process.env.NODE_ENV = originalNodeEnv;
  if (originalGateway === undefined) delete process.env.GATEWAY_BASE_URL;
  else process.env.GATEWAY_BASE_URL = originalGateway;
}

// A3（2026-10-04）：钱路不得静默回退到硬编码网关默认值。旧实现在 env 缺失时静默
// 回退（2026-09-19 IMGMU7UH9SFF9A21D 每笔实单被打成 500）。生产缺配置必须大声失败。
test("getGatewayBaseUrl throws in production when GATEWAY_BASE_URL is missing", () => {
  try {
    process.env.NODE_ENV = "production";
    delete process.env.GATEWAY_BASE_URL;
    assert.throws(() => getGatewayBaseUrl(), /GATEWAY_BASE_URL/);
  } finally {
    restoreEnv();
  }
});

test("getGatewayBaseUrl returns the configured value (trimmed)", () => {
  try {
    process.env.GATEWAY_BASE_URL = "  https://gateway.test/newapi  ";
    assert.equal(getGatewayBaseUrl(), "https://gateway.test/newapi");
  } finally {
    restoreEnv();
  }
});

test("getGatewayBaseUrl keeps the localhost fallback outside production", () => {
  try {
    process.env.NODE_ENV = "development";
    delete process.env.GATEWAY_BASE_URL;
    assert.equal(getGatewayBaseUrl(), "http://localhost:3001");
  } finally {
    restoreEnv();
  }
});