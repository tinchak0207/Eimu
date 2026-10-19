// 站内通知／公告／横幅的持久化。
//
// 本档以 src/lib/asset-pack-store.ts 为**逐行基底复制**（2026-09-26），只改白名单栏位：
// blob key 前缀、文档形状（Announcement / UserNotification / UserNotificationState）、
// 函数名与业务逻辑（生效时间窗／受众过滤／已读隔离／未读计数）。以下骨架一行未改：
//   - ensureBlobBackendWritable 门禁（后端不可用且不允许内存降级 → 抛错，不静默降级）
//   - listIndexBlobs 分页走完所有页 + 按 uploadedAt 倒序
//   - 每次写入落到新路径 + 修剪旧世代（INDEX_GENERATIONS_KEPT），避开 Blob
//     cacheControlMaxAge 60s 下限的「刚写读不到」
//   - readBlobDocument 的 access:"public" + 失败回空数组（错误吞噬，不抛给调用方）
//   - per-key 写入串行队列 enqueue
//   - 进程内 Map 兜底 + __resetNotificationStoreForTests
//
// **本档只交付机制，不含任何运营文案**：标题／正文全部由调用方（管理端 API /
// 其他服务端流程）传入，本档不内置任何默认内容，也不区分「征稿／大赛」这类运营语义。
//
// **按用户隔离**：个人通知、已读标记、横幅关闭、弹窗已看全部落在
// `notifications/u/<userId>/` 命名空间下。公告本体是平台级（管理端创建），
// 但「谁读过／谁关过」永远是 per-user 子文档，不存在全局已读。
//
// 已读语义（三处各管一段，互不冒充）：
//   - readNotificationIds：个人通知已读
//   - readAnnouncementIds：公告已读（inbox 未读计数 + active-modal 的「未读过」共用）
//   - dismissedBannerIds：横幅关闭（与「已读」不同：关掉不等于读过）

import { randomBytes } from "node:crypto";
import { del, ensureBlobBackendWritable, get, list, put } from "@/lib/blob-backend";
import { sanitizeBlobSegment } from "@/lib/history-types";

const DOCUMENT_SCHEMA_VERSION = 1;
const INDEX_GENERATIONS_KEPT = 2;
const INDEX_CACHE_TTL_MS = 3_000;

/** Blob 路径前缀（与其他 store 分命名空间，互不影响）。 */
export const NOTIFICATION_BLOB_PREFIX = "notifications";

/** 每用户个人通知上限（超出时 createNotification 拒绝，不静默截断）。 */
export const MAX_NOTIFICATIONS_PER_USER = 500;
/** 每用户已读标记上限，防止 readNotificationIds 无界增长。 */
export const MAX_READ_MARKS_PER_USER = 2_000;
/** 平台公告上限（管理端创建）。 */
export const MAX_ANNOUNCEMENTS = 500;

export const MAX_TITLE_LENGTH = 200;
export const MAX_BODY_LENGTH = 4_000;
export const MAX_LINK_LENGTH = 2_000;
/** 单条公告的受众上限；不设上限的 audience 数组会被无界写入。 */
export const MAX_AUDIENCE_USER_IDS = 10_000;

export const NOTIFICATION_PAGE_SIZE = 20;
export const MAX_PAGE_SIZE = 100;

/** 公告的呈现面。「inbox」＝只进通知列表；banner＝顶栏横幅；modal＝登录后弹窗。 */
export type AnnouncementSurface = "inbox" | "banner" | "modal";

export const ANNOUNCEMENT_SURFACES: readonly AnnouncementSurface[] = ["inbox", "banner", "modal"];

export interface Announcement {
  id: string;
  title: string;
  body: string;
  /** 呈现面（至少一个）。 */
  surfaces: AnnouncementSurface[];
  /** 停用开关；false 时任何生效面都不出。 */
  enabled: boolean;
  /** 生效起点（ISO，含）。缺省＝不限。 */
  startsAt?: string;
  /** 生效终点（ISO，含）。缺省＝不限。 */
  endsAt?: string;
  /** 可选用户范围；缺省或空数组＝全体用户。 */
  audienceUserIds?: number[];
  createdAt: string;
  updatedAt: string;
}

