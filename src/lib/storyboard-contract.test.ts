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
  affectedShotNodesByCardIds,
  compactStoryboardShot,
  filterApprovedShotCardIds,
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
  type StoryboardQcShot,
  type StoryboardQcShotNodeMetadata,
  type StoryboardScriptShot,
} from "./storyboard-contract";
import { compactMetadataForAgent } from "@/hooks/canvas/canvas-chat-types";
import { toNodeMetadata } from "./canvas/layout";
import { runShortDramaTool } from "./shortdrama-domain";
import { normalizeAssetShare } from "./asset-scope";

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
    // 道具是加成欄位（不在 QC_REQUIRED_FIELDS）：未供給時輸出空陣列、且不影響 complete。
    propCardIds: [],
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
  assert.deepEqual(indexCardsByName([]), { character: new Map(), scene: new Map(), prop: new Map() });
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
  assert.deepEqual(args.input.shots[0], { shotId: "001", order: 1, prompt: fullShot().visualDescription, propCardIds: [], ...production["001"] });
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
  assert.deepEqual(Object.keys(args.input.shots[0]).sort(), ["characterCardIds", "order", "prompt", "propCardIds", "sceneCardIds", "shotId"]);
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
      durationSeconds: 12,
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
    segmentDurationSeconds: 12,
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
    "001": { sceneId: "S01", durationSeconds: 12, keyframeId: "kf-1", lastFrameId: "lf-1", audioAnchorId: "a-1" },
    "002": { sceneId: "S01", durationSeconds: 15, keyframeId: "kf-2", lastFrameId: "lf-2", audioAnchorId: "a-2" },
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

// ─────────────────────────────────────────── ⑧ REQ-B2-2 生成卡注入的作用域裁決

/** proj-a 的角色卡 + 一張個人卡（兩態：項目歸屬 / personal）。 */
const scopedCards: StoryboardQcCardRef[] = [
  { id: "card-in-a", name: "項目A角色", kind: "character", scope: { owner: "project", projectId: "proj-a" } },
  { id: "card-personal", name: "個人卡", kind: "character" },
];
const scopedProject = { cardIds: ["card-in-a", "card-personal"] };

test("B2-2 生成卡注入：跨項目未分享的卡不得進鎖定集合（個人卡零回歸、未給上下文逐位不變）", () => {
  // 未給 scope 上下文 → 既有行為逐位不變（零回歸：既有呼叫端不受影響）。
  const legacy = storyboardQcContextFromProject(scopedProject, { cards: scopedCards });
  assert.deepEqual(legacy.context.lockedCharacterCardIds, ["card-in-a", "card-personal"]);
  assert.deepEqual(legacy.outOfScopeCardIds, []);
  assert.equal(legacy.context.cards?.length, 2);

  // proj-b：proj-a 的卡不可用 → 不進鎖定集合，如實回報；個人卡照用。
  const inB = storyboardQcContextFromProject(scopedProject, {
    cards: scopedCards,
    scope: { viewerUserId: 42, projectId: "proj-b", shares: [] },
  });
  assert.deepEqual(inB.context.lockedCharacterCardIds, ["card-personal"]);
  assert.deepEqual(inB.outOfScopeCardIds, ["card-in-a"]);
  assert.deepEqual(inB.unresolvedCardIds, [], "被作用域拒掉的卡不是『查不到實體』（兩態分開）");
  assert.deepEqual(inB.context.cards?.map((c) => c.id), ["card-personal"], "注入上下文不得夾帶不可見的卡實體");

  // proj-a：本項目 → 可用（不是無條件拒絕）。
  const inA = storyboardQcContextFromProject(scopedProject, {
    cards: scopedCards,
    scope: { viewerUserId: 42, projectId: "proj-a", shares: [] },
  });
  assert.deepEqual(inA.context.lockedCharacterCardIds, ["card-in-a", "card-personal"]);
  assert.deepEqual(inA.outOfScopeCardIds, []);

  // 無項目上下文（null）→ 項目歸屬的卡不可用，個人卡照用。
  const noCtx = storyboardQcContextFromProject(scopedProject, {
    cards: scopedCards,
    scope: { viewerUserId: 42, projectId: null, shares: [] },
  });
  assert.deepEqual(noCtx.context.lockedCharacterCardIds, ["card-personal"]);
  assert.deepEqual(noCtx.outOfScopeCardIds, ["card-in-a"]);
});

test("B2-2 生成卡注入：顯式分享後跨項目可用；撤銷後回到不可用", () => {
  const shared = normalizeAssetShare({
    assetKind: "card",
    assetId: "card-in-a",
    fromProjectId: "proj-a",
    toProjectId: "proj-b",
    createdAt: "2026-09-22T00:00:00.000Z",
  });
  assert.ok(shared);
  const inB = storyboardQcContextFromProject(scopedProject, {
    cards: scopedCards,
    scope: { viewerUserId: 42, projectId: "proj-b", shares: [shared] },
  });
  assert.deepEqual(inB.context.lockedCharacterCardIds, ["card-in-a", "card-personal"]);
  assert.deepEqual(inB.outOfScopeCardIds, []);

  // 撤銷後立刻回到不可用（記錄留痕不刪）。
  const revoked = normalizeAssetShare({
    assetKind: "card",
    assetId: "card-in-a",
    fromProjectId: "proj-a",
    toProjectId: "proj-b",
    createdAt: "2026-09-22T00:00:00.000Z",
    revokedAt: "2026-09-22T01:00:00.000Z",
  });
  assert.ok(revoked);
  const afterRevoke = storyboardQcContextFromProject(scopedProject, {
    cards: scopedCards,
    scope: { viewerUserId: 42, projectId: "proj-b", shares: [revoked] },
  });
  assert.deepEqual(afterRevoke.context.lockedCharacterCardIds, ["card-personal"]);
  assert.deepEqual(afterRevoke.outOfScopeCardIds, ["card-in-a"]);

  // 跨 owner：本函式的卡清單一律視為「呼叫者自己的卡」（真源 listCharacterCards(userId)），
  // 故跨 owner 的裁決不在本純函式內——由使用路徑的 store 層負責
  // （見 asset-library 的 isAssetUsable / filterCardIdsForProject 的跨 owner 斷言）。
  // 這裡只釘住「不可見即不可用」在本函式的落點：卡的 ownerUserId 只能是呼叫者。
  const emptyCards = storyboardQcContextFromProject(
    { cardIds: ["card-in-a"] },
    { cards: [], scope: { viewerUserId: 42, projectId: "proj-a", shares: [] } },
  );
  assert.deepEqual(emptyCards.unresolvedCardIds, ["card-in-a"], "無卡實體仍走『不猜』路徑");
});

