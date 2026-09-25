import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import {
  buildGoogleAuthorizeUrl,
  buildGoogleEmail,
  buildGooglePassword,
  buildGoogleUsername,
  createGoogleState,
  type GoogleProfile,
} from "./google-auth.ts";
import { embedTicketInState, extractTicketFromState } from "./github-auth.ts";

// Google OAuth 契約測試：授權 URL / 身份推導是純函數，直接跑；路由側只釘
// 關鍵接線（源碼字串斷言），避免為單測起 HTTP。

const readSrc = (rel: string) => readFileSync(new URL(rel, import.meta.url), "utf8");

const profile: GoogleProfile = {
  sub: "110234567890123456789",
  name: "Ada Lovelace",
  email: "ada@example.com",
  email_verified: true,
  picture: "https://lh3.googleusercontent.com/a/abc",
};

test("buildGoogleAuthorizeUrl carries the full OIDC authorize contract", () => {
  const raw = buildGoogleAuthorizeUrl({
    clientId: "client-123.apps.googleusercontent.com",
    state: "0f1e2d3c-4b5a-6978-8796-a5b4c3d2e1f0",
    redirectUri: "https://www.eimu.dev/api/auth/google/callback",
  });
  const url = new URL(raw);
  assert.equal(url.origin, "https://accounts.google.com");
  assert.equal(url.pathname, "/o/oauth2/v2/auth");
  assert.equal(url.searchParams.get("client_id"), "client-123.apps.googleusercontent.com");
  assert.equal(url.searchParams.get("redirect_uri"), "https://www.eimu.dev/api/auth/google/callback");
  assert.equal(url.searchParams.get("response_type"), "code");
  assert.equal(url.searchParams.get("scope"), "openid email profile");
  assert.equal(url.searchParams.get("state"), "0f1e2d3c-4b5a-6978-8796-a5b4c3d2e1f0");
  assert.equal(url.searchParams.get("prompt"), "select_account");
});

test("createGoogleState returns a dot-free uuid usable as handoff base", () => {
  const state = createGoogleState();
  assert.match(state, /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/);
  assert.doesNotMatch(state, /\./);
  assert.notEqual(createGoogleState(), state);
});

test("buildGoogleUsername is stable per sub and distinct across subs", () => {
  assert.equal(buildGoogleUsername(profile), "google_110234567890123456789");
  assert.equal(buildGoogleUsername({ sub: profile.sub }), buildGoogleUsername(profile));
  assert.notEqual(buildGoogleUsername({ sub: "999" }), buildGoogleUsername(profile));
  assert.match(buildGoogleUsername(profile), /^google_\d+$/);
});

test("buildGooglePassword is stable, secret-sensitive, and Gg+14hex shaped", () => {
  const password = buildGooglePassword(profile, "seed-a");
  assert.equal(password, buildGooglePassword(profile, "seed-a"));
  assert.notEqual(password, buildGooglePassword(profile, "seed-b"));
  assert.notEqual(password, buildGooglePassword({ ...profile, sub: "999" }, "seed-a"));
  assert.match(password, /^Gg[0-9a-f]{14}$/);
  assert.equal(password.length, 16);
  // HMAC 输入只含 sub：email/name 变了密码必须不变（sub 不可变，email 可変）。
  assert.equal(
    buildGooglePassword({ ...profile, email: "other@example.com", name: "Someone Else" }, "seed-a"),
    password,
  );
});

test("buildGoogleEmail stays synthetic and free of real personal data", () => {
  const email = buildGoogleEmail(profile);
  assert.equal(email, "google-110234567890123456789@oauth.tinchak0207.xyz");
  assert.match(email, /^[^@\s]+@[^@\s]+\.[a-z]+$/);
  assert.ok(!email.includes(profile.email!), "不得使用真实 Gmail 地址");
  assert.ok(!email.includes(profile.name!), "不得夹带真实姓名");
});

test("handoff state round-trips through the shared github-auth helpers", () => {
  const state = embedTicketInState(createGoogleState(), "deadbeefcafe0123456789abcdef0123");
  assert.equal(extractTicketFromState(state), "deadbeefcafe0123456789abcdef0123");
  assert.ok(state.includes("."), "handoff state 必须内嵌 ticket");
});

test("google start route points at google endpoints and seeds google_oauth_state", () => {
  const route = readSrc("../app/api/auth/google/start/route.ts");
  assert.ok(route.includes("buildGoogleAuthorizeUrl"), "start 必须构造 Google 授权 URL");
  assert.ok(route.includes("google_oauth_state"), "start 必须种 google_oauth_state cookie");
  assert.ok(route.includes("embedTicketInState"), "start 必须支持 handoff ticket 嵌入");
  assert.ok(route.includes("/api/auth/google/callback"), "redirect_uri 必须指向 google callback");
});

test("google callback wires exchange, userinfo, handoff and loopback branches", () => {
  const route = readSrc("../app/api/auth/google/callback/route.ts");
  assert.ok(route.includes("https://oauth2.googleapis.com/token"), "token 交换端点必须钉死");
  assert.ok(route.includes("application/x-www-form-urlencoded"), "token 交换必须用表单编码");
  assert.ok(route.includes("https://openidconnect.googleapis.com/v1/userinfo"), "userinfo 端点必须钉死");
  assert.ok(route.includes("AbortSignal.timeout"), "必须保留上游硬超时");
  assert.ok(route.includes("extractTicketFromState"), "callback 必须从 state 提取 ticket");
  assert.ok(route.includes("auth/complete?handoff=1"), "handoff 分支必须回 complete?handoff=1");
  assert.ok(route.includes("emu_oauth_loopback"), "必须保留 Emu 回环分支");
  assert.ok(route.includes("/auth/complete`"), "普通分支必须回 /auth/complete");
  assert.ok(route.includes("GOOGLE_LOGIN_SECRET"), "password seed 必须可独立钉死");
});