/** 管理端创建公告的输入。id/createdAt/updatedAt 由本档生成。 */
export interface AnnouncementInput {
  title: string;
  body: string;
  surfaces?: AnnouncementSurface[];
  enabled?: boolean;
  startsAt?: string;
  endsAt?: string;
  audienceUserIds?: number[];
}

/** 管理端可改的栏位（id / createdAt 不可改）。 */
export type AnnouncementPatch = Partial<AnnouncementInput>;

export interface UserNotification {
  id: string;
  title: string;
  body: string;
  /** 可选指向公告：点开走公告详情（[id] 端点）。 */
  announcementId?: string;
  /** 可选跳转链接。 */
  link?: string;
  createdAt: string;
}

export interface UserNotificationInput {
  title: string;
  body: string;
  announcementId?: string;
  link?: string;
}

export interface UserNotificationState {
  notifications: UserNotification[];
  readNotificationIds: string[];
  readAnnouncementIds: string[];
  dismissedBannerIds: string[];
}

/** 通知列表条目：个人通知与公告合并后的统一形状（kind 判别）。 */
export interface InboxItem {
  kind: "notification" | "announcement";
  id: string;
  title: string;
  body: string;
  createdAt: string;
  /** 该用户是否已读（永远按用户算）。 */
  read: boolean;
  announcementId?: string;
  link?: string;
}

export interface PaginatedResult<T> {
  items: T[];
  total: number;
  page: number;
  pageSize: number;
  hasMore: boolean;
}

export class NotificationLimitError extends Error {
  constructor(scope: string, limit: number) {
    super(`${scope} 数量已达上限 ${limit} 条`);
    this.name = "NotificationLimitError";
  }
}

// ─────────────────────────────────────────── 进程内兜底 / 缓存 / 队列

const announcementMemory = new Map<string, Announcement[]>();
const userMemory = new Map<number, UserNotificationState>();
const announcementCache = new Map<string, { value: Announcement[]; expiresAt: number }>();
const userCache = new Map<number, { value: UserNotificationState; expiresAt: number }>();
const writeQueues = new Map<string, Promise<unknown>>();

const ANNOUNCEMENT_CACHE_KEY = "announcements";

function announcementPrefix(): string {
  return `${NOTIFICATION_BLOB_PREFIX}/announcements/index-`;
}

function userPrefix(userId: number): string {
  return `${NOTIFICATION_BLOB_PREFIX}/u/${sanitizeBlobSegment(String(userId), "0")}`;
}

function userIndexPrefix(userId: number): string {
  return `${userPrefix(userId)}/index-`;
}

function enqueue<T>(key: string, task: () => Promise<T>): Promise<T> {
  const previous = writeQueues.get(key) ?? Promise.resolve();
  const next = previous.catch(() => undefined).then(task);
  writeQueues.set(key, next.catch(() => undefined));
  return next;
}

// ─────────────────────────────────────────── blob 读写（基底骨架逐字沿用）

type BlobRef = { url: string; pathname: string; uploadedAt: Date };

async function listIndexBlobs(prefix: string): Promise<BlobRef[]> {
  const blobs: BlobRef[] = [];
  let cursor: string | undefined;
  do {
    const page = await list({ prefix, cursor });
    for (const blob of page.blobs) {
      blobs.push({ url: blob.url, pathname: blob.pathname, uploadedAt: blob.uploadedAt });
    }
    cursor = page.hasMore ? page.cursor : undefined;
  } while (cursor);
  return blobs.sort((a, b) => b.uploadedAt.getTime() - a.uploadedAt.getTime());
}

async function readBlobDocument<T>(urlOrPath: string): Promise<T | null> {
  try {
    const blob = await get(urlOrPath, { access: "public" });
    if (!blob || blob.statusCode !== 200) return null;
    const text = await new Response(blob.stream).text();
    if (!text) return null;
    return JSON.parse(text) as T;
  } catch {
    return null;
  }
}

