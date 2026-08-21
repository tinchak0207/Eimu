// 角色卡純邏輯測試（P2 鎖定注入語義）：
//   - 注入順序（卡 id 序）、冪等（同卡兩次 / apply 兩次）
//   - 負面詞合併去重、參考圖角色保留與 url 去重
//   - 生成請求體鎖定：applyCharacterCardsToPayload 後請求確實含卡內容
//     （UI 宣稱「卡生效」的真實能力鎖——請求體不含卡內容即測試失敗）
//   - 無卡時零漂移：payload 原樣返回
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  applyCharacterCards,
  applyCharacterCardsToPayload,
  normalizeCharacterCard,
  toCharacterCardKind,
  type CharacterCard,
} from "./character-cards";

function card(partial: Partial<CharacterCard> & { id: string }): CharacterCard {
  return {
    name: partial.id,
    kind: "character",
    prompt: "",
    references: [],
    createdAt: "2026-08-22T00:00:00.000Z",
    updatedAt: "2026-08-22T00:00:00.000Z",
    ...partial,
  };
}

test("applyCharacterCards：卡按 id 升序注入前綴（與傳入順序無關）", () => {
  const a = card({ id: "card-a", prompt: "紅髮少女，藍色軍裝" });
  const b = card({ id: "card-b", prompt: "賽博龐克雨夜街道" });
  const applied = applyCharacterCards("一隻柴犬", [b, a]);
  assert.equal(applied.prompt, "紅髮少女，藍色軍裝\n賽博龐克雨夜街道\n一隻柴犬");
});

test("applyCharacterCards：冪等——同一卡兩次只注入一次；apply 兩次結果相同", () => {
  const a = card({ id: "card-a", prompt: "紅髮少女" });
  const b = card({ id: "card-b", prompt: "雨夜街道" });
  const once = applyCharacterCards("夜景", [a, a, b]);
  assert.equal(once.prompt, "紅髮少女\n雨夜街道\n夜景");
  const twice = applyCharacterCards(once.prompt, [a, b]);
  assert.equal(twice.prompt, once.prompt);
});

test("applyCharacterCards：正文已含的片段不重複注入", () => {
  const a = card({ id: "card-a", prompt: "紅髮少女" });
  const applied = applyCharacterCards("紅髮少女 在海邊", [a]);
  assert.equal(applied.prompt, "紅髮少女 在海邊");
});

test("applyCharacterCards：負面詞合併去重；無負面詞回 null", () => {
  const a = card({ id: "card-a", negativePrompt: "多手指" });
  const b = card({ id: "card-b", negativePrompt: "多手指" }); // 同詞 → 去重
  const c = card({ id: "card-c", negativePrompt: "模糊" });
  const applied = applyCharacterCards("夜景", [a, b, c]);
  assert.equal(applied.negativePrompt, "多手指, 模糊");
  assert.equal(applyCharacterCards("夜景", [card({ id: "d" })]).negativePrompt, null);
});

test("applyCharacterCards：參考圖角色保留、url 去重、非法 URL 丟棄", () => {
  const a = card({
    id: "card-a",
    references: [
      { url: "https://img.example/char.png", role: "character", name: "角色定妝照" },
      { url: "https://img.example/char.png", role: "style", name: "同 URL 應去重" },
      { url: "javascript:alert(1)", role: "general", name: "非法 URL" },
    ],
  });
  const b = card({
    id: "card-b",
    references: [{ url: "https://img.example/style.png", role: "style", name: "風格" }],
  });
  const applied = applyCharacterCards("夜景", [a, b]);
  assert.equal(applied.references.length, 2);
  assert.equal(applied.references[0].role, "character");
  assert.equal(applied.references[0].name, "角色定妝照");
  assert.equal(applied.references[1].role, "style");
});

test("applyCharacterCardsToPayload：請求體確實含卡內容（鎖定生效的真實能力鎖）", () => {
  const a = card({
    id: "card-a",
    prompt: "紅髮少女，藍色軍裝",
    negativePrompt: "多手指",
    references: [{ url: "https://img.example/char.png", role: "character", name: "角色定妝照" }],
  });
  const payload = {
    prompt: "在陽台上喝咖啡",
    model: "gpt-image-2",
    count: 1,
    reference_images: [{ url: "https://img.example/manual.png", role: "general", name: "手動引用" }],
  };
  const result = applyCharacterCardsToPayload(payload, [a]);
  assert.ok(result.prompt.startsWith("紅髮少女，藍色軍裝"));
  assert.ok(result.prompt.includes("在陽台上喝咖啡"));
  assert.equal(result.negative_prompt, "多手指");
  // 卡參考圖在最前（locked 優先），原有參考保留其後，角色保留。
  assert.equal(result.reference_images?.length, 2);
  assert.equal(result.reference_images?.[0].url, "https://img.example/char.png");
  assert.equal(result.reference_images?.[0].role, "character");
  assert.equal(result.reference_images?.[1].url, "https://img.example/manual.png");
  // 其餘欄位不改動。
  assert.equal(result.model, "gpt-image-2");
  assert.equal(result.count, 1);
});