// ─────────────────────────────────────────── ⑨ 道具卡解析鏈（2026-09-24：道具不再只是自由文字）

/** 道具卡名（含歧義/未命中對照）。 */
const PROP_NAME = "授权让读书";

/** 既有卡清單 + 一張 `kind==="prop"` 的道具卡（`kind` 在本檔是 `string`，不 import WS1 的 union）。 */
function cardsWithProp(): StoryboardQcCardRef[] {
  return [...cards(), { id: "card-prop-book", name: PROP_NAME, kind: "prop" }];
}

/** 去掉 `propCardIds` 鍵的 shots（供「門禁判定不因道具而變」的對照組）。 */
function withoutPropKey(shots: StoryboardQcShot[]): StoryboardQcShot[] {
  return shots.map((shot) => {
    const copy: Record<string, unknown> = { ...shot };
    delete copy.propCardIds;
    return copy as unknown as StoryboardQcShot;
  });
}

test("道具解析：名稱逐字命中 kind===\"prop\" 卡 → propCardIds 含該 id；未命中 → unresolvedProps 含該名", () => {
  const hit = resolveReferenceAssetsToCardIds(`道具:[${PROP_NAME}]`, cardsWithProp());
  assert.deepEqual(hit.propCardIds, ["card-prop-book"]);
  assert.deepEqual(hit.unresolvedProps, []);

  const miss = resolveReferenceAssetsToCardIds("道具:[不存在的道具]", cardsWithProp());
  assert.deepEqual(miss.propCardIds, []);
  assert.deepEqual(miss.unresolvedProps, ["不存在的道具"]);

  // 卡清單未載入（空）→ 一樣不臆造 id
  const noCards = resolveReferenceAssetsToCardIds(`道具:[${PROP_NAME}]`, []);
  assert.deepEqual(noCards.propCardIds, []);
  assert.deepEqual(noCards.unresolvedProps, [PROP_NAME]);
});

test("道具解析沿用同一套尺：同名不同 kind 不解析、同名同 kind 歧義整批排除、style 卡不進 prop 表", () => {
  // 名字對但 kind 不是 prop（character / style）→ 不解析（同 kind 才算）
  const otherKind = resolveReferenceAssetsToCardIds(`道具:[${PROP_NAME}]`, [
    { id: "card-char-same", name: PROP_NAME, kind: "character" },
    { id: "card-style-same", name: PROP_NAME, kind: "style" },
  ]);
  assert.deepEqual(otherKind.propCardIds, []);
  assert.deepEqual(otherKind.unresolvedProps, [PROP_NAME]);

  // 同名同 kind 兩張 → 整批排除（與角色/場景用同一條規則，不為道具另立）
  const dup = resolveReferenceAssetsToCardIds(`道具:[${PROP_NAME}]`, [
    { id: "p1", name: PROP_NAME, kind: "prop" },
    { id: "p2", name: PROP_NAME, kind: "prop" },
  ]);
  assert.deepEqual(dup.propCardIds, []);
  assert.deepEqual(dup.unresolvedProps, [PROP_NAME]);

  // 三族索引互不干擾：prop 表只收 prop 卡，別族的卡不會從 prop 表被撈出來
  const index = indexCardsByName(cardsWithProp());
  assert.equal(index.prop.get(PROP_NAME), "card-prop-book");
  assert.equal(index.character.get(PROP_NAME), undefined);
  assert.equal(index.prop.get("林昭_正面"), undefined);
  assert.equal(index.prop.size, 1);
});

test("禁區 B：qcShots 的 missing 永不含 propCardIds（道具是加成欄位，不是門檻欄位）", () => {
  // 完全沒有道具引用
  const bare = storyboardQcShots([fullShot()]);
  assert.equal(bare.missing.includes("propCardIds"), false);
  assert.deepEqual(bare.shots[0].propCardIds, []);

  // 引用了解析不到的道具（未命中）→ 照樣不得進 missing
  const unresolvedOnly = storyboardQcShots([fullShot({ referenceAssets: "道具:[不存在的道具]" })]);
  assert.equal(unresolvedOnly.missing.includes("propCardIds"), false);
  assert.deepEqual(unresolvedOnly.shots[0].propCardIds, []);

  // 有道具卡 id 時照樣輸出該欄（與另兩個卡 id 陣列同構），也不進 missing
  const withProp = storyboardQcShots([fullShot()], { "001": { propCardIds: ["card-prop-book"] } });
  assert.deepEqual(withProp.shots[0].propCardIds, ["card-prop-book"]);
  assert.equal(withProp.missing.includes("propCardIds"), false);

  // 空值道具 id 逐項過濾（門禁 strArr 只認非空字串），同樣不算缺
  const hollowProp = storyboardQcShots([fullShot()], { "001": { propCardIds: ["", "   "] } });
  assert.deepEqual(hollowProp.shots[0].propCardIds, []);
  assert.equal(hollowProp.missing.includes("propCardIds"), false);
});

test("complete 判定不受 prop 影響：除道具外全齊 → complete=true；只有道具 → complete=false", () => {
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
  const withoutProp = storyboardQcShots([fullShot()], production);
  assert.equal(withoutProp.complete, true);
  assert.deepEqual(withoutProp.missing, []);

  // 反向：道具欄有值也不能把其他缺項洗白
  const onlyProp = storyboardQcShots([fullShot()], { "001": { propCardIds: ["card-prop-book"] } });
  assert.equal(onlyProp.complete, false);
  assert.ok(onlyProp.missing.includes("sceneId"));
});

