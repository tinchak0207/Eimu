// 分鏡 21 欄契約測試（2026-09-15 刀 2）。
// 兩層釘死：
//   ① 契約層——21 欄名稱與順序逐字等於 AID `doc/提示词开发指南.md` 輸出欄位表，
//      且**不含**已廢的 sceneCode（AID v2.1.4 §開發要點 5）。
//   ② 通道層——往復合同：壓縮（compactMetadataForAgent）→ 還原（toNodeMetadata）
//      後 21 欄仍在（照 canvas-chat-types.test.ts 的 director/sceneCard 範式）。
//      這層是 2026-09-03「刷新後空殼」事故的同型防線：雙白名單漏一端即紅。
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  MAX_STORYBOARD_FIELD_CHARS,
  STORYBOARD_SHOT_FIELDS,
  STORYBOARD_SNAPSHOT_FIELD_CHARS,
  compactStoryboardShot,
  indexCardsByName,
  normalizeStoryboardSceneRef,
  normalizeStoryboardShots,
  normalizeStoryboardShot,
  parseReferenceAssets,
  productionFieldsFromContext,
  resolveReferenceAssetsToCardIds,
  storyboardQcGateArgs,
  storyboardQcContextFromProject,
  storyboardQcShots,
  type StoryboardQcCardRef,
  type StoryboardScriptShot,
} from "./storyboard-contract";
import { compactMetadataForAgent } from "@/hooks/canvas/canvas-chat-types";
import { toNodeMetadata } from "./canvas/layout";
import { runShortDramaTool } from "./shortdrama-domain";

/** 照 AID 契約順序的全形 21 欄樣本。 */
function fullShot(overrides: Partial<StoryboardScriptShot> = {}): StoryboardScriptShot {
  return {
    shotNumber: "001",
    scriptContent: "林昭推開門，屋內空無一人。",
    visualDescription: "中景，林昭推門而入，晨光斜切過地板。",
    dialogue: "[林昭]：「有人嗎」",
    actionState: "林昭推門、環視",
    narrativeFunction: "建立空間與懸念",
    timeOfDay: "清晨",
    eraCoordinate: "当代",
    dateCoordinate: "第三天",
    weather: "晴",
    referenceAssets: "场景:[旧宅_主视] 角色:[林昭_正面]、[陈默_正面] 道具:[铜钥匙]",
    shotSize: "中景",
    cameraAngle: "平视",
    focalLength: "50mm 标准",
    cameraMovement: "固定",
    composition: "三分法",
    atmosphere: "压抑",
    colorTone: "冷调",
    lighting: "侧光",
    exposureBlur: "浅景深",
    soundEffect: "环境风声",
    ...overrides,
  };
}

// ─────────────────────────────────────────── ① 契約層

test("21 欄名稱與順序逐字等於 AID 契約（shotNumber…soundEffect）", () => {
  assert.equal(STORYBOARD_SHOT_FIELDS.length, 21);
  assert.deepEqual([...STORYBOARD_SHOT_FIELDS], [
    "shotNumber",
    "scriptContent",
    "visualDescription",
    "dialogue",
    "actionState",
    "narrativeFunction",
    "timeOfDay",
    "eraCoordinate",
    "dateCoordinate",
    "weather",
    "referenceAssets",
    "shotSize",
    "cameraAngle",
    "focalLength",
    "cameraMovement",
    "composition",
    "atmosphere",
    "colorTone",
    "lighting",
    "exposureBlur",
    "soundEffect",
  ]);
});

test("契約不含已廢的 sceneCode（AID v2.1.4 §開發要點 5）", () => {
  assert.equal((STORYBOARD_SHOT_FIELDS as readonly string[]).includes("sceneCode"), false);
});

test("normalizeStoryboardShot：全形樣本逐欄原樣存活且 key 順序 = 契約順序", () => {
  const shot = normalizeStoryboardShot(fullShot());
  assert.ok(shot);
  assert.deepEqual(shot, fullShot());
  assert.deepEqual(Object.keys(shot), [...STORYBOARD_SHOT_FIELDS]);
});

test("normalizeStoryboardShot：非字串欄位一律收斂成 \"\"（AID 空值規則，不寫 null/「无」）", () => {
  const shot = normalizeStoryboardShot({
    shotNumber: "007",
    scriptContent: null,
    visualDescription: 42,
    dialogue: undefined,
    actionState: { text: "x" },
    referenceAssets: ["[A]"],
  });
  assert.ok(shot);
  for (const field of STORYBOARD_SHOT_FIELDS) {
    if (field === "shotNumber") continue;
    assert.equal(shot[field], "", `${field} 應收斂成空字串`);
  }
});

