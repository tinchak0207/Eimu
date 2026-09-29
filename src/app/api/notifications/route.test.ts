// 运行时（不是源码字串检查）测 /api/notifications 这一族路由的**按用户隔离**。
//
// 做法：
// - 起一个本地假网关实现 /api/user/self，Authorization → 用户 id 的映射在假网关里；
//   它同时校验 New-Api-User 必须等于令牌所有者，模拟真上游「拒绝令牌持有者 ≠ 头里声称 id」。
//   于是路由拿到的 id 只可能来自校验，客户端自称的 x-user-id 无法冒领别人的数据。
// - GATEWAY_BASE_URL 指向该假网关；NEXT_PUBLIC_LOCAL_TEST_MODE 未设，走真鉴权分支。
// - 存储走记忆体模式（无 blob 后端），可重现、不碰外部存储。
//
// 已读隔离是本片核心判据：A 标记已读后 B 的未读数与已读位必须原封不动。

// 与仓库其余测试一致走 node:test（npm test = tsx --test）；vitest.config.mts 开了
// globals，这里以 globalThis.* 优先、fallback node:test.*，让同一份测试在两种
// 执行器下都能注册（范式抄 src/lib/video-frames.test.ts）。

import assert from "node:assert/strict";
import * as nodeTest from "node:test";

type TestFn = (name: string, fn: () => void | Promise<void>) => unknown;
type HookFn = (fn: () => void | Promise<void>) => unknown;
const globals = globalThis as unknown as {
  test?: TestFn;
  beforeAll?: HookFn;
  afterAll?: HookFn;
  beforeEach?: HookFn;
};
const test = globals.test ?? (nodeTest.test as unknown as TestFn);
const before = globals.beforeAll ?? (nodeTest.before as unknown as HookFn);
const after = globals.afterAll ?? (nodeTest.after as unknown as HookFn);
const beforeEach = globals.beforeEach ?? (nodeTest.beforeEach as unknown as HookFn);
import { createServer, type Server } from "node:http";
import { NextRequest } from "next/server";

import { GET as getNotifications } from "./route";
import { POST as markRead } from "./mark-read/route";
import { GET as getBanners } from "./banners/route";
import { GET as getActiveModal } from "./active-modal/route";
import {
  __resetNotificationStoreForTests,
  createAnnouncement,
  createNotification,
} from "../../../lib/notification-store";

/** 假网关的令牌 → 用户映射。 */
const TOKENS: Record<string, { id: number; username: string }> = {
  "Bearer token-a": { id: 101, username: "user-a" },
  "Bearer token-b": { id: 202, username: "user-b" },
};

const USER_A = 101;
const USER_B = 202;

let server: Server | null = null;
let port = 0;

before(async () => {
  delete process.env.NEXT_PUBLIC_LOCAL_TEST_MODE;
  delete process.env.BLOB_READ_WRITE_TOKEN;
  delete process.env.IMAGE_DATA_BASE_URL;
  delete process.env.IMAGE_DATA_API_KEY;

  server = createServer((req, res) => {
    res.setHeader("content-type", "application/json");
    if (req.url !== "/api/user/self") {
      res.statusCode = 404;
      res.end(JSON.stringify({ success: false, message: "not found" }));
      return;
    }
    const owner = TOKENS[req.headers.authorization ?? ""];
    const claimed = Number(req.headers["new-api-user"] ?? "");
    if (!owner || owner.id !== claimed) {
      res.statusCode = 401;
      res.end(JSON.stringify({ success: false, message: "Token 与用户不匹配。" }));
      return;
    }
    res.statusCode = 200;
    res.end(
      JSON.stringify({
        success: true,
        data: { ...owner, quota: 1_000_000, used_quota: 0 },
      }),
    );
  });
  await new Promise<void>((resolve) => server?.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  port = typeof address === "object" && address ? address.port : 0;
  process.env.GATEWAY_BASE_URL = `http://127.0.0.1:${port}`;
});

after(async () => {
  await new Promise<void>((resolve) => server?.close(() => resolve()));
});

beforeEach(() => {
  __resetNotificationStoreForTests();
});

/** 以某个令牌 + 自称 id 组一个请求。 */
function request(path: string, token: string | null, claimedUserId: number | null, init: RequestInit = {}) {
  const headers = new Headers(init.headers);
  if (token) headers.set("Authorization", token);
  if (claimedUserId !== null) headers.set("x-user-id", String(claimedUserId));
  return new NextRequest(`http://localhost${path}`, { ...init, headers });
}

async function body(response: Response): Promise<Record<string, unknown>> {
  return (await response.json()) as Record<string, unknown>;
}

interface InboxData {
  notifications: Array<{ id: string; kind: string; read: boolean }>;
  total: number;
  unreadCount: number;
}

// ── 鉴权 ───────────────────────────────────────────────────────

test("未带令牌 → 401；令牌与自称 id 不符 → 401（不能冒领别人的 id）", async () => {
  const anonymous = await getNotifications(request("/api/notifications", null, null));
  assert.equal(anonymous.status, 401);

  // 拿 A 的令牌自称 B 的 id：上游会拒，路由不得放行。
  const spoofed = await getNotifications(request("/api/notifications", "Bearer token-a", USER_B));
  assert.equal(spoofed.status, 401);
  assert.equal((await body(spoofed)).success, false);

  // 没有令牌但自称 id → 401。
  const noToken = await getNotifications(request("/api/notifications", null, USER_A));
  assert.equal(noToken.status, 401);
});

// ── 跨用户隔离（HTTP 面）───────────────────────────────────────

test("HTTP 面跨用户隔离：个人通知只进目标用户，A 标记已读后 B 不受影响", async () => {
  const mine = await createNotification(USER_A, { title: "占位标题", body: "占位正文" });

  const listA = await getNotifications(request("/api/notifications?pageSize=20", "Bearer token-a", USER_A));
  assert.equal(listA.status, 200);
  const dataA = (await body(listA)).data as InboxData;
  assert.equal(dataA.total, 1);
  assert.equal(dataA.notifications[0].id, mine.id);
  assert.equal(dataA.notifications[0].read, false);
  assert.equal(dataA.unreadCount, 1);

  const listB = await getNotifications(request("/api/notifications?pageSize=20", "Bearer token-b", USER_B));
  const dataB = (await body(listB)).data as InboxData;
  assert.equal(dataB.total, 0);
  assert.equal(dataB.unreadCount, 0);

  const marked = await markRead(
    request("/api/notifications/mark-read", "Bearer token-a", USER_A, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ notificationIds: [mine.id] }),
    }),
  );
  assert.equal(marked.status, 200);
  assert.equal(((await body(marked)).data as { unreadCount: number }).unreadCount, 0);

  // 真读两遍：A 归零是重算出来的；B 从头到尾没被碰过。
  const afterA = (await body(
    await getNotifications(request("/api/notifications", "Bearer token-a", USER_A)),
  )).data as InboxData;
  assert.equal(afterA.unreadCount, 0);
  assert.equal(afterA.notifications[0].read, true);

  const afterB = (await body(
    await getNotifications(request("/api/notifications", "Bearer token-b", USER_B)),
  )).data as InboxData;
  assert.equal(afterB.total, 0);
  assert.equal(afterB.unreadCount, 0);
});

