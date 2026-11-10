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

import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import {
  generationDatabaseConfigured,
  getGenerationSql,
} from "@/lib/generation-core/database";
import { signBizKeySync } from "@/lib/biz-key-sync";

const HANDOFF_TTL_MINUTES = 10;

// S-01/S-17（2026-11-04）：领取需 ticket + verifier（PKCE 式），库里只存 ticket 的 sha256。
// 发起设备只上报 challenge = sha256hex(verifier)；verifier 永不离开发起设备（直到 claim 请求体）。
const CHALLENGE_PATTERN = /^[0-9a-f]{64}$/;
const VERIFIER_PATTERN = /^[A-Za-z0-9_-]{43,128}$/;
// create 用 randomBytes(16).toString("hex") 生成：32 位小写 hex。非法 ticket 一律按"不存在"处理，不进 SQL
//（含 NUL 等字符会让 PG 抛 invalid byte sequence）。ticket~invite 的打包值由客户端先拆再传，服务端不收。
const TICKET_PATTERN = /^[0-9a-f]{32}$/;

function isValidTicket(value: unknown): value is string {
  return typeof value === "string" && TICKET_PATTERN.test(value);
}

/**
 * 过渡开关：部署切换前已发出的旧 ticket（ticket_hash 与 challenge 均为 NULL）在其 10 分钟 TTL 内
 * 仍可仅凭 ticket 领取一次。create 一律要求 challenge，部署后不会再产生旧式 ticket，
 * 故部署满 1 天（所有旧行必已过期）后删除本开关与下方两处 legacy 分支；
 * 紧急时设 PWA_HANDOFF_ALLOW_LEGACY_TICKETS 为 false/0/no/off（不分大小写）即刻关闭。
 * 部署顺序：先部署 Vercel（新客户端发 challenge，旧控制面忽略它，期间无保护但功能正常），
 * 紧接着部署控制面。反过来（旧 Vercel + 新控制面）会让 create 缺 challenge 返回 400。
 */
function legacyTicketsAllowed(): boolean {
  const flag = process.env.PWA_HANDOFF_ALLOW_LEGACY_TICKETS?.trim().toLowerCase();
  return !(flag === "false" || flag === "0" || flag === "no" || flag === "off");
}

function sha256Hex(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

export function isValidHandoffChallenge(value: unknown): value is string {
  return typeof value === "string" && CHALLENGE_PATTERN.test(value);
}

export function isValidHandoffVerifier(value: unknown): value is string {
  return typeof value === "string" && VERIFIER_PATTERN.test(value);
}

function constantTimeEqualHex(a: string, b: string): boolean {
  const ba = Buffer.from(a, "utf8");
  const bb = Buffer.from(b, "utf8");
  if (ba.length !== bb.length) return false;
  return timingSafeEqual(ba, bb);
}

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
      // 与 db/migrations/041_pwa_handoff_challenge.sql 一致（迁移未落地前旧进程也能工作）。
      await sql`ALTER TABLE pwa_login_handoff ADD COLUMN IF NOT EXISTS ticket_hash TEXT`;
      await sql`ALTER TABLE pwa_login_handoff ADD COLUMN IF NOT EXISTS challenge TEXT`;
      await sql`
        CREATE UNIQUE INDEX IF NOT EXISTS pwa_login_handoff_ticket_hash_idx
          ON pwa_login_handoff (ticket_hash) WHERE ticket_hash IS NOT NULL
      `;
    })().catch((error) => {
      schemaReady = null;
      throw error;
    });
  }
  return schemaReady;
}

/**
 * 签发新 ticket（10 分钟有效），顺手清理过期 1 小时以上的旧行。
 * challenge = sha256hex(发起设备本地 verifier)，必填；库里只存 ticket 的 sha256，不存明文。
 */
export async function createHandoffTicket(challenge: string): Promise<string> {
  if (!isValidHandoffChallenge(challenge)) throw new Error("pwa-handoff challenge 非法");
  if (!generationDatabaseConfigured()) {
    const data = await relayOp<{ ticket: string }>("create", { challenge });
    return data.ticket;
  }
  await ensureSchema();
  const sql = getGenerationSql();
  const ticket = randomBytes(16).toString("hex");
  const ticketHash = sha256Hex(ticket);
  // PK 列 ticket 同样只放摘要：明文 ticket 不落库；legacy 分支只认 ticket_hash IS NULL 的行，
  // 所以泄露的摘要不能被当作 legacy 明文 ticket 使用。
  await sql`
    INSERT INTO pwa_login_handoff (ticket, ticket_hash, challenge, expires_at)
    VALUES (${ticketHash}, ${ticketHash}, ${challenge}, now() + interval '10 minutes')
  `;
  await sql`
    DELETE FROM pwa_login_handoff WHERE expires_at < now() - interval '1 hour'
  `;
  return ticket;
}

