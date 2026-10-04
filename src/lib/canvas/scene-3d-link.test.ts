// 连接码签章（`src/lib/canvas/scene-3d-link.ts`）的真函式测试。
//
// 为什么直呼真函式而不是扫源码字串：本档要钉的是**验签的判定本身**
// （有效通过 / 过期拒 / 被窜改拒 / 别的密钥签的拒 / 别的用途的码拒），
// 这些都是可以真跑出来的结论；源码断言只能证明「有写」，证明不了「判得对」。
// 真执行器：`npx tsx --test src/lib/canvas/scene-3d-link.test.ts`（本仓无 vitest）。
//
// 四个负向对照各有不可替代的作用：
//   · 窜改 payload 不窜改签章 ⇒ 挡「改 userId 冒充别人上传」；
//   · 换密钥签 ⇒ 挡「别的服务/别的部署拿同一格式伪造」；
//   · 同密钥但无域前缀（emu-oauth 形态）⇒ 挡跨协议码通用（本档最重要的一条）；
//   · 缺 env ⇒ 挡「静默降级成无签章」。

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

/** 用指定密钥签一个任意 payload（模拟「另一方」自己生的码，不经过本模组）。 */
function forge(secret: string, payload: string): string {
  return `${Buffer.from(payload, "utf8").toString("base64url")}.${createHmac("sha256", secret)
    .update(payload, "utf8")
    .digest("hex")}`;
}

test("TTL 是 15 分钟（用户要肉眼复制，60 秒不够）", () => {
  assert.equal(SCENE_3D_LINK_TTL_MS, 15 * 60_000);
});

test("有效码：验签回同一个 userId，且到期时间落在 TTL 窗口内", () => {
  const before = Date.now();
  const code = signScene3dLinkCode(42);
  const verified = verifyScene3dLinkCode(code);
  assert.equal(verified.ok, true);
  if (!verified.ok) return;
  assert.equal(verified.userId, 42);
  assert.ok(verified.expiresAt >= before + SCENE_3D_LINK_TTL_MS - 5_000, "到期时间约等于铸码时刻 + TTL");
  assert.ok(verified.expiresAt <= Date.now() + SCENE_3D_LINK_TTL_MS, "到期时间不得超过 TTL");
});

test("过期码拒：签章有效但时效已过 ⇒ reason 必须是 expired（不是 invalid）", () => {
  // ttl 传负值＝签一张「已经过期」的码，不必改时钟。
  const code = signScene3dLinkCode(42, -1_000);
  const verified = verifyScene3dLinkCode(code);
  assert.equal(verified.ok, false);
  if (verified.ok) return;
  assert.equal(verified.reason, "expired");
});

