// new-api 稳定会话令牌（session token）确保层。
//
// 背景：new-api 网关的 GET /api/user/token 每次调用都会重置该用户的
// 唯一 access_token（实测连打三次三个值，DB users.access_token 同步变），
// 且 /api/user/self 无论谁读取都会脱敏 access_token、PUT self 写不进
// （白名单），上游是公共镜像无源码可改。于是任何一次新登录都会杀掉
// 该用户所有旧会话（PWA/Safari/桌面互杀）。
//
// 治本：控制面（可达 new-api，env GATEWAY_BASE_URL）用自有 Postgres 存
// 每用户一个稳定 token：
//   1. 首次：用登录 session cookie 调 /api/user/token 生成 → 落表 → 返回；
//   2. 之后：先查表 → 用 Bearer token + New-Api-User 打 /api/user/self
//      验活 → 活 → 返回旧 token（不重置）；死 → 重新生成并覆盖表。
// 所有设备共享同一 token，互杀根治。
//
// 双模式（与 pwa-handoff 同一架构）：本文件的 ensureNewApiSessionToken
// 在控制面直连 DB 执行；Vercel 侧没有控制面 DB 直连，走
// ensureNewApiSessionTokenViaRelay 经 HMAC 签名通道
// （signatureDomain "newapi-session-token"）转投控制面的
// /image-control/api/internal/newapi-session-token。

import {
  getGenerationSql,
} from "@/lib/generation-core/database";
import { getGatewayBaseUrl } from "@/lib/new-api-auth-server";
import { signBizKeySync } from "@/lib/biz-key-sync";

const GATEWAY_TIMEOUT_MS = 15_000;
const RELAY_TIMEOUT_MS = 15_000;

const RELAY_SIGNATURE_DOMAIN = "newapi-session-token";

export type EnsuredSessionToken = {
  ok: true;
  token: string;
  reused: boolean;
};

let schemaReady: Promise<void> | null = null;

async function ensureSchema(): Promise<void> {
  if (!schemaReady) {
    schemaReady = (async () => {
      const sql = getGenerationSql();
      await sql`
        CREATE TABLE IF NOT EXISTS newapi_session_token (
          user_id    INTEGER PRIMARY KEY,
          token      TEXT NOT NULL,
          updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
        )
      `;
    })().catch((error) => {
      schemaReady = null;
      throw error;
    });
  }
  return schemaReady;
}

/** 用 Bearer token 验活：HTTP 200 且 body success 才算活。 */
async function verifyTokenAlive(baseUrl: string, token: string, userId: number): Promise<boolean> {
  try {
    const response = await fetch(`${baseUrl}/api/user/self`, {
      headers: {
        Authorization: `Bearer ${token}`,
        "New-Api-User": String(userId),
      },
      cache: "no-store",
      signal: AbortSignal.timeout(GATEWAY_TIMEOUT_MS),
    });
    if (!response.ok) return false;
    const data = (await response.json().catch(() => null)) as { success?: boolean } | null;
    return data?.success === true;
  } catch {
    return false;
  }
}

/** 用登录 session cookie 生成新 token（注意：这一步会重置旧 token）。 */
async function generateToken(baseUrl: string, sessionCookie: string, userId: number): Promise<string | null> {
  try {
    const response = await fetch(`${baseUrl}/api/user/token`, {
      headers: {
        Cookie: sessionCookie,
        "New-Api-User": String(userId),
      },
      cache: "no-store",
      signal: AbortSignal.timeout(GATEWAY_TIMEOUT_MS),
    });
    const data = (await response.json().catch(() => null)) as
      | { success?: boolean; data?: string }
      | null;
    if (!response.ok || !data?.success || !data.data) return null;
    return data.data;
  } catch {
    return null;
  }
}

/**
 * 控制面侧：确保该用户有一个稳定的 new-api access token（读表 → 验活 →
 * 复用或重新生成覆盖）。任何失败都返回 { ok: false }，由调用方决定降级。
 */
