// POST /v1/team/seats/allocate 路由契约测试（鉴权 / 控制面未配置时 fail-closed 不印额度）。

import assert from "node:assert/strict";
import test from "node:test";
import { NextRequest } from "next/server";

import { hashBizApiKey } from "@/lib/biz-api-keys";
import { __resetBizKeyStoreForTests } from "@/lib/biz-api-key-store";

import { POST } from "./route";

const VALID_KEY = `sk-biz-${"c3d4e5f60718293a".repeat(2)}`;
const AUTH = { authorization: `Bearer ${VALID_KEY}` };

function reset() {
  delete process.env.GENERATION_DATABASE_URL;
  delete process.env.DATABASE_URL;
  delete process.env.GENERATION_CONTROL_PLANE_ENABLED;
  process.env.BIZ_API_KEY_HASHES = `${hashBizApiKey(VALID_KEY)}:117`;
  __resetBizKeyStoreForTests();
}

function req(init: { headers?: Record<string, string>; body?: unknown } = {}): NextRequest {
  const headers = new Headers(init.headers);
  if (init.body !== undefined) headers.set("content-type", "application/json");
  return new NextRequest("http://localhost/api/v1/team/seats/allocate", {
    method: "POST",
    headers,
    body: init.body === undefined ? undefined : JSON.stringify(init.body),
  });
}

async function bodyOf(response: Response) {
  return (await response.json()) as {
    success?: boolean;
    error?: { code: string; message: string };
    transferred_quota?: number;
  };
}

test("未带密钥 → 401（不得分配）", async () => {
  reset();
  const response = await POST(req({ body: { member_user_id: 900, seats: 5, per_seat_coins: 40 } }));
  assert.equal(response.status, 401);
  assert.equal((await bodyOf(response)).success, false);
});

test("控制面未配置 → 503 fail-closed：不落任何本地点数、不回成功", async () => {
  reset();
  const response = await POST(req({ headers: AUTH, body: { member_user_id: 900, seats: 5, per_seat_coins: 40 } }));
  assert.equal(response.status, 503);
  const body = await bodyOf(response);
  assert.equal(body.success, false);
  assert.equal(body.error?.code, "allocation_unavailable");
  assert.equal(body.transferred_quota, undefined, "失败时不得回任何转移数字");
});

test("非法 JSON / 非正整数席位 → 400", async () => {
  reset();
  const badJson = await POST(
    new NextRequest("http://localhost/api/v1/team/seats/allocate", {
      method: "POST",
      headers: new Headers(AUTH),
      body: "{",
    }),
  );
  assert.equal(badJson.status, 400);
  assert.equal((await bodyOf(badJson)).error?.code, "invalid_json");
});
