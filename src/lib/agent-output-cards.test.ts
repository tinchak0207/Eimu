// WS4 行为断言（2026-09-24）：模板节点交付 → 实体卡自动落卡。
//
// 全部是**行为断言**（真跑函式看输出），不钉源码字串：
//   - 卡物件一律用 `normalizeCharacterCard`（既有唯一收口）当 oracle 反证合法性 + 逐栏相等
//   - 模板端到端用**真** `expandTemplate`（gateway 引擎）产生节点，且产出**真的穿过**
//     `compactMetadataForAgent → toNodeMetadata` 这个传输边界再喂本档函式
//
// WS10（2026-09-24）修正本档一条假 oracle：旧版 `nodesFromTemplate()` 自写重实作了
// `expandTemplate` 的 merge、且从不经过 `toNodeMetadata` → 前端白名单剥掉 `emitsEntity`
// 时它照样全绿（整条自动落卡在真画布上不可能触发却验不出来）。现在 oracle 换成
// 「真引擎输出」＋「真白名单函式」两者——都不属于被测实现本身。

import { test } from "node:test";
import assert from "node:assert/strict";
import { isAssetApproved, normalizeCharacterCard } from "./character-cards";
import {
  ENTITY_CARD_ID_PREFIX,
  cardFromEntityNode,
  emittedCardsForNodes,
  emittedEntityOf,
  entityCardIdForNode,
  toAgentOutputNodeRef,
  type AgentOutputNodeRef,
  type ShotEntityBackfill,
} from "./agent-output-cards";
import { toNodeMetadata } from "./canvas/layout";
import { compactMetadataForAgent } from "../hooks/canvas/canvas-chat-types";
import type { CanvasNodeMetadata } from "./canvas/types";
import { expandTemplate } from "../../deploy-staging/gateway/workflow-engine";
import { WORKFLOW_TEMPLATES } from "../../deploy-staging/gateway/workflow-templates/index";

const IMG = "https://cdn.example.com/out/view-1.png";
// 四视图另外三张（独立输入，当聚合断言的 oracle：喂进去的就是该被收回来的）
const IMG2 = "https://cdn.example.com/out/view-2.png";
const IMG3 = "https://cdn.example.com/out/view-3.png";
const IMG4 = "https://cdn.example.com/out/view-4.png";

function node(overrides: Partial<AgentOutputNodeRef> & { id: string }): AgentOutputNodeRef {
  return { title: "正面", ...overrides };
}

function marked(kind: string, content?: string, extra: Record<string, unknown> = {}): AgentOutputNodeRef {
  return node({ id: "tpl-view1-2", metadata: { emitsEntity: { kind, nameFrom: "input" }, ...(content ? { content } : {}), ...extra } });
}

// ─────────────────────────────────────────── emittedEntityOf

test("emittedEntityOf：没有标记 → null；metadata 缺席/非物件 → null", () => {
  assert.equal(emittedEntityOf({ id: "n1" }), null);
  assert.equal(emittedEntityOf({ id: "n1", metadata: null }), null);
  assert.equal(emittedEntityOf({ id: "n1", metadata: {} }), null);
  assert.equal(emittedEntityOf({ id: "n1", metadata: { emitsEntity: "character" } }), null);
  assert.equal(emittedEntityOf({ id: "n1", metadata: { emitsEntity: ["character"] } }), null);
});

test("emittedEntityOf：kind 乱填/缺席 → null（不猜成 character）", () => {
  for (const kind of ["banana", "", 7, null, undefined, "CHARACTER"]) {
    assert.equal(emittedEntityOf({ id: "n1", metadata: { emitsEntity: { kind } } }), null, `kind=${String(kind)}`);
  }
  assert.equal(emittedEntityOf({ id: "n1", metadata: { emitsEntity: {} } }), null);
});

test("emittedEntityOf：kind 五值域全收；nameFrom 非 input 一律 nodeTitle", () => {
  for (const kind of ["character", "scene", "style", "prop", "audio"]) {
    assert.deepEqual(emittedEntityOf({ id: "n1", metadata: { emitsEntity: { kind } } }), { kind, nameFrom: "nodeTitle" });
  }
  for (const nameFrom of ["input", "nodeTitle", "nonsense", 42, null]) {
    const spec = emittedEntityOf({ id: "n1", metadata: { emitsEntity: { kind: "scene", nameFrom } } });
    assert.deepEqual(spec, { kind: "scene", nameFrom: nameFrom === "input" ? "input" : "nodeTitle" });
  }
});

// ─────────────────────────────────────────── entityCardIdForNode

test("entityCardIdForNode：产出的 id 真的过得了 normalizeCharacterCard（含 `:` 与超长 nodeId）", () => {
  const ids = [
    "character_sheet-view1-2",
    "scene_setup-result-2",
    "ses_abc:node:7", // 含 `:`（作用域键段分隔符）→ 必须被改写，否则整张卡被拒
    "a".repeat(400), // 超长 → 截到 100
    "有中文的:节点 id",
    "with\u0000control\u007fchars:1",
    "",
  ];
  for (const raw of ids) {
    const id = entityCardIdForNode(raw);
    assert.ok(id.length <= 100, `id 长度 ≤100：${id}`);
    assert.ok(!id.includes(":"), `id 不得含 \`:\`：${id}`);
    const card = normalizeCharacterCard({ id, name: "x" });
    assert.ok(card, `normalizeCharacterCard 必须收下 ${JSON.stringify(raw)} → ${id}`);
    assert.equal(card!.id, id);
  }
});

test("entityCardIdForNode：决定性/可重入（同节点同 id）、不同节点不同 id", () => {
  assert.equal(entityCardIdForNode("character_sheet-view1-2"), entityCardIdForNode("character_sheet-view1-2"));
  assert.notEqual(entityCardIdForNode("character_sheet-view1-2"), entityCardIdForNode("character_sheet-view2-3"));
  // `:` 换 `-` 后可能撞名（同一个节点仍必同 id；不同节点撞名是可接受的碰撞，不制造非法 id）
  assert.equal(entityCardIdForNode("a:b"), entityCardIdForNode("a-b"));
  assert.ok(!entityCardIdForNode("a:b").includes(":"));
});