test("normalizeStoryboardShot：未知欄位丟棄（白名單，不夾帶 sceneCode）", () => {
  const shot = normalizeStoryboardShot({ shotNumber: "002", sceneCode: "S03", image_prompt: "x" });
  assert.ok(shot);
  assert.equal(Object.prototype.hasOwnProperty.call(shot, "sceneCode"), false);
  assert.equal(Object.prototype.hasOwnProperty.call(shot, "image_prompt"), false);
  assert.deepEqual(Object.keys(shot), [...STORYBOARD_SHOT_FIELDS]);
});

test("normalizeStoryboardShot：shotNumber 空/非字串 → null（整包丟棄，不製造無鏡號分鏡）", () => {
  assert.equal(normalizeStoryboardShot({ shotNumber: "", scriptContent: "x" }), null);
  assert.equal(normalizeStoryboardShot({ shotNumber: "   ", scriptContent: "x" }), null);
  assert.equal(normalizeStoryboardShot({ shotNumber: 1, scriptContent: "x" }), null);
  assert.equal(normalizeStoryboardShot({ scriptContent: "x" }), null);
  assert.equal(normalizeStoryboardShot(null), null);
  assert.equal(normalizeStoryboardShot("001"), null);
  assert.equal(normalizeStoryboardShot([]), null);
});

test("normalizeStoryboardShot：shotNumber 規範化（trim + 上限 16 字），其餘欄逐字保留不 trim", () => {
  const shot = normalizeStoryboardShot({ shotNumber: "  001  ", scriptContent: "  原文含縮排  " });
  assert.ok(shot);
  assert.equal(shot.shotNumber, "001");
  assert.equal(shot.scriptContent, "  原文含縮排  ");
});

test("normalizeStoryboardShot：超長欄截 MAX_STORYBOARD_FIELD_CHARS，不觸發者不動", () => {
  const long = "字".repeat(MAX_STORYBOARD_FIELD_CHARS + 10);
  const shot = normalizeStoryboardShot({ shotNumber: "001", scriptContent: long });
  assert.ok(shot);
  assert.equal(shot.scriptContent.length, MAX_STORYBOARD_FIELD_CHARS);
});

test("normalizeStoryboardShots：逐項清洗，非法項丟棄，合法項保序", () => {
  const shots = normalizeStoryboardShots([
    fullShot({ shotNumber: "001" }),
    { scriptContent: "無鏡號" },
    fullShot({ shotNumber: "002" }),
    null,
  ]);
  assert.ok(shots);
  assert.deepEqual(shots.map((s) => s.shotNumber), ["001", "002"]);
  assert.equal(normalizeStoryboardShots({ shots: [] }), null);
});

test("normalizeStoryboardSceneRef：sceneName 非空才成立；shotCount 非負整數否則 0", () => {
  assert.deepEqual(normalizeStoryboardSceneRef({ sceneName: "旧宅", shotCount: 3 }), { sceneName: "旧宅", shotCount: 3 });
  assert.deepEqual(normalizeStoryboardSceneRef({ sceneName: " 旧宅 " }), { sceneName: "旧宅", shotCount: 0 });
  assert.equal(normalizeStoryboardSceneRef({ sceneName: "" }), null);
  assert.equal(normalizeStoryboardSceneRef({ sceneName: "  " }), null);
  assert.deepEqual(normalizeStoryboardSceneRef({ sceneName: "旧宅", shotCount: -1 }), { sceneName: "旧宅", shotCount: 0 });
  assert.deepEqual(normalizeStoryboardSceneRef({ sceneName: "旧宅", shotCount: 2.7 }), { sceneName: "旧宅", shotCount: 2 });
  assert.equal(normalizeStoryboardSceneRef(null), null);
});

// ─────────────────────────────────────────── referenceAssets 解析

test("parseReferenceAssets：三標籤分組解析（含 en-dash 分隔與多角色）", () => {
  assert.deepEqual(parseReferenceAssets("场景:[旧宅_主视] 角色:[林昭_正面]、[陈默_正面] 道具:[铜钥匙]"), {
    scene: ["旧宅_主视"],
    character: ["林昭_正面", "陈默_正面"],
    prop: ["铜钥匙"],
  });
});

test("parseReferenceAssets：空字串/無標籤 → 三空陣列（不拋錯）", () => {
  assert.deepEqual(parseReferenceAssets(""), { scene: [], character: [], prop: [] });
  assert.deepEqual(parseReferenceAssets("角色:[林昭_正面]"), { scene: [], character: ["林昭_正面"], prop: [] });
  assert.deepEqual(parseReferenceAssets("純文字無標籤"), { scene: [], character: [], prop: [] });
});

// ─────────────────────────────────────────── ② 通道層（往復合同）

test("storyboardShot 壓縮保留 21 欄（含空字串欄位），短值不截斷", () => {
  const compacted = compactMetadataForAgent({ storyboardShot: fullShot() });
  assert.ok(compacted);
  assert.deepEqual(compacted.storyboardShot, fullShot());
  assert.deepEqual(Object.keys(compacted.storyboardShot as object), [...STORYBOARD_SHOT_FIELDS]);
});

