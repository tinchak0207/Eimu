// 生命周期邮件（Resend）——激活到付费的四个时刻，各发一封、只发一次。
//
// 为什么在控制面 worker 跑：email 存在控制面 postgres 的 user_attribution 侧车表
// （db/migrations/025），「有没有出过图」在 generation_job、余额在 account_ledger，
// Vercel 都读不到；worker 的帐本维护循环（10 分钟一轮）天然是排程点，不另造 cron。
//
// 四封信对应四个产品时刻：
//   - welcome（交易类）：新人礼 applied 且有已验证 email。目标＝第一张图。
//   - nudge（营销类）：welcome 已发满 48h、仍无任何 succeeded 生成。目标＝第一张图。
//   - depleted（营销类）：出过图、新人礼额度已用到不够一张标准图、从未充值、
//     最后一次出图已过 1h（不在创作中途打扰）。目标＝第一次付费。
//   - key_idle（营销类）：建了第一把 biz key 满 24h、却没有任何 source=biz 的 job。
//     这一群不是被拒绝，是拿到 key 后没有下一步；信里直接放一段可直接跑通的 /v1 curl
//     （key 位置只放 $EMU_API_KEY 占位符，永不嵌入真实 key）。目标＝首次 API 调用。
// 每个示例都是「这句话 → 它真实生成的那张图」（public/email/example-*.jpg 由同一句
// prompt 以 gpt-image-2 生成），点击落地 `/?agent=1&q=` 交接通道：提示词已填进
// 助理输入框，按发送即出图；未登入者由 a8362440 的补送链在登入后自动送出。
//
// 幂等：先在 email_send_log 占位（user_id+template 唯一）再呼叫 Resend 并带
// Idempotency-Key。单收件人错误记 failed 不重试；系统性错误（401/403/429/5xx/网路）
// 释放占位、中止本轮、下轮重试。未配置 RESEND_API_KEY → 整体 no-op。
// 营销类带一键退订（List-Unsubscribe + 页内连结）。
//
// 隐私：email 永不进日志；日志只记 user_id 与计数。

import { createHmac, timingSafeEqual } from "node:crypto";
import type { GenerationSql } from "@/lib/generation-core/database";
import { readAccountBalance } from "@/lib/generation-core/account-ledger";
import { quickstartCurlExamples } from "@/lib/dev-quickstart";
import { PLANS } from "@/lib/plans";
import { getSiteUrlFromEnv } from "@/lib/site-url";
import {
  WELCOME_GIFT_COINS,
  WELCOME_GIFT_IMAGE_COUNT,
  WELCOME_GIFT_STANDARD_IMAGE_COINS,
} from "@/lib/welcome-gift";
import { DEFAULT_IMAGE_MODEL_ID } from "./image-model-ids.js";

export type LifecycleTemplate = "welcome" | "nudge" | "depleted" | "key_idle";
const MARKETING_TEMPLATES: ReadonlySet<LifecycleTemplate> = new Set(["nudge", "depleted", "key_idle"]);

export const LIFECYCLE_EMAIL_FROM = "Emu <hello@eimu.dev>";
export const NUDGE_DELAY_MS = 48 * 60 * 60_000;
/** 最后一次出图后至少等多久才发「额度用完」——不在创作中途打扰。 */
export const DEPLETED_QUIET_MS = 60 * 60_000;
/** 建 key 后至少观察多久仍无 biz 调用才发信（当天建的 key 不急著催）。 */
export const KEY_IDLE_DELAY_MS = 24 * 60 * 60_000;
/** curl 范例里的 key 占位符：邮件永不嵌入真实 key，收件人自己替换。 */
export const KEY_IDLE_KEY_PLACEHOLDER = "$EMU_API_KEY";
/** key 管理页的实际路由（对应 src/app/settings/api-keys/page.tsx，非 query tab）。 */
export const KEY_IDLE_SETTINGS_PATH = "/settings/api-keys";
/** 每轮每种模板最多发几封（Resend 免费档 100 封/天、2 req/s）。 */
export const LIFECYCLE_BATCH_LIMIT = 20;

