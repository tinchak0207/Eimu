// device-bridge-credential.ts — 桌面壳「短效装置票」的**换票与推送**（W7a，2026-10-05）。
//
// 为什么需要这一支（根因）：装置桥挂在闸道既有的 Bearer `sk-biz-*` 之后，而桌面壳载入的
// 是**远端页面**、壳内没有也不该有长期 key。旧设计只剩「使用者自己把 0600 的 key 档放进
// userData」这条操作者路径 ⇒ 对真实使用者等于功能不存在（实测：设定档已 mode=full、
// enabled=true，桥仍永远停在 credentials_unavailable，「本机档案权限」四档怎么选都一样）。
//
// 正确形态（闸道 `POST /agent/v1/device-bridge/token` 已实作）：**已登录的页面**向站内
// 服务端换一张 `sk-dev-…` 短效票（分钟级、行程内记忆体、闸道重启即失效＝可撤销），经窄
// IPC `window.eimuLocal.bridge.setCredential` 交给主进程当 Bearer。票**绝不**落盘／
// 入 localStorage／入 log；本档只做「拿票 → 正规化 → 交出去」。
//
// 分工：本档有 IO（fetch 与身份头），`device-bridge-display.ts` 维持零 IO／零外部 import；
// 后者只负责「什么时候该推」（挂载、主进程索取、到期前），实际推的动作由它注入本档。

import { authHeaders } from "@/lib/canvas/client";

/** 换票端点（站内代理，身份头与 agent-chat-client 的 authHeaders 同一套）。 */
export const DEVICE_TOKEN_PATH = "/api/agent/device-token";

/** 契约里的票载荷（与闸道／桌面壳三边逐字一致）。 */
export interface DeviceCredential {
  token: string;
  gatewayBaseUrl: string;
  expiresInSec: number;
}

/** 票前缀（闸道 auth-gw DEVICE_TICKET_PREFIX 的镜像；壳只认这个前缀）。 */
export const DEVICE_TICKET_PREFIX = "sk-dev-";

/** 预设票期（秒）——上游没给 expires_in_sec 时的退路，与闸道预设 600s 同值。 */
export const DEFAULT_DEVICE_TICKET_TTL_SEC = 600;

/** 本档只需要壳的这一个方法（其余能力不碰）。 */
interface PushableBridgeApi {
  bridge?: { setCredential?: (credential: DeviceCredential) => Promise<unknown> };
}

/**
 * 这个壳支持「页面推票」吗？**旧桌面产物没有 `bridge.setCredential`** ⇒ false，
 * 此时一律不得呼叫（也不得 throw）。纯浏览器自然也是 false。
 */
export function shouldPushDeviceCredential(api: unknown): boolean {
  if (!api || typeof api !== "object") return false;
  const bridge = (api as PushableBridgeApi).bridge;
  return typeof bridge?.setCredential === "function";
}

/**
 * 上游 JSON → credential（纯函式，fail-closed）。
 * 形状不合（票前缀不对／base 非 http(s)／TTL 非正）一律回 null，绝不把半截东西交给壳。
 */
export function normalizeDeviceCredential(raw: unknown): DeviceCredential | null {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null;
  const rec = raw as Record<string, unknown>;
  const token = typeof rec.token === "string" ? rec.token.trim() : "";
  if (!token.startsWith(DEVICE_TICKET_PREFIX) || token.length <= DEVICE_TICKET_PREFIX.length) return null;
  const base = typeof rec.gatewayBaseUrl === "string" ? rec.gatewayBaseUrl.trim() : "";
  if (!/^https?:\/\//.test(base)) return null;
  const ttlRaw = Number(rec.expiresInSec);
  const expiresInSec =
    Number.isFinite(ttlRaw) && ttlRaw > 0 ? Math.floor(ttlRaw) : DEFAULT_DEVICE_TICKET_TTL_SEC;
  return { token, gatewayBaseUrl: base.replace(/\/+$/, ""), expiresInSec };
}

/**
 * 换一张票并推给桌面壳。**任何失败都静默**（未登录／站内未启用／壳不支持／上游 5xx）：
 * 这条链路是渐进增强，桥没有票时的既有行为（credentials_unavailable）本来就是安全的。
 *
 * 排下一次刷新用 `device-bridge-display.ts` 的 `credentialRefreshDelayMs`（单一真源）。
 *
 * @returns 推成功回的票（供呼叫端排下一次刷新）；没推成回 null。
 */
export async function fetchAndPushDeviceCredential(api: unknown): Promise<DeviceCredential | null> {
  if (!shouldPushDeviceCredential(api)) return null;
  const headers = authHeaders();
  if (!headers) return null; // 未登录：静默跳过（不是错误）
  let res: Response;
  try {
    res = await fetch(DEVICE_TOKEN_PATH, { method: "POST", headers, cache: "no-store" });
  } catch {
    return null;
  }
  if (!res.ok) return null;
  let raw: unknown;
  try {
    raw = await res.json();
  } catch {
    return null;
  }
  const body = raw && typeof raw === "object" ? (raw as Record<string, unknown>) : {};
  const credential = normalizeDeviceCredential({
    token: body.token,
    gatewayBaseUrl: body.gatewayBaseUrl,
    expiresInSec: body.expiresInSec,
  });
  if (!credential) return null;
  const setCredential = (api as PushableBridgeApi).bridge?.setCredential;
  if (typeof setCredential !== "function") return null;
  try {
    await setCredential(credential);
  } catch {
    return null;
  }
  return credential;
}