test("storyboardScene 壓縮透傳（sceneName 是場景歸屬唯一權威）", () => {
  const compacted = compactMetadataForAgent({ storyboardScene: { sceneName: "旧宅", shotCount: 4 } });
  assert.deepEqual(compacted?.storyboardScene, { sceneName: "旧宅", shotCount: 4 });
});

test("壓縮輸出經還原端 toNodeMetadata 後 21 欄仍在（往復合同，刷新/換裝置不空殼）", () => {
  const meta = { storyboardShot: fullShot(), storyboardScene: { sceneName: "旧宅", shotCount: 1 } };
  const restored = toNodeMetadata(compactMetadataForAgent(meta));
  assert.deepEqual(restored.storyboardShot, fullShot());
  assert.deepEqual(Object.keys(restored.storyboardShot as object), [...STORYBOARD_SHOT_FIELDS]);
  assert.deepEqual(restored.storyboardScene, { sceneName: "旧宅", shotCount: 1 });
});

test("往復合同：空字串欄位不被當成缺失（AID 空值規則穿過雙白名單）", () => {
  const shot = fullShot({ dialogue: "", actionState: "", soundEffect: "" });
  const restored = toNodeMetadata(compactMetadataForAgent({ storyboardShot: shot }));
  assert.ok(restored.storyboardShot);
  assert.equal(restored.storyboardShot.dialogue, "");
  assert.equal(restored.storyboardShot.actionState, "");
  assert.equal(restored.storyboardShot.soundEffect, "");
  assert.deepEqual(restored.storyboardShot, shot);
});

test("壓縮端逐欄截 STORYBOARD_SNAPSHOT_FIELD_CHARS，還原端再過一次契約清洗", () => {
  const long = "字".repeat(STORYBOARD_SNAPSHOT_FIELD_CHARS + 500);
  const compacted = compactStoryboardShot(fullShot({ scriptContent: long }));
  assert.equal(compacted.scriptContent.length, STORYBOARD_SNAPSHOT_FIELD_CHARS);
  const restored = toNodeMetadata(compactMetadataForAgent({ storyboardShot: compacted }));
  assert.equal(restored.storyboardShot?.scriptContent.length, STORYBOARD_SNAPSHOT_FIELD_CHARS);
  // 其餘 20 欄不受影響
  assert.equal(restored.storyboardShot?.shotNumber, "001");
  assert.equal(restored.storyboardShot?.shotSize, "中景");
});

test("還原端非契約形狀整包丟棄（無 shotNumber）", () => {
  const restored = toNodeMetadata({ storyboardShot: { scriptContent: "殘形無鏡號" } });
  assert.equal(restored.storyboardShot, undefined);
  assert.equal(toNodeMetadata({ storyboardScene: { shotCount: 3 } }).storyboardScene, undefined);
});

test("非分鏡節點不受影響：無 storyboard 欄位不外傳空殼", () => {
  const compacted = compactMetadataForAgent({ content: "hello" });
  assert.deepEqual(compacted, { content: "hello" });
});

test("不與 sceneCard 互相污染：同節點兩族並存各自存活", () => {
  const sceneCard = {
    turntable_url: "https://cdn.example.com/t.mp4",
    stills_urls: ["https://cdn.example.com/s.png"],
    blend_path: "/api/scene-assets/a.blend",
    glb_path: "/api/scene-assets/a.glb",
    scene_summary: "摘要",
    duration_ms: 8000,
  };
  const restored = toNodeMetadata(compactMetadataForAgent({ sceneCard, storyboardShot: fullShot() }));
  assert.deepEqual(restored.sceneCard, sceneCard);
  assert.deepEqual(restored.storyboardShot, fullShot());
});

// ─────────────────────────────────────────── ③ 門禁輸入橋接

test("storyboardQcShots：欄名映射 shotNumber→shotId、序→order、prompt←visualDescription", () => {
  const { shots, missing, complete } = storyboardQcShots([fullShot({ shotNumber: "001" }), fullShot({ shotNumber: "002" })]);
  assert.deepEqual(shots.map((s) => s.shotId), ["001", "002"]);
  assert.deepEqual(shots.map((s) => s.order), [1, 2]);
  assert.equal(shots[0].prompt, fullShot().visualDescription);
  // 成片階段欄位 21 欄供不了 → 誠實列 missing、complete=false（不補假值）
  assert.equal(complete, false);
  assert.ok(missing.includes("sceneId"));
  assert.ok(missing.includes("durationSeconds"));
  assert.ok(missing.includes("keyframeId"));
  assert.ok(missing.includes("lastFrameId"));
  assert.ok(missing.includes("audioAnchorId"));
  assert.ok(missing.includes("aspectRatio"));
  assert.ok(missing.includes("characterCardIds"));
  assert.ok(missing.includes("sceneCardIds"));
  assert.deepEqual(shots[0].characterCardIds, []);
  assert.deepEqual(shots[0].sceneCardIds, []);
  assert.equal(shots[0].keyframeId, undefined);
});