test("HTTP 面公告时间窗：窗外公告不进列表，窗内进列表且两用户各自未读", async () => {
  const now = new Date();
  const inWindow = await createAnnouncement({
    title: "占位标题",
    body: "占位正文",
    surfaces: ["inbox"],
    startsAt: new Date(now.getTime() - 60_000).toISOString(),
    endsAt: new Date(now.getTime() + 3_600_000).toISOString(),
  });
  await createAnnouncement({
    title: "占位标题",
    body: "占位正文",
    surfaces: ["inbox"],
    startsAt: new Date(now.getTime() + 3_600_000).toISOString(),
  });

  const listA = (await body(
    await getNotifications(request("/api/notifications", "Bearer token-a", USER_A)),
  )).data as InboxData;
  assert.deepEqual(listA.notifications.map((item) => item.id), [inWindow.id]);
  assert.equal(listA.unreadCount, 1);

  const listB = (await body(
    await getNotifications(request("/api/notifications", "Bearer token-b", USER_B)),
  )).data as InboxData;
  // 公告是平台级：B 也看得到（未读是各自的）。
  assert.equal(listB.unreadCount, 1);

  // A 读掉之后 B 仍是未读。
  await markRead(
    request("/api/notifications/mark-read", "Bearer token-a", USER_A, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ announcementIds: [inWindow.id] }),
    }),
  );
  const afterA = (await body(
    await getNotifications(request("/api/notifications", "Bearer token-a", USER_A)),
  )).data as InboxData;
  const afterB = (await body(
    await getNotifications(request("/api/notifications", "Bearer token-b", USER_B)),
  )).data as InboxData;
  assert.equal(afterA.unreadCount, 0);
  assert.equal(afterB.unreadCount, 1);
});

test("HTTP 面横幅与弹窗：生效面各自的令牌只看得到自己该看的", async () => {
  const banner = await createAnnouncement({
    title: "占位标题",
    body: "占位正文",
    surfaces: ["banner"],
  });
  const modal = await createAnnouncement({
    title: "占位标题",
    body: "占位正文",
    surfaces: ["modal"],
  });
  // inbox 面的公告不该出现在横幅/弹窗端点。
  await createAnnouncement({ title: "占位标题", body: "占位正文", surfaces: ["inbox"] });

  const banners = (await body(
    await getBanners(request("/api/notifications/banners", "Bearer token-a", USER_A)),
  )).data as { banners: Array<{ id: string }> };
  assert.deepEqual(banners.banners.map((item) => item.id), [banner.id]);

  const active = (await body(
    await getActiveModal(request("/api/notifications/active-modal", "Bearer token-b", USER_B)),
  )).data as { modal: { id: string } | null };
  assert.equal(active.modal?.id, modal.id);

  // 未登入不得读到弹窗。
  assert.equal((await getActiveModal(request("/api/notifications/active-modal", null, null))).status, 401);
});
