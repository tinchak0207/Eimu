import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { QUOTA_PER_COIN } from "../../../lib/quota-constants.ts";

const route = readFileSync(join(process.cwd(), "src/app/api/checkin/route.ts"), "utf8");

test("checkin route keeps native new-api checkin but enables disabled backend settings", () => {
  assert.doesNotMatch(route, /makeProxy/);
  assert.match(route, /getGatewayBaseUrl/);
  assert.match(route, /\/api\/user\/checkin/);
  assert.match(route, /\/api\/option\//);
  assert.match(route, /checkin_setting\.enabled/);
  assert.match(route, /checkin_setting\.min_quota/);
  assert.match(route, /checkin_setting\.max_quota/);
  assert.match(route, /签到功能未启用/);
});

test("checkin reward band is expressed in coins via the shared QUOTA_PER_COIN constant", () => {
  // 不再断言 500_000 / 1_500_000 字面量：奖励区间的不变量是「1～3 枚额度币」，
  // 单位换算只应该有 src/lib/quota-constants.ts 这一个来源。
  assert.equal(QUOTA_PER_COIN, 500_000);
  assert.doesNotMatch(route, /=\s*500_000/);
  assert.doesNotMatch(route, /=\s*1_500_000/);
  assert.match(route, /from "@\/lib\/quota-constants"/);
  assert.match(route, /CHECKIN_REWARD_MIN_QUOTA = 1 \* QUOTA_PER_COIN/);
  assert.match(route, /CHECKIN_REWARD_MAX_QUOTA = 3 \* QUOTA_PER_COIN/);
});

test("checkin route normalizes native response for the existing client", () => {
  assert.match(route, /quota_awarded/);
  assert.match(route, /can_checkin/);
  assert.match(route, /checked_in_today/);
  assert.match(route, /retry/);
});
