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
  CHARACTER_CARD_KIND_LABEL,
  CHARACTER_CARD_KIND_VALUES,
  clearApproval,
  isAssetApproved,
  normalizeApprovalState,
  normalizeCharacterCard,
  setApproval,
  toCharacterCardKind,
  type CharacterCard,
  type CharacterCardKind,
} from "./character-cards";
import {
  ENTITY_TOKEN_PATTERN,
  expandEntityTokens,
  parseEntityTokens,
  resolveEntityTokenKind,
  serializeEntityToken,
} from "./entity-tokens";

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

test("normalizeCharacterCard：style kind 原樣保留（風格卡清洗後不回落 character）", () => {
  const ok = normalizeCharacterCard({
    id: "card-style",
    name: "水彩風格",
    kind: "style",
    prompt: "",
    references: [{ url: "https://img.example/style.png", role: "style", name: "風格樣張" }],
  });
  assert.ok(ok);
  assert.equal(ok?.kind, "style");
  assert.equal(ok?.references[0].role, "style");
  // applyCharacterCardsToPayload 對 style 卡照常注入參考圖（卡種類不影響鎖定語義）。
  const payload = { prompt: "夜景", count: 1 };
  const result = applyCharacterCardsToPayload(payload, [ok!]);
  assert.equal(result.reference_images?.[0].url, "https://img.example/style.png");
  assert.equal(result.reference_images?.[0].role, "style");
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
  assert.equal(toCharacterCardKind("style"), "style");
  assert.equal(toCharacterCardKind("nonsense"), "character");
  // 擊穿收斂：大小寫與近似拼寫都不是合法 kind，必須回落 character（舊數據/agent 亂填不炸）。
  assert.equal(toCharacterCardKind("Style"), "character");
  assert.equal(toCharacterCardKind("styles"), "character");
  assert.equal(toCharacterCardKind(123), "character");
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
  // 2026-08-22 CanvasEmbed 域拆分（Task 7）：生成編排搬 embed/use-canvas-generation.ts、
  // 存為卡搬 embed/use-canvas-interaction.ts、卡面板搬 embed/CanvasEmbedOverlays.tsx——
  // 斷言語義不變，read 路徑改為殼+新檔拼接（同本檔 use-canvas-chat 拆分後的模式）。
  const source = [
    "src/components/canvas/CanvasEmbed.tsx",
    "src/components/canvas/embed/use-canvas-generation.ts",
    "src/components/canvas/embed/use-canvas-interaction.ts",
    "src/components/canvas/embed/context-menu-items.ts",
    "src/components/canvas/embed/CanvasEmbedOverlays.tsx",
  ].map((p) => readFileSync(p, "utf8")).join("\n");
  assert.match(source, /applyCharacterCardsToPayload\(payload as CardAwareGeneratePayload/);
  assert.match(source, /canvasStateRef\.current\.activeCharacterCards/);
  // 存為卡動作 + 卡面板（生效 badge）
  assert.match(source, /存为卡并锁定/);
  assert.match(source, /toggleCharacterCard/);
});

test("掛接契約：use-canvas-chat 持久化 cardIds 並暴露鎖定卡", () => {
  const source = [
    "src/hooks/use-canvas-chat.ts",
    "src/hooks/canvas/canvas-chat-types.ts",
    "src/hooks/canvas/canvas-project-sync.ts",
    "src/hooks/canvas/use-canvas-cards.ts",
    "src/hooks/canvas/canvas-event-settler.ts",
    "src/hooks/canvas/canvas-reducer-adapter.ts",
  ].map((p) => readFileSync(p, "utf8")).join("\n");
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
  // 後端判斷已收口到 blob-backend.ts 的單一真源（VPS selector ∪ BLOB_READ_WRITE_TOKEN）；
  // store 必須經共用門禁 ensureBlobBackendWritable，不得自帶 token-only 判斷（會靜默降級到記憶體）。
  assert.match(store, /from "@\/lib\/blob-backend"/);
  assert.match(store, /ensureBlobBackendWritable/);
  assert.doesNotMatch(store, /BLOB_READ_WRITE_TOKEN/);
});

// ─────────────────────────────────────────── 實體模型擴充（道具/音頻/變體 + 行內 token）
// 全部為**行為斷言**：跑真函式、比對真輸出（源碼字串斷言不計入「已驗證」）。

test("kind 值域：五種 kind 都過 normalizeCharacterCard，prop/audio 不回退 character", () => {
  assert.equal(CHARACTER_CARD_KIND_VALUES.length, 5);
  assert.deepEqual([...CHARACTER_CARD_KIND_VALUES], ["character", "scene", "style", "prop", "audio"]);
  for (const kind of CHARACTER_CARD_KIND_VALUES) {
    const normalized = normalizeCharacterCard({
      id: `card-${kind}`,
      name: `名稱-${kind}`,
      kind,
      prompt: `${kind} 描述`,
      references: [{ url: `https://img.example/${kind}.png`, role: "general", name: `${kind} 圖` }],
    });
    assert.ok(normalized, `${kind} 卡清洗後不應為 null`);
    assert.equal(normalized?.kind, kind, `${kind} 不應被收斂成其他 kind`);
    assert.equal(normalized?.references[0].url, `https://img.example/${kind}.png`);
  }
  assert.equal(toCharacterCardKind("prop"), "prop");
  assert.equal(toCharacterCardKind("audio"), "audio");
  // 未知/中文種類字仍收斂 character（舊數據不炸），但合法值一個都不許掉。
  assert.equal(toCharacterCardKind("道具"), "character");
  assert.equal(toCharacterCardKind("Prop"), "character");
  assert.equal(CHARACTER_CARD_KIND_LABEL.prop, "道具");
  assert.equal(CHARACTER_CARD_KIND_LABEL.audio, "音频");

  // 真行為：道具卡（kind=prop）與角色卡同權參與視覺鎖定——不因新 kind 被靜默丟棄。
  const prop = normalizeCharacterCard({
    id: "card-prop",
    name: "青銅匕首",
    kind: "prop",
    prompt: "祖傳青銅匕首，刃口缺口",
    references: [{ url: "https://img.example/dagger.png", role: "general", name: "道具圖" }],
  });
  const applied = applyCharacterCards("握在手中", [prop!]);
  assert.equal(applied.prompt, "祖傳青銅匕首，刃口缺口\n握在手中");
  assert.equal(applied.references[0].url, "https://img.example/dagger.png");
});

test("kind 值域：音頻卡被視覺鏈路完全忽略（不進前綴、不進參考圖，負面詞也不進）", () => {
  const visual = card({ id: "card-a", prompt: "紅髮少女" });
  const audio = card({
    id: "card-b",
    kind: "audio",
    prompt: "輕快鋼琴配樂",
    negativePrompt: "雜音",
    references: [{ url: "https://img.example/bgm.png", role: "general", name: "音頻封面" }],
  });
  const applied = applyCharacterCards("夜景", [visual, audio]);
  assert.equal(applied.prompt, "紅髮少女\n夜景");
  assert.equal(applied.references.length, 0);
  assert.equal(applied.negativePrompt, null);
});

test("variantOf 清洗：正常保留、含 `:` 省略、自環省略、非字串省略，且不影響整張卡存活", () => {
  const base = normalizeCharacterCard({ id: "card-base", name: "霍辞渊", kind: "character" });
  assert.ok(base);
  const variant = normalizeCharacterCard({
    id: "card-variant",
    name: "劼后-霍辞渊",
    kind: "character",
    variantOf: "  card-base  ",
    prompt: "劼后造型",
  });
  assert.ok(variant, "變體母卡指針壞掉不該讓卡本身消失");
  assert.equal(variant?.variantOf, "card-base"); // trim 後保留
  assert.equal(variant?.kind, "character"); // 變體不新增 kind
  // 走 JSON 往返再清洗（＝blob store 讀回路徑）→ variantOf 逐字存活、不收斂。
  const reloaded = normalizeCharacterCard(JSON.parse(JSON.stringify(variant)));
  assert.deepEqual(reloaded, variant);
  // 含保留分隔符 `:` → 只省略該欄位
  const colon = normalizeCharacterCard({ id: "card-c", name: "x", variantOf: "card:base" });
  assert.ok(colon);
  assert.equal(colon?.variantOf, undefined);
  assert.equal("variantOf" in (colon ?? {}), false);
  // 自環 → 省略（不製造鬼引用）
  const selfRef = normalizeCharacterCard({ id: "card-self", name: "x", variantOf: "card-self" });
  assert.ok(selfRef);
  assert.equal(selfRef?.variantOf, undefined);
  // 非字串 / 控制字元 / 超長 → 省略
  for (const bad of [123, null, {}, "", "   ", "card\u0000base", "a".repeat(101)]) {
    const normalized = normalizeCharacterCard({ id: "card-x", name: "x", variantOf: bad });
    assert.ok(normalized, `variantOf=${String(bad)} 不應讓整張卡回 null`);
    assert.equal(normalized?.variantOf, undefined, `variantOf=${String(bad)} 應被省略`);
  }
});

test("variantOf：母卡存在或缺席都照常參與注入（fail-open，不報錯不丟卡）", () => {
  const mother = card({ id: "card-mother", name: "霍辞渊", prompt: "銀髮紅瞳" });
  const variant = card({
    id: "card-variant",
    name: "劼后-霍辞渊",
    prompt: "劼后造型，金冠",
    variantOf: "card-mother",
    references: [{ url: "https://img.example/jie.png", role: "character", name: "劼后定妝" }],
  });
  const orphan = card({ id: "card-orphan", name: "無母變體", prompt: "孤兒造型", variantOf: "card-ghost" });
  const applied = applyCharacterCards("站著", [mother, variant, orphan]);
  assert.equal(applied.prompt, "銀髮紅瞳\n孤兒造型\n劼后造型，金冠\n站著"); // id 升序：mother < orphan < variant
  assert.equal(applied.references.length, 1);
  assert.equal(applied.references[0].url, "https://img.example/jie.png");
});

// ── 行內 token：解析 / 序列化 / 種類字正規化

test("resolveEntityTokenKind：正/簡/英文皆收，其餘 null", () => {
  const cases: [string, CharacterCardKind][] = [
    ["角色", "character"],
    ["人物", "character"],
    ["character", "character"],
    ["场景", "scene"],
    ["場景", "scene"],
    ["scene", "scene"],
    ["风格", "style"],
    ["風格", "style"],
    ["style", "style"],
    ["道具", "prop"],
    ["prop", "prop"],
    ["音频", "audio"],
    ["音頻", "audio"],
    ["音效", "audio"],
    ["配乐", "audio"],
    ["配樂", "audio"],
    ["audio", "audio"],
    [" 角色 ", "character"], // 兩側空白容忍
  ];
  for (const [label, expected] of cases) {
    assert.equal(resolveEntityTokenKind(label), expected, `${label} 應映射 ${expected}`);
  }
  for (const bogus of ["", "   ", "怪物", "Character", "scenes", "声优", "video"]) {
    assert.equal(resolveEntityTokenKind(bogus), null, `${bogus} 應回 null`);
  }
});

test("parseEntityTokens：位置正確、先後有序、重複呼叫不串味（lastIndex 不洩漏）", () => {
  const prompt = "前 @[角色:霍辞渊] 中 @[场景:雨夜街道] 後";
  const first = parseEntityTokens(prompt);
  assert.equal(first.length, 2);
  assert.equal(prompt.slice(first[0].start, first[0].end), "@[角色:霍辞渊]");
  assert.equal(prompt.slice(first[1].start, first[1].end), "@[场景:雨夜街道]");
  // 全域正則共用會殘留 lastIndex：同一輸入解析兩次必須逐字相同。
  assert.deepEqual(parseEntityTokens(prompt), first);
  assert.equal(ENTITY_TOKEN_PATTERN.global, true);
  // 名稱含種類字/英數/中文標點皆可；巢狀 `[` `]` 不匹配。
  const messy = parseEntityTokens("@[道具:破舊的[青銅]匕首]");
  assert.equal(messy.length, 0);
  assert.deepEqual(parseEntityTokens(""), []);
});

test("serializeEntityToken：往返一致（序列化→解析得回同一種類與名稱）", () => {
  for (const kind of CHARACTER_CARD_KIND_VALUES) {
    const token = serializeEntityToken({ kind, name: "測試實體" });
    assert.ok(token.startsWith("@[") && token.endsWith("]"));
    const hits = parseEntityTokens(`看 ${token} 一眼`);
    assert.equal(hits.length, 1, `${kind} 的 token 應可被解析`);
    assert.equal(hits[0].name, "測試實體");
    assert.equal(resolveEntityTokenKind(hits[0].kindLabel), kind, `${kind} 序列化後應解析回同一 kind`);
    assert.equal(serializeEntityToken({ kind, name: hits[0].name }), token);
  }
});

test("expandEntityTokens：命中就地展開（在原位置，不是搬到開頭）", () => {
  const her = card({ id: "card-her", name: "霍辞渊", prompt: "銀髮紅瞳少女" });
  const scene = card({ id: "card-scene", kind: "scene", name: "雨夜街道", prompt: "賽博龐克雨夜街道" });
  const source = "鏡頭1：@[角色:霍辞渊] 站在 @[场景:雨夜街道] 前";
  const result = expandEntityTokens(source, [her, scene]);
  assert.equal(result.prompt, "鏡頭1：銀髮紅瞳少女 站在 賽博龐克雨夜街道 前");
  assert.notEqual(result.prompt, `${her.prompt}\n${source}`); // 不是前綴搬移
  assert.deepEqual(result.usedCardIds, ["card-her", "card-scene"]); // 首次出現序
  assert.deepEqual(result.unresolved, []);
  // 不 mutate 輸入
  assert.equal(source, "鏡頭1：@[角色:霍辞渊] 站在 @[场景:雨夜街道] 前");
  assert.equal(her.prompt, "銀髮紅瞳少女");
});

test("expandEntityTokens：未命中保留原樣並回報；零 token 逐位元不變", () => {
  const her = card({ id: "card-her", name: "霍辞渊", prompt: "銀髮紅瞳" });
  const miss = expandEntityTokens("帶上 @[角色:不存在] 和 @[怪物:外神] 和 @[角色:不存在] 前進", [her]);
  assert.equal(miss.prompt, "帶上 @[角色:不存在] 和 @[怪物:外神] 和 @[角色:不存在] 前進");
  assert.deepEqual(miss.usedCardIds, []);
  assert.deepEqual(miss.unresolved, ["@[角色:不存在]", "@[怪物:外神]"]); // 去重、首次出現序
  const none = expandEntityTokens("完全沒有 token 的正文", [her]);
  assert.equal(none.prompt, "完全沒有 token 的正文");
  assert.deepEqual(none.usedCardIds, []);
  assert.deepEqual(none.unresolved, []);
});

test("expandEntityTokens：同名同 kind 多張卡取陣列第一張；空片段回退卡名", () => {
  const first = card({ id: "card-1", name: "小美", prompt: "紅裙" });
  const second = card({ id: "card-2", name: "小美", prompt: "藍裙" });
  const hit = expandEntityTokens("@[角色:小美] 出場", [first, second]);
  assert.equal(hit.prompt, "紅裙 出場");
  assert.deepEqual(hit.usedCardIds, ["card-1"]); // 刻意 fail-safe：取第一張
  const bare = card({ id: "card-3", name: "水彩風", kind: "style", prompt: "" });
  const bareHit = expandEntityTokens("@[风格:水彩風] 上色", [bare]);
  assert.equal(bareHit.prompt, "水彩風 上色"); // 空片段 → 用卡名，不留空
  // 種類對不上不命中：kind 必須一致（同名 scene 卡不吃 character token）。
  const wrongKind = card({ id: "card-4", name: "小美", kind: "scene", prompt: "場景小美" });
  assert.equal(expandEntityTokens("@[角色:小美] 出場", [wrongKind]).prompt, "@[角色:小美] 出場");
});

// ── applyCharacterCards 新語義

test("applyCharacterCards：token 引用的卡不重複進前綴；未引用卡照常前綴", () => {
  const her = card({ id: "card-her", name: "霍辞渊", prompt: "銀髮紅瞳少女" });
  const scene = card({ id: "card-scene", kind: "scene", name: "雨夜街道", prompt: "賽博龐克雨夜街道" });
  const style = card({ id: "card-style", kind: "style", name: "水彩", prompt: "水彩畫風" });
  const applied = applyCharacterCards("@[角色:霍辞渊] 在 @[场景:雨夜街道] 回頭", [her, scene, style]);
  assert.equal(applied.prompt, "水彩畫風\n銀髮紅瞳少女 在 賽博龐克雨夜街道 回頭");
  // 被引用的兩張卡不進前綴（不重複），未引用的風格卡進前綴。
  assert.equal(applied.prompt.split("銀髮紅瞳少女").length, 2);
  assert.equal(applied.prompt.split("水彩畫風").length, 2);
});

test("applyCharacterCards：冪等（含 referenceScope: \"referenced\"）", () => {
  const her = card({
    id: "card-her",
    name: "霍辞渊",
    prompt: "銀髮紅瞳少女",
    references: [{ url: "https://img.example/her.png", role: "character", name: "定妝" }],
  });
  const scene = card({
    id: "card-scene",
    kind: "scene",
    name: "雨夜街道",
    prompt: "賽博龐克雨夜街道",
    references: [{ url: "https://img.example/scene.png", role: "general", name: "場景" }],
  });
  for (const options of [undefined, { referenceScope: "referenced" as const }]) {
    const source = "@[角色:霍辞渊] 走進 @[场景:雨夜街道]";
    const once = applyCharacterCards(source, [her, scene], options);
    assert.equal(once.prompt, "銀髮紅瞳少女 走進 賽博龐克雨夜街道");
    const twice = applyCharacterCards(once.prompt, [her, scene], options);
    assert.equal(twice.prompt, once.prompt, "第二次必須逐字相同（靠 base.includes 判準擋掉重複前綴）");
    assert.equal(applyCharacterCards(twice.prompt, [her, scene], options).prompt, once.prompt);
  }
  // 純文字（無 token）路徑的既有冪等同樣保住。
  const plain = applyCharacterCards("夜景", [her, scene]);
  assert.equal(applyCharacterCards(plain.prompt, [her, scene]).prompt, plain.prompt);
});

test("applyCharacterCards：referenceScope \"referenced\" 只收被引用卡的參考圖；無 token 退回 all", () => {
  const her = card({
    id: "card-her",
    name: "霍辞渊",
    prompt: "銀髮紅瞳少女",
    negativePrompt: "多手指",
    references: [{ url: "https://img.example/her.png", role: "character", name: "定妝" }],
  });
  const scene = card({
    id: "card-scene",
    kind: "scene",
    name: "雨夜街道",
    prompt: "賽博龐克雨夜街道",
    negativePrompt: "白天",
    references: [{ url: "https://img.example/scene.png", role: "general", name: "場景" }],
  });
  const scoped = applyCharacterCards("@[角色:霍辞渊] 特寫", [her, scene], { referenceScope: "referenced" });
  assert.deepEqual(scoped.references.map((r) => r.url), ["https://img.example/her.png"]);
  // 負面詞不隨參考圖收窄（收窄會讓畫面失控）。
  assert.equal(scoped.negativePrompt, "多手指, 白天");
  // 零 token → 退回全收，不靜默丟參考圖。
  const fallback = applyCharacterCards("兩人都要", [her, scene], { referenceScope: "referenced" });
  assert.deepEqual(fallback.references.map((r) => r.url), [
    "https://img.example/her.png",
    "https://img.example/scene.png",
  ]);
  // 出參契約：未命中 token 不算「有引用」（usedCardIds 空）→ 同樣退回 all，
  // 未命中的 token 原樣留在正文（fail-open），卡片段照常前綴。
  const missOnly = applyCharacterCards("@[角色:查無此人] 特寫", [her, scene], { referenceScope: "referenced" });
  assert.equal(missOnly.prompt, "銀髮紅瞳少女\n賽博龐克雨夜街道\n@[角色:查無此人] 特寫");
  assert.equal(missOnly.references.length, 2);
});

test("applyCharacterCards：target \"audio\" 只吃音頻卡、references 一律空", () => {
  const visual = card({ id: "card-a", prompt: "紅髮少女", negativePrompt: "多手指" });
  const bgm = card({
    id: "card-bgm",
    kind: "audio",
    name: "離別配樂",
    prompt: "輕快鋼琴配樂",
    negativePrompt: "雜音",
    references: [{ url: "https://img.example/bgm.png", role: "general", name: "封面" }],
  });
  const applied = applyCharacterCards("黃昏的離別", [visual, bgm], { target: "audio" });
  assert.equal(applied.prompt, "輕快鋼琴配樂\n黃昏的離別");
  assert.deepEqual(applied.references, []);
  assert.equal(applied.negativePrompt, "雜音"); // 視覺卡的負面詞不進音頻鏈路
  // 音頻 token 同樣就地展開（音頻鏈路沒有「參考圖」但有「指名」）。
  const named = applyCharacterCards("@[音频:離別配樂] 但更慢", [bgm], { target: "audio" });
  assert.equal(named.prompt, "輕快鋼琴配樂 但更慢");
  // 卡清單裡沒有音頻卡 → 原樣返回。
  const none = applyCharacterCards("黃昏的離別", [visual], { target: "audio" });
  assert.equal(none.prompt, "黃昏的離別");
  assert.deepEqual(none.references, []);
  assert.equal(none.negativePrompt, null);
  assert.equal(applyCharacterCards("黃昏的離別", [], { target: "audio" }).prompt, "黃昏的離別");
});

test("音頻卡參考物清洗：data:audio/ 不得被純圖片尺靜默丟掉（kind-aware 收口；視覺卡尺不放寬）", () => {
  const embeddedAudio = "data:audio/mpeg;base64,SUQzBAo=";
  const remoteAudio = "https://store.example/bgm.mp3";
  const coverImage = "data:image/png;base64,iVBORw0KGgo=";
  const normalized = normalizeCharacterCard({
    id: "card-bgm",
    name: "離別配樂",
    kind: "audio",
    prompt: "輕快鋼琴配樂",
    references: [
      { url: embeddedAudio, role: "general", name: "內嵌樣本" },
      { url: remoteAudio, role: "general", name: "遠端樣本" },
      { url: coverImage, role: "general", name: "封面圖" },
    ],
  });
  assert.ok(normalized, "音頻卡清洗後不得為 null");
  // 舊尺（只認 http / data:image）會把內嵌音頻靜默丟掉 → 卡變成沒有載體的空殼。
  assert.deepEqual(normalized?.references.map((r) => r.url), [embeddedAudio, remoteAudio, coverImage]);
  // 冪等往復：清洗後的卡再清洗一次逐欄不變（儲存層每次寫入都過這把尺）。
  assert.deepEqual(normalizeCharacterCard(normalized), normalized);
  // 視覺卡同一把尺不放寬：data:audio/ 不是圖片 → 該條丟、卡本體存活。
  const visual = normalizeCharacterCard({
    id: "card-visual",
    name: "霍辞渊",
    kind: "character",
    references: [{ url: embeddedAudio, role: "character", name: "誤傳音頻" }],
  });
  assert.ok(visual);
  assert.deepEqual(visual?.references, []);
  // 未給 kind（舊資料/agent 亂填）＝收斂 character → 同樣不收 data:audio/（不放寬未知值）。
  assert.deepEqual(
    normalizeCharacterCard({ id: "card-x", name: "x", references: [{ url: embeddedAudio }] })?.references,
    [],
  );
});

test("音頻卡注入語義（真輸出）：只吃音頻片段、參考物不進 references、負面詞只收音頻卡", () => {
  const character = card({
    id: "card-char",
    name: "霍辞渊",
    prompt: "銀髮紅瞳少女",
    negativePrompt: "多手指",
    references: [{ url: "https://img.example/her.png", role: "character", name: "定妝" }],
  });
  const bgm = card({
    id: "card-bgm",
    kind: "audio",
    name: "離別配樂",
    prompt: "輕快鋼琴配樂",
    negativePrompt: "雜音",
    references: [{ url: "data:audio/mpeg;base64,SUQzBAo=", role: "general", name: "樣本" }],
  });
  const applied = applyCharacterCards("黃昏的離別", [character, bgm], { target: "audio" });
  assert.equal(applied.prompt, "輕快鋼琴配樂\n黃昏的離別");
  assert.equal(applied.prompt.includes("銀髮紅瞳少女"), false, "視覺卡的片段不得進音頻 prompt");
  assert.deepEqual(applied.references, [], "音頻鏈路沒有參考圖語義（音頻參考物不得冒充圖片）");
  assert.equal(applied.negativePrompt, "雜音", "負面詞只收參與音頻鏈路的卡");
  // 冪等：拿上一次輸出再跑一次逐欄相同。
  assert.deepEqual(applyCharacterCards(applied.prompt, [character, bgm], { target: "audio" }), applied);

  // 請求體掛接：prompt 帶音頻片段、負面詞就位，其餘欄位逐位不動、參考圖欄不被音頻參考物污染。
  const payload: {
    prompt: string;
    model: string;
    reference_images: { url: string; role: "general"; name: string }[];
    negative_prompt?: string | null;
  } = { prompt: "黃昏的離別", model: "tts-default", reference_images: [] };
  const hooked = applyCharacterCardsToPayload(payload, [character, bgm], { target: "audio" });
  assert.equal(hooked.prompt, "輕快鋼琴配樂\n黃昏的離別");
  assert.equal(hooked.negative_prompt, "雜音");
  assert.deepEqual(hooked.reference_images, []);
  assert.equal(hooked.model, "tts-default");
});

test("target 缺省＝零回歸：帶 data:audio/ 參考與負面詞的音頻卡對視覺請求體零影響", () => {
  const character = card({ id: "card-char", prompt: "銀髮紅瞳少女" });
  const bgm = card({
    id: "card-bgm",
    kind: "audio",
    prompt: "輕快鋼琴配樂",
    negativePrompt: "雜音",
    references: [{ url: "data:audio/mpeg;base64,SUQzBAo=", role: "general", name: "樣本" }],
  });
  const payload: {
    prompt: string;
    model: string;
    reference_images: { url: string; role: "general"; name: string }[];
    negative_prompt?: string | null;
  } = {
    prompt: "特寫",
    model: "gpt-image-2",
    reference_images: [{ url: "https://img.example/manual.png", role: "general", name: "手動" }],
  };
  const hooked = applyCharacterCardsToPayload(payload, [character, bgm]);
  assert.equal(hooked.prompt, "銀髮紅瞳少女\n特寫");
  assert.deepEqual(hooked.reference_images?.map((r) => r.url), ["https://img.example/manual.png"]);
  assert.equal(hooked.negative_prompt, undefined, "音頻卡的負面詞不得進視覺請求體");
  // 清單裡只有音頻卡 → 原樣返回同一物件（零漂移）。
  assert.equal(applyCharacterCardsToPayload(payload, [bgm]), payload);
  // 音頻 token 在缺省 target 下不展開（fail-open 原樣留在正文）：`@[音频:…]` 不會憑空變片段。
  assert.equal(applyCharacterCards("@[音频:離別配樂] 特寫", [bgm]).prompt, "@[音频:離別配樂] 特寫");
});

test("applyCharacterCards：target 缺省＝既有行為（改動前語義等價對照）", () => {
  const a = card({ id: "card-a", prompt: "紅髮少女，藍色軍裝", negativePrompt: "多手指" });
  const b = card({ id: "card-b", prompt: "賽博龐克雨夜街道" });
  const c = card({ id: "card-c", kind: "style", prompt: "水彩畫風" });
  const base = "一隻柴犬";
  const legacy = "紅髮少女，藍色軍裝\n賽博龐克雨夜街道\n水彩畫風\n一隻柴犬";
  assert.equal(applyCharacterCards(base, [c, b, a]).prompt, legacy); // id 升序無關傳入序
  assert.deepEqual(applyCharacterCards(base, [a, b, c]), applyCharacterCards(base, [a, b, c], {}));
  assert.deepEqual(
    applyCharacterCards(base, [a, b, c]),
    applyCharacterCards(base, [a, b, c], { target: "visual", referenceScope: "all" }),
  );
  // 含 token 的正文在缺省 target 下也走視覺鏈路（audio 卡被忽略）。
  const audio = card({ id: "card-d", kind: "audio", prompt: "配樂" });
  assert.equal(applyCharacterCards(base, [a, audio]).prompt, "紅髮少女，藍色軍裝\n一隻柴犬");
});

test("applyCharacterCardsToPayload：options 透傳且不改動其餘欄位", () => {
  const her = card({
    id: "card-her",
    name: "霍辞渊",
    prompt: "銀髮紅瞳少女",
    negativePrompt: "多手指",
    references: [{ url: "https://img.example/her.png", role: "character", name: "定妝" }],
  });
  const scene = card({
    id: "card-scene",
    kind: "scene",
    name: "雨夜街道",
    prompt: "賽博龐克雨夜街道",
    references: [{ url: "https://img.example/scene.png", role: "general", name: "場景" }],
  });
  const payload = {
    prompt: "@[角色:霍辞渊] 站在 @[场景:雨夜街道] 前",
    model: "gpt-image-2",
    reference_images: [{ url: "https://img.example/manual.png", role: "general" as const, name: "手動" }],
  };
  // 沒被 token 點到的風格卡：正文裡沒有它的 token，片段不進前綴、參考圖被收窄排除。
  const style = card({
    id: "card-style-extra",
    kind: "style",
    name: "水彩",
    prompt: "水彩畫風",
    references: [{ url: "https://img.example/style.png", role: "style", name: "風格樣張" }],
  });
  const result = applyCharacterCardsToPayload(payload, [her, scene, style], { referenceScope: "referenced" });
  // 未引用的風格卡片段照常前綴（referenceScope 只管參考圖，不管片段注入）。
  assert.equal(result.prompt, "水彩畫風\n銀髮紅瞳少女 站在 賽博龐克雨夜街道 前");
  assert.equal(result.negative_prompt, "多手指");
  // 兩張卡都被 token 引用 → 兩張卡的參考圖都在；未引用的風格卡參考圖被排除。
  assert.deepEqual(result.reference_images?.map((r) => r.url), [
    "https://img.example/her.png",
    "https://img.example/scene.png",
    "https://img.example/manual.png",
  ]);
  assert.equal(result.model, "gpt-image-2");
  // 同輸入改回缺省 scope → 風格卡的參考圖重新參與（收窄是 opt-in，不是新默認）。
  const widened = applyCharacterCardsToPayload(payload, [her, scene, style]);
  assert.equal(widened.prompt, result.prompt);
  assert.equal(widened.reference_images?.length, 4);
  // 音頻鏈路：無音頻卡 → 原樣同一物件（零漂移）。
  assert.equal(applyCharacterCardsToPayload(payload, [her], { target: "audio" }), payload);
});

// ─────────────────────────────────────────── 資產批准狀態（2026-09-24 決策 23/4）

test("isAssetApproved：缺省 approval ＝ 已批准（決策 23 存量相容）；未給 mode 一律已批准", () => {
  assert.equal(isAssetApproved(undefined), true);
  assert.equal(isAssetApproved(undefined, "collaborate"), true);
  assert.equal(isAssetApproved(null, "collaborate"), true);
  assert.equal(isAssetApproved({ status: "approved" }, "collaborate"), true);
  assert.equal(isAssetApproved({ status: "pending" }, "collaborate"), false);
  assert.equal(isAssetApproved({ status: "rejected", reason: "光影不对" }, "collaborate"), false);
});

test("護城河：全自動兩檔（preset/auto）對 pending/rejected 卡一律視為已批准、不擋", () => {
  for (const mode of ["preset", "auto"] as const) {
    for (const status of ["pending", "rejected"] as const) {
      assert.equal(isAssetApproved({ status }, mode), true, `${mode}/${status} 必須放行`);
    }
  }
});

test("setApproval/clearApproval：純函式回新卡；駁回理由可原樣讀回（含 normalize 唯一收口往復）", () => {
  const base = card({ id: "card-her", name: "霍辞渊" });
  const rejected = setApproval(base, "rejected", {
    decidedAt: "2026-09-24T10:00:00.000Z",
    reason: "光影与剧本不符",
  });
  assert.equal(base.approval, undefined, "不改傳入卡（純函式）");
  assert.deepEqual(rejected.approval, {
    status: "rejected",
    decidedAt: "2026-09-24T10:00:00.000Z",
    reason: "光影与剧本不符",
  });
  assert.equal(rejected.updatedAt, "2026-09-24T10:00:00.000Z", "批准動作更新 updatedAt（列表按它排序）");
  // 唯一收口：寫入的卡過 normalizeCharacterCard 逐欄不變（decidedAt/reason 不被吞）
  assert.deepEqual(normalizeCharacterCard(JSON.parse(JSON.stringify(rejected))), rejected);

  const approved = setApproval(rejected, "approved", { decidedAt: "2026-09-24T11:00:00.000Z" });
  assert.deepEqual(approved.approval, { status: "approved", decidedAt: "2026-09-24T11:00:00.000Z" }, "換狀態不殘留舊 reason");
  assert.equal(isAssetApproved(approved.approval, "collaborate"), true);

  const cleared = clearApproval(approved);
  assert.equal("approval" in cleared, false, "清除＝回到缺省（欄位整個消失）");
  assert.equal(isAssetApproved(cleared.approval, "collaborate"), true);
  assert.equal(clearApproval(base), base, "本來就沒有 approval → 回同一物件（呼叫端可略過寫入）");
});

test("normalizeCharacterCard：approval 非三值域/半形 → 欄位省略（＝已批准），不整張卡作廢", () => {
  for (const junk of [{ status: "maybe" }, { reason: "沒有 status" }, "approved", ["approved"], { status: 7 }]) {
    const normalized = normalizeCharacterCard({ id: "card-x", name: "x", approval: junk });
    assert.ok(normalized, `approval=${JSON.stringify(junk)} 不得讓整張卡作廢`);
    assert.equal("approval" in normalized, false, `approval=${JSON.stringify(junk)} 應省略欄位`);
    assert.equal(isAssetApproved(normalized.approval, "collaborate"), true);
  }
  const blankReason = normalizeCharacterCard({ id: "card-y", name: "y", approval: { status: "rejected", reason: "   " } });
  assert.deepEqual(blankReason?.approval, { status: "rejected" }, "純空白理由＝沒有理由");
  assert.equal(normalizeApprovalState({ status: "pending" })?.status, "pending");
  assert.equal(normalizeApprovalState(undefined), null);
});
