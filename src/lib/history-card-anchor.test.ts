// 历史一键锚定纯函式测试：
//   - cardFromHistoryEntry 从历史条目构造「纯参考图卡」：URL 选取（imageUrl 优先、base64 组 data URL）、
//     kind 三类角色映射、无图/无名拒建
//   - assetPackPayloadFromHistoryEntry 从历史条目构造「资产包 payload」（存为资产）：
//     有 prompt 带 prompt item、无 prompt 退 reference、含 lora 带 lora item、无 id / 无内容回 null
//   - 构造结果能通过 normalizeCharacterCard（资产层唯一 owner 的清洗收口，不另立标准）
//   - 挂接契约（源码级）：历史页「存为角色卡 / 发布为案例」入口已拔除
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { cardFromHistoryEntry, anchorImageUrlOf, anchorDeliverableOf, assetPackPayloadFromHistoryEntry } from "./history-card-anchor";
import { deliverableKindLabel } from "./deliverable-kind";
import type { DeliverableKind } from "./deliverable-kind";
import { normalizeCharacterCard } from "./character-cards";
import { normalizeAssetPack } from "./asset-pack-store";
import type { HistoryEntry } from "./history-types";

function entry(partial: Partial<HistoryEntry> & Pick<HistoryEntry, "results">): HistoryEntry {
  return {
    id: "entry-1",
    prompt: "雨夜霓虹街道",
    generatedAt: Date.now(),
    source: "server",
    ...partial,
  };
}

test("cardFromHistoryEntry：imageUrl 优先，base64 组 data URL 兜底", () => {
  const withUrl = entry({
    results: [
      { provider: "p", modelId: "gpt-image-2", image: "QUJD", imageUrl: null },
      { provider: "p", modelId: "gpt-image-2", image: null, imageUrl: "https://img.example/a.png" },
    ],
  });
  assert.equal(anchorImageUrlOf(withUrl), "https://img.example/a.png");

  const onlyBase64 = entry({
    results: [{ provider: "p", modelId: "gpt-image-2", image: "QUJD", imageUrl: null }],
  });
  assert.equal(anchorImageUrlOf(onlyBase64), "data:image/png;base64,QUJD");

  // 无图记录（计费日志）：不建空卡。
  const noImage = entry({ results: [{ provider: "p", modelId: "gpt-image-2", image: null, imageUrl: null }] });
  assert.equal(anchorImageUrlOf(noImage), null);
  assert.equal(cardFromHistoryEntry(noImage, "character", "主角"), null);
});

test("cardFromHistoryEntry：kind 三类 → 参考图角色映射（scene 收敛 general）", () => {
  const e = entry({
    results: [{ provider: "p", modelId: "gpt-image-2", image: null, imageUrl: "https://img.example/a.png" }],
  });
  assert.equal(cardFromHistoryEntry(e, "character", "主角")?.references[0].role, "character");
  assert.equal(cardFromHistoryEntry(e, "style", "水彩")?.references[0].role, "style");
  // ReferenceImageRole 没有 scene 角色：场景卡参考图收敛 general（与 toReferenceImageRole 同一语义）。
  assert.equal(cardFromHistoryEntry(e, "scene", "废墟")?.references[0].role, "general");
  // 未知 kind 收敛 character（与 toCharacterCardKind 一致）。
  assert.equal(cardFromHistoryEntry(e, "nonsense", "主角")?.kind, "character");
});

test("cardFromHistoryEntry：名称必填、trim、上限 100", () => {
  const e = entry({
    results: [{ provider: "p", modelId: "gpt-image-2", image: null, imageUrl: "https://img.example/a.png" }],
  });
  assert.equal(cardFromHistoryEntry(e, "character", ""), null);
  assert.equal(cardFromHistoryEntry(e, "character", "   "), null);
  const named = cardFromHistoryEntry(e, "character", "  主角定妆照  ");
  assert.equal(named?.name, "主角定妆照");
  const long = cardFromHistoryEntry(e, "character", "长".repeat(150));
  assert.equal(long?.name.length, 100);
});

test("cardFromHistoryEntry：构造结果通过 normalizeCharacterCard（资产层唯一收口）", () => {
  const e = entry({
    results: [{ provider: "p", modelId: "gpt-image-2", image: null, imageUrl: "https://img.example/style.png" }],
  });
  const card = cardFromHistoryEntry(e, "style", "水彩风格");
  assert.ok(card);
  const normalized = normalizeCharacterCard(card);
  assert.ok(normalized);
  assert.equal(normalized?.kind, "style");
  assert.equal(normalized?.prompt, ""); // 纯参考图卡：locked 片段为空
  assert.equal(normalized?.references.length, 1);
  assert.equal(normalized?.references[0].url, "https://img.example/style.png");
  assert.equal(normalized?.references[0].role, "style");
});

// ─────────────────────────────── 历史 → 资产包（存为资产）────────────────────────

