import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const source = readFileSync(join(process.cwd(), "src/app/api/auth/github/callback/route.ts"), "utf8");

test("github callback creates upstream accounts through the admin create API", () => {
  // 关闭自助注册后不能再打 /api/user/register；建号统一走 ensureGatewayUserForOAuth。
  assert.match(source, /ensureGatewayUserForOAuth/);
  assert.doesNotMatch(source, /\/api\/user\/register/);
  assert.match(source, /console\.error\("\[auth\/github\/register\]"/);
});

test("github callback logs backend username when login fails", () => {
  assert.match(source, /console\.error\("\[auth\/github\/login\]"/);
  assert.match(source, /username/);
});