test("ENTITY_CARD_ID_PREFIX：与 entityCardIdForNode 的真实输出对齐（真 nodeId 逐字断言）", () => {
  const nodeId = "character_sheet-view1-2";
  const id = entityCardIdForNode(nodeId);
  assert.ok(id.startsWith(ENTITY_CARD_ID_PREFIX), `${id} 必带前缀 ${ENTITY_CARD_ID_PREFIX}`);
  assert.equal(id, `${ENTITY_CARD_ID_PREFIX}${nodeId}`, "无需清洗的 nodeId：前缀 + 原 id 逐字相等");
  // 清洗路径（含 `:` / 控制字元 / 超长）也维持前缀——回填的 startsWith 判定不会漏卡
  for (const raw of ["ses_abc:node:7", "with\u0000ctrl:1", "a".repeat(400)]) {
    assert.ok(entityCardIdForNode(raw).startsWith(ENTITY_CARD_ID_PREFIX), `清洗后仍带前缀：${raw}`);
  }
  // 前缀本身过得了卡 id 界线（否则回填的判定与卡实体会是两套事实）
  assert.ok(normalizeCharacterCard({ id, name: "x" }));
});

// ─────────────────────────────────────────── cardFromEntityNode

test("cardFromEntityNode：真节点 → 真卡，且 normalizeCharacterCard(card) 与 card 逐栏相等", () => {
  const card = cardFromEntityNode(
    marked("character", IMG, {
      input: "霍辞渊",
      deliverable: "正面设定图，锁定面部基线 face_identity",
    }),
    [],
  );
  assert.ok(card);
  assert.equal(card!.id, entityCardIdForNode("tpl-view1-2"));
  assert.equal(card!.name, "霍辞渊");
  assert.equal(card!.kind, "character");
  assert.equal(card!.prompt, "正面设定图，锁定面部基线 face_identity");
  assert.deepEqual(card!.references, [{ url: IMG, role: "character", name: "霍辞渊" }]);
  assert.match(card!.createdAt, /^\d{4}-\d{2}-\d{2}T/);
  assert.equal(card!.updatedAt, card!.createdAt);

  const normalized = normalizeCharacterCard(card);
  assert.ok(normalized, "产出的卡必须过 normalizeCharacterCard");
  assert.deepEqual(normalized, card, "逐栏相等（栏位不多不少、值已被同一把尺界定）");
  assert.deepEqual(Object.keys(card!).sort(), ["createdAt", "id", "kind", "name", "prompt", "references", "updatedAt"]);
});

test("cardFromEntityNode：边界值（超长 prompt/超长名）仍与 normalizeCharacterCard 逐栏相等", () => {
  const card = cardFromEntityNode(
    marked("scene", IMG, { input: "场".repeat(500), deliverable: "d".repeat(5000) }),
    [],
  );
  assert.ok(card);
  assert.equal(card!.name.length, 100);
  assert.equal(card!.prompt.length, 2000);
  assert.equal(card!.references[0].name.length, 60);
  assert.deepEqual(normalizeCharacterCard(card), card);
});

test("cardFromEntityNode：没有交付物 → null（绝不建空卡）", () => {
  assert.equal(cardFromEntityNode(marked("character"), []), null); // 完全没有 content
  assert.equal(cardFromEntityNode(marked("character", ""), []), null);
  assert.equal(cardFromEntityNode(marked("character", "   "), []), null);
  assert.equal(cardFromEntityNode(marked("character", "/tmp/local.png"), []), null);
  assert.equal(cardFromEntityNode(marked("character", "data:text/plain;base64,AAAA"), []), null);
  assert.equal(cardFromEntityNode(marked("character", { url: IMG } as unknown as string), []), null);
  // audio 的载体是媒体 URL（blob/local 路径不算）
  assert.equal(cardFromEntityNode(marked("audio", "data:image/png;base64,AAAA"), []), null);
  assert.ok(cardFromEntityNode(marked("audio", "data:audio/mpeg;base64,AAAA", { input: "主角配音" }), []));
});

test("cardFromEntityNode：未宣告 emitsEntity 的节点（即使有图）→ null", () => {
  assert.equal(cardFromEntityNode(node({ id: "plain-1", metadata: { content: IMG } }), []), null);
  assert.equal(cardFromEntityNode(node({ id: "plain-1", metadata: { content: IMG, emitsEntity: { kind: "nope" } } }), []), null);
});

test("cardFromEntityNode：existing 已有同 id → null（幂等），别张卡不影响", () => {
  const existing = normalizeCharacterCard({ id: entityCardIdForNode("tpl-view1-2"), name: "旧卡" });
  assert.ok(existing);
  assert.equal(cardFromEntityNode(marked("character", IMG, { input: "霍辞渊" }), [existing!]), null);
  assert.ok(cardFromEntityNode(marked("character", IMG, { input: "霍辞渊" }), [normalizeCharacterCard({ id: "other", name: "x" })!]));
});

test("cardFromEntityNode：没有名字 → null（nameFrom:input 与 nodeTitle 两条路都空）", () => {
  const noTitle = node({ id: "tpl-view1-2", title: undefined, metadata: { emitsEntity: { kind: "character", nameFrom: "nodeTitle" }, content: IMG } });
  assert.equal(cardFromEntityNode(noTitle, []), null);
  const emptyTitle = node({ id: "tpl-view1-2", title: "   ", metadata: { emitsEntity: { kind: "character", nameFrom: "input" }, content: IMG } });
  assert.equal(cardFromEntityNode(emptyTitle, []), null);
  // nameFrom:input 取不到 → 退回标题；标题在 → 建卡
  const fallback = node({ id: "tpl-view1-2", title: "正面", metadata: { emitsEntity: { kind: "character", nameFrom: "input" }, content: IMG, input: "" } });
  assert.equal(cardFromEntityNode(fallback, [])?.name, "正面");
});

test("cardFromEntityNode：nameFrom:input 依序取 input → characterName → sceneName", () => {
  const build = (metadata: Record<string, unknown>) =>
    cardFromEntityNode(node({ id: "tpl-view1-2", title: "正面", metadata: { emitsEntity: { kind: "character", nameFrom: "input" }, content: IMG, ...metadata } }), []);
  assert.equal(build({ sceneName: "C", characterName: "B", input: "A" })?.name, "A");
  assert.equal(build({ sceneName: "C", characterName: "B", input: "  " })?.name, "B");
  assert.equal(build({ sceneName: "C" })?.name, "C");
  // 非字串不算名字（不 toString 猜）
  assert.equal(build({ input: { name: "A" } })?.name, "正面");
  // nodeTitle 模式不看 input
  const titled = cardFromEntityNode(node({ id: "tpl-view1-2", title: "正面", metadata: { emitsEntity: { kind: "character", nameFrom: "nodeTitle" }, content: IMG, input: "A" } }), []);
  assert.equal(titled?.name, "正面");
});