test("storyboardQcShots：production 補齊成片欄位後 complete=true", () => {
  const production = {
    "001": {
      sceneId: "sc-1",
      durationSeconds: 3,
      characterCardIds: ["char-1"],
      sceneCardIds: ["scene-1"],
      keyframeId: "kf-1",
      lastFrameId: "lf-1",
      audioAnchorId: "au-1",
      aspectRatio: "9:16",
    },
  };
  const { shots, missing, complete } = storyboardQcShots([fullShot({ shotNumber: "001" })], production);
  assert.equal(complete, true);
  assert.deepEqual(missing, []);
  assert.deepEqual(shots[0], {
    shotId: "001",
    order: 1,
    prompt: fullShot().visualDescription,
    sceneId: "sc-1",
    durationSeconds: 3,
    characterCardIds: ["char-1"],
    sceneCardIds: ["scene-1"],
    keyframeId: "kf-1",
    lastFrameId: "lf-1",
    audioAnchorId: "au-1",
    aspectRatio: "9:16",
  });
});

test("storyboardQcShots：production.prompt 覆蓋 visualDescription；空 shots → complete=false", () => {
  const { shots } = storyboardQcShots([fullShot()], { "001": { prompt: "畫師 prompt" } });
  assert.equal(shots[0].prompt, "畫師 prompt");
  assert.equal(storyboardQcShots([]).complete, false);
  assert.deepEqual(storyboardQcShots([]).shots, []);
});

// ─────────────────────────────────────────── ④ 上下文 → 成片欄位（G5 合法推導）

/** 卡實體最小樣本（形狀同 character-cards.ts:38-54，只取解析需要的三欄）。 */
function cards(): StoryboardQcCardRef[] {
  return [
    { id: "card-lin", name: "林昭_正面", kind: "character" },
    { id: "card-chen", name: "陈默_正面", kind: "character" },
    { id: "card-house", name: "旧宅_主视", kind: "scene" },
  ];
}

test("indexCardsByName：同名同 kind 歧義整批排除（不取首個，避免猜）", () => {
  const index = indexCardsByName([
    { id: "a", name: "林昭", kind: "character" },
    { id: "b", name: "林昭", kind: "character" },
    { id: "c", name: "旧宅", kind: "scene" },
  ]);
  assert.equal(index.character.get("林昭"), undefined);
  assert.equal(index.scene.get("旧宅"), "c");
});

test("indexCardsByName：同名不同 kind 互不干擾；空/非字串欄位跳過", () => {
  const index = indexCardsByName([
    { id: "a", name: "同名", kind: "character" },
    { id: "b", name: "同名", kind: "scene" },
    { id: "", name: "无名", kind: "character" },
    { id: "d", name: "   ", kind: "character" },
  ]);
  assert.equal(index.character.get("同名"), "a");
  assert.equal(index.scene.get("同名"), "b");
  assert.equal(index.character.size, 1);
  assert.deepEqual(indexCardsByName([]), { character: new Map(), scene: new Map() });
});

test("resolveReferenceAssetsToCardIds：名稱逐字命中 → 卡 id；道具段無門禁欄位 → 原樣回報不靜默丟", () => {
  const r = resolveReferenceAssetsToCardIds(fullShot().referenceAssets, cards());
  assert.deepEqual(r.characterCardIds, ["card-lin", "card-chen"]);
  assert.deepEqual(r.sceneCardIds, ["card-house"]);
  assert.deepEqual(r.unresolvedProps, ["铜钥匙"]);
  assert.deepEqual(r.unresolvedCharacters, []);
  assert.deepEqual(r.unresolvedScenes, []);
});

test("resolveReferenceAssetsToCardIds：名稱未命中/空輸入 → 不臆造 id（留 unresolved/空陣列）", () => {
  const r = resolveReferenceAssetsToCardIds("场景:[不存在的场景] 角色:[不存在的人]", cards());
  assert.deepEqual(r.characterCardIds, []);
  assert.deepEqual(r.sceneCardIds, []);
  assert.deepEqual(r.unresolvedCharacters, ["不存在的人"]);
  assert.deepEqual(r.unresolvedScenes, ["不存在的场景"]);
  const empty = resolveReferenceAssetsToCardIds("", cards());
  assert.deepEqual(empty.characterCardIds, []);
  assert.deepEqual(empty.sceneCardIds, []);
  // 卡清單為空（未載入）→ 一樣不臆造
  const noCards = resolveReferenceAssetsToCardIds(fullShot().referenceAssets, []);
  assert.deepEqual(noCards.characterCardIds, []);
  assert.deepEqual(noCards.sceneCardIds, []);
});

