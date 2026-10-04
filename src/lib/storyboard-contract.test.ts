// 分镜 21 栏契约测试（2026-09-15 刀 2）。
// 两层钉死：
//   ① 契约层——21 栏名称与顺序逐字等于 AID `doc/提示词开发指南.md` 输出栏位表，
//      且**不含**已废的 sceneCode（AID v2.1.4 §开发要点 5）。
//   ② 通道层——往复合同：压缩（compactMetadataForAgent）→ 还原（toNodeMetadata）
//      后 21 栏仍在（照 canvas-chat-types.test.ts 的 director/sceneCard 范式）。
//      这层是 2026-09-03「刷新后空壳」事故的同型防线：双白名单漏一端即红。
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

/** 照 AID 契约顺序的全形 21 栏样本。 */
function fullShot(overrides: Partial<StoryboardScriptShot> = {}): StoryboardScriptShot {
  return {
    shotNumber: "001",
    scriptContent: "林昭推开门，屋内空无一人。",
    visualDescription: "中景，林昭推门而入，晨光斜切过地板。",
    dialogue: "[林昭]：「有人吗」",
    actionState: "林昭推门、环视",
    narrativeFunction: "建立空间与悬念",
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

// ─────────────────────────────────────────── ① 契约层

test("21 栏名称与顺序逐字等于 AID 契约（shotNumber…soundEffect）", () => {
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

test("契约不含已废的 sceneCode（AID v2.1.4 §开发要点 5）", () => {
  assert.equal((STORYBOARD_SHOT_FIELDS as readonly string[]).includes("sceneCode"), false);
});

test("normalizeStoryboardShot：全形样本逐栏原样存活且 key 顺序 = 契约顺序", () => {
  const shot = normalizeStoryboardShot(fullShot());
  assert.ok(shot);
  assert.deepEqual(shot, fullShot());
  assert.deepEqual(Object.keys(shot), [...STORYBOARD_SHOT_FIELDS]);
});

test("normalizeStoryboardShot：非字串栏位一律收敛成 \"\"（AID 空值规则，不写 null/「无」）", () => {
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
    assert.equal(shot[field], "", `${field} 应收敛成空字串`);
  }
});

test("normalizeStoryboardShot：未知栏位丢弃（白名单，不夹带 sceneCode）", () => {
  const shot = normalizeStoryboardShot({ shotNumber: "002", sceneCode: "S03", image_prompt: "x" });
  assert.ok(shot);
  assert.equal(Object.prototype.hasOwnProperty.call(shot, "sceneCode"), false);
  assert.equal(Object.prototype.hasOwnProperty.call(shot, "image_prompt"), false);
  assert.deepEqual(Object.keys(shot), [...STORYBOARD_SHOT_FIELDS]);
});

test("normalizeStoryboardShot：shotNumber 空/非字串 → null（整包丢弃，不制造无镜号分镜）", () => {
  assert.equal(normalizeStoryboardShot({ shotNumber: "", scriptContent: "x" }), null);
  assert.equal(normalizeStoryboardShot({ shotNumber: "   ", scriptContent: "x" }), null);
  assert.equal(normalizeStoryboardShot({ shotNumber: 1, scriptContent: "x" }), null);
  assert.equal(normalizeStoryboardShot({ scriptContent: "x" }), null);
  assert.equal(normalizeStoryboardShot(null), null);
  assert.equal(normalizeStoryboardShot("001"), null);
  assert.equal(normalizeStoryboardShot([]), null);
});

test("normalizeStoryboardShot：shotNumber 规范化（trim + 上限 16 字），其余栏逐字保留不 trim", () => {
  const shot = normalizeStoryboardShot({ shotNumber: "  001  ", scriptContent: "  原文含缩排  " });
  assert.ok(shot);
  assert.equal(shot.shotNumber, "001");
  assert.equal(shot.scriptContent, "  原文含缩排  ");
});

test("normalizeStoryboardShot：超长栏截 MAX_STORYBOARD_FIELD_CHARS，不触发者不动", () => {
  const long = "字".repeat(MAX_STORYBOARD_FIELD_CHARS + 10);
  const shot = normalizeStoryboardShot({ shotNumber: "001", scriptContent: long });
  assert.ok(shot);
  assert.equal(shot.scriptContent.length, MAX_STORYBOARD_FIELD_CHARS);
});

test("normalizeStoryboardShots：逐项清洗，非法项丢弃，合法项保序", () => {
  const shots = normalizeStoryboardShots([
    fullShot({ shotNumber: "001" }),
    { scriptContent: "无镜号" },
    fullShot({ shotNumber: "002" }),
    null,
  ]);
  assert.ok(shots);
  assert.deepEqual(shots.map((s) => s.shotNumber), ["001", "002"]);
  assert.equal(normalizeStoryboardShots({ shots: [] }), null);
});

test("normalizeStoryboardSceneRef：sceneName 非空才成立；shotCount 非负整数否则 0", () => {
  assert.deepEqual(normalizeStoryboardSceneRef({ sceneName: "旧宅", shotCount: 3 }), { sceneName: "旧宅", shotCount: 3 });
  assert.deepEqual(normalizeStoryboardSceneRef({ sceneName: " 旧宅 " }), { sceneName: "旧宅", shotCount: 0 });
  assert.equal(normalizeStoryboardSceneRef({ sceneName: "" }), null);
  assert.equal(normalizeStoryboardSceneRef({ sceneName: "  " }), null);
  assert.deepEqual(normalizeStoryboardSceneRef({ sceneName: "旧宅", shotCount: -1 }), { sceneName: "旧宅", shotCount: 0 });
  assert.deepEqual(normalizeStoryboardSceneRef({ sceneName: "旧宅", shotCount: 2.7 }), { sceneName: "旧宅", shotCount: 2 });
  assert.equal(normalizeStoryboardSceneRef(null), null);
});

// ─────────────────────────────────────────── referenceAssets 解析

test("parseReferenceAssets：三标签分组解析（含 en-dash 分隔与多角色）", () => {
  assert.deepEqual(parseReferenceAssets("场景:[旧宅_主视] 角色:[林昭_正面]、[陈默_正面] 道具:[铜钥匙]"), {
    scene: ["旧宅_主视"],
    character: ["林昭_正面", "陈默_正面"],
    prop: ["铜钥匙"],
  });
});

test("parseReferenceAssets：空字串/无标签 → 三空阵列（不抛错）", () => {
  assert.deepEqual(parseReferenceAssets(""), { scene: [], character: [], prop: [] });
  assert.deepEqual(parseReferenceAssets("角色:[林昭_正面]"), { scene: [], character: ["林昭_正面"], prop: [] });
  assert.deepEqual(parseReferenceAssets("纯文字无标签"), { scene: [], character: [], prop: [] });
});

// ─────────────────────────────────────────── ② 通道层（往复合同）

test("storyboardShot 压缩保留 21 栏（含空字串栏位），短值不截断", () => {
  const compacted = compactMetadataForAgent({ storyboardShot: fullShot() });
  assert.ok(compacted);
  assert.deepEqual(compacted.storyboardShot, fullShot());
  assert.deepEqual(Object.keys(compacted.storyboardShot as object), [...STORYBOARD_SHOT_FIELDS]);
});

test("storyboardScene 压缩透传（sceneName 是场景归属唯一权威）", () => {
  const compacted = compactMetadataForAgent({ storyboardScene: { sceneName: "旧宅", shotCount: 4 } });
  assert.deepEqual(compacted?.storyboardScene, { sceneName: "旧宅", shotCount: 4 });
});

test("压缩输出经还原端 toNodeMetadata 后 21 栏仍在（往复合同，刷新/换装置不空壳）", () => {
  const meta = { storyboardShot: fullShot(), storyboardScene: { sceneName: "旧宅", shotCount: 1 } };
  const restored = toNodeMetadata(compactMetadataForAgent(meta));
  assert.deepEqual(restored.storyboardShot, fullShot());
  assert.deepEqual(Object.keys(restored.storyboardShot as object), [...STORYBOARD_SHOT_FIELDS]);
  assert.deepEqual(restored.storyboardScene, { sceneName: "旧宅", shotCount: 1 });
});

test("往复合同：空字串栏位不被当成缺失（AID 空值规则穿过双白名单）", () => {
  const shot = fullShot({ dialogue: "", actionState: "", soundEffect: "" });
  const restored = toNodeMetadata(compactMetadataForAgent({ storyboardShot: shot }));
  assert.ok(restored.storyboardShot);
  assert.equal(restored.storyboardShot.dialogue, "");
  assert.equal(restored.storyboardShot.actionState, "");
  assert.equal(restored.storyboardShot.soundEffect, "");
  assert.deepEqual(restored.storyboardShot, shot);
});

test("压缩端逐栏截 STORYBOARD_SNAPSHOT_FIELD_CHARS，还原端再过一次契约清洗", () => {
  const long = "字".repeat(STORYBOARD_SNAPSHOT_FIELD_CHARS + 500);
  const compacted = compactStoryboardShot(fullShot({ scriptContent: long }));
  assert.equal(compacted.scriptContent.length, STORYBOARD_SNAPSHOT_FIELD_CHARS);
  const restored = toNodeMetadata(compactMetadataForAgent({ storyboardShot: compacted }));
  assert.equal(restored.storyboardShot?.scriptContent.length, STORYBOARD_SNAPSHOT_FIELD_CHARS);
  // 其余 20 栏不受影响
  assert.equal(restored.storyboardShot?.shotNumber, "001");
  assert.equal(restored.storyboardShot?.shotSize, "中景");
});

test("还原端非契约形状整包丢弃（无 shotNumber）", () => {
  const restored = toNodeMetadata({ storyboardShot: { scriptContent: "残形无镜号" } });
  assert.equal(restored.storyboardShot, undefined);
  assert.equal(toNodeMetadata({ storyboardScene: { shotCount: 3 } }).storyboardScene, undefined);
});

test("非分镜节点不受影响：无 storyboard 栏位不外传空壳", () => {
  const compacted = compactMetadataForAgent({ content: "hello" });
  assert.deepEqual(compacted, { content: "hello" });
});

test("不与 sceneCard 互相污染：同节点两族并存各自存活", () => {
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

// ─────────────────────────────────────────── ③ 门禁输入桥接

test("storyboardQcShots：栏名映射 shotNumber→shotId、序→order、prompt←visualDescription", () => {
  const { shots, missing, complete } = storyboardQcShots([fullShot({ shotNumber: "001" }), fullShot({ shotNumber: "002" })]);
  assert.deepEqual(shots.map((s) => s.shotId), ["001", "002"]);
  assert.deepEqual(shots.map((s) => s.order), [1, 2]);
  assert.equal(shots[0].prompt, fullShot().visualDescription);
  // 成片阶段栏位 21 栏供不了 → 诚实列 missing、complete=false（不补假值）
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

test("storyboardQcShots：production 补齐成片栏位后 complete=true", () => {
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
    // 道具是加成栏位（不在 QC_REQUIRED_FIELDS）：未供给时输出空阵列、且不影响 complete。
    propCardIds: [],
    keyframeId: "kf-1",
    lastFrameId: "lf-1",
    audioAnchorId: "au-1",
    aspectRatio: "9:16",
  });
});

test("storyboardQcShots：production.prompt 覆盖 visualDescription；空 shots → complete=false", () => {
  const { shots } = storyboardQcShots([fullShot()], { "001": { prompt: "画师 prompt" } });
  assert.equal(shots[0].prompt, "画师 prompt");
  assert.equal(storyboardQcShots([]).complete, false);
  assert.deepEqual(storyboardQcShots([]).shots, []);
});

// ─────────────────────────────────────────── ④ 上下文 → 成片栏位（G5 合法推导）

/** 卡实体最小样本（形状同 character-cards.ts:38-54，只取解析需要的三栏）。 */
function cards(): StoryboardQcCardRef[] {
  return [
    { id: "card-lin", name: "林昭_正面", kind: "character" },
    { id: "card-chen", name: "陈默_正面", kind: "character" },
    { id: "card-house", name: "旧宅_主视", kind: "scene" },
  ];
}

test("indexCardsByName：同名同 kind 歧义整批排除（不取首个，避免猜）", () => {
  const index = indexCardsByName([
    { id: "a", name: "林昭", kind: "character" },
    { id: "b", name: "林昭", kind: "character" },
    { id: "c", name: "旧宅", kind: "scene" },
  ]);
  assert.equal(index.character.get("林昭"), undefined);
  assert.equal(index.scene.get("旧宅"), "c");
});

test("indexCardsByName：同名不同 kind 互不干扰；空/非字串栏位跳过", () => {
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

test("resolveReferenceAssetsToCardIds：名称逐字命中 → 卡 id；道具段无门禁栏位 → 原样回报不静默丢", () => {
  const r = resolveReferenceAssetsToCardIds(fullShot().referenceAssets, cards());
  assert.deepEqual(r.characterCardIds, ["card-lin", "card-chen"]);
  assert.deepEqual(r.sceneCardIds, ["card-house"]);
  assert.deepEqual(r.unresolvedProps, ["铜钥匙"]);
  assert.deepEqual(r.unresolvedCharacters, []);
  assert.deepEqual(r.unresolvedScenes, []);
});

test("resolveReferenceAssetsToCardIds：名称未命中/空输入 → 不臆造 id（留 unresolved/空阵列）", () => {
  const r = resolveReferenceAssetsToCardIds("场景:[不存在的场景] 角色:[不存在的人]", cards());
  assert.deepEqual(r.characterCardIds, []);
  assert.deepEqual(r.sceneCardIds, []);
  assert.deepEqual(r.unresolvedCharacters, ["不存在的人"]);
  assert.deepEqual(r.unresolvedScenes, ["不存在的场景"]);
  const empty = resolveReferenceAssetsToCardIds("", cards());
  assert.deepEqual(empty.characterCardIds, []);
  assert.deepEqual(empty.sceneCardIds, []);
  // 卡清单为空（未载入）→ 一样不臆造
  const noCards = resolveReferenceAssetsToCardIds(fullShot().referenceAssets, []);
  assert.deepEqual(noCards.characterCardIds, []);
  assert.deepEqual(noCards.sceneCardIds, []);
});

test("productionFieldsFromContext：有来源才生成——卡名解析 + 节点 ratio，逐条记来源", () => {
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

test("productionFieldsFromContext：**无来源则完全不生成该栏**（不补默认值：无 duration/sceneId/keyframe）", () => {
  const { fields, sources } = productionFieldsFromContext([fullShot()], { cards: cards() });
  const f = fields["001"];
  // 三条推导中只有两条卡 id 成立（无 shotMetadata → 无 ratio）
  assert.equal(f.aspectRatio, undefined);
  assert.equal(sources["001"].aspectRatio, undefined);
  // 四个本 repo 无生产者的栏位：不得凭空出现
  assert.equal(f.durationSeconds, undefined);
  assert.equal(f.sceneId, undefined);
  assert.equal(f.keyframeId, undefined);
  assert.equal(f.lastFrameId, undefined);
  assert.equal(f.audioAnchorId, undefined);
  // 节点 ratio 只有「已是 ratio 形状」才收——像素尺寸不做换算、不猜默认
  const px = productionFieldsFromContext([fullShot()], { shotMetadata: { "001": { size: "1024x1792" } } });
  assert.equal(px.fields["001"].aspectRatio, undefined);
  assert.equal(px.sources["001"].aspectRatio, undefined);
});

test("productionFieldsFromContext：呼叫端已供给者不被推导覆盖（production 优先）", () => {
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

test("storyboardQcGateArgs：全齐 → complete=true 且两形 args 可直接喂门禁", () => {
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

test("storyboardQcGateArgs：**无来源 → 进 missing 且不凭空产生值**（最重要断言）", () => {
  const args = storyboardQcGateArgs([fullShot()], { cards: cards() });
  assert.equal(args.complete, false);
  // 只由 referenceAssets 推导出两条 → 其余全在 missing（含场景/时长/帧/锚点/比例）
  for (const field of ["sceneId", "durationSeconds", "keyframeId", "lastFrameId", "audioAnchorId", "aspectRatio"]) {
    assert.ok(args.missing.includes(field), `${field} 应在 missing`);
  }
  // 门禁层输入同样诚实回报（缺锁定 id → character_lock/scene_lock 必 block；缺段长 → segment_duration 必 block）
  assert.ok(args.missing.includes("lockedCharacterCardIds"));
  assert.ok(args.missing.includes("lockedSceneCardIds"));
  assert.ok(args.missing.includes("segmentDurationSeconds"));
  // 不含任何推导不到的栏位，且没有补假值
  assert.deepEqual(Object.keys(args.input.shots[0]).sort(), ["characterCardIds", "order", "prompt", "propCardIds", "sceneCardIds", "shotId"]);
  assert.equal(args.input.shots[0].durationSeconds, undefined);
  assert.equal(args.input.shots[0].sceneId, undefined);
  assert.equal(args.input.shots[0].keyframeId, undefined);
  assert.equal(args.input.shots[0].aspectRatio, undefined);
  assert.equal(Object.prototype.hasOwnProperty.call(args.toolArgs, "segment_duration_seconds"), false);
  assert.equal(Object.prototype.hasOwnProperty.call(args.toolArgs, "locked_character_card_ids"), false);
});

test("storyboardQcGateArgs：缺专案/缺卡/空阵列的边界（不抛错、不臆造）", () => {
  // 无 context
  const bare = storyboardQcGateArgs([fullShot()]);
  assert.equal(bare.complete, false);
  assert.equal(bare.input.shots[0].characterCardIds.length, 0);
  assert.equal(bare.input.shots[0].sceneCardIds.length, 0);
  // 空 shots → complete=false
  assert.equal(storyboardQcGateArgs([]).complete, false);
  assert.deepEqual(storyboardQcGateArgs([]).input.shots, []);
  // 锁定 id 传空阵列 = 未供给（不是「锁了 0 张」）
  const emptyLocks = storyboardQcGateArgs([fullShot()], { lockedCharacterCardIds: [], lockedSceneCardIds: [] });
  assert.ok(emptyLocks.missing.includes("lockedCharacterCardIds"));
  assert.ok(emptyLocks.missing.includes("lockedSceneCardIds"));
  // segmentDurationSeconds=0/NaN 亦视同未供给（门禁 segment_duration 要求 >0）
  assert.ok(storyboardQcGateArgs([fullShot()], { segmentDurationSeconds: 0 }).missing.includes("segmentDurationSeconds"));
  assert.ok(storyboardQcGateArgs([fullShot()], { segmentDurationSeconds: Number.NaN }).missing.includes("segmentDurationSeconds"));
  // production 缺该镜条目 → 不炸
  const noEntry = storyboardQcGateArgs([fullShot({ shotNumber: "002" })], { production: { "001": {} } });
  assert.equal(noEntry.input.shots[0].shotId, "002");
});

// ─────────────────────────────────────────── ⑤ 端到端：推导结果真喂本地门禁判定

test("端到端：推导后的输入喂 storyboardQc()，门禁确实收到推导出的卡 id（不是空集合）", () => {
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
  // 卡 id 全部由 referenceAssets 名称解析而来（非呼叫端手填）
  assert.deepEqual(args.sources["001"].characterCardIds, "referenceAssets");
  assert.deepEqual(args.input.shots[0].characterCardIds, ["card-lin", "card-chen"]);

  const result = runShortDramaTool("storyboard_qc_17", args.input);
  const gates = result.gates;
  assert.equal(gates.length, 17);
  const byId = new Map(gates.map((g) => [g.id, g]));
  // 推导真送到门禁：characters_bound / scenes_bound / character_lock / scene_lock 全 pass
  for (const id of ["characters_bound", "scenes_bound", "character_lock", "scene_lock", "shot_identity", "shot_order", "prompt_present", "duration_bounds", "scene_binding", "aspect_ratio"]) {
    assert.equal(byId.get(id)?.passed, true, `${id} 应 pass（证据：${byId.get(id)?.detail}）`);
  }
  // 未供给的栏位仍 block（诚实：不因推导两栏就宣称全数达标）
  assert.equal(byId.get("keyframe_present")?.passed, true);
  assert.equal(result.status, "succeeded");
  assert.equal(result.output.ready, true);
});

test("端到端（负向）：只推导得出卡 id 时门禁仍 block，且 block 的正是无来源的门", () => {
  const args = storyboardQcGateArgs([fullShot()], { cards: cards() });
  const result = runShortDramaTool("storyboard_qc_17", args.input);
  const gates = result.gates;
  assert.equal(gates.length, 17);
  const blocked = gates.filter((g) => !g.passed).map((g) => g.id);
  // 有来源的两门 pass
  for (const id of ["characters_bound", "scenes_bound"]) assert.ok(!blocked.includes(id), `${id} 不应 block`);
  // 无来源的门如实 block（不被补假值骗过）
  for (const id of ["scene_binding", "keyframe_present", "last_frame_present", "audio_anchor_present", "aspect_ratio", "segment_duration"]) {
    assert.ok(blocked.includes(id), `${id} 应 block`);
  }
  assert.equal(result.status, "blocked");
  assert.equal(result.output.ready, false);
  assert.equal(blocked.length, 17 - gates.filter((g) => g.passed).length);
});

// ─────────────────────────────────────────── ⑥ 空值是「没有值」不是「有值」（09-17 缺陷回归钉）

test("空值不得算已供给：\"\" / NaN 进 missing 且不送进门禁（防「桥接说 complete、门禁实际 block」）", () => {
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
  // 空字串/纯空白/NaN/空卡 id 全部如实列 missing
  for (const field of ["sceneId", "keyframeId", "aspectRatio", "durationSeconds", "characterCardIds", "sceneCardIds"]) {
    assert.ok(r.missing.includes(field), `${field} 空值应进 missing`);
  }
  // 真有值的两栏不算 missing
  assert.ok(!r.missing.includes("lastFrameId"));
  assert.ok(!r.missing.includes("audioAnchorId"));
  // 空值不得被「补」成门禁看得懂的形：键要嘛不出现、要嘛是空阵列（门禁一律视为缺）
  assert.equal(r.complete, false);
  assert.equal(Object.prototype.hasOwnProperty.call(r.shots[0], "sceneId"), false);
  assert.equal(Object.prototype.hasOwnProperty.call(r.shots[0], "keyframeId"), false);
  assert.equal(Object.prototype.hasOwnProperty.call(r.shots[0], "aspectRatio"), false);
  assert.equal(Object.prototype.hasOwnProperty.call(r.shots[0], "durationSeconds"), false);
  assert.deepEqual(r.shots[0].characterCardIds, []);
  assert.deepEqual(r.shots[0].sceneCardIds, []);
  // 逐字喂本地门禁：未被空值骗过，该 block 的门如实 block
  const result = runShortDramaTool("storyboard_qc_17", {
    shots: r.shots,
    lockedCharacterCardIds: ["card-lin", "card-chen"],
    lockedSceneCardIds: ["card-house"],
    segmentDurationSeconds: 10,
  });
  const blocked = result.gates.filter((g) => !g.passed).map((g) => g.id);
  for (const id of ["scene_binding", "keyframe_present", "aspect_ratio", "duration_bounds", "characters_bound"]) {
    assert.ok(blocked.includes(id), `${id} 应 block（空值不是值）`);
  }
  assert.equal(result.output.ready, false);
});

test("空值路径与 null 路径一致：缺栏、undefined、null、\"\"、NaN 全数等价进 missing", () => {
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
    assert.deepEqual([...r.missing].sort(), [...expected].sort(), `变体 ${JSON.stringify(v)} 的 missing 应一致`);
    assert.equal(r.complete, false);
  }
});

// ─────────────────────────────────────────── ⑦ 专案上下文接线（G5 ③）

test("storyboardQcContextFromProject：project.cardIds 按 kind 分流成两个锁定集合，未解析者如实回报", () => {
  const { context, unresolvedCardIds } = storyboardQcContextFromProject(
    { cardIds: ["card-lin", "card-chen", "card-house", "ghost-card", "card-style"] },
    { cards: [...cards(), { id: "card-style", name: "冷调", kind: "style" }] },
  );
  assert.deepEqual(context.lockedCharacterCardIds, ["card-lin", "card-chen"]);
  assert.deepEqual(context.lockedSceneCardIds, ["card-house"]);
  // style 卡不属门禁两集（Shot 无 styleCardIds）→ 不算未解析；查不到的 id 才回报
  assert.deepEqual(unresolvedCardIds, ["ghost-card"]);
  assert.deepEqual(context.cards?.length, 4);
});

test("storyboardQcContextFromProject：缺专案/缺卡清单/空阵列 → 不臆造锁定集合（全数未解析）", () => {
  // 无专案
  const none = storyboardQcContextFromProject();
  assert.equal(none.context.lockedCharacterCardIds, undefined);
  assert.equal(none.context.lockedSceneCardIds, undefined);
  assert.deepEqual(none.unresolvedCardIds, []);
  // 有 cardIds 但无卡清单（卡未载入）→ 全部未解析，绝不两集合都塞
  const noCards = storyboardQcContextFromProject({ cardIds: ["card-lin", "card-house"] });
  assert.equal(noCards.context.lockedCharacterCardIds, undefined);
  assert.equal(noCards.context.lockedSceneCardIds, undefined);
  assert.deepEqual(noCards.unresolvedCardIds, ["card-lin", "card-house"]);
  // 空 cardIds / 空字串项 → 无锁定、无未解析
  const emptyIds = storyboardQcContextFromProject({ cardIds: ["", "   "] }, { cards: cards() });
  assert.equal(emptyIds.context.lockedCharacterCardIds, undefined);
  assert.deepEqual(emptyIds.unresolvedCardIds, []);
  // 同 id 撞 kind（歧义）→ 不猜，列未解析
  const ambiguous = storyboardQcContextFromProject(
    { cardIds: ["dup"] },
    { cards: [{ id: "dup", name: "x", kind: "character" }, { id: "dup", name: "y", kind: "scene" }] },
  );
  assert.equal(ambiguous.context.lockedCharacterCardIds, undefined);
  assert.equal(ambiguous.context.lockedSceneCardIds, undefined);
  assert.deepEqual(ambiguous.unresolvedCardIds, ["dup"]);
});

test("storyboardQcContextFromProject：节点 size 只在有 shotNumber 时归属该镜；同镜矛盾则不给比例", () => {
  const { context } = storyboardQcContextFromProject({
    nodes: [
      { metadata: { size: "9:16", storyboardShot: { shotNumber: "001" } } },
      { metadata: { size: "16:9" } }, // 无镜号 → 不归属任一镜
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

test("端到端（专案接线）：专案锁定卡 + 节点比例经接线真送进门禁（character_lock/scene_lock/aspect_ratio 不因缺输入而 block）", () => {
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
  // 比例由节点推得、卡 id 由 referenceAssets 解析、锁定集合由专案分流
  assert.equal(args.sources["001"].aspectRatio, "nodeSize");
  assert.equal(args.sources["001"].characterCardIds, "referenceAssets");
  assert.deepEqual(args.input.lockedCharacterCardIds, ["card-lin", "card-chen"]);
  assert.deepEqual(args.input.lockedSceneCardIds, ["card-house"]);
  const result = runShortDramaTool("storyboard_qc_17", args.input);
  const byId = new Map(result.gates.map((g) => [g.id, g]));
  for (const id of ["shot_identity", "shot_order", "scene_binding", "duration_bounds", "prompt_present", "characters_bound", "scenes_bound", "character_lock", "scene_lock", "keyframe_present", "last_frame_present", "audio_anchor_present", "aspect_ratio", "dialogue_alignment", "continuity", "export_readiness"]) {
    assert.equal(byId.get(id)?.passed, true, `${id} 应 pass（证据：${byId.get(id)?.detail}）`);
  }
  // segment_duration 仍如实 block（本接线没有段长来源，不补假值）
  assert.equal(byId.get("segment_duration")?.passed, false);
  assert.ok(args.missing.includes("segmentDurationSeconds"));
});

// ─────────────────────────────────────────── ⑧ REQ-B2-2 生成卡注入的作用域裁决

/** proj-a 的角色卡 + 一张个人卡（两态：项目归属 / personal）。 */
const scopedCards: StoryboardQcCardRef[] = [
  { id: "card-in-a", name: "项目A角色", kind: "character", scope: { owner: "project", projectId: "proj-a" } },
  { id: "card-personal", name: "个人卡", kind: "character" },
];
const scopedProject = { cardIds: ["card-in-a", "card-personal"] };

test("B2-2 生成卡注入：跨项目未分享的卡不得进锁定集合（个人卡零回归、未给上下文逐位不变）", () => {
  // 未给 scope 上下文 → 既有行为逐位不变（零回归：既有呼叫端不受影响）。
  const legacy = storyboardQcContextFromProject(scopedProject, { cards: scopedCards });
  assert.deepEqual(legacy.context.lockedCharacterCardIds, ["card-in-a", "card-personal"]);
  assert.deepEqual(legacy.outOfScopeCardIds, []);
  assert.equal(legacy.context.cards?.length, 2);

  // proj-b：proj-a 的卡不可用 → 不进锁定集合，如实回报；个人卡照用。
  const inB = storyboardQcContextFromProject(scopedProject, {
    cards: scopedCards,
    scope: { viewerUserId: 42, projectId: "proj-b", shares: [] },
  });
  assert.deepEqual(inB.context.lockedCharacterCardIds, ["card-personal"]);
  assert.deepEqual(inB.outOfScopeCardIds, ["card-in-a"]);
  assert.deepEqual(inB.unresolvedCardIds, [], "被作用域拒掉的卡不是『查不到实体』（两态分开）");
  assert.deepEqual(inB.context.cards?.map((c) => c.id), ["card-personal"], "注入上下文不得夹带不可见的卡实体");

  // proj-a：本项目 → 可用（不是无条件拒绝）。
  const inA = storyboardQcContextFromProject(scopedProject, {
    cards: scopedCards,
    scope: { viewerUserId: 42, projectId: "proj-a", shares: [] },
  });
  assert.deepEqual(inA.context.lockedCharacterCardIds, ["card-in-a", "card-personal"]);
  assert.deepEqual(inA.outOfScopeCardIds, []);

  // 无项目上下文（null）→ 项目归属的卡不可用，个人卡照用。
  const noCtx = storyboardQcContextFromProject(scopedProject, {
    cards: scopedCards,
    scope: { viewerUserId: 42, projectId: null, shares: [] },
  });
  assert.deepEqual(noCtx.context.lockedCharacterCardIds, ["card-personal"]);
  assert.deepEqual(noCtx.outOfScopeCardIds, ["card-in-a"]);
});

test("B2-2 生成卡注入：显式分享后跨项目可用；撤销后回到不可用", () => {
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

  // 撤销后立刻回到不可用（记录留痕不删）。
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

  // 跨 owner：本函式的卡清单一律视为「呼叫者自己的卡」（真源 listCharacterCards(userId)），
  // 故跨 owner 的裁决不在本纯函式内——由使用路径的 store 层负责
  // （见 asset-library 的 isAssetUsable / filterCardIdsForProject 的跨 owner 断言）。
  // 这里只钉住「不可见即不可用」在本函式的落点：卡的 ownerUserId 只能是呼叫者。
  const emptyCards = storyboardQcContextFromProject(
    { cardIds: ["card-in-a"] },
    { cards: [], scope: { viewerUserId: 42, projectId: "proj-a", shares: [] } },
  );
  assert.deepEqual(emptyCards.unresolvedCardIds, ["card-in-a"], "无卡实体仍走『不猜』路径");
});

// ─────────────────────────────────────────── ⑨ 道具卡解析链（2026-09-24：道具不再只是自由文字）

/** 道具卡名（含歧义/未命中对照）。 */
const PROP_NAME = "授权让读书";

/** 既有卡清单 + 一张 `kind==="prop"` 的道具卡（`kind` 在本档是 `string`，不 import WS1 的 union）。 */
function cardsWithProp(): StoryboardQcCardRef[] {
  return [...cards(), { id: "card-prop-book", name: PROP_NAME, kind: "prop" }];
}

/** 去掉 `propCardIds` 键的 shots（供「门禁判定不因道具而变」的对照组）。 */
function withoutPropKey(shots: StoryboardQcShot[]): StoryboardQcShot[] {
  return shots.map((shot) => {
    const copy: Record<string, unknown> = { ...shot };
    delete copy.propCardIds;
    return copy as unknown as StoryboardQcShot;
  });
}

test("道具解析：名称逐字命中 kind===\"prop\" 卡 → propCardIds 含该 id；未命中 → unresolvedProps 含该名", () => {
  const hit = resolveReferenceAssetsToCardIds(`道具:[${PROP_NAME}]`, cardsWithProp());
  assert.deepEqual(hit.propCardIds, ["card-prop-book"]);
  assert.deepEqual(hit.unresolvedProps, []);

  const miss = resolveReferenceAssetsToCardIds("道具:[不存在的道具]", cardsWithProp());
  assert.deepEqual(miss.propCardIds, []);
  assert.deepEqual(miss.unresolvedProps, ["不存在的道具"]);

  // 卡清单未载入（空）→ 一样不臆造 id
  const noCards = resolveReferenceAssetsToCardIds(`道具:[${PROP_NAME}]`, []);
  assert.deepEqual(noCards.propCardIds, []);
  assert.deepEqual(noCards.unresolvedProps, [PROP_NAME]);
});

test("道具解析沿用同一套尺：同名不同 kind 不解析、同名同 kind 歧义整批排除、style 卡不进 prop 表", () => {
  // 名字对但 kind 不是 prop（character / style）→ 不解析（同 kind 才算）
  const otherKind = resolveReferenceAssetsToCardIds(`道具:[${PROP_NAME}]`, [
    { id: "card-char-same", name: PROP_NAME, kind: "character" },
    { id: "card-style-same", name: PROP_NAME, kind: "style" },
  ]);
  assert.deepEqual(otherKind.propCardIds, []);
  assert.deepEqual(otherKind.unresolvedProps, [PROP_NAME]);

  // 同名同 kind 两张 → 整批排除（与角色/场景用同一条规则，不为道具另立）
  const dup = resolveReferenceAssetsToCardIds(`道具:[${PROP_NAME}]`, [
    { id: "p1", name: PROP_NAME, kind: "prop" },
    { id: "p2", name: PROP_NAME, kind: "prop" },
  ]);
  assert.deepEqual(dup.propCardIds, []);
  assert.deepEqual(dup.unresolvedProps, [PROP_NAME]);

  // 三族索引互不干扰：prop 表只收 prop 卡，别族的卡不会从 prop 表被捞出来
  const index = indexCardsByName(cardsWithProp());
  assert.equal(index.prop.get(PROP_NAME), "card-prop-book");
  assert.equal(index.character.get(PROP_NAME), undefined);
  assert.equal(index.prop.get("林昭_正面"), undefined);
  assert.equal(index.prop.size, 1);
});

test("禁区 B：qcShots 的 missing 永不含 propCardIds（道具是加成栏位，不是门槛栏位）", () => {
  // 完全没有道具引用
  const bare = storyboardQcShots([fullShot()]);
  assert.equal(bare.missing.includes("propCardIds"), false);
  assert.deepEqual(bare.shots[0].propCardIds, []);

  // 引用了解析不到的道具（未命中）→ 照样不得进 missing
  const unresolvedOnly = storyboardQcShots([fullShot({ referenceAssets: "道具:[不存在的道具]" })]);
  assert.equal(unresolvedOnly.missing.includes("propCardIds"), false);
  assert.deepEqual(unresolvedOnly.shots[0].propCardIds, []);

  // 有道具卡 id 时照样输出该栏（与另两个卡 id 阵列同构），也不进 missing
  const withProp = storyboardQcShots([fullShot()], { "001": { propCardIds: ["card-prop-book"] } });
  assert.deepEqual(withProp.shots[0].propCardIds, ["card-prop-book"]);
  assert.equal(withProp.missing.includes("propCardIds"), false);

  // 空值道具 id 逐项过滤（门禁 strArr 只认非空字串），同样不算缺
  const hollowProp = storyboardQcShots([fullShot()], { "001": { propCardIds: ["", "   "] } });
  assert.deepEqual(hollowProp.shots[0].propCardIds, []);
  assert.equal(hollowProp.missing.includes("propCardIds"), false);
});

test("complete 判定不受 prop 影响：除道具外全齐 → complete=true；只有道具 → complete=false", () => {
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

  // 反向：道具栏有值也不能把其他缺项洗白
  const onlyProp = storyboardQcShots([fullShot()], { "001": { propCardIds: ["card-prop-book"] } });
  assert.equal(onlyProp.complete, false);
  assert.ok(onlyProp.missing.includes("sceneId"));
});

test("productionFieldsFromContext 第 ④ 条推导：道具名 → propCardIds（来源 referenceAssets；呼叫端已供给不被覆盖）", () => {
  const shot = fullShot({ referenceAssets: `场景:[旧宅_主视] 角色:[林昭_正面] 道具:[${PROP_NAME}]` });
  const derived = productionFieldsFromContext([shot], { cards: cardsWithProp() });
  assert.deepEqual(derived.fields["001"].propCardIds, ["card-prop-book"]);
  assert.equal(derived.sources["001"].propCardIds, "referenceAssets");
  // 另两条照旧（同一批解析，道具不干扰角色/场景）
  assert.equal(derived.sources["001"].characterCardIds, "referenceAssets");
  assert.equal(derived.sources["001"].sceneCardIds, "referenceAssets");

  const supplied = productionFieldsFromContext([shot], {
    production: { "001": { propCardIds: ["card-explicit-prop"] } },
    cards: cardsWithProp(),
  });
  assert.deepEqual(supplied.fields["001"].propCardIds, ["card-explicit-prop"], "呼叫端已供给的道具 id 不被推导覆盖");
  assert.equal(supplied.sources["001"].propCardIds, "production");

  // 没有道具来源时完全不生成该栏（与其他推导同一纪律：不补默认值）
  const bare = productionFieldsFromContext([fullShot({ referenceAssets: "角色:[林昭_正面]" })], { cards: cardsWithProp() });
  assert.equal(bare.fields["001"].propCardIds, undefined);
  assert.equal(bare.sources["001"].propCardIds, undefined);
});

test("行为断言：带道具的推导结果喂本地门禁，门禁判定与无道具时逐项相同（道具不改变任何一门）", () => {
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
  // 道具名称真的走完了「名称 → 卡 id」解析链（来源记在审计迹上）
  assert.deepEqual(withPropArgs.input.shots[0].propCardIds, ["card-prop-book"]);
  assert.equal(withPropArgs.sources["001"].propCardIds, "referenceAssets");

  const withProp = runShortDramaTool("storyboard_qc_17", withPropArgs.input);
  const stripped = runShortDramaTool("storyboard_qc_17", {
    ...withPropArgs.input,
    shots: withoutPropKey(withPropArgs.input.shots),
  });
  assert.equal(withProp.gates.length, 17);
  assert.deepEqual(withProp.gates, stripped.gates, "多带 propCardIds 键不得改变任何一门的判定");
  assert.equal(withProp.output.ready, true);
});

test("专案接线：专案锁定清单里的 prop 卡不算『查不到卡实体』（也不进两集锁定集合）", () => {
  const { context, unresolvedCardIds } = storyboardQcContextFromProject(
    { cardIds: ["card-lin", "card-prop-book"] },
    { cards: cardsWithProp() },
  );
  assert.deepEqual(context.lockedCharacterCardIds, ["card-lin"]);
  assert.deepEqual(context.lockedSceneCardIds, undefined);
  assert.deepEqual(unresolvedCardIds, []);
});

// ─────────────────────────────────────────── ⑩ 第 ⑤ 条推导：节点 metadata 卡 id → 门禁（2026-09-24 闭环消费端）

/** 分镜节点样本（结构相容 CanvasNodeRef）：镜号 + 任意 metadata 栏。 */
function shotNode(shotNumber: string, metadata: StoryboardQcShotNodeMetadata): { metadata: StoryboardQcShotNodeMetadata & { storyboardShot: { shotNumber: string } } } {
  return { metadata: { ...metadata, storyboardShot: { shotNumber } } };
}

test("闭环（最重要）：节点 metadata 的卡 id 真的进 fields/sources，且 missing 确实少掉两项", () => {
  // referenceAssets 刻意留空：这条只验 metadata 这一路（不得靠名称解析借道）
  const shot = fullShot({ referenceAssets: "" });
  const context = {
    shotMetadata: { "001": { characterCardIds: ["card-lin", "card-chen"], sceneCardIds: ["card-house"] } },
  };
  const { fields, sources } = productionFieldsFromContext([shot], context);
  assert.deepEqual(fields["001"].characterCardIds, ["card-lin", "card-chen"]);
  assert.deepEqual(fields["001"].sceneCardIds, ["card-house"]);
  assert.equal(sources["001"].characterCardIds, "nodeMetadata");
  assert.equal(sources["001"].sceneCardIds, "nodeMetadata");

  // 对照组：同一镜、无 metadata 卡 id → 两项卡 id 进 missing
  const withoutMeta = storyboardQcShots([shot], productionFieldsFromContext([shot], {}).fields);
  assert.ok(withoutMeta.missing.includes("characterCardIds"));
  assert.ok(withoutMeta.missing.includes("sceneCardIds"));

  // 有 metadata → 这两项真的从 missing 消失（闭环的价值本体）
  const withMeta = storyboardQcShots([shot], fields);
  assert.ok(!withMeta.missing.includes("characterCardIds"), "推导到值后不得再列 missing");
  assert.ok(!withMeta.missing.includes("sceneCardIds"));
  assert.deepEqual(
    withoutMeta.missing.filter((f) => !["characterCardIds", "sceneCardIds"].includes(f)),
    withMeta.missing.filter((f) => !["characterCardIds", "sceneCardIds"].includes(f)),
    "除了这两项，其余 missing 逐项不变",
  );
});

test("优先序三态：supplied > referenceAssets > 节点 metadata（metadata 绝不覆盖前两者）", () => {
  const threeFromNode = { "001": { characterCardIds: ["card-x", "card-y", "card-z"] } };
  // ① supplied 有值 → production 胜，src = "production"
  const supplied = productionFieldsFromContext([fullShot()], {
    production: { "001": { characterCardIds: ["card-explicit"] } },
    cards: cards(),
    shotMetadata: threeFromNode,
  });
  assert.deepEqual(supplied.fields["001"].characterCardIds, ["card-explicit"]);
  assert.equal(supplied.sources["001"].characterCardIds, "production");

  // ② supplied 无、referenceAssets 指 1 张、metadata 有 3 张 → 结果必须是那 1 张
  const viaRefs = productionFieldsFromContext([fullShot({ referenceAssets: "角色:[林昭_正面]" })], {
    cards: cards(),
    shotMetadata: threeFromNode,
  });
  assert.deepEqual(viaRefs.fields["001"].characterCardIds, ["card-lin"], "metadata 不得覆盖 referenceAssets");
  assert.equal(viaRefs.sources["001"].characterCardIds, "referenceAssets");

  // ③ 两者都无 → metadata 胜，src = "nodeMetadata"
  const viaNode = productionFieldsFromContext([fullShot({ referenceAssets: "" })], { shotMetadata: threeFromNode });
  assert.deepEqual(viaNode.fields["001"].characterCardIds, ["card-x", "card-y", "card-z"]);
  assert.equal(viaNode.sources["001"].characterCardIds, "nodeMetadata");
});

test("禁区：propCardIds 从 metadata 推导到值，missing 与 complete 逐项不变", () => {
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
  assert.deepEqual(withProp.missing, withoutProp.missing, "道具是加成栏位：missing 逐项不变");
  assert.equal(withProp.complete, withoutProp.complete);
  assert.equal(withProp.complete, true);
  assert.deepEqual(withProp.input.shots[0].propCardIds, ["card-prop-book"]);
  assert.equal(withProp.sources["001"].propCardIds, "nodeMetadata");
  assert.deepEqual(withoutProp.input.shots[0].propCardIds, []);
  // 行为断言：门禁 17 门判定逐项相同（道具键不改变任何一门）
  const gated = runShortDramaTool("storyboard_qc_17", withProp.input);
  const stripped = runShortDramaTool("storyboard_qc_17", { ...withProp.input, shots: withoutPropKey(withProp.input.shots) });
  assert.equal(gated.gates.length, 17);
  assert.deepEqual(gated.gates, stripped.gates);
});

test("清洗与空值：非字串项剔除、重复去重；空阵列省略该键（不误报「有值」）", () => {
  const dirty = productionFieldsFromContext([fullShot({ referenceAssets: "" })], {
    shotMetadata: { "001": { characterCardIds: ["a", "", "a", 123] } },
  });
  assert.deepEqual(dirty.fields["001"].characterCardIds, ["a"]);
  assert.equal(dirty.sources["001"].characterCardIds, "nodeMetadata");

  // 空阵列 / 全空白 / 非阵列 → 不生成该栏、来源不出现
  for (const raw of [[], ["", "   "], "a", null, { 0: "a" }]) {
    const bare = productionFieldsFromContext([fullShot({ referenceAssets: "" })], {
      shotMetadata: { "001": { characterCardIds: raw } },
    });
    assert.equal(bare.fields["001"].characterCardIds, undefined, `raw=${JSON.stringify(raw)} 不得生成`);
    assert.equal(bare.sources["001"].characterCardIds, undefined);
  }
});

test("专案接线：节点卡 id 进 shotMetadata（与 size 共存；空值省略键；无镜号不臆造键）", () => {
  const { context } = storyboardQcContextFromProject({
    nodes: [
      shotNode("001", { size: "9:16", characterCardIds: ["card-lin", "", "card-lin"], sceneCardIds: ["card-house"], propCardIds: ["card-prop-book"] }),
      shotNode("002", { characterCardIds: ["card-chen"] }), // 无 size 但卡 id 仍要带
      shotNode("003", { characterCardIds: [] }), // 空阵列 → 该键省略
      { metadata: { characterCardIds: ["card-ghost"] } }, // 无镜号 → 不归属任一镜
    ],
  });
  assert.deepEqual(context.shotMetadata, {
    "001": { size: "9:16", characterCardIds: ["card-lin"], sceneCardIds: ["card-house"], propCardIds: ["card-prop-book"] },
    "002": { characterCardIds: ["card-chen"] },
  });
  // 未被误加的键：003 只有空阵列 → 整个镜键都不生成（不造空壳）；size 语义不变
  assert.equal(Object.prototype.hasOwnProperty.call(context.shotMetadata, "003"), false);
  assert.equal(context.shotMetadata?.["002"]?.size, undefined);
});

test("整合（oracle = 真本地 storyboard_qc_17）：节点卡 id 带入 → 门禁该些门通过；不带 → block", () => {
  // 输入只有节点宣告的卡 id：专案锁定集 = 同一批卡、镜的 referenceAssets 为空（无名称可解析）
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
    assert.equal(byId.get(id)?.passed, true, `${id} 应 pass（证据：${byId.get(id)?.detail}）`);
  }
  assert.ok(!args.missing.includes("characterCardIds"));
  assert.ok(!args.missing.includes("sceneCardIds"));

  // 对照组：同专案、同 production，但节点不宣告卡 id → 该些门如实 block
  const noMeta = storyboardQcContextFromProject(
    { cardIds: ["card-lin", "card-chen", "card-house"], nodes: [shotNode("001", { size: "9:16" })] },
    { cards: cards() },
  );
  const bareArgs = storyboardQcGateArgs([fullShot({ referenceAssets: "" })], { ...noMeta.context, production });
  const bare = runShortDramaTool("storyboard_qc_17", bareArgs.input);
  const bareById = new Map(bare.gates.map((g) => [g.id, g]));
  for (const id of ["characters_bound", "scenes_bound"]) {
    assert.equal(bareById.get(id)?.passed, false, `${id} 应 block（无来源时不许通过）`);
  }
  // 两集 lock 门在「引用集为空」时是空集合真空通过（门禁既有语义，非本刀改动）——
  // 所以无来源时真正 block 的是 `*_bound`；有来源时 lock 门才是**非真空**地验「每个引用都在锁定集内」。
  assert.equal(bareById.get("character_lock")?.passed, true);
  assert.ok(bareArgs.missing.includes("characterCardIds"));
  assert.ok(bareArgs.missing.includes("sceneCardIds"));
  assert.equal(bare.output.ready, false);
});

// ─────────────────────────────────────────── ⑪ 资产批准闸（2026-09-24 决策 2/23）

/** 批准状态样本名单（同一批名称，只换 approval；undefined＝不带栏位＝缺省）。 */
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

test("协作档：未批准的卡 id 不得进分镜卡引用栏；改 approved 后进来（真输入真输出）", () => {
  const pending = productionFieldsFromContext([fullShot()], { cards: cardsWithApproval("pending"), mode: "collaborate" });
  assert.equal("characterCardIds" in pending.fields["001"], false, "未批准 → 整栏不留值（不留空阵列骗门禁）");
  assert.equal("sceneCardIds" in pending.fields["001"], false);
  assert.deepEqual(pending.blockedCardIdsByShot?.["001"], ["card-lin", "card-chen", "card-house"], "挡下的 id 如实回报");
  const viaGate = storyboardQcShots([fullShot()], pending.fields);
  assert.ok(viaGate.missing.includes("characterCardIds"), "挡下后该栏进 missing（门禁会 block，不是静默无引用）");
  assert.ok(viaGate.missing.includes("sceneCardIds"));

  // 同一份名单改 approved → 同一条推导路径把 id 交出来
  const okFields = productionFieldsFromContext([fullShot()], { cards: cardsWithApproval("approved"), mode: "collaborate" });
  assert.deepEqual(okFields.fields["001"].characterCardIds, ["card-lin", "card-chen"]);
  assert.deepEqual(okFields.fields["001"].sceneCardIds, ["card-house"]);
  assert.equal(okFields.blockedCardIdsByShot, undefined, "没挡到就不回报这栏");

  // 缺省 approval（存量资产）→ 协作档照样当已批准
  const legacy = productionFieldsFromContext([fullShot()], { cards: cardsWithApproval(undefined), mode: "collaborate" });
  assert.deepEqual(legacy.fields["001"].characterCardIds, ["card-lin", "card-chen"], "缺省＝已批准（决策 23）");

  // 逐 id 过闸：只有林昭 pending，已批准的陈默不受牵连
  const partialCards = cardsWithApproval(undefined).map((c) =>
    c.id === "card-lin" ? { ...c, approval: { status: "pending" as const } } : c,
  );
  const partial = productionFieldsFromContext([fullShot()], { cards: partialCards, mode: "collaborate" });
  assert.deepEqual(partial.fields["001"].characterCardIds, ["card-chen"]);
  assert.deepEqual(partial.blockedCardIdsByShot?.["001"], ["card-lin"]);
});

test("护城河回归（最重要）：全自动两档＋未给 mode → 未批准卡照进卡引用栏，真门禁 17 门逐项相同", () => {
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
  // 全部卡都 rejected（最极端）：未给 mode ＝ 既有行为
  const unlockCtx = {
    production,
    cards: cardsWithApproval("rejected"),
    lockedCharacterCardIds: ["card-lin", "card-chen"],
    lockedSceneCardIds: ["card-house"],
    segmentDurationSeconds: 10,
  };
  const baseline = storyboardQcGateArgs([fullShot()], unlockCtx);
  assert.equal(baseline.complete, true, "未给 mode：既有情境仍 complete=true（零回归）");
  assert.deepEqual(baseline.input.shots[0].characterCardIds, ["card-lin", "card-chen"]);
  const baselineGates = runShortDramaTool("storyboard_qc_17", baseline.input).gates;
  assert.equal(runShortDramaTool("storyboard_qc_17", baseline.input).output.ready, true);

  for (const mode of ["preset", "auto"] as const) {
    const args = storyboardQcGateArgs([fullShot()], { ...unlockCtx, mode });
    assert.deepEqual(args.input.shots, baseline.input.shots, `mode=${mode}：门禁输入逐位相同`);
    assert.deepEqual(args.missing, baseline.missing, `mode=${mode}：missing 逐项相同`);
    assert.equal(args.complete, true, `mode=${mode}：不得新增任何阻塞`);
    assert.deepEqual(
      runShortDramaTool("storyboard_qc_17", args.input).gates,
      baselineGates,
      `mode=${mode}：真门禁 17 门逐项相同`,
    );
  }

  // 对照组（独立 oracle）：同一份被驳回的卡，协作档下真门禁必须翻脸 → 证明闸真的接上了
  const collab = storyboardQcGateArgs([fullShot()], { ...unlockCtx, mode: "collaborate" });
  const collabRun = runShortDramaTool("storyboard_qc_17", collab.input);
  assert.equal(collabRun.output.ready, false, "协作档＋未批准资产 → 真门禁 block");
  assert.notDeepEqual(collabRun.gates, baselineGates);
});

test("驳回后：已写进节点 metadata 的旧绑定照样被挡（闸在生效层，不是事后贴纸）", () => {
  const shotMetadata = { "001": { characterCardIds: ["card-lin"], sceneCardIds: ["card-house"] } };
  const shot = fullShot({ referenceAssets: "" });
  const open = productionFieldsFromContext([shot], { shotMetadata });
  assert.deepEqual(open.fields["001"].characterCardIds, ["card-lin"], "未给 mode：metadata 绑定照常生效（零回归）");
  const gated = productionFieldsFromContext([shot], {
    shotMetadata,
    cards: [
      { id: "card-lin", name: "林昭_正面", kind: "character", approval: { status: "rejected", reason: "光影不对" } },
      { id: "card-house", name: "旧宅_主视", kind: "scene" },
    ],
    mode: "collaborate",
  });
  assert.equal("characterCardIds" in gated.fields["001"], false, "落卡后才驳回 → 旧绑定不得继续生效");
  assert.equal(gated.sources["001"].characterCardIds, undefined, "来源审计迹同步清掉（不留「有来源却无值」）");
  assert.deepEqual(gated.fields["001"].sceneCardIds, ["card-house"], "同镜已批准的场景卡不受牵连");
  assert.deepEqual(gated.blockedCardIdsByShot?.["001"], ["card-lin"]);
});

test("呼叫端供给的 production 卡 id 同样过闸（供给不是绕道）", () => {
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

test("filterApprovedShotCardIds：非协作档原样回传（含顺序与重复项）；查不到的 id 不猜著挡", () => {
  const ids = ["card-b", "card-a", "card-a", "card-unknown"];
  const rejectedA: StoryboardQcCardRef[] = [
    { id: "card-a", name: "a", kind: "character", approval: { status: "rejected", reason: "不对" } },
    { id: "card-b", name: "b", kind: "character" },
  ];
  for (const mode of [undefined, "preset", "auto"] as const) {
    assert.deepEqual(filterApprovedShotCardIds(ids, rejectedA, mode), ids, `mode=${String(mode)} 必须逐位原样`);
  }
  assert.deepEqual(filterApprovedShotCardIds(ids, rejectedA, "collaborate"), ["card-b", "card-unknown"]);
  // 同 id 多笔且其中有未批准者 → 挡（不能证明已批准的，不当已批准处理）
  const duplicate: StoryboardQcCardRef[] = [
    { id: "card-a", name: "a", kind: "character", approval: { status: "approved" } },
    { id: "card-a", name: "a", kind: "character", approval: { status: "pending" } },
  ];
  assert.deepEqual(filterApprovedShotCardIds(["card-a"], duplicate, "collaborate"), []);
  assert.deepEqual(filterApprovedShotCardIds(undefined, rejectedA, "collaborate"), []);
});

test("分镜侧 approval：供给才出现（同一 shape、reason 原样读回），且不得改变 missing（门槛语义零变动）", () => {
  const approval = { status: "pending" as const, decidedAt: "2026-09-24T10:00:00.000Z", reason: "等甲方核对" };
  const withApproval = storyboardQcShots([fullShot()], { "001": { approval } });
  assert.deepEqual(withApproval.shots[0].approval, approval, "与资产侧同一个 shape，理由原样读回");
  assert.deepEqual(
    withApproval.missing,
    storyboardQcShots([fullShot()], {}).missing,
    "带 approval 不得改变 missing（分镜确认不是 QC 门槛栏位）",
  );
  assert.ok(!withApproval.missing.includes("approval"));
  const bare = storyboardQcShots([fullShot()], {});
  assert.equal("approval" in bare.shots[0], false, "未供给 → 不补默认值（既有输出键逐位不变）");
  // 独立 oracle：真本地门禁对「带 approval / 不带 approval」两形输入判定逐项相同（未知键忽略）
  assert.deepEqual(
    runShortDramaTool("storyboard_qc_17", { shots: withApproval.shots }).gates,
    runShortDramaTool("storyboard_qc_17", { shots: bare.shots }).gates,
    "多带 approval 键不得改变任何一门的判定",
  );
});

// ─────────────────────────────────────────── ⑫ 重跑影响面（纯判定）

test("affectedShotNodesByCardIds：只回报真的引用了该批卡的分镜节点（非分镜节点/无 id 不回报）", () => {
  const nodes = [
    { id: "shot-1", metadata: { storyboardShot: { shotNumber: "001" }, characterCardIds: ["card-node-a"], sceneCardIds: ["card-node-s"] } },
    { id: "shot-2", metadata: { storyboardShot: { shotNumber: "002" }, characterCardIds: ["card-node-b"] } },
    { id: "asset-a", metadata: { storyboardShot: null, characterCardIds: ["card-node-a"] } },
    { id: "shot-3", metadata: { storyboardShot: { shotNumber: "003" }, characterCardIds: ["card-node-a"] } },
  ];
  const single = affectedShotNodesByCardIds(nodes, ["card-node-a"]);
  assert.deepEqual(single.affectedCardIds, ["card-node-a"]);
  assert.deepEqual(single.shotNodeIds, ["shot-1", "shot-3"], "无镜号的资产节点不是分镜节点");

  const batch = affectedShotNodesByCardIds(nodes, ["card-node-a", "card-node-b", "card-node-unused"]);
  assert.deepEqual(batch.affectedCardIds, ["card-node-a", "card-node-b"], "没被任何镜引用的卡不回报");
  assert.deepEqual(batch.shotNodeIds, ["shot-1", "shot-2", "shot-3"], "顺序＝节点输入序");
  assert.deepEqual(affectedShotNodesByCardIds(nodes, []), { affectedCardIds: [], shotNodeIds: [] });
  assert.deepEqual(affectedShotNodesByCardIds(nodes, ["  "]), { affectedCardIds: [], shotNodeIds: [] });
  // 节点无 id → 卡仍如实回报，但不得臆造节点 id
  const noId = affectedShotNodesByCardIds([{ metadata: { storyboardShot: { shotNumber: "001" }, characterCardIds: ["card-node-a"] } }], ["card-node-a"]);
  assert.deepEqual(noId, { affectedCardIds: ["card-node-a"], shotNodeIds: [] });
});

// ─────────────────────────────────────────── ⑬ 旁白加成栏位（2026-09-30）

const NARRATION = "第三天清晨，林昭终于推开那扇门。";

test("旁白是加成栏位：供给时原值输出且不进 missing；未供给时也不进 missing（不罚），门槛结论不变", () => {
  const supplied = storyboardQcShots([fullShot()], { "001": { narration: NARRATION } });
  // 真行为断言：栏位值真的流到输出（不是源码字串断言）
  assert.equal(supplied.shots[0].narration, NARRATION);
  assert.equal(supplied.missing.includes("narration"), false, "旁白不参与 missing 判定");

  const bare = storyboardQcShots([fullShot()], {});
  // 未供给 → 不补默认值（不冒充用户设定），且同样不罚
  assert.equal("narration" in bare.shots[0], false);
  assert.equal(bare.missing.includes("narration"), false);
  // 供给旁白不得改变门槛结论：missing / complete 逐项相同
  assert.deepEqual(bare.missing, supplied.missing);
  assert.equal(bare.complete, supplied.complete);

  // 空值/纯空白 → 省略该键（本档既有纪律），且照样不进 missing
  const hollow = storyboardQcShots([fullShot()], { "001": { narration: "   " } });
  assert.equal("narration" in hollow.shots[0], false);
  assert.equal(hollow.missing.includes("narration"), false);
});

test("旁白来源补记与不推导：供给记 production、未供给不生成，且不从 dialogue 猜", () => {
  const supplied = productionFieldsFromContext([fullShot()], {
    production: { "001": { narration: NARRATION } },
  });
  assert.equal(supplied.fields["001"].narration, NARRATION, "旁白原样进 fields");
  assert.equal(supplied.sources["001"].narration, "production", "加成栏位也要有审计迹（与 prompt/propCardIds 同范式）");

  const bare = productionFieldsFromContext([fullShot()], { cards: cards() });
  assert.equal(bare.fields["001"].narration, undefined, "无来源则完全不生成该栏");
  assert.equal(bare.sources["001"].narration, undefined);
  // 行为断言：dialogue 有值也不得凭空生成 narration（从 dialogue 猜旁白＝自造转换，禁）
  const withDialogue = productionFieldsFromContext([fullShot({ dialogue: "[林昭]：「有人吗」" })], { cards: cards() });
  assert.equal(withDialogue.fields["001"].narration, undefined);
});

test("行为断言：多带 narration 键不得改变门禁任何一门的判定（独立 oracle = 真本地 storyboard_qc_17）", () => {
  const production = {
    "001": { sceneId: "S01", durationSeconds: 3, keyframeId: "kf-1", lastFrameId: "lf-1", audioAnchorId: "a-1", aspectRatio: "9:16" },
  };
  const withNarration = storyboardQcGateArgs([fullShot()], {
    production: { "001": { ...production["001"], narration: NARRATION } },
  });
  const without = storyboardQcGateArgs([fullShot()], { production });
  assert.equal(withNarration.input.shots[0].narration, NARRATION);
  assert.deepEqual(withNarration.missing, without.missing, "旁白是加成栏位：missing 逐项不变");
  assert.equal(withNarration.complete, without.complete);
  assert.deepEqual(
    runShortDramaTool("storyboard_qc_17", withNarration.input).gates,
    runShortDramaTool("storyboard_qc_17", without.input).gates,
    "多带 narration 键不得改变任何一门的判定",
  );
});

// ─────────────────────────────────────────── ⑭ 分镜节点音轨锚 → 门禁（2026-09-30）

/** 除音轨锚外的成片栏位样本（音轨锚刻意留给「节点 metadata vs 呼叫端供给」两路对照）。 */
const ANCHOR_PRODUCTION = {
  "001": {
    sceneId: "S01",
    durationSeconds: 3,
    keyframeId: "kf-1",
    lastFrameId: "lf-1",
    aspectRatio: "9:16",
  },
};

test("闭环（真行为）：节点 audioAnchorId 真喂进门禁 → audio_anchor_present/dialogue_alignment 由 block 转 pass", () => {
  const project = {
    cardIds: ["card-lin", "card-chen", "card-house"],
    nodes: [shotNode("001", { audioAnchorId: "anchor-from-voiceover" })],
  };
  const { context } = storyboardQcContextFromProject(project, { cards: cards() });
  // 带入端：逐镜配音回写的节点音轨锚真的进 shotMetadata
  assert.equal(context.shotMetadata?.["001"]?.audioAnchorId, "anchor-from-voiceover");

  const args = storyboardQcGateArgs([fullShot()], { ...context, production: ANCHOR_PRODUCTION });
  assert.equal(args.sources["001"].audioAnchorId, "nodeMetadata", "来源审计迹 = 节点 metadata");
  assert.equal(args.input.shots[0].audioAnchorId, "anchor-from-voiceover");
  assert.ok(!args.missing.includes("audioAnchorId"), "节点供给后不得再列 missing");

  const gated = runShortDramaTool("storyboard_qc_17", args.input);
  const byId = new Map(gated.gates.map((g) => [g.id, g]));
  assert.equal(byId.get("audio_anchor_present")?.passed, true, `应 pass（证据：${byId.get("audio_anchor_present")?.detail}）`);
  assert.equal(byId.get("dialogue_alignment")?.passed, true, `应 pass（证据：${byId.get("dialogue_alignment")?.detail}）`);
});

test("反证：拔掉节点音轨锚 → 同一两门必 block（证明判定真吃了节点音轨，非同源伪证）", () => {
  const stripped = storyboardQcContextFromProject(
    { cardIds: ["card-lin", "card-chen", "card-house"], nodes: [shotNode("001", {})] },
    { cards: cards() },
  );
  const bareArgs = storyboardQcGateArgs([fullShot()], { ...stripped.context, production: ANCHOR_PRODUCTION });
  assert.ok(bareArgs.missing.includes("audioAnchorId"), "无来源必须诚实回报 missing");
  assert.equal(bareArgs.input.shots[0].audioAnchorId, undefined, "不得凭空补值");

  const bare = runShortDramaTool("storyboard_qc_17", bareArgs.input);
  const bareById = new Map(bare.gates.map((g) => [g.id, g]));
  assert.equal(bareById.get("audio_anchor_present")?.passed, false, `拔掉后必 block（证据：${bareById.get("audio_anchor_present")?.detail}）`);
  assert.equal(bareById.get("dialogue_alignment")?.passed, false, `拔掉后必 block（证据：${bareById.get("dialogue_alignment")?.detail}）`);
});

test("优先序：呼叫端明确供给的 audioAnchorId 胜；未供给时才从节点 metadata 拿（⑤ 生效条件）", () => {
  const supplied = storyboardQcGateArgs([fullShot()], {
    production: { "001": { ...ANCHOR_PRODUCTION["001"], audioAnchorId: "anchor-explicit" } },
    shotMetadata: { "001": { audioAnchorId: "anchor-node" } },
  });
  assert.equal(supplied.input.shots[0].audioAnchorId, "anchor-explicit", "metadata 不得覆盖呼叫端供给");
  assert.equal(supplied.sources["001"].audioAnchorId, "production");

  const fromNode = storyboardQcGateArgs([fullShot()], {
    production: ANCHOR_PRODUCTION,
    shotMetadata: { "001": { audioAnchorId: "anchor-node" } },
  });
  assert.equal(fromNode.input.shots[0].audioAnchorId, "anchor-node");
  assert.equal(fromNode.sources["001"].audioAnchorId, "nodeMetadata");
});

test("节点音轨锚是单值语义（同 size，非卡 id 联集）：同镜首个非空胜、矛盾则不给、空值不占位", () => {
  // 同镜两节点矛尖不同 → 整个不给（不取首个猜；仍有该镜键但无值）
  const conflict = storyboardQcContextFromProject({
    nodes: [shotNode("001", { audioAnchorId: "a-1" }), shotNode("001", { audioAnchorId: "a-2" })],
  });
  assert.deepEqual(conflict.context.shotMetadata, { "001": {} });

  // 相同值多节点 + 空/纯空白 → 收敛成单一纯字串（不是阵列，空值不占位也不制造矛盾）
  const agree = storyboardQcContextFromProject({
    nodes: [
      shotNode("001", { audioAnchorId: "a-1" }),
      shotNode("001", { audioAnchorId: "a-1" }),
      shotNode("001", { audioAnchorId: "   " }),
    ],
  });
  assert.deepEqual(agree.context.shotMetadata, { "001": { audioAnchorId: "a-1" } });

  // 非字串 / 无镜号 → 不臆造
  const dirty = storyboardQcContextFromProject({
    nodes: [shotNode("002", { audioAnchorId: 123 }), { metadata: { audioAnchorId: "a-ghost" } }],
  });
  assert.equal(dirty.context.shotMetadata, undefined);
});