async function writeBlobDocument(
  prefix: string,
  document: unknown,
  context: string,
): Promise<void> {
  const previous = await listIndexBlobs(prefix).catch(() => [] as BlobRef[]);
  const pathname = `${prefix}${Date.now()}-${randomBytes(4).toString("hex")}.json`;
  await put(pathname, JSON.stringify(document), {
    access: "public",
    contentType: "application/json",
    cacheControlMaxAge: 60,
  });
  const stale = previous.slice(INDEX_GENERATIONS_KEPT - 1);
  if (stale.length) {
    await del(stale.map((b) => b.url)).catch((error) => {
      console.error(`[${context}] 清理旧索引失败。`, error);
    });
  }
}

// ─────────────────────────────────────────── 纯函数：清洗与生效判定

function trimmed(value: unknown, max: number): string {
  return typeof value === "string" ? value.trim().slice(0, max) : "";
}

/** ISO 时间戳清洗：只收能被 Date.parse 解析的字符串，否则丢弃（不猜时间）。 */
function isoOrUndefined(value: unknown): string | undefined {
  if (typeof value !== "string" || !value.trim()) return undefined;
  const parsed = Date.parse(value);
  if (!Number.isFinite(parsed)) return undefined;
  return new Date(parsed).toISOString();
}

function normalizeSurfaces(value: unknown): AnnouncementSurface[] {
  if (!Array.isArray(value)) return [];
  const seen = new Set<AnnouncementSurface>();
  for (const raw of value) {
    if (typeof raw !== "string") continue;
    if (!(ANNOUNCEMENT_SURFACES as readonly string[]).includes(raw)) continue;
    seen.add(raw as AnnouncementSurface);
  }
  return ANNOUNCEMENT_SURFACES.filter((surface) => seen.has(surface));
}

function normalizeAudience(value: unknown): number[] | undefined {
  if (!Array.isArray(value)) return undefined;
  const seen = new Set<number>();
  for (const raw of value) {
    const id = Number(raw);
    if (!Number.isFinite(id)) continue;
    seen.add(Math.trunc(id));
    if (seen.size >= MAX_AUDIENCE_USER_IDS) break;
  }
  return seen.size ? [...seen] : undefined;
}

/**
 * 纯函数：把不可信 payload 正规化为 Announcement。缺 id／title／body 一律回 null
 * （本档不生成运营文案，标题正文必须由调用方给出）。
 */
export function normalizeAnnouncement(payload: unknown): Announcement | null {
  if (!payload || typeof payload !== "object") return null;
  const p = payload as Partial<Announcement>;
  const id = trimmed(p.id, 64);
  const title = trimmed(p.title, MAX_TITLE_LENGTH);
  const body = trimmed(p.body, MAX_BODY_LENGTH);
  if (!id || !title || !body) return null;
  const surfaces = normalizeSurfaces(p.surfaces);
  const startsAt = isoOrUndefined(p.startsAt);
  const endsAt = isoOrUndefined(p.endsAt);
  const audience = normalizeAudience(p.audienceUserIds);
  const now = new Date().toISOString();
  return {
    id,
    title,
    body,
    surfaces: surfaces.length ? surfaces : ["inbox"],
    enabled: p.enabled !== false,
    ...(startsAt ? { startsAt } : {}),
    ...(endsAt ? { endsAt } : {}),
    ...(audience ? { audienceUserIds: audience } : {}),
    createdAt: isoOrUndefined(p.createdAt) ?? now,
    updatedAt: isoOrUndefined(p.updatedAt) ?? now,
  };
}

/** 纯函数：生效判定＝启用 + 时间窗 + 受众。now 显式注入，测试可定死时间。 */
export function isAnnouncementActiveFor(
  announcement: Announcement,
  userId: number,
  now: Date = new Date(),
): boolean {
  if (!announcement.enabled) return false;
  const at = now.getTime();
  if (announcement.startsAt && Date.parse(announcement.startsAt) > at) return false;
  if (announcement.endsAt && Date.parse(announcement.endsAt) < at) return false;
  const audience = announcement.audienceUserIds;
  if (audience && audience.length > 0 && !audience.includes(userId)) return false;
  return true;
}

