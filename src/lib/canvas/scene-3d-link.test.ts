// 連接碼簽章（`src/lib/canvas/scene-3d-link.ts`）的真函式測試。
//
// 為什麼直呼真函式而不是掃源碼字串：本檔要釘的是**驗簽的判定本身**
// （有效通過 / 過期拒 / 被竄改拒 / 別的密鑰簽的拒 / 別的用途的碼拒），
// 這些都是可以真跑出來的結論；源碼斷言只能證明「有寫」，證明不了「判得對」。
// 真執行器：`npx tsx --test src/lib/canvas/scene-3d-link.test.ts`（本倉無 vitest）。
//
// 四個負向對照各有不可替代的作用：
//   · 竄改 payload 不竄改簽章 ⇒ 擋「改 userId 冒充別人上傳」；
//   · 換密鑰簽 ⇒ 擋「別的服務/別的部署拿同一格式偽造」；
//   · 同密鑰但無域前綴（emu-oauth 形態）⇒ 擋跨協議碼通用（本檔最重要的一條）；
//   · 缺 env ⇒ 擋「靜默降級成無簽章」。

import test, { afterEach, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { createHmac } from "node:crypto";
import {
  SCENE_3D_LINK_PURPOSE,
  SCENE_3D_LINK_TTL_MS,
  isLinkableUserId,
  scene3dLinkBearer,
  scene3dLinkConfigured,
  signScene3dLinkCode,
  verifyScene3dLinkCode,
} from "./scene-3d-link";

const SECRET_A = "test-scene3d-link-secret-a";
const SECRET_B = "test-scene3d-link-secret-b";

const savedSecret = process.env.SCENE_3D_LINK_SECRET;

beforeEach(() => {
  process.env.SCENE_3D_LINK_SECRET = SECRET_A;
});

afterEach(() => {
  if (savedSecret === undefined) delete process.env.SCENE_3D_LINK_SECRET;
  else process.env.SCENE_3D_LINK_SECRET = savedSecret;
});

/** 用指定密鑰簽一個任意 payload（模擬「另一方」自己生的碼，不經過本模組）。 */
function forge(secret: string, payload: string): string {
  return `${Buffer.from(payload, "utf8").toString("base64url")}.${createHmac("sha256", secret)
    .update(payload, "utf8")
    .digest("hex")}`;
}

test("TTL 是 15 分鐘（用戶要肉眼複製，60 秒不夠）", () => {
  assert.equal(SCENE_3D_LINK_TTL_MS, 15 * 60_000);
});

test("有效碼：驗簽回同一個 userId，且到期時間落在 TTL 窗口內", () => {
  const before = Date.now();
  const code = signScene3dLinkCode(42);
  const verified = verifyScene3dLinkCode(code);
  assert.equal(verified.ok, true);
  if (!verified.ok) return;
  assert.equal(verified.userId, 42);
  assert.ok(verified.expiresAt >= before + SCENE_3D_LINK_TTL_MS - 5_000, "到期時間約等於鑄碼時刻 + TTL");
  assert.ok(verified.expiresAt <= Date.now() + SCENE_3D_LINK_TTL_MS, "到期時間不得超過 TTL");
});

test("過期碼拒：簽章有效但時效已過 ⇒ reason 必須是 expired（不是 invalid）", () => {
  // ttl 傳負值＝簽一張「已經過期」的碼，不必改時鐘。
  const code = signScene3dLinkCode(42, -1_000);
  const verified = verifyScene3dLinkCode(code);
  assert.equal(verified.ok, false);
  if (verified.ok) return;
  assert.equal(verified.reason, "expired");
});

test("被竄改 payload 拒：換掉 userId 但留著原簽章 ⇒ invalid", () => {
  const code = signScene3dLinkCode(42);
  const dot = code.lastIndexOf(".");
  const signature = code.slice(dot + 1);
  const tamperedPayload = Buffer.from(`${SCENE_3D_LINK_PURPOSE}.999.${Date.now() + SCENE_3D_LINK_TTL_MS}`)
    .toString("base64url");
  const verified = verifyScene3dLinkCode(`${tamperedPayload}.${signature}`);
  assert.equal(verified.ok, false);
  if (verified.ok) return;
  assert.equal(verified.reason, "invalid");
});

test("別的密鑰簽的碼拒（負向對照）：SECRET_B 簽、SECRET_A 驗 ⇒ invalid", () => {
  process.env.SCENE_3D_LINK_SECRET = SECRET_B;
  const foreignCode = signScene3dLinkCode(42);
  process.env.SCENE_3D_LINK_SECRET = SECRET_A;
  const verified = verifyScene3dLinkCode(foreignCode);
  assert.equal(verified.ok, false);
  if (verified.ok) return;
  assert.equal(verified.reason, "invalid");
});

test("域隔離：同一把密鑰下，無域前綴（emu-oauth 形態）的碼不得通用", () => {
  // 這是本檔最重要的一條：emu-oauth 的碼能換 B 端密鑰；若兩種碼通用，
  // 畫布上顯示的連接碼就等於一把可鑄 key 的憑證。
  const oauthShaped = forge(SECRET_A, `7.${Date.now() + 60_000}`);
  const verified = verifyScene3dLinkCode(oauthShaped);
  assert.equal(verified.ok, false);
  if (verified.ok) return;
  assert.equal(verified.reason, "invalid");
});

test("域隔離：別的前綴（如 scene-3d-export）即使是本密鑰簽的也拒", () => {
  const otherPurpose = forge(SECRET_A, `scene-3d-export.7.${Date.now() + 60_000}`);
  const verified = verifyScene3dLinkCode(otherPurpose);
  assert.equal(verified.ok, false);
  if (verified.ok) return;
  assert.equal(verified.reason, "invalid");
});

test("簽章長度不符不得拋：回 invalid（timingSafeEqual 不等長會拋，必須先擋）", () => {
  const code = signScene3dLinkCode(42);
  const dot = code.lastIndexOf(".");
  assert.equal(verifyScene3dLinkCode(`${code.slice(0, dot)}.deadbeef`).ok, false);
  assert.equal(verifyScene3dLinkCode(`${code.slice(0, dot)}.`).ok, false);
  assert.equal(verifyScene3dLinkCode("").ok, false);
  assert.equal(verifyScene3dLinkCode("not-a-code").ok, false);
});

test("超長輸入（>512）直接 invalid，不進 base64 解碼", () => {
  const verified = verifyScene3dLinkCode(`x.${"A".repeat(2000)}`);
  assert.equal(verified.ok, false);
  if (verified.ok) return;
  assert.equal(verified.reason, "invalid");
});

test("密鑰未配置：驗簽回 not_configured、簽發必須拋（不降級、不靜默）", () => {
  delete process.env.SCENE_3D_LINK_SECRET;
  assert.equal(scene3dLinkConfigured(), false);
  const verified = verifyScene3dLinkCode("anything");
  assert.equal(verified.ok, false);
  if (verified.ok) return;
  assert.equal(verified.reason, "not_configured");
  assert.throws(() => signScene3dLinkCode(1));
});

test("不可鏈接的 userId（0 / 負 / 非整數）：簽發拋、驗簽拒（同一份判據）", () => {
  assert.equal(isLinkableUserId(0), false);
  assert.equal(isLinkableUserId(-3), false);
  assert.equal(isLinkableUserId(1.5), false);
  assert.equal(isLinkableUserId(1), true);
  assert.throws(() => signScene3dLinkCode(0));
  // 負 id / 0 的碼：連簽都簽不出來，用 forge 生一個也必須驗不過。
  for (const bad of ["0", "-3"]) {
    const verified = verifyScene3dLinkCode(forge(SECRET_A, `${SCENE_3D_LINK_PURPOSE}.${bad}.${Date.now() + 60_000}`));
    assert.equal(verified.ok, false, `userId=${bad} 必須被拒`);
  }
});

test("Bearer 解析：只認 Bearer 形態；會話令牌與連接碼共用同一個標頭通道", () => {
  const headers = (value?: string) => ({ get: (name: string) => (name.toLowerCase() === "authorization" ? value ?? null : null) });
  assert.equal(scene3dLinkBearer(headers("Bearer abc.def")), "abc.def");
  assert.equal(scene3dLinkBearer(headers("bearer abc.def")), "abc.def");
  assert.equal(scene3dLinkBearer(headers("Bearer   abc.def  ")), "abc.def");
  assert.equal(scene3dLinkBearer(headers("Basic abc")), null);
  assert.equal(scene3dLinkBearer(headers(undefined)), null);
  assert.equal(scene3dLinkBearer(headers("Bearer ")), null);
});

test("碼不洩露密鑰：base64 解碼後的 payload 只有域前綴 + userId + 到期時間", () => {
  const code = signScene3dLinkCode(42);
  assert.ok(!code.includes(SECRET_A), "碼本體不得含密鑰");
  const payload = Buffer.from(code.slice(0, code.lastIndexOf(".")), "base64url").toString("utf8");
  assert.ok(!payload.includes(SECRET_A), "解碼後的 payload 也不得含密鑰");
  assert.match(payload, new RegExp(`^${SCENE_3D_LINK_PURPOSE}\\.42\\.\\d+$`));
});

test("不同 userId 的碼互不通用；同一個碼可重複驗證（碼本身無狀態）", () => {
  // 註：payload 是 `域.userId.到期時間戳（毫秒）`，因此**同毫秒 + 同用戶**會得到
  // 同一串碼——那是同一張憑證（同用戶、同時效），不是重複鑄碼的 bug。
  // 這裡刻意不斷言「兩次鑄碼必不同」：唯一性不是本方案的安全屬性（不可偽造才是），
  // 用 Date.now() 當隨機源會寫出一條假紅燈（本輪已實踩一次）。
  const codeA = signScene3dLinkCode(42);
  const codeB = signScene3dLinkCode(43);
  assert.notEqual(codeA, codeB);
  const a1 = verifyScene3dLinkCode(codeA);
  const a2 = verifyScene3dLinkCode(codeA);
  assert.equal(a1.ok, true);
  assert.equal(a2.ok, true);
  if (!a1.ok || !a2.ok) return;
  assert.equal(a1.userId, 42);
  assert.equal(a2.userId, 42);
});
