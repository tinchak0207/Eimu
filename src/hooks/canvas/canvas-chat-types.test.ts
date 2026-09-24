// compactMetadataForAgent 回歸測試（2026-09-03 導演台「示意图未同步」事故）。
// 事故鏈：上行壓縮白名單不含 director 欄位 → gateway 快照裡導演台節點是空殼 →
// 刷新/恢復後還原出的節點缺 directorSessionId/SVG → NodeBody 落到兜底文案。
// 本測試釘死往復合同：壓縮輸出經 toNodeMetadata（還原端）後指針欄位原樣存活。
import { test } from "node:test";
import assert from "node:assert/strict";
import { compactMetadataForAgent } from "./canvas-chat-types";
import { toNodeMetadata } from "@/lib/canvas/layout";
import type { CanvasNodeMetadata } from "@/lib/canvas/types";
import type { StoryboardScriptShot } from "@/lib/storyboard-contract";

const BIG_SVG = `<svg>${"x".repeat(60 * 1024)}</svg>`;

test("director 節點壓縮保留指針欄位、剔除 SVG", () => {
  const meta: CanvasNodeMetadata = {
    pipelineCard: "director",
    directorSessionId: "sess_abc123",
    planName: "分鏡方案 A",
    shotCount: 6,
    healthOk: true,
    revision: 12,
    topViewSvg: BIG_SVG,
    cameraViewSvg: BIG_SVG,
  };
  const compacted = compactMetadataForAgent(meta);
  assert.ok(compacted);
  assert.equal(compacted.pipelineCard, "director");
  assert.equal(compacted.directorSessionId, "sess_abc123");
  assert.equal(compacted.planName, "分鏡方案 A");
  assert.equal(compacted.shotCount, 6);
  assert.equal(compacted.healthOk, true);
  assert.equal(compacted.revision, 12);
  assert.equal(compacted.topViewSvg, undefined);
  assert.equal(compacted.cameraViewSvg, undefined);
});

test("壓縮輸出經還原端 toNodeMetadata 後 director 指針不丟（往復合同）", () => {
  const meta: CanvasNodeMetadata = {
    pipelineCard: "director",
    directorSessionId: "sess_abc123",
    planName: null,
    shotCount: 0,
    healthOk: false,
    revision: 3,
  };
  const restored = toNodeMetadata(compactMetadataForAgent(meta));
  assert.equal(restored.pipelineCard, "director");
  assert.equal(restored.directorSessionId, "sess_abc123");
  assert.equal(restored.planName, null);
  assert.equal(restored.shotCount, 0);
  assert.equal(restored.healthOk, false);
  assert.equal(restored.revision, 3);
});

test("非 director 節點不受影響：SVG 欄位從不外傳", () => {
  const compacted = compactMetadataForAgent({ content: "hello", topViewSvg: BIG_SVG });
  assert.deepEqual(compacted, { content: "hello" });
});

// ── 3D 場景卡（2026-09-06 Astra PRD P1-3）：sceneCard 欄位族往復合同 ──

const SCENE_CARD = {
  turntable_url: "https://cdn.example.com/turntable.mp4",
  stills_urls: ["https://cdn.example.com/s1.png", "https://cdn.example.com/s2.png", "https://cdn.example.com/s3.png"],
  blend_path: "/api/scene-assets/scene_01.blend",
  glb_path: "/api/scene-assets/scene_01.glb",
  scene_summary: "废弃灯塔主场景 · 白模已上材质",
  duration_ms: 8000,
};

test("scene_3d 節點壓縮保留 sceneCard 六欄", () => {
  const compacted = compactMetadataForAgent({ sceneCard: SCENE_CARD });
  assert.ok(compacted);
  assert.deepEqual(compacted.sceneCard, SCENE_CARD);
});