export async function ensureNewApiSessionToken(
  userId: number,
  sessionCookie: string,
): Promise<EnsuredSessionToken | { ok: false }> {
  try {
    const sql = getGenerationSql();
    await ensureSchema();
    const baseUrl = getGatewayBaseUrl();

    return await sql.begin(async (tx) => {
      await tx`SELECT pg_advisory_xact_lock(${userId})`;

      const rows = await tx`
        SELECT token FROM newapi_session_token WHERE user_id = ${userId}
      `;
      const existing = (rows[0] as { token: string } | undefined)?.token;
      if (existing && (await verifyTokenAlive(baseUrl, existing, userId))) {
        return { ok: true, token: existing, reused: true };
      }

      // 没存过或已失效：重新生成并覆盖表（此时旧 token 反正已死，重置无副作用）。
      const token = await generateToken(baseUrl, sessionCookie, userId);
      if (!token) return { ok: false };

      await tx`
        INSERT INTO newapi_session_token (user_id, token, updated_at)
        VALUES (${userId}, ${token}, now())
        ON CONFLICT (user_id) DO UPDATE SET token = ${token}, updated_at = now()
      `;
      return { ok: true, token, reused: false };
    });
  } catch (error) {
    console.error("[newapi-session-token] ensure failed", error);
    return { ok: false };
  }
}

/**
 * Vercel 侧：经 HMAC 签名代理通道调控制面的
 * /image-control/api/internal/newapi-session-token 执行同一套逻辑。
 * env 缺一或任何失败 → 返回 null（调用方回退原 fetchAccessToken 路径）。
 */
export async function ensureNewApiSessionTokenViaRelay(
  userId: number,
  sessionCookie: string,
): Promise<EnsuredSessionToken | null> {
  const origin = process.env.GENERATION_CONTROL_PLANE_PROXY_ORIGIN?.trim().replace(/\/+$/, "");
  const secret = process.env.GENERATION_BILLING_RELAY_SECRET?.trim();
  if (!origin || !secret) return null;
  try {
    const rawBody = JSON.stringify({ userId, sessionCookie });
    const timestamp = String(Date.now());
    const signature = signBizKeySync(secret, timestamp, rawBody, RELAY_SIGNATURE_DOMAIN);
    const res = await fetch(`${origin}/image-control/api/internal/newapi-session-token`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-Biz-Key-Sync-Timestamp": timestamp,
        "X-Biz-Key-Sync-Signature": signature,
      },
      body: rawBody,
      signal: AbortSignal.timeout(RELAY_TIMEOUT_MS),
    });
    if (!res.ok) return null;
    const data = (await res.json().catch(() => null)) as
      | ({ ok?: boolean; token?: unknown; reused?: unknown })
      | null;
    if (!data?.ok || typeof data.token !== "string" || !data.token) return null;
    return { ok: true, token: data.token, reused: data.reused === true };
  } catch (error) {
    console.error("[newapi-session-token] relay failed", error);
    return null;
  }
}

/**
 * 控面侧：用稳定 token 反查 userId（/api/user/self 强制要求 New-Api-User 头，
 * 而前端存储的 user 可能是坏残留——id 的唯一可信源是这张表）。
 */
export async function lookupUserIdByToken(token: string): Promise<number | null> {
  try {
    const sql = getGenerationSql();
    const rows = await sql`
      SELECT user_id FROM newapi_session_token WHERE token = ${token} LIMIT 1
    `;
    const id = (rows[0] as { user_id: number | undefined } | undefined)?.user_id;
    return typeof id === "number" && Number.isInteger(id) && id > 0 ? id : null;
  } catch {
    return null;
  }
}

/** Vercel 侧 relay 反查；env 缺一或失败 → null。 */
export async function lookupUserIdByTokenViaRelay(token: string): Promise<number | null> {
  const origin = process.env.GENERATION_CONTROL_PLANE_PROXY_ORIGIN?.trim().replace(/\/+$/, "");
  const secret = process.env.GENERATION_BILLING_RELAY_SECRET?.trim();
  if (!origin || !secret) return null;
  try {
    const rawBody = JSON.stringify({ op: "lookup", token });
    const timestamp = String(Date.now());
    const signature = signBizKeySync(secret, timestamp, rawBody, RELAY_SIGNATURE_DOMAIN);
    const res = await fetch(`${origin}/image-control/api/internal/newapi-session-token`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-Biz-Key-Sync-Timestamp": timestamp,
        "X-Biz-Key-Sync-Signature": signature,
      },
      body: rawBody,
      signal: AbortSignal.timeout(RELAY_TIMEOUT_MS),
    });
    if (!res.ok) return null;
    const data = (await res.json().catch(() => null)) as
      | ({ ok?: boolean; userId?: unknown })
      | null;
    if (!data?.ok || typeof data.userId !== "number" || !Number.isInteger(data.userId)) return null;
    return data.userId;
  } catch {
    return null;
  }
}