test("productionFieldsFromContext：有來源才生成——卡名解析 + 節點 ratio，逐條記來源", () => {
  const { fields, sources } = productionFieldsFromContext([fullShot()], {
    cards: cards(),
    shotMetadata: { "001": { size: "9:16" } },
  });
  assert.deepEqual(fields["001"].characterCardIds, ["card-lin", "card-chen"]);
  assert.deepEqual(fields["001"].sceneCardIds, ["card-house"]);
  assert.equal(fields["001"].aspectRatio, "9:16");
  assert.equal(sources["001"].characterCardIds, "referenceAssets");
  assert.equal(sources["001"].sceneCardIds, "referenceAssets");
  assert.equal(sources["001"].aspectRatio, "nodeSize");
});

test("productionFieldsFromContext：**無來源則完全不生成該欄**（不補默認值：無 duration/sceneId/keyframe）", () => {
  const { fields, sources } = productionFieldsFromContext([fullShot()], { cards: cards() });
  const f = fields["001"];
  // 三條推導中只有兩條卡 id 成立（無 shotMetadata → 無 ratio）
  assert.equal(f.aspectRatio, undefined);
  assert.equal(sources["001"].aspectRatio, undefined);
  // 四個本 repo 無生產者的欄位：不得憑空出現
  assert.equal(f.durationSeconds, undefined);
  assert.equal(f.sceneId, undefined);
  assert.equal(f.keyframeId, undefined);
  assert.equal(f.lastFrameId, undefined);
  assert.equal(f.audioAnchorId, undefined);
  // 節點 ratio 只有「已是 ratio 形狀」才收——像素尺寸不做換算、不猜默認
  const px = productionFieldsFromContext([fullShot()], { shotMetadata: { "001": { size: "1024x1792" } } });
  assert.equal(px.fields["001"].aspectRatio, undefined);
  assert.equal(px.sources["001"].aspectRatio, undefined);
});

test("productionFieldsFromContext：呼叫端已供給者不被推導覆蓋（production 優先）", () => {
  const { fields, sources } = productionFieldsFromContext([fullShot()], {
    production: { "001": { characterCardIds: ["card-explicit"], aspectRatio: "16:9" } },
    cards: cards(),
    shotMetadata: { "001": { size: "9:16" } },
  });
  assert.deepEqual(fields["001"].characterCardIds, ["card-explicit"]);
  assert.equal(fields["001"].aspectRatio, "16:9");
  assert.equal(sources["001"].characterCardIds, "production");
  assert.equal(sources["001"].aspectRatio, "production");
});

test("storyboardQcGateArgs：全齊 → complete=true 且兩形 args 可直接餵門禁", () => {
  const production = {
    "001": {
      sceneId: "S01",
      durationSeconds: 3,
      characterCardIds: ["card-lin"],
      sceneCardIds: ["card-house"],
      keyframeId: "kf-1",
      lastFrameId: "lf-1",
      audioAnchorId: "a-1",
      aspectRatio: "9:16",
    },
  };
  const args = storyboardQcGateArgs([fullShot()], {
    production,
    lockedCharacterCardIds: ["card-lin"],
    lockedSceneCardIds: ["card-house"],
    segmentDurationSeconds: 10,
  });
  assert.deepEqual(args.missing, []);
  assert.equal(args.complete, true);
  assert.deepEqual(args.input.shots[0], { shotId: "001", order: 1, prompt: fullShot().visualDescription, ...production["001"] });
  assert.equal(typeof args.toolArgs.shots, "string");
  assert.deepEqual(JSON.parse(args.toolArgs.shots), args.input.shots);
  assert.equal(args.toolArgs.locked_character_card_ids, '["card-lin"]');
  assert.equal(args.toolArgs.segment_duration_seconds, 10);
});

test("storyboardQcGateArgs：**無來源 → 進 missing 且不憑空產生值**（最重要斷言）", () => {
  const args = storyboardQcGateArgs([fullShot()], { cards: cards() });
  assert.equal(args.complete, false);
  // 只由 referenceAssets 推導出兩條 → 其餘全在 missing（含場景/時長/幀/錨點/比例）
  for (const field of ["sceneId", "durationSeconds", "keyframeId", "lastFrameId", "audioAnchorId", "aspectRatio"]) {
    assert.ok(args.missing.includes(field), `${field} 應在 missing`);
  }
  // 門禁層輸入同樣誠實回報（缺鎖定 id → character_lock/scene_lock 必 block；缺段長 → segment_duration 必 block）
  assert.ok(args.missing.includes("lockedCharacterCardIds"));
  assert.ok(args.missing.includes("lockedSceneCardIds"));
  assert.ok(args.missing.includes("segmentDurationSeconds"));
  // 不含任何推導不到的欄位，且沒有補假值
  assert.deepEqual(Object.keys(args.input.shots[0]).sort(), ["characterCardIds", "order", "prompt", "sceneCardIds", "shotId"]);
  assert.equal(args.input.shots[0].durationSeconds, undefined);
  assert.equal(args.input.shots[0].sceneId, undefined);
  assert.equal(args.input.shots[0].keyframeId, undefined);
  assert.equal(args.input.shots[0].aspectRatio, undefined);
  assert.equal(Object.prototype.hasOwnProperty.call(args.toolArgs, "segment_duration_seconds"), false);
  assert.equal(Object.prototype.hasOwnProperty.call(args.toolArgs, "locked_character_card_ids"), false);
});

