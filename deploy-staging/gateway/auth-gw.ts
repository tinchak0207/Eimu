// auth-gw.ts — SSE/附件票据、API key 验证与正典化身分、loopback 判定、CORS（自 index.ts 四段逐行抽取，2026-09-19 Wave1）
import { KEY_CACHE_TTL_MS, PLATFORM_BASE } from "./constants-gateway.ts"
// SSE tickets. The browser EventSource API cannot set an Authorization header
// (its only option is withCredentials), so a page written the way §7 shows it
// cannot authenticate the event stream at all. Rather than accept the sk-biz-*
// key in the query string — where it lands in nginx access logs, Referer
// headers and browser history, and where it would still be a key that can spend
// money — a ticket is minted by an authenticated POST and scoped to exactly one
// session, read-only, with a short TTL.
//
// Deliberately reusable until it expires: EventSource reconnects on its own and
// replays Last-Event-ID, so a one-shot ticket would break §9-5 resume on the
// first network blip.
export const SSE_TICKET_TTL_MS = Number.parseInt(process.env.SSE_TICKET_TTL_MS || "600000", 10) || 600_000
export const sseTickets = new Map<string, { sessionId: string; apiKey: string; expiresAt: number }>()

// ── 附件静态读票据（2026-08-29，罪状1 网关侧）─────────────────────────────
// 前端 <img>/<video> 标签带不了 Authorization 头，与 SSE ticket 同构：认证 POST
// 换一张只读、单会话、TTL 1 小时的票据，公开 GET 路由凭票直读 UPLOADS_DIR 下文件。
export const UPLOAD_TICKET_TTL_MS = Number.parseInt(process.env.UPLOAD_TICKET_TTL_MS || "3600000", 10) || 3_600_000
export const uploadTickets = new Map<string, { sessionId: string; expiresAt: number }>()

export function issueUploadTicket(sessionId: string): string {
  const ticket = `ut_${crypto.randomUUID().replace(/-/g, "")}`
  uploadTickets.set(ticket, { sessionId, expiresAt: Date.now() + UPLOAD_TICKET_TTL_MS })
  return ticket
}

/** 只验票据有效（未过期）且与会话匹配，不验 key（GET 方是浏览器标签）。
 *  过期顺手删条目；无效/过期/会话不匹配回 false，呼叫端一律 404 不泄露存在性。 */
export function redeemUploadTicket(ticket: string, sessionId: string): boolean {
  const rec = uploadTickets.get(ticket)
  if (!rec) return false
  if (rec.expiresAt <= Date.now()) {
    uploadTickets.delete(ticket)
    return false
  }
  return rec.sessionId === sessionId
}

// ── 装置桥短效凭证「device ticket」（2026-10-05，W7a）─────────────────────
// 问题：装置桥挂在 Bearer sk-biz-* 之后，但桌面壳载入的是**远端页面**、壳内没有也不该有
// 长期 key（页面能写进主进程＝多开一条 remote→local 信任路径）。结果是使用者装了桌面版
// 也永远停在 credentials_unavailable——功能对真实使用者不存在（2026-10-05 实测）。
// 解法（与 SSE ticket 同构、同一条纪律）：由**已登录的页面**向站内服务端换一张短效、
// 只够打装置桥四个端点的票，经窄 IPC 交给壳当 Bearer。TTL 分钟级、行程内记忆体（网关
// 重启即全失效＝可撤销）、绝不落盘、绝不入 log。
//
// 刻意可重放至过期：壳要连续用同一张票打 register/heartbeat/poll/result，一次性票会
// 在第一发 heartbeat 就死。
export const DEVICE_TICKET_TTL_MS = Number.parseInt(process.env.EIMU_DEVICE_TICKET_TTL_MS || "600000", 10) || 600_000
/** 票前缀。**不得**与 sk-biz- 相交（router 用前缀区分两条鉴权路径）。 */
export const DEVICE_TICKET_PREFIX = "sk-dev-"
export const deviceTickets = new Map<string, { tenant: string; userId: number | null; keyHash: string; expiresAt: number }>()