test("applyCharacterCardsToPayload：卡與手動引用同 URL 去重；負面詞與既有值合併", () => {
  const a = card({
    id: "card-a",
    prompt: "紅髮少女",
    negativePrompt: "模糊",
    references: [{ url: "https://img.example/same.png", role: "character", name: "卡圖" }],
  });
  const payload = {
    prompt: "夜景",
    negative_prompt: "多手指",
    reference_images: [{ url: "https://img.example/same.png", role: "general", name: "手動" }],
  };
  const result = applyCharacterCardsToPayload(payload, [a]);
  assert.equal(result.reference_images?.length, 1);
  // 同 URL：locked 角色優先（卡在前，角色 character 保留）。
  assert.equal(result.reference_images?.[0].role, "character");
  assert.equal(result.negative_prompt, "多手指, 模糊");
});

test("applyCharacterCardsToPayload：無卡 / 空卡原樣返回（零行為漂移）", () => {
  const payload = { prompt: "夜景", count: 1 };
  assert.equal(applyCharacterCardsToPayload(payload, []), payload);
  const empty = applyCharacterCardsToPayload(payload, [card({ id: "card-empty" })]);
  assert.equal(empty, payload);
  assert.equal("negative_prompt" in empty, false);
});

test("normalizeCharacterCard：清洗、上限與非法輸入", () => {
  const ok = normalizeCharacterCard({
    id: "card-1",
    name: "主角",
    kind: "scene",
    prompt: "  沙漠廢墟  ",
    references: [{ url: "https://img.example/a.png", role: "bogus", name: "" }],
    negativePrompt: "  ",
    loraIds: ["lora-1", "", 3],
  });
  assert.ok(ok);
  assert.equal(ok?.kind, "scene");
  assert.equal(ok?.prompt, "沙漠廢墟");
  assert.equal(ok?.references[0].role, "general"); // 非法角色 → general
  assert.equal(ok?.references[0].name, "主角"); // 空名回退卡名
  assert.equal(ok?.negativePrompt, undefined); // 空白負面詞丟棄
  assert.deepEqual(ok?.loraIds, ["lora-1"]);
  assert.equal(normalizeCharacterCard({ id: "", name: "x" }), null);
  assert.equal(normalizeCharacterCard({ id: "x", name: 123 }), null);
  assert.equal(normalizeCharacterCard(null), null);
  assert.equal(toCharacterCardKind("scene"), "scene");
  assert.equal(toCharacterCardKind("nonsense"), "character");
});

// ─────────────────────────────────────────── 掛接契約（源碼級，倉庫既有模式）
// 端到端邏輯驗證的替代（不開瀏覽器、不模擬站內鑑權）：
//   1. 純函數層：applyCharacterCardsToPayload 已在上面鎖定「請求體確實含卡內容」。
//   2. 這裡鎖定「掛接點真的存在」：CanvasEmbed 的 callCanvasGenerate 必須調用
//      applyCharacterCardsToPayload（否則 UI 宣稱的「卡生效」是假的）；
//      hook 必須把 cardIds 持久化進 CanvasProject 並暴露 activeCharacterCards；
//      /api/canvas/generate 必須把 negative_prompt 併進 workflow 下游鏈路。
import { readFileSync } from "node:fs";

test("掛接契約：CanvasEmbed 生成唯一出口注入卡（手動+agent 同路）", () => {
  const source = readFileSync("src/components/canvas/CanvasEmbed.tsx", "utf8");
  assert.match(source, /applyCharacterCardsToPayload\(payload as CardAwareGeneratePayload/);
  assert.match(source, /canvasStateRef\.current\.activeCharacterCards/);
  // 存為卡動作 + 卡面板（生效 badge）
  assert.match(source, /存为卡并锁定/);
  assert.match(source, /toggleCharacterCard/);
});

test("掛接契約：use-canvas-chat 持久化 cardIds 並暴露鎖定卡", () => {
  const source = readFileSync("src/hooks/use-canvas-chat.ts", "utf8");
  assert.match(source, /activeCardIdsRef\.current,/);
  assert.match(source, /target\.cardIds/);
  assert.match(source, /const activeCharacterCards = useMemo/);
  // agent 上行摘要含鎖定卡
  assert.match(source, /base\.character_cards/);
});

test("掛接契約：/api/canvas/generate 把卡負面詞併進 workflow 鏈路", () => {
  const source = readFileSync("src/app/api/canvas/generate/route.ts", "utf8");
  assert.match(source, /negative_prompt\?: string/);
  assert.match(source, /negativePrompt \? \{ negativePrompt \}/);
  // JSON 與 multipart 兩條路徑都帶 workflow
  assert.match(source, /\.\.\.\(workflowField \? \{ workflow: workflowField \} : \{\}\)/);
  assert.match(source, /if \(workflowField\) form\.append\("workflow", workflowField\)/);
});

test("掛接契約：/api/character-cards 站內鑑權 + blob store", () => {
  const route = readFileSync("src/app/api/character-cards/route.ts", "utf8");
  assert.match(route, /requireVerifiedUser/);
  assert.match(route, /saveCharacterCard/);
  assert.match(route, /deleteCharacterCards/);
  const store = readFileSync("src/lib/character-card-store.ts", "utf8");
  assert.match(store, /BLOB_READ_WRITE_TOKEN/);
});