/** 示例＝这句话与它真实生成的图（同一句 prompt、gpt-image-2、1536x1024）。 */
export const EMAIL_EXAMPLES = [
  { prompt: "一只橘猫趴在洒满阳光的窗台上，水彩风格", image: "/email/example-1.jpg" },
  { prompt: "雨后的赛博朋克城市街角，霓虹灯倒映在湿漉漉的地面上，电影感", image: "/email/example-2.jpg" },
  { prompt: "为一家叫「山雾」的咖啡店设计一张极简海报，米白底色，大量留白", image: "/email/example-3.jpg" },
] as const;

export type LifecycleRecipient = { userId: number; email: string; imagesMade?: number };

export type LifecycleEmailStore = {
  listWelcomeCandidates(limit: number): Promise<LifecycleRecipient[]>;
  listNudgeCandidates(limit: number, sentBefore: Date): Promise<LifecycleRecipient[]>;
  /** 已出图、额度不足一张标准图、未充值、最后出图早于 quietBefore 的用户。 */
  listDepletedCandidates(limit: number, quietBefore: Date): Promise<LifecycleRecipient[]>;
  /** 建第一把 biz key 早于 idleBefore、却无任何 source=biz job、未退订的用户。 */
  listKeyIdleCandidates(limit: number, idleBefore: Date): Promise<LifecycleRecipient[]>;
  /** 占位；已存在回 false。 */
  claim(userId: number, template: LifecycleTemplate): Promise<boolean>;
  settle(userId: number, template: LifecycleTemplate, status: "sent" | "failed", detail: string | null): Promise<void>;
  /** 撤销占位（系统性错误时），让下一轮重试。 */
  release(userId: number, template: LifecycleTemplate): Promise<void>;
};

export type EmailMessage = {
  to: string;
  subject: string;
  html: string;
  idempotencyKey: string;
  headers?: Record<string, string>;
};

/** systemic＝帐号/网域/限流/上游/网路层错误：与收件人无关，应释放占位、中止本轮、下轮重试。 */
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

// ── 退订 token（HMAC，复用两侧都有的 GENERATION_BILLING_RELAY_SECRET，域分隔） ──

