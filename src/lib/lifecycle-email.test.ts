import assert from "node:assert/strict";
import test from "node:test";
import type { GenerationSql } from "@/lib/generation-core/database";
import { WELCOME_GIFT_IMAGE_COUNT } from "@/lib/welcome-gift";
import {
  EMAIL_EXAMPLES,
  KEY_IDLE_DELAY_MS,
  KEY_IDLE_KEY_PLACEHOLDER,
  KEY_IDLE_SETTINGS_PATH,
  NUDGE_DELAY_MS,
  createPostgresLifecycleEmailStore,
  entryPlan,
  renderLifecycleEmail,
  runLifecycleEmailsOnce,
  unsubscribeToken,
  verifyUnsubscribeToken,
  type EmailMessage,
  type LifecycleEmailStore,
  type LifecycleRecipient,
  type LifecycleTemplate,
} from "@/lib/lifecycle-email";

/** key_idle 候选的事实来源：key 建立时间、有没有 biz job、有没有退订。 */
type KeyIdleFixture = {
  recipient: LifecycleRecipient;
  /** 第一把 biz key 建立的时间；null = 从没建过 key。 */
  firstKeyAt: Date | null;
  /** 该用户有没有任何 source=biz 的 job。 */
  hasBizJob?: boolean;
  /** 有没有退订营销邮件。 */
  optedOut?: boolean;
};

function fakeStore(
  welcome: LifecycleRecipient[],
  nudge: LifecycleRecipient[] = [],
  depleted: LifecycleRecipient[] = [],
  keyIdle: KeyIdleFixture[] = [],
) {
  const log = new Map<string, { status: string; detail: string | null }>();
  let nudgeCutoff: Date | null = null;
  let keyIdleCutoff: Date | null = null;
  const store: LifecycleEmailStore = {
    async listWelcomeCandidates() {
      return welcome.filter((r) => !log.has(`${r.userId}:welcome`));
    },
    async listNudgeCandidates(_limit, sentBefore) {
      nudgeCutoff = sentBefore;
      return nudge.filter((r) => !log.has(`${r.userId}:nudge`));
    },
    async listDepletedCandidates() {
      return depleted.filter((r) => !log.has(`${r.userId}:depleted`));
    },
    // 与生产 SQL 同一组闸门（读 runLifecycleEmailsOnce 传进来的 idleBefore，故 24h 常数受测）。
    async listKeyIdleCandidates(_limit, idleBefore) {
      keyIdleCutoff = idleBefore;
      return keyIdle
        .filter((f) => f.firstKeyAt !== null && f.firstKeyAt.getTime() < idleBefore.getTime())
        .filter((f) => !f.hasBizJob && !f.optedOut)
        .map((f) => f.recipient)
        .filter((r) => !log.has(`${r.userId}:key_idle`));
    },
    async claim(userId: number, template: LifecycleTemplate) {
      const key = `${userId}:${template}`;
      if (log.has(key)) return false;
      log.set(key, { status: "pending", detail: null });
      return true;
    },
    async settle(userId, template, status, detail) {
      log.set(`${userId}:${template}`, { status, detail });
    },
    async release(userId, template) {
      log.delete(`${userId}:${template}`);
    },
  };
  return { store, log, cutoff: () => nudgeCutoff, keyIdleCutoff: () => keyIdleCutoff };
}

const SECRET = "test-secret";
const SITE = "https://example.test";

test("no api key → no-op, nothing claimed", async () => {
  const { store, log } = fakeStore([{ userId: 1, email: "a@x.test" }]);
  const report = await runLifecycleEmailsOnce({ store, apiKey: null, secret: SECRET, siteUrl: SITE });
  assert.equal(report.skipped, "no_api_key");
  assert.equal(log.size, 0);
});