test("cardFromEntityNode：kind → references[0].role 映射；audio 不建参考图", () => {
  const roles: Record<string, string> = { character: "character", scene: "composition", prop: "product", style: "style" };
  for (const [kind, role] of Object.entries(roles)) {
    const card = cardFromEntityNode(marked(kind, IMG, { input: "甲" }), []);
    assert.ok(card, `${kind} 应该建卡`);
    assert.deepEqual(card!.references.map((r) => r.role), [role]);
    assert.deepEqual(normalizeCharacterCard(card), card);
  }
  const audio = cardFromEntityNode(marked("audio", "https://cdn.example.com/vo.mp3", { input: "旁白" }), []);
  assert.ok(audio);
  assert.equal(audio!.kind, "audio");
  assert.deepEqual(audio!.references, [], "audio 卡的载体是 prompt 片段，不塞图片参考");
  assert.deepEqual(normalizeCharacterCard(audio), audio);
});

test("cardFromEntityNode：prompt 取 deliverable → dna → signature，都没有回空字串（纯参考图卡合法）", () => {
  const build = (metadata: Record<string, unknown>) => cardFromEntityNode(marked("character", IMG, { input: "甲", ...metadata }), [])?.prompt;
  assert.equal(build({ deliverable: "D", dna: "N", signature: "S" }), "D");
  assert.equal(build({ doodle: "x", dna: "N", signature: "S" }), "N");
  assert.equal(build({ signature: "S" }), "S");
  assert.equal(build({}), "");
});

// ─────────────────────────────────────────── emittedCardsForNodes

test("emittedCardsForNodes：幂等——同输入跑两次，第二次 cards/lockedIds 为空", () => {
  const nodes = [marked("character", IMG, { input: "霍辞渊" })];
  const first = emittedCardsForNodes(nodes, []);
  assert.equal(first.cards.length, 1);
  assert.deepEqual(first.lockedIds, [first.cards[0].id]);
  const second = emittedCardsForNodes(nodes, first.cards);
  assert.deepEqual(second.cards, []);
  assert.deepEqual(second.lockedIds, []);
  assert.deepEqual(second.shotBackfill, []);
});

test("emittedCardsForNodes：metadata.entityCardId 已存在 → 跳过（即使卡不在 existing 里）", () => {
  const nodes = [marked("character", IMG, { input: "霍辞渊", entityCardId: entityCardIdForNode("tpl-view1-2") })];
  const result = emittedCardsForNodes(nodes, []);
  assert.deepEqual(result.cards, []);
  assert.deepEqual(result.lockedIds, []);
});

test("emittedCardsForNodes：多节点去重、同 kind 多卡、未知标记不落卡", () => {
  const nodes = [
    marked("character", IMG, { input: "霍辞渊" }),
    node({ id: "tpl-view2-3", title: "侧面", metadata: { content: IMG } }), // 没宣告 → 不落卡（四视图只标 view1）
    node({ id: "tpl-view3-4", title: "背面", metadata: { content: "" } }),
    node({ id: "tpl-scene-2", title: "场景图", metadata: { emitsEntity: { kind: "scene", nameFrom: "input" }, content: IMG, input: "客厅" } }),
    node({ id: "tpl-shot-1", title: "镜头", metadata: { emitsEntity: { kind: "audio" }, content: "https://cdn.example.com/a.mp3" } }),
  ];
  const result = emittedCardsForNodes(nodes, []);
  assert.deepEqual(result.cards.map((c) => c.name), ["霍辞渊", "客厅", "镜头"]);
  assert.deepEqual(result.cards.map((c) => c.kind), ["character", "scene", "audio"]);
  assert.deepEqual(result.lockedIds, result.cards.map((c) => c.id));
  for (const card of result.cards) assert.deepEqual(normalizeCharacterCard(card), card);
});

// ─────────────────────────────────────────── shotBackfill

/**
 * 分镜节点：卡引用栏在 metadata 顶层（`characterCardIds` 等，与回填写入位置一致），
 * AID 21 栏在 `metadata.storyboardShot`（现场真源形状）。
 */
function shotNode(id: string, opts: { top?: Record<string, unknown>; shot?: Record<string, unknown> } = {}): AgentOutputNodeRef {
  return node({
    id,
    title: "一镜",
    metadata: { ...(opts.top ?? {}), storyboardShot: { shotNumber: id, referenceAssets: "", ...(opts.shot ?? {}) } },
  });
}

test("shotBackfill：未指定引用的分镜节点被填（按 kind 分栏），非分镜节点不动", () => {
  const nodes = [
    marked("character", IMG, { input: "霍辞渊" }),
    node({ id: "tpl-scene-2", title: "场景图", metadata: { emitsEntity: { kind: "scene", nameFrom: "input" }, content: IMG, input: "客厅" } }),
    shotNode("shot-1", {}),
    node({ id: "not-a-shot", title: "普通卡", metadata: {} }),
  ];
  const result = emittedCardsForNodes(nodes, []);
  const byKind = new Map(result.cards.map((c) => [c.kind, c.id]));
  assert.equal(result.shotBackfill.length, 1);
  assert.deepEqual(result.shotBackfill[0], {
    nodeId: "shot-1",
    characterCardIds: [byKind.get("character")],
    sceneCardIds: [byKind.get("scene")],
  });
});

test("shotBackfill：已指定引用的分镜节点不被覆盖（id 阵列与 referenceAssets 名称两种）", () => {
  const nodes = [
    marked("character", IMG, { input: "霍辞渊" }),
    node({ id: "tpl-scene-2", title: "场景图", metadata: { emitsEntity: { kind: "scene", nameFrom: "input" }, content: IMG, input: "客厅" } }),
    shotNode("shot-manual", { top: { characterCardIds: ["hand-made-card"] } }), // 人工指定 id → character 栏不动
    shotNode("shot-named", { shot: { referenceAssets: "场景:[客厅] 角色:[霍辞渊]" } }), // 上游按名称点名两 kind → 该镜不回填
    shotNode("shot-partial", { shot: { referenceAssets: "角色:[霍辞渊]" } }), // 只点名 character → scene 栏照填
    shotNode("shot-empty-array", { top: { characterCardIds: [], sceneCardIds: ["   "] } }), // 空值不算已指定
  ];
  const result = emittedCardsForNodes(nodes, []);
  const charId = result.cards.find((c) => c.kind === "character")!.id;
  const sceneId = result.cards.find((c) => c.kind === "scene")!.id;
  const byNode = new Map(result.shotBackfill.map((b) => [b.nodeId, b]));
  assert.deepEqual(byNode.get("shot-manual"), { nodeId: "shot-manual", sceneCardIds: [sceneId] });
  assert.equal(byNode.has("shot-named"), false, "referenceAssets 已点名两 kind → 该镜不回填");
  assert.deepEqual(byNode.get("shot-partial"), { nodeId: "shot-partial", sceneCardIds: [sceneId] });
  assert.deepEqual(byNode.get("shot-empty-array"), {
    nodeId: "shot-empty-array",
    characterCardIds: [charId],
    sceneCardIds: [sceneId],
  });
});

