// 侧车事实服务端层的具名验收（node:test）：
//   ① 只有「已验证 email ＋ 有 provider」才进落库形状（未验证／无来源一律丢）；
//   ② 两边皆空的事实不打库（hasAttributionFacts 是显式守卫）；
//   ③ 归因读取失败必须回 ok:false（呼叫方才能把来源拆分标成不可用，不假装大家都没归因）。

import test from "node:test";
import assert from "node:assert/strict";
import {
  buildOAuthAttributionInput,
  hasAttributionFacts,
  parseAttributionUpsertBody,
  readFunnelAttribution,
} from "./user-attribution";
import type { GenerationSql } from "./generation-core/database";

test("OAuth 落库形状：只有已验证 email 才带值，未验证一律 null（且不带 provider）", () => {
  const github = buildOAuthAttributionInput({
    userId: 501,
    provider: "github",
    githubEmails: [
      { email: "hidden@example.com", primary: true, verified: false },
      { email: "real@example.com", verified: true },
    ],
    firstTouch: { utmSource: "Bili", capturedAt: "2026-09-27T00:00:00.000Z" },
  });
  assert.equal(github.email, "real@example.com");
  assert.equal(github.emailProvider, "github");
  assert.equal(github.firstTouch?.utmSource, "Bili");

  const unverified = buildOAuthAttributionInput({
    userId: 502,
    provider: "github",
    githubEmails: [{ email: "hidden@example.com", primary: true, verified: false }],
  });
  assert.equal(unverified.email, null);
  assert.equal(unverified.emailProvider, null);
  assert.equal(unverified.firstTouch, null);

  const google = buildOAuthAttributionInput({
    userId: 503,
    provider: "google",
    googleProfile: { email: "u@gmail.com", email_verified: true },
  });
  assert.equal(google.email, "u@gmail.com");
  assert.equal(google.emailProvider, "google");

  const googleUnverified = buildOAuthAttributionInput({
    userId: 504,
    provider: "google",
    googleProfile: { email: "u@gmail.com", email_verified: false },
  });
  assert.equal(googleUnverified.email, null);
  assert.equal(googleUnverified.emailProvider, null);
});

test("hasAttributionFacts：userId 非法／两边皆空 → 不写库", () => {
  assert.equal(hasAttributionFacts({ userId: 0, email: "a@b.com" }), false);
  assert.equal(hasAttributionFacts({ userId: 1.5, email: "a@b.com" }), false);
  assert.equal(hasAttributionFacts({ userId: 7 }), false);
  assert.equal(hasAttributionFacts({ userId: 7, email: "   " }), false);
  assert.equal(hasAttributionFacts({ userId: 7, email: "a@b.com" }), true);
  assert.equal(hasAttributionFacts({ userId: 7, firstTouch: { utmSource: "x" } }), true);
});

test("入站请求体校验：email 必须与 provider 成对（来源不可考＝不存），userId 非法＝拒收", () => {
  assert.equal(
    parseAttributionUpsertBody({ userId: 12, email: "Real@Example.com", emailProvider: "github" })?.email,
    "real@example.com",
  );
  // 没 provider 的 email 一律丢（不知道是谁给的，就不是可触达事实）。
  assert.equal(parseAttributionUpsertBody({ userId: 12, email: "real@example.com" })?.email, null);
  assert.equal(parseAttributionUpsertBody({ userId: 12, email: "real@example.com", emailProvider: "wechat" })?.email, null);
  assert.equal(parseAttributionUpsertBody({ userId: 0, email: "a@b.com", emailProvider: "github" }), null);
  assert.equal(parseAttributionUpsertBody({ email: "a@b.com", emailProvider: "github" }), null);
  assert.equal(parseAttributionUpsertBody(null), null);

  const withTouch = parseAttributionUpsertBody({
    userId: "13",
    attribution: { signupSource: "bilibili", utmSource: "Bili", landingPath: "/", firstTouchAt: "2026-09-27T00:00:00.000Z" },
  });
  assert.equal(withTouch?.userId, 13);
  assert.equal(withTouch?.firstTouch?.utmSource, "Bili");
  assert.equal(withTouch?.firstTouch?.landingPath, "/");
  // 无 email 事实时，firstTouch 仍要能单独落库（微信路径）。
  assert.equal(hasAttributionFacts(withTouch!), true);
});

test("归因读取：空 cohort 不打库；读取失败回 ok:false（不静默假装没归因）", async () => {
  let calls = 0;
  const neverCalled = (() => {
    calls += 1;
    return Promise.resolve([]);
  }) as unknown as GenerationSql;
  assert.deepEqual(await readFunnelAttribution({ userIds: [], sql: neverCalled }), { rows: [], ok: true });
  assert.equal(calls, 0);

  const failing = (() => Promise.reject(new Error("relation \"user_attribution\" does not exist"))) as unknown as GenerationSql;
  const failed = await readFunnelAttribution({ userIds: [1, 2], sql: failing });
  assert.equal(failed.ok, false);
  assert.deepEqual(failed.rows, []);

  const ok = (() =>
    Promise.resolve([
      { user_id: "9", signup_source: "bilibili" },
      { user_id: 10, signup_source: "   " },
    ])) as unknown as GenerationSql;
  const read = await readFunnelAttribution({ userIds: [9, 10], sql: ok });
  assert.equal(read.ok, true);
  assert.deepEqual(read.rows, [
    { userId: 9, source: "bilibili" },
    { userId: 10, source: null },
  ]);
});