export function issueDeviceTicket(entry: { tenant: string; userId: number | null; keyHash: string }): string {
  const ticket = `${DEVICE_TICKET_PREFIX}${crypto.randomUUID().replace(/-/g, "")}`
  deviceTickets.set(ticket, { ...entry, expiresAt: Date.now() + DEVICE_TICKET_TTL_MS })
  return ticket
}

/** 验票并回它绑定的身分；过期顺手删条目、无效/过期回 null（呼叫端一律 401，不泄露存在性）。 */
export function redeemDeviceTicket(
  ticket: string,
): { tenant: string; userId: number | null; keyHash: string } | null {
  const rec = deviceTickets.get(ticket)
  if (!rec) return null
  if (rec.expiresAt <= Date.now()) {
    deviceTickets.delete(ticket)
    return null
  }
  return { tenant: rec.tenant, userId: rec.userId, keyHash: rec.keyHash }
}

export const keyCache = new Map<string, { ok: boolean; expiresAt: number }>()
export const encoder = new TextEncoder()
export const decoder = new TextDecoder()


// ---- auth validation (正结论缓存 5 分钟；负结论只认上游明确否定) ----

// 2026-10-14：负结论缓存单独用短 TTL。负结论也可能源自上游自身抖动（一次 401 是它当下
// 的判断，不代表这把 key 持续无效），短 TTL 限制单次瞬时失败的爆炸半径。
export const KEY_NEG_CACHE_TTL_MS = 15_000

export async function validateApiKey(key: string): Promise<boolean> {
  const now = Date.now()
  const cached = keyCache.get(key)
  if (cached && cached.expiresAt > now) return cached.ok
  let ok = false
  let conclusive = false // 只有上游明确答复才算结论；超时/网络抖动/5xx/429 一律不算
  try {
    const res = await fetch(`${PLATFORM_BASE}/v1/models`, {
      headers: { Authorization: `Bearer ${key}` },
      signal: AbortSignal.timeout(2000), // 2026-09-12 刀2：miss RTT 实测 24–125ms，5s 上限收敛为 2s 尾延迟保护
    })
    ok = res.ok
    if (res.ok) {
      conclusive = true // 2xx：正结论
    } else if (res.status === 401 || res.status === 403) {
      conclusive = true // 上游明确否定：负结论
    }
  } catch {
    ok = false
  }
  // 判定不出（瞬时失败/上游 5xx 等）不写缓存：下一次请求重新判定，避免把一次抖动
  // 放大成这把合法 key 连续 5 分钟全部 401（2026-10-14 两支评测 agent 实测需重试最多
  // 15 次才自愈的根因）。
  if (conclusive) {
    keyCache.set(key, { ok, expiresAt: now + (ok ? KEY_CACHE_TTL_MS : KEY_NEG_CACHE_TTL_MS) })
  }
  return ok
}

// ---- canonical identity (R6): raw B key -> owner derived key ----

// 正典化缓存：正 10 分钟（派生 key 稳定），负 60 秒（站点抖动防风暴）。
// 任何失败（超时/非 200/形状不符）一律 fallback 回 rawKey。
export const CANON_KEY_TTL_MS = 10 * 60 * 1000
export const CANON_KEY_NEG_TTL_MS = 60 * 1000
// G4（2026-09-17）：缓存值加 userId（resolve-owner 回应的属主数字 id，非密——密钥
// 字面值照旧不出现在任何日志/响应）。agent 触发的成片导出要向控制面报
// `web:<userId>` tenant，控制面不持有 agent key 明文（单向哈希）反解不了 owner，
// 属主身份只能在这次既有正典化调用里顺带拿到。
export const canonKeyCache = new Map<string, { key: string | null; userId: number | null; expiresAt: number }>()