test("壓縮輸出經還原端 toNodeMetadata 後 sceneCard 不丟（往復合同）", () => {
  const meta: CanvasNodeMetadata = { sceneCard: SCENE_CARD };
  const restored = toNodeMetadata(compactMetadataForAgent(meta));
  assert.deepEqual(restored.sceneCard, SCENE_CARD);
});

test("sceneCard 非契約形狀在還原端整包丟棄（缺 turntable_url）", () => {
  const restored = toNodeMetadata({ sceneCard: { stills_urls: ["x.png"], scene_summary: "殘形" } });
  assert.equal(restored.sceneCard, undefined);
});

test("非 scene_3d 節點不受影響：無 sceneCard 不外傳空欄位", () => {
  const compacted = compactMetadataForAgent({ content: "hello" });
  assert.deepEqual(compacted, { content: "hello" });
});

// ── 分鏡實體（2026-09-15 刀 2）：storyboardShot/storyboardScene 欄位族往復合同 ──
// 完整契約測試在 src/lib/storyboard-contract.test.ts；此處只釘「壓縮器這一端有接上」，
// 即雙白名單第二處（本檔）不漏欄——漏了就刷新/換裝置後 21 欄空殼。

test("分鏡節點壓縮保留 storyboardShot 21 欄與 storyboardScene", () => {
  const shot: StoryboardScriptShot = {
    shotNumber: "001",
    scriptContent: "正文片段",
    visualDescription: "中景，推門而入",
    dialogue: "[林昭]：「有人嗎」",
    actionState: "推門、環視",
    narrativeFunction: "建立懸念",
    timeOfDay: "清晨",
    eraCoordinate: "当代",
    dateCoordinate: "第三天",
    weather: "晴",
    referenceAssets: "场景:[旧宅_主视] 角色:[林昭_正面] 道具:[铜钥匙]",
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
  };
  const compacted = compactMetadataForAgent({ storyboardShot: shot, storyboardScene: { sceneName: "旧宅", shotCount: 1 } });
  assert.ok(compacted);
  assert.deepEqual(compacted.storyboardShot, shot);
  assert.deepEqual(compacted.storyboardScene, { sceneName: "旧宅", shotCount: 1 });
});

test("壓縮輸出經還原端 toNodeMetadata 後分鏡欄位不丟（往復合同）", () => {
  const shot: StoryboardScriptShot = {
    shotNumber: "001",
    scriptContent: "正文",
    visualDescription: "画面",
    dialogue: "",
    actionState: "",
    narrativeFunction: "",
    timeOfDay: "",
    eraCoordinate: "",
    dateCoordinate: "",
    weather: "",
    referenceAssets: "",
    shotSize: "",
    cameraAngle: "",
    focalLength: "",
    cameraMovement: "",
    composition: "",
    atmosphere: "",
    colorTone: "",
    lighting: "",
    exposureBlur: "",
    soundEffect: "",
  };
  const restored = toNodeMetadata(compactMetadataForAgent({ storyboardShot: shot }));
  assert.equal(restored.storyboardShot?.shotNumber, "001");
  assert.equal(restored.storyboardShot?.scriptContent, "正文");
  assert.equal(restored.storyboardShot?.dialogue, "");
});
// ── 分鏡實體卡引用＋落卡標記（WS7 收口，2026-09-24）：雙白名單第二處的往復合同 ──
// 病灶同構：漏這一端 = 回舊會話/換裝置還原（fromCanvasProject → toNodeMetadata）後
// 分鏡節點失去卡引用、落卡標記消失 → 自動落卡的回填與冪等只在 session 內有效。

test("分鏡卡引用＋落卡標記壓縮保留（四欄逐位元）", () => {
  const compacted = compactMetadataForAgent({
    characterCardIds: ["card-node-char-1", "card-hand-made"],
    sceneCardIds: ["card-node-scene-1"],
    propCardIds: ["card-node-prop-1"],
    entityCardId: "card-node-char-1",
  });
  assert.deepEqual(compacted, {
    characterCardIds: ["card-node-char-1", "card-hand-made"],
    sceneCardIds: ["card-node-scene-1"],
    propCardIds: ["card-node-prop-1"],
    entityCardId: "card-node-char-1",
  });
});