test("storyboardQcGateArgs：缺專案/缺卡/空陣列的邊界（不拋錯、不臆造）", () => {
  // 無 context
  const bare = storyboardQcGateArgs([fullShot()]);
  assert.equal(bare.complete, false);
  assert.equal(bare.input.shots[0].characterCardIds.length, 0);
  assert.equal(bare.input.shots[0].sceneCardIds.length, 0);
  // 空 shots → complete=false
  assert.equal(storyboardQcGateArgs([]).complete, false);
  assert.deepEqual(storyboardQcGateArgs([]).input.shots, []);
  // 鎖定 id 傳空陣列 = 未供給（不是「鎖了 0 張」）
  const emptyLocks = storyboardQcGateArgs([fullShot()], { lockedCharacterCardIds: [], lockedSceneCardIds: [] });
  assert.ok(emptyLocks.missing.includes("lockedCharacterCardIds"));
  assert.ok(emptyLocks.missing.includes("lockedSceneCardIds"));
  // segmentDurationSeconds=0/NaN 亦視同未供給（門禁 segment_duration 要求 >0）
  assert.ok(storyboardQcGateArgs([fullShot()], { segmentDurationSeconds: 0 }).missing.includes("segmentDurationSeconds"));
  assert.ok(storyboardQcGateArgs([fullShot()], { segmentDurationSeconds: Number.NaN }).missing.includes("segmentDurationSeconds"));
  // production 缺該鏡條目 → 不炸
  const noEntry = storyboardQcGateArgs([fullShot({ shotNumber: "002" })], { production: { "001": {} } });
  assert.equal(noEntry.input.shots[0].shotId, "002");
});

// ─────────────────────────────────────────── ⑤ 端到端：推導結果真餵本地門禁判定

test("端到端：推導後的輸入餵 storyboardQc()，門禁確實收到推導出的卡 id（不是空集合）", () => {
  const production = {
    "001": {
      sceneId: "S01",
      durationSeconds: 3,
      keyframeId: "kf-1",
      lastFrameId: "lf-1",
      audioAnchorId: "a-1",
      aspectRatio: "9:16",
    },
  };
  const args = storyboardQcGateArgs([fullShot()], {
    production,
    cards: cards(),
    lockedCharacterCardIds: ["card-lin", "card-chen"],
    lockedSceneCardIds: ["card-house"],
    segmentDurationSeconds: 3,
  });
  // 卡 id 全部由 referenceAssets 名稱解析而來（非呼叫端手填）
  assert.deepEqual(args.sources["001"].characterCardIds, "referenceAssets");
  assert.deepEqual(args.input.shots[0].characterCardIds, ["card-lin", "card-chen"]);

  const result = runShortDramaTool("storyboard_qc_17", args.input);
  const gates = result.gates;
  assert.equal(gates.length, 17);
  const byId = new Map(gates.map((g) => [g.id, g]));
  // 推導真送到門禁：characters_bound / scenes_bound / character_lock / scene_lock 全 pass
  for (const id of ["characters_bound", "scenes_bound", "character_lock", "scene_lock", "shot_identity", "shot_order", "prompt_present", "duration_bounds", "scene_binding", "aspect_ratio"]) {
    assert.equal(byId.get(id)?.passed, true, `${id} 應 pass（證據：${byId.get(id)?.detail}）`);
  }
  // 未供給的欄位仍 block（誠實：不因推導兩欄就宣稱全數達標）
  assert.equal(byId.get("keyframe_present")?.passed, true);
  assert.equal(result.status, "succeeded");
  assert.equal(result.output.ready, true);
});

test("端到端（負向）：只推導得出卡 id 時門禁仍 block，且 block 的正是無來源的門", () => {
  const args = storyboardQcGateArgs([fullShot()], { cards: cards() });
  const result = runShortDramaTool("storyboard_qc_17", args.input);
  const gates = result.gates;
  assert.equal(gates.length, 17);
  const blocked = gates.filter((g) => !g.passed).map((g) => g.id);
  // 有來源的兩門 pass
  for (const id of ["characters_bound", "scenes_bound"]) assert.ok(!blocked.includes(id), `${id} 不應 block`);
  // 無來源的門如實 block（不被補假值騙過）
  for (const id of ["scene_binding", "keyframe_present", "last_frame_present", "audio_anchor_present", "aspect_ratio", "segment_duration"]) {
    assert.ok(blocked.includes(id), `${id} 應 block`);
  }
  assert.equal(result.status, "blocked");
  assert.equal(result.output.ready, false);
  assert.equal(blocked.length, 17 - gates.filter((g) => g.passed).length);
});