test("productionFieldsFromContext 第 ④ 條推導：道具名 → propCardIds（來源 referenceAssets；呼叫端已供給不被覆蓋）", () => {
  const shot = fullShot({ referenceAssets: `场景:[旧宅_主视] 角色:[林昭_正面] 道具:[${PROP_NAME}]` });
  const derived = productionFieldsFromContext([shot], { cards: cardsWithProp() });
  assert.deepEqual(derived.fields["001"].propCardIds, ["card-prop-book"]);
  assert.equal(derived.sources["001"].propCardIds, "referenceAssets");
  // 另兩條照舊（同一批解析，道具不干擾角色/場景）
  assert.equal(derived.sources["001"].characterCardIds, "referenceAssets");
  assert.equal(derived.sources["001"].sceneCardIds, "referenceAssets");

  const supplied = productionFieldsFromContext([shot], {
    production: { "001": { propCardIds: ["card-explicit-prop"] } },
    cards: cardsWithProp(),
  });
  assert.deepEqual(supplied.fields["001"].propCardIds, ["card-explicit-prop"], "呼叫端已供給的道具 id 不被推導覆蓋");
  assert.equal(supplied.sources["001"].propCardIds, "production");

  // 沒有道具來源時完全不生成該欄（與其他推導同一紀律：不補默認值）
  const bare = productionFieldsFromContext([fullShot({ referenceAssets: "角色:[林昭_正面]" })], { cards: cardsWithProp() });
  assert.equal(bare.fields["001"].propCardIds, undefined);
  assert.equal(bare.sources["001"].propCardIds, undefined);
});

test("行為斷言：帶道具的推導結果餵本地門禁，門禁判定與無道具時逐項相同（道具不改變任何一門）", () => {
  const production = {
    "001": { sceneId: "S01", durationSeconds: 12, keyframeId: "kf-1", lastFrameId: "lf-1", audioAnchorId: "a-1" },
  };
  const shots = [fullShot({ referenceAssets: `场景:[旧宅_主视] 角色:[林昭_正面] 道具:[${PROP_NAME}]` })];
  const withPropArgs = storyboardQcGateArgs(shots, {
    production,
    cards: cardsWithProp(),
    shotMetadata: { "001": { size: "9:16" } },
    lockedCharacterCardIds: ["card-lin"],
    lockedSceneCardIds: ["card-house"],
    segmentDurationSeconds: 12,
  });
  // 道具名稱真的走完了「名稱 → 卡 id」解析鏈（來源記在審計跡上）
  assert.deepEqual(withPropArgs.input.shots[0].propCardIds, ["card-prop-book"]);
  assert.equal(withPropArgs.sources["001"].propCardIds, "referenceAssets");

  const withProp = runShortDramaTool("storyboard_qc_17", withPropArgs.input);
  const stripped = runShortDramaTool("storyboard_qc_17", {
    ...withPropArgs.input,
    shots: withoutPropKey(withPropArgs.input.shots),
  });
  assert.equal(withProp.gates.length, 17);
  assert.deepEqual(withProp.gates, stripped.gates, "多帶 propCardIds 鍵不得改變任何一門的判定");
  assert.equal(withProp.output.ready, true);
});

test("專案接線：專案鎖定清單裡的 prop 卡不算『查不到卡實體』（也不進兩集鎖定集合）", () => {
  const { context, unresolvedCardIds } = storyboardQcContextFromProject(
    { cardIds: ["card-lin", "card-prop-book"] },
    { cards: cardsWithProp() },
  );
  assert.deepEqual(context.lockedCharacterCardIds, ["card-lin"]);
  assert.deepEqual(context.lockedSceneCardIds, undefined);
  assert.deepEqual(unresolvedCardIds, []);
});

// ─────────────────────────────────────────── ⑩ 第 ⑤ 條推導：節點 metadata 卡 id → 門禁（2026-09-24 閉環消費端）

/** 分鏡節點樣本（結構相容 CanvasNodeRef）：鏡號 + 任意 metadata 欄。 */
function shotNode(shotNumber: string, metadata: StoryboardQcShotNodeMetadata): { metadata: StoryboardQcShotNodeMetadata & { storyboardShot: { shotNumber: string } } } {
  return { metadata: { ...metadata, storyboardShot: { shotNumber } } };
}

test("閉環（最重要）：節點 metadata 的卡 id 真的進 fields/sources，且 missing 確實少掉兩項", () => {
  // referenceAssets 刻意留空：這條只驗 metadata 這一路（不得靠名稱解析借道）
  const shot = fullShot({ referenceAssets: "" });
  const context = {
    shotMetadata: { "001": { characterCardIds: ["card-lin", "card-chen"], sceneCardIds: ["card-house"] } },
  };
  const { fields, sources } = productionFieldsFromContext([shot], context);
  assert.deepEqual(fields["001"].characterCardIds, ["card-lin", "card-chen"]);
  assert.deepEqual(fields["001"].sceneCardIds, ["card-house"]);
  assert.equal(sources["001"].characterCardIds, "nodeMetadata");
  assert.equal(sources["001"].sceneCardIds, "nodeMetadata");

  // 對照組：同一鏡、無 metadata 卡 id → 兩項卡 id 進 missing
  const withoutMeta = storyboardQcShots([shot], productionFieldsFromContext([shot], {}).fields);
  assert.ok(withoutMeta.missing.includes("characterCardIds"));
  assert.ok(withoutMeta.missing.includes("sceneCardIds"));

  // 有 metadata → 這兩項真的從 missing 消失（閉環的價值本體）
  const withMeta = storyboardQcShots([shot], fields);
  assert.ok(!withMeta.missing.includes("characterCardIds"), "推導到值後不得再列 missing");
  assert.ok(!withMeta.missing.includes("sceneCardIds"));
  assert.deepEqual(
    withoutMeta.missing.filter((f) => !["characterCardIds", "sceneCardIds"].includes(f)),
    withMeta.missing.filter((f) => !["characterCardIds", "sceneCardIds"].includes(f)),
    "除了這兩項，其餘 missing 逐項不變",
  );
});

