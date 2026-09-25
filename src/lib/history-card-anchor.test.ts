// 歷史一鍵錨定純函式測試：
//   - cardFromHistoryEntry 從歷史條目構造「純參考圖卡」：URL 選取（imageUrl 優先、base64 組 data URL）、
//     kind 三類角色映射、無圖/無名拒建
//   - assetPackPayloadFromHistoryEntry 從歷史條目構造「資產包 payload」（存为资产）：
//     有 prompt 帶 prompt item、無 prompt 退 reference、含 lora 帶 lora item、無 id / 無內容回 null
//   - 構造結果能通過 normalizeCharacterCard（資產層唯一 owner 的清洗收口，不另立標準）
//   - 掛接契約（源碼級）：歷史頁「存为角色卡 / 发布为案例」入口已拔除
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { cardFromHistoryEntry, anchorImageUrlOf, assetPackPayloadFromHistoryEntry } from "./history-card-anchor";
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

test("cardFromHistoryEntry：imageUrl 優先，base64 組 data URL 兜底", () => {
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

  // 無圖記錄（計費日誌）：不建空卡。
  const noImage = entry({ results: [{ provider: "p", modelId: "gpt-image-2", image: null, imageUrl: null }] });
  assert.equal(anchorImageUrlOf(noImage), null);
  assert.equal(cardFromHistoryEntry(noImage, "character", "主角"), null);
});

test("cardFromHistoryEntry：kind 三類 → 參考圖角色映射（scene 收斂 general）", () => {
  const e = entry({
    results: [{ provider: "p", modelId: "gpt-image-2", image: null, imageUrl: "https://img.example/a.png" }],
  });
  assert.equal(cardFromHistoryEntry(e, "character", "主角")?.references[0].role, "character");
  assert.equal(cardFromHistoryEntry(e, "style", "水彩")?.references[0].role, "style");
  // ReferenceImageRole 沒有 scene 角色：場景卡參考圖收斂 general（與 toReferenceImageRole 同一語義）。
  assert.equal(cardFromHistoryEntry(e, "scene", "廢墟")?.references[0].role, "general");
  // 未知 kind 收斂 character（與 toCharacterCardKind 一致）。
  assert.equal(cardFromHistoryEntry(e, "nonsense", "主角")?.kind, "character");
});

test("cardFromHistoryEntry：名稱必填、trim、上限 100", () => {
  const e = entry({
    results: [{ provider: "p", modelId: "gpt-image-2", image: null, imageUrl: "https://img.example/a.png" }],
  });
  assert.equal(cardFromHistoryEntry(e, "character", ""), null);
  assert.equal(cardFromHistoryEntry(e, "character", "   "), null);
  const named = cardFromHistoryEntry(e, "character", "  主角定妝照  ");
  assert.equal(named?.name, "主角定妝照");
  const long = cardFromHistoryEntry(e, "character", "長".repeat(150));
  assert.equal(long?.name.length, 100);
});

test("cardFromHistoryEntry：構造結果通過 normalizeCharacterCard（資產層唯一收口）", () => {
  const e = entry({
    results: [{ provider: "p", modelId: "gpt-image-2", image: null, imageUrl: "https://img.example/style.png" }],
  });
  const card = cardFromHistoryEntry(e, "style", "水彩風格");
  assert.ok(card);
  const normalized = normalizeCharacterCard(card);
  assert.ok(normalized);
  assert.equal(normalized?.kind, "style");
  assert.equal(normalized?.prompt, ""); // 純參考圖卡：locked 片段為空
  assert.equal(normalized?.references.length, 1);
  assert.equal(normalized?.references[0].url, "https://img.example/style.png");
  assert.equal(normalized?.references[0].role, "style");
});

// ─────────────────────────────── 歷史 → 資產包（存为资产）────────────────────────

test("assetPackPayloadFromHistoryEntry：有 prompt 帶 prompt item（content/modelId/size/首圖 URL）", () => {
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
  assert.equal(payload.items.length, 1);
  const item = payload.items[0];
  assert.equal(item.kind, "prompt");
  assert.equal(item.title, "生成提示词");
  assert.equal(item.content, "雨夜霓虹街道");
  assert.equal(item.modelId, "gpt-image-2");
  assert.equal(item.size, "1024x1024");
  assert.equal(item.imageUrl, "https://img.example/a.png"); // 跟锚定一致：第一张可用图
  assert.deepEqual(item.source, { type: "history", id: "entry-1" });
});

test("assetPackPayloadFromHistoryEntry：無 prompt 但帶圖 → 只存 reference", () => {
  const e = entry({
    prompt: "",
    results: [{ provider: "p", modelId: "gpt-image-2", image: null, imageUrl: "https://img.example/a.png" }],
  });
  const payload = assetPackPayloadFromHistoryEntry(e);
  assert.ok(payload);
  assert.equal(payload.items.length, 1);
  const item = payload.items[0];
  assert.equal(item.kind, "reference");
  assert.equal(item.title, "生成图片");
  assert.equal(item.imageUrl, "https://img.example/a.png");
});

test("assetPackPayloadFromHistoryEntry：含 loraModelVersionIds → 額外帶 lora item", () => {
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

test("assetPackPayloadFromHistoryEntry：無 id 回 null", () => {
  const e = entry({
    results: [{ provider: "p", modelId: "gpt-image-2", image: null, imageUrl: "https://img.example/a.png" }],
  });
  const noId = { ...e, id: "   " };
  assert.equal(assetPackPayloadFromHistoryEntry(noId), null);
});

test("assetPackPayloadFromHistoryEntry：無 prompt 也無圖（計費日誌）→ 回 null 不建空包", () => {
  const e = entry({
    prompt: "",
    results: [{ provider: "p", modelId: "gpt-image-2", image: null, imageUrl: null }],
  });
  assert.equal(assetPackPayloadFromHistoryEntry(e), null);
});

test("assetPackPayloadFromHistoryEntry：payload 可通過 normalizeAssetPack（資產層唯一收口）", () => {
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
  assert.equal(normalized.items.length, 1);
  assert.equal(normalized.items[0].kind, "prompt");
  assert.equal(normalized.items[0].content, "雨夜霓虹街道");
});

// ─────────────────────────────────── 掛接契約（源碼級）：入口已拔除
test("掛接契約：歷史頁「存为角色卡」「发布为案例」入口已拔除", () => {
  // 剝行註釋再斷言，防拔除說明的註釋殘留誤紅；斷言只釘歷史頁三檔，
  // 不做全倉掃描——畫布右鍵選單（context-menu-items.ts）仍有「存为角色卡」
  // 入口，不在本契約範圍。
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
