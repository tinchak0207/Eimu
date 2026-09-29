// 用戶側車事實的服務端通道：已驗證真實 email（觸達）＋ 首次觸達歸因（來源）。
//
// 為什麼是側車而不是「第二套用戶資料」：身分／憑證的 owner 仍是 new-api 的 users 表
// （合成帳號、派生密碼、quota）。真 email 在 OAuth 流程被丟棄、歸因 new-api 根本沒有欄位，
// 所以只補這兩類事實，鍵＝new-api users.id（`user_attribution.user_id`）。
//
// 部署拓撲（與 welcome-gift 同一骨架）：
//   寫庫只在控制面（直連控制面 Postgres）。Vercel 站點沒有控制面 DB，走 HMAC 簽名通道
//   轉投 `/image-control/api/internal/user-attribution`（簽名域 "user-attribution"，與
//   welcome-gift / newapi-session-token 互相不可重放）。
//
// 隱私鐵律：email 屬個資，**永不進日誌、永不進回傳值**；本檔所有日誌只印 user_id 與
// 布林狀態。失敗一律吞（登入流程不因觸達/歸因寫入失敗而中斷）。

import { signBizKeySync } from "@/lib/biz-key-sync";
import {
  decodeFirstTouchCookieValue,
  selectVerifiedGitHubEmail,
  selectVerifiedGoogleEmail,
  toFirstTouchRecord,
  type FirstTouchInput,
  type GitHubEmailEntry,
} from "@/lib/first-touch-attribution";
import { getGenerationSql, type GenerationSql } from "@/lib/generation-core/database";

export type EmailProvider = "github" | "google";

/** 一次登入要落地的事實（email 可缺、歸因可缺；兩者皆缺時不寫庫）。 */
export interface UserAttributionUpsert {
  userId: number;
  email?: string | null;
  emailProvider?: EmailProvider | null;
  firstTouch?: FirstTouchInput | null;
}

/** 投影用的最簡形狀（統計層只認 userId → 分組鍵）。 */
export interface UserAttributionSourceRow {
  userId: number;
  source: string | null;
}

export interface UserAttributionStore {
  /** 冪等 upsert：email 最新已驗證值勝出，歸因首觸勝出。回是否有寫入。 */
  upsert(record: UserAttributionUpsert): Promise<boolean>;
}

export interface UserAttributionRead {
  rows: UserAttributionSourceRow[];
  /** 讀取是否成功（表未建／連線失敗＝false，呼叫方必須把來源拆分標成不可用，不假裝沒歸因）。 */
  ok: boolean;
}

// ─────────────────────────────────────────── 輸入組裝（呼叫方只給原料）

/**
 * OAuth 回調用：provider 原始 profile → 要落庫的事實（只收已驗證 email）。
 * GitHub 走 `/user/emails`（挑 verified，優先 primary），Google 走 userinfo 的 email_verified。
 */
export function buildOAuthAttributionInput(input: {
  userId: number;
  provider: EmailProvider;
  firstTouch?: FirstTouchInput | null;
  githubEmails?: readonly GitHubEmailEntry[] | null;
  googleProfile?: { email?: string | null; email_verified?: boolean | null } | null;
}): UserAttributionUpsert {
  const email = input.provider === "github"
    ? selectVerifiedGitHubEmail(input.githubEmails)
    : selectVerifiedGoogleEmail(input.googleProfile);
  return {
    userId: input.userId,
    email,
    emailProvider: email ? input.provider : null,
    firstTouch: input.firstTouch ?? null,
  };
}

/** 有東西要寫才寫（純 fact：email 與歸因皆空 → 不必打一次庫）。 */
export function hasAttributionFacts(record: UserAttributionUpsert): boolean {
  if (!Number.isInteger(record.userId) || record.userId <= 0) return false;
  const hasEmail = typeof record.email === "string" && record.email.trim().length > 0;
  return hasEmail || record.firstTouch != null;
}

// ─────────────────────────────────────────── 控制面：Postgres

let schemaReady: Promise<void> | null = null;

async function ensureSchema(sql: GenerationSql): Promise<void> {
  if (!schemaReady) {
    // 與 db/migrations/025_user_attribution.sql 同一 DDL（冪等，首用即建，免人工遷移）。
    schemaReady = (async () => {
      await sql`
        CREATE TABLE IF NOT EXISTS user_attribution (
          user_id           bigint PRIMARY KEY,
          email             text,
          email_provider    text CHECK (email_provider IS NULL OR email_provider IN ('github', 'google')),
          email_verified_at timestamptz,
          signup_source     text,
          utm_source        text,
          utm_medium        text,
          utm_campaign      text,
          referrer_host     text,
          landing_path      text,
          first_touch_at    timestamptz,
          created_at        timestamptz NOT NULL DEFAULT now(),
          updated_at        timestamptz NOT NULL DEFAULT now()
        )
      `;
      await sql`
        CREATE INDEX IF NOT EXISTS user_attribution_signup_source_idx ON user_attribution (signup_source)
      `;
    })().catch((error) => {
      schemaReady = null;
      throw error;
    });
  }
  return schemaReady;
}