test("welcome sent once per user even across runs (idempotent)", async () => {
  const { store, log } = fakeStore([{ userId: 7, email: "a@x.test" }]);
  const sent: EmailMessage[] = [];
  const send = async (m: EmailMessage) => (sent.push(m), { ok: true as const, id: `re_${sent.length}` });
  await runLifecycleEmailsOnce({ store, apiKey: "k", secret: SECRET, send, siteUrl: SITE });
  await runLifecycleEmailsOnce({ store, apiKey: "k", secret: SECRET, send, siteUrl: SITE });
  assert.equal(sent.length, 1);
  assert.equal(sent[0].idempotencyKey, "welcome:7:v1");
  assert.equal(sent[0].headers, undefined, "transactional welcome carries no unsubscribe header");
  assert.deepEqual(log.get("7:welcome"), { status: "sent", detail: "re_1" });
});

test("send failure is recorded and not retried", async () => {
  const { store, log } = fakeStore([{ userId: 3, email: "a@x.test" }]);
  let calls = 0;
  const send = async () => (calls++, { ok: false as const, error: "HTTP 422 bad" });
  const r1 = await runLifecycleEmailsOnce({ store, apiKey: "k", secret: SECRET, send, siteUrl: SITE });
  await runLifecycleEmailsOnce({ store, apiKey: "k", secret: SECRET, send, siteUrl: SITE });
  assert.equal(r1.failed, 1);
  assert.equal(calls, 1);
  assert.equal(log.get("3:welcome")?.status, "failed");
});

test("nudge carries a verifiable one-click unsubscribe and uses a 48h cutoff", async () => {
  const now = new Date("2026-09-28T00:00:00Z");
  const { store, cutoff } = fakeStore([], [{ userId: 42, email: "b@x.test" }]);
  const sent: EmailMessage[] = [];
  const send = async (m: EmailMessage) => (sent.push(m), { ok: true as const, id: "re_n" });
  await runLifecycleEmailsOnce({ store, apiKey: "k", secret: SECRET, send, now, siteUrl: SITE });
  assert.equal(cutoff()?.getTime(), now.getTime() - NUDGE_DELAY_MS);
  assert.equal(sent.length, 1);
  const header = sent[0].headers?.["List-Unsubscribe"] ?? "";
  const url = new URL(header.slice(1, -1));
  assert.equal(url.pathname, "/api/email/unsubscribe");
  assert.ok(verifyUnsubscribeToken(Number(url.searchParams.get("u")), url.searchParams.get("t") ?? "", SECRET));
  assert.ok(sent[0].html.includes(url.toString().replace(/&/g, "&amp;")), "html href is the same url, entity-escaped");
});

test("unsubscribe token rejects other users, other secrets and junk", () => {
  const t = unsubscribeToken(5, SECRET);
  assert.ok(verifyUnsubscribeToken(5, t, SECRET));
  assert.equal(verifyUnsubscribeToken(6, t, SECRET), false);
  assert.equal(verifyUnsubscribeToken(5, t, "other"), false);
  assert.equal(verifyUnsubscribeToken(5, "zz", SECRET), false);
  assert.equal(verifyUnsubscribeToken(0, t, SECRET), false);
});

test("templates: simplified Chinese, utm-tagged CTA, no emoji", () => {
  for (const tpl of ["welcome", "nudge", "depleted", "key_idle"] as const) {
    const { subject, html } = renderLifecycleEmail(tpl, { siteUrl: SITE, unsubscribeUrl: `${SITE}/u` });
    assert.ok(subject.length > 0);
    assert.ok(html.includes(`utm_campaign=${tpl}`));
    assert.equal(/\p{Extended_Pictographic}/u.test(subject + html), false);
  }
});

