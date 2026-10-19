import test from "node:test";
import assert from "node:assert/strict";
import type { HistoryEntry } from "./history-types.ts";
import {
  buildRecipeFromHistoryEntry,
  buildUserShowcaseCase,
  mergeShowcaseCases,
  publishUserShowcaseCase,
  readUserShowcaseCases,
} from "./showcase-user-cases.ts";
import { SHOWCASE_CASES } from "./showcase-cases.ts";
import { parseWorkflowRecallConfig } from "./workflow-recall.ts";

/** 契约测试的内存 Storage 桩：node --test 无 window。 */
class MemoryStorage implements Storage {
  private map = new Map<string, string>();
  get length() { return this.map.size; }
  clear() { this.map.clear(); }
  getItem(key: string) { return this.map.get(key) ?? null; }
  key(index: number) { return [...this.map.keys()][index] ?? null; }
  removeItem(key: string) { this.map.delete(key); }
  setItem(key: string, value: string) { this.map.set(key, value); }
}

function makeEntry(overrides: Partial<HistoryEntry> = {}): HistoryEntry {
  return {
    id: "h-1",
    prompt: "一瓶放在木质吧台上的精酿啤酒",
    generatedAt: Date.now(),
    results: [{ provider: "test", modelId: "gpt-image-2", image: null, imageUrl: "https://img.example.com/a.png" }],
    source: "local",
    modelId: "gpt-image-2",
    workflow: {
      schemaVersion: 2,
      prompt: "一瓶放在木质吧台上的精酿啤酒",
      negativePrompt: "水印",
      workflowPreset: "product-shot",
      workflowPresetLabel: "商品主图",
      productionIntent: "ecommerce",
      imageSizes: ["1024x1024"],
      qualityProfile: "print",
      copies: 1,
    },
    ...overrides,
  };
}

test("published user case snapshot survives the workflow-recall parse pipeline", () => {
  const entry = makeEntry();
  const recipe = buildRecipeFromHistoryEntry(entry);
  // 案例配方 = workflow-recall 既有结构 + 加法式扩展（schemaVersion/modelId）。
  // 「用此工作流打开」走同一条 parseWorkflowRecallConfig 管线 —— 解析失败=整条链断。
  const parsed = parseWorkflowRecallConfig(JSON.stringify(recipe));
  assert.equal(parsed.ok, true);
  assert.equal(parsed.config.prompt, "一瓶放在木质吧台上的精酿啤酒");
  assert.equal(parsed.config.negativePrompt, "水印");
  assert.equal(parsed.config.qualityProfile, "print");
  assert.equal(recipe.modelId, "gpt-image-2");
});

test("user showcase case is community-sourced and merges after official cases", () => {
  const entry = makeEntry();
  const userCase = buildUserShowcaseCase(entry);
  assert.equal(userCase.source, "community");
  assert.equal(userCase.category, "用户投稿");
  assert.ok(userCase.recipe);
  const merged = mergeShowcaseCases(SHOWCASE_CASES, [userCase]);
  assert.equal(merged[0].id, SHOWCASE_CASES[0].id);
  assert.equal(merged[merged.length - 1].id, "user-h-1");
});

test("publish is idempotent and read round-trips through storage", () => {
  const storage = new MemoryStorage();
  const entry = makeEntry();
  const first = publishUserShowcaseCase(entry, storage);
  assert.deepEqual(first, { ok: true, alreadyPublished: false });
  const second = publishUserShowcaseCase(entry, storage);
  assert.deepEqual(second, { ok: true, alreadyPublished: true });

  const stored = readUserShowcaseCases(storage);
  assert.equal(stored.length, 1);
  assert.equal(stored[0].id, "user-h-1");
  assert.equal(stored[0].source, "community");
});

test("entries without any recipe cannot be published", () => {
  const storage = new MemoryStorage();
  const bare = makeEntry({ prompt: "   ", workflow: undefined, results: [], modelId: undefined });
  const result = publishUserShowcaseCase(bare, storage);
  assert.equal(result.ok, false);
  assert.equal(readUserShowcaseCases(storage).length, 0);
});
