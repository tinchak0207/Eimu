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
  beforeEach?: HookFn;
};
const test = globals.test ?? (nodeTest.test as unknown as TestFn);
const beforeEach = globals.beforeEach ?? (nodeTest.beforeEach as unknown as HookFn);
import {
  __resetNotificationStoreForTests,
  activeBanners,
  activeModal,
  createAnnouncement,
  createNotification,
  dismissBanner,
  getAnnouncementForUser,
  listAnnouncements,
  listInboxForUser,
  markNotificationsRead,
  normalizePageSize,
  unreadCountForUser,
  updateAnnouncement,
} from "./notification-store.ts";

beforeEach(() => {
  __resetNotificationStoreForTests();
});

const USER_A = 101;
const USER_B = 202;

/** 测试用公告：文案是占位符，本档不内置任何运营内容。 */
async function seedAnnouncement(overrides: Record<string, unknown> = {}) {
  return createAnnouncement({
    title: "标题占位 A",
    body: "正文占位 A",
    surfaces: ["inbox"],
    ...overrides,
  });
}

// ── 真行为断言：建 2 条公告 → 列表回 2 → 标记已读 → 未读数 0 ─────────

test("SQL-1 建 2 条公告 → 列表回 2 → 标记已读 → 该用户未读数 0", async () => {
  const a = await seedAnnouncement({ title: "一" });
  const b = await seedAnnouncement({ title: "二" });

  const inbox = await listInboxForUser(USER_A);
  assert.equal(inbox.total, 2);
  assert.equal(inbox.items.length, 2);
  assert.deepEqual(inbox.items.map((item) => item.id).sort(), [a.id, b.id].sort());
  assert.equal(inbox.items.every((item) => item.read === false), true);

  assert.equal(await unreadCountForUser(USER_A), 2);

  const marked = await markNotificationsRead(USER_A, { announcementIds: [a.id, b.id] });
  assert.equal(marked.announcementIds.length, 2);
  assert.equal(marked.unreadCount, 0);

  // 真读一遍：未读数是重算出来的，不是返回值里带回来的。
  assert.equal(await unreadCountForUser(USER_A), 0);
  const after = await listInboxForUser(USER_A);
  assert.equal(after.items.every((item) => item.read === true), true);
});

// ── 跨用户隔离（本片核心判据）────────────────────────────────────

test("SQL-2 跨用户隔离：A 标记已读不影响 B 的未读数与已读位", async () => {
  const a = await seedAnnouncement({ title: "一" });
  const b = await seedAnnouncement({ title: "二" });

  assert.equal(await unreadCountForUser(USER_A), 2);
  assert.equal(await unreadCountForUser(USER_B), 2);

  await markNotificationsRead(USER_A, { announcementIds: [a.id, b.id] });

  // A 归零，B 原封不动（若已读是全局的，这里会是 0）。
  assert.equal(await unreadCountForUser(USER_A), 0);
  assert.equal(await unreadCountForUser(USER_B), 2);

  const inboxB = await listInboxForUser(USER_B);
  assert.equal(inboxB.total, 2);
  assert.equal(inboxB.items.every((item) => item.read === false), true);
});

test("SQL-3 跨用户隔离：个人通知只进目标用户的通知列表与未读数", async () => {
  const forA = await createNotification(USER_A, { title: "私信占位", body: "正文占位" });

  const inboxA = await listInboxForUser(USER_A);
  assert.equal(inboxA.total, 1);
  assert.equal(inboxA.items[0].id, forA.id);
  assert.equal(inboxA.items[0].kind, "notification");
  assert.equal(inboxA.items[0].read, false);

  const inboxB = await listInboxForUser(USER_B);
  assert.equal(inboxB.total, 0);

  assert.equal(await unreadCountForUser(USER_A), 1);
  assert.equal(await unreadCountForUser(USER_B), 0);

  await markNotificationsRead(USER_A, { notificationIds: [forA.id] });
  assert.equal(await unreadCountForUser(USER_A), 0);
  assert.equal(await unreadCountForUser(USER_B), 0);
});

test("SQL-4 跨用户隔离：A 关掉的横幅在 B 仍然生效", async () => {
  const banner = await seedAnnouncement({ surfaces: ["banner"], title: "横幅占位" });

  assert.deepEqual((await activeBanners({ userId: USER_A })).map((item) => item.id), [banner.id]);
  assert.deepEqual((await activeBanners({ userId: USER_B })).map((item) => item.id), [banner.id]);

  assert.equal(await dismissBanner(USER_A, banner.id), true);
  assert.equal(await dismissBanner(USER_A, banner.id), false); // 幂等：重复关闭回 false

  assert.deepEqual(await activeBanners({ userId: USER_A }), []);
  assert.deepEqual((await activeBanners({ userId: USER_B })).map((item) => item.id), [banner.id]);
});

// ── 时间窗 ─────────────────────────────────────────────────────

test("SQL-5 时间窗外的公告不出现在生效清单（未开始 / 已结束）", async () => {
  const now = new Date("2026-09-27T12:00:00.000Z");
  const future = await seedAnnouncement({
    title: "未开始",
    startsAt: "2026-09-28T00:00:00.000Z",
  });
  const past = await seedAnnouncement({
    title: "已结束",
    endsAt: "2026-09-26T00:00:00.000Z",
  });
  const live = await seedAnnouncement({
    title: "生效中",
    startsAt: "2026-09-27T00:00:00.000Z",
    endsAt: "2026-09-27T23:59:59.000Z",
  });

  const active = await listInboxForUser(USER_A, { now });
  assert.deepEqual(active.items.map((item) => item.id), [live.id]);

  // 未读数用同一把尺：窗外两条不计。
  assert.equal(await unreadCountForUser(USER_A, now), 1);

  // 边界：起点当刻算生效，终点当刻算生效。
  assert.deepEqual(
    (await listInboxForUser(USER_A, { now: new Date("2026-09-27T00:00:00.000Z") })).items.map((i) => i.id),
    [live.id],
  );
  assert.equal(
    (await listInboxForUser(USER_A, { now: new Date("2026-09-28T00:00:00.000Z") })).items.some(
      (i) => i.id === future.id,
    ),
    true,
  );
  assert.equal(
    (await listInboxForUser(USER_A, { now: new Date("2026-09-28T00:00:00.000Z") })).items.some(
      (i) => i.id === past.id,
    ),
    false,
  );
});