// WS7（2026-09-24）：耐久回填——回填判准从「本轮有新建卡」改成「**自动落成的卡存在**且
// 分镜节点缺引用」。以下三态 ＋ 收敛断言钉死这个语义转变。

test("shotBackfill：自动落成的卡已存在、分镜节点缺引用 → **仍然回填**（耐久，不只建卡那一轮有效）", () => {
  const charCard = normalizeCharacterCard({ id: entityCardIdForNode("tpl-view1-2"), name: "霍辞渊", kind: "character" });
  const sceneCard = normalizeCharacterCard({ id: entityCardIdForNode("tpl-scene-2"), name: "客厅", kind: "scene" });
  assert.ok(charCard && sceneCard);
  const result = emittedCardsForNodes([shotNode("shot-1")], [charCard!, sceneCard!]);
  assert.deepEqual(result.cards, [], "卡已存在 → 不重复建卡");
  assert.deepEqual(result.lockedIds, [], "没新建就不锁定（不重复锁）");
  assert.deepEqual(
    result.shotBackfill,
    [{ nodeId: "shot-1", characterCardIds: [charCard!.id], sceneCardIds: [sceneCard!.id] }],
    "已落成的卡照样填进分镜引用栏（重载后也拿得到卡引用）",
  );
});

test("shotBackfill：分镜节点已有引用 → 不覆盖（即使自动落成卡存在，其他 kind 照填）", () => {
  const charCard = normalizeCharacterCard({ id: entityCardIdForNode("tpl-view1-2"), name: "霍辞渊", kind: "character" });
  const sceneCard = normalizeCharacterCard({ id: entityCardIdForNode("tpl-scene-2"), name: "客厅", kind: "scene" });
  assert.ok(charCard && sceneCard);
  const nodes = [shotNode("shot-manual", { top: { characterCardIds: ["card-hand-made"] } })];
  const result = emittedCardsForNodes(nodes, [charCard!, sceneCard!]);
  assert.deepEqual(
    result.shotBackfill,
    [{ nodeId: "shot-manual", sceneCardIds: [sceneCard!.id] }],
    "character 栏已被人工指定 → 原样不动；scene 栏仍耐久回填",
  );
  assert.ok(!JSON.stringify(result.shotBackfill).includes("card-hand-made"), "人工指定的 id 不得被自动流程改写");
});

test("shotBackfill：只有使用者手建卡（无 `card-node-` 前缀）→ 不回填（自动流程只碰自己造的卡）", () => {
  const handMade = normalizeCharacterCard({ id: "card-hand-made", name: "手工角色卡", kind: "character" });
  assert.ok(handMade);
  const result = emittedCardsForNodes([shotNode("shot-1")], [handMade!]);
  assert.deepEqual(result.cards, []);
  assert.deepEqual(result.shotBackfill, [], "手建卡不是自动落成的卡，一个都不碰");
});

test("shotBackfill：无自动落成的卡 → 不产生 backfill（既有卡不触发写入；本条语义已收窄为「无**自动落成**卡」）", () => {
  const nodes = [shotNode("shot-1")];
  const existing = normalizeCharacterCard({ id: entityCardIdForNode("tpl-view1-2"), name: "霍辞渊", kind: "character" });
  assert.ok(existing);
  const noEntity = emittedCardsForNodes(nodes, [normalizeCharacterCard({ id: "card-hand-made", name: "手工", kind: "scene" })!]);
  assert.deepEqual(noEntity.shotBackfill, [], "没有自动落成的卡 → 不臆造引用");
  // 同一批输入里有自动落成的卡时仍照常回填（对照组，证明上一行不是因为函式整体失效）
  assert.equal(emittedCardsForNodes(nodes, [existing!]).shotBackfill.length, 1);
});

/** 模拟呼叫端套用一轮结果：卡落盘 → `entityCardId` 标记写进拥有它的节点 → 回填写进分镜节点。 */
function applyRound(
  nodes: readonly AgentOutputNodeRef[],
  result: { cards: readonly { id: string }[]; shotBackfill: readonly ShotEntityBackfill[] },
): AgentOutputNodeRef[] {
  const ownerByCardId = new Map(nodes.map((n) => [entityCardIdForNode(n.id), n.id] as const));
  const backfillByNode = new Map(result.shotBackfill.map((item) => [item.nodeId, item] as const));
  return nodes.map((n) => {
    const metadata: Record<string, unknown> = { ...(n.metadata ?? {}) };
    for (const card of result.cards) {
      if (ownerByCardId.get(card.id) === n.id) metadata[ENTITY_CARD_ID_KEY_FOR_TEST] = card.id;
    }
    const item = backfillByNode.get(n.id);
    if (item) {
      if (item.characterCardIds) metadata.characterCardIds = item.characterCardIds;
      if (item.sceneCardIds) metadata.sceneCardIds = item.sceneCardIds;
      if (item.propCardIds) metadata.propCardIds = item.propCardIds;
    }
    return { ...n, metadata };
  });
}

/** 标记键名（与 agent-output-cards.ENTITY_CARD_ID_KEY 同步；测试自持一份，避免抄实作）。 */
const ENTITY_CARD_ID_KEY_FOR_TEST = "entityCardId";

test("emittedCardsForNodes：收敛——套用一轮后第二轮、第三轮结果完全相同（不再产生任何写入）", () => {
  const nodes = [marked("character", IMG, { input: "霍辞渊" }), shotNode("shot-1")];
  const first = emittedCardsForNodes(nodes, []);
  assert.equal(first.cards.length, 1);
  assert.equal(first.shotBackfill.length, 1);

  const afterFirst = applyRound(nodes, first);
  const second = emittedCardsForNodes(afterFirst, first.cards);
  assert.deepEqual(
    second,
    { cards: [], updatedCards: [], lockedIds: [], shotBackfill: [], nameFallbacks: [] },
    "第二轮：marker 已存在不建卡、引用已写不重填、参考图集合未变不更新",
  );

  const afterSecond = applyRound(afterFirst, second);
  const third = emittedCardsForNodes(afterSecond, [...first.cards, ...second.cards]);
  assert.deepEqual(third, second, "第三轮与第二轮逐位元相同（函式收敛，无振荡）");
  assert.deepEqual(afterSecond, afterFirst, "第二轮没有任何 metadata 写入（无 patch ＝ 无历史噪音）");
});

test("shotBackfill：非分镜形状（无 storyboardShot / shotNumber 空）不进清单", () => {
  const nodes = [
    marked("character", IMG, { input: "霍辞渊" }),
    node({ id: "n-flat", title: "扁平 shotNumber", metadata: { shotNumber: "001" } }),
    node({ id: "n-empty", title: "空镜号", metadata: { storyboardShot: { shotNumber: "  " } } }),
    node({ id: "n-null", title: "整包 null", metadata: { storyboardShot: null } }),
  ];
  const result = emittedCardsForNodes(nodes, []);
  assert.equal(result.cards.length, 1);
  assert.deepEqual(result.shotBackfill, []);
});

