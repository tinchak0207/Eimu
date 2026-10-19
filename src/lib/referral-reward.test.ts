import assert from "node:assert/strict";
import test from "node:test";
import { buildInviteUrl, inviteCodeFor, parseInviteCode } from "./referral-code";
import { looksLikeInviteCode } from "./first-touch-attribution";
import { buildShareUrl } from "./share-remix";
import {
  MAX_REWARDED_INVITES,
  referralRewardQuota,
  runReferralRewardsOnce,
  type ReferralCandidate,
  type ReferralDeps,
  type ReferralRewardStatus,
  type ReferralRole,
} from "./referral-reward";

const SECRET = "test-secret";

test("邀请码：自签可还原、伪造与畸形一律拒", () => {
  const code = inviteCodeFor(257, SECRET);
  assert.ok(looksLikeInviteCode(code), "形状要能过前端闸");
  assert.equal(parseInviteCode(code, SECRET), 257);
  assert.equal(parseInviteCode(code.toUpperCase(), SECRET), 257, "大小写不敏感");
  assert.equal(parseInviteCode(code, "other-secret"), null, "换密钥＝伪造");
  const [id36] = code.split("-");
  assert.equal(parseInviteCode(`${(258).toString(36)}-${code.split("-")[1]}`, SECRET), null, "改 id 不改签名＝拒");
  assert.equal(parseInviteCode(`${id36}-zzzzzzzz`, SECRET), null);
  assert.equal(parseInviteCode("", SECRET), null);
  assert.equal(parseInviteCode(null, SECRET), null);
  assert.equal(buildInviteUrl("https://eimu.dev/", code), `https://eimu.dev/?invite=${code}`);
});

test("分享连结带作者邀请码，且排在第一位（防落地路径截断）", () => {
  const url = new URL(buildShareUrl("https://eimu.dev", "abc123", "7-deadbeef"));
  assert.equal(url.searchParams.get("invite"), "7-deadbeef");
  assert.equal([...url.searchParams.keys()][0], "invite");
  assert.equal(url.searchParams.get("utm_source"), "share");
  assert.equal(new URL(buildShareUrl("https://eimu.dev", "abc123")).searchParams.has("invite"), false);
});

type RowKey = `${number}:${ReferralRole}`;

function harness(candidates: ReferralCandidate[], opts: { inviterUsed?: number; adjustFails?: boolean; baselineBlocked?: boolean } = {}) {
  const rows = new Map<RowKey, ReferralRewardStatus>();
  const adjusted: Array<{ userId: number; delta: number }> = [];
  const ledger: Array<{ userId: number; sourceRef: string }> = [];
  const quota = new Map<number, number>();
  const deps: ReferralDeps = {
    store: {
      async bind() {
        return true;
      },
      async listCandidates() {
        return candidates;
      },
      async countInviterRewards() {
        return opts.inviterUsed ?? 0;
      },
      async claim({ inviteeId, role }) {
        const key: RowKey = `${inviteeId}:${role}`;
        const cur = rows.get(key);
        if (cur && cur !== "failed") return false;
        rows.set(key, "pending");
        return true;
      },
      async mark(inviteeId, role, status) {
        rows.set(`${inviteeId}:${role}`, status);
      },
      async skip({ inviteeId, role }) {
        rows.set(`${inviteeId}:${role}`, "skipped");
      },
    },
    async ensureBaseline() {
      return opts.baselineBlocked ? { ready: false, blocked: true, reason: "x" } : { ready: true, blocked: false };
    },
    async readUpstreamQuota(userId) {
      return quota.get(userId) ?? 0;
    },
    async adjustUpstream(userId, delta) {
      if (opts.adjustFails) throw new Error("upstream 500");
      quota.set(userId, (quota.get(userId) ?? 0) + delta);
      adjusted.push({ userId, delta });
    },
    async recordLedger({ userId, sourceRef }) {
      ledger.push({ userId, sourceRef });
      return { posted: true };
    },
  };
  return { deps, rows, adjusted, ledger };
}

const fresh = (inviteeId: number, inviterId: number): ReferralCandidate => ({ inviteeId, inviterId, inviterStatus: null, inviteeStatus: null });

test("首图后双方各发一次，金额＝口径，帐本幂等键按角色分开", async () => {
  const h = harness([fresh(300, 117)]);
  const report = await runReferralRewardsOnce(h.deps);
  assert.deepEqual(report, { granted: 2, skipped: 0, failed: 0, aborted: false });
  assert.deepEqual(h.adjusted, [
    { userId: 300, delta: referralRewardQuota("invitee") },
    { userId: 117, delta: referralRewardQuota("inviter") },
  ]);
  assert.ok(referralRewardQuota("inviter") > referralRewardQuota("invitee"));
  assert.deepEqual(h.ledger.map((l) => l.sourceRef), ["referral:300:invitee:v1", "referral:300:inviter:v1"]);
  assert.equal(h.rows.get("300:invitee"), "applied");
  assert.equal(h.rows.get("300:inviter"), "applied");
});

test("已结清的角色不重发；邀请人达上限只发被邀请人", async () => {
  const done = harness([{ inviteeId: 301, inviterId: 117, inviterStatus: "applied", inviteeStatus: "applied" }]);
  assert.equal((await runReferralRewardsOnce(done.deps)).granted, 0);
  assert.equal(done.adjusted.length, 0);

  const capped = harness([fresh(302, 117)], { inviterUsed: MAX_REWARDED_INVITES });
  const report = await runReferralRewardsOnce(capped.deps);
  assert.deepEqual(report, { granted: 1, skipped: 1, failed: 0, aborted: false });
  assert.deepEqual(capped.adjusted.map((a) => a.userId), [302]);
  assert.equal(capped.rows.get("302:inviter"), "skipped");
});

test("上游调额失败＝整轮停，quota 未动记 failed 可重试", async () => {
  const h = harness([fresh(303, 117), fresh(304, 117)], { adjustFails: true });
  const report = await runReferralRewardsOnce(h.deps);
  assert.equal(report.aborted, true);
  assert.equal(h.rows.get("303:invitee"), "failed");
  assert.equal(h.rows.has("304:invitee"), false, "停了就不再连打");
});

test("基线不可得＝不动上游，记 failed", async () => {
  const h = harness([fresh(305, 117)], { baselineBlocked: true });
  const report = await runReferralRewardsOnce(h.deps);
  assert.equal(h.adjusted.length, 0);
  assert.equal(report.failed, 2);
  assert.equal(h.rows.get("305:invitee"), "failed");
});