// ── 受众范围 ───────────────────────────────────────────────────

test("SQL-6 受众范围内的公告只对指定用户生效（含详情面同一把尺）", async () => {
  const scoped = await seedAnnouncement({
    title: "限定受众",
    surfaces: ["inbox"],
    audienceUserIds: [USER_A],
  });

  assert.deepEqual((await listInboxForUser(USER_A)).items.map((item) => item.id), [scoped.id]);
  assert.equal((await listInboxForUser(USER_B)).total, 0);
  assert.equal(await unreadCountForUser(USER_B), 0);

  // 详情面不能绕过受众。
  assert.ok(await getAnnouncementForUser(scoped.id, USER_A));
  assert.equal(await getAnnouncementForUser(scoped.id, USER_B), null);
});

// ── 弹窗 ───────────────────────────────────────────────────────

test("SQL-7 active-modal：返回未读过的弹窗，标记已读后换下一条、最终为 null", async () => {
  const first = await seedAnnouncement({ surfaces: ["modal"], title: "弹窗一" });
  const second = await seedAnnouncement({ surfaces: ["modal"], title: "弹窗二" });

  const initial = await activeModal({ userId: USER_A });
  assert.ok(initial);
  assert.ok([first.id, second.id].includes(initial.id));

  await markNotificationsRead(USER_A, { announcementIds: [initial.id] });
  const next = await activeModal({ userId: USER_A });
  assert.ok(next);
  assert.notEqual(next.id, initial.id);

  await markNotificationsRead(USER_A, { announcementIds: [next.id] });
  assert.equal(await activeModal({ userId: USER_A }), null);

  // 与用户无关的已读者不会让别人的弹窗消失。
  assert.ok(await activeModal({ userId: USER_B }));
});

// ── 管理端：建 / 列 / 改 ────────────────────────────────────────

test("SQL-8 管理端 contract：建 → 列（含分页与停用过滤）→ 改", async () => {
  const a = await seedAnnouncement({ title: "占位一" });
  await seedAnnouncement({ title: "占位二", enabled: false });

  const all = await listAnnouncements({});
  assert.equal(all.total, 2);
  assert.equal(all.page, 1);
  assert.equal(all.pageSize, 20);

  const onlyEnabled = await listAnnouncements({ includeDisabled: false });
  assert.deepEqual(onlyEnabled.items.map((item) => item.id), [a.id]);

  const paged = await listAnnouncements({ page: 2, pageSize: 1 });
  assert.equal(paged.items.length, 1);
  assert.equal(paged.total, 2);
  assert.equal(paged.hasMore, false);

  const updated = await updateAnnouncement(a.id, { enabled: false, surfaces: ["banner"] });
  assert.ok(updated);
  assert.equal(updated.enabled, false);
  assert.deepEqual(updated.surfaces, ["banner"]);
  assert.equal(updated.title, "占位一"); // patch 未提及的栏位不动
  assert.equal(await updateAnnouncement("不存在的-id", { title: "x" }), null);
});

test("SQL-9 边界：标题/正文为空拒绝；未知 id 的已读标记被丢弃", async () => {
  await assert.rejects(() => createAnnouncement({ title: "  ", body: "正文" }), /不能为空/);
  await assert.rejects(() => createAnnouncement({ title: "标题", body: "" }), /不能为空/);
  await assert.rejects(() => createNotification(USER_A, { title: "标题", body: "" }), /不能为空/);

  const real = await seedAnnouncement({});
  const marked = await markNotificationsRead(USER_A, {
    announcementIds: [real.id, "垃圾-id"],
    notificationIds: ["不存在"],
  });
  assert.deepEqual(marked.announcementIds, [real.id]);
  assert.deepEqual(marked.notificationIds, []);
  assert.equal(marked.unreadCount, 0);
});

test("SQL-10 边界：pageSize 超上限被夹回；非法页码回落第 1 页", async () => {
  assert.equal(normalizePageSize(10_000), 100);
  assert.equal(normalizePageSize(0), 20);
  assert.equal(normalizePageSize("abc"), 20);
  await seedAnnouncement({ title: "占位" });
  const page = await listInboxForUser(USER_A, { page: -5, pageSize: 0 });
  assert.equal(page.page, 1);
  assert.equal(page.pageSize, 20);
});

test("SQL-11 个人通知可指向公告：link/announcementId 随条目带出且截断安全", async () => {
  const announcement = await seedAnnouncement({ title: "占位公告" });
  const n = await createNotification(USER_B, {
    title: "占位通知",
    body: "正文占位",
    announcementId: announcement.id,
    link: "/pricing",
  });
  const inbox = await listInboxForUser(USER_B);
  const item = inbox.items.find((entry) => entry.id === n.id);
  assert.ok(item);
  assert.equal(item.announcementId, announcement.id);
  assert.equal(item.link, "/pricing");

  // 同一条公告同时进 inbox 面公告与本条通知 → B 的未读数为 2。
  assert.equal(await unreadCountForUser(USER_B), 2);
});
