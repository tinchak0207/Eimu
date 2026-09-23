// /v1/team/quota 端點的不變量測試（源碼斷言，沿用 v1/route.test.ts 的姿勢）。
//
// 這一層只做契約與授權：配額數學在 lib/generation-core/member-quota.ts（另有測試），
// 餘額真源在 new-api。路由自己算餘額、或寫本地餘額 = 影子帳本，直接判死。

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";

const ROUTE = "src/app/api/v1/team/quota/route.ts";

/** 去掉注释后再断言，避免注释里引用的反例把测试带跑。 */
function code(relPath: string): string {
  return readFileSync(join(process.cwd(), relPath), "utf8")
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/^\s*\/\/.*$/gm, "");
}

test("團隊配額端點只認 Authorization 的 B 端密鑰，身份不來自請求體", () => {
  const source = code(ROUTE);
  assert.match(source, /readBearerToken\(req\.headers\.get\("authorization"\)\)/);
  assert.match(source, /authenticateBizApiKey/);
  assert.doesNotMatch(source, /x-user-id/);
  // 團隊主帳 = 呼叫方密鑰的 userId，不從 body 取（否則任何人可代別人分配）。
  assert.match(source, /auth\.key\.userId/);
  assert.doesNotMatch(source, /payload\.user_id|body\.user_id|team_user_id\s*=\s*payload/);
});

test("成員金鑰不得自行分配額度（用團隊主帳號密鑰操作）", () => {
  const source = code(ROUTE);
  assert.match(source, /member_cannot_allocate/);
  // user 層判據：呼叫方 key 的 user 是不是在成員名冊裡（不再走 token 映射）。
  assert.match(source, /findMemberByUserId\(auth\.key\.userId\)/);
  assert.doesNotMatch(source, /findMemberByTokenId|member_token_id/);
});

test("額度寫入只走 member-quota 的分配層（不在路由重算餘額、不寫本地餘額）", () => {
  const source = code(ROUTE);
  assert.match(source, /allocateMemberQuota\(/);
  assert.match(source, /readTeamQuotaView\(/);
  // 路由不得自己碰上游 token/users，也不得寫任何本地額度表。
  assert.doesNotMatch(source, /setGatewayTokenQuota|adjustGatewayUserQuotaExact|fetchGatewayToken/);
  assert.doesNotMatch(source, /INSERT INTO|UPDATE .*quota/i);
});

test("可視面欄位齊備：主帳剩餘／已分配／已用／成員各自額度與消耗", () => {
  const source = code(ROUTE);
  for (const field of [
    "balance_coins",
    "allocated",
    "unallocated",
    "granted_coins",
    "used_coins",
    "remaining_coins",
  ]) {
    assert.ok(source.includes(field), `可視面必須輸出 ${field}`);
  }
  // 成員身份按 user 暴露（配額桶在成員 user 身上）。
  assert.ok(source.includes("member_user_id"), "成員可視面必須輸出 member_user_id");
});
