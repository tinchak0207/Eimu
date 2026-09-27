import test from "node:test";
import assert from "node:assert/strict";

import { ensureGatewayUserForOAuth } from "./gateway-admin.ts";

/**
 * 站点 OAuth 建号改走上游管理员建号 API（为关闭自助注册做准备）。
 *
 * 这里用真桩 fetch 跑真分支，不做源碼字串断言：决定行为的是「先查后建、
 * 已存在算复用、其他失败才抛」这条分流，只有真呼叫才能证。
 */

type Call = {
  url: string;
  method: string;
  headers: Record<string, string>;
  body: string | null;
};

function jsonResponse(payload: unknown): Response {
  return {
    status: 200,
    text: async () => JSON.stringify(payload),
  } as unknown as Response;
}

function withStubbedGateway(responder: (call: Call) => Response) {
  const saved = {
    fetch: globalThis.fetch,
    token: process.env.GATEWAY_ADMIN_ACCESS_TOKEN,
    userId: process.env.GATEWAY_ADMIN_USER_ID,
    base: process.env.GATEWAY_BASE_URL,
  };
  const calls: Call[] = [];

  process.env.GATEWAY_ADMIN_ACCESS_TOKEN = "test-admin-token";
  process.env.GATEWAY_ADMIN_USER_ID = "1";
  process.env.GATEWAY_BASE_URL = "https://gateway.test";

  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const call: Call = {
      url: String(input),
      method: init?.method ?? "GET",
      headers: (init?.headers ?? {}) as Record<string, string>,
      body: typeof init?.body === "string" ? init.body : null,
    };
    calls.push(call);
    return responder(call);
  }) as typeof fetch;

  return {
    calls,
    restore() {
      globalThis.fetch = saved.fetch;
      if (saved.token === undefined) delete process.env.GATEWAY_ADMIN_ACCESS_TOKEN;
      else process.env.GATEWAY_ADMIN_ACCESS_TOKEN = saved.token;
      if (saved.userId === undefined) delete process.env.GATEWAY_ADMIN_USER_ID;
      else process.env.GATEWAY_ADMIN_USER_ID = saved.userId;
      if (saved.base === undefined) delete process.env.GATEWAY_BASE_URL;
      else process.env.GATEWAY_BASE_URL = saved.base;
    },
  };
}

function userSearch(username: string, found: boolean): Response {
  return jsonResponse({
    success: true,
    data: found ? [{ id: 7, username, quota: 0 }] : [],
  });
}

test("existing upstream account is reused without any create call", async () => {
  const stub = withStubbedGateway((call) => userSearch("github_12345678", true));
  try {
    const result = await ensureGatewayUserForOAuth({
      username: "github_12345678",
      password: "Gh0123456789abcd",
    });
    assert.deepEqual(result, { created: false });
    assert.equal(stub.calls.length, 1, "命中已存在时只应有一次查询");
    assert.ok(stub.calls[0].url.includes("/api/user/search?keyword=github_12345678"));
  } finally {
    stub.restore();
  }
});

test("missing account is created via the admin create API with the admin headers", async () => {
  const stub = withStubbedGateway((call) =>
    call.method === "POST" ? jsonResponse({ success: true }) : userSearch("wx_abcdef0123456789", false),
  );
  try {
    const result = await ensureGatewayUserForOAuth({
      username: "wx_abcdef0123456789",
      password: "Wx0123456789abcd",
    });
    assert.deepEqual(result, { created: true });

    const create = stub.calls.find((call) => call.method === "POST");
    assert.ok(create, "未命中时必须调用建号 API");
    assert.ok(create.url.endsWith("/api/user/"), `建号端点应为 /api/user/，实为 ${create.url}`);
    assert.equal(create.headers.Authorization, "Bearer test-admin-token");
    assert.equal(create.headers["New-Api-User"], "1");
    // 逐字保持旧 register 路径的 body：只有 username / password，无 display_name、无 email。
    assert.deepEqual(JSON.parse(create.body ?? "{}"), {
      username: "wx_abcdef0123456789",
      password: "Wx0123456789abcd",
    });
  } finally {
    stub.restore();
  }
});

test("create rejected with an already-exists message is treated as reuse", async () => {
  for (const message of [
    "用户已存在",
    "User already exists",
    "该用户名已被使用",
    "用户名被占用",
  ]) {
    const stub = withStubbedGateway((call) =>
      call.method === "POST" ? jsonResponse({ success: false, message }) : userSearch("github_1", false),
    );
    try {
      const result = await ensureGatewayUserForOAuth({ username: "github_1", password: "Gh0123456789abcd" });
      assert.deepEqual(result, { created: false }, `message=${message} 应判为复用`);
    } finally {
      stub.restore();
    }
  }
});

test("other create failures throw with the upstream message", async () => {
  const stub = withStubbedGateway((call) =>
    call.method === "POST"
      ? jsonResponse({ success: false, message: "New user registration has been disabled by administrator" })
      : userSearch("github_1", false),
  );
  try {
    await assert.rejects(
      ensureGatewayUserForOAuth({ username: "github_1", password: "Gh0123456789abcd" }),
      /registration has been disabled/,
    );
  } finally {
    stub.restore();
  }
});

test("over-length username throws before touching the gateway", async () => {
  const stub = withStubbedGateway(() => userSearch("google_110234567890123456789", false));
  try {
    await assert.rejects(
      ensureGatewayUserForOAuth({ username: "google_110234567890123456789", password: "Gg0123456789abcd" }),
      /用户名最长 20 个字符/,
    );
    assert.equal(stub.calls.length, 0, "超长用户名不应发出任何上游请求");
  } finally {
    stub.restore();
  }
});
