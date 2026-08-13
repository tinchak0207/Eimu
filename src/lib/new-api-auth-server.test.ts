import test from "node:test";
import assert from "node:assert/strict";

import { getGatewayBaseUrl } from "./new-api-auth-server.ts";

test("getGatewayBaseUrl falls back to production backend IP when env is missing", () => {
  const originalNodeEnv = process.env.NODE_ENV;
  const originalGateway = process.env.GATEWAY_BASE_URL;

  process.env.NODE_ENV = "production";
  delete process.env.GATEWAY_BASE_URL;

  assert.equal(getGatewayBaseUrl(), "http://43.172.85.76");

  process.env.NODE_ENV = originalNodeEnv;
  if (originalGateway === undefined) {
    delete process.env.GATEWAY_BASE_URL;
  } else {
    process.env.GATEWAY_BASE_URL = originalGateway;
  }
});
