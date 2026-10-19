// 运行时测 /api/admin/announcements：鉴权走真 requireAdminSession（不 mock），
// 做法逐字沿用 admin/model-pricing/route.test.ts 的轮子——patch next/headers 的
// cookies() exports，再 mint 一颗真 admin session token。
//
// 断言的是行为不是源码：没有 session 时三个方法都 401；有 session 时
// POST 建 → GET 列 → PATCH 改 真的落在同一份存储上。
//
// **执行器限定 tsx --test**（`npm test` 走它）：createRequire 拿到的是 next/headers
// 的 Node CJS 副本，vitest 会把 route 的 next/headers 经 Vite 图解析成另一个实例，
// patch 打不中 → session 永远缺席。repo 既有同款限制：model-pricing/route.test.ts
// 用同一招，同样只能在 node:test 下跑。其余两档（notification-store / notifications
// route）都是双执行器可跑。

import test, { after, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { NextRequest } from "next/server";

import { ADMIN_SESSION_COOKIE, createAdminSessionToken } from "../../../../lib/admin-auth";
import { __resetNotificationStoreForTests } from "../../../../lib/notification-store";
import { GET, PATCH, POST } from "./route";

const requireFn = createRequire(import.meta.url);
const nextHeaders = requireFn("next/headers") as { cookies: unknown };

process.env.ADMIN_SESSION_SECRET = "admin-announcements-test-secret";
process.env.ADMIN_USERNAME = "eimu";
delete process.env.BLOB_READ_WRITE_TOKEN;
delete process.env.IMAGE_DATA_BASE_URL;
delete process.env.IMAGE_DATA_API_KEY;
delete process.env.NODE_ENV;

let sessionToken: string | null = null;

function installCookieMock() {
  const store = new Map<string, string>();
  if (sessionToken) store.set(ADMIN_SESSION_COOKIE, sessionToken);
  // cookie store .get() 必须回 { name, value } 形状，否则 getAdminSession 的
  // `?.value` 拿到 undefined，永远当未登入。
  nextHeaders.cookies = async () => ({
    get: (name: string) => {
      const value = store.get(name);
      return value !== undefined ? { name, value } : undefined;
    },
  });
}

function mintToken(): string {
  return createAdminSessionToken("eimu", process.env.ADMIN_SESSION_SECRET as string);
}

function jsonRequest(method: string, payload?: unknown): NextRequest {
  return new NextRequest("http://localhost/api/admin/announcements", {
    method,
    headers: { "Content-Type": "application/json" },
    ...(payload === undefined ? {} : { body: JSON.stringify(payload) }),
  });
}

async function json(response: Response): Promise<Record<string, unknown>> {
  return (await response.json()) as Record<string, unknown>;
}

interface AnnouncementList {
  announcements: Array<{ id: string; title: string; enabled: boolean; surfaces: string[] }>;
  total: number;
}

beforeEach(() => {
  __resetNotificationStoreForTests();
  installCookieMock();
});

after(() => {
  sessionToken = null;
  installCookieMock();
});

test("无 session：GET/POST/PATCH 全部 401（不泄漏也不写入）", async () => {
  sessionToken = null;
  installCookieMock();

  const get = await GET(new NextRequest("http://localhost/api/admin/announcements") as never);
  assert.equal(get.status, 401);
  assert.equal((await json(get)).success, false);

  const post = await POST(jsonRequest("POST", { title: "占位标题", body: "占位正文" }) as never);
  assert.equal(post.status, 401);

  const patch = await PATCH(
    jsonRequest("PATCH", { id: "whatever", enabled: false }) as never,
  );
  assert.equal(patch.status, 401);

  // 确认未写入：即便带 session 再列，也还是空的。
  sessionToken = mintToken();
  installCookieMock();
  const list = await GET(new NextRequest("http://localhost/api/admin/announcements") as never);
  assert.equal(((await json(list)).data as AnnouncementList).total, 0);
});

test("有 session：POST 建 → GET 列（含停用项）→ PATCH 改", async () => {
  sessionToken = mintToken();
  installCookieMock();

  const created = await POST(
    jsonRequest("POST", {
      title: "占位标题",
      body: "占位正文",
      surfaces: ["inbox", "banner"],
      startsAt: "2026-09-01T00:00:00.000Z",
    }) as never,
  );
  assert.equal(created.status, 201);
  const createdBody = (await json(created)).data as { id: string; surfaces: string[] };
  assert.ok(createdBody.id);
  assert.deepEqual(createdBody.surfaces, ["inbox", "banner"]);

  // 缺标题/正文 → 400，不落库。
  const bad = await POST(jsonRequest("POST", { title: "  ", body: "占位" }) as never);
  assert.equal(bad.status, 400);

  const list = await GET(new NextRequest("http://localhost/api/admin/announcements") as never);
  const listBody = (await json(list)).data as AnnouncementList;
  assert.equal(listBody.total, 1);
  assert.equal(listBody.announcements[0].id, createdBody.id);

  const patched = await PATCH(
    jsonRequest("PATCH", { id: createdBody.id, enabled: false }) as never,
  );
  assert.equal(patched.status, 200);
  const patchedBody = (await json(patched)).data as { enabled: boolean; title: string };
  assert.equal(patchedBody.enabled, false);
  assert.equal(patchedBody.title, "占位标题");

  // 停用后 includeDisabled=0 的列表里不再出现；默认列表仍看得到（后台可回看）。
  const enabledOnly = await GET(
    new NextRequest("http://localhost/api/admin/announcements?includeDisabled=0") as never,
  );
  assert.equal(((await json(enabledOnly)).data as AnnouncementList).total, 0);

  const missing = await PATCH(jsonRequest("PATCH", { id: "不存在的-id" }) as never);
  assert.equal(missing.status, 404);
});

test("有 session：时间窗与受众由管理端显式设定，原样回读", async () => {
  sessionToken = mintToken();
  installCookieMock();

  const created = await POST(
    jsonRequest("POST", {
      title: "占位标题",
      body: "占位正文",
      startsAt: "2026-09-01T00:00:00.000Z",
      endsAt: "2026-09-30T00:00:00.000Z",
      audienceUserIds: [101, 202],
    }) as never,
  );
  const data = (await json(created)).data as {
    startsAt: string;
    endsAt: string;
    audienceUserIds: number[];
  };
  assert.equal(data.startsAt, "2026-09-01T00:00:00.000Z");
  assert.equal(data.endsAt, "2026-09-30T00:00:00.000Z");
  assert.deepEqual(data.audienceUserIds, [101, 202]);

  // 非法时间戳被丢弃（不猜时间），而不是整条拒绝。
  const noWindow = await POST(
    jsonRequest("POST", { title: "占位标题", body: "占位正文", startsAt: "不是时间" }) as never,
  );
  const noWindowData = (await json(noWindow)).data as { startsAt?: string };
  assert.equal(noWindowData.startsAt, undefined);
});