test("壓縮輸出經還原端 toNodeMetadata 後四欄逐位元還在（往復合同）", () => {
  const meta: CanvasNodeMetadata = {
    characterCardIds: ["card-node-char-1", "card-hand-made"],
    sceneCardIds: ["card-node-scene-1"],
    propCardIds: ["card-node-prop-1"],
    entityCardId: "card-node-char-1",
  };
  const restored = toNodeMetadata(compactMetadataForAgent(meta));
  assert.deepEqual(restored.characterCardIds, ["card-node-char-1", "card-hand-made"], "卡 id 順序原樣（順序是語義）");
  assert.deepEqual(restored.sceneCardIds, ["card-node-scene-1"]);
  assert.deepEqual(restored.propCardIds, ["card-node-prop-1"]);
  assert.equal(restored.entityCardId, "card-node-char-1", "落卡標記不丟（否則重載後冪等判定失去依據）");
});

test("卡引用欄清洗：空/空白 → 鍵不存在；['a','','a'] → ['a']（壓縮端與還原端同一把尺）", () => {
  // 壓縮端
  const compacted = compactMetadataForAgent({
    characterCardIds: ["a", "", "a"],
    sceneCardIds: [],
    propCardIds: ["   "],
  });
  assert.deepEqual(compacted, { characterCardIds: ["a"] }, "去重＋剔空；空陣列/純空白欄不寫進快照");
  // 還原端（同一批髒值）
  const restored = toNodeMetadata({
    characterCardIds: ["a", "", "a"],
    sceneCardIds: [],
    propCardIds: ["   "],
    entityCardId: "   ",
  });
  assert.deepEqual(restored, { characterCardIds: ["a"] }, "還原端逐欄收斂：空欄省略、標記純空白＝沒有標記");
});

test("卡引用欄非陣列/髒元素不落地（不偽造 id、不炸）", () => {
  const restored = toNodeMetadata({
    characterCardIds: "card-node-char-1",
    sceneCardIds: [7, null, { id: "x" }, "card-node-scene-1"],
    propCardIds: undefined,
    entityCardId: 42,
  });
  assert.deepEqual(restored, { sceneCardIds: ["card-node-scene-1"] }, "只留真字串 id，其餘丟棄");
});

test("安全邊界：通道只放行這四欄，其餘 metadata 鍵照舊不外傳", () => {
  const compacted = compactMetadataForAgent({
    characterCardIds: ["card-node-char-1"],
    // 任何其他欄位（含未列白名單的既有欄位）都不得因此被放行
    someNewKey: "leak",
    referenceNodeIds: ["n1"],
    topViewSvg: BIG_SVG,
  } as CanvasNodeMetadata);
  assert.deepEqual(compacted, { characterCardIds: ["card-node-char-1"] }, "四欄以外零放行");
});

// ── 模板實體宣告＋卡名來源（WS10，2026-09-24）：雙白名單第二處的往復合同 ──
// 病灶（已實錘的斷點）：閘道 `expandTemplate` 把模板 `defaults.emitsEntity` spread 進
// 節點 metadata，前端落地時被白名單剝掉 → `agent-output-cards.emittedEntityOf` 回 null
// → 整條「agent 交付自動落卡」在真畫布上不可能觸發（0 卡）。本節釘死這一端不漏欄。

const ENTITY_DECL = { kind: "character" as const, nameFrom: "input" as const };

test("壓縮端保留 emitsEntity 與卡名三鍵（逐位元），且回傳新物件（不與輸入同參考）", () => {
  const rawDeclaration = { kind: "character", nameFrom: "input" };
  const compacted = compactMetadataForAgent({
    emitsEntity: rawDeclaration,
    input: "霍辞渊",
    characterName: "备选名",
    sceneName: "旧宅",
  } as unknown as CanvasNodeMetadata);
  assert.deepEqual(compacted, { emitsEntity: ENTITY_DECL, input: "霍辞渊", characterName: "备选名", sceneName: "旧宅" });
  assert.notEqual(compacted!.emitsEntity, rawDeclaration, "必須是新物件（gateway 淺 spread 讓宣告與模板模組層同參考，沿用會跨會話污染）");
});