// ─────────────────────────────────────────── 真模板端到端（穿真传输边界）

/**
 * 真节点产生器：直接跑 gateway 的**真** `expandTemplate`（不重写它的 merge 逻辑）。
 * 旧版自写的「照合并式造节点」是假 oracle——它从不经过前端落地白名单，
 * 结构上不可能发现「闸道有标记、前端被剥掉」这个断点。
 */
function templateNodes(
  templateId: string,
  content: Record<string, Record<string, unknown>>,
): (AgentOutputNodeRef & { role: string })[] {
  const template = WORKFLOW_TEMPLATES.find((t) => t.id === templateId);
  assert.ok(template, `模板 ${templateId} 必须存在于 WORKFLOW_TEMPLATES`);
  const graph = expandTemplate(template!.id, template!, content);
  return graph.nodes.map((n) => ({ id: n.id, role: n.role, title: n.title, metadata: n.metadata as Record<string, unknown> }));
}

/**
 * 真传输边界：上行快照 `compactMetadataForAgent`（双白名单之一）→ 前端落地
 * `toNodeMetadata`（双白名单之二；`normalizeCanvasNode`/`fromCanvasProject` 都收束到它）。
 * 节点 metadata 要活过这一趟才算真的接上画布。
 */
function landThroughCanvasWhitelists(node: AgentOutputNodeRef): AgentOutputNodeRef & { role?: string } {
  const compacted = compactMetadataForAgent(node.metadata as unknown as CanvasNodeMetadata);
  const landed = toNodeMetadata(compacted);
  return { ...node, metadata: landed as Record<string, unknown> };
}

/** 边界后的 metadata 读取（结构化栏位取值，测试自持）。 */
function entitySpecIn(node: AgentOutputNodeRef): unknown {
  return node.metadata?.emitsEntity;
}

test("真模板 × 真边界：character_sheet 四视图只落**一张**角色卡（view1 标记），卡名取自 input", () => {
  const gatewayNodes = templateNodes("character_sheet", {
    view1: { content: IMG, input: "霍辞渊" },
    view2: { content: IMG2 },
    view3: { content: IMG3 },
    view4: { content: IMG4 },
  });
  // 第一段 oracle：闸道侧真有宣告（来源＝模板模组自己的宣告，不是本档喂的假物件）；
  // referenceNodeIds 由 expandTemplate 的参考图 post-pass 解析自**本次展开的真节点**。
  const gwView1 = gatewayNodes.find((n) => n.role === "view1")!;
  const siblingIds = ["view2", "view3", "view4"].map((role) => gatewayNodes.find((n) => n.role === role)!.id);
  assert.deepEqual(gwView1.metadata?.emitsEntity, {
    kind: "character",
    nameFrom: "input",
    referenceRoles: ["view2", "view3", "view4"],
    referenceNodeIds: siblingIds,
  });

  // 第二段：穿过两处真白名单（双白名单都要放行这四键，否则 aggregation 在真画布上不可能触发）
  const nodes = gatewayNodes.map(landThroughCanvasWhitelists);
  const landed = nodes.find((n) => n.role === "view1")!;
  assert.deepEqual(
    entitySpecIn(landed),
    gwView1.metadata?.emitsEntity,
    "emitsEntity 四键必须**逐键**活著穿过两处白名单（漏一处＝聚合整条不可能触发）",
  );
  assert.equal(landed.metadata?.input, "霍辞渊", "卡名来源键 input 必须活著穿过边界");
  assert.deepEqual(emittedEntityOf(landed), { kind: "character", nameFrom: "input" });

  // 第三段：四视图聚合——喂**穿过真传输边界**的节点（端到端：真引擎 → 真白名单 → 真纯函式）
  const result = emittedCardsForNodes(nodes, []);
  assert.equal(result.cards.length, 1, "四张图只落一张卡（四颗都标会落四张重复卡）");
  const card = result.cards[0];
  assert.equal(card.kind, "character");
  assert.equal(card.name, "霍辞渊", "卡名＝角色名（不是节点标题「正面」）");
  assert.equal(card.id, "card-node-character_sheet-view1-2");
  assert.deepEqual(
    card.references.map((r) => r.url),
    [IMG, IMG2, IMG3, IMG4],
    "一张卡四张参考图：自己的图在前 ＋ view2/3/4 的交付图（顺序＝referenceRoles）",
  );
  assert.deepEqual(card.references.map((r) => r.name), ["霍辞渊", "侧面", "背面", "动作"], "参考图名用兄弟节点标题");
  assert.deepEqual(card.references.map((r) => r.role), ["character", "character", "character", "character"]);
  assert.deepEqual(normalizeCharacterCard(card), card);
  assert.deepEqual(result.updatedCards, [], "第一轮是新建，不是更新");

  const twoRun = emittedCardsForNodes(nodes, result.cards);
  assert.deepEqual(twoRun.cards, [], "幂等：第二轮不再建卡");
  assert.deepEqual(twoRun.updatedCards, [], "幂等：参考图集合未变 → 不更新");
});

test("真模板 × 真边界：scene_setup 场景图落一张场景卡（kind=scene → role=composition）", () => {
  const nodes = templateNodes("scene_setup", { result: { content: IMG, input: "客厅-黄昏" } }).map(landThroughCanvasWhitelists);
  const result = emittedCardsForNodes(nodes, []);
  assert.equal(result.cards.length, 1);
  assert.equal(result.cards[0].kind, "scene");
  assert.equal(result.cards[0].name, "客厅-黄昏");
  assert.equal(result.cards[0].references[0].role, "composition");
  assert.deepEqual(normalizeCharacterCard(result.cards[0]), result.cards[0]);
});

test("真模板 × 真边界：未交付时（生成中/失败）一卡都不落，交付后才落（同一节点 id 不变）", () => {
  const pending = templateNodes("character_sheet", { view1: { input: "霍辞渊" } }).map(landThroughCanvasWhitelists);
  assert.deepEqual(emittedCardsForNodes(pending, []).cards, []);
  const done = templateNodes("character_sheet", { view1: { input: "霍辞渊", content: IMG } }).map(landThroughCanvasWhitelists);
  assert.equal(emittedCardsForNodes(done, []).cards.length, 1);
});

