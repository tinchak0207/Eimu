// 新人礼首登弹窗的客户端契约：纯类型 + 纯函数，零服务端依赖（客户端 bundle 可安全 import）。
//
// 服务端（/api/auth/me）在既有 new-api 用户对象上 additive 挂一个 `welcomeGift` 字段，
// 内容由控制面的 welcome-gift.ts 从具名常量推導（币数/张数/文案都不在客户端写死）。
// 这里只做两件事：①解析这个字段（形状不对一律当「不弹」）②本设备已看过的辅助标记。
//
// 闸门权威在服务端：`status='applied' AND modal_seen_at IS NULL`（见 welcome-gift.ts
// 的 welcomeGiftModalPending）。localStorage 只是本设备的辅助——服务端状态已记「看过」
// 之后即使本机标记丢了也只会由服务端兜住，反之本机标记只用来挡住同设备上的重复弹。

/** 服务端随 /api/auth/me 回传的待展示新人礼（pending=false 表示无需弹窗）。 */
export interface WelcomeGiftModal {
  pending: boolean;
  /** 币数（服务端按 welcome-gift 具名常量推導）。 */
  coins?: number;
  /** 折合标准图张数。 */
  images?: number;
  /** 弹窗标题（服务端文案，单一来源）。 */
  title?: string;
  /** 弹窗正文。 */
  body?: string;
}

/** 本设备「已看过某用户新人礼弹窗」的辅助标记（存 userId，切账号仍各看各的）。 */
export const WELCOME_GIFT_MODAL_SEEN_KEY = "eimu-welcome-gift-modal-seen-v1";

/** 可注入的存储介面（node --test 用假物件验行为，不必碰真 localStorage）。 */
export interface WelcomeGiftModalStorage {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
}

function deviceStore(store?: WelcomeGiftModalStorage | null): WelcomeGiftModalStorage | null {
  if (store) return store;
  if (typeof window === "undefined") return null;
  try {
    return window.localStorage;
  } catch {
    // 私密模式/停用存储：辅助闸门失效，服务端状态照常负责。
    return null;
  }
}

/**
 * 解析服务端字段。只有明确的「pending=true + 币数/张数/文案齐全」才算待展示——
 * 形状不对（缺字段、数字非法、文案空）一律回 null 不弹：宁可少弹一次，
 * 也不拿半截数据弹一个数字可能是假的窗。
 */
export function parseWelcomeGiftModal(value: unknown): WelcomeGiftModal | null {
  if (!value || typeof value !== "object") return null;
  const raw = value as Record<string, unknown>;
  if (raw.pending !== true) return null;
  const coins = Number(raw.coins);
  const images = Number(raw.images);
  if (!Number.isFinite(coins) || coins <= 0) return null;
  if (!Number.isInteger(images) || images <= 0) return null;
  const title = typeof raw.title === "string" ? raw.title.trim() : "";
  const body = typeof raw.body === "string" ? raw.body.trim() : "";
  if (!title || !body) return null;
  return { pending: true, coins, images, title, body };
}

/** 本设备是否已经看过该用户的新人礼弹窗。 */
export function welcomeGiftModalSeenLocally(
  userId: number,
  store?: WelcomeGiftModalStorage | null,
): boolean {
  const target = deviceStore(store);
  if (!target || !Number.isInteger(userId) || userId <= 0) return false;
  try {
    return target.getItem(WELCOME_GIFT_MODAL_SEEN_KEY) === String(userId);
  } catch {
    return false;
  }
}

/** 记下「该用户的新人礼弹窗已在本设备展示过」。 */
export function markWelcomeGiftModalSeenLocally(
  userId: number,
  store?: WelcomeGiftModalStorage | null,
): void {
  const target = deviceStore(store);
  if (!target || !Number.isInteger(userId) || userId <= 0) return;
  try {
    target.setItem(WELCOME_GIFT_MODAL_SEEN_KEY, String(userId));
  } catch {
    // 存不了（私密模式/配额满）不致命：服务端回执仍是权威。
  }
}
