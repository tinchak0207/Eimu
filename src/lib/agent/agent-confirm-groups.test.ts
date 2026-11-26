// 确认卡归并回归锁（罪状 5/6）：同批同模型确认卡合并成一张「model ×N 共 N 币」，
// 不同模型逐张出；合并卡裁决必须覆盖组内全部 requestId。
import test from "node:test";
import assert from "node:assert/strict";

import {
  describeGroup,
  groupPendingConfirms,
  modelFromDescription,
} from "./agent-confirm-groups";
import type { AgentPendingConfirm } from "./agent-chat-types";

function confirm(requestId: string, amountCoins: number, description?: string): AgentPendingConfirm {
  return { requestId, amountCoins, ...(description !== undefined ? { description } : {}), seq: 0 };
}

test("同批同模型 5 条合并成 1 组：×5 共总额（罪状 5）", () => {
  const groups = groupPendingConfirms([
    confirm("r1", 6, "生成 1 张图（image-5-pro），预估花费 6 币"),
    confirm("r2", 6, "生成 1 张图（image-5-pro），预估花费 6 币"),
    confirm("r3", 6, "生成 1 张图（image-5-pro），预估花费 6 币"),
    confirm("r4", 6, "生成 1 张图（image-5-pro），预估花费 6 币"),
    confirm("r5", 6, "生成 1 张图（image-5-pro），预估花费 6 币"),
  ]);
  assert.equal(groups.length, 1);
  assert.equal(groups[0].count, 5);
  assert.equal(groups[0].amountCoins, 30);
  assert.deepEqual(groups[0].requestIds, ["r1", "r2", "r3", "r4", "r5"]);
  assert.match(describeGroup(groups[0]), /^image-5-pro ×5 共 30 币$/);
});

test("不同模型（或金额不同）各自成组，逐张出", () => {
  const groups = groupPendingConfirms([
    confirm("a1", 6, "生成 1 张图（gpt-image-2），预估花费 6 币"),
    confirm("a2", 0.5, "生成 1 张图（image-5-pro），预估花费 0.5 币"),
  ]);
  assert.equal(groups.length, 2);
  assert.equal(groups[0].count, 1);
  assert.equal(groups[1].count, 1);
});

test("浮点求和不出 0.30000000000000004", () => {
  const groups = groupPendingConfirms([
    confirm("f1", 0.1, "生成 1 张图（tiny），预估花费 0.1 币"),
    confirm("f2", 0.1, "生成 1 张图（tiny），预估花费 0.1 币"),
    confirm("f3", 0.1, "生成 1 张图（tiny），预估花费 0.1 币"),
  ]);
  assert.equal(groups.length, 1);
  assert.equal(groups[0].amountCoins, 0.3);
});

test("description 缺省也能合并，文案退回「图片生成」", () => {
  const groups = groupPendingConfirms([confirm("x1", 2), confirm("x2", 2)]);
  assert.equal(groups.length, 1);
  assert.match(describeGroup(groups[0]), /图片生成 ×2 共 4 币/);
});

test("modelFromDescription 抽全角/半角括号里的模型名", () => {
  assert.equal(modelFromDescription("生成 1 张图（image-5-pro），预估花费 6 币"), "image-5-pro");
  assert.equal(modelFromDescription("生成 1 张图 (gpt-image-2)"), "gpt-image-2");
  assert.equal(modelFromDescription(undefined), null);
  assert.equal(modelFromDescription("没有括号"), null);
});
