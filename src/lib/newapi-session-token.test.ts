import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";

// new-api 稳定会话令牌契约测试：只钉关键接线（源码字串断言），避免为
// 单测起 DB/new-api 网关。语义：/api/user/token 是重置型端点，登录链
// 必须优先走控制面稳定通道，且回退路径保留。

const read = (relPath: string) => readFileSync(join(process.cwd(), relPath), "utf8");

test("internal route reuses the biz-key-sync HMAC skeleton with its own domain", () => {
  const route = read("src/app/api/internal/newapi-session-token/route.ts");
  assert.ok(route.includes("verifyBizKeySync"), "必须复用 biz-key-sync HMAC 鉴权骨架");
  assert.ok(route.includes('"newapi-session-token"'), "signatureDomain 必须是 newapi-session-token");
  assert.ok(route.includes('runtime = "nodejs"'));
  assert.ok(route.includes('dynamic = "force-dynamic"'));
  assert.ok(route.includes("ensureNewApiSessionToken"), "route 必须转调业务层");
});

test("session token store persists idempotently and verifies against /api/user/self", () => {
  const source = read("src/lib/newapi-session-token.ts");
  assert.ok(source.includes("CREATE TABLE IF NOT EXISTS newapi_session_token"), "自有 Postgres 存储表");
  assert.ok(source.includes("ON CONFLICT"), "upsert 必须幂等覆盖");
  assert.ok(source.includes("/api/user/self"), "必须打 /api/user/self 验活（不重置）");
  assert.ok(source.includes("/api/user/token"), "失效时重新生成");
  assert.ok(source.includes('pg_advisory_xact_lock(${userId})'), "同一用户必须使用事务级 advisory lock 串行化");
  assert.ok(source.includes("sql.begin(async (tx)"), "查验活/生成/upsert 必须置于同一事务");
  assert.ok(source.includes('"newapi-session-token"'), "relay 签名域一致");
});

test("loginViaNewApi prefers the stable token relay and keeps the reset fallback", () => {
  const source = read("src/lib/new-api-auth-server.ts");
  assert.ok(source.includes("ensureNewApiSessionTokenViaRelay"), "登录链必须优先走稳定令牌通道");
  assert.ok(source.includes("fetchAccessToken"), "回退路径（原重置型端点）必须保留");
});