test("assetPackPayloadFromHistoryEntry：有 prompt 带 prompt item（content/modelId/size/首图 URL）＋ media item", () => {
  const e = entry({
    prompt: "雨夜霓虹街道",
    workflow: { schemaVersion: 1, imageSize: "1024x1024" },
    results: [
      { provider: "p", modelId: "gpt-image-2", image: null, imageUrl: "https://img.example/a.png" },
      { provider: "p", modelId: "gpt-image-2", image: null, imageUrl: "https://img.example/b.png" },
    ],
  });
  const payload = assetPackPayloadFromHistoryEntry(e);
  assert.ok(payload);
  assert.match(payload.title, /^历史资产 \d{4}-\d{2}-\d{2}$/);
  assert.equal(payload.items.length, 2);
  const item = payload.items[0];
  assert.equal(item.kind, "prompt");
  assert.equal(item.title, "生成提示词");
  assert.equal(item.content, "雨夜霓虹街道");
  assert.equal(item.modelId, "gpt-image-2");
  assert.equal(item.size, "1024x1024");
  assert.equal(item.imageUrl, "https://img.example/a.png"); // 跟锚定一致：第一张可用图
  assert.deepEqual(item.source, { type: "history", id: "entry-1" });
  // 新增：代表媒体 item（kind 由交付物注册表推导）让图 URL 真正落库。
  const media = payload.items[1];
  assert.equal(media.kind, "image");
  assert.equal(media.imageUrl, "https://img.example/a.png");
  assert.deepEqual(media.source, { type: "history", id: "entry-1" });
});

test("assetPackPayloadFromHistoryEntry：无 prompt 但带图 → 存 image item（kind 由注册表推导）", () => {
  const generatedAt = Date.UTC(2026, 9, 3, 12, 34, 56);
  const e = entry({
    prompt: "",
    generatedAt,
    results: [{ provider: "p", modelId: "gpt-image-2", image: null, imageUrl: "https://img.example/a.png" }],
  });
  const payload = assetPackPayloadFromHistoryEntry(e);
  assert.ok(payload);
  assert.equal(payload.items.length, 1);
  const item = payload.items[0];
  assert.equal(item.kind, "image");
  assert.equal(item.imageUrl, "https://img.example/a.png");
  // 无 prompt 的媒体条目：media item title 必须是「种类文案 + 真实生成时间」（真值比对）。
  const kind = item.kind as DeliverableKind;
  assert.equal(
    item.title,
    `${deliverableKindLabel(kind)} ${new Date(generatedAt).toLocaleString("zh-CN")}`,
  );
  assert.equal(item.title, `图片 ${new Date(generatedAt).toLocaleString("zh-CN")}`);
});

test("assetPackPayloadFromHistoryEntry：纯影片 entry → kind:'video' + mediaUrl（可过 normalizeAssetPack）", () => {
  const e = entry({
    prompt: "一段海浪空拍",
    results: [{ provider: "p", modelId: "seedance-2.0", image: null, imageUrl: null, videoUrl: "https://x/a.mp4", mediaType: "video" }],
  });
  const payload = assetPackPayloadFromHistoryEntry(e);
  assert.ok(payload);
  const video = payload.items.find((item) => item.kind === "video");
  assert.ok(video);
  assert.equal(video.mediaUrl, "https://x/a.mp4");
  assert.equal(video.imageUrl, undefined);
  // prompt 存在 → prompt item 也要在（既有产出不得回归）。
  assert.ok(payload.items.some((item) => item.kind === "prompt"));

  const normalized = normalizeAssetPack({ id: `history-${e.id}`, title: payload.title, items: payload.items, tags: [] });
  assert.ok(normalized);
  const normVideo = normalized.items.find((item) => item.kind === "video");
  assert.ok(normVideo);
  assert.equal(normVideo.mediaUrl, "https://x/a.mp4");
});

test("assetPackPayloadFromHistoryEntry：纯音频 entry → kind:'audio' + mediaUrl", () => {
  const e = entry({
    prompt: "",
    results: [{ provider: "p", modelId: "flowmusic", image: null, imageUrl: null, audioUrl: "https://x/a.mp3", mediaType: "audio" }],
  });
  const payload = assetPackPayloadFromHistoryEntry(e);
  assert.ok(payload);
  const audio = payload.items.find((item) => item.kind === "audio");
  assert.ok(audio);
  assert.equal(audio.mediaUrl, "https://x/a.mp3");
  const normalized = normalizeAssetPack({ id: `history-${e.id}`, title: payload.title, items: payload.items, tags: [] });
  assert.ok(normalized);
  assert.equal(normalized.items[0].kind, "audio");
  assert.equal(normalized.items[0].mediaUrl, "https://x/a.mp3");
});

test("assetPackPayloadFromHistoryEntry：prompt 为空时 media item title 带真实时间（不编造）", () => {
  const generatedAt = Date.UTC(2026, 9, 3, 12, 34, 56);
  const e = entry({
    prompt: "   ",
    generatedAt,
    results: [{ provider: "p", modelId: "seedance-2.0", image: null, imageUrl: null, videoUrl: "https://x/a.mp4", mediaType: "video" }],
  });
  const payload = assetPackPayloadFromHistoryEntry(e);
  assert.ok(payload);
  assert.equal(payload.items.length, 1);
  assert.equal(
    payload.items[0].title,
    `视频 ${new Date(generatedAt).toLocaleString("zh-CN")}`,
  );
  assert.doesNotMatch(payload.items[0].title, /undefined|NaN|Invalid Date|生成/);
});

