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
  normalizeStoryboardSceneRef,
  normalizeStoryboardShots,
  normalizeStoryboardShot,
  parseReferenceAssets,
  storyboardQcShots,
  type StoryboardScriptShot,
} from "./storyboard-contract";
import { compactMetadataForAgent } from "@/hooks/canvas/canvas-chat-types";
import { toNodeMetadata } from "./canvas/layout";

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
