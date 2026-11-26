import test from "node:test";
import assert from "node:assert/strict";

import { redeemTopupCode } from "./new-api-client.ts";

test("redeemTopupCode normalizes numeric new-api quota responses", async () => {
  const originalFetch = globalThis.fetch;
  let requestBody = "";

  globalThis.fetch = async (_input, init) => {
    requestBody = String(init?.body ?? "");
    return new Response(JSON.stringify({ success: true, data: 500000 }), {
      status: 200,
      headers: { "Content-Type": "application/json" },
    });
  };

  try {
    const result = await redeemTopupCode("token", "CDK-1");

    assert.equal(result.success, true);
    assert.deepEqual(result.data, { quota: 500000 });
    assert.equal(JSON.parse(requestBody).key, "CDK-1");
  } finally {
    globalThis.fetch = originalFetch;
  }
});