function normalizeUserNotification(payload: unknown): UserNotification | null {
  if (!payload || typeof payload !== "object") return null;
  const p = payload as Partial<UserNotification>;
  const id = trimmed(p.id, 64);
  const title = trimmed(p.title, MAX_TITLE_LENGTH);
  const body = trimmed(p.body, MAX_BODY_LENGTH);
  if (!id || !title || !body) return null;
  const announcementId = trimmed(p.announcementId, 64);
  const link = trimmed(p.link, MAX_LINK_LENGTH);
  return {
    id,
    title,
    body,
    ...(announcementId ? { announcementId } : {}),
    ...(link ? { link } : {}),
    createdAt: isoOrUndefined(p.createdAt) ?? new Date().toISOString(),
  };
}

function normalizeIdList(value: unknown, max: number): string[] {
  if (!Array.isArray(value)) return [];
  const seen = new Set<string>();
  for (const raw of value) {
    const id = trimmed(raw, 64);
    if (!id) continue;
    seen.add(id);
    if (seen.size >= max) break;
  }
  return [...seen];
}

function emptyState(): UserNotificationState {
  return { notifications: [], readNotificationIds: [], readAnnouncementIds: [], dismissedBannerIds: [] };
}

function normalizeUserState(payload: unknown): UserNotificationState {
  if (!payload || typeof payload !== "object") return emptyState();
  const p = payload as Partial<UserNotificationState>;
  const rawNotifications = Array.isArray(p.notifications) ? p.notifications : [];
  const notifications = rawNotifications
    .flatMap((item) => {
      const normalized = normalizeUserNotification(item);
      return normalized ? [normalized] : [];
    })
    .slice(0, MAX_NOTIFICATIONS_PER_USER);
  return {
    notifications,
    readNotificationIds: normalizeIdList(p.readNotificationIds, MAX_READ_MARKS_PER_USER),
    readAnnouncementIds: normalizeIdList(p.readAnnouncementIds, MAX_READ_MARKS_PER_USER),
    dismissedBannerIds: normalizeIdList(p.dismissedBannerIds, MAX_READ_MARKS_PER_USER),
  };
}

export function newNotificationId(): string {
  return randomBytes(8).toString("hex");
}

// ─────────────────────────────────────────── 公告读写

async function readAnnouncements(): Promise<Announcement[]> {
  if (!ensureBlobBackendWritable("notification-store.readAnnouncements")) {
    return [...(announcementMemory.get(ANNOUNCEMENT_CACHE_KEY) ?? [])];
  }
  const cached = announcementCache.get(ANNOUNCEMENT_CACHE_KEY);
  if (cached && cached.expiresAt > Date.now()) return [...cached.value];
  const blobs = await listIndexBlobs(announcementPrefix()).catch(() => [] as BlobRef[]);
  const raw = blobs.length ? await readBlobDocument<unknown>(blobs[0].url) : null;
  const list_ = Array.isArray(raw)
    ? raw
    : Array.isArray((raw as { announcements?: unknown } | null)?.announcements)
      ? (raw as { announcements: unknown[] }).announcements
      : [];
  const announcements = list_
    .flatMap((item) => {
      const normalized = normalizeAnnouncement(item);
      return normalized ? [normalized] : [];
    })
    .slice(0, MAX_ANNOUNCEMENTS);
  announcementCache.set(ANNOUNCEMENT_CACHE_KEY, {
    value: announcements,
    expiresAt: Date.now() + INDEX_CACHE_TTL_MS,
  });
  return [...announcements];
}

async function writeAnnouncements(announcements: Announcement[]): Promise<void> {
  const sorted = [...announcements].sort((a, b) => Date.parse(b.createdAt) - Date.parse(a.createdAt));
  if (!ensureBlobBackendWritable("notification-store.writeAnnouncements")) {
    announcementMemory.set(ANNOUNCEMENT_CACHE_KEY, sorted);
    announcementCache.delete(ANNOUNCEMENT_CACHE_KEY);
    return;
  }
  const document = { schemaVersion: DOCUMENT_SCHEMA_VERSION, announcements: sorted };
  await writeBlobDocument(announcementPrefix(), document, "notifications");
  announcementCache.set(ANNOUNCEMENT_CACHE_KEY, {
    value: sorted,
    expiresAt: Date.now() + INDEX_CACHE_TTL_MS,
  });
}

// ─────────────────────────────────────────── 用户子文档读写