test("anchorDeliverableOf：三种产物各推正确种类与 URL；无产物回 null", () => {
  const img = entry({ results: [{ provider: "p", modelId: "m", image: null, imageUrl: "https://x/a.png" }] });
  assert.deepEqual(anchorDeliverableOf(img), { kind: "image", url: "https://x/a.png" });
  const vid = entry({ results: [{ provider: "p", modelId: "m", image: null, imageUrl: null, videoUrl: "https://x/a.mp4" }] });
  assert.deepEqual(anchorDeliverableOf(vid), { kind: "video", url: "https://x/a.mp4" });
  const aud = entry({ results: [{ provider: "p", modelId: "m", image: null, imageUrl: null, audioUrl: "https://x/a.mp3" }] });
  assert.deepEqual(anchorDeliverableOf(aud), { kind: "audio", url: "https://x/a.mp3" });
  const none = entry({ results: [{ provider: "p", modelId: "m", image: null, imageUrl: null }] });
  assert.equal(anchorDeliverableOf(none), null);
});

test("assetPackPayloadFromHistoryEntry：含 loraModelVersionIds → 额外带 lora item", () => {
  const e = entry({
    results: [{ provider: "p", modelId: "sd-3.5", image: null, imageUrl: "https://img.example/a.png" }],
  }) as HistoryEntry & { loraModelVersionIds?: string[] };
  e.loraModelVersionIds = ["lora-v1", "lora-v2"];
  const payload = assetPackPayloadFromHistoryEntry(e);
  assert.ok(payload);
  const loraItem = payload.items.find((item) => item.kind === "lora");
  assert.ok(loraItem);
  assert.equal(loraItem.title, "LoRA");
  assert.equal(loraItem.loraVersionId, "lora-v1"); // 单选铁律：取第一个
  assert.deepEqual(loraItem.source, { type: "history", id: "entry-1" });
});

test("assetPackPayloadFromHistoryEntry：无 id 回 null", () => {
  const e = entry({
    results: [{ provider: "p", modelId: "gpt-image-2", image: null, imageUrl: "https://img.example/a.png" }],
  });
  const noId = { ...e, id: "   " };
  assert.equal(assetPackPayloadFromHistoryEntry(noId), null);
});

test("assetPackPayloadFromHistoryEntry：无 prompt 也无图（计费日志）→ 回 null 不建空包", () => {
  const e = entry({
    prompt: "",
    results: [{ provider: "p", modelId: "gpt-image-2", image: null, imageUrl: null }],
  });
  assert.equal(assetPackPayloadFromHistoryEntry(e), null);
});

test("assetPackPayloadFromHistoryEntry：payload 可通过 normalizeAssetPack（资产层唯一收口）", () => {
  const e = entry({
    prompt: "雨夜霓虹街道",
    workflow: { schemaVersion: 1, imageSize: "1024x1024" },
    results: [{ provider: "p", modelId: "gpt-image-2", image: null, imageUrl: "https://img.example/a.png" }],
  });
  const payload = assetPackPayloadFromHistoryEntry(e);
  assert.ok(payload);
  const normalized = normalizeAssetPack({
    id: `history-${e.id}`,
    title: payload.title,
    items: payload.items,
    tags: [],
  });
  assert.ok(normalized);
  assert.equal(normalized.items.length, 2);
  assert.equal(normalized.items[0].kind, "prompt");
  assert.equal(normalized.items[0].content, "雨夜霓虹街道");
  assert.equal(normalized.items[1].kind, "image");
  assert.equal(normalized.items[1].imageUrl, "https://img.example/a.png");
});

// ─────────────────────────────────── 挂接契约（源码级）：入口已拔除
test("挂接契约：历史页「存为角色卡」「发布为案例」入口已拔除", () => {
  // 剥行注释再断言，防拔除说明的注释残留误红；断言只钉历史页三档，
  // 不做全仓扫描——画布右键选单（context-menu-items.ts）仍有「存为角色卡」
  // 入口，不在本契约范围。
  const stripLineComments = (source: string) => source.replace(/\/\/.*$/gm, "");

  const card = readFileSync("src/components/history/HistoryCard.tsx", "utf8");
  assert.doesNotMatch(stripLineComments(card), /存为角色卡/);
  assert.doesNotMatch(stripLineComments(card), /发布为案例/);

  const lightbox = readFileSync("src/components/history/HistoryLightbox.tsx", "utf8");
  assert.doesNotMatch(stripLineComments(lightbox), /存为角色卡/);
  assert.doesNotMatch(stripLineComments(lightbox), /发布为案例/);

  const client = readFileSync("src/components/HistoryClient.tsx", "utf8");
  assert.doesNotMatch(stripLineComments(client), /SaveCardDialog|publishUserShowcaseCase/);
});
