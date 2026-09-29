// 首次觸達歸因純函式層的具名驗收（node:test，無 DOM）。
//
// 釘住三件會被「改壞了還靜默通過」的事：
//   ① email 只認已驗證（GitHub verified / Google email_verified），未驗證一律 null；
//   ② first-touch cookie 已有合法值時**不覆蓋**（回 null＝呼叫方不寫）；
//   ③ 分組鍵口徑：utm_source → referrer host → 'direct'，本站自身不算來源。

import test from "node:test";
import assert from "node:assert/strict";
import {
  FIRST_TOUCH_COOKIE_VERSION,
  UNATTRIBUTED_SOURCE,
  decodeFirstTouchCookieValue,
  deriveSignupSource,
  encodeFirstTouchCookieValue,
  firstTouchFromLocation,
  isPlausibleEmail,
  referrerHostFrom,
  resolveFirstTouchCookieValue,
  selectVerifiedGitHubEmail,
  selectVerifiedGoogleEmail,
} from "./first-touch-attribution";

test("first-touch cookie：已有合法值不覆蓋（回 null），無值／壞值／舊版本才寫新值", () => {
  const first = {
    utmSource: "Bilibili-Video",
    utmMedium: "social",
    utmCampaign: "launch-0927",
    referrerHost: "m.bilibili.com",
    landingPath: "/",
    capturedAt: "2026-09-27T01:00:00.000Z",
  };
  const encoded = encodeFirstTouchCookieValue(first);
  const decoded = decodeFirstTouchCookieValue(encoded);
  assert.equal(decoded?.utmSource, "Bilibili-Video");
  assert.equal(decoded?.utmMedium, "social");
  assert.equal(decoded?.utmCampaign, "launch-0927");
  assert.equal(decoded?.referrerHost, "m.bilibili.com");
  assert.equal(decoded?.capturedAt, "2026-09-27T01:00:00.000Z");

  // 已有合法值：回 null = 不重寫（首觸時間戳與 90 天窗口固定不動）。
  const second = { utmSource: "weixin", capturedAt: "2026-09-28T01:00:00.000Z" };
  assert.equal(resolveFirstTouchCookieValue(encoded, second), null);
  // 但解出來的仍是第一次那一份事實。
  assert.equal(decodeFirstTouchCookieValue(encoded)?.utmSource, "Bilibili-Video");

  // 沒值 → 寫；壞值 → 重寫；版本號不對（舊格式／外來字串）→ 重寫。
  const written = resolveFirstTouchCookieValue(null, second);
  assert.equal(typeof written, "string");
  assert.equal(decodeFirstTouchCookieValue(written)?.utmSource, "weixin");
  assert.equal(typeof resolveFirstTouchCookieValue("not-json", second), "string");
  assert.equal(typeof resolveFirstTouchCookieValue(encodeURIComponent(JSON.stringify({ v: 9, u: "x" })), second), "string");
  assert.equal(decodeFirstTouchCookieValue(""), null);
  assert.equal(decodeFirstTouchCookieValue(null), null);
  assert.equal(decodeFirstTouchCookieValue("%7B"), null);
  assert.equal(FIRST_TOUCH_COOKIE_VERSION, 1);
});

test("分組鍵：utm_source 小寫勝出 → 其次 referrer host → 最後 direct；本站自身不算來源", () => {
  assert.equal(deriveSignupSource({ utmSource: "BiliBili" }), "bilibili");
  assert.equal(deriveSignupSource({ utmSource: "  ", referrerHost: "m.bilibili.com" }), "m.bilibili.com");
  assert.equal(deriveSignupSource({ referrerHost: "B23.TV" }), "b23.tv");
  assert.equal(deriveSignupSource({}), "direct");
  assert.equal(deriveSignupSource({ utmSource: "", referrerHost: null }), "direct");
  assert.notEqual(UNATTRIBUTED_SOURCE, "direct");

  assert.equal(referrerHostFrom("https://m.bilibili.com/video/x", "www.eimu.dev"), "m.bilibili.com");
  assert.equal(referrerHostFrom("https://www.eimu.dev/pricing", "www.eimu.dev"), null);
  assert.equal(referrerHostFrom("", "www.eimu.dev"), null);
  assert.equal(referrerHostFrom("不是網址", "www.eimu.dev"), null);

  // 站內跳轉（referrer = 自己的網域）→ 只留 utm；都沒有 → direct。
  const own = firstTouchFromLocation({
    search: "",
    referrer: "https://www.eimu.dev/",
    selfHost: "www.eimu.dev",
    pathname: "/pricing",
    capturedAt: "2026-09-27T02:00:00.000Z",
  });
  assert.equal(own.referrerHost, null);
  assert.equal(own.landingPath, "/pricing");
  assert.equal(deriveSignupSource(own), "direct");

  const channel = firstTouchFromLocation({
    search: "?utm_source=Bili&utm_medium=cpc&utm_campaign=launch",
    referrer: "https://m.bilibili.com/video/BV1",
    selfHost: "www.eimu.dev",
    pathname: "/",
  });
  assert.equal(channel.utmSource, "Bili");
  assert.equal(channel.utmMedium, "cpc");
  assert.equal(channel.utmCampaign, "launch");
  assert.equal(deriveSignupSource(channel), "bili");
});

test("email 只認已驗證：GitHub 挑 verified（優先 primary），Google 認 email_verified===true", () => {
  assert.equal(
    selectVerifiedGitHubEmail([
      { email: "public@example.com", primary: true, verified: false },
      { email: "real@example.com", primary: true, verified: true },
      { email: "other@example.com", verified: true },
    ]),
    "real@example.com",
  );
  // 只有未驗證的 → null（絕不回退、絕不回退到合成 email）。
  assert.equal(selectVerifiedGitHubEmail([{ email: "public@example.com", primary: true, verified: false }]), null);
  assert.equal(selectVerifiedGitHubEmail([]), null);
  assert.equal(selectVerifiedGitHubEmail(null), null);
  assert.equal(selectVerifiedGitHubEmail(undefined), null);
  // verified 必須嚴格等於 true（字串 "true" 不算）；畸形信箱不算。
  assert.equal(selectVerifiedGitHubEmail([{ email: "a@b.com", verified: "true" as unknown as boolean }]), null);
  assert.equal(selectVerifiedGitHubEmail([{ email: "not-an-email", verified: true }]), null);
  assert.equal(selectVerifiedGitHubEmail([{ email: "  UP@Example.COM ", verified: true }]), "up@example.com");

  assert.equal(selectVerifiedGoogleEmail({ email: "u@gmail.com", email_verified: true }), "u@gmail.com");
  assert.equal(selectVerifiedGoogleEmail({ email: "u@gmail.com", email_verified: false }), null);
  assert.equal(selectVerifiedGoogleEmail({ email: "u@gmail.com" }), null);
  assert.equal(selectVerifiedGoogleEmail({ email_verified: true }), null);
  assert.equal(selectVerifiedGoogleEmail(null), null);

  assert.equal(isPlausibleEmail("a@b.com"), true);
  assert.equal(isPlausibleEmail("a b@c.com"), false);
  assert.equal(isPlausibleEmail("a@@b.com"), false);
  assert.equal(isPlausibleEmail("@b.com"), false);
  assert.equal(isPlausibleEmail("a@"), false);
  assert.equal(isPlausibleEmail(""), false);
  assert.equal(isPlausibleEmail(42), false);
});
