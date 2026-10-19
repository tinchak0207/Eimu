import test from "node:test";
import assert from "node:assert/strict";

// 强制走内存降级路径：测试环境不碰真实 Blob。
delete process.env.BLOB_READ_WRITE_TOKEN;

import {
  __resetGateLogStoreForTests,
  aggregateGateStats,
  appendGateLog,
  listGateLog,
} from "./generation-gate-log";
import { gatesBlock, runPreGenerationGates } from "./generation-gates";

function entry(overrides: Partial<Parameters<typeof appendGateLog>[1]> = {}) {
  const checks = runPreGenerationGates({
    prompt: "一只橘猫",
    modelId: "gpt-image-2",
    aspectRatio: "1:1",
  });
  return {
    id: "gate-test-1",
    at: "2026-01-01T00:00:00.000Z",
    modelId: "gpt-image-2",
    blocked: gatesBlock(checks),
    checks,
    ...overrides,
  };
}

test("appendGateLog / listGateLog：追加后新条目在前，顺序稳定", async () => {
  __resetGateLogStoreForTests();
  await appendGateLog(1, entry({ id: "a", at: "2026-01-01T00:00:01.000Z" }));
  await appendGateLog(1, entry({ id: "b", at: "2026-01-01T00:00:02.000Z" }));

  const entries = await listGateLog(1);
  assert.deepEqual(entries.map((item) => item.id), ["b", "a"]);
});

test("滚动上限 500 条：多写只保留最新 500 条", async () => {
  __resetGateLogStoreForTests();
  for (let i = 0; i < 520; i++) {
    await appendGateLog(2, entry({ id: `gate-${i}`, at: new Date(2026, 0, 1, 0, 0, 0, i).toISOString() }));
  }

  const entries = await listGateLog(2);
  assert.equal(entries.length, 500);
  assert.equal(entries[0].id, "gate-519", "最新在前");
  assert.equal(entries[499].id, "gate-20", "最旧的 20 条被滚动淘汰");
});

test("appendGateLog 按检查结果自动置 blocked（缺省字段也有兜底）", async () => {
  __resetGateLogStoreForTests();
  const failing = runPreGenerationGates({ prompt: "   ", modelId: "gpt-image-2" });
  await appendGateLog(3, { id: "", at: "", modelId: "gpt-image-2", blocked: false, checks: failing });
  const entries = await listGateLog(3);

  assert.equal(entries.length, 1);
  assert.equal(entries[0].blocked, true, "存在 fail 时 blocked 必须为 true，即使调用方传了 false");
  assert.ok(entries[0].id, "缺省 id 必须服务端铸造");
  assert.ok(entries[0].at, "缺省 at 必须服务端补齐");
});

test("aggregateGateStats：每门 pass/fail/skip 计数 + 触发率", () => {
  const passEntry = entry();
  const failEntry = {
    ...entry(),
    id: "gate-fail",
    blocked: true,
    checks: runPreGenerationGates({ prompt: "   ", modelId: "gpt-image-2", aspectRatio: "16:10", loraIds: ["1", "2"] }),
  };
  const stats = aggregateGateStats([passEntry, failEntry]);
  const byId = (id: string) => {
    const stat = stats.find((item) => item.id === id);
    assert.ok(stat, `missing stat ${id}`);
    return stat;
  };

  // prompt_nonempty: 1 pass + 1 fail → 触发率 1/2
  assert.deepEqual(
    { ...byId("prompt_nonempty"), triggerRate: 0 },
    { id: "prompt_nonempty", label: "提示词非空", pass: 1, fail: 1, skip: 0, triggerRate: 0 },
  );
  assert.equal(byId("prompt_nonempty").triggerRate, 0.5);

  // prompt_length: 2 pass
  assert.equal(byId("prompt_length").pass, 2);
  assert.equal(byId("prompt_length").triggerRate, 0);

  // size_legal: 1 pass + 1 fail
  assert.equal(byId("size_legal").fail, 1);
  assert.equal(byId("size_legal").triggerRate, 0.5);

  // negative_antonym: 两条都 skip → 分母为 0，触发率 0
  assert.deepEqual(
    { pass: byId("negative_antonym").pass, fail: byId("negative_antonym").fail, skip: byId("negative_antonym").skip },
    { pass: 0, fail: 0, skip: 2 },
  );
  assert.equal(byId("negative_antonym").triggerRate, 0);

  // lora_single: 1 pass + 1 skip → skip 不进分母，触发率 0
  assert.equal(byId("lora_single").pass, 1);
  assert.equal(byId("lora_single").skip, 1);
  assert.equal(byId("lora_single").triggerRate, 0);
});

test("aggregateGateStats：空日志返回空数组", () => {
  assert.deepEqual(aggregateGateStats([]), []);
});
