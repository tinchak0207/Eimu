// `src/lib/openai-compat/models.ts` 的**闸位断言**。
//
// 清单必须与提交入口同一组闸（白名单 + 目录 kind + 真实生成结果驱动的熔断/断供）。
// 这里注入替身验「闸真的会把东西挡掉」——不是空跑一次看它没抛错（那只能证明函数存在）。
import test from "node:test";
import assert from "node:assert/strict";

import type { BizApiKey } from "@/lib/biz-api-keys";
import { listCompatibleImageModelIds, openAICompatModelList, resolveCompatibleImageModelId } from "./models";

function keyWith(allowedModels: string[]): BizApiKey {
  return {
    id: "key-test",
    label: "test",
    keyHash: "hash",
    keyPreview: "sk-biz-0000",
    userId: 1,
    enabled: true,
    rpm: 60,
    allowedModels,
    createdAt: 0,
    totalRequests: 0,
    totalImages: 0,
  };
}

const NO_SYNC = { sync: async () => undefined };

test("无熔断 + 不限模型 → 全部图片模型在列，且没有视频模型混进来", async () => {
  const ids = await listCompatibleImageModelIds(keyWith([]), {
    ...NO_SYNC,
    readUnavailable: async () => new Map<string, string>(),
  });
  assert.ok(ids.includes("gpt-image-2"));
  assert.ok(ids.includes("pixai-tsubaki2"));
  assert.ok(!ids.some((id) => id.includes("seedance")), "视频模型不得出现在生图清单");
  assert.ok(!ids.includes("minimax-h3"));
});

test("金钥白名单：只列白名单内的图片模型（与提交入口同一支 isModelAllowedForKey）", async () => {
  const ids = await listCompatibleImageModelIds(keyWith(["pixai-tsubaki2", "gpt-4o"]), {
    ...NO_SYNC,
    readUnavailable: async () => new Map<string, string>(),
  });
  assert.deepEqual(ids, ["pixai-tsubaki2"], "白名单里的非图片模型（gpt-4o）也必须被过滤掉");
});

test("熔断/断供名单：open 的模型从清单消失，其余不受影响（负控制）", async () => {
  const ids = await listCompatibleImageModelIds(keyWith([]), {
    ...NO_SYNC,
    readUnavailable: async () => new Map([["gpt-image-2", "近期真实生成全部失败"]]),
  });
  assert.ok(!ids.includes("gpt-image-2"), "熔断模型不得继续宣称可用");
  assert.ok(ids.includes("pixai-tsubaki2"), "同一份清单里其他模型必须还在（否则是清空而非过滤）");
  assert.ok(ids.length > 1);
});

test("可用性名单读取失败 → fail-open（不把整张清单打空）", async () => {
  const ids = await listCompatibleImageModelIds(keyWith([]), {
    ...NO_SYNC,
    readUnavailable: async () => {
      throw new Error("control plane unreachable");
    },
  });
  assert.ok(ids.includes("gpt-image-2"), "观测面失败不得让清单变空");
});

test("model 解析：显示名分隔符容忍，非图片模型回 null", () => {
  assert.equal(resolveCompatibleImageModelId("seedream 2.0"), "seedream-2.0");
  assert.equal(resolveCompatibleImageModelId("gpt-image-2"), "gpt-image-2");
  assert.equal(resolveCompatibleImageModelId("gpt-4o"), null);
  assert.equal(resolveCompatibleImageModelId("dall-e-3"), null);
});

test("list 形状：OpenAI 必备字段齐、owned_by=eimu", () => {
  const list = openAICompatModelList(["gpt-image-2"]);
  assert.equal(list.object, "list");
  assert.deepEqual(Object.keys(list.data[0]).sort(), ["created", "id", "object", "owned_by"]);
  assert.equal(list.data[0].owned_by, "eimu");
  assert.equal(list.data[0].object, "model");
});