test("優先序三態：supplied > referenceAssets > 節點 metadata（metadata 絕不覆蓋前兩者）", () => {
  const threeFromNode = { "001": { characterCardIds: ["card-x", "card-y", "card-z"] } };
  // ① supplied 有值 → production 勝，src = "production"
  const supplied = productionFieldsFromContext([fullShot()], {
    production: { "001": { characterCardIds: ["card-explicit"] } },
    cards: cards(),
    shotMetadata: threeFromNode,
  });
  assert.deepEqual(supplied.fields["001"].characterCardIds, ["card-explicit"]);
  assert.equal(supplied.sources["001"].characterCardIds, "production");

  // ② supplied 無、referenceAssets 指 1 張、metadata 有 3 張 → 結果必須是那 1 張
  const viaRefs = productionFieldsFromContext([fullShot({ referenceAssets: "角色:[林昭_正面]" })], {
    cards: cards(),
    shotMetadata: threeFromNode,
  });
  assert.deepEqual(viaRefs.fields["001"].characterCardIds, ["card-lin"], "metadata 不得覆蓋 referenceAssets");
  assert.equal(viaRefs.sources["001"].characterCardIds, "referenceAssets");

  // ③ 兩者都無 → metadata 勝，src = "nodeMetadata"
  const viaNode = productionFieldsFromContext([fullShot({ referenceAssets: "" })], { shotMetadata: threeFromNode });
  assert.deepEqual(viaNode.fields["001"].characterCardIds, ["card-x", "card-y", "card-z"]);
  assert.equal(viaNode.sources["001"].characterCardIds, "nodeMetadata");
});

test("禁區：propCardIds 從 metadata 推導到值，missing 與 complete 逐項不變", () => {
  const shot = fullShot({ referenceAssets: "" });
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
  const common = {
    production,
    lockedCharacterCardIds: ["card-lin"],
    lockedSceneCardIds: ["card-house"],
    segmentDurationSeconds: 3,
  };
  const withProp = storyboardQcGateArgs([shot], { ...common, shotMetadata: { "001": { propCardIds: ["card-prop-book"] } } });
  const withoutProp = storyboardQcGateArgs([shot], common);
  assert.deepEqual(withProp.missing, withoutProp.missing, "道具是加成欄位：missing 逐項不變");
  assert.equal(withProp.complete, withoutProp.complete);
  assert.equal(withProp.complete, true);
  assert.deepEqual(withProp.input.shots[0].propCardIds, ["card-prop-book"]);
  assert.equal(withProp.sources["001"].propCardIds, "nodeMetadata");
  assert.deepEqual(withoutProp.input.shots[0].propCardIds, []);
  // 行為斷言：門禁 17 門判定逐項相同（道具鍵不改變任何一門）
  const gated = runShortDramaTool("storyboard_qc_17", withProp.input);
  const stripped = runShortDramaTool("storyboard_qc_17", { ...withProp.input, shots: withoutPropKey(withProp.input.shots) });
  assert.equal(gated.gates.length, 17);
  assert.deepEqual(gated.gates, stripped.gates);
});

test("清洗與空值：非字串項剔除、重複去重；空陣列省略該鍵（不誤報「有值」）", () => {
  const dirty = productionFieldsFromContext([fullShot({ referenceAssets: "" })], {
    shotMetadata: { "001": { characterCardIds: ["a", "", "a", 123] } },
  });
  assert.deepEqual(dirty.fields["001"].characterCardIds, ["a"]);
  assert.equal(dirty.sources["001"].characterCardIds, "nodeMetadata");

  // 空陣列 / 全空白 / 非陣列 → 不生成該欄、來源不出現
  for (const raw of [[], ["", "   "], "a", null, { 0: "a" }]) {
    const bare = productionFieldsFromContext([fullShot({ referenceAssets: "" })], {
      shotMetadata: { "001": { characterCardIds: raw } },
    });
    assert.equal(bare.fields["001"].characterCardIds, undefined, `raw=${JSON.stringify(raw)} 不得生成`);
    assert.equal(bare.sources["001"].characterCardIds, undefined);
  }
});

test("專案接線：節點卡 id 進 shotMetadata（與 size 共存；空值省略鍵；無鏡號不臆造鍵）", () => {
  const { context } = storyboardQcContextFromProject({
    nodes: [
      shotNode("001", { size: "9:16", characterCardIds: ["card-lin", "", "card-lin"], sceneCardIds: ["card-house"], propCardIds: ["card-prop-book"] }),
      shotNode("002", { characterCardIds: ["card-chen"] }), // 無 size 但卡 id 仍要帶
      shotNode("003", { characterCardIds: [] }), // 空陣列 → 該鍵省略
      { metadata: { characterCardIds: ["card-ghost"] } }, // 無鏡號 → 不歸屬任一鏡
    ],
  });
  assert.deepEqual(context.shotMetadata, {
    "001": { size: "9:16", characterCardIds: ["card-lin"], sceneCardIds: ["card-house"], propCardIds: ["card-prop-book"] },
    "002": { characterCardIds: ["card-chen"] },
  });
  // 未被誤加的鍵：003 只有空陣列 → 整個鏡鍵都不生成（不造空殼）；size 語義不變
  assert.equal(Object.prototype.hasOwnProperty.call(context.shotMetadata, "003"), false);
  assert.equal(context.shotMetadata?.["002"]?.size, undefined);
});