test("往復合同：壓縮 → 還原端 toNodeMetadata 後 emitsEntity 與卡名逐位元還在", () => {
  const meta = {
    emitsEntity: { kind: "scene", nameFrom: "input" },
    input: "客廳-黃昏",
    characterName: "不該當場景名用",
    sceneName: "客廳",
  } as unknown as CanvasNodeMetadata;
  const restored = toNodeMetadata(compactMetadataForAgent(meta));
  // nameFrom:"input" 的候選鍵順序由 agent-output-cards 決定（input → characterName → sceneName）：
  // 通道端只負責「三個鍵都活著過去」，不重排、不改值。
  assert.deepEqual((restored as { emitsEntity?: unknown }).emitsEntity, { kind: "scene", nameFrom: "input" });
  assert.equal((restored as { input?: string }).input, "客廳-黃昏");
  assert.equal((restored as { characterName?: string }).characterName, "不該當場景名用");
  assert.equal((restored as { sceneName?: string }).sceneName, "客廳");
});

test("emitsEntity 清洗：kind 不在五值域 → 兩端都整包丟（不降格成 character）", () => {
  for (const kind of ["banana", "", 7, null, "CHARACTER", undefined]) {
    const meta = { emitsEntity: { kind } } as unknown as CanvasNodeMetadata;
    assert.equal(compactMetadataForAgent(meta), undefined, `壓縮端：kind=${String(kind)} 整包丟`);
    assert.deepEqual(toNodeMetadata({ emitsEntity: { kind } }), {}, `還原端：kind=${String(kind)} 整包丟`);
  }
  // 非物件形態（字串/陣列/數字）同樣不進通道
  for (const raw of ["character", ["character"], 3, true]) {
    assert.deepEqual(toNodeMetadata({ emitsEntity: raw }), {}, `還原端：非物件 ${JSON.stringify(raw)} 丟棄`);
  }
});

test("emitsEntity 清洗：nameFrom 非兩值 → 省略該欄（kind 仍有效）；五值域全收", () => {
  for (const kind of ["character", "scene", "style", "prop", "audio"]) {
    assert.deepEqual(toNodeMetadata({ emitsEntity: { kind } }), { emitsEntity: { kind } }, `kind=${kind} 必收`);
  }
  for (const nameFrom of ["nonsense", 42, null, ""]) {
    assert.deepEqual(
      toNodeMetadata({ emitsEntity: { kind: "prop", nameFrom } }),
      { emitsEntity: { kind: "prop" } },
      `nameFrom=${String(nameFrom)} 只省該欄`,
    );
  }
  assert.deepEqual(toNodeMetadata({ emitsEntity: { kind: "prop", nameFrom: "nodeTitle" } }), {
    emitsEntity: { kind: "prop", nameFrom: "nodeTitle" },
  });
});

test("卡名三鍵清洗：空白/非字串 → 省略鍵；超長截 100（兩端同一把尺）", () => {
  const dirty = {
    input: "   ",
    characterName: 42,
    sceneName: "场".repeat(200),
  } as unknown as CanvasNodeMetadata;
  const restored = toNodeMetadata(dirty);
  assert.deepEqual(restored, { sceneName: "场".repeat(100) }, "只留真字串且非空，長度截到 100（卡名上限）");
  const compacted = compactMetadataForAgent(dirty);
  assert.deepEqual(compacted, { sceneName: "场".repeat(100) }, "壓縮端同一把尺（不留空欄進快照）");
});

