// PWA GitHub 登录跨浏览器交接（handoff）票据存储。
//
// 背景：PWA standalone 视窗的 storage 与常用浏览器隔离，GitHub cookie 带不
// 进来，每次都被要求重新登录。治本方案：在常用浏览器完成 GitHub 授权，
// 会话经一次性 ticket 交回 PWA：
//   1. PWA POST ?action=create 拿 ticket + loginUrl；
//   2. 用户在常用浏览器打开 /api/auth/github/start?handoff=<ticket>，
//      callback 时 ticket 经 state 携带回服务器，token/user_json 写入本表；
//   3. PWA 轮询 poll → status=delivered 后 POST ?action=claim 原子一次性
//      消费（claimed_at 置位），Set-Cookie 种 napi_token/napi_user。
//
// 存储轮子：src/lib/agent-profile-store.ts 的 getGenerationSql 用法（无
// Blob 兜底层——DB 未配置时直接抛错，由 route 回 503）。
//
// 双模式（2026-09-05）：生产 Vercel 环境没有 GENERATION_DATABASE_URL，四个导出
// 函数在 `generationDatabaseConfigured()` 为 false 时改走 HMAC 签名代理通道——
// 经 GENERATION_CONTROL_PLANE_PROXY_ORIGIN 调控制面的
// /image-control/api/internal/pwa-handoff（biz-key-sync 轮子，signatureDomain
// "pwa-handoff"），由控制面侧执行同一套直连 SQL；有 DB（本地/控制面）时仍走
// 下方原始直连实现，语义不变。

import { randomBytes } from "node:crypto";
import {
  generationDatabaseConfigured,
  getGenerationSql,
} from "@/lib/generation-core/database";
import { signBizKeySync } from "@/lib/biz-key-sync";

const HANDOFF_TTL_MINUTES = 10;

const RELAY_TIMEOUT_MS = 15_000;

/**
 * Vercel 侧代理执行（无控制面 DB 直连）：经 GENERATION_CONTROL_PLANE_PROXY_ORIGIN
 * 调控制面 /image-control/api/internal/pwa-handoff（HMAC 签名，域 "pwa-handoff"）。
 * origin/secret 缺一即 throw（由调用方 route 回 503）；响应非 2xx 或 ok:false 也 throw。
 */
async function relayOp<T>(op: string, payload: Record<string, unknown>): Promise<T> {
  const origin = process.env.GENERATION_CONTROL_PLANE_PROXY_ORIGIN?.trim().replace(/\/+$/, "");
  const secret = process.env.GENERATION_BILLING_RELAY_SECRET?.trim();
  if (!origin || !secret) throw new Error("pwa-handoff 签名代理通道未配置");
  const rawBody = JSON.stringify({ op, ...payload });
  const timestamp = String(Date.now());
  const signature = signBizKeySync(secret, timestamp, rawBody, "pwa-handoff");
  const res = await fetch(`${origin}/image-control/api/internal/pwa-handoff`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "X-Biz-Key-Sync-Timestamp": timestamp,
      "X-Biz-Key-Sync-Signature": signature,
    },
    body: rawBody,
    signal: AbortSignal.timeout(RELAY_TIMEOUT_MS),
  });
  if (!res.ok) throw new Error(`pwa-handoff 代理通道响应异常 status=${res.status}`);
  const data = (await res.json().catch(() => null)) as ({ ok?: boolean } & T) | null;
  if (!data?.ok) throw new Error("pwa-handoff 代理通道返回失败");
  return data;
}

let schemaReady: Promise<void> | null = null;

async function ensureSchema(): Promise<void> {
  if (!schemaReady) {
    schemaReady = (async () => {
      const sql = getGenerationSql();
      await sql`
        CREATE TABLE IF NOT EXISTS pwa_login_handoff (
          ticket       TEXT PRIMARY KEY,
          token        TEXT NOT NULL DEFAULT '',
          user_json    JSONB NOT NULL DEFAULT '{}'::jsonb,
          created_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
          expires_at   TIMESTAMPTZ NOT NULL,
          delivered_at TIMESTAMPTZ,
          claimed_at   TIMESTAMPTZ
        )
      `;
    })().catch((error) => {
      schemaReady = null;
      throw error;
    });
  }
  return schemaReady;
}

/** 签发新 ticket（10 分钟有效），顺手清理过期一天以上的旧行。 */
export async function createHandoffTicket(): Promise<string> {
  if (!generationDatabaseConfigured()) {
    const data = await relayOp<{ ticket: string }>("create", {});
    return data.ticket;
  }
  await ensureSchema();
  const sql = getGenerationSql();
  const ticket = randomBytes(16).toString("hex");
  await sql`
    INSERT INTO pwa_login_handoff (ticket, expires_at)
    VALUES (${ticket}, now() + interval '10 minutes')
  `;
  await sql`
    DELETE FROM pwa_login_handoff WHERE expires_at < now() - interval '1 day'
  `;
  return ticket;
}

/** callback 侧投递：同一 ticket 只允许投递一次。返回是否命中。 */
export async function deliverHandoff(ticket: string, token: string, user: unknown): Promise<boolean> {
  if (!generationDatabaseConfigured()) {
    const data = await relayOp<{ delivered: boolean }>("deliver", { ticket, token, user });
    return data.delivered;
  }
  await ensureSchema();
  const sql = getGenerationSql();
  const rows = await sql`
    UPDATE pwa_login_handoff
    SET token = ${token}, user_json = ${sql.json((user ?? {}) as never)}, delivered_at = now()
    WHERE ticket = ${ticket} AND delivered_at IS NULL AND expires_at > now()
    RETURNING ticket
  `;
  return rows.length > 0;
}

/** PWA 侧原子一次性消费：只有已投递、未消费、未过期才命中。 */
export async function claimHandoff(ticket: string): Promise<{ token: string; user: unknown } | null> {
  if (!generationDatabaseConfigured()) {
    const data = await relayOp<{ claimed: { token: string; user: unknown } | null }>("claim", { ticket });
    return data.claimed ?? null;
  }
  await ensureSchema();
  const sql = getGenerationSql();
  const rows = await sql`
    UPDATE pwa_login_handoff
    SET claimed_at = now()
    WHERE ticket = ${ticket} AND delivered_at IS NOT NULL AND claimed_at IS NULL AND expires_at > now()
    RETURNING token, user_json
  `;
  const row = rows[0] as { token: string; user_json: unknown } | undefined;
  if (!row) return null;
  return { token: row.token, user: row.user_json };
}

/** 只读轮询：ticket 不存在/已过期/已消费 → "unknown"。 */
export async function pollHandoff(
  ticket: string,
): Promise<"pending" | "delivered" | "unknown"> {
  if (!generationDatabaseConfigured()) {
    const data = await relayOp<{ status: "pending" | "delivered" | "unknown" }>("poll", { ticket });
    return data.status;
  }
  await ensureSchema();
  const sql = getGenerationSql();
  const rows = await sql`
    SELECT delivered_at, claimed_at FROM pwa_login_handoff
    WHERE ticket = ${ticket} AND expires_at > now()
  `;
  const row = rows[0] as { delivered_at: Date | string | null; claimed_at: Date | string | null } | undefined;
  if (!row) return "unknown";
  if (row.claimed_at) return "unknown";
  if (row.delivered_at) return "delivered";
  return "pending";
}

export { HANDOFF_TTL_MINUTES };
