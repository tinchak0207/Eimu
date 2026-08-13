import test from "node:test";
import assert from "node:assert/strict";

import { QUOTA_PER_COIN } from "./new-api-client.ts";
import {
  fulfillMapayRedemption,
  mapayOrderRedemptionName,
  type NewApiRedemption,
} from "./mapay-redemption.ts";

function json(data: unknown, status = 200) {
  return new Response(JSON.stringify(data), { status, headers: { "Content-Type": "application/json" } });
}

test("mapayOrderRedemptionName stays within new-api's 20 character name limit", () => {
  assert.equal(mapayOrderRedemptionName("IMG1760000000000ABCDEFGH"), "MP0000000000ABCDEFGH");
  assert.equal(mapayOrderRedemptionName("SHORT"), "MPSHORT");
  assert.ok(mapayOrderRedemptionName("IMG1760000000000ABCDEFGH").length <= 20);
});

test("fulfillMapayRedemption creates one cdk using plan image credits as quota units", async () => {
  const calls: Array<{ url: string; init?: RequestInit }> = [];
  const fetcher = async (url: string | URL | Request, init?: RequestInit) => {
    calls.push({ url: String(url), init });
    if (String(url).includes("/api/redemption/search")) {
      return json({ success: true, data: { items: [] } });
    }
    return json({ success: true, data: ["CDK-NEW"] });
  };

  const result = await fulfillMapayRedemption(
    {
      orderId: "IMG1760000000000ABCDEFGH",
      plan: { id: "starter", name: "梦芽 · 轻度尝鲜包", price: 9.9, coins: 100 },
    },
    {
      GATEWAY_BASE_URL: "https://new-api.example",
      GATEWAY_ADMIN_ACCESS_TOKEN: "adm",
      GATEWAY_ADMIN_USER_ID: "1",
    },
    fetcher,
  );

  const createBody = JSON.parse(String(calls[1].init?.body));
  assert.deepEqual(result, { key: "CDK-NEW", created: true });
  assert.equal(createBody.name, "MP0000000000ABCDEFGH");
  assert.equal(createBody.count, 1);
  assert.equal(createBody.quota, 100 * QUOTA_PER_COIN);
});

test("fulfillMapayRedemption reuses an existing cdk for duplicate callbacks", async () => {
  const existing: NewApiRedemption = {
    id: 1,
    key: "CDK-EXISTING",
    name: "MP0000000000ABCDEFGH",
    quota: 100 * QUOTA_PER_COIN,
    status: 1,
  };
  const calls: string[] = [];
  const fetcher = async (url: string | URL | Request) => {
    calls.push(String(url));
    return json({ success: true, data: { items: [existing] } });
  };

  const result = await fulfillMapayRedemption(
    {
      orderId: "IMG1760000000000ABCDEFGH",
      plan: { id: "starter", name: "梦芽 · 轻度尝鲜包", price: 9.9, coins: 100 },
    },
    {
      GATEWAY_BASE_URL: "https://new-api.example",
      GATEWAY_ADMIN_ACCESS_TOKEN: "adm",
      GATEWAY_ADMIN_USER_ID: "1",
    },
    fetcher,
  );

  assert.deepEqual(result, { key: "CDK-EXISTING", created: false });
  assert.equal(calls.length, 1);
});
