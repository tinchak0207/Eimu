// compactMetadataForAgent 回归测试（2026-09-03 导演台「示意图未同步」事故）。
// 事故链：上行压缩白名单不含 director 栏位 → gateway 快照里导演台节点是空壳 →
// 刷新/恢复后还原出的节点缺 directorSessionId/SVG → NodeBody 落到兜底文案。
// 本测试钉死往复合同：压缩输出经 toNodeMetadata（还原端）后指针栏位原样存活。
import { test } from "node:test";
import assert from "node:assert/strict";
import { compactMetadataForAgent } from "./canvas-chat-types";
import { fromCanvasProject, toNodeMetadata } from "@/lib/canvas/layout";
import type { CanvasNodeMetadata } from "@/lib/canvas/types";
import type { StoryboardScriptShot } from "@/lib/storyboard-contract";

const BIG_SVG = `<svg>${"x".repeat(60 * 1024)}</svg>`;

test("director 节点压缩保留指针栏位、剔除 SVG", () => {
  const meta: CanvasNodeMetadata = {
    pipelineCard: "director",
    directorSessionId: "sess_abc123",
    planName: "分镜方案 A",
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
  assert.equal(compacted.planName, "分镜方案 A");
  assert.equal(compacted.shotCount, 6);
  assert.equal(compacted.healthOk, true);
  assert.equal(compacted.revision, 12);
  assert.equal(compacted.topViewSvg, undefined);
  assert.equal(compacted.cameraViewSvg, undefined);
});

test("压缩输出经还原端 toNodeMetadata 后 director 指针不丢（往复合同）", () => {
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

test("非 director 节点不受影响：SVG 栏位从不外传", () => {
  const compacted = compactMetadataForAgent({ content: "hello", topViewSvg: BIG_SVG });
  assert.deepEqual(compacted, { content: "hello" });
});

// ── 3D 场景卡（2026-09-06 Astra PRD P1-3）：sceneCard 栏位族往复合同 ──

const SCENE_CARD = {
  turntable_url: "https://cdn.example.com/turntable.mp4",
  stills_urls: ["https://cdn.example.com/s1.png", "https://cdn.example.com/s2.png", "https://cdn.example.com/s3.png"],
  blend_path: "/api/scene-assets/scene_01.blend",
  glb_path: "/api/scene-assets/scene_01.glb",
  scene_summary: "废弃灯塔主场景 · 白模已上材质",
  duration_ms: 8000,
};

test("scene_3d 节点压缩保留 sceneCard 六栏", () => {
  const compacted = compactMetadataForAgent({ sceneCard: SCENE_CARD });
  assert.ok(compacted);
  assert.deepEqual(compacted.sceneCard, SCENE_CARD);
});

test("压缩输出经还原端 toNodeMetadata 后 sceneCard 不丢（往复合同）", () => {
  const meta: CanvasNodeMetadata = { sceneCard: SCENE_CARD };
  const restored = toNodeMetadata(compactMetadataForAgent(meta));
  assert.deepEqual(restored.sceneCard, SCENE_CARD);
});

test("sceneCard 非契约形状在还原端整包丢弃（缺 turntable_url）", () => {
  const restored = toNodeMetadata({ sceneCard: { stills_urls: ["x.png"], scene_summary: "残形" } });
  assert.equal(restored.sceneCard, undefined);
});

test("非 scene_3d 节点不受影响：无 sceneCard 不外传空栏位", () => {
  const compacted = compactMetadataForAgent({ content: "hello" });
  assert.deepEqual(compacted, { content: "hello" });
});

// ── 分镜实体（2026-09-15 刀 2）：storyboardShot/storyboardScene 栏位族往复合同 ──
// 完整契约测试在 src/lib/storyboard-contract.test.ts；此处只钉「压缩器这一端有接上」，
// 即双白名单第二处（本档）不漏栏——漏了就刷新/换装置后 21 栏空壳。

test("分镜节点压缩保留 storyboardShot 21 栏与 storyboardScene", () => {
  const shot: StoryboardScriptShot = {
    shotNumber: "001",
    scriptContent: "正文片段",
    visualDescription: "中景，推门而入",
    dialogue: "[林昭]：「有人吗」",
    actionState: "推门、环视",
    narrativeFunction: "建立悬念",
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

test("压缩输出经还原端 toNodeMetadata 后分镜栏位不丢（往复合同）", () => {
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
// ── 分镜实体卡引用＋落卡标记（WS7 收口，2026-09-24）：双白名单第二处的往复合同 ──
// 病灶同构：漏这一端 = 回旧会话/换装置还原（fromCanvasProject → toNodeMetadata）后
// 分镜节点失去卡引用、落卡标记消失 → 自动落卡的回填与幂等只在 session 内有效。

test("分镜卡引用＋落卡标记压缩保留（四栏逐位元）", () => {
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

test("压缩输出经还原端 toNodeMetadata 后四栏逐位元还在（往复合同）", () => {
  const meta: CanvasNodeMetadata = {
    characterCardIds: ["card-node-char-1", "card-hand-made"],
    sceneCardIds: ["card-node-scene-1"],
    propCardIds: ["card-node-prop-1"],
    entityCardId: "card-node-char-1",
  };
  const restored = toNodeMetadata(compactMetadataForAgent(meta));
  assert.deepEqual(restored.characterCardIds, ["card-node-char-1", "card-hand-made"], "卡 id 顺序原样（顺序是语义）");
  assert.deepEqual(restored.sceneCardIds, ["card-node-scene-1"]);
  assert.deepEqual(restored.propCardIds, ["card-node-prop-1"]);
  assert.equal(restored.entityCardId, "card-node-char-1", "落卡标记不丢（否则重载后幂等判定失去依据）");
});

test("卡引用栏清洗：空/空白 → 键不存在；['a','','a'] → ['a']（压缩端与还原端同一把尺）", () => {
  // 压缩端
  const compacted = compactMetadataForAgent({
    characterCardIds: ["a", "", "a"],
    sceneCardIds: [],
    propCardIds: ["   "],
  });
  assert.deepEqual(compacted, { characterCardIds: ["a"] }, "去重＋剔空；空阵列/纯空白栏不写进快照");
  // 还原端（同一批脏值）
  const restored = toNodeMetadata({
    characterCardIds: ["a", "", "a"],
    sceneCardIds: [],
    propCardIds: ["   "],
    entityCardId: "   ",
  });
  assert.deepEqual(restored, { characterCardIds: ["a"] }, "还原端逐栏收敛：空栏省略、标记纯空白＝没有标记");
});

test("卡引用栏非阵列/脏元素不落地（不伪造 id、不炸）", () => {
  const restored = toNodeMetadata({
    characterCardIds: "card-node-char-1",
    sceneCardIds: [7, null, { id: "x" }, "card-node-scene-1"],
    propCardIds: undefined,
    entityCardId: 42,
  });
  assert.deepEqual(restored, { sceneCardIds: ["card-node-scene-1"] }, "只留真字串 id，其余丢弃");
});

test("安全边界：通道只放行这四栏，其余 metadata 键照旧不外传", () => {
  const compacted = compactMetadataForAgent({
    characterCardIds: ["card-node-char-1"],
    // 任何其他栏位（含未列白名单的既有栏位）都不得因此被放行
    someNewKey: "leak",
    referenceNodeIds: ["n1"],
    topViewSvg: BIG_SVG,
  } as CanvasNodeMetadata);
  assert.deepEqual(compacted, { characterCardIds: ["card-node-char-1"] }, "四栏以外零放行");
});

// ── 模板实体宣告＋卡名来源（WS10，2026-09-24）：双白名单第二处的往复合同 ──
// 病灶（已实锤的断点）：闸道 `expandTemplate` 把模板 `defaults.emitsEntity` spread 进
// 节点 metadata，前端落地时被白名单剥掉 → `agent-output-cards.emittedEntityOf` 回 null
// → 整条「agent 交付自动落卡」在真画布上不可能触发（0 卡）。本节钉死这一端不漏栏。

const ENTITY_DECL = { kind: "character" as const, nameFrom: "input" as const };

test("压缩端保留 emitsEntity 与卡名三键（逐位元），且回传新物件（不与输入同参考）", () => {
  const rawDeclaration = { kind: "character", nameFrom: "input" };
  const compacted = compactMetadataForAgent({
    emitsEntity: rawDeclaration,
    input: "霍辞渊",
    characterName: "备选名",
    sceneName: "旧宅",
  } as unknown as CanvasNodeMetadata);
  assert.deepEqual(compacted, { emitsEntity: ENTITY_DECL, input: "霍辞渊", characterName: "备选名", sceneName: "旧宅" });
  assert.notEqual(compacted!.emitsEntity, rawDeclaration, "必须是新物件（gateway 浅 spread 让宣告与模板模组层同参考，沿用会跨会话污染）");
});

test("往复合同：压缩 → 还原端 toNodeMetadata 后 emitsEntity 与卡名逐位元还在", () => {
  const meta = {
    emitsEntity: { kind: "scene", nameFrom: "input" },
    input: "客厅-黄昏",
    characterName: "不该当场景名用",
    sceneName: "客厅",
  } as unknown as CanvasNodeMetadata;
  const restored = toNodeMetadata(compactMetadataForAgent(meta));
  // nameFrom:"input" 的候选键顺序由 agent-output-cards 决定（input → characterName → sceneName）：
  // 通道端只负责「三个键都活著过去」，不重排、不改值。
  assert.deepEqual((restored as { emitsEntity?: unknown }).emitsEntity, { kind: "scene", nameFrom: "input" });
  assert.equal((restored as { input?: string }).input, "客厅-黄昏");
  assert.equal((restored as { characterName?: string }).characterName, "不该当场景名用");
  assert.equal((restored as { sceneName?: string }).sceneName, "客厅");
});

test("emitsEntity 清洗：kind 不在五值域 → 两端都整包丢（不降格成 character）", () => {
  for (const kind of ["banana", "", 7, null, "CHARACTER", undefined]) {
    const meta = { emitsEntity: { kind } } as unknown as CanvasNodeMetadata;
    assert.equal(compactMetadataForAgent(meta), undefined, `压缩端：kind=${String(kind)} 整包丢`);
    assert.deepEqual(toNodeMetadata({ emitsEntity: { kind } }), {}, `还原端：kind=${String(kind)} 整包丢`);
  }
  // 非物件形态（字串/阵列/数字）同样不进通道
  for (const raw of ["character", ["character"], 3, true]) {
    assert.deepEqual(toNodeMetadata({ emitsEntity: raw }), {}, `还原端：非物件 ${JSON.stringify(raw)} 丢弃`);
  }
});

test("emitsEntity 清洗：nameFrom 非两值 → 省略该栏（kind 仍有效）；五值域全收", () => {
  for (const kind of ["character", "scene", "style", "prop", "audio"]) {
    assert.deepEqual(toNodeMetadata({ emitsEntity: { kind } }), { emitsEntity: { kind } }, `kind=${kind} 必收`);
  }
  for (const nameFrom of ["nonsense", 42, null, ""]) {
    assert.deepEqual(
      toNodeMetadata({ emitsEntity: { kind: "prop", nameFrom } }),
      { emitsEntity: { kind: "prop" } },
      `nameFrom=${String(nameFrom)} 只省该栏`,
    );
  }
  assert.deepEqual(toNodeMetadata({ emitsEntity: { kind: "prop", nameFrom: "nodeTitle" } }), {
    emitsEntity: { kind: "prop", nameFrom: "nodeTitle" },
  });
});

test("卡名三键清洗：空白/非字串 → 省略键；超长截 100（两端同一把尺）", () => {
  const dirty = {
    input: "   ",
    characterName: 42,
    sceneName: "场".repeat(200),
  } as unknown as CanvasNodeMetadata;
  const restored = toNodeMetadata(dirty);
  assert.deepEqual(restored, { sceneName: "场".repeat(100) }, "只留真字串且非空，长度截到 100（卡名上限）");
  const compacted = compactMetadataForAgent(dirty);
  assert.deepEqual(compacted, { sceneName: "场".repeat(100) }, "压缩端同一把尺（不留空栏进快照）");
});

test("安全边界：卡名三键不放行同名的其他 metadata 键（输入不因此外泄）", () => {
  const compacted = compactMetadataForAgent({
    input: "角色名",
    description: "不该外传",
    key_features: ["不该外传"],
  } as unknown as CanvasNodeMetadata);
  assert.deepEqual(compacted, { input: "角色名" }, "只放行三键本身");
});

// ── 四视图聚合的参考图键（2026-09-24）：双白名单的第二刀 ──
// 病灶同族（WS10 实锤）：`emitsEntity` 内新增的键若漏放行，**当下就被剥**（不是重载才消失）
// → `referenceNodeIds` 永远 undefined → 整条聚合功能不可能触发（症状＝完全没反应）。
// 本节用**真** compactMetadataForAgent → **真** toNodeMetadata 往返（不写替代品当 oracle）。

const ENTITY_WITH_REFS = {
  kind: "character" as const,
  nameFrom: "input" as const,
  referenceRoles: ["view2", "view3", "view4"],
  referenceNodeIds: ["tpl-view2-9", "tpl-view3-9", "tpl-view4-9"],
};

test("聚合键往复合同：经压缩端 → 还原端后 referenceRoles/referenceNodeIds 逐位元还在", () => {
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
  assert.deepEqual(compacted?.emitsEntity, ENTITY_WITH_REFS, "压缩端（上行/快照）逐键放行");
  const restored = toNodeMetadata(compacted);
  assert.deepEqual(restored.emitsEntity, ENTITY_WITH_REFS, "还原端（Blob/快照落地）逐位元存活");
  // 两端各自独立断言：只活过一端（漏一端）＝功能当下被剥
  assert.deepEqual(toNodeMetadata({ emitsEntity: ENTITY_WITH_REFS }).emitsEntity, ENTITY_WITH_REFS, "还原端单独吃原始 metadata 也放行");
  assert.deepEqual(
    (compactMetadataForAgent({ emitsEntity: ENTITY_WITH_REFS } as unknown as CanvasNodeMetadata) ?? {}).emitsEntity,
    ENTITY_WITH_REFS,
    "压缩端单独吃原始 metadata 也放行",
  );
});

test("聚合键清洗：只收非空字串、去重、trim；空集合省略键（两端同一把尺）", () => {
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
    "压缩端同一把尺",
  );
  // 空集合 / 非阵列 → 省略该键（不是写 []）
  for (const empty of [[], ["  "], "view2", 7, null, {}]) {
    const cleaned = toNodeMetadata({ emitsEntity: { kind: "prop", referenceNodeIds: empty, referenceRoles: empty } });
    assert.deepEqual(cleaned.emitsEntity, { kind: "prop" }, `referenceNodeIds=${JSON.stringify(empty)} 省略键`);
  }
});

test("聚合键清洗：单项截 100、项数上限 8（与卡参考图上限同尺）", () => {
  const cleaned = toNodeMetadata({
    emitsEntity: {
      kind: "character",
      referenceNodeIds: [...Array.from({ length: 20 }, (_, i) => `n${i}`), "n".repeat(200)],
    },
  });
  const ids = cleaned.emitsEntity?.referenceNodeIds ?? [];
  assert.equal(ids.length, 8, "项数截到 8");
  assert.deepEqual(ids, ["n0", "n1", "n2", "n3", "n4", "n5", "n6", "n7"]);
  assert.equal(
    (toNodeMetadata({ emitsEntity: { kind: "character", referenceNodeIds: ["x".repeat(200)] } }).emitsEntity
      ?.referenceNodeIds ?? [])[0]?.length,
    100,
    "单项截 100",
  );
});

test("聚合键不合法时：kind 非法仍整包丢（聚合键救不回一个坏宣告）", () => {
  assert.deepEqual(toNodeMetadata({ emitsEntity: { kind: "banana", referenceNodeIds: ["a"] } }), {});
});

// ── 文本节点字号（2026-09-25）：白名单放行前它「session 内可见、重载即消失」 ──
// 写入端＝context-menu-items.ts:155/156（Math.min(28,…)/Math.max(10,…)，缺省 14.5）
// 读取端＝NodeBody.tsx:431；耐久化唯一路径＝toNodeMetadata。本节钉死往复＋清洗界。

test("fontSize 往复合同：toNodeMetadata(compactMetadataForAgent({fontSize:22})).fontSize === 22", () => {
  const roundTrip = toNodeMetadata(compactMetadataForAgent({ fontSize: 22 } as CanvasNodeMetadata));
  assert.equal(roundTrip.fontSize, 22, "两端都放行（漏一端＝重载/回旧会话掉字号）");
  assert.equal(compactMetadataForAgent({ fontSize: 22 } as CanvasNodeMetadata)?.fontSize, 22, "压缩端单独放行");
  assert.equal(toNodeMetadata({ fontSize: 22 }).fontSize, 22, "还原端单独放行");
});

test("fontSize 清洗：夹在 10..28、四舍五入成整数；非有限数字省略该键（两端同一把尺）", () => {
  assert.equal(toNodeMetadata({ fontSize: 100 }).fontSize, 28, "超上界收敛到 28");
  assert.equal(toNodeMetadata({ fontSize: -100 }).fontSize, 10, "超下界收敛到 10");
  assert.equal(toNodeMetadata({ fontSize: 14.5 }).fontSize, 15, "四舍五入（面板只写整数）");
  assert.equal(toNodeMetadata({ fontSize: 14.4 }).fontSize, 14);
  for (const bad of ["22", NaN, Infinity, -Infinity, null, undefined, true, {}, []]) {
    const restored = toNodeMetadata({ fontSize: bad });
    assert.equal("fontSize" in restored, false, `fontSize=${String(bad)} 省略该键（不转型、不代填 14.5）`);
    assert.deepEqual(compactMetadataForAgent({ fontSize: bad } as unknown as CanvasNodeMetadata), undefined, `压缩端同一把尺：${String(bad)}`);
  }
});

test("fontSize 缺席＝零回归：输出物件逐位元不含该键（既有键集不变）", () => {
  const withoutFontSize = toNodeMetadata({ content: "正文", prompt: "p", model: "m", count: 2, status: "success" });
  assert.deepEqual(withoutFontSize, { content: "正文", prompt: "p", model: "m", count: 2, status: "success" });
  assert.equal(Object.keys(withoutFontSize).includes("fontSize"), false, "缺席时不新增恒存在键（不是 `fontSize: undefined`）");
  assert.deepEqual(
    (compactMetadataForAgent({ content: "正文" } as unknown as CanvasNodeMetadata) ?? {}).fontSize,
    undefined,
    "压缩端缺席时同样不多写键",
  );
});

// ── 双白名单收口（2026-09-24）：门禁裁决 gateConfirm ＋ 分镜批准 approval ──
// 两键同族同写法（结构化物件、走与还原端同一份清洗、残形整包丢弃）。
// 病灶：两端任一漏放行＝「同会话内看起来正常、刷新/回旧会话后凭空消失」——
// 门禁卡退回纯文字（按不下批准）、分镜审查面板退回「未批准」。属最重的一类静默失败。

const GATE_CONFIRM = { request_id: "wfgate_wf1_cast_card_abc", session_id: "sess_1", status: "pending" } as const;
const APPROVAL = { status: "rejected", decidedAt: "2026-09-24T10:00:00.000Z", reason: "第 3 镜服装不一致" } as const;

test("往复不丢：真 metadata（approval ＋ gateConfirm）→ 压缩 → fromCanvasProject 还原后两键逐位相同", () => {
  const meta: CanvasNodeMetadata = {
    prompt: "第 3 镜 少年推门",
    gateConfirm: { ...GATE_CONFIRM },
    approval: { ...APPROVAL },
  };
  // 上行：真压缩端（canvas-project-sync 上行的就是这个函式的输出）
  const compacted = compactMetadataForAgent(meta);
  assert.deepEqual(compacted?.gateConfirm, GATE_CONFIRM, "压缩端放行 gateConfirm");
  assert.deepEqual(compacted?.approval, APPROVAL, "压缩端放行 approval（含 decidedAt/reason 逐栏）");

  // 下行：真还原入口（use-canvas-chat.restoreAgentSnapshot → fromCanvasProject → toNodeMetadata），
  // 不是直接喂 toNodeMetadata——中间的节点形状校验也必须让两键活著。
  const restored = fromCanvasProject({ nodes: [{ id: "shot-1", type: "text", title: "第 3 镜", metadata: compacted }] });
  assert.equal(restored.nodes.length, 1);
  assert.deepEqual(restored.nodes[0]?.metadata?.gateConfirm, GATE_CONFIRM, "还原后 gateConfirm 逐位相同");
  assert.deepEqual(restored.nodes[0]?.metadata?.approval, APPROVAL, "还原后 approval 逐位相同");
  assert.deepEqual(toNodeMetadata(compacted), meta, "两键与其他 metadata 同存时互不干扰（整包等价）");
});

test("两键是独立键：只带 approval 不伪造 gateConfirm（反之亦然），不合并不互推", () => {
  const onlyApproval = compactMetadataForAgent({ approval: { ...APPROVAL } });
  assert.deepEqual(onlyApproval, { approval: APPROVAL });
  const onlyGate = compactMetadataForAgent({ gateConfirm: { ...GATE_CONFIRM } });
  assert.deepEqual(onlyGate, { gateConfirm: GATE_CONFIRM });
  assert.equal("gateConfirm" in (onlyApproval ?? {}), false, "没有裁决凭据就不写该键");
  assert.equal("approval" in (onlyGate ?? {}), false, "没有批准状态就不写该键");
});

test("负对照：残形/缺栏的输入整包丢弃，不得半形半套（两端同一把尺）", () => {
  // gateConfirm：三栏缺一不可（缺 request_id 的卡按不下批准）
  const badGate = [
    { session_id: "s", status: "pending" },
    { request_id: "r", status: "pending" },
    { request_id: "r", session_id: "s", status: "weird" },
    "pending",
    null,
    42,
  ];
  for (const bad of badGate) {
    assert.deepEqual(
      compactMetadataForAgent({ gateConfirm: bad } as unknown as CanvasNodeMetadata),
      undefined,
      `压缩端丢弃残形 gateConfirm：${JSON.stringify(bad)}`,
    );
    assert.equal("gateConfirm" in toNodeMetadata({ gateConfirm: bad }), false, `还原端同一把尺：${JSON.stringify(bad)}`);
  }
  // approval：status 三值域之外＝整包丢弃（读不懂的值不猜成 pending 也不猜成 approved）
  const badApproval = [
    { status: "maybe" },
    { reason: "只给理由不给结论" },
    { status: "approved", decidedAt: 123 },
    "",
    null,
    [],
  ];
  for (const bad of badApproval) {
    const compacted = compactMetadataForAgent({ approval: bad } as unknown as CanvasNodeMetadata);
    if (bad && typeof bad === "object" && (bad as { status?: string }).status === "approved") {
      // decidedAt 非字串＝该栏省略，但 status 合法 → 键照留（批准结论可信）
      assert.deepEqual(compacted, { approval: { status: "approved" } }, "非字串 decidedAt 只丢该栏，不丢整个结论");
      continue;
    }
    assert.deepEqual(compacted, undefined, `压缩端丢弃残形 approval：${JSON.stringify(bad)}`);
  }
});

test("脏 approval 走卡侧同一收口：reason 裁剪/空白省略（不在节点侧另立判据）", () => {
  const compacted = compactMetadataForAgent({
    approval: { status: "rejected", decidedAt: "2026-09-24T10:00:00.000Z", reason: "   " },
  } as unknown as CanvasNodeMetadata);
  assert.deepEqual(compacted, { approval: { status: "rejected", decidedAt: "2026-09-24T10:00:00.000Z" } }, "纯空白理由＝没有理由（栏位省略）");
});

test("缺席＝零回归：既有键集逐位元不变（不多写恒存在的空键）", () => {
  const baseline = toNodeMetadata({ content: "正文", gate: "剧本人工批准", count: 2 });
  assert.deepEqual(baseline, { content: "正文", gate: "剧本人工批准", count: 2 });
  assert.deepEqual(compactMetadataForAgent({ content: "正文", gate: "剧本人工批准" } as unknown as CanvasNodeMetadata), {
    content: "正文",
    gate: "剧本人工批准",
  });
});

test("全自动档不受影响：两键的存续与 interaction_mode 无关（纯资料传输，不带档位判断）", () => {
  // 门禁/批准是「资料在不在」，不是「挡不挡」——档位语义只活在 isAssetApproved/网关闸，
  // 白名单端两个档位走同一条路（否则 auto 档的门禁卡刷新后也会退回纯文字）。
  const meta = { gateConfirm: { ...GATE_CONFIRM }, approval: { status: "approved" } } as CanvasNodeMetadata;
  const roundTrip = fromCanvasProject({ nodes: [{ id: "n", type: "text", title: "t", metadata: compactMetadataForAgent(meta) }] });
  assert.deepEqual(roundTrip.nodes[0]?.metadata?.gateConfirm, GATE_CONFIRM);
  assert.deepEqual(roundTrip.nodes[0]?.metadata?.approval, { status: "approved" });
});