test("被窜改 payload 拒：换掉 userId 但留著原签章 ⇒ invalid", () => {
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

test("别的密钥签的码拒（负向对照）：SECRET_B 签、SECRET_A 验 ⇒ invalid", () => {
  process.env.SCENE_3D_LINK_SECRET = SECRET_B;
  const foreignCode = signScene3dLinkCode(42);
  process.env.SCENE_3D_LINK_SECRET = SECRET_A;
  const verified = verifyScene3dLinkCode(foreignCode);
  assert.equal(verified.ok, false);
  if (verified.ok) return;
  assert.equal(verified.reason, "invalid");
});

test("域隔离：同一把密钥下，无域前缀（emu-oauth 形态）的码不得通用", () => {
  // 这是本档最重要的一条：emu-oauth 的码能换 B 端密钥；若两种码通用，
  // 画布上显示的连接码就等于一把可铸 key 的凭证。
  const oauthShaped = forge(SECRET_A, `7.${Date.now() + 60_000}`);
  const verified = verifyScene3dLinkCode(oauthShaped);
  assert.equal(verified.ok, false);
  if (verified.ok) return;
  assert.equal(verified.reason, "invalid");
});

test("域隔离：别的前缀（如 scene-3d-export）即使是本密钥签的也拒", () => {
  const otherPurpose = forge(SECRET_A, `scene-3d-export.7.${Date.now() + 60_000}`);
  const verified = verifyScene3dLinkCode(otherPurpose);
  assert.equal(verified.ok, false);
  if (verified.ok) return;
  assert.equal(verified.reason, "invalid");
});

test("签章长度不符不得抛：回 invalid（timingSafeEqual 不等长会抛，必须先挡）", () => {
  const code = signScene3dLinkCode(42);
  const dot = code.lastIndexOf(".");
  assert.equal(verifyScene3dLinkCode(`${code.slice(0, dot)}.deadbeef`).ok, false);
  assert.equal(verifyScene3dLinkCode(`${code.slice(0, dot)}.`).ok, false);
  assert.equal(verifyScene3dLinkCode("").ok, false);
  assert.equal(verifyScene3dLinkCode("not-a-code").ok, false);
});

test("超长输入（>512）直接 invalid，不进 base64 解码", () => {
  const verified = verifyScene3dLinkCode(`x.${"A".repeat(2000)}`);
  assert.equal(verified.ok, false);
  if (verified.ok) return;
  assert.equal(verified.reason, "invalid");
});

test("密钥未配置：验签回 not_configured、签发必须抛（不降级、不静默）", () => {
  delete process.env.SCENE_3D_LINK_SECRET;
  assert.equal(scene3dLinkConfigured(), false);
  const verified = verifyScene3dLinkCode("anything");
  assert.equal(verified.ok, false);
  if (verified.ok) return;
  assert.equal(verified.reason, "not_configured");
  assert.throws(() => signScene3dLinkCode(1));
});

test("不可链接的 userId（0 / 负 / 非整数）：签发抛、验签拒（同一份判据）", () => {
  assert.equal(isLinkableUserId(0), false);
  assert.equal(isLinkableUserId(-3), false);
  assert.equal(isLinkableUserId(1.5), false);
  assert.equal(isLinkableUserId(1), true);
  assert.throws(() => signScene3dLinkCode(0));
  // 负 id / 0 的码：连签都签不出来，用 forge 生一个也必须验不过。
  for (const bad of ["0", "-3"]) {
    const verified = verifyScene3dLinkCode(forge(SECRET_A, `${SCENE_3D_LINK_PURPOSE}.${bad}.${Date.now() + 60_000}`));
    assert.equal(verified.ok, false, `userId=${bad} 必须被拒`);
  }
});

test("Bearer 解析：只认 Bearer 形态；会话令牌与连接码共用同一个标头通道", () => {
  const headers = (value?: string) => ({ get: (name: string) => (name.toLowerCase() === "authorization" ? value ?? null : null) });
  assert.equal(scene3dLinkBearer(headers("Bearer abc.def")), "abc.def");
  assert.equal(scene3dLinkBearer(headers("bearer abc.def")), "abc.def");
  assert.equal(scene3dLinkBearer(headers("Bearer   abc.def  ")), "abc.def");
  assert.equal(scene3dLinkBearer(headers("Basic abc")), null);
  assert.equal(scene3dLinkBearer(headers(undefined)), null);
  assert.equal(scene3dLinkBearer(headers("Bearer ")), null);
});

test("码不泄露密钥：base64 解码后的 payload 只有域前缀 + userId + 到期时间", () => {
  const code = signScene3dLinkCode(42);
  assert.ok(!code.includes(SECRET_A), "码本体不得含密钥");
  const payload = Buffer.from(code.slice(0, code.lastIndexOf(".")), "base64url").toString("utf8");
  assert.ok(!payload.includes(SECRET_A), "解码后的 payload 也不得含密钥");
  assert.match(payload, new RegExp(`^${SCENE_3D_LINK_PURPOSE}\\.42\\.\\d+$`));
});

test("不同 userId 的码互不通用；同一个码可重复验证（码本身无状态）", () => {
  // 注：payload 是 `域.userId.到期时间戳（毫秒）`，因此**同毫秒 + 同用户**会得到
  // 同一串码——那是同一张凭证（同用户、同时效），不是重复铸码的 bug。
  // 这里刻意不断言「两次铸码必不同」：唯一性不是本方案的安全属性（不可伪造才是），
  // 用 Date.now() 当随机源会写出一条假红灯（本轮已实踩一次）。
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