// ─────────────────────────────────────────── ⑥ 空值是「沒有值」不是「有值」（09-17 缺陷回歸釘）

test("空值不得算已供給：\"\" / NaN 進 missing 且不送進門禁（防「橋接說 complete、門禁實際 block」）", () => {
  const hollow = {
    "001": {
      sceneId: "",
      keyframeId: "   ",
      aspectRatio: "",
      durationSeconds: Number.NaN,
      characterCardIds: [""],
      sceneCardIds: [] as string[],
      lastFrameId: "lf-1",
      audioAnchorId: "a-1",
    },
  };
  const r = storyboardQcShots([fullShot()], hollow);
  // 空字串/純空白/NaN/空卡 id 全部如實列 missing
  for (const field of ["sceneId", "keyframeId", "aspectRatio", "durationSeconds", "characterCardIds", "sceneCardIds"]) {
    assert.ok(r.missing.includes(field), `${field} 空值應進 missing`);
  }
  // 真有值的兩欄不算 missing
  assert.ok(!r.missing.includes("lastFrameId"));
  assert.ok(!r.missing.includes("audioAnchorId"));
  // 空值不得被「補」成門禁看得懂的形：鍵要嘛不出現、要嘛是空陣列（門禁一律視為缺）
  assert.equal(r.complete, false);
  assert.equal(Object.prototype.hasOwnProperty.call(r.shots[0], "sceneId"), false);
  assert.equal(Object.prototype.hasOwnProperty.call(r.shots[0], "keyframeId"), false);
  assert.equal(Object.prototype.hasOwnProperty.call(r.shots[0], "aspectRatio"), false);
  assert.equal(Object.prototype.hasOwnProperty.call(r.shots[0], "durationSeconds"), false);
  assert.deepEqual(r.shots[0].characterCardIds, []);
  assert.deepEqual(r.shots[0].sceneCardIds, []);
  // 逐字餵本地門禁：未被空值騙過，該 block 的門如實 block
  const result = runShortDramaTool("storyboard_qc_17", {
    shots: r.shots,
    lockedCharacterCardIds: ["card-lin", "card-chen"],
    lockedSceneCardIds: ["card-house"],
    segmentDurationSeconds: 10,
  });
  const blocked = result.gates.filter((g) => !g.passed).map((g) => g.id);
  for (const id of ["scene_binding", "keyframe_present", "aspect_ratio", "duration_bounds", "characters_bound"]) {
    assert.ok(blocked.includes(id), `${id} 應 block（空值不是值）`);
  }
  assert.equal(result.output.ready, false);
});

test("空值路徑與 null 路徑一致：缺欄、undefined、null、\"\"、NaN 全數等價進 missing", () => {
  const base = { characterCardIds: ["c"], sceneCardIds: ["s"], lastFrameId: "lf", audioAnchorId: "a" };
  const variants: Array<Record<string, unknown>> = [
    { ...base },
    { ...base, sceneId: undefined, durationSeconds: undefined, keyframeId: undefined, aspectRatio: undefined },
    { ...base, sceneId: null, durationSeconds: null, keyframeId: null, aspectRatio: null },
    { ...base, sceneId: "", durationSeconds: Number.NaN, keyframeId: " ", aspectRatio: "\t" },
  ];
  const expected = ["sceneId", "durationSeconds", "keyframeId", "aspectRatio"];
  for (const v of variants) {
    const r = storyboardQcShots([fullShot()], { "001": v as never });
    assert.deepEqual([...r.missing].sort(), [...expected].sort(), `變體 ${JSON.stringify(v)} 的 missing 應一致`);
    assert.equal(r.complete, false);
  }
});

// ─────────────────────────────────────────── ⑦ 專案上下文接線（G5 ③）

test("storyboardQcContextFromProject：project.cardIds 按 kind 分流成兩個鎖定集合，未解析者如實回報", () => {
  const { context, unresolvedCardIds } = storyboardQcContextFromProject(
    { cardIds: ["card-lin", "card-chen", "card-house", "ghost-card", "card-style"] },
    { cards: [...cards(), { id: "card-style", name: "冷调", kind: "style" }] },
  );
  assert.deepEqual(context.lockedCharacterCardIds, ["card-lin", "card-chen"]);
  assert.deepEqual(context.lockedSceneCardIds, ["card-house"]);
  // style 卡不屬門禁兩集（Shot 無 styleCardIds）→ 不算未解析；查不到的 id 才回報
  assert.deepEqual(unresolvedCardIds, ["ghost-card"]);
  assert.deepEqual(context.cards?.length, 4);
});