async function readUserState(userId: number): Promise<UserNotificationState> {
  if (!ensureBlobBackendWritable("notification-store.readUserState")) {
    return normalizeUserState(userMemory.get(userId));
  }
  const cached = userCache.get(userId);
  if (cached && cached.expiresAt > Date.now()) return normalizeUserState(cached.value);
  const blobs = await listIndexBlobs(userIndexPrefix(userId)).catch(() => [] as BlobRef[]);
  const raw = blobs.length ? await readBlobDocument<unknown>(blobs[0].url) : null;
  const state = normalizeUserState(raw);
  userCache.set(userId, { value: state, expiresAt: Date.now() + INDEX_CACHE_TTL_MS });
  return state;
}

async function writeUserState(userId: number, state: UserNotificationState): Promise<void> {
  const normalized = normalizeUserState(state);
  if (!ensureBlobBackendWritable("notification-store.writeUserState")) {
    userMemory.set(userId, normalized);
    userCache.delete(userId);
    return;
  }
  const document = { schemaVersion: DOCUMENT_SCHEMA_VERSION, ...normalized };
  await writeBlobDocument(userIndexPrefix(userId), document, "notifications");
  userCache.set(userId, { value: normalized, expiresAt: Date.now() + INDEX_CACHE_TTL_MS });
}

// ─────────────────────────────────────────── 对外接口：公告（管理端）

/** 创建公告。title/body 由调用方给出（本档不生成任何运营文案）。 */
export async function createAnnouncement(input: AnnouncementInput): Promise<Announcement> {
  const now = new Date().toISOString();
  const draft = normalizeAnnouncement({
    ...input,
    id: newNotificationId(),
    createdAt: now,
    updatedAt: now,
  });
  if (!draft) throw new Error("公告标题与正文不能为空。");

  return enqueue(ANNOUNCEMENT_CACHE_KEY, async () => {
    const current = await readAnnouncements();
    if (current.length >= MAX_ANNOUNCEMENTS) {
      throw new NotificationLimitError("公告", MAX_ANNOUNCEMENTS);
    }
    await writeAnnouncements([draft, ...current]);
    return draft;
  });
}

/** 更新公告。找不到回 null（不静默创建）。 */
export async function updateAnnouncement(
  id: string,
  patch: AnnouncementPatch,
): Promise<Announcement | null> {
  const target = trimmed(id, 64);
  if (!target) return null;
  return enqueue(ANNOUNCEMENT_CACHE_KEY, async () => {
    const current = await readAnnouncements();
    const index = current.findIndex((item) => item.id === target);
    if (index < 0) return null;
    const merged = normalizeAnnouncement({
      ...current[index],
      ...patch,
      id: target,
      createdAt: current[index].createdAt,
      updatedAt: new Date().toISOString(),
    });
    if (!merged) throw new Error("公告标题与正文不能为空。");
    const next = [...current];
    next[index] = merged;
    await writeAnnouncements(next);
    return merged;
  });
}

/** 管理端列表（含停用公告，默认页码 1）。 */
export async function listAnnouncements(options: {
  page?: unknown;
  pageSize?: unknown;
  includeDisabled?: boolean;
} = {}): Promise<PaginatedResult<Announcement>> {
  const all = await readAnnouncements();
  const scoped = options.includeDisabled === false ? all.filter((item) => item.enabled) : all;
  const sorted = [...scoped].sort((a, b) => Date.parse(b.createdAt) - Date.parse(a.createdAt));
  return paginate(sorted, options.page, options.pageSize);
}

/**
 * 取单条公告详情。受众不符回 null —— 详情与列表同一把尺，
 * 不让「列表看不到但直连 id 看得到」留下旁路。
 */
export async function getAnnouncementForUser(
  id: string,
  userId: number,
  now: Date = new Date(),
): Promise<Announcement | null> {
  const all = await readAnnouncements();
  const found = all.find((item) => item.id === id);
  if (!found) return null;
  return isAnnouncementActiveFor(found, userId, now) ? found : null;
}

// ─────────────────────────────────────────── 对外接口：生效面（用户端）