test("整合（oracle = 真本地 storyboard_qc_17）：節點卡 id 帶入 → 門禁該些門通過；不帶 → block", () => {
  // 輸入只有節點宣告的卡 id：專案鎖定集 = 同一批卡、鏡的 referenceAssets 為空（無名稱可解析）
  const project = {
    cardIds: ["card-lin", "card-chen", "card-house"],
    nodes: [shotNode("001", { size: "9:16", characterCardIds: ["card-lin", "card-chen"], sceneCardIds: ["card-house"] })],
  };
  const { context, unresolvedCardIds } = storyboardQcContextFromProject(project, { cards: cards() });
  assert.deepEqual(unresolvedCardIds, []);

  const production = {
    "001": { sceneId: "S01", durationSeconds: 3, keyframeId: "kf-1", lastFrameId: "lf-1", audioAnchorId: "a-1" },
  };
  const args = storyboardQcGateArgs([fullShot({ referenceAssets: "" })], { ...context, production });
  const gated = runShortDramaTool("storyboard_qc_17", args.input);
  const byId = new Map(gated.gates.map((g) => [g.id, g]));
  assert.equal(args.sources["001"].characterCardIds, "nodeMetadata");
  assert.equal(args.sources["001"].sceneCardIds, "nodeMetadata");
  for (const id of ["characters_bound", "scenes_bound", "character_lock", "scene_lock"]) {
    assert.equal(byId.get(id)?.passed, true, `${id} 應 pass（證據：${byId.get(id)?.detail}）`);
  }
  assert.ok(!args.missing.includes("characterCardIds"));
  assert.ok(!args.missing.includes("sceneCardIds"));

  // 對照組：同專案、同 production，但節點不宣告卡 id → 該些門如實 block
  const noMeta = storyboardQcContextFromProject(
    { cardIds: ["card-lin", "card-chen", "card-house"], nodes: [shotNode("001", { size: "9:16" })] },
    { cards: cards() },
  );
  const bareArgs = storyboardQcGateArgs([fullShot({ referenceAssets: "" })], { ...noMeta.context, production });
  const bare = runShortDramaTool("storyboard_qc_17", bareArgs.input);
  const bareById = new Map(bare.gates.map((g) => [g.id, g]));
  for (const id of ["characters_bound", "scenes_bound"]) {
    assert.equal(bareById.get(id)?.passed, false, `${id} 應 block（無來源時不許通過）`);
  }
  // 兩集 lock 門在「引用集為空」時是空集合真空通過（門禁既有語義，非本刀改動）——
  // 所以無來源時真正 block 的是 `*_bound`；有來源時 lock 門才是**非真空**地驗「每個引用都在鎖定集內」。
  assert.equal(bareById.get("character_lock")?.passed, true);
  assert.ok(bareArgs.missing.includes("characterCardIds"));
  assert.ok(bareArgs.missing.includes("sceneCardIds"));
  assert.equal(bare.output.ready, false);
});

// ─────────────────────────────────────────── ⑪ 資產批准閘（2026-09-24 決策 2/23）

/** 批准狀態樣本名單（同一批名稱，只換 approval；undefined＝不帶欄位＝缺省）。 */
function cardsWithApproval(status: "approved" | "pending" | "rejected" | undefined): StoryboardQcCardRef[] {
  const names: [string, string, string][] = [
    ["card-lin", "林昭_正面", "character"],
    ["card-chen", "陈默_正面", "character"],
    ["card-house", "旧宅_主视", "scene"],
  ];
  return names.map(([id, name, kind]) => ({
    id,
    name,
    kind,
    ...(status ? { approval: { status } } : {}),
  }));
}

test("協作檔：未批准的卡 id 不得進分鏡卡引用欄；改 approved 後進來（真輸入真輸出）", () => {
  const pending = productionFieldsFromContext([fullShot()], { cards: cardsWithApproval("pending"), mode: "collaborate" });
  assert.equal("characterCardIds" in pending.fields["001"], false, "未批准 → 整欄不留值（不留空陣列騙門禁）");
  assert.equal("sceneCardIds" in pending.fields["001"], false);
  assert.deepEqual(pending.blockedCardIdsByShot?.["001"], ["card-lin", "card-chen", "card-house"], "擋下的 id 如實回報");
  const viaGate = storyboardQcShots([fullShot()], pending.fields);
  assert.ok(viaGate.missing.includes("characterCardIds"), "擋下後該欄進 missing（門禁會 block，不是靜默無引用）");
  assert.ok(viaGate.missing.includes("sceneCardIds"));

  // 同一份名單改 approved → 同一條推導路徑把 id 交出來
  const okFields = productionFieldsFromContext([fullShot()], { cards: cardsWithApproval("approved"), mode: "collaborate" });
  assert.deepEqual(okFields.fields["001"].characterCardIds, ["card-lin", "card-chen"]);
  assert.deepEqual(okFields.fields["001"].sceneCardIds, ["card-house"]);
  assert.equal(okFields.blockedCardIdsByShot, undefined, "沒擋到就不回報這欄");

  // 缺省 approval（存量資產）→ 協作檔照樣當已批准
  const legacy = productionFieldsFromContext([fullShot()], { cards: cardsWithApproval(undefined), mode: "collaborate" });
  assert.deepEqual(legacy.fields["001"].characterCardIds, ["card-lin", "card-chen"], "缺省＝已批准（決策 23）");

  // 逐 id 過閘：只有林昭 pending，已批准的陈默不受牽連
  const partialCards = cardsWithApproval(undefined).map((c) =>
    c.id === "card-lin" ? { ...c, approval: { status: "pending" as const } } : c,
  );
  const partial = productionFieldsFromContext([fullShot()], { cards: partialCards, mode: "collaborate" });
  assert.deepEqual(partial.fields["001"].characterCardIds, ["card-chen"]);
  assert.deepEqual(partial.blockedCardIdsByShot?.["001"], ["card-lin"]);
});