export function unsubscribeSecret(env: NodeJS.ProcessEnv = process.env): string | null {
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

// ── 连结 ──

function utm(campaign: LifecycleTemplate, content: string): string {
  return `utm_source=email&utm_medium=lifecycle&utm_campaign=${campaign}&utm_content=${content}`;
}

/** 点一下＝提示词填进助理输入框（`?agent=1&q=` 既有交接通道），按发送即出图。 */
export function tryPromptUrl(siteUrl: string, prompt: string, campaign: LifecycleTemplate, content: string): string {
  return `${siteUrl}/?agent=1&q=${encodeURIComponent(prompt)}&${utm(campaign, content)}`;
}

/** 最便宜的一档（付费信只讲一个数字：最低多少钱能接著做）。 */
export function entryPlan(): { name: string; price: number; coins: number; images: number } {
  const plan = [...PLANS].sort((a, b) => a.price - b.price)[0];
  const shortName = plan.name.split("·")[0].trim();
  return {
    name: shortName,
    price: plan.price,
    coins: plan.coins,
    images: Math.floor(plan.coins / WELCOME_GIFT_STANDARD_IMAGE_COINS),
  };
}

// ── 版式（表格布局：Gmail/Apple Mail/Outlook/QQ 邮箱都稳；品牌色取自 DESIGN.md） ──

const C = {
  page: "#f5f7f9",
  card: "#ffffff",
  ink: "#2d3142",
  body: "#3a4052",
  muted: "#717886",
  hairline: "#e6e9ee",
  soft: "#f5f7f9",
  coin: "#a86b00",
} as const;
const FONT = "-apple-system,BlinkMacSystemFont,'PingFang SC','Hiragino Sans GB','Microsoft YaHei','Helvetica Neue',Arial,sans-serif";

function esc(value: string): string {
  return value.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}

function coin(text: string): string {
  return `<strong style="color:${C.coin};font-weight:600">${text}</strong>`;
}

function button(href: string, label: string): string {
  return `<table role="presentation" cellspacing="0" cellpadding="0" border="0"><tr><td style="border-radius:999px;background:${C.ink}">
<a href="${esc(href)}" style="display:inline-block;padding:13px 28px;font-family:${FONT};font-size:15px;font-weight:600;line-height:1;color:#ffffff;text-decoration:none;border-radius:999px">${label}</a>
</td></tr></table>`;
}

function codeBlock(code: string): string {
  return `<pre style="margin:0 0 16px;padding:16px 18px;background:${C.soft};border:1px solid ${C.hairline};border-radius:14px;overflow-x:auto;font-family:ui-monospace,SFMono-Regular,Menlo,Consolas,'Courier New',monospace;font-size:12.5px;line-height:1.7;color:${C.ink};white-space:pre">${esc(code)}</pre>`;
}

function note(html: string): string {
  return `<div style="margin:0 0 24px;font-size:13px;line-height:1.7;color:${C.muted}">${html}</div>`;
}

function exampleCard(siteUrl: string, example: (typeof EMAIL_EXAMPLES)[number], href: string, big = false): string {
  return `<table role="presentation" width="100%" cellspacing="0" cellpadding="0" border="0" style="margin:0 0 ${big ? 24 : 16}px;border:1px solid ${C.hairline};border-radius:16px;border-collapse:separate;overflow:hidden">
<tr><td style="padding:0;line-height:0"><a href="${esc(href)}"><img src="${siteUrl}${example.image}" width="${big ? 504 : 504}" alt="${esc(example.prompt)}" style="display:block;width:100%;max-width:504px;height:auto;border:0;border-radius:16px 16px 0 0"></a></td></tr>
<tr><td style="padding:14px 16px 16px;font-family:${FONT}">
<div style="font-size:14px;line-height:1.6;color:${C.body}">「${esc(example.prompt)}」</div>
<a href="${esc(href)}" style="display:inline-block;margin-top:8px;font-size:14px;font-weight:600;color:${C.ink};text-decoration:none">用这句生成 &rarr;</a>
</td></tr></table>`;
}

function layout(input: { siteUrl: string; preheader: string; body: string; footer: string }): string {
  return `<!doctype html><html lang="zh-CN"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="color-scheme" content="light"><title>Emu</title></head>
<body style="margin:0;padding:0;background:${C.page}">
<div style="display:none;max-height:0;overflow:hidden;opacity:0;color:${C.page}">${esc(input.preheader)}&#8199;&#65279;&#847;&#8199;&#65279;&#847;&#8199;&#65279;&#847;</div>
<table role="presentation" width="100%" cellspacing="0" cellpadding="0" border="0" style="background:${C.page}"><tr><td align="center" style="padding:32px 12px">
<table role="presentation" width="100%" cellspacing="0" cellpadding="0" border="0" style="max-width:568px">
<tr><td style="padding:0 8px 16px"><a href="${input.siteUrl}" style="text-decoration:none"><img src="${input.siteUrl}/icon-512.png" width="36" height="36" alt="Emu" style="display:inline-block;vertical-align:middle;border:0;border-radius:10px"><span style="display:inline-block;vertical-align:middle;margin-left:10px;font-family:${FONT};font-size:17px;font-weight:600;color:${C.ink}">Emu</span></a></td></tr>
<tr><td style="background:${C.card};border-radius:24px;padding:32px 32px 28px;font-family:${FONT};color:${C.body}">
${input.body}
</td></tr>
<tr><td style="padding:18px 16px 0;font-family:${FONT};font-size:12px;line-height:1.7;color:${C.muted}">${input.footer}</td></tr>
</table></td></tr></table></body></html>`;
}

function h1(text: string): string {
  return `<h1 style="margin:0 0 12px;font-size:24px;line-height:1.35;font-weight:700;color:${C.ink}">${text}</h1>`;
}

function lead(html: string): string {
  return `<p style="margin:0 0 24px;font-size:15px;line-height:1.75;color:${C.body}">${html}</p>`;
}

const FOOTER_REASON = "你收到这封邮件，是因为你用 GitHub 或 Google 登录了 Emu（eimu.dev）。";

function marketingFooter(unsub?: string): string {
  return unsub
    ? `${FOOTER_REASON}<br>不想再收到这类提醒？<a href="${esc(unsub)}" style="color:${C.muted}">一键退订</a>`
    : FOOTER_REASON;
}

// ── 模板 ──

/**
 * key_idle 信里的 curl：直接复用建 key 页的 gpt-image-2 范例（dev-quickstart 真源），
 * 只把 key 换成 $EMU_API_KEY 占位符——邮件永不嵌入真实 key。
 * catalog 内查无该 model 时回 null（宁可不给范例，也不给一段打不通的命令）。
 */
function keyIdleCurlExample(): string | null {
  const example = quickstartCurlExamples(KEY_IDLE_KEY_PLACEHOLDER).find(
    (item) => item.modelId === DEFAULT_IMAGE_MODEL_ID,
  );
  return example?.curl ?? null;
}

export type RenderOptions = { siteUrl: string; unsubscribeUrl?: string; imagesMade?: number };

export function renderLifecycleEmail(
  template: LifecycleTemplate,
  opts: RenderOptions,
): { subject: string; html: string } {
  const site = opts.siteUrl.replace(/\/+$/, "");

  if (template === "welcome") {
    const cards = EMAIL_EXAMPLES.map((ex, i) =>
      exampleCard(site, ex, tryPromptUrl(site, ex.prompt, "welcome", `example-${i + 1}`)),
    ).join("");
    return {
      subject: `送你 ${WELCOME_GIFT_COINS} 币：说一句话，就能出图`,
      html: layout({
        siteUrl: site,
        preheader: `无需签到、无需充值，现在就能生成约 ${WELCOME_GIFT_IMAGE_COUNT} 张图。`,
        body: `${h1("新人礼已到账")}
${lead(`已送你 ${coin(`${WELCOME_GIFT_COINS} 币`)}，够生成约 ${WELCOME_GIFT_IMAGE_COUNT} 张图。在 Emu 不用调参数，把想要的画面说出来就行。`)}
<div style="margin:0 0 14px;font-size:13px;font-weight:600;letter-spacing:0.02em;color:${C.muted}">不知道写什么？点一句，提示词会自动填好</div>
${cards}
<div style="padding-top:8px">${button(`${site}/?${utm("welcome", "cta")}`, "打开 Emu")}</div>`,
        footer: FOOTER_REASON,
      }),
    };
  }

  if (template === "nudge") {
    const ex = EMAIL_EXAMPLES[0];
    const href = tryPromptUrl(site, ex.prompt, "nudge", "example-1");
    return {
      subject: `你的 ${WELCOME_GIFT_COINS} 币还在，挑一句试试？`,
      html: layout({
        siteUrl: site,
        preheader: "点一下，提示词自动填好，按发送就出图。",
        body: `${h1(`${WELCOME_GIFT_COINS} 币还在账上`)}
${lead("你还没生成第一张图。试试下面这句：点一下，提示词会自动填进输入框，按发送就行，大约一分钟出图。")}
${exampleCard(site, ex, href, true)}
${button(href, "用这句生成")}`,
        footer: marketingFooter(opts.unsubscribeUrl),
      }),
    };
  }

  if (template === "key_idle") {
    const curl = keyIdleCurlExample();
    const keyHref = `${site}${KEY_IDLE_SETTINGS_PATH}?${utm("key_idle", "cta")}`;
    return {
      subject: "你的 API key 还没出过第一张图",
      html: layout({
        siteUrl: site,
        preheader: "复制一段命令就能出图，新人礼额度可直接调用。",
        body: `${h1("你的 API key 还没出过第一张图")}
${lead(`API key 建好了，但还没调用过 /v1。下面这段命令复制就能跑，新人礼 ${WELCOME_GIFT_IMAGE_COUNT} 张可直接调用，不用先充值。`)}
${curl ? codeBlock(curl) : ""}
${note(`把 <span style="font-family:ui-monospace,SFMono-Regular,Menlo,Consolas,'Courier New',monospace;color:${C.ink}">${KEY_IDLE_KEY_PLACEHOLDER}</span> 换成你自己的 key——在「查看我的 key」页面可以复制，key 只在你自己的机器上使用。`)}
${button(keyHref, "查看我的 key")}`,
        footer: marketingFooter(opts.unsubscribeUrl),
      }),
    };
  }

  const plan = entryPlan();
  const made = opts.imagesMade && opts.imagesMade > 0 ? opts.imagesMade : null;
  const pricingHref = `${site}/pricing?${utm("depleted", "cta")}`;
  return {
    subject: made ? `你已经用 Emu 做了 ${made} 张图，想接着做吗？` : "新人礼额度用完了，想接着做吗？",
    html: layout({
      siteUrl: site,
      preheader: `${plan.name} ¥${plan.price} 得 ${plan.coins} 币，够再做约 ${plan.images} 张。`,
      body: `${h1("新人礼额度用完了")}
${lead(`${made ? `你用 Emu 生成了 ${made} 张图，` : ""}新人礼额度已经用完。作品都保存在历史记录里，随时可以回去改图、放大或下载。`)}
<table role="presentation" width="100%" cellspacing="0" cellpadding="0" border="0" style="margin:0 0 24px;background:${C.soft};border-radius:16px"><tr><td style="padding:18px 20px;font-family:${FONT}">
<div style="font-size:13px;color:${C.muted}">最低一档</div>
<div style="margin-top:4px;font-size:18px;font-weight:700;color:${C.ink}">${esc(plan.name)} · ¥${plan.price}</div>
<div style="margin-top:4px;font-size:14px;line-height:1.6;color:${C.body}">得 ${coin(`${plan.coins} 币`)}，够生成约 ${plan.images} 张标准图。支付宝或微信付款，付完回到 Emu 自动到账。</div>
</td></tr></table>
${button(pricingHref, "去充值")}
<div style="margin-top:16px;font-size:14px"><a href="${site}/history?${utm("depleted", "history")}" style="color:${C.muted};text-decoration:none">先看看我的作品 &rarr;</a></div>`,
      footer: marketingFooter(opts.unsubscribeUrl),
    }),
  };
}

// ── 执行一轮 ──

export type LifecycleRunReport = {
  skipped?: "no_api_key" | "no_secret";
  sent: number;
  failed: number;
  aborted?: string;
};

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
  const siteUrl = (deps.siteUrl ?? getSiteUrlFromEnv()).replace(/\/+$/, "");
  const limit = deps.limit ?? LIFECYCLE_BATCH_LIMIT;

  const batches: Array<[LifecycleTemplate, () => Promise<LifecycleRecipient[]>]> = [
    ["welcome", () => deps.store.listWelcomeCandidates(limit)],
    ["nudge", () => deps.store.listNudgeCandidates(limit, new Date(now.getTime() - NUDGE_DELAY_MS))],
    ["depleted", () => deps.store.listDepletedCandidates(limit, new Date(now.getTime() - DEPLETED_QUIET_MS))],
    ["key_idle", () => deps.store.listKeyIdleCandidates(limit, new Date(now.getTime() - KEY_IDLE_DELAY_MS))],
  ];
  for (const [template, list] of batches) {
    for (const recipient of await list()) {
      if (!(await deps.store.claim(recipient.userId, template))) continue;
      const unsub = MARKETING_TEMPLATES.has(template) ? unsubscribeUrl(recipient.userId, secret, siteUrl) : undefined;
      const { subject, html } = renderLifecycleEmail(template, {
        siteUrl,
        unsubscribeUrl: unsub,
        imagesMade: recipient.imagesMade,
      });
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
  // 与 db/migrations/027_lifecycle_email.sql 同一 DDL（幂等，首用即建）。
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

type Row = { user_id: string | number; email: string; images_made?: string | number | null };
const toRecipients = (rows: Row[]) =>
  rows.map((r) => ({
    userId: Number(r.user_id),
    email: r.email,
    ...(r.images_made != null ? { imagesMade: Number(r.images_made) } : {}),
  }));

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
    async listDepletedCandidates(limit, quietBefore) {
      await ensureSchema(sql);
      const rows = await sql<Row[]>`
        SELECT a.user_id, a.email, s.images_made
        FROM user_attribution a
        JOIN welcome_gift_grant g ON g.user_id = a.user_id AND g.status = 'applied'
        JOIN LATERAL (
          SELECT count(*) AS images_made, max(j.finished_at) AS last_success
          FROM generation_job j
          WHERE j.status = 'succeeded'
            AND (j.tenant_id = 'web:' || a.user_id::text
              OR j.billing_user_id = a.user_id
              OR j.api_key_id IN (SELECT k.id FROM biz_api_key k WHERE k.user_id = a.user_id))
        ) s ON s.images_made > 0 AND s.last_success < ${quietBefore.toISOString()}::timestamptz
        WHERE a.email IS NOT NULL
          AND NOT EXISTS (SELECT 1 FROM email_send_log l WHERE l.user_id = a.user_id AND l.template = 'depleted')
          AND NOT EXISTS (SELECT 1 FROM email_preference p WHERE p.user_id = a.user_id AND p.marketing_opt_out)
          AND NOT EXISTS (SELECT 1 FROM account_ledger r WHERE r.billing_user_id = a.user_id AND r.entry_type = 'recharge')
        ORDER BY s.last_success
        LIMIT ${limit * 3}`;
      // 余额以帐本唯一读法判定（含订阅池 lazy 过期），不在 SQL 里重算一套。
      const out: LifecycleRecipient[] = [];
      for (const recipient of toRecipients(rows)) {
        if (out.length >= limit) break;
        const balance = await readAccountBalance(recipient.userId, { sql });
        if (balance.coins < WELCOME_GIFT_STANDARD_IMAGE_COINS) out.push(recipient);
      }
      return out;
    },
    async listKeyIdleCandidates(limit, idleBefore) {
      await ensureSchema(sql);
      return toRecipients(await sql<Row[]>`
        SELECT a.user_id, a.email
        FROM user_attribution a
        JOIN (
          SELECT user_id, min(created_at) AS first_key_at
          FROM biz_api_key
          GROUP BY user_id
        ) k ON k.user_id = a.user_id
        WHERE a.email IS NOT NULL
          AND k.first_key_at < ${idleBefore.toISOString()}::timestamptz
          AND NOT EXISTS (SELECT 1 FROM email_send_log l WHERE l.user_id = a.user_id AND l.template = 'key_idle')
          AND NOT EXISTS (SELECT 1 FROM email_preference p WHERE p.user_id = a.user_id AND p.marketing_opt_out)
          AND NOT EXISTS (
            SELECT 1 FROM generation_job j
            WHERE j.source = 'biz'
              AND (j.billing_user_id = a.user_id
                OR j.api_key_id IN (SELECT bk.id FROM biz_api_key bk WHERE bk.user_id = a.user_id)
                OR j.tenant_id IN (SELECT 'biz:' || bk.id FROM biz_api_key bk WHERE bk.user_id = a.user_id))
          )
        ORDER BY k.first_key_at
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

/** worker 帐本维护循环的挂点：失败只记日志，不挡任务路径。 */
export async function runLifecycleEmailsWithSql(sql: GenerationSql): Promise<LifecycleRunReport> {
  return runLifecycleEmailsOnce({
    store: createPostgresLifecycleEmailStore(sql),
    apiKey: resendApiKey(),
    secret: unsubscribeSecret(),
  });
}
