// 歷史一鍵錨定（存为角色卡）純函式測試：
//   - cardFromHistoryEntry 從歷史條目構造「純參考圖卡」：URL 選取（imageUrl 優先、base64 組 data URL）、
//     kind 三類角色映射、無圖/無名拒建
//   - 構造結果能通過 normalizeCharacterCard（資產層唯一 owner 的清洗收口，不另立標準）
//   - 掛接契約（源碼級，倉庫既有模式）：歷史頁真的掛了這個入口且 POST 走 /api/character-cards
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { cardFromHistoryEntry, anchorImageUrlOf } from "./history-card-anchor";
import { normalizeCharacterCard } from "./character-cards";
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

// ─────────────────────────────────────────── 掛接契約（源碼級，倉庫既有模式）
test("掛接契約：歷史頁「存为角色卡」入口存在且 POST 走 /api/character-cards", () => {
  const card = readFileSync("src/components/history/HistoryCard.tsx", "utf8");
  assert.match(card, /onSaveCard/);
  assert.match(card, /存为角色卡/);

  const lightbox = readFileSync("src/components/history/HistoryLightbox.tsx", "utf8");
  assert.match(lightbox, /onSaveCard/);
  assert.match(lightbox, /存为角色卡/);

  const client = readFileSync("src/components/HistoryClient.tsx", "utf8");
  assert.match(client, /SaveCardDialog/);
  assert.match(client, /setSaveCardEntry/);

  // 對話框復用 character-card-client（不另建 API 層）與純函式構造。
  const dialog = readFileSync("src/components/history/SaveCardDialog.tsx", "utf8");
  assert.match(dialog, /saveCharacterCard/);
  assert.match(dialog, /cardFromHistoryEntry/);

  // 資產層唯一 owner：kind 三類枚舉生效。
  const lib = readFileSync("src/lib/character-cards.ts", "utf8");
  assert.match(lib, /"character" \| "scene" \| "style"/);

  // 畫布右鍵菜單補 style 選項（既有入口只加選項，不新增入口）。
  const menu = readFileSync("src/components/canvas/embed/context-menu-items.ts", "utf8");
  assert.match(menu, /save-card-style/);
  assert.match(menu, /存为风格卡/);
});