test("護城河回歸（最重要）：全自動兩檔＋未給 mode → 未批准卡照進卡引用欄，真門禁 17 門逐項相同", () => {
  const production = {
    "001": {
      sceneId: "S01",
      durationSeconds: 12,
      keyframeId: "kf-1",
      lastFrameId: "lf-1",
      audioAnchorId: "a-1",
      aspectRatio: "9:16",
    },
  };
  // 全部卡都 rejected（最極端）：未給 mode ＝ 既有行為
  const unlockCtx = {
    production,
    cards: cardsWithApproval("rejected"),
    lockedCharacterCardIds: ["card-lin", "card-chen"],
    lockedSceneCardIds: ["card-house"],
    segmentDurationSeconds: 10,
  };
  const baseline = storyboardQcGateArgs([fullShot()], unlockCtx);
  assert.equal(baseline.complete, true, "未給 mode：既有情境仍 complete=true（零回歸）");
  assert.deepEqual(baseline.input.shots[0].characterCardIds, ["card-lin", "card-chen"]);
  const baselineGates = runShortDramaTool("storyboard_qc_17", baseline.input).gates;
  assert.equal(runShortDramaTool("storyboard_qc_17", baseline.input).output.ready, true);

  for (const mode of ["preset", "auto"] as const) {
    const args = storyboardQcGateArgs([fullShot()], { ...unlockCtx, mode });
    assert.deepEqual(args.input.shots, baseline.input.shots, `mode=${mode}：門禁輸入逐位相同`);
    assert.deepEqual(args.missing, baseline.missing, `mode=${mode}：missing 逐項相同`);
    assert.equal(args.complete, true, `mode=${mode}：不得新增任何阻塞`);
    assert.deepEqual(
      runShortDramaTool("storyboard_qc_17", args.input).gates,
      baselineGates,
      `mode=${mode}：真門禁 17 門逐項相同`,
    );
  }

  // 對照組（獨立 oracle）：同一份被駁回的卡，協作檔下真門禁必須翻臉 → 證明閘真的接上了
  const collab = storyboardQcGateArgs([fullShot()], { ...unlockCtx, mode: "collaborate" });
  const collabRun = runShortDramaTool("storyboard_qc_17", collab.input);
  assert.equal(collabRun.output.ready, false, "協作檔＋未批准資產 → 真門禁 block");
  assert.notDeepEqual(collabRun.gates, baselineGates);
});

test("駁回後：已寫進節點 metadata 的舊綁定照樣被擋（閘在生效層，不是事後貼紙）", () => {
  const shotMetadata = { "001": { characterCardIds: ["card-lin"], sceneCardIds: ["card-house"] } };
  const shot = fullShot({ referenceAssets: "" });
  const open = productionFieldsFromContext([shot], { shotMetadata });
  assert.deepEqual(open.fields["001"].characterCardIds, ["card-lin"], "未給 mode：metadata 綁定照常生效（零回歸）");
  const gated = productionFieldsFromContext([shot], {
    shotMetadata,
    cards: [
      { id: "card-lin", name: "林昭_正面", kind: "character", approval: { status: "rejected", reason: "光影不对" } },
      { id: "card-house", name: "旧宅_主视", kind: "scene" },
    ],
    mode: "collaborate",
  });
  assert.equal("characterCardIds" in gated.fields["001"], false, "落卡後才駁回 → 舊綁定不得繼續生效");
  assert.equal(gated.sources["001"].characterCardIds, undefined, "來源審計跡同步清掉（不留「有來源卻無值」）");
  assert.deepEqual(gated.fields["001"].sceneCardIds, ["card-house"], "同鏡已批准的場景卡不受牽連");
  assert.deepEqual(gated.blockedCardIdsByShot?.["001"], ["card-lin"]);
});

test("呼叫端供給的 production 卡 id 同樣過閘（供給不是繞道）", () => {
  const args = storyboardQcGateArgs([fullShot()], {
    production: { "001": { characterCardIds: ["card-lin", "card-chen"] } },
    cards: [
      { id: "card-lin", name: "林昭_正面", kind: "character", approval: { status: "pending" } },
      { id: "card-chen", name: "陈默_正面", kind: "character", approval: { status: "approved" } },
    ],
    mode: "collaborate",
  });
  assert.deepEqual(args.input.shots[0].characterCardIds, ["card-chen"]);
});

test("filterApprovedShotCardIds：非協作檔原樣回傳（含順序與重複項）；查不到的 id 不猜著擋", () => {
  const ids = ["card-b", "card-a", "card-a", "card-unknown"];
  const rejectedA: StoryboardQcCardRef[] = [
    { id: "card-a", name: "a", kind: "character", approval: { status: "rejected", reason: "不对" } },
    { id: "card-b", name: "b", kind: "character" },
  ];
  for (const mode of [undefined, "preset", "auto"] as const) {
    assert.deepEqual(filterApprovedShotCardIds(ids, rejectedA, mode), ids, `mode=${String(mode)} 必須逐位原樣`);
  }
  assert.deepEqual(filterApprovedShotCardIds(ids, rejectedA, "collaborate"), ["card-b", "card-unknown"]);
  // 同 id 多筆且其中有未批准者 → 擋（不能證明已批准的，不當已批准處理）
  const duplicate: StoryboardQcCardRef[] = [
    { id: "card-a", name: "a", kind: "character", approval: { status: "approved" } },
    { id: "card-a", name: "a", kind: "character", approval: { status: "pending" } },
  ];
  assert.deepEqual(filterApprovedShotCardIds(["card-a"], duplicate, "collaborate"), []);
  assert.deepEqual(filterApprovedShotCardIds(undefined, rejectedA, "collaborate"), []);
});

