import test from "node:test";
import assert from "node:assert/strict";
import {
  AGENT_MEDIA_HISTORY_MAX_ATTEMPTS,
  agentHistoryEntryForMedia,
  agentMediaItemIds,
  isAgentMediaItem,
  pendingAgentMediaHistoryEntries,
  planAgentMediaHistoryWrites,
} from "./agent-media-history";
import type { AgentImageItem, AgentAudioItem, AgentTranscriptItem, AgentVideoItem } from "./agent-chat-types";
import { inferEntryKind, normalizeHistoryEntry } from "./history-types";

const imageItem: AgentImageItem = {
  kind: "image",
  id: "img-1",
  seq: 1,
  url: "https://store.example.com/generation/jobs/cat.png",
  taskId: "job-img-1",
  recipe: { prompt: "a cat", model: "gpt-image-2", size: "1536x1024" },
};

const videoItem: AgentVideoItem = {
  kind: "video",
  id: "vid-1",
  seq: 2,
  url: "https://store.example.com/generation/jobs/clip.mp4",
  taskId: "job-vid-1",
  mediaKind: "film",
};

const audioItem: AgentAudioItem = {
  kind: "audio",
  id: "aud-1",
  seq: 3,
  url: "https://store.example.com/generation/jobs/song.m4a",
  taskId: "job-aud-1",
  mediaKind: "music",
};

test("圖條目 → image entry：url/mediaType/taskId/prompt/modelId/尺寸齊備", () => {
  const entry = agentHistoryEntryForMedia(imageItem);
  assert.equal(entry.entryKind, "image");
  assert.equal(entry.prompt, "a cat");
  assert.equal(entry.modelId, "gpt-image-2");
  assert.equal(entry.taskId, "job-img-1");
  const result = entry.results[0];
  assert.equal(result.imageUrl, imageItem.url);
  assert.equal(result.mediaType, "image");
  assert.equal(result.taskId, "job-img-1");
  // recipe.size 必須進 workflow.imageSize——RerunDialog/buildHistoryRerunPlan 靠它推比例，
  // 不放會退化成 1:1 / 1k。
  assert.equal(entry.workflow?.imageSize, "1536x1024");
  // 同一張圖重複合成 → 同一條 id（冪等 upsert 的前提）。
  assert.equal(agentHistoryEntryForMedia(imageItem).id, entry.id);
  assert.equal(entry.id, "agent-job-img-1");
});

test("影片條目 → video entry：videoUrl + mediaType=video，image 欄位留 null", () => {
  const entry = agentHistoryEntryForMedia(videoItem);
  assert.equal(entry.entryKind, "video");
  const result = entry.results[0];
  assert.equal(result.videoUrl, videoItem.url);
  assert.equal(result.imageUrl, null);
  assert.equal(result.mediaType, "video");
  assert.equal(entry.id, "agent-job-vid-1");
  assert.equal(inferEntryKind(entry), "video");
});

test("音頻條目 → audio entry：audioUrl + mediaType=audio", () => {
  const entry = agentHistoryEntryForMedia(audioItem);
  assert.equal(entry.entryKind, "audio");
  const result = entry.results[0];
  assert.equal(result.audioUrl, audioItem.url);
  assert.equal(result.imageUrl, null);
  assert.equal(result.mediaType, "audio");
  assert.equal(entry.id, "agent-job-aud-1");
  assert.equal(inferEntryKind(entry), "audio");
});

test("無 taskId 時以 url 雜湊兜底：同 url 兩次合成同一條", () => {
  const a = agentHistoryEntryForMedia({ ...imageItem, taskId: undefined });
  const b = agentHistoryEntryForMedia({ ...imageItem, taskId: undefined });
  assert.equal(a.id, b.id);
  assert.match(a.id, /^agent-u[0-9a-z]+$/);
});

test("三種媒體 entry 都能過 POST /api/history 的正規化（不被拒收）", () => {
  for (const item of [imageItem, videoItem, audioItem]) {
    const entry = agentHistoryEntryForMedia(item);
    const normalized = normalizeHistoryEntry(JSON.parse(JSON.stringify(entry)), "server");
    assert.ok(normalized, `${item.kind} entry 被 normalizeHistoryEntry 拒收`);
    assert.equal(normalized.entryKind, item.kind);
    if (item.kind === "image") {
      // 2026-10-03 更新：normalize 现在对 image 也显式写 mediaType（由
      // deliverable-kind 注册表统一推导，旧「刻意省略」已作废）；此分支只断
      // 图片的产物载体 imageUrl 仍在（mediaType 的三态语义已在上一测试逐条断言）。
      assert.equal(normalized.results[0].imageUrl, item.url);
    } else {
      assert.equal(normalized.results[0].mediaType, item.kind);
    }
  }
});

