// 生命週期郵件（Resend）——新人禮歡迎信＋48h 未出圖激活提醒。
//
// 為什麼在控制面 worker 跑：email 存在控制面 postgres 的 user_attribution 側車表
// （db/migrations/025），「有沒有出過圖」在 generation_job，兩者 Vercel 都讀不到；
// worker 的帳本維護循環（10 分鐘一輪）天然是排程點，不另造第二個 cron。
//
// 語義：
//   - welcome（交易類）：新人禮 applied 且有已驗證 email → 發一次。
//   - nudge（營銷類）：welcome 已發滿 48h、仍無任何 succeeded 生成、未退訂 → 發一次；
//     帶一鍵退訂（List-Unsubscribe + 頁內連結）。
//   - 冪等：先在 email_send_log 佔位（user_id+template 唯一）再呼叫 Resend，並帶
//     Idempotency-Key；佔位後失敗記 failed，不自動重試（寧少發不重發）。
//   - 未配置 RESEND_API_KEY → 整體 no-op（不佔位，配好後自然補發）。
//
// 隱私：email 永不進日誌；日誌只記 user_id 與計數。

import { createHmac, timingSafeEqual } from "node:crypto";
import type { GenerationSql } from "@/lib/generation-core/database";
import { getSiteUrlFromEnv } from "@/lib/site-url";
import { WELCOME_GIFT_COINS, WELCOME_GIFT_IMAGE_COUNT } from "@/lib/welcome-gift";

export type LifecycleTemplate = "welcome" | "nudge";

export const LIFECYCLE_EMAIL_FROM = "Emu <hello@eimu.dev>";
export const NUDGE_DELAY_MS = 48 * 60 * 60_000;
/** 每輪每種模板最多發幾封（Resend 免費檔 100 封/天、2 req/s）。 */
export const LIFECYCLE_BATCH_LIMIT = 20;

const EXAMPLE_PROMPTS = [
  "一只橘猫趴在洒满阳光的窗台上，水彩风格",
  "赛博朋克夜晚的城市街角，霓虹灯倒映在雨后的地面",
  "极简风格的咖啡品牌海报，米白底色，留白充足",
];

export type LifecycleRecipient = { userId: number; email: string };

export type LifecycleEmailStore = {
  listWelcomeCandidates(limit: number): Promise<LifecycleRecipient[]>;
  listNudgeCandidates(limit: number, sentBefore: Date): Promise<LifecycleRecipient[]>;
  /** 佔位；已存在回 false。 */
  claim(userId: number, template: LifecycleTemplate): Promise<boolean>;
  settle(userId: number, template: LifecycleTemplate, status: "sent" | "failed", detail: string | null): Promise<void>;
  /** 撤銷佔位（系統性錯誤時），讓下一輪重試。 */
  release(userId: number, template: LifecycleTemplate): Promise<void>;
};

export type EmailMessage = {
  to: string;
  subject: string;
  html: string;
  idempotencyKey: string;
  headers?: Record<string, string>;
};

/** systemic＝帳號/網域/限流/上游/網路層錯誤：與收件人無關，應釋放佔位、中止本輪、下輪重試。 */
export type SendResult = { ok: true; id: string } | { ok: false; error: string; systemic?: boolean };

export function resendApiKey(env: NodeJS.ProcessEnv = process.env): string | null {
  const key = env.RESEND_API_KEY?.trim();
  return key ? key : null;
}