test("分鏡側 approval：供給才出現（同一 shape、reason 原樣讀回），且不得改變 missing（門檻語義零變動）", () => {
  const approval = { status: "pending" as const, decidedAt: "2026-09-24T10:00:00.000Z", reason: "等甲方核對" };
  const withApproval = storyboardQcShots([fullShot()], { "001": { approval } });
  assert.deepEqual(withApproval.shots[0].approval, approval, "與資產側同一個 shape，理由原樣讀回");
  assert.deepEqual(
    withApproval.missing,
    storyboardQcShots([fullShot()], {}).missing,
    "帶 approval 不得改變 missing（分鏡確認不是 QC 門檻欄位）",
  );
  assert.ok(!withApproval.missing.includes("approval"));
  const bare = storyboardQcShots([fullShot()], {});
  assert.equal("approval" in bare.shots[0], false, "未供給 → 不補默認值（既有輸出鍵逐位不變）");
  // 獨立 oracle：真本地門禁對「帶 approval / 不帶 approval」兩形輸入判定逐項相同（未知鍵忽略）
  assert.deepEqual(
    runShortDramaTool("storyboard_qc_17", { shots: withApproval.shots }).gates,
    runShortDramaTool("storyboard_qc_17", { shots: bare.shots }).gates,
    "多帶 approval 鍵不得改變任何一門的判定",
  );
});

// ─────────────────────────────────────────── ⑫ 重跑影響面（純判定）

test("affectedShotNodesByCardIds：只回報真的引用了該批卡的分鏡節點（非分鏡節點/無 id 不回報）", () => {
  const nodes = [
    { id: "shot-1", metadata: { storyboardShot: { shotNumber: "001" }, characterCardIds: ["card-node-a"], sceneCardIds: ["card-node-s"] } },
    { id: "shot-2", metadata: { storyboardShot: { shotNumber: "002" }, characterCardIds: ["card-node-b"] } },
    { id: "asset-a", metadata: { storyboardShot: null, characterCardIds: ["card-node-a"] } },
    { id: "shot-3", metadata: { storyboardShot: { shotNumber: "003" }, characterCardIds: ["card-node-a"] } },
  ];
  const single = affectedShotNodesByCardIds(nodes, ["card-node-a"]);
  assert.deepEqual(single.affectedCardIds, ["card-node-a"]);
  assert.deepEqual(single.shotNodeIds, ["shot-1", "shot-3"], "無鏡號的資產節點不是分鏡節點");

  const batch = affectedShotNodesByCardIds(nodes, ["card-node-a", "card-node-b", "card-node-unused"]);
  assert.deepEqual(batch.affectedCardIds, ["card-node-a", "card-node-b"], "沒被任何鏡引用的卡不回報");
  assert.deepEqual(batch.shotNodeIds, ["shot-1", "shot-2", "shot-3"], "順序＝節點輸入序");
  assert.deepEqual(affectedShotNodesByCardIds(nodes, []), { affectedCardIds: [], shotNodeIds: [] });
  assert.deepEqual(affectedShotNodesByCardIds(nodes, ["  "]), { affectedCardIds: [], shotNodeIds: [] });
  // 節點無 id → 卡仍如實回報，但不得臆造節點 id
  const noId = affectedShotNodesByCardIds([{ metadata: { storyboardShot: { shotNumber: "001" }, characterCardIds: ["card-node-a"] } }], ["card-node-a"]);
  assert.deepEqual(noId, { affectedCardIds: ["card-node-a"], shotNodeIds: [] });
});

// ─────────────────────────────────────────── ⑬ 旁白加成欄位（2026-09-30）

const NARRATION = "第三天清晨，林昭終於推開那扇門。";

test("旁白是加成欄位：供給時原值輸出且不進 missing；未供給時也不進 missing（不罰），門檻結論不變", () => {
  const supplied = storyboardQcShots([fullShot()], { "001": { narration: NARRATION } });
  // 真行為斷言：欄位值真的流到輸出（不是源碼字串斷言）
  assert.equal(supplied.shots[0].narration, NARRATION);
  assert.equal(supplied.missing.includes("narration"), false, "旁白不參與 missing 判定");

  const bare = storyboardQcShots([fullShot()], {});
  // 未供給 → 不補默認值（不冒充用戶設定），且同樣不罰
  assert.equal("narration" in bare.shots[0], false);
  assert.equal(bare.missing.includes("narration"), false);
  // 供給旁白不得改變門檻結論：missing / complete 逐項相同
  assert.deepEqual(bare.missing, supplied.missing);
  assert.equal(bare.complete, supplied.complete);

  // 空值/純空白 → 省略該鍵（本檔既有紀律），且照樣不進 missing
  const hollow = storyboardQcShots([fullShot()], { "001": { narration: "   " } });
  assert.equal("narration" in hollow.shots[0], false);
  assert.equal(hollow.missing.includes("narration"), false);
});

test("旁白來源補記與不推導：供給記 production、未供給不生成，且不從 dialogue 猜", () => {
  const supplied = productionFieldsFromContext([fullShot()], {
    production: { "001": { narration: NARRATION } },
  });
  assert.equal(supplied.fields["001"].narration, NARRATION, "旁白原樣進 fields");
  assert.equal(supplied.sources["001"].narration, "production", "加成欄位也要有審計跡（與 prompt/propCardIds 同範式）");

  const bare = productionFieldsFromContext([fullShot()], { cards: cards() });
  assert.equal(bare.fields["001"].narration, undefined, "無來源則完全不生成該欄");
  assert.equal(bare.sources["001"].narration, undefined);
  // 行為斷言：dialogue 有值也不得憑空生成 narration（從 dialogue 猜旁白＝自造轉換，禁）
  const withDialogue = productionFieldsFromContext([fullShot({ dialogue: "[林昭]：「有人嗎」" })], { cards: cards() });
  assert.equal(withDialogue.fields["001"].narration, undefined);
});

test("行為斷言：多帶 narration 鍵不得改變門禁任何一門的判定（獨立 oracle = 真本地 storyboard_qc_17）", () => {
  const production = {
    "001": { sceneId: "S01", durationSeconds: 3, keyframeId: "kf-1", lastFrameId: "lf-1", audioAnchorId: "a-1", aspectRatio: "9:16" },
  };
  const withNarration = storyboardQcGateArgs([fullShot()], {
    production: { "001": { ...production["001"], narration: NARRATION } },
  });
  const without = storyboardQcGateArgs([fullShot()], { production });
  assert.equal(withNarration.input.shots[0].narration, NARRATION);
  assert.deepEqual(withNarration.missing, without.missing, "旁白是加成欄位：missing 逐項不變");
  assert.equal(withNarration.complete, without.complete);
  assert.deepEqual(
    runShortDramaTool("storyboard_qc_17", withNarration.input).gates,
    runShortDramaTool("storyboard_qc_17", without.input).gates,
    "多帶 narration 鍵不得改變任何一門的判定",
  );
});

