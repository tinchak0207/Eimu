import test from "node:test";
import assert from "node:assert/strict";
import { agentHistoryEntry, imageExtensionFromUrl } from "./agent-image-share";
import { normalizeHistoryEntry } from "./history-types";
import { firstShareableIndex } from "./share-remix";

const item = {
  kind: "image" as const,
  id: "t1",
  url: "https://store.tinchak0207.xyz/image-data/files/generation/jobs/x.png",
  taskId: "job-123",
  recipe: { prompt: "a cat", model: "gpt-image-2" },
} as Parameters<typeof agentHistoryEntry>[0];

test("助理图 → 历史 entry：稳定 id、能过 POST /api/history 的正规化、能被分享选中", () => {
  const entry = agentHistoryEntry(item);
  assert.equal(entry.id, "agent-job-123");
  assert.equal(agentHistoryEntry(item).id, entry.id, "同一张图重点分享必须落同一条记录");
  const normalized = normalizeHistoryEntry(JSON.parse(JSON.stringify(entry)), "server");
  assert.ok(normalized, "POST /api/history 会拒收");
  assert.equal(normalized.results[0].imageUrl, item.url);
  assert.equal(normalized.prompt, "a cat");
  assert.ok(firstShareableIndex(normalized) >= 0, "ShareDialog 会报「没有可分享的图片」");
});

test("无 taskId 时以 url 杂凑作稳定 id", () => {
  const a = agentHistoryEntry({ ...item, taskId: undefined });
  const b = agentHistoryEntry({ ...item, taskId: undefined });
  assert.equal(a.id, b.id);
  assert.match(a.id, /^agent-u[0-9a-z]+$/);
});

test("imageExtensionFromUrl：从 URL 路径推副档名，剥 query/fragment，推不到落 png", () => {
  assert.equal(imageExtensionFromUrl("https://store.tinchak0207.xyz/a/b/cat.jpeg"), "jpeg");
  assert.equal(imageExtensionFromUrl("https://store.tinchak0207.xyz/a/b/cat.PNG"), "png");
  assert.equal(imageExtensionFromUrl("https://store.tinchak0207.xyz/a/b/cat.webp?v=2"), "webp");
  assert.equal(imageExtensionFromUrl("https://store.tinchak0207.xyz/a/b/cat#frag"), "png");
  assert.equal(imageExtensionFromUrl("https://store.tinchak0207.xyz/image-data/files/jobs/abc"), "png");
  assert.equal(imageExtensionFromUrl(""), "png");
});
