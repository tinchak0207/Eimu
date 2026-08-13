import test from "node:test";
import assert from "node:assert/strict";

import { buildHistoryArchive } from "./history-export.ts";
import type { HistoryEntry } from "./history-types.ts";

function entry(overrides: Partial<HistoryEntry> & Pick<HistoryEntry, "id" | "generatedAt">): HistoryEntry {
  return { prompt: "", results: [], source: "server", ...overrides };
}

test("buildHistoryArchive 摊平工作流参数并保留原始 workflow", () => {
  const archive = buildHistoryArchive([
    entry({
      id: "a",
      generatedAt: 1_700_000_000_000,
      prompt: "一只戴帽子的猫",
      modelId: "openai/gpt-image-2",
      starred: true,
      quota: 1_000_000,
      results: [
        { provider: "image_tinchak", modelId: "gpt-image-2", image: null, imageUrl: "https://x/a.png" },
        { provider: "image_tinchak", modelId: "gpt-image-2", image: null, imageUrl: null },
      ],
      workflow: { imageSize: "1024x1024", workflowPresetLabel: "商品图", qualityProfile: "print" },
    }),
  ]);

  assert.equal(archive.count, 1);
  const record = archive.records[0];
  assert.equal(record.prompt, "一只戴帽子的猫");
  assert.equal(record.model, "openai/gpt-image-2");
  assert.equal(record.imageSize, "1024x1024");
  assert.equal(record.preset, "商品图");
  assert.equal(record.qualityProfile, "print");
  assert.equal(record.starred, true);
  assert.equal(record.coins, "2");
  assert.deepEqual(record.imageUrls, ["https://x/a.png"], "没有 URL 的结果项不应出现在清单里");
  assert.ok(record.workflow, "原始工作流参数应当保留，以便日后复现");
});

test("buildHistoryArchive 对没有消耗信息的记录不编造 coins 字段", () => {
  const archive = buildHistoryArchive([entry({ id: "a", generatedAt: 1_000 })]);
  assert.equal("coins" in archive.records[0], false);
});

test("buildHistoryArchive 输出 ISO 时间，跨时区可解析", () => {
  const archive = buildHistoryArchive([entry({ id: "a", generatedAt: 1_700_000_000_000 })]);
  assert.equal(archive.records[0].generatedAt, new Date(1_700_000_000_000).toISOString());
  assert.equal(Date.parse(archive.records[0].generatedAt), 1_700_000_000_000);
});

test("buildHistoryArchive 对空输入返回空档案而不是抛错", () => {
  const archive = buildHistoryArchive([]);
  assert.equal(archive.count, 0);
  assert.deepEqual(archive.records, []);
});
