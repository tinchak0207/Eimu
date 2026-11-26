import test from "node:test";
import assert from "node:assert/strict";

import { formatCheckinRewardText, quotaToRewardCount } from "./checkin-copy.ts";

test("quotaToRewardCount rounds quota to 1-3 image credits", () => {
  assert.equal(quotaToRewardCount(500_000), 1);
  assert.equal(quotaToRewardCount(1_000_000), 2);
  assert.equal(quotaToRewardCount(1_500_000), 3);
});

test("formatCheckinRewardText uses explicit random reward copy before checkin", () => {
  assert.equal(formatCheckinRewardText(), "每日签到可随机获得 1 到 3 张额度");
  assert.equal(formatCheckinRewardText(2), "今日签到已获得 2 张额度");
});