export async function resolveCanonicalIdentity(rawKey: string): Promise<{ key: string; userId: number | null }> {
  const now = Date.now()
  const cached = canonKeyCache.get(rawKey)
  if (cached && cached.expiresAt > now) return { key: cached.key ?? rawKey, userId: cached.userId }
  let canonical: string | null = null
  let userId: number | null = null
  let answered = false // 上游是否给出明确答复；超时/网络/5xx 等瞬时失败一律不算结论，不写缓存
  try {
    const res = await fetch(`${PLATFORM_BASE}/api/agent/biz/resolve-owner`, {
      method: "POST",
      headers: { Authorization: `Bearer ${rawKey}` },
      signal: AbortSignal.timeout(2000), // 2026-09-12 刀2：miss RTT 实测 95–533ms，负缓存 60s 防风暴下 2s 足够
    })
    if (res.ok) {
      answered = true // 200：有无映射都是明确结论
      const data = (await res.json()) as { canonical_key?: unknown; user_id?: unknown }
      if (typeof data.canonical_key === "string" && data.canonical_key.startsWith("sk-biz-")) {
        canonical = data.canonical_key
      }
      if (typeof data.user_id === "number" && Number.isInteger(data.user_id) && data.user_id > 0) {
        userId = data.user_id
      }
    } else if (res.status === 401 || res.status === 403) {
      answered = true // 上游明确否定
    }
  } catch {
    // 瞬时失败：不写缓存，fallback 回 rawKey
  }
  if (answered) {
    canonKeyCache.set(rawKey, {
      key: canonical,
      userId,
      expiresAt: now + (canonical ? CANON_KEY_TTL_MS : CANON_KEY_NEG_TTL_MS),
    })
  }
  return { key: canonical ?? rawKey, userId }
}

/** 既有呼叫端（R6 正典化）只吃 key；身份扩充（成片索引 tenant 归属）走 resolveCanonicalIdentity。 */
export async function resolveCanonicalKey(rawKey: string): Promise<string> {
  return (await resolveCanonicalIdentity(rawKey)).key
}

export async function hashKey(key: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(key))
  return [...new Uint8Array(digest)]
    .slice(0, 12)
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("")
}

export function isLoopback(ip: string | null): boolean {
  if (!ip) return false
  if (ip === "127.0.0.1" || ip === "::1") return true
  return ip.startsWith("127.") || ip.startsWith("::ffff:127.")
}

// ---- CORS ----

// Explicit allowlist, not "*": these responses are authenticated with a
// sk-biz-* key, and a wildcard origin combined with credentials is exactly the
// configuration browsers refuse (and that would let any site drive a user's
// paid account). Configure via CORS_ORIGINS as a comma-separated list.
export const CORS_ORIGINS = (process.env.CORS_ORIGINS || "https://image.tinchak0207.xyz")
  .split(",")
  .map((s) => s.trim().replace(/\/+$/, ""))
  .filter(Boolean)

export function corsOriginFor(origin: string | null): string | null {
  if (!origin) return null // same-origin / curl: no CORS headers needed
  const normalized = origin.replace(/\/+$/, "")
  if (CORS_ORIGINS.includes(normalized)) return origin
  if (CORS_ORIGINS.includes("*")) return origin // echo the caller, never literal "*"
  // local dev: 192.168.*, localhost, 127.0.0.1
  if (/^https?:\/\/(localhost|127\.0\.0\.1|192\.168\.\d{1,3}\.\d{1,3})(:\d+)?$/.test(normalized)) return origin
  return null
}

export function corsHeaders(allowedOrigin: string | null): Record<string, string> {
  if (!allowedOrigin) return {}
  return {
    "Access-Control-Allow-Origin": allowedOrigin,
    "Access-Control-Allow-Methods": "GET, POST, DELETE, OPTIONS",
    // last-event-id must be allowed or SSE resume-after-reconnect fails preflight.
    "Access-Control-Allow-Headers": "Authorization, Content-Type, Last-Event-ID",
    "Access-Control-Max-Age": "86400",
    // Varying on Origin keeps a CDN from caching one origin's headers for another.
    Vary: "Origin",
  }
}