test("isAgentMediaItem 只放行圖／影片／音頻", () => {
  assert.equal(isAgentMediaItem(imageItem), true);
  assert.equal(isAgentMediaItem(videoItem), true);
  assert.equal(isAgentMediaItem(audioItem), true);
  assert.equal(isAgentMediaItem({ kind: "notice", id: "n1", seq: 1, tone: "info", text: "x" }), false);
  assert.equal(isAgentMediaItem({ kind: "assistant", id: "a1", seq: 1, text: "x", streaming: false }), false);
});

test("agentMediaItemIds 只收媒體條目的 id，順序保留", () => {
  const items: AgentTranscriptItem[] = [
    { kind: "assistant", id: "a1", seq: 1, text: "x", streaming: false },
    imageItem,
    videoItem,
    audioItem,
  ];
  assert.deepEqual(agentMediaItemIds(items), ["img-1", "vid-1", "aud-1"]);
});

test("pendingAgentMediaHistoryEntries：只回未處理的媒體，已在集合的跳過、同輪同 id 只出一次", () => {
  const items: AgentTranscriptItem[] = [imageItem, videoItem, audioItem, imageItem];
  // 影片已處理 → 不出；imageItem 重複兩次也只出一次。
  const pending = pendingAgentMediaHistoryEntries(items, new Set(["vid-1"]));
  assert.deepEqual(
    pending.map((entry) => entry.id),
    ["agent-job-img-1", "agent-job-aud-1"],
  );
  // 全部已處理 → 空（重渲染不重打 POST）。
  const none = pendingAgentMediaHistoryEntries(items, new Set(["img-1", "vid-1", "aud-1"]));
  assert.equal(none.length, 0);
  // 非媒體條目一律不進輸出。
  const onlyText: AgentTranscriptItem[] = [
    { kind: "notice", id: "n1", seq: 1, tone: "info", text: "x" },
  ];
  assert.equal(pendingAgentMediaHistoryEntries(onlyText, new Set()).length, 0);
});

test("planAgentMediaHistoryWrites：失敗撤回佔位後，下一輪仍會被挑出來重試", () => {
  const first = planAgentMediaHistoryWrites([imageItem], new Set(), new Set(), new Map());
  // 送出前即佔位（防重渲染重打同一條）。
  assert.deepEqual(first.writes.map((w) => w.itemId), ["img-1"]);
  assert.ok(first.nextProcessedIds.includes("img-1"), "送出中先佔位");
  // 模擬寫入失敗：撤回 img-1（未達上限），attempts +1。
  const afterFailure = new Set(first.nextProcessedIds);
  afterFailure.delete("img-1");
  const retry = planAgentMediaHistoryWrites(
    [imageItem],
    afterFailure,
    new Set(),
    new Map([["img-1", 1]]),
  );
  assert.deepEqual(retry.writes.map((w) => w.itemId), ["img-1"], "失敗後不再 processed，重試仍挑出");
});

test("planAgentMediaHistoryWrites：重試達上限即放棄，不再挑出（且不影響其他條目）", () => {
  const attempts = new Map([["img-1", AGENT_MEDIA_HISTORY_MAX_ATTEMPTS]]);
  const plan = planAgentMediaHistoryWrites([imageItem, videoItem], new Set(), new Set(), attempts);
  assert.deepEqual(plan.writes.map((w) => w.itemId), ["vid-1"], "放棄的 img-1 不挑，正常條目 vid-1 仍挑");
  assert.ok(plan.nextProcessedIds.includes("img-1"), "放棄者併入 processed 定案");
  // 上限前一輪仍可挑（邊界：attempts = MAX-1 尚在預算內）。
  const under = planAgentMediaHistoryWrites(
    [imageItem],
    new Set(),
    new Set(),
    new Map([["img-1", AGENT_MEDIA_HISTORY_MAX_ATTEMPTS - 1]]),
  );
  assert.deepEqual(under.writes.map((w) => w.itemId), ["img-1"]);
});

test("planAgentMediaHistoryWrites：in-flight 中的 id 不重複挑出", () => {
  const plan = planAgentMediaHistoryWrites(
    [imageItem, videoItem],
    new Set(),
    new Set(["img-1"]),
    new Map(),
  );
  assert.deepEqual(plan.writes.map((w) => w.itemId), ["vid-1"]);
});

test("planAgentMediaHistoryWrites：首屏既有 items（已 processed）不進待寫清單", () => {
  const plan = planAgentMediaHistoryWrites(
    [imageItem, videoItem],
    new Set(["img-1", "vid-1"]),
    new Set(),
    new Map(),
  );
  assert.equal(plan.writes.length, 0);
  assert.deepEqual([...plan.nextProcessedIds].sort(), ["img-1", "vid-1"]);
});