test("storyboardQcContextFromProject：缺專案/缺卡清單/空陣列 → 不臆造鎖定集合（全數未解析）", () => {
  // 無專案
  const none = storyboardQcContextFromProject();
  assert.equal(none.context.lockedCharacterCardIds, undefined);
  assert.equal(none.context.lockedSceneCardIds, undefined);
  assert.deepEqual(none.unresolvedCardIds, []);
  // 有 cardIds 但無卡清單（卡未載入）→ 全部未解析，絕不兩集合都塞
  const noCards = storyboardQcContextFromProject({ cardIds: ["card-lin", "card-house"] });
  assert.equal(noCards.context.lockedCharacterCardIds, undefined);
  assert.equal(noCards.context.lockedSceneCardIds, undefined);
  assert.deepEqual(noCards.unresolvedCardIds, ["card-lin", "card-house"]);
  // 空 cardIds / 空字串項 → 無鎖定、無未解析
  const emptyIds = storyboardQcContextFromProject({ cardIds: ["", "   "] }, { cards: cards() });
  assert.equal(emptyIds.context.lockedCharacterCardIds, undefined);
  assert.deepEqual(emptyIds.unresolvedCardIds, []);
  // 同 id 撞 kind（歧義）→ 不猜，列未解析
  const ambiguous = storyboardQcContextFromProject(
    { cardIds: ["dup"] },
    { cards: [{ id: "dup", name: "x", kind: "character" }, { id: "dup", name: "y", kind: "scene" }] },
  );
  assert.equal(ambiguous.context.lockedCharacterCardIds, undefined);
  assert.equal(ambiguous.context.lockedSceneCardIds, undefined);
  assert.deepEqual(ambiguous.unresolvedCardIds, ["dup"]);
});

test("storyboardQcContextFromProject：節點 size 只在有 shotNumber 時歸屬該鏡；同鏡矛盾則不給比例", () => {
  const { context } = storyboardQcContextFromProject({
    nodes: [
      { metadata: { size: "9:16", storyboardShot: { shotNumber: "001" } } },
      { metadata: { size: "16:9" } }, // 無鏡號 → 不歸屬任一鏡
    ],
  });
  assert.deepEqual(context.shotMetadata, { "001": { size: "9:16" } });
  const conflicting = storyboardQcContextFromProject({
    nodes: [
      { metadata: { size: "9:16", storyboardShot: { shotNumber: "001" } } },
      { metadata: { size: "16:9", storyboardShot: { shotNumber: "001" } } },
    ],
  });
  assert.deepEqual(conflicting.context.shotMetadata, { "001": {} });
});

test("端到端（專案接線）：專案鎖定卡 + 節點比例經接線真送進門禁（character_lock/scene_lock/aspect_ratio 不因缺輸入而 block）", () => {
  const project = {
    cardIds: ["card-lin", "card-chen", "card-house"],
    nodes: [
      { metadata: { size: "9:16", storyboardShot: { shotNumber: "001" } } },
      { metadata: { size: "9:16", storyboardShot: { shotNumber: "002" } } },
    ],
  };
  const { context, unresolvedCardIds } = storyboardQcContextFromProject(project, { cards: cards() });
  assert.deepEqual(unresolvedCardIds, []);
  const production = {
    "001": { sceneId: "S01", durationSeconds: 3, keyframeId: "kf-1", lastFrameId: "lf-1", audioAnchorId: "a-1" },
    "002": { sceneId: "S01", durationSeconds: 4, keyframeId: "kf-2", lastFrameId: "lf-2", audioAnchorId: "a-2" },
  };
  const args = storyboardQcGateArgs(
    [fullShot({ shotNumber: "001" }), fullShot({ shotNumber: "002" })],
    { ...context, production },
  );
  // 比例由節點推得、卡 id 由 referenceAssets 解析、鎖定集合由專案分流
  assert.equal(args.sources["001"].aspectRatio, "nodeSize");
  assert.equal(args.sources["001"].characterCardIds, "referenceAssets");
  assert.deepEqual(args.input.lockedCharacterCardIds, ["card-lin", "card-chen"]);
  assert.deepEqual(args.input.lockedSceneCardIds, ["card-house"]);
  const result = runShortDramaTool("storyboard_qc_17", args.input);
  const byId = new Map(result.gates.map((g) => [g.id, g]));
  for (const id of ["shot_identity", "shot_order", "scene_binding", "duration_bounds", "prompt_present", "characters_bound", "scenes_bound", "character_lock", "scene_lock", "keyframe_present", "last_frame_present", "audio_anchor_present", "aspect_ratio", "dialogue_alignment", "continuity", "export_readiness"]) {
    assert.equal(byId.get(id)?.passed, true, `${id} 應 pass（證據：${byId.get(id)?.detail}）`);
  }
  // segment_duration 仍如實 block（本接線沒有段長來源，不補假值）
  assert.equal(byId.get("segment_duration")?.passed, false);
  assert.ok(args.missing.includes("segmentDurationSeconds"));
});