test("真模板 × 真边界：四模板五个标记节点——emitsEntity 与卡名都活著穿过白名单，且真的落成该 kind 的卡", () => {
  const cases = [
    { templateId: "character_sheet", role: "view1", name: "霍辞渊", kind: "character" },
    { templateId: "scene_setup", role: "result", name: "客厅-黄昏", kind: "scene" },
    { templateId: "shortdrama_visual", role: "cast_card", name: "沈蔓", kind: "character" },
    { templateId: "novel_film", role: "char_card", name: "林昭", kind: "character" },
    { templateId: "novel_film", role: "art_card", name: "旧宅_主视", kind: "scene" },
  ] as const;
  for (const c of cases) {
    const nodes = templateNodes(c.templateId, { [c.role]: { content: IMG, input: c.name } }).map(landThroughCanvasWhitelists);
    const target = nodes.find((n) => n.role === c.role);
    assert.ok(target, `${c.templateId}.${c.role} 节点必须存在`);
    // 逐键断言（不锁整包）：emitsEntity 穿边界的最小契约是 kind/nameFrom；
    // 参考图两键的穿边界由 character_sheet 那条**逐键全等**断言钉死（不在此处重复锁整包）。
    const spec = entitySpecIn(target!) as { kind?: unknown; nameFrom?: unknown };
    assert.equal(spec.kind, c.kind, `${c.templateId}.${c.role}：emitsEntity.kind 穿边界`);
    assert.equal(spec.nameFrom, "input", `${c.templateId}.${c.role}：emitsEntity.nameFrom 穿边界`);
    assert.equal(target!.metadata?.input, c.name, `${c.templateId}.${c.role}：卡名键穿边界`);
    const card = cardFromEntityNode(target!, []);
    assert.ok(card, `${c.templateId}.${c.role} 必须落成卡`);
    assert.equal(card!.kind, c.kind, "kind 不降格、不猜");
    assert.equal(card!.name, c.name, "卡名＝实体名（不是节点标题）");
    assert.deepEqual(normalizeCharacterCard(card), card);
  }
});

test("真模板 × 真边界：分镜节点引用回填——镜号与卡都在穿过白名单后成立", () => {
  const rawNodes: AgentOutputNodeRef[] = [
    ...templateNodes("character_sheet", { view1: { content: IMG, input: "霍辞渊" } }),
    ...templateNodes("scene_setup", { result: { content: IMG, input: "客厅" } }),
    // 分镜节点真形状：21 栏契约（此处只给 shotNumber；其余栏由 normalizeStoryboardShot 补 "")
    { id: "shot-1", title: "一镜", metadata: { storyboardShot: { shotNumber: "S001" } } },
  ];
  const nodes = rawNodes.map(landThroughCanvasWhitelists);
  const shot = nodes.find((n) => n.id === "shot-1")!;
  const shotMeta = shot.metadata as { storyboardShot?: { shotNumber?: string } };
  assert.equal(shotMeta.storyboardShot?.shotNumber, "S001", "分镜镜号必须穿过白名单（否则回填判定整条失效）");

  const result = emittedCardsForNodes(nodes, []);
  assert.equal(result.cards.length, 2, "角色卡 + 场景卡各一张");
  assert.deepEqual(result.shotBackfill.map((b) => b.nodeId), ["shot-1"]);
  assert.equal(result.shotBackfill[0].characterCardIds?.length, 1);
  assert.equal(result.shotBackfill[0].sceneCardIds?.length, 1);
});

// ─────────────────────────────────────────── 边界投影

test("toAgentOutputNodeRef：CanvasNode 形状（interface metadata）可投影，null metadata → undefined", () => {
  const ref = toAgentOutputNodeRef({ id: "n1", title: "正面", metadata: { emitsEntity: { kind: "character" }, content: IMG } });
  assert.equal(ref.id, "n1");
  assert.deepEqual(ref.metadata?.emitsEntity, { kind: "character" });
  assert.equal(toAgentOutputNodeRef({ id: "n2", metadata: null }).metadata, undefined);
  assert.equal(toAgentOutputNodeRef({ id: "n3" }).metadata, undefined);
  // 投影后仍能被本档消费（同一次呼叫链）
  assert.ok(cardFromEntityNode({ ...ref, title: "霍辞渊" }, []));
});
// ─────────────────────────────────────────── 落卡档位 → 初始批准状态（2026-09-24 决策 2/23）

test("落卡档位：协作档落 pending；全自动两档落 approved；未给 mode 一个栏位都不多写", () => {
  const n = marked("character", IMG);
  for (const mode of ["preset", "auto"] as const) {
    const auto = cardFromEntityNode(n, [], { mode });
    assert.deepEqual(auto?.approval, { status: "approved" }, `mode=${mode} 全自动档落的卡＝已批准（不停）`);
    assert.deepEqual(normalizeCharacterCard(auto), auto, "带 approval 仍逐栏等于唯一收口（normalize 不吞状态）");
  }
  const collab = cardFromEntityNode(n, [], { mode: "collaborate" });
  assert.deepEqual(collab?.approval, { status: "pending" }, "协作档落的卡等人过资产确认闸");
  assert.equal(collab && "decidedAt" in collab.approval!, false, "自动落卡不假造决策时间（decidedAt 缺席）");
  assert.equal(isAssetApproved(collab?.approval, "collaborate"), false);
  assert.equal(isAssetApproved(collab?.approval, "preset"), true, "同一张 pending 卡在全自动档不得挡");

  // 未给 mode（＝既有全部呼叫端）→ 不写 approval：键集合逐字不变
  const bare = cardFromEntityNode(n, []);
  assert.deepEqual(Object.keys(bare!).sort(), ["createdAt", "id", "kind", "name", "prompt", "references", "updatedAt"]);
  assert.deepEqual(normalizeCharacterCard(bare), bare);
});

test("批量落卡带档位：cards 带状态、lockedIds 照锁；第二轮仍幂等（不得因 approval 重复建卡）", () => {
  const nodes = [
    marked("character", IMG),
    node({ id: "tpl-scene-1", title: "客厅", metadata: { emitsEntity: { kind: "scene" }, content: IMG } }),
  ];
  const first = emittedCardsForNodes(nodes, [], { mode: "collaborate" });
  assert.deepEqual(first.cards.map((c) => c.approval?.status), ["pending", "pending"]);
  assert.deepEqual(first.lockedIds, first.cards.map((c) => c.id), "落卡锁定行为不因档位改变");
  for (const card of first.cards) assert.deepEqual(normalizeCharacterCard(card), card);

  // 第二轮：卡已存在（决定性 id）＋ 分镜引用已写 → 逐位收敛
  const withCards = [...first.cards];
  const second = emittedCardsForNodes(nodes, withCards, { mode: "collaborate" });
  assert.deepEqual(second, {
    cards: [],
    updatedCards: [],
    lockedIds: [],
    shotBackfill: [],
    // marked("character", IMG) 没给 input → 卡名退回节点标题「正面」，如实记录（每轮都记，不是写入）
    nameFallbacks: [{ nodeId: "tpl-view1-2", fallbackName: "正面" }],
  });
});

