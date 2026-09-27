import assert from "node:assert/strict";
import test from "node:test";
import {
  NUDGE_DELAY_MS,
  renderLifecycleEmail,
  runLifecycleEmailsOnce,
  unsubscribeToken,
  verifyUnsubscribeToken,
  type EmailMessage,
  type LifecycleEmailStore,
  type LifecycleRecipient,
  type LifecycleTemplate,
} from "@/lib/lifecycle-email";

function fakeStore(welcome: LifecycleRecipient[], nudge: LifecycleRecipient[] = []) {
  const log = new Map<string, { status: string; detail: string | null }>();
  let nudgeCutoff: Date | null = null;
  const store: LifecycleEmailStore = {
    async listWelcomeCandidates() {
      return welcome.filter((r) => !log.has(`${r.userId}:welcome`));
    },
    async listNudgeCandidates(_limit, sentBefore) {
      nudgeCutoff = sentBefore;
      return nudge.filter((r) => !log.has(`${r.userId}:nudge`));
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
  return { store, log, cutoff: () => nudgeCutoff };
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
  assert.ok(sent[0].html.includes(url.toString().replace(/&/g, "&")));
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
  for (const tpl of ["welcome", "nudge"] as const) {
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