test("systemic error (e.g. 403 domain not verified) releases the claim, aborts the run, retries next run", async () => {
  const { store, log } = fakeStore([{ userId: 1, email: "a@x.test" }, { userId: 2, email: "b@x.test" }]);
  let calls = 0;
  const down = async () => (calls++, { ok: false as const, error: "HTTP 403 domain not verified", systemic: true });
  const r1 = await runLifecycleEmailsOnce({ store, apiKey: "k", secret: SECRET, send: down, siteUrl: SITE });
  assert.equal(calls, 1, "stops at first systemic error");
  assert.ok(r1.aborted);
  assert.equal(log.size, 0, "claim released");
  const up = async () => ({ ok: true as const, id: "re_ok" });
  const r2 = await runLifecycleEmailsOnce({ store, apiKey: "k", secret: SECRET, send: up, siteUrl: SITE });
  assert.equal(r2.sent, 2);
});

test("welcome: every example links into the assistant input with its exact prompt", () => {
  const { html } = renderLifecycleEmail("welcome", { siteUrl: SITE });
  for (const ex of EMAIL_EXAMPLES) {
    assert.ok(html.includes(`${SITE}${ex.image}`), "example image is absolute on the site");
    assert.ok(html.includes(`/?agent=1&amp;q=${encodeURIComponent(ex.prompt)}`), "one click fills the prompt");
  }
  assert.equal(html.includes("退订"), false, "transactional welcome has no unsubscribe");
});

test("depleted: names images made and the cheapest plan, carries unsubscribe", async () => {
  const { store } = fakeStore([], [], [{ userId: 9, email: "c@x.test", imagesMade: 4 }]);
  const sent: EmailMessage[] = [];
  const send = async (m: EmailMessage) => (sent.push(m), { ok: true as const, id: "re_d" });
  await runLifecycleEmailsOnce({ store, apiKey: "k", secret: SECRET, send, siteUrl: SITE });
  assert.equal(sent.length, 1);
  assert.equal(sent[0].idempotencyKey, "depleted:9:v1");
  assert.ok(sent[0].subject.includes("4 张图"));
  const plan = entryPlan();
  assert.ok(sent[0].html.includes(`¥${plan.price}`));
  assert.ok(plan.images > 0 && !plan.name.includes("·"));
  assert.ok(sent[0].headers?.["List-Unsubscribe"]);
  assert.ok(sent[0].html.includes("/pricing?utm_source=email"));
});

// ── key_idle：建了 key 却零调用的召回（S7） ──

const NOW = new Date("2026-09-28T00:00:00Z");
const HOUR = 60 * 60_000;
const hoursAgo = (hours: number) => new Date(NOW.getTime() - hours * HOUR);

/** 预设合格：建 key 已 25h、无 biz job、未退订、有已验证 email。 */
const eligible = (overrides: Partial<KeyIdleFixture> = {}): KeyIdleFixture => ({
  recipient: { userId: 61, email: "d@x.test" },
  firstKeyAt: hoursAgo(25),
  ...overrides,
});

async function runKeyIdle(fixtures: KeyIdleFixture[]) {
  const state = fakeStore([], [], [], fixtures);
  const sent: EmailMessage[] = [];
  const send = async (m: EmailMessage) => (sent.push(m), { ok: true as const, id: `re_${sent.length}` });
  const report = await runLifecycleEmailsOnce({
    store: state.store,
    apiKey: "k",
    secret: SECRET,
    send,
    now: NOW,
    siteUrl: SITE,
  });
  return { ...state, sent, report };
}

test("key_idle: 没建 key → 不发", async () => {
  const { sent, report } = await runKeyIdle([eligible({ firstKeyAt: null })]);
  assert.equal(sent.length, 0);
  assert.equal(report.sent, 0);
});

test("key_idle: 建了未满 24 小时 → 不发", async () => {
  const { sent } = await runKeyIdle([eligible({ firstKeyAt: hoursAgo(23) })]);
  assert.equal(sent.length, 0);
});

test("key_idle: 已有 source=biz 的 job → 不发", async () => {
  const { sent } = await runKeyIdle([eligible({ hasBizJob: true })]);
  assert.equal(sent.length, 0);
});

test("key_idle: 已退订营销邮件 → 不发", async () => {
  const { sent } = await runKeyIdle([eligible({ optedOut: true })]);
  assert.equal(sent.length, 0);
});