// ─────────────────────────────────────────── ⑭ 分鏡節點音軌錨 → 門禁（2026-09-30）

/** 除音軌錨外的成片欄位樣本（音軌錨刻意留給「節點 metadata vs 呼叫端供給」兩路對照）。 */
const ANCHOR_PRODUCTION = {
  "001": {
    sceneId: "S01",
    durationSeconds: 3,
    keyframeId: "kf-1",
    lastFrameId: "lf-1",
    aspectRatio: "9:16",
  },
};

test("閉環（真行為）：節點 audioAnchorId 真餵進門禁 → audio_anchor_present/dialogue_alignment 由 block 轉 pass", () => {
  const project = {
    cardIds: ["card-lin", "card-chen", "card-house"],
    nodes: [shotNode("001", { audioAnchorId: "anchor-from-voiceover" })],
  };
  const { context } = storyboardQcContextFromProject(project, { cards: cards() });
  // 帶入端：逐鏡配音回寫的節點音軌錨真的進 shotMetadata
  assert.equal(context.shotMetadata?.["001"]?.audioAnchorId, "anchor-from-voiceover");

  const args = storyboardQcGateArgs([fullShot()], { ...context, production: ANCHOR_PRODUCTION });
  assert.equal(args.sources["001"].audioAnchorId, "nodeMetadata", "來源審計跡 = 節點 metadata");
  assert.equal(args.input.shots[0].audioAnchorId, "anchor-from-voiceover");
  assert.ok(!args.missing.includes("audioAnchorId"), "節點供給後不得再列 missing");

  const gated = runShortDramaTool("storyboard_qc_17", args.input);
  const byId = new Map(gated.gates.map((g) => [g.id, g]));
  assert.equal(byId.get("audio_anchor_present")?.passed, true, `應 pass（證據：${byId.get("audio_anchor_present")?.detail}）`);
  assert.equal(byId.get("dialogue_alignment")?.passed, true, `應 pass（證據：${byId.get("dialogue_alignment")?.detail}）`);
});

test("反證：拔掉節點音軌錨 → 同一兩門必 block（證明判定真吃了節點音軌，非同源偽證）", () => {
  const stripped = storyboardQcContextFromProject(
    { cardIds: ["card-lin", "card-chen", "card-house"], nodes: [shotNode("001", {})] },
    { cards: cards() },
  );
  const bareArgs = storyboardQcGateArgs([fullShot()], { ...stripped.context, production: ANCHOR_PRODUCTION });
  assert.ok(bareArgs.missing.includes("audioAnchorId"), "無來源必須誠實回報 missing");
  assert.equal(bareArgs.input.shots[0].audioAnchorId, undefined, "不得憑空補值");

  const bare = runShortDramaTool("storyboard_qc_17", bareArgs.input);
  const bareById = new Map(bare.gates.map((g) => [g.id, g]));
  assert.equal(bareById.get("audio_anchor_present")?.passed, false, `拔掉後必 block（證據：${bareById.get("audio_anchor_present")?.detail}）`);
  assert.equal(bareById.get("dialogue_alignment")?.passed, false, `拔掉後必 block（證據：${bareById.get("dialogue_alignment")?.detail}）`);
});

test("優先序：呼叫端明確供給的 audioAnchorId 勝；未供給時才從節點 metadata 拿（⑤ 生效條件）", () => {
  const supplied = storyboardQcGateArgs([fullShot()], {
    production: { "001": { ...ANCHOR_PRODUCTION["001"], audioAnchorId: "anchor-explicit" } },
    shotMetadata: { "001": { audioAnchorId: "anchor-node" } },
  });
  assert.equal(supplied.input.shots[0].audioAnchorId, "anchor-explicit", "metadata 不得覆蓋呼叫端供給");
  assert.equal(supplied.sources["001"].audioAnchorId, "production");

  const fromNode = storyboardQcGateArgs([fullShot()], {
    production: ANCHOR_PRODUCTION,
    shotMetadata: { "001": { audioAnchorId: "anchor-node" } },
  });
  assert.equal(fromNode.input.shots[0].audioAnchorId, "anchor-node");
  assert.equal(fromNode.sources["001"].audioAnchorId, "nodeMetadata");
});

test("節點音軌錨是單值語義（同 size，非卡 id 聯集）：同鏡首個非空勝、矛盾則不給、空值不佔位", () => {
  // 同鏡兩節點矛尖不同 → 整個不給（不取首個猜；仍有該鏡鍵但無值）
  const conflict = storyboardQcContextFromProject({
    nodes: [shotNode("001", { audioAnchorId: "a-1" }), shotNode("001", { audioAnchorId: "a-2" })],
  });
  assert.deepEqual(conflict.context.shotMetadata, { "001": {} });

  // 相同值多節點 + 空/純空白 → 收斂成單一純字串（不是陣列，空值不佔位也不製造矛盾）
  const agree = storyboardQcContextFromProject({
    nodes: [
      shotNode("001", { audioAnchorId: "a-1" }),
      shotNode("001", { audioAnchorId: "a-1" }),
      shotNode("001", { audioAnchorId: "   " }),
    ],
  });
  assert.deepEqual(agree.context.shotMetadata, { "001": { audioAnchorId: "a-1" } });

  // 非字串 / 無鏡號 → 不臆造
  const dirty = storyboardQcContextFromProject({
    nodes: [shotNode("002", { audioAnchorId: 123 }), { metadata: { audioAnchorId: "a-ghost" } }],
  });
  assert.equal(dirty.context.shotMetadata, undefined);
});
