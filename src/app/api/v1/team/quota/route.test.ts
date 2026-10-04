// /v1/team/quota 端点的不变量测试（源码断言，沿用 v1/route.test.ts 的姿势）。
//
// 这一层只做契约与授权：配额数学在 lib/generation-core/member-quota.ts（另有测试），
// 余额真源在 new-api。路由自己算余额、或写本地余额 = 影子帐本，直接判死。

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

test("团队配额端点只认 Authorization 的 B 端密钥，身份不来自请求体", () => {
  const source = code(ROUTE);
  assert.match(source, /readBearerToken\(req\.headers\.get\("authorization"\)\)/);
  assert.match(source, /authenticateBizApiKey/);
  assert.doesNotMatch(source, /x-user-id/);
  // 团队主帐 = 呼叫方密钥的 userId，不从 body 取（否则任何人可代别人分配）。
  assert.match(source, /auth\.key\.userId/);
  assert.doesNotMatch(source, /payload\.user_id|body\.user_id|team_user_id\s*=\s*payload/);
});

test("成员金钥不得自行分配额度（用团队主帐号密钥操作）", () => {
  const source = code(ROUTE);
  assert.match(source, /member_cannot_allocate/);
  // user 层判据：呼叫方 key 的 user 是不是在成员名册里（不再走 token 映射）。
  assert.match(source, /findMemberByUserId\(auth\.key\.userId\)/);
  assert.doesNotMatch(source, /findMemberByTokenId|member_token_id/);
});

test("额度写入只走 member-quota 的分配层（不在路由重算余额、不写本地余额）", () => {
  const source = code(ROUTE);
  assert.match(source, /allocateMemberQuota\(/);
  assert.match(source, /readTeamQuotaView\(/);
  // 路由不得自己碰上游 token/users，也不得写任何本地额度表。
  assert.doesNotMatch(source, /setGatewayTokenQuota|adjustGatewayUserQuotaExact|fetchGatewayToken/);
  assert.doesNotMatch(source, /INSERT INTO|UPDATE .*quota/i);
});

test("可视面栏位齐备：主帐剩余／已分配／已用／成员各自额度与消耗", () => {
  const source = code(ROUTE);
  for (const field of [
    "balance_coins",
    "allocated",
    "unallocated",
    "granted_coins",
    "used_coins",
    "remaining_coins",
  ]) {
    assert.ok(source.includes(field), `可视面必须输出 ${field}`);
  }
  // 成员身份按 user 暴露（配额桶在成员 user 身上）。
  assert.ok(source.includes("member_user_id"), "成员可视面必须输出 member_user_id");
});
