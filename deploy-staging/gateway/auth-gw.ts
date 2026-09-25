// auth-gw.ts — SSE/附件票據、API key 驗證與正典化身分、loopback 判定、CORS（自 index.ts 四段逐行抽取，2026-09-19 Wave1）
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

// ── 附件靜態讀票據（2026-08-29，罪狀1 網關側）─────────────────────────────
// 前端 <img>/<video> 標籤帶不了 Authorization 頭，與 SSE ticket 同構：認證 POST
// 換一張只讀、單會話、TTL 1 小時的票據，公開 GET 路由憑票直讀 UPLOADS_DIR 下文件。
export const UPLOAD_TICKET_TTL_MS = Number.parseInt(process.env.UPLOAD_TICKET_TTL_MS || "3600000", 10) || 3_600_000
export const uploadTickets = new Map<string, { sessionId: string; expiresAt: number }>()

export function issueUploadTicket(sessionId: string): string {
  const ticket = `ut_${crypto.randomUUID().replace(/-/g, "")}`
  uploadTickets.set(ticket, { sessionId, expiresAt: Date.now() + UPLOAD_TICKET_TTL_MS })
  return ticket
}

/** 只驗票據有效（未過期）且與會話匹配，不驗 key（GET 方是瀏覽器標籤）。
 *  過期順手刪條目；無效/過期/會話不匹配回 false，呼叫端一律 404 不泄露存在性。 */
export function redeemUploadTicket(ticket: string, sessionId: string): boolean {
  const rec = uploadTickets.get(ticket)
  if (!rec) return false
  if (rec.expiresAt <= Date.now()) {
    uploadTickets.delete(ticket)
    return false
  }
  return rec.sessionId === sessionId
}

export const keyCache = new Map<string, { ok: boolean; expiresAt: number }>()
export const encoder = new TextEncoder()
export const decoder = new TextDecoder()


// ---- auth validation (cached 5 minutes) ----

export async function validateApiKey(key: string): Promise<boolean> {
  const now = Date.now()
  const cached = keyCache.get(key)
  if (cached && cached.expiresAt > now) return cached.ok
  let ok = false
  try {
    const res = await fetch(`${PLATFORM_BASE}/v1/models`, {
      headers: { Authorization: `Bearer ${key}` },
      signal: AbortSignal.timeout(2000), // 2026-09-12 刀2：miss RTT 實測 24–125ms，5s 上限收斂為 2s 尾延遲保護
    })
    ok = res.ok
  } catch {
    ok = false
  }
  keyCache.set(key, { ok, expiresAt: now + KEY_CACHE_TTL_MS })
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
  try {
    const res = await fetch(`${PLATFORM_BASE}/api/agent/biz/resolve-owner`, {
      method: "POST",
      headers: { Authorization: `Bearer ${rawKey}` },
      signal: AbortSignal.timeout(2000), // 2026-09-12 刀2：miss RTT 實測 95–533ms，負緩存 60s 防風暴下 2s 足夠
    })
    if (res.ok) {
      const data = (await res.json()) as { canonical_key?: unknown; user_id?: unknown }
      if (typeof data.canonical_key === "string" && data.canonical_key.startsWith("sk-biz-")) {
        canonical = data.canonical_key
      }
      if (typeof data.user_id === "number" && Number.isInteger(data.user_id) && data.user_id > 0) {
        userId = data.user_id
      }
    }
  } catch {
    // fall through: fallback to rawKey
  }
  canonKeyCache.set(rawKey, {
    key: canonical,
    userId,
    expiresAt: now + (canonical ? CANON_KEY_TTL_MS : CANON_KEY_NEG_TTL_MS),
  })
  return { key: canonical ?? rawKey, userId }
}

/** 既有呼叫端（R6 正典化）只吃 key；身份擴充（成片索引 tenant 歸屬）走 resolveCanonicalIdentity。 */
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