/** 生效中的公告（时间窗 + 受众 + enabled），可选按呈现面过滤。 */
export async function activeAnnouncements(options: {
  userId: number;
  surface?: AnnouncementSurface;
  now?: Date;
}): Promise<Announcement[]> {
  const now = options.now ?? new Date();
  const all = await readAnnouncements();
  return all
    .filter((item) => isAnnouncementActiveFor(item, options.userId, now))
    .filter((item) => (options.surface ? item.surfaces.includes(options.surface) : true))
    .sort((a, b) => Date.parse(b.createdAt) - Date.parse(a.createdAt));
}

/** 生效中的横幅：active 的 banner 面公告 − 该用户已关闭的。 */
export async function activeBanners(options: { userId: number; now?: Date }): Promise<Announcement[]> {
  const banners = await activeAnnouncements({ ...options, surface: "banner" });
  const state = await readUserState(options.userId);
  const dismissed = new Set(state.dismissedBannerIds);
  return banners.filter((item) => !dismissed.has(item.id));
}

/**
 * 未读过的弹窗：active 的 modal 面公告中，该用户尚未标记已读者；取最新一条
 * （createdAt 倒序首条），没有则回 null。标记已读走 markNotificationsRead，
 * 本函数**不产生副作用**（GET 不留写痕迹）。
 */
export async function activeModal(options: { userId: number; now?: Date }): Promise<Announcement | null> {
  const modals = await activeAnnouncements({ ...options, surface: "modal" });
  const state = await readUserState(options.userId);
  const read = new Set(state.readAnnouncementIds);
  return modals.find((item) => !read.has(item.id)) ?? null;
}

/** 关闭横幅：按用户记，返回值＝该横幅此前是否处于未关闭态。 */
export async function dismissBanner(userId: number, announcementId: string): Promise<boolean> {
  const target = trimmed(announcementId, 64);
  if (!target) return false;
  return enqueue(`u:${userId}`, async () => {
    const state = await readUserState(userId);
    if (state.dismissedBannerIds.includes(target)) return false;
    await writeUserState(userId, {
      ...state,
      dismissedBannerIds: [...state.dismissedBannerIds, target].slice(-MAX_READ_MARKS_PER_USER),
    });
    return true;
  });
}

// ─────────────────────────────────────────── 对外接口：个人通知（用户端）

/** 给某个用户建一条个人通知（userId 决定命名空间，天然隔离）。 */
export async function createNotification(
  userId: number,
  input: UserNotificationInput,
): Promise<UserNotification> {
  const draft = normalizeUserNotification({ ...input, id: newNotificationId() });
  if (!draft) throw new Error("通知标题与正文不能为空。");

  return enqueue(`u:${userId}`, async () => {
    const state = await readUserState(userId);
    if (state.notifications.length >= MAX_NOTIFICATIONS_PER_USER) {
      throw new NotificationLimitError("个人通知", MAX_NOTIFICATIONS_PER_USER);
    }
    await writeUserState(userId, {
      ...state,
      notifications: [draft, ...state.notifications].slice(0, MAX_NOTIFICATIONS_PER_USER),
    });
    return draft;
  });
}

/**
 * 通知列表：个人通知 + 该用户可见的 inbox 面生效公告，按 createdAt 倒序合并，
 * 带分页。read 栏位永远按传入 userId 计算。
 */
export async function listInboxForUser(
  userId: number,
  options: { page?: unknown; pageSize?: unknown; now?: Date } = {},
): Promise<PaginatedResult<InboxItem>> {
  const state = await readUserState(userId);
  const announcements = await activeAnnouncements({ userId, surface: "inbox", now: options.now });
  const readNotifications = new Set(state.readNotificationIds);
  const readAnnouncements = new Set(state.readAnnouncementIds);

  const items: InboxItem[] = [
    ...state.notifications.map((item): InboxItem => ({
      kind: "notification",
      id: item.id,
      title: item.title,
      body: item.body,
      createdAt: item.createdAt,
      read: readNotifications.has(item.id),
      ...(item.announcementId ? { announcementId: item.announcementId } : {}),
      ...(item.link ? { link: item.link } : {}),
    })),
    ...announcements.map((item): InboxItem => ({
      kind: "announcement",
      id: item.id,
      title: item.title,
      body: item.body,
      createdAt: item.createdAt,
      read: readAnnouncements.has(item.id),
    })),
  ];

  const sorted = items.sort((a, b) => Date.parse(b.createdAt) - Date.parse(a.createdAt));
  return paginate(sorted, options.page, options.pageSize);
}