export async function sendViaResend(
  message: EmailMessage,
  apiKey: string,
  fetchImpl: typeof fetch = fetch,
): Promise<SendResult> {
  try {
    const response = await fetchImpl("https://api.resend.com/emails", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${apiKey}`,
        "Content-Type": "application/json",
        "Idempotency-Key": message.idempotencyKey,
      },
      body: JSON.stringify({
        from: LIFECYCLE_EMAIL_FROM,
        to: [message.to],
        subject: message.subject,
        html: message.html,
        headers: message.headers,
      }),
      signal: AbortSignal.timeout(15_000),
    });
    const text = await response.text();
    if (!response.ok) {
      const systemic = response.status === 401 || response.status === 403 || response.status === 429 || response.status >= 500;
      return { ok: false, error: `HTTP ${response.status} ${text.slice(0, 200)}`, systemic };
    }
    const id = (JSON.parse(text) as { id?: string }).id;
    return id ? { ok: true, id } : { ok: false, error: "missing id" };
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error.message : String(error), systemic: true };
  }
}

// ── 退訂 token（HMAC，復用兩側都有的 GENERATION_BILLING_RELAY_SECRET，域分隔） ──

function unsubscribeSecret(env: NodeJS.ProcessEnv = process.env): string | null {
  return env.GENERATION_BILLING_RELAY_SECRET?.trim() || null;
}

export function unsubscribeToken(userId: number, secret: string): string {
  return createHmac("sha256", secret).update(`email-unsubscribe.${userId}`).digest("hex").slice(0, 32);
}

export function verifyUnsubscribeToken(userId: number, token: string, secret: string): boolean {
  if (!Number.isInteger(userId) || userId <= 0 || !/^[0-9a-f]{32}$/.test(token)) return false;
  const expected = Buffer.from(unsubscribeToken(userId, secret));
  const actual = Buffer.from(token);
  return expected.length === actual.length && timingSafeEqual(expected, actual);
}

export function unsubscribeUrl(userId: number, secret: string, siteUrl = getSiteUrlFromEnv()): string {
  return `${siteUrl}/api/email/unsubscribe?u=${userId}&t=${unsubscribeToken(userId, secret)}`;
}

// ── 模板（簡體中文、內聯樣式、無 emoji） ──

function ctaUrl(campaign: LifecycleTemplate, siteUrl: string): string {
  return `${siteUrl}/?utm_source=email&utm_medium=lifecycle&utm_campaign=${campaign}`;
}

function layout(body: string, footer: string): string {
  return `<!doctype html><html><body style="margin:0;background:#f5f5f7;font-family:-apple-system,BlinkMacSystemFont,'PingFang SC','Microsoft YaHei',sans-serif;color:#1d1d1f">
<div style="max-width:520px;margin:0 auto;padding:32px 20px">
<div style="background:#ffffff;border-radius:20px;padding:32px 28px">
<div style="font-size:15px;font-weight:600;color:#6e6e73;margin-bottom:20px">Emu</div>
${body}
</div>
<div style="font-size:12px;line-height:1.6;color:#86868b;padding:16px 8px 0">${footer}</div>
</div></body></html>`;
}

function button(href: string, label: string): string {
  return `<a href="${href}" style="display:inline-block;background:#0071e3;color:#ffffff;text-decoration:none;font-size:15px;font-weight:600;padding:12px 24px;border-radius:999px">${label}</a>`;
}

function promptList(prompts: string[]): string {
  return prompts
    .map((p) => `<div style="font-size:14px;line-height:1.6;background:#f5f5f7;border-radius:12px;padding:10px 14px;margin-bottom:8px">${p}</div>`)
    .join("");
}

export function renderLifecycleEmail(
  template: LifecycleTemplate,
  opts: { siteUrl: string; unsubscribeUrl?: string },
): { subject: string; html: string } {
  const cta = ctaUrl(template, opts.siteUrl);
  if (template === "welcome") {
    return {
      subject: `新人礼 ${WELCOME_GIFT_COINS} 币已到账，够生成约 ${WELCOME_GIFT_IMAGE_COUNT} 张图`,
      html: layout(
        `<h1 style="font-size:22px;line-height:1.4;margin:0 0 12px">新人礼已到账</h1>
<p style="font-size:15px;line-height:1.7;margin:0 0 20px">已送你 ${WELCOME_GIFT_COINS} 币，够生成约 ${WELCOME_GIFT_IMAGE_COUNT} 张图。无需签到、无需充值，说一句想要的画面就能出图。不知道写什么？试试这几句：</p>
${promptList(EXAMPLE_PROMPTS)}
<div style="margin-top:24px">${button(cta, "马上生成")}</div>`,
        "你收到这封邮件，是因为你用 GitHub 或 Google 登录了 Emu。",
      ),
    };
  }
  return {
    subject: `你的 ${WELCOME_GIFT_COINS} 币还没用`,
    html: layout(
      `<h1 style="font-size:22px;line-height:1.4;margin:0 0 12px">你的 ${WELCOME_GIFT_COINS} 币还没用</h1>
<p style="font-size:15px;line-height:1.7;margin:0 0 20px">新人礼额度还在账上，够生成约 ${WELCOME_GIFT_IMAGE_COUNT} 张图。复制下面这句，粘贴到 Emu 首页的输入框，按发送就行：</p>
${promptList(EXAMPLE_PROMPTS.slice(0, 1))}
<div style="margin-top:24px">${button(cta, "去生成第一张")}</div>`,
      opts.unsubscribeUrl
        ? `不想再收到这类提醒？<a href="${opts.unsubscribeUrl}" style="color:#86868b">一键退订</a>`
        : "",
    ),
  };
}

// ── 執行一輪 ──

export type LifecycleRunReport = { skipped?: "no_api_key" | "no_secret"; sent: number; failed: number; aborted?: string };

export async function runLifecycleEmailsOnce(deps: {
  store: LifecycleEmailStore;
  apiKey: string | null;
  secret: string | null;
  send?: (message: EmailMessage) => Promise<SendResult>;
  now?: Date;
  siteUrl?: string;
  limit?: number;
}): Promise<LifecycleRunReport> {
  const report: LifecycleRunReport = { sent: 0, failed: 0 };
  if (!deps.apiKey) return { ...report, skipped: "no_api_key" };
  if (!deps.secret) return { ...report, skipped: "no_secret" };
  const apiKey = deps.apiKey;
  const secret = deps.secret;
  const send = deps.send ?? ((message: EmailMessage) => sendViaResend(message, apiKey));
  const now = deps.now ?? new Date();
  const siteUrl = deps.siteUrl ?? getSiteUrlFromEnv();
  const limit = deps.limit ?? LIFECYCLE_BATCH_LIMIT;

  const batches: Array<[LifecycleTemplate, LifecycleRecipient[]]> = [
    ["welcome", await deps.store.listWelcomeCandidates(limit)],
    ["nudge", await deps.store.listNudgeCandidates(limit, new Date(now.getTime() - NUDGE_DELAY_MS))],
  ];
  for (const [template, recipients] of batches) {
    for (const recipient of recipients) {
      if (!(await deps.store.claim(recipient.userId, template))) continue;
      const unsub = template === "nudge" ? unsubscribeUrl(recipient.userId, secret, siteUrl) : undefined;
      const { subject, html } = renderLifecycleEmail(template, { siteUrl, unsubscribeUrl: unsub });
      const result = await send({
        to: recipient.email,
        subject,
        html,
        idempotencyKey: `${template}:${recipient.userId}:v1`,
        headers: unsub ? { "List-Unsubscribe": `<${unsub}>`, "List-Unsubscribe-Post": "List-Unsubscribe=One-Click" } : undefined,
      });
      if (result.ok) {
        report.sent += 1;
        await deps.store.settle(recipient.userId, template, "sent", result.id);
      } else if (result.systemic) {
        await deps.store.release(recipient.userId, template);
        report.aborted = result.error.slice(0, 200);
        return report;
      } else {
        report.failed += 1;
        await deps.store.settle(recipient.userId, template, "failed", result.error.slice(0, 300));
      }
    }
  }
  return report;
}

// ── Postgres store ──

let schemaReady: Promise<void> | null = null;

function ensureSchema(sql: GenerationSql): Promise<void> {
  // 與 db/migrations/027_lifecycle_email.sql 同一 DDL（冪等，首用即建）。
  schemaReady ??= (async () => {
    await sql`
      CREATE TABLE IF NOT EXISTS email_send_log (
        user_id    bigint NOT NULL,
        template   text NOT NULL,
        status     text NOT NULL CHECK (status IN ('pending', 'sent', 'failed')),
        detail     text,
        created_at timestamptz NOT NULL DEFAULT now(),
        sent_at    timestamptz,
        PRIMARY KEY (user_id, template)
      )`;
    await sql`
      CREATE TABLE IF NOT EXISTS email_preference (
        user_id            bigint PRIMARY KEY,
        marketing_opt_out  boolean NOT NULL DEFAULT false,
        updated_at         timestamptz NOT NULL DEFAULT now()
      )`;
  })().catch((error) => {
    schemaReady = null;
    throw error;
  });
  return schemaReady;
}

type Row = { user_id: string | number; email: string };
const toRecipients = (rows: Row[]) => rows.map((r) => ({ userId: Number(r.user_id), email: r.email }));

export function createPostgresLifecycleEmailStore(sql: GenerationSql): LifecycleEmailStore {
  return {
    async listWelcomeCandidates(limit) {
      await ensureSchema(sql);
      return toRecipients(await sql<Row[]>`
        SELECT a.user_id, a.email
        FROM user_attribution a
        JOIN welcome_gift_grant g ON g.user_id = a.user_id AND g.status = 'applied'
        WHERE a.email IS NOT NULL
          AND NOT EXISTS (SELECT 1 FROM email_send_log l WHERE l.user_id = a.user_id AND l.template = 'welcome')
        ORDER BY a.updated_at
        LIMIT ${limit}`);
    },
    async listNudgeCandidates(limit, sentBefore) {
      await ensureSchema(sql);
      return toRecipients(await sql<Row[]>`
        SELECT a.user_id, a.email
        FROM user_attribution a
        JOIN email_send_log w ON w.user_id = a.user_id AND w.template = 'welcome'
          AND w.status = 'sent' AND w.sent_at < ${sentBefore.toISOString()}::timestamptz
        WHERE a.email IS NOT NULL
          AND NOT EXISTS (SELECT 1 FROM email_send_log l WHERE l.user_id = a.user_id AND l.template = 'nudge')
          AND NOT EXISTS (SELECT 1 FROM email_preference p WHERE p.user_id = a.user_id AND p.marketing_opt_out)
          AND NOT EXISTS (
            SELECT 1 FROM generation_job j
            WHERE j.status = 'succeeded'
              AND (j.tenant_id = 'web:' || a.user_id::text
                OR j.billing_user_id = a.user_id
                OR j.api_key_id IN (SELECT k.id FROM biz_api_key k WHERE k.user_id = a.user_id))
          )
        ORDER BY w.sent_at
        LIMIT ${limit}`);
    },
    async claim(userId, template) {
      await ensureSchema(sql);
      const rows = await sql`
        INSERT INTO email_send_log (user_id, template, status) VALUES (${userId}, ${template}, 'pending')
        ON CONFLICT (user_id, template) DO NOTHING
        RETURNING user_id`;
      return rows.length > 0;
    },
    async settle(userId, template, status, detail) {
      await sql`
        UPDATE email_send_log
        SET status = ${status}, detail = ${detail}, sent_at = CASE WHEN ${status} = 'sent' THEN now() ELSE sent_at END
        WHERE user_id = ${userId} AND template = ${template}`;
    },
    async release(userId, template) {
      await sql`DELETE FROM email_send_log WHERE user_id = ${userId} AND template = ${template} AND status = 'pending'`;
    },
  };
}

export async function setMarketingOptOut(sql: GenerationSql, userId: number): Promise<void> {
  await ensureSchema(sql);
  await sql`
    INSERT INTO email_preference (user_id, marketing_opt_out) VALUES (${userId}, true)
    ON CONFLICT (user_id) DO UPDATE SET marketing_opt_out = true, updated_at = now()`;
}

/** worker 帳本維護循環的掛點：失敗只記日誌，不擋任務路徑。 */
export async function runLifecycleEmailsWithSql(sql: GenerationSql): Promise<LifecycleRunReport> {
  return runLifecycleEmailsOnce({
    store: createPostgresLifecycleEmailStore(sql),
    apiKey: resendApiKey(),
    secret: unsubscribeSecret(),
  });
}

export { unsubscribeSecret };