test("安全邊界：卡名三鍵不放行同名的其他 metadata 鍵（輸入不因此外洩）", () => {
  const compacted = compactMetadataForAgent({
    input: "角色名",
    description: "不該外傳",
    key_features: ["不該外傳"],
  } as unknown as CanvasNodeMetadata);
  assert.deepEqual(compacted, { input: "角色名" }, "只放行三鍵本身");
});

// ── 四視圖聚合的參考圖鍵（2026-09-24）：雙白名單的第二刀 ──
// 病灶同族（WS10 實錘）：`emitsEntity` 內新增的鍵若漏放行，**當下就被剝**（不是重載才消失）
// → `referenceNodeIds` 永遠 undefined → 整條聚合功能不可能觸發（症狀＝完全沒反應）。
// 本節用**真** compactMetadataForAgent → **真** toNodeMetadata 往返（不寫替代品當 oracle）。

const ENTITY_WITH_REFS = {
  kind: "character" as const,
  nameFrom: "input" as const,
  referenceRoles: ["view2", "view3", "view4"],
  referenceNodeIds: ["tpl-view2-9", "tpl-view3-9", "tpl-view4-9"],
};

test("聚合鍵往復合同：經壓縮端 → 還原端後 referenceRoles/referenceNodeIds 逐位元還在", () => {
  const raw = {
    emitsEntity: {
      kind: "character",
      nameFrom: "input",
      referenceRoles: ["view2", "view3", "view4"],
      referenceNodeIds: ["tpl-view2-9", "tpl-view3-9", "tpl-view4-9"],
    },
    input: "霍辞渊",
  } as unknown as CanvasNodeMetadata;
  const compacted = compactMetadataForAgent(raw);
  assert.deepEqual(compacted?.emitsEntity, ENTITY_WITH_REFS, "壓縮端（上行/快照）逐鍵放行");
  const restored = toNodeMetadata(compacted);
  assert.deepEqual(restored.emitsEntity, ENTITY_WITH_REFS, "還原端（Blob/快照落地）逐位元存活");
  // 兩端各自獨立斷言：只活過一端（漏一端）＝功能當下被剝
  assert.deepEqual(toNodeMetadata({ emitsEntity: ENTITY_WITH_REFS }).emitsEntity, ENTITY_WITH_REFS, "還原端單獨吃原始 metadata 也放行");
  assert.deepEqual(
    (compactMetadataForAgent({ emitsEntity: ENTITY_WITH_REFS } as unknown as CanvasNodeMetadata) ?? {}).emitsEntity,
    ENTITY_WITH_REFS,
    "壓縮端單獨吃原始 metadata 也放行",
  );
});

test("聚合鍵清洗：只收非空字串、去重、trim；空集合省略鍵（兩端同一把尺）", () => {
  const dirty = {
    kind: "scene",
    referenceNodeIds: ["a", "", "  a  ", 123, null, "b"],
    referenceRoles: ["view2", "view2", "   "],
  };
  const restored = toNodeMetadata({ emitsEntity: dirty });
  assert.deepEqual(restored.emitsEntity, {
    kind: "scene",
    referenceNodeIds: ["a", "b"],
    referenceRoles: ["view2"],
  });
  assert.deepEqual(
    (compactMetadataForAgent({ emitsEntity: dirty } as unknown as CanvasNodeMetadata) ?? {}).emitsEntity,
    { kind: "scene", referenceNodeIds: ["a", "b"], referenceRoles: ["view2"] },
    "壓縮端同一把尺",
  );
  // 空集合 / 非陣列 → 省略該鍵（不是寫 []）
  for (const empty of [[], ["  "], "view2", 7, null, {}]) {
    const cleaned = toNodeMetadata({ emitsEntity: { kind: "prop", referenceNodeIds: empty, referenceRoles: empty } });
    assert.deepEqual(cleaned.emitsEntity, { kind: "prop" }, `referenceNodeIds=${JSON.stringify(empty)} 省略鍵`);
  }
});