/**
 * 未读计数 = 未读个人通知 + 未读的 inbox 面生效公告。
 *
 * 按用户隔离的关键：两个集合都来自该 userId 的 readNotificationIds /
 * readAnnouncementIds，别人的已读标记不会进这个函数。
 */
export async function unreadCountForUser(
  userId: number,
  now: Date = new Date(),
): Promise<number> {
  const state = await readUserState(userId);
  const announcements = await activeAnnouncements({ userId, surface: "inbox", now });
  const readNotifications = new Set(state.readNotificationIds);
  const readAnnouncements = new Set(state.readAnnouncementIds);
  const unreadNotifications = state.notifications.filter((item) => !readNotifications.has(item.id)).length;
  const unreadAnnouncements = announcements.filter((item) => !readAnnouncements.has(item.id)).length;
  return unreadNotifications + unreadAnnouncements;
}

/**
 * 标记已读。两个集合各自过滤到真实存在的 id（拒绝垃圾 id 写入）。
 * 只动该 userId 的子文档，别人的已读状态不受影响。
 */
export async function markNotificationsRead(
  userId: number,
  input: { notificationIds?: unknown; announcementIds?: unknown },
): Promise<{ notificationIds: string[]; announcementIds: string[]; unreadCount: number }> {
  const wantedNotifications = new Set(normalizeIdList(input?.notificationIds, MAX_READ_MARKS_PER_USER));
  const wantedAnnouncements = new Set(normalizeIdList(input?.announcementIds, MAX_READ_MARKS_PER_USER));

  return enqueue(`u:${userId}`, async () => {
    const state = await readUserState(userId);
    const existingNotifications = new Set(state.notifications.map((item) => item.id));
    const allAnnouncements = await readAnnouncements();
    const existingAnnouncements = new Set(allAnnouncements.map((item) => item.id));

    const markedNotifications = [...wantedNotifications].filter((id) => existingNotifications.has(id));
    const markedAnnouncements = [...wantedAnnouncements].filter((id) => existingAnnouncements.has(id));

    const nextNotifications = [
      ...new Set([...state.readNotificationIds, ...markedNotifications]),
    ].slice(-MAX_READ_MARKS_PER_USER);
    const nextAnnouncements = [
      ...new Set([...state.readAnnouncementIds, ...markedAnnouncements]),
    ].slice(-MAX_READ_MARKS_PER_USER);

    await writeUserState(userId, {
      ...state,
      readNotificationIds: nextNotifications,
      readAnnouncementIds: nextAnnouncements,
    });

    const unreadCount = await unreadCountForUser(userId);
    return { notificationIds: markedNotifications, announcementIds: markedAnnouncements, unreadCount };
  });
}

// ─────────────────────────────────────────── 分页

export function normalizePage(value: unknown): number {
  const parsed = Math.floor(Number(value));
  return Number.isFinite(parsed) && parsed >= 1 ? parsed : 1;
}

export function normalizePageSize(value: unknown): number {
  const parsed = Math.floor(Number(value));
  if (!Number.isFinite(parsed) || parsed < 1) return NOTIFICATION_PAGE_SIZE;
  return Math.min(parsed, MAX_PAGE_SIZE);
}

export function paginate<T>(items: T[], page: unknown, pageSize: unknown): PaginatedResult<T> {
  const currentPage = normalizePage(page);
  const size = normalizePageSize(pageSize);
  const total = items.length;
  const start = (currentPage - 1) * size;
  const slice = items.slice(start, start + size);
  return {
    items: slice,
    total,
    page: currentPage,
    pageSize: size,
    hasMore: start + slice.length < total,
  };
}

/** 仅测试：重置进程内状态。 */
export function __resetNotificationStoreForTests(): void {
  announcementMemory.clear();
  userMemory.clear();
  announcementCache.clear();
  userCache.clear();
  writeQueues.clear();
}