export function createPostgresUserAttributionStore(
  sql: GenerationSql = getGenerationSql(),
): UserAttributionStore {
  return {
    async upsert(record) {
      if (!hasAttributionFacts(record)) return false;
      await ensureSchema(sql);
      const email = typeof record.email === "string" && record.email.trim() ? record.email.trim().toLowerCase() : null;
      const provider = email ? (record.emailProvider ?? null) : null;
      const verifiedAt = email ? new Date().toISOString() : null;
      const touch = record.firstTouch ? toFirstTouchRecord(record.firstTouch) : null;
      const rows = await sql<{ user_id: unknown }[]>`
        INSERT INTO user_attribution (
          user_id, email, email_provider, email_verified_at,
          signup_source, utm_source, utm_medium, utm_campaign, referrer_host, landing_path, first_touch_at
        ) VALUES (
          ${record.userId}, ${email}, ${provider}, ${verifiedAt}::timestamptz,
          ${touch?.signupSource ?? null}, ${touch?.utmSource ?? null}, ${touch?.utmMedium ?? null},
          ${touch?.utmCampaign ?? null}, ${touch?.referrerHost ?? null}, ${touch?.landingPath ?? null},
          ${touch?.capturedAt ?? null}::timestamptz
        )
        ON CONFLICT (user_id) DO UPDATE SET
          -- email：最新一筆「已驗證」值勝出；新值為 NULL（provider 沒給）時保留舊值。
          email             = COALESCE(EXCLUDED.email, user_attribution.email),
          email_provider    = COALESCE(EXCLUDED.email_provider, user_attribution.email_provider),
          email_verified_at = COALESCE(EXCLUDED.email_verified_at, user_attribution.email_verified_at),
          -- 歸因：首觸勝出（既有非 NULL 值永不覆蓋）。
          signup_source     = COALESCE(user_attribution.signup_source, EXCLUDED.signup_source),
          utm_source        = COALESCE(user_attribution.utm_source, EXCLUDED.utm_source),
          utm_medium        = COALESCE(user_attribution.utm_medium, EXCLUDED.utm_medium),
          utm_campaign      = COALESCE(user_attribution.utm_campaign, EXCLUDED.utm_campaign),
          referrer_host     = COALESCE(user_attribution.referrer_host, EXCLUDED.referrer_host),
          landing_path      = COALESCE(user_attribution.landing_path, EXCLUDED.landing_path),
          first_touch_at    = COALESCE(user_attribution.first_touch_at, EXCLUDED.first_touch_at),
          updated_at        = now()
        RETURNING user_id
      `;
      return rows.length > 0;
    },
  };
}

/**
 * 統計投影用：讀窗口內註冊用戶的來源分組鍵（只讀，一條寫入都沒有）。
 * 表未建／讀取失敗 → `ok: false`（呼叫方必須把「來源拆分」標成不可用，不假裝大家都沒歸因）。
 */
export async function readFunnelAttribution(input: {
  userIds: number[];
  sql?: GenerationSql;
}): Promise<UserAttributionRead> {
  if (input.userIds.length === 0) return { rows: [], ok: true };
  const sql = input.sql ?? getGenerationSql();
  try {
    const rows = await sql<{ user_id: unknown; signup_source: unknown }[]>`
      SELECT user_id, signup_source
      FROM user_attribution
      WHERE user_id = ANY(${input.userIds}::bigint[])
    `;
    return {
      rows: rows.map((row) => ({
        userId: Number(row.user_id),
        source: typeof row.signup_source === "string" && row.signup_source.trim() ? row.signup_source.trim() : null,
      })),
      ok: true,
    };
  } catch (error) {
    console.error(
      `[user-attribution] funnel source read failed：${error instanceof Error ? error.message : String(error)}`,
    );
    return { rows: [], ok: false };
  }
}

// ─────────────────────────────────────────── Vercel 側簽名通道

export const USER_ATTRIBUTION_RELAY_SIGNATURE_DOMAIN = "user-attribution";
const RELAY_PATH = "/image-control/api/internal/user-attribution";
const DEFAULT_RELAY_TIMEOUT_MS = 2_500;

interface RelayOptions {
  timeoutMs?: number;
  fetchImpl?: typeof fetch;
}