/** callback 侧投递：同一 ticket 只允许投递一次。返回是否命中。 */
export async function deliverHandoff(ticket: string, token: string, user: unknown): Promise<boolean> {
  if (!isValidTicket(ticket)) return false;
  if (!generationDatabaseConfigured()) {
    const data = await relayOp<{ delivered: boolean }>("deliver", { ticket, token, user });
    return data.delivered;
  }
  await ensureSchema();
  const sql = getGenerationSql();
  const rows = await sql`
    UPDATE pwa_login_handoff
    SET token = ${token}, user_json = ${sql.json((user ?? {}) as never)}, delivered_at = now()
    WHERE (ticket_hash = ${sha256Hex(ticket)}
           OR (${legacyTicketsAllowed()}::boolean AND ticket_hash IS NULL AND ticket = ${ticket}))
      AND delivered_at IS NULL AND expires_at > now()
    RETURNING ticket
  `;
  return rows.length > 0;
}

/**
 * PWA 侧原子一次性消费：只有已投递、未消费、未过期才命中。
 * 新式 ticket 必须同时出示 verifier（sha256(verifier) 与存档 challenge 常数时间比对）；
 * verifier 错误不消费 ticket（避免持 ticket 者靠乱填 verifier 烧掉合法用户的登录）。
 * 领取与清空 token 在同一条 UPDATE 内完成（S-17）。
 */
export async function claimHandoff(
  ticket: string,
  verifier?: string | null,
): Promise<{ token: string; user: unknown } | null> {
  if (!isValidTicket(ticket)) return null;
  if (!generationDatabaseConfigured()) {
    const data = await relayOp<{ claimed: { token: string; user: unknown } | null }>("claim", {
      ticket,
      verifier: verifier ?? null,
    });
    return data.claimed ?? null;
  }
  await ensureSchema();
  const sql = getGenerationSql();
  const ticketHash = sha256Hex(ticket);
  const found = await sql`
    SELECT ticket_hash, challenge FROM pwa_login_handoff
    WHERE (ticket_hash = ${ticketHash}
           OR (${legacyTicketsAllowed()}::boolean AND ticket_hash IS NULL AND ticket = ${ticket}))
      AND delivered_at IS NOT NULL AND claimed_at IS NULL AND expires_at > now()
  `;
  const head = found[0] as { ticket_hash: string | null; challenge: string | null } | undefined;
  if (!head) return null;
  // 旧行放行条件严格为 ticket_hash IS NULL 且 challenge IS NULL；只要 challenge 非 NULL 一律要求 verifier。
  if (head.challenge !== null) {
    if (!isValidHandoffVerifier(verifier)) return null;
    if (!constantTimeEqualHex(sha256Hex(verifier), head.challenge)) return null;
  } else if (head.ticket_hash !== null) {
    return null; // 新式行缺 challenge：异常行，拒绝。
  }
  const rows = await sql`
    UPDATE pwa_login_handoff AS t
    SET claimed_at = now(), token = '', user_json = '{}'::jsonb
    FROM (
      SELECT ticket AS pk, token AS old_token, user_json AS old_user
      FROM pwa_login_handoff
      WHERE (ticket_hash = ${ticketHash}
             OR (${legacyTicketsAllowed()}::boolean AND ticket_hash IS NULL AND ticket = ${ticket}))
        AND delivered_at IS NOT NULL AND claimed_at IS NULL AND expires_at > now()
      FOR UPDATE
    ) AS o
    WHERE t.ticket = o.pk AND t.claimed_at IS NULL
    RETURNING o.old_token AS token, o.old_user AS user_json
  `;
  const row = rows[0] as { token: string; user_json: unknown } | undefined;
  if (!row) return null;
  return { token: row.token, user: row.user_json };
}

/** 只读轮询：ticket 不存在/已过期/已消费 → "unknown"。 */
export async function pollHandoff(
  ticket: string,
): Promise<"pending" | "delivered" | "unknown"> {
  if (!isValidTicket(ticket)) return "unknown";
  if (!generationDatabaseConfigured()) {
    const data = await relayOp<{ status: "pending" | "delivered" | "unknown" }>("poll", { ticket });
    return data.status;
  }
  await ensureSchema();
  const sql = getGenerationSql();
  const rows = await sql`
    SELECT delivered_at, claimed_at FROM pwa_login_handoff
    WHERE (ticket_hash = ${sha256Hex(ticket)}
           OR (${legacyTicketsAllowed()}::boolean AND ticket_hash IS NULL AND ticket = ${ticket}))
      AND expires_at > now()
  `;
  const row = rows[0] as { delivered_at: Date | string | null; claimed_at: Date | string | null } | undefined;
  if (!row) return "unknown";
  if (row.claimed_at) return "unknown";
  if (row.delivered_at) return "delivered";
  return "pending";
}

export { HANDOFF_TTL_MINUTES };