test("key_idle: 四条件全满足 → 发一封；curl 只放占位符、CTA 指真路由、HTML 无 sk-", async () => {
  const { sent, keyIdleCutoff } = await runKeyIdle([eligible()]);
  assert.equal(keyIdleCutoff()?.getTime(), NOW.getTime() - KEY_IDLE_DELAY_MS, "24h 切点由生产常数提供");
  assert.equal(sent.length, 1);
  const mail = sent[0];
  assert.equal(mail.idempotencyKey, "key_idle:61:v1");
  assert.equal(mail.subject, "你的 API key 还没出过第一张图");
  assert.ok(mail.html.includes(`Bearer ${KEY_IDLE_KEY_PLACEHOLDER}`), "key 位置只放 $EMU_API_KEY 占位符");
  assert.ok(
    mail.html.includes("&quot;model&quot;:&quot;gpt-image-2&quot;"),
    "curl 复用 dev-quickstart 的 gpt-image-2 范例（HTML 内引号已转义）",
  );
  assert.ok(
    mail.html.includes(`新人礼 ${WELCOME_GIFT_IMAGE_COUNT} 张可直接调用`),
    "余额字面取自 WELCOME_GIFT 常数",
  );
  assert.ok(
    mail.html.includes(`${SITE}${KEY_IDLE_SETTINGS_PATH}?utm_source=email`),
    "CTA 指向实际存在的 key 管理路由",
  );
  assert.ok(mail.html.includes("一键退订"));
  assert.equal(/sk-/.test(mail.html), false, "渲染出的 HTML 不含任何 sk- 开头字串");
  assert.ok(mail.headers?.["List-Unsubscribe"], "营销信带一键退订 header");
});

test("key_idle: 每人只发一次（email_send_log 幂等）", async () => {
  const { store, log } = fakeStore([], [], [], [eligible()]);
  const sent: EmailMessage[] = [];
  const send = async (m: EmailMessage) => (sent.push(m), { ok: true as const, id: "re_k" });
  const deps = { store, apiKey: "k", secret: SECRET, send, now: NOW, siteUrl: SITE };
  await runLifecycleEmailsOnce(deps);
  await runLifecycleEmailsOnce(deps);
  assert.equal(sent.length, 1);
  assert.deepEqual(log.get("61:key_idle"), { status: "sent", detail: "re_k" });
});

test("key_idle 候选 SQL：24h 切点、零 source=biz、未退订、一次性（变更探针）", async () => {
  const queries: string[] = [];
  const values: unknown[][] = [];
  const tagged = (async (strings: TemplateStringsArray, ...v: unknown[]) => {
    queries.push(strings.join(" ? "));
    values.push(v);
    return [];
  }) as unknown as GenerationSql;
  await createPostgresLifecycleEmailStore(tagged).listKeyIdleCandidates(20, new Date("2026-09-27T00:00:00.000Z"));
  const query = queries.find((q) => q.includes("source = 'biz'")) ?? "";
  assert.ok(query.includes("FROM biz_api_key"), "以 biz_api_key 判定建 key 时间");
  assert.ok(query.includes("min(created_at)"), "第一把 key = 最早 created_at");
  assert.ok(query.includes("l.template = 'key_idle'"), "一次性由 email_send_log 保证");
  assert.ok(query.includes("marketing_opt_out"), "退订者剔除");
  assert.ok(query.includes("j.api_key_id"), "biz job 以 api_key_id 归属到用户");
});

test("key_idle: 渲染 HTML 全域不含 sk- 字串（直接渲染，不经 store）", () => {
  const { subject, html } = renderLifecycleEmail("key_idle", { siteUrl: SITE, unsubscribeUrl: `${SITE}/u` });
  assert.equal(/sk-/.test(subject + html), false);
  assert.ok(html.includes(KEY_IDLE_KEY_PLACEHOLDER));
});