async function postRelay(body: Record<string, unknown>, options: RelayOptions): Promise<boolean> {
  const origin = process.env.GENERATION_CONTROL_PLANE_PROXY_ORIGIN?.trim().replace(/\/+$/, "");
  const secret = process.env.GENERATION_BILLING_RELAY_SECRET?.trim();
  if (!origin || !secret) return false;
  const rawBody = JSON.stringify(body);
  const timestamp = String(Date.now());
  const signature = signBizKeySync(secret, timestamp, rawBody, USER_ATTRIBUTION_RELAY_SIGNATURE_DOMAIN);
  const res = await (options.fetchImpl ?? fetch)(`${origin}${RELAY_PATH}`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "X-Biz-Key-Sync-Timestamp": timestamp,
      "X-Biz-Key-Sync-Signature": signature,
    },
    body: rawBody,
    cache: "no-store",
    signal: AbortSignal.timeout(options.timeoutMs ?? DEFAULT_RELAY_TIMEOUT_MS),
  });
  if (!res.ok) return false;
  const data = (await res.json().catch(() => null)) as { ok?: boolean } | null;
  return data?.ok === true;
}

/**
 * 請控制面寫一次側車事實。**永不 throw、永不回傳 email**；env 缺一或失敗回 false（不擋登入）。
 */
export async function recordUserAttributionViaRelay(
  record: UserAttributionUpsert,
  options: RelayOptions = {},
): Promise<boolean> {
  if (!hasAttributionFacts(record)) return false;
  try {
    const touch = record.firstTouch ? toFirstTouchRecord(record.firstTouch) : null;
    return await postRelay(
      {
        op: "upsert",
        userId: record.userId,
        email: record.email ?? null,
        emailProvider: record.emailProvider ?? null,
        attribution: touch
          ? {
              signupSource: touch.signupSource,
              utmSource: touch.utmSource,
              utmMedium: touch.utmMedium,
              utmCampaign: touch.utmCampaign,
              referrerHost: touch.referrerHost,
              landingPath: touch.landingPath,
              firstTouchAt: touch.capturedAt,
            }
          : null,
      },
      options,
    );
  } catch (error) {
    console.error(
      `[user-attribution] relay upsert failed user=${record.userId}：${error instanceof Error ? error.message : String(error)}`,
    );
    return false;
  }
}

/**
 * 首次觸達 cookie → 落庫（歸因部分）。cookie 無值／壞值 → 直接 false（不寫）。
 * 供 `/api/auth/me` 在**任何** provider 登入後補記（涵蓋微信等沒有 OAuth callback 的路徑）。
 */
export async function recordFirstTouchCookieViaRelay(
  userId: number,
  rawCookie: string | null | undefined,
  options: RelayOptions = {},
): Promise<boolean> {
  const firstTouch = decodeFirstTouchCookieValue(rawCookie);
  if (!firstTouch) return false;
  return recordUserAttributionViaRelay({ userId, firstTouch }, options);
}

/**
 * 邀請碼 cookie → 控面綁定邀請關係（驗簽與「未出過圖才可綁」都在控面）。永不 throw。
 * 回 true ＝ 控面已處理（綁上或判定不可綁都算處理完，免得每次登入重送）。
 */
export async function recordInviteViaRelay(
  userId: number,
  inviteCode: string | null | undefined,
  options: RelayOptions = {},
): Promise<boolean> {
  if (!inviteCode) return false;
  try {
    return await postRelay({ op: "invite", userId, inviteCode }, options);
  } catch (error) {
    console.error(`[user-attribution] relay invite failed user=${userId}：${error instanceof Error ? error.message : String(error)}`);
    return false;
  }
}

// ─────────────────────────────────────────── 控制面入站（供 internal route 組裝）

/** 入站請求體（provider 已在 Vercel 側挑出「已驗證」email；控制面只做形狀校驗再落庫）。 */
export function parseAttributionUpsertBody(body: unknown): UserAttributionUpsert | null {
  if (!body || typeof body !== "object") return null;
  const payload = body as Record<string, unknown>;
  const userId = typeof payload.userId === "number" ? payload.userId : Number(payload.userId);
  if (!Number.isInteger(userId) || userId <= 0) return null;

  const rawEmail = typeof payload.email === "string" ? payload.email.trim() : "";
  const provider = payload.emailProvider === "github" || payload.emailProvider === "google"
    ? payload.emailProvider
    : null;
  // email 與 provider 必須成對出現：沒 provider 的 email 一律丟（來源不可考＝不存）。
  const email = rawEmail && provider ? rawEmail.toLowerCase() : null;

  const raw = payload.attribution;
  let firstTouch: FirstTouchInput | null = null;
  if (raw && typeof raw === "object") {
    const a = raw as Record<string, unknown>;
    const asText = (value: unknown) => (typeof value === "string" ? value : null);
    firstTouch = {
      utmSource: asText(a.utmSource),
      utmMedium: asText(a.utmMedium),
      utmCampaign: asText(a.utmCampaign),
      referrerHost: asText(a.referrerHost),
      landingPath: asText(a.landingPath),
      capturedAt: asText(a.firstTouchAt),
    };
  }

  return { userId, email, emailProvider: email ? provider : null, firstTouch };
}
