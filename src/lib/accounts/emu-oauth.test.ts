// Emu OAuth 回环凭证的纯函数测试。
// 直接跑 sign/verify，不走 HTTP：凭证逻辑与路由解耦，正反例都钉在函数上。

import test from "node:test";
import assert from "node:assert/strict";
import { createHmac } from "node:crypto";
import {
  EMU_OAUTH_CODE_TTL_MS,
  emuOauthSecret,
  signEmuOauthCode,
  verifyEmuOauthCode,
} from "./emu-oauth";

const SECRET_A = "test-emu-oauth-secret-a";
const SECRET_B = "test-emu-oauth-secret-b";

const savedSecret = process.env.EMU_OAUTH_SECRET;
const savedClientSecret = process.env.GITHUB_CLIENT_SECRET;

test.before(() => {
  process.env.EMU_OAUTH_SECRET = SECRET_A;
  delete process.env.GITHUB_CLIENT_SECRET;
});

test.after(() => {
  if (savedSecret === undefined) delete process.env.EMU_OAUTH_SECRET;
  else process.env.EMU_OAUTH_SECRET = savedSecret;
  if (savedClientSecret === undefined) delete process.env.GITHUB_CLIENT_SECRET;
  else process.env.GITHUB_CLIENT_SECRET = savedClientSecret;
});

/** 按与 signEmuOauthCode 相同的格式手工构造凭证（用于过期/未来时间戳用例）。 */
function craft(userId: number, expiresAt: number, secret: string): string {
  const payload = `${userId}.${expiresAt}`;
  const hmac = createHmac("sha256", secret).update(payload, "utf8").digest("hex");
  return `${Buffer.from(payload, "utf8").toString("base64url")}.${hmac}`;
}

test("签发的凭证能验回正确的 userId", () => {
  const code = signEmuOauthCode(12345);
  assert.equal(verifyEmuOauthCode(code), 12345);
});

test("凭证过期必须拒绝（手工构造已过期时间戳）", () => {
  const expired = craft(12345, Date.now() - 1000, SECRET_A);
  assert.equal(verifyEmuOauthCode(expired), null);
});

test("篡改 payload 必须拒绝", () => {
  const code = signEmuOauthCode(12345);
  const dot = code.lastIndexOf(".");
  const payload = code.slice(0, dot);
  const flipped = payload[0] === "A" ? "B" : "A";
  const tampered = `${flipped}${payload.slice(1)}.${code.slice(dot + 1)}`;
  assert.equal(verifyEmuOauthCode(tampered), null);
});

test("篡改签名必须拒绝", () => {
  const code = signEmuOauthCode(12345);
  const dot = code.lastIndexOf(".");
  const signature = code.slice(dot + 1);
  const flipped = signature[0] === "0" ? "1" : "0";
  const tampered = `${code.slice(0, dot)}.${flipped}${signature.slice(1)}`;
  assert.equal(verifyEmuOauthCode(tampered), null);
});

test("换一把 secret 签发的凭证必须拒绝", () => {
  const code = signEmuOauthCode(12345); // 用 SECRET_A 签
  process.env.EMU_OAUTH_SECRET = SECRET_B;
  try {
    assert.equal(verifyEmuOauthCode(code), null);
  } finally {
    process.env.EMU_OAUTH_SECRET = SECRET_A;
  }
});

test("坏格式一律返回 null，不抛", () => {
  for (const bad of ["", "garbage", "abc", "a.b", "....", "xxx.yyy", "MTIzLjQ1NjcuMTIz.y"]) {
    assert.equal(verifyEmuOauthCode(bad), null, `格式「${bad}」应被判无效`);
  }
});

test("payload 里塞非数字 userId / 过期时间必须拒绝", () => {
  // base64url("abc.def.ghi") —— userId/expiry 都不是纯数字
  const badPayload = Buffer.from("abc.def.ghi", "utf8").toString("base64url");
  const hmac = createHmac("sha256", SECRET_A).update("abc.def.ghi", "utf8").digest("hex");
  assert.equal(verifyEmuOauthCode(`${badPayload}.${hmac}`), null);
});

test("EMU_OAUTH_SECRET 缺失时回退 GITHUB_CLIENT_SECRET", () => {
  delete process.env.EMU_OAUTH_SECRET;
  process.env.GITHUB_CLIENT_SECRET = "gh-fallback-secret";
  try {
    assert.equal(emuOauthSecret(), "gh-fallback-secret");
    const code = signEmuOauthCode(7);
    assert.equal(verifyEmuOauthCode(code), 7);
  } finally {
    process.env.EMU_OAUTH_SECRET = SECRET_A;
    delete process.env.GITHUB_CLIENT_SECRET;
  }
});

test("两个 secret 都没有时 emuOauthSecret 抛错，verify 返回 null", () => {
  delete process.env.EMU_OAUTH_SECRET;
  delete process.env.GITHUB_CLIENT_SECRET;
  try {
    assert.throws(() => emuOauthSecret());
    assert.equal(verifyEmuOauthCode(signEmuOauthCodeOrThrow()), null);
  } finally {
    process.env.EMU_OAUTH_SECRET = SECRET_A;
  }
  function signEmuOauthCodeOrThrow(): string {
    try {
      return signEmuOauthCode(1);
    } catch {
      return "unreachable";
    }
  }
});

test("TTL 常量是 60 秒", () => {
  assert.equal(EMU_OAUTH_CODE_TTL_MS, 60_000);
});