test("聚合鍵清洗：單項截 100、項數上限 8（與卡參考圖上限同尺）", () => {
  const cleaned = toNodeMetadata({
    emitsEntity: {
      kind: "character",
      referenceNodeIds: [...Array.from({ length: 20 }, (_, i) => `n${i}`), "n".repeat(200)],
    },
  });
  const ids = cleaned.emitsEntity?.referenceNodeIds ?? [];
  assert.equal(ids.length, 8, "項數截到 8");
  assert.deepEqual(ids, ["n0", "n1", "n2", "n3", "n4", "n5", "n6", "n7"]);
  assert.equal(
    (toNodeMetadata({ emitsEntity: { kind: "character", referenceNodeIds: ["x".repeat(200)] } }).emitsEntity
      ?.referenceNodeIds ?? [])[0]?.length,
    100,
    "單項截 100",
  );
});

test("聚合鍵不合法時：kind 非法仍整包丟（聚合鍵救不回一個壞宣告）", () => {
  assert.deepEqual(toNodeMetadata({ emitsEntity: { kind: "banana", referenceNodeIds: ["a"] } }), {});
});

// ── 文本節點字號（2026-09-25）：白名單放行前它「session 內可見、重載即消失」 ──
// 寫入端＝context-menu-items.ts:155/156（Math.min(28,…)/Math.max(10,…)，缺省 14.5）
// 讀取端＝NodeBody.tsx:431；耐久化唯一路徑＝toNodeMetadata。本節釘死往復＋清洗界。

test("fontSize 往復合同：toNodeMetadata(compactMetadataForAgent({fontSize:22})).fontSize === 22", () => {
  const roundTrip = toNodeMetadata(compactMetadataForAgent({ fontSize: 22 } as CanvasNodeMetadata));
  assert.equal(roundTrip.fontSize, 22, "兩端都放行（漏一端＝重載/回舊會話掉字號）");
  assert.equal(compactMetadataForAgent({ fontSize: 22 } as CanvasNodeMetadata)?.fontSize, 22, "壓縮端單獨放行");
  assert.equal(toNodeMetadata({ fontSize: 22 }).fontSize, 22, "還原端單獨放行");
});

test("fontSize 清洗：夾在 10..28、四捨五入成整數；非有限數字省略該鍵（兩端同一把尺）", () => {
  assert.equal(toNodeMetadata({ fontSize: 100 }).fontSize, 28, "超上界收斂到 28");
  assert.equal(toNodeMetadata({ fontSize: -100 }).fontSize, 10, "超下界收斂到 10");
  assert.equal(toNodeMetadata({ fontSize: 14.5 }).fontSize, 15, "四捨五入（面板只寫整數）");
  assert.equal(toNodeMetadata({ fontSize: 14.4 }).fontSize, 14);
  for (const bad of ["22", NaN, Infinity, -Infinity, null, undefined, true, {}, []]) {
    const restored = toNodeMetadata({ fontSize: bad });
    assert.equal("fontSize" in restored, false, `fontSize=${String(bad)} 省略該鍵（不轉型、不代填 14.5）`);
    assert.deepEqual(compactMetadataForAgent({ fontSize: bad } as unknown as CanvasNodeMetadata), undefined, `壓縮端同一把尺：${String(bad)}`);
  }
});

test("fontSize 缺席＝零回歸：輸出物件逐位元不含該鍵（既有鍵集不變）", () => {
  const withoutFontSize = toNodeMetadata({ content: "正文", prompt: "p", model: "m", count: 2, status: "success" });
  assert.deepEqual(withoutFontSize, { content: "正文", prompt: "p", model: "m", count: 2, status: "success" });
  assert.equal(Object.keys(withoutFontSize).includes("fontSize"), false, "缺席時不新增恆存在鍵（不是 `fontSize: undefined`）");
  assert.deepEqual(
    (compactMetadataForAgent({ content: "正文" } as unknown as CanvasNodeMetadata) ?? {}).fontSize,
    undefined,
    "壓縮端缺席時同樣不多寫鍵",
  );
});