// ─────────────────────────────────────────── 参考图聚合（2026-09-24 四视图）

test("真模板 × 真引擎：四视图渐进聚合——兄弟图晚到时 updatedCards 补上，再跑为空（幂等）", () => {
  // 第一轮：只有 view1 有交付图（其余三颗还在生成/失败）。节点一律穿过真传输白名单。
  const onlyView1 = templateNodes("character_sheet", { view1: { content: IMG, input: "霍辞渊" } }).map(landThroughCanvasWhitelists);
  const first = emittedCardsForNodes(onlyView1, []);
  assert.equal(first.cards.length, 1);
  assert.deepEqual(first.cards[0].references.map((r) => r.url), [IMG], "只有 view1 有图 → 一张卡一张参考图");
  assert.deepEqual(first.updatedCards, []);

  // 第二轮：view2/3/4 的图到齐（同一批节点 id，referenceNodeIds 也已在节点上）
  const fourViews = templateNodes("character_sheet", {
    view1: { content: IMG, input: "霍辞渊" },
    view2: { content: IMG2 },
    view3: { content: IMG3 },
    view4: { content: IMG4 },
  }).map(landThroughCanvasWhitelists);
  const second = emittedCardsForNodes(fourViews, first.cards);
  assert.deepEqual(second.cards, [], "卡已存在（决定性 id）→ 不重复建");
  assert.equal(second.updatedCards.length, 1, "参考图集合变了 → 一张卡就地更新");
  const updated = second.updatedCards[0];
  assert.equal(updated.id, first.cards[0].id, "更新的就是同一张卡（同决定性 id）");
  assert.deepEqual(updated.references.map((r) => r.url), [IMG, IMG2, IMG3, IMG4]);
  assert.equal(updated.createdAt, first.cards[0].createdAt, "createdAt 沿用既有卡（不重造建立时间）");
  assert.deepEqual(normalizeCharacterCard(updated), updated, "更新后的卡仍逐栏过得了唯一收口");

  // 第三轮：把更新套用回既有卡 → cards 与 updatedCards 皆空
  const third = emittedCardsForNodes(fourViews, [updated]);
  assert.deepEqual(third.cards, []);
  assert.deepEqual(third.updatedCards, [], "幂等：同一批节点第二次跑不再更新");
});

test("聚合更新不动人的决策：既有卡 rejected，兄弟图到齐后更新的卡仍带 rejected", () => {
  const nodes = templateNodes("character_sheet", {
    view1: { content: IMG, input: "霍辞渊" },
    view2: { content: IMG2 },
  });
  const existing = normalizeCharacterCard({
    id: entityCardIdForNode("character_sheet-view1-2"),
    name: "霍辞渊",
    kind: "character",
    references: [{ url: IMG, role: "character", name: "霍辞渊" }],
    approval: { status: "rejected", reason: "换脸" },
  });
  assert.ok(existing);
  const result = emittedCardsForNodes(nodes, [existing!]);
  assert.equal(result.updatedCards.length, 1);
  assert.deepEqual(result.updatedCards[0].references.map((r) => r.url), [IMG, IMG2], "参考图照收");
  assert.deepEqual(result.updatedCards[0].approval, { status: "rejected", reason: "换脸" }, "重算不得把人的驳回决策洗回 pending");
});

test("真引擎：参考图 post-pass 不污染模板模组层（连跑两次不串味、defaults 不被写入）", () => {
  const template = WORKFLOW_TEMPLATES.find((t) => t.id === "character_sheet")!;
  const view1Spec = template.nodes.find((n) => n.role === "view1")!;
  const declared = view1Spec.defaults?.emitsEntity as Record<string, unknown>;
  // 前置：模板模组层只有作者宣告的三键（referenceNodeIds 由引擎解析后填入节点 metadata，不落回宣告）
  assert.deepEqual(Object.keys(declared).sort(), ["kind", "nameFrom", "referenceRoles"]);

  const run = () => expandTemplate(template.id, template, { view1: { content: IMG, input: "霍辞渊" } });
  const firstView1 = run().nodes.find((n) => n.role === "view1")!;
  const firstEntity = firstView1.metadata.emitsEntity as Record<string, unknown>;
  assert.equal((firstEntity.referenceNodeIds as string[]).length, 3, "第一次展开解出 3 个兄弟节点 id");
  assert.notEqual(firstEntity, declared, "节点上的 emitsEntity 必须是复制后的新物件（不得与模板模组层同参考）");

  const secondView1 = run().nodes.find((n) => n.role === "view1")!;
  const secondEntity = secondView1.metadata.emitsEntity as Record<string, unknown>;
  assert.notEqual(secondEntity, firstEntity, "两次展开各得自己的物件");
  assert.deepEqual(secondEntity.referenceNodeIds, firstEntity.referenceNodeIds, "两次解出的 id 决定性相同（同模板同索引）");
  assert.deepEqual(Object.keys(secondEntity).sort(), ["kind", "nameFrom", "referenceNodeIds", "referenceRoles"], "第二次不得残留第一次的多余键");
  assert.equal(declared.referenceNodeIds, undefined, "模板模组层的 defaults.emitsEntity 全程不得被写入 referenceNodeIds");
  assert.deepEqual(Object.keys(declared).sort(), ["kind", "nameFrom", "referenceRoles"], "模板模组层宣告逐键原样");
});

