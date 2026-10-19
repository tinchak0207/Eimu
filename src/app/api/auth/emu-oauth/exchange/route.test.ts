// emu-oauth exchange 路由的不变量测试。
// 与 src/app/api/agent/route.test.ts 同路数：读源码文本断言，钉死安全属性。

import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const source = readFileSync(
  join(process.cwd(), "src/app/api/auth/emu-oauth/exchange/route.ts"),
  "utf8",
);

/** 去掉注解后再断言，避免注解里引用的反例把测试带跑。 */
function code(): string {
  return source
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/^\s*\/\/.*$/gm, "");
}

test("exchange 必须用 consumeEmuOauthCode 作为唯一身份门禁（原子验证+消费）", () => {
  const c = code();
  assert.match(c, /consumeEmuOauthCode\(/);
  // 身份结果只能来自凭证消费：userId 由凭证解出，不接受请求携带的 userId。
  assert.match(c, /const userId = await consumeEmuOauthCode\(code\)/);
  assert.doesNotMatch(c, /typeof body\.userId/);
  // 不读 cookie / 授权头 / 会话：身份完全来自签名凭证。
  assert.doesNotMatch(c, /req\.cookies/);
  assert.doesNotMatch(c, /authorization/i);
  assert.doesNotMatch(c, /requireVerifiedUser/);
});

test("exchange 不得把签名凭证回显进任何响应", () => {
  const c = code();
  // code 只能出现在「取 body.code 传进 verify」这一步；
  // 成功响应里只有 key / preview，绝不允许模板插值把 code 拼回去。
  assert.match(c, /typeof body\.code === "string"/);
  assert.doesNotMatch(c, /\$\{code\}/);
  assert.doesNotMatch(c, /data:\s*\{[^}]*code/);
});

test("exchange 校验与签发分支齐全", () => {
  const c = code();
  assert.match(c, /"invalid_code"/);
  assert.match(c, /401/);
  assert.match(c, /USER_API_KEY_LIMIT/);
  assert.match(c, /"key_limit_reached"/);
  assert.match(c, /"key_issue_failed"/);
  assert.match(c, /503/);
});

test("exchange 签发草稿固定为 DSH 插件默认参数", () => {
  const c = code();
  assert.match(c, /label: normalizeUserBizKeyLabel\(undefined\)/);
  assert.match(c, /rpm: BIZ_KEY_DEFAULT_RPM/);
  assert.match(c, /allowedModels: \[\]/);
  assert.match(c, /enabled: true/);
  assert.match(c, /userId,?$/m, "userId 必须来自验证结果");
});

test("exchange 返回 key 明文一次 + preview，两者同源", () => {
  const c = code();
  assert.match(c, /key: issued\.key/);
  assert.match(c, /preview: toPublicBizApiKey\(issued\.record\)\.keyPreview/);
});

test("exchange 是 nodejs 路由且固定区域", () => {
  assert.match(source, /export const runtime = "nodejs"/);
  assert.match(source, /export const dynamic = "force-dynamic"/);
  assert.match(source, /export const preferredRegion = "sfo1"/);
});
