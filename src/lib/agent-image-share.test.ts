import test from "node:test";
import assert from "node:assert/strict";
import { agentHistoryEntry } from "./agent-image-share";
import { normalizeHistoryEntry } from "./history-types";
import { firstShareableIndex } from "./share-remix";

const item = {
  kind: "image" as const,
  id: "t1",
  url: "https://store.tinchak0207.xyz/image-data/files/generation/jobs/x.png",
  taskId: "job-123",
  recipe: { prompt: "a cat", model: "gpt-image-2" },
} as Parameters<typeof agentHistoryEntry>[0];

test("助理圖 → 歷史 entry：穩定 id、能過 POST /api/history 的正規化、能被分享選中", () => {
  const entry = agentHistoryEntry(item);
  assert.equal(entry.id, "agent-job-123");
  assert.equal(agentHistoryEntry(item).id, entry.id, "同一張圖重點分享必須落同一條記錄");
  const normalized = normalizeHistoryEntry(JSON.parse(JSON.stringify(entry)), "server");
  assert.ok(normalized, "POST /api/history 會拒收");
  assert.equal(normalized.results[0].imageUrl, item.url);
  assert.equal(normalized.prompt, "a cat");
  assert.ok(firstShareableIndex(normalized) >= 0, "ShareDialog 會報「没有可分享的图片」");
});

test("無 taskId 時以 url 雜湊作穩定 id", () => {
  const a = agentHistoryEntry({ ...item, taskId: undefined });
  const b = agentHistoryEntry({ ...item, taskId: undefined });
  assert.equal(a.id, b.id);
  assert.match(a.id, /^agent-u[0-9a-z]+$/);
});