test("真引擎：referenceRoles 写错（role 不存在/部分命中）→ 不炸、不假装解析过", () => {
  const build = (referenceRoles: string[]) => {
    const template = {
      id: "bogus_tpl",
      nodes: [
        { role: "view1", kind: "image" as const, title: "正面", defaults: { emitsEntity: { kind: "character", nameFrom: "input", referenceRoles } } },
        { role: "view2", kind: "image" as const, title: "侧面" },
      ],
      connections: [],
    };
    return expandTemplate("bogus_tpl", template, {});
  };
  // 全部落空 → 不写该键、展开照常完成
  const missAll = build(["nope_role"]);
  const missEntity = missAll.nodes.find((n) => n.role === "view1")!.metadata.emitsEntity as Record<string, unknown>;
  assert.equal(missEntity.referenceNodeIds, undefined, "一个 role 都没命中 → 不写 referenceNodeIds");
  assert.deepEqual(missEntity.referenceRoles, ["nope_role"], "宣告原样保留（不写空阵列假装解析过）");
  assert.deepEqual(missAll.nodes.map((n) => n.role), ["view1", "view2"], "整个模板展开不受影响（不炸）");

  // 部分命中 → 只写命中的那个（保序）
  const partial = build(["nope_role", "view2"]);
  const partialEntity = partial.nodes.find((n) => n.role === "view1")!.metadata.emitsEntity as Record<string, unknown>;
  assert.deepEqual(partialEntity.referenceNodeIds, ["bogus_tpl-view2-1"], "只收真的存在的 role（其余略过）");

  // 同名 role 多个实例（multiShot 克隆会让同名 role 有多个）→ **全部纳入**（去重、保序）；
  // 作者手写的 referenceNodeIds 被引擎的重算结果覆写（宣告键由引擎拥有）。
  const dup = expandTemplate(
    "dup_tpl",
    {
      id: "dup_tpl",
      nodes: [
        { role: "owner", kind: "image" as const, title: "正面", defaults: { emitsEntity: { kind: "character", referenceNodeIds: ["ghost"], referenceRoles: ["view", "view"] } } },
        { role: "view", kind: "image" as const, title: "侧面" },
        { role: "view", kind: "image" as const, title: "背面" },
      ],
      connections: [],
    },
    {},
  );
  const dupEntity = dup.nodes.find((n) => n.role === "owner")!.metadata.emitsEntity as Record<string, unknown>;
  assert.deepEqual(dupEntity.referenceNodeIds, ["dup_tpl-view-1", "dup_tpl-view-2"], "同名 role 的多个实例全纳入、去重、保序");

  // 宣告形状不合法（非阵列/空阵列）→ 完全不动（不写键、不炸）
  for (const bogus of [[], "view2", 7, null] as unknown[]) {
    const graph = expandTemplate(
      "bogus_tpl",
      {
        id: "bogus_tpl",
        nodes: [{ role: "view1", kind: "image" as const, title: "正面", defaults: { emitsEntity: { kind: "character", referenceRoles: bogus } } }],
        connections: [],
      },
      {},
    );
    const entity = graph.nodes.find((n) => n.role === "view1")!.metadata.emitsEntity as Record<string, unknown>;
    assert.equal(entity.referenceNodeIds, undefined, `referenceRoles=${JSON.stringify(bogus)} 不触发解析`);
  }
});

test("cardFromEntityNode：不传 allNodes → 与旧版单图行为逐栏相同；传了才收兄弟图", () => {
  const sibling = node({ id: "tpl-view2-3", title: "侧面", metadata: { content: IMG2 } });
  const owner = node({
    id: "tpl-view1-2",
    title: "正面",
    metadata: {
      emitsEntity: { kind: "character", nameFrom: "input", referenceRoles: ["view2"], referenceNodeIds: ["tpl-view2-3", "ghost-node"] },
      content: IMG,
      input: "霍辞渊",
    },
  });
  const alone = cardFromEntityNode(owner, []);
  assert.ok(alone);
  assert.deepEqual(alone!.references, [{ url: IMG, role: "character", name: "霍辞渊" }], "不传 allNodes ＝ 只有自己那张图（旧行为逐位元）");
  assert.deepEqual(Object.keys(alone!).sort(), ["createdAt", "id", "kind", "name", "prompt", "references", "updatedAt"]);

  const collected = cardFromEntityNode(owner, [], [owner, sibling]);
  assert.deepEqual(collected!.references, [
    { url: IMG, role: "character", name: "霍辞渊" },
    { url: IMG2, role: "character", name: "侧面" },
  ], "指向不存在的节点（ghost-node）静默略过；找得到的兄弟收进来");
  assert.deepEqual(normalizeCharacterCard(collected), collected);

  // 旧呼叫形式（第三位放落卡档位）仍被支援（生产与既有测试都在用）
  const gated = cardFromEntityNode(owner, [], { mode: "collaborate" });
  assert.deepEqual(gated?.approval, { status: "pending" });
  assert.deepEqual(gated?.references, alone!.references, "第三位放 options 时不触发聚合");
});

// ─────────────────────────────────────────── 音频交付判定收紧（2026-09-24）

test("音频交付判定收紧：真音频 URL 形状收，图 URL／无副档名裸 URL 挡（不建空壳卡）", () => {
  const audioNode = (content: unknown) => node({ id: "tpl-vo-1", title: "配音", metadata: { emitsEntity: { kind: "audio" }, content } });
  // 收：grep 到的真交付 URL 形状（gateway TTS `.mp3`、music 上传 store 公网 URL、Lyria inline）
  const accepted = [
    "https://store.eimu.dev/tts/tts_lx1_ab.mp3",
    "https://store.eimu.dev/image-data/files/uploads/music-gen-1727000000.mp3",
    "https://store.eimu.dev/image-data/files/uploads/music-gen-1727000000.flac",
    "https://store.eimu.dev/image-data/files/uploads/music-gen-1727000000.m4a",
    "https://cdn.example.com/vo.mp3?token=abc#t=1",
    "https://cdn.example.com/vo.MP3",
    "data:audio/mpeg;base64,AAAA",
  ];
  for (const url of accepted) {
    const card = cardFromEntityNode(audioNode(url), []);
    assert.ok(card, `音频 URL 应被接受：${url}`);
    assert.deepEqual(card!.references, [], "音频卡不塞图片参考");
  }
  // 挡：一张 png URL 旧版会被当成合法音频交付 → 建出空壳卡
  const rejected = [
    "https://cdn.example.com/out/view-1.png",
    "https://cdn.example.com/a.png?x=.mp3",
    "https://cdn.example.com/audio/tts_abc",
    "https://cdn.example.com/vo.mp4",
    "data:image/png;base64,AAAA",
    "data:text/plain;base64,AAAA",
    "/tmp/local.mp3",
  ];
  for (const url of rejected) {
    assert.equal(cardFromEntityNode(audioNode(url), []), null, `不得当成音频交付：${url}`);
  }
});

// ─────────────────────────────────────────── nameFallbacks（软耦合可见化）

test("nameFallbacks：宣告 nameFrom:input 但三键都空 → 卡名退回节点标题、卡照样建出并记一笔", () => {
  const nodes = [
    node({ id: "tpl-view1-2", title: "正面", metadata: { emitsEntity: { kind: "character", nameFrom: "input" }, content: IMG } }),
    node({ id: "tpl-scene-3", title: "场景图", metadata: { emitsEntity: { kind: "scene", nameFrom: "input" }, content: IMG, sceneName: "客厅" } }),
    node({ id: "tpl-view2-9", title: "侧面", metadata: { emitsEntity: { kind: "character", nameFrom: "nodeTitle" }, content: IMG } }),
  ];
  const result = emittedCardsForNodes(nodes, []);
  assert.deepEqual(result.cards.map((c) => c.name), ["正面", "客厅", "侧面"], "卡仍建出（退回标题，不静默丢卡）");
  assert.deepEqual(
    result.nameFallbacks,
    [{ nodeId: "tpl-view1-2", fallbackName: "正面" }],
    "只有真的退回节点标题的节点记一笔（给了 sceneName／走 nodeTitle 的不算）",
  );
});
