// WS4 行為斷言（2026-09-24）：模板節點交付 → 實體卡自動落卡。
//
// 全部是**行為斷言**（真跑函式看輸出），不釘源碼字串：
//   - 卡物件一律用 `normalizeCharacterCard`（既有唯一收口）當 oracle 反證合法性 + 逐欄相等
//   - 模板端到端用**真** `expandTemplate`（gateway 引擎）產生節點，且產出**真的穿過**
//     `compactMetadataForAgent → toNodeMetadata` 這個傳輸邊界再餵本檔函式
//
// WS10（2026-09-24）修正本檔一條假 oracle：舊版 `nodesFromTemplate()` 自寫重實作了
// `expandTemplate` 的 merge、且從不經過 `toNodeMetadata` → 前端白名單剝掉 `emitsEntity`
// 時它照樣全綠（整條自動落卡在真畫布上不可能觸發卻驗不出來）。現在 oracle 換成
// 「真引擎輸出」＋「真白名單函式」兩者——都不屬於被測實現本身。

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
// 四視圖另外三張（獨立輸入，當聚合斷言的 oracle：餵進去的就是該被收回來的）
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

test("emittedEntityOf：沒有標記 → null；metadata 缺席/非物件 → null", () => {
  assert.equal(emittedEntityOf({ id: "n1" }), null);
  assert.equal(emittedEntityOf({ id: "n1", metadata: null }), null);
  assert.equal(emittedEntityOf({ id: "n1", metadata: {} }), null);
  assert.equal(emittedEntityOf({ id: "n1", metadata: { emitsEntity: "character" } }), null);
  assert.equal(emittedEntityOf({ id: "n1", metadata: { emitsEntity: ["character"] } }), null);
});

test("emittedEntityOf：kind 亂填/缺席 → null（不猜成 character）", () => {
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

test("entityCardIdForNode：產出的 id 真的過得了 normalizeCharacterCard（含 `:` 與超長 nodeId）", () => {
  const ids = [
    "character_sheet-view1-2",
    "scene_setup-result-2",
    "ses_abc:node:7", // 含 `:`（作用域鍵段分隔符）→ 必須被改寫，否則整張卡被拒
    "a".repeat(400), // 超長 → 截到 100
    "有中文的:節點 id",
    "with\u0000control\u007fchars:1",
    "",
  ];
  for (const raw of ids) {
    const id = entityCardIdForNode(raw);
    assert.ok(id.length <= 100, `id 長度 ≤100：${id}`);
    assert.ok(!id.includes(":"), `id 不得含 \`:\`：${id}`);
    const card = normalizeCharacterCard({ id, name: "x" });
    assert.ok(card, `normalizeCharacterCard 必須收下 ${JSON.stringify(raw)} → ${id}`);
    assert.equal(card!.id, id);
  }
});

test("entityCardIdForNode：決定性/可重入（同節點同 id）、不同節點不同 id", () => {
  assert.equal(entityCardIdForNode("character_sheet-view1-2"), entityCardIdForNode("character_sheet-view1-2"));
  assert.notEqual(entityCardIdForNode("character_sheet-view1-2"), entityCardIdForNode("character_sheet-view2-3"));
  // `:` 換 `-` 後可能撞名（同一個節點仍必同 id；不同節點撞名是可接受的碰撞，不製造非法 id）
  assert.equal(entityCardIdForNode("a:b"), entityCardIdForNode("a-b"));
  assert.ok(!entityCardIdForNode("a:b").includes(":"));
});

test("ENTITY_CARD_ID_PREFIX：與 entityCardIdForNode 的真實輸出對齊（真 nodeId 逐字斷言）", () => {
  const nodeId = "character_sheet-view1-2";
  const id = entityCardIdForNode(nodeId);
  assert.ok(id.startsWith(ENTITY_CARD_ID_PREFIX), `${id} 必帶前綴 ${ENTITY_CARD_ID_PREFIX}`);
  assert.equal(id, `${ENTITY_CARD_ID_PREFIX}${nodeId}`, "無需清洗的 nodeId：前綴 + 原 id 逐字相等");
  // 清洗路徑（含 `:` / 控制字元 / 超長）也維持前綴——回填的 startsWith 判定不會漏卡
  for (const raw of ["ses_abc:node:7", "with\u0000ctrl:1", "a".repeat(400)]) {
    assert.ok(entityCardIdForNode(raw).startsWith(ENTITY_CARD_ID_PREFIX), `清洗後仍帶前綴：${raw}`);
  }
  // 前綴本身過得了卡 id 界線（否則回填的判定與卡實體會是兩套事實）
  assert.ok(normalizeCharacterCard({ id, name: "x" }));
});

// ─────────────────────────────────────────── cardFromEntityNode

test("cardFromEntityNode：真節點 → 真卡，且 normalizeCharacterCard(card) 與 card 逐欄相等", () => {
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
  assert.ok(normalized, "產出的卡必須過 normalizeCharacterCard");
  assert.deepEqual(normalized, card, "逐欄相等（欄位不多不少、值已被同一把尺界定）");
  assert.deepEqual(Object.keys(card!).sort(), ["createdAt", "id", "kind", "name", "prompt", "references", "updatedAt"]);
});

test("cardFromEntityNode：邊界值（超長 prompt/超長名）仍與 normalizeCharacterCard 逐欄相等", () => {
  const card = cardFromEntityNode(
    marked("scene", IMG, { input: "場".repeat(500), deliverable: "d".repeat(5000) }),
    [],
  );
  assert.ok(card);
  assert.equal(card!.name.length, 100);
  assert.equal(card!.prompt.length, 2000);
  assert.equal(card!.references[0].name.length, 60);
  assert.deepEqual(normalizeCharacterCard(card), card);
});

test("cardFromEntityNode：沒有交付物 → null（絕不建空卡）", () => {
  assert.equal(cardFromEntityNode(marked("character"), []), null); // 完全沒有 content
  assert.equal(cardFromEntityNode(marked("character", ""), []), null);
  assert.equal(cardFromEntityNode(marked("character", "   "), []), null);
  assert.equal(cardFromEntityNode(marked("character", "/tmp/local.png"), []), null);
  assert.equal(cardFromEntityNode(marked("character", "data:text/plain;base64,AAAA"), []), null);
  assert.equal(cardFromEntityNode(marked("character", { url: IMG } as unknown as string), []), null);
  // audio 的載體是媒體 URL（blob/local 路徑不算）
  assert.equal(cardFromEntityNode(marked("audio", "data:image/png;base64,AAAA"), []), null);
  assert.ok(cardFromEntityNode(marked("audio", "data:audio/mpeg;base64,AAAA", { input: "主角配音" }), []));
});

test("cardFromEntityNode：未宣告 emitsEntity 的節點（即使有圖）→ null", () => {
  assert.equal(cardFromEntityNode(node({ id: "plain-1", metadata: { content: IMG } }), []), null);
  assert.equal(cardFromEntityNode(node({ id: "plain-1", metadata: { content: IMG, emitsEntity: { kind: "nope" } } }), []), null);
});

test("cardFromEntityNode：existing 已有同 id → null（冪等），別張卡不影響", () => {
  const existing = normalizeCharacterCard({ id: entityCardIdForNode("tpl-view1-2"), name: "舊卡" });
  assert.ok(existing);
  assert.equal(cardFromEntityNode(marked("character", IMG, { input: "霍辞渊" }), [existing!]), null);
  assert.ok(cardFromEntityNode(marked("character", IMG, { input: "霍辞渊" }), [normalizeCharacterCard({ id: "other", name: "x" })!]));
});

test("cardFromEntityNode：沒有名字 → null（nameFrom:input 與 nodeTitle 兩條路都空）", () => {
  const noTitle = node({ id: "tpl-view1-2", title: undefined, metadata: { emitsEntity: { kind: "character", nameFrom: "nodeTitle" }, content: IMG } });
  assert.equal(cardFromEntityNode(noTitle, []), null);
  const emptyTitle = node({ id: "tpl-view1-2", title: "   ", metadata: { emitsEntity: { kind: "character", nameFrom: "input" }, content: IMG } });
  assert.equal(cardFromEntityNode(emptyTitle, []), null);
  // nameFrom:input 取不到 → 退回標題；標題在 → 建卡
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

test("cardFromEntityNode：kind → references[0].role 映射；audio 不建參考圖", () => {
  const roles: Record<string, string> = { character: "character", scene: "composition", prop: "product", style: "style" };
  for (const [kind, role] of Object.entries(roles)) {
    const card = cardFromEntityNode(marked(kind, IMG, { input: "甲" }), []);
    assert.ok(card, `${kind} 應該建卡`);
    assert.deepEqual(card!.references.map((r) => r.role), [role]);
    assert.deepEqual(normalizeCharacterCard(card), card);
  }
  const audio = cardFromEntityNode(marked("audio", "https://cdn.example.com/vo.mp3", { input: "旁白" }), []);
  assert.ok(audio);
  assert.equal(audio!.kind, "audio");
  assert.deepEqual(audio!.references, [], "audio 卡的載體是 prompt 片段，不塞圖片參考");
  assert.deepEqual(normalizeCharacterCard(audio), audio);
});

test("cardFromEntityNode：prompt 取 deliverable → dna → signature，都沒有回空字串（純參考圖卡合法）", () => {
  const build = (metadata: Record<string, unknown>) => cardFromEntityNode(marked("character", IMG, { input: "甲", ...metadata }), [])?.prompt;
  assert.equal(build({ deliverable: "D", dna: "N", signature: "S" }), "D");
  assert.equal(build({ doodle: "x", dna: "N", signature: "S" }), "N");
  assert.equal(build({ signature: "S" }), "S");
  assert.equal(build({}), "");
});

// ─────────────────────────────────────────── emittedCardsForNodes

test("emittedCardsForNodes：冪等——同輸入跑兩次，第二次 cards/lockedIds 為空", () => {
  const nodes = [marked("character", IMG, { input: "霍辞渊" })];
  const first = emittedCardsForNodes(nodes, []);
  assert.equal(first.cards.length, 1);
  assert.deepEqual(first.lockedIds, [first.cards[0].id]);
  const second = emittedCardsForNodes(nodes, first.cards);
  assert.deepEqual(second.cards, []);
  assert.deepEqual(second.lockedIds, []);
  assert.deepEqual(second.shotBackfill, []);
});

test("emittedCardsForNodes：metadata.entityCardId 已存在 → 跳過（即使卡不在 existing 裡）", () => {
  const nodes = [marked("character", IMG, { input: "霍辞渊", entityCardId: entityCardIdForNode("tpl-view1-2") })];
  const result = emittedCardsForNodes(nodes, []);
  assert.deepEqual(result.cards, []);
  assert.deepEqual(result.lockedIds, []);
});

test("emittedCardsForNodes：多節點去重、同 kind 多卡、未知標記不落卡", () => {
  const nodes = [
    marked("character", IMG, { input: "霍辞渊" }),
    node({ id: "tpl-view2-3", title: "側面", metadata: { content: IMG } }), // 沒宣告 → 不落卡（四視圖只標 view1）
    node({ id: "tpl-view3-4", title: "背面", metadata: { content: "" } }),
    node({ id: "tpl-scene-2", title: "場景圖", metadata: { emitsEntity: { kind: "scene", nameFrom: "input" }, content: IMG, input: "客廳" } }),
    node({ id: "tpl-shot-1", title: "鏡頭", metadata: { emitsEntity: { kind: "audio" }, content: "https://cdn.example.com/a.mp3" } }),
  ];
  const result = emittedCardsForNodes(nodes, []);
  assert.deepEqual(result.cards.map((c) => c.name), ["霍辞渊", "客廳", "鏡頭"]);
  assert.deepEqual(result.cards.map((c) => c.kind), ["character", "scene", "audio"]);
  assert.deepEqual(result.lockedIds, result.cards.map((c) => c.id));
  for (const card of result.cards) assert.deepEqual(normalizeCharacterCard(card), card);
});

// ─────────────────────────────────────────── shotBackfill

/**
 * 分鏡節點：卡引用欄在 metadata 頂層（`characterCardIds` 等，與回填寫入位置一致），
 * AID 21 欄在 `metadata.storyboardShot`（現場真源形狀）。
 */
function shotNode(id: string, opts: { top?: Record<string, unknown>; shot?: Record<string, unknown> } = {}): AgentOutputNodeRef {
  return node({
    id,
    title: "一鏡",
    metadata: { ...(opts.top ?? {}), storyboardShot: { shotNumber: id, referenceAssets: "", ...(opts.shot ?? {}) } },
  });
}

test("shotBackfill：未指定引用的分鏡節點被填（按 kind 分欄），非分鏡節點不動", () => {
  const nodes = [
    marked("character", IMG, { input: "霍辞渊" }),
    node({ id: "tpl-scene-2", title: "場景圖", metadata: { emitsEntity: { kind: "scene", nameFrom: "input" }, content: IMG, input: "客廳" } }),
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

test("shotBackfill：已指定引用的分鏡節點不被覆蓋（id 陣列與 referenceAssets 名稱兩種）", () => {
  const nodes = [
    marked("character", IMG, { input: "霍辞渊" }),
    node({ id: "tpl-scene-2", title: "場景圖", metadata: { emitsEntity: { kind: "scene", nameFrom: "input" }, content: IMG, input: "客廳" } }),
    shotNode("shot-manual", { top: { characterCardIds: ["hand-made-card"] } }), // 人工指定 id → character 欄不動
    shotNode("shot-named", { shot: { referenceAssets: "场景:[客厅] 角色:[霍辞渊]" } }), // 上游按名稱點名兩 kind → 該鏡不回填
    shotNode("shot-partial", { shot: { referenceAssets: "角色:[霍辞渊]" } }), // 只點名 character → scene 欄照填
    shotNode("shot-empty-array", { top: { characterCardIds: [], sceneCardIds: ["   "] } }), // 空值不算已指定
  ];
  const result = emittedCardsForNodes(nodes, []);
  const charId = result.cards.find((c) => c.kind === "character")!.id;
  const sceneId = result.cards.find((c) => c.kind === "scene")!.id;
  const byNode = new Map(result.shotBackfill.map((b) => [b.nodeId, b]));
  assert.deepEqual(byNode.get("shot-manual"), { nodeId: "shot-manual", sceneCardIds: [sceneId] });
  assert.equal(byNode.has("shot-named"), false, "referenceAssets 已點名兩 kind → 該鏡不回填");
  assert.deepEqual(byNode.get("shot-partial"), { nodeId: "shot-partial", sceneCardIds: [sceneId] });
  assert.deepEqual(byNode.get("shot-empty-array"), {
    nodeId: "shot-empty-array",
    characterCardIds: [charId],
    sceneCardIds: [sceneId],
  });
});

// WS7（2026-09-24）：耐久回填——回填判準從「本輪有新建卡」改成「**自動落成的卡存在**且
// 分鏡節點缺引用」。以下三態 ＋ 收斂斷言釘死這個語義轉變。

test("shotBackfill：自動落成的卡已存在、分鏡節點缺引用 → **仍然回填**（耐久，不只建卡那一輪有效）", () => {
  const charCard = normalizeCharacterCard({ id: entityCardIdForNode("tpl-view1-2"), name: "霍辞渊", kind: "character" });
  const sceneCard = normalizeCharacterCard({ id: entityCardIdForNode("tpl-scene-2"), name: "客廳", kind: "scene" });
  assert.ok(charCard && sceneCard);
  const result = emittedCardsForNodes([shotNode("shot-1")], [charCard!, sceneCard!]);
  assert.deepEqual(result.cards, [], "卡已存在 → 不重複建卡");
  assert.deepEqual(result.lockedIds, [], "沒新建就不鎖定（不重複鎖）");
  assert.deepEqual(
    result.shotBackfill,
    [{ nodeId: "shot-1", characterCardIds: [charCard!.id], sceneCardIds: [sceneCard!.id] }],
    "已落成的卡照樣填進分鏡引用欄（重載後也拿得到卡引用）",
  );
});

test("shotBackfill：分鏡節點已有引用 → 不覆蓋（即使自動落成卡存在，其他 kind 照填）", () => {
  const charCard = normalizeCharacterCard({ id: entityCardIdForNode("tpl-view1-2"), name: "霍辞渊", kind: "character" });
  const sceneCard = normalizeCharacterCard({ id: entityCardIdForNode("tpl-scene-2"), name: "客廳", kind: "scene" });
  assert.ok(charCard && sceneCard);
  const nodes = [shotNode("shot-manual", { top: { characterCardIds: ["card-hand-made"] } })];
  const result = emittedCardsForNodes(nodes, [charCard!, sceneCard!]);
  assert.deepEqual(
    result.shotBackfill,
    [{ nodeId: "shot-manual", sceneCardIds: [sceneCard!.id] }],
    "character 欄已被人工指定 → 原樣不動；scene 欄仍耐久回填",
  );
  assert.ok(!JSON.stringify(result.shotBackfill).includes("card-hand-made"), "人工指定的 id 不得被自動流程改寫");
});

test("shotBackfill：只有使用者手建卡（無 `card-node-` 前綴）→ 不回填（自動流程只碰自己造的卡）", () => {
  const handMade = normalizeCharacterCard({ id: "card-hand-made", name: "手工角色卡", kind: "character" });
  assert.ok(handMade);
  const result = emittedCardsForNodes([shotNode("shot-1")], [handMade!]);
  assert.deepEqual(result.cards, []);
  assert.deepEqual(result.shotBackfill, [], "手建卡不是自動落成的卡，一個都不碰");
});

test("shotBackfill：無自動落成的卡 → 不產生 backfill（既有卡不觸發寫入；本條語義已收窄為「無**自動落成**卡」）", () => {
  const nodes = [shotNode("shot-1")];
  const existing = normalizeCharacterCard({ id: entityCardIdForNode("tpl-view1-2"), name: "霍辞渊", kind: "character" });
  assert.ok(existing);
  const noEntity = emittedCardsForNodes(nodes, [normalizeCharacterCard({ id: "card-hand-made", name: "手工", kind: "scene" })!]);
  assert.deepEqual(noEntity.shotBackfill, [], "沒有自動落成的卡 → 不臆造引用");
  // 同一批輸入裡有自動落成的卡時仍照常回填（對照組，證明上一行不是因為函式整體失效）
  assert.equal(emittedCardsForNodes(nodes, [existing!]).shotBackfill.length, 1);
});

/** 模擬呼叫端套用一輪結果：卡落盤 → `entityCardId` 標記寫進擁有它的節點 → 回填寫進分鏡節點。 */
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

/** 標記鍵名（與 agent-output-cards.ENTITY_CARD_ID_KEY 同步；測試自持一份，避免抄實作）。 */
const ENTITY_CARD_ID_KEY_FOR_TEST = "entityCardId";

test("emittedCardsForNodes：收斂——套用一輪後第二輪、第三輪結果完全相同（不再產生任何寫入）", () => {
  const nodes = [marked("character", IMG, { input: "霍辞渊" }), shotNode("shot-1")];
  const first = emittedCardsForNodes(nodes, []);
  assert.equal(first.cards.length, 1);
  assert.equal(first.shotBackfill.length, 1);

  const afterFirst = applyRound(nodes, first);
  const second = emittedCardsForNodes(afterFirst, first.cards);
  assert.deepEqual(
    second,
    { cards: [], updatedCards: [], lockedIds: [], shotBackfill: [], nameFallbacks: [] },
    "第二輪：marker 已存在不建卡、引用已寫不重填、參考圖集合未變不更新",
  );

  const afterSecond = applyRound(afterFirst, second);
  const third = emittedCardsForNodes(afterSecond, [...first.cards, ...second.cards]);
  assert.deepEqual(third, second, "第三輪與第二輪逐位元相同（函式收斂，無振盪）");
  assert.deepEqual(afterSecond, afterFirst, "第二輪沒有任何 metadata 寫入（無 patch ＝ 無歷史噪音）");
});

test("shotBackfill：非分鏡形狀（無 storyboardShot / shotNumber 空）不進清單", () => {
  const nodes = [
    marked("character", IMG, { input: "霍辞渊" }),
    node({ id: "n-flat", title: "扁平 shotNumber", metadata: { shotNumber: "001" } }),
    node({ id: "n-empty", title: "空鏡號", metadata: { storyboardShot: { shotNumber: "  " } } }),
    node({ id: "n-null", title: "整包 null", metadata: { storyboardShot: null } }),
  ];
  const result = emittedCardsForNodes(nodes, []);
  assert.equal(result.cards.length, 1);
  assert.deepEqual(result.shotBackfill, []);
});

// ─────────────────────────────────────────── 真模板端到端（穿真傳輸邊界）

/**
 * 真節點產生器：直接跑 gateway 的**真** `expandTemplate`（不重寫它的 merge 邏輯）。
 * 舊版自寫的「照合併式造節點」是假 oracle——它從不經過前端落地白名單，
 * 結構上不可能發現「閘道有標記、前端被剝掉」這個斷點。
 */
function templateNodes(
  templateId: string,
  content: Record<string, Record<string, unknown>>,
): (AgentOutputNodeRef & { role: string })[] {
  const template = WORKFLOW_TEMPLATES.find((t) => t.id === templateId);
  assert.ok(template, `模板 ${templateId} 必須存在於 WORKFLOW_TEMPLATES`);
  const graph = expandTemplate(template!.id, template!, content);
  return graph.nodes.map((n) => ({ id: n.id, role: n.role, title: n.title, metadata: n.metadata as Record<string, unknown> }));
}

/**
 * 真傳輸邊界：上行快照 `compactMetadataForAgent`（雙白名單之一）→ 前端落地
 * `toNodeMetadata`（雙白名單之二；`normalizeCanvasNode`/`fromCanvasProject` 都收束到它）。
 * 節點 metadata 要活過這一趟才算真的接上畫布。
 */
function landThroughCanvasWhitelists(node: AgentOutputNodeRef): AgentOutputNodeRef & { role?: string } {
  const compacted = compactMetadataForAgent(node.metadata as unknown as CanvasNodeMetadata);
  const landed = toNodeMetadata(compacted);
  return { ...node, metadata: landed as Record<string, unknown> };
}

/** 邊界後的 metadata 讀取（結構化欄位取值，測試自持）。 */
function entitySpecIn(node: AgentOutputNodeRef): unknown {
  return node.metadata?.emitsEntity;
}

test("真模板 × 真邊界：character_sheet 四視圖只落**一張**角色卡（view1 標記），卡名取自 input", () => {
  const gatewayNodes = templateNodes("character_sheet", {
    view1: { content: IMG, input: "霍辞渊" },
    view2: { content: IMG2 },
    view3: { content: IMG3 },
    view4: { content: IMG4 },
  });
  // 第一段 oracle：閘道側真有宣告（來源＝模板模組自己的宣告，不是本檔餵的假物件）；
  // referenceNodeIds 由 expandTemplate 的參考圖 post-pass 解析自**本次展開的真節點**。
  const gwView1 = gatewayNodes.find((n) => n.role === "view1")!;
  const siblingIds = ["view2", "view3", "view4"].map((role) => gatewayNodes.find((n) => n.role === role)!.id);
  assert.deepEqual(gwView1.metadata?.emitsEntity, {
    kind: "character",
    nameFrom: "input",
    referenceRoles: ["view2", "view3", "view4"],
    referenceNodeIds: siblingIds,
  });

  // 第二段：穿過兩處真白名單（雙白名單都要放行這四鍵，否則 aggregation 在真畫布上不可能觸發）
  const nodes = gatewayNodes.map(landThroughCanvasWhitelists);
  const landed = nodes.find((n) => n.role === "view1")!;
  assert.deepEqual(
    entitySpecIn(landed),
    gwView1.metadata?.emitsEntity,
    "emitsEntity 四鍵必須**逐鍵**活著穿過兩處白名單（漏一處＝聚合整條不可能觸發）",
  );
  assert.equal(landed.metadata?.input, "霍辞渊", "卡名來源鍵 input 必須活著穿過邊界");
  assert.deepEqual(emittedEntityOf(landed), { kind: "character", nameFrom: "input" });

  // 第三段：四視圖聚合——餵**穿過真傳輸邊界**的節點（端到端：真引擎 → 真白名單 → 真純函式）
  const result = emittedCardsForNodes(nodes, []);
  assert.equal(result.cards.length, 1, "四張圖只落一張卡（四顆都標會落四張重複卡）");
  const card = result.cards[0];
  assert.equal(card.kind, "character");
  assert.equal(card.name, "霍辞渊", "卡名＝角色名（不是節點標題「正面」）");
  assert.equal(card.id, "card-node-character_sheet-view1-2");
  assert.deepEqual(
    card.references.map((r) => r.url),
    [IMG, IMG2, IMG3, IMG4],
    "一張卡四張參考圖：自己的圖在前 ＋ view2/3/4 的交付圖（順序＝referenceRoles）",
  );
  assert.deepEqual(card.references.map((r) => r.name), ["霍辞渊", "侧面", "背面", "动作"], "參考圖名用兄弟節點標題");
  assert.deepEqual(card.references.map((r) => r.role), ["character", "character", "character", "character"]);
  assert.deepEqual(normalizeCharacterCard(card), card);
  assert.deepEqual(result.updatedCards, [], "第一輪是新建，不是更新");

  const twoRun = emittedCardsForNodes(nodes, result.cards);
  assert.deepEqual(twoRun.cards, [], "冪等：第二輪不再建卡");
  assert.deepEqual(twoRun.updatedCards, [], "冪等：參考圖集合未變 → 不更新");
});

test("真模板 × 真邊界：scene_setup 場景圖落一張場景卡（kind=scene → role=composition）", () => {
  const nodes = templateNodes("scene_setup", { result: { content: IMG, input: "客廳-黃昏" } }).map(landThroughCanvasWhitelists);
  const result = emittedCardsForNodes(nodes, []);
  assert.equal(result.cards.length, 1);
  assert.equal(result.cards[0].kind, "scene");
  assert.equal(result.cards[0].name, "客廳-黃昏");
  assert.equal(result.cards[0].references[0].role, "composition");
  assert.deepEqual(normalizeCharacterCard(result.cards[0]), result.cards[0]);
});

test("真模板 × 真邊界：未交付時（生成中/失敗）一卡都不落，交付後才落（同一節點 id 不變）", () => {
  const pending = templateNodes("character_sheet", { view1: { input: "霍辞渊" } }).map(landThroughCanvasWhitelists);
  assert.deepEqual(emittedCardsForNodes(pending, []).cards, []);
  const done = templateNodes("character_sheet", { view1: { input: "霍辞渊", content: IMG } }).map(landThroughCanvasWhitelists);
  assert.equal(emittedCardsForNodes(done, []).cards.length, 1);
});

test("真模板 × 真邊界：四模板五個標記節點——emitsEntity 與卡名都活著穿過白名單，且真的落成該 kind 的卡", () => {
  const cases = [
    { templateId: "character_sheet", role: "view1", name: "霍辞渊", kind: "character" },
    { templateId: "scene_setup", role: "result", name: "客廳-黃昏", kind: "scene" },
    { templateId: "shortdrama_visual", role: "cast_card", name: "沈蔓", kind: "character" },
    { templateId: "novel_film", role: "char_card", name: "林昭", kind: "character" },
    { templateId: "novel_film", role: "art_card", name: "舊宅_主視", kind: "scene" },
  ] as const;
  for (const c of cases) {
    const nodes = templateNodes(c.templateId, { [c.role]: { content: IMG, input: c.name } }).map(landThroughCanvasWhitelists);
    const target = nodes.find((n) => n.role === c.role);
    assert.ok(target, `${c.templateId}.${c.role} 節點必須存在`);
    // 逐鍵斷言（不鎖整包）：emitsEntity 穿邊界的最小契約是 kind/nameFrom；
    // 參考圖兩鍵的穿邊界由 character_sheet 那條**逐鍵全等**斷言釘死（不在此處重複鎖整包）。
    const spec = entitySpecIn(target!) as { kind?: unknown; nameFrom?: unknown };
    assert.equal(spec.kind, c.kind, `${c.templateId}.${c.role}：emitsEntity.kind 穿邊界`);
    assert.equal(spec.nameFrom, "input", `${c.templateId}.${c.role}：emitsEntity.nameFrom 穿邊界`);
    assert.equal(target!.metadata?.input, c.name, `${c.templateId}.${c.role}：卡名鍵穿邊界`);
    const card = cardFromEntityNode(target!, []);
    assert.ok(card, `${c.templateId}.${c.role} 必須落成卡`);
    assert.equal(card!.kind, c.kind, "kind 不降格、不猜");
    assert.equal(card!.name, c.name, "卡名＝實體名（不是節點標題）");
    assert.deepEqual(normalizeCharacterCard(card), card);
  }
});

test("真模板 × 真邊界：分鏡節點引用回填——鏡號與卡都在穿過白名單後成立", () => {
  const rawNodes: AgentOutputNodeRef[] = [
    ...templateNodes("character_sheet", { view1: { content: IMG, input: "霍辞渊" } }),
    ...templateNodes("scene_setup", { result: { content: IMG, input: "客廳" } }),
    // 分鏡節點真形狀：21 欄契約（此處只給 shotNumber；其餘欄由 normalizeStoryboardShot 補 "")
    { id: "shot-1", title: "一鏡", metadata: { storyboardShot: { shotNumber: "S001" } } },
  ];
  const nodes = rawNodes.map(landThroughCanvasWhitelists);
  const shot = nodes.find((n) => n.id === "shot-1")!;
  const shotMeta = shot.metadata as { storyboardShot?: { shotNumber?: string } };
  assert.equal(shotMeta.storyboardShot?.shotNumber, "S001", "分鏡鏡號必須穿過白名單（否則回填判定整條失效）");

  const result = emittedCardsForNodes(nodes, []);
  assert.equal(result.cards.length, 2, "角色卡 + 場景卡各一張");
  assert.deepEqual(result.shotBackfill.map((b) => b.nodeId), ["shot-1"]);
  assert.equal(result.shotBackfill[0].characterCardIds?.length, 1);
  assert.equal(result.shotBackfill[0].sceneCardIds?.length, 1);
});

// ─────────────────────────────────────────── 邊界投影

test("toAgentOutputNodeRef：CanvasNode 形狀（interface metadata）可投影，null metadata → undefined", () => {
  const ref = toAgentOutputNodeRef({ id: "n1", title: "正面", metadata: { emitsEntity: { kind: "character" }, content: IMG } });
  assert.equal(ref.id, "n1");
  assert.deepEqual(ref.metadata?.emitsEntity, { kind: "character" });
  assert.equal(toAgentOutputNodeRef({ id: "n2", metadata: null }).metadata, undefined);
  assert.equal(toAgentOutputNodeRef({ id: "n3" }).metadata, undefined);
  // 投影後仍能被本檔消費（同一次呼叫鏈）
  assert.ok(cardFromEntityNode({ ...ref, title: "霍辞渊" }, []));
});
// ─────────────────────────────────────────── 落卡檔位 → 初始批准狀態（2026-09-24 決策 2/23）

test("落卡檔位：協作檔落 pending；全自動兩檔落 approved；未給 mode 一個欄位都不多寫", () => {
  const n = marked("character", IMG);
  for (const mode of ["preset", "auto"] as const) {
    const auto = cardFromEntityNode(n, [], { mode });
    assert.deepEqual(auto?.approval, { status: "approved" }, `mode=${mode} 全自動檔落的卡＝已批准（不停）`);
    assert.deepEqual(normalizeCharacterCard(auto), auto, "帶 approval 仍逐欄等於唯一收口（normalize 不吞狀態）");
  }
  const collab = cardFromEntityNode(n, [], { mode: "collaborate" });
  assert.deepEqual(collab?.approval, { status: "pending" }, "協作檔落的卡等人過資產確認閘");
  assert.equal(collab && "decidedAt" in collab.approval!, false, "自動落卡不假造決策時間（decidedAt 缺席）");
  assert.equal(isAssetApproved(collab?.approval, "collaborate"), false);
  assert.equal(isAssetApproved(collab?.approval, "preset"), true, "同一張 pending 卡在全自動檔不得擋");

  // 未給 mode（＝既有全部呼叫端）→ 不寫 approval：鍵集合逐字不變
  const bare = cardFromEntityNode(n, []);
  assert.deepEqual(Object.keys(bare!).sort(), ["createdAt", "id", "kind", "name", "prompt", "references", "updatedAt"]);
  assert.deepEqual(normalizeCharacterCard(bare), bare);
});

test("批量落卡帶檔位：cards 帶狀態、lockedIds 照鎖；第二輪仍冪等（不得因 approval 重複建卡）", () => {
  const nodes = [
    marked("character", IMG),
    node({ id: "tpl-scene-1", title: "客廳", metadata: { emitsEntity: { kind: "scene" }, content: IMG } }),
  ];
  const first = emittedCardsForNodes(nodes, [], { mode: "collaborate" });
  assert.deepEqual(first.cards.map((c) => c.approval?.status), ["pending", "pending"]);
  assert.deepEqual(first.lockedIds, first.cards.map((c) => c.id), "落卡鎖定行為不因檔位改變");
  for (const card of first.cards) assert.deepEqual(normalizeCharacterCard(card), card);

  // 第二輪：卡已存在（決定性 id）＋ 分鏡引用已寫 → 逐位收斂
  const withCards = [...first.cards];
  const second = emittedCardsForNodes(nodes, withCards, { mode: "collaborate" });
  assert.deepEqual(second, {
    cards: [],
    updatedCards: [],
    lockedIds: [],
    shotBackfill: [],
    // marked("character", IMG) 沒給 input → 卡名退回節點標題「正面」，如實記錄（每輪都記，不是寫入）
    nameFallbacks: [{ nodeId: "tpl-view1-2", fallbackName: "正面" }],
  });
});

// ─────────────────────────────────────────── 參考圖聚合（2026-09-24 四視圖）

test("真模板 × 真引擎：四視圖漸進聚合——兄弟圖晚到時 updatedCards 補上，再跑為空（冪等）", () => {
  // 第一輪：只有 view1 有交付圖（其餘三顆還在生成/失敗）。節點一律穿過真傳輸白名單。
  const onlyView1 = templateNodes("character_sheet", { view1: { content: IMG, input: "霍辞渊" } }).map(landThroughCanvasWhitelists);
  const first = emittedCardsForNodes(onlyView1, []);
  assert.equal(first.cards.length, 1);
  assert.deepEqual(first.cards[0].references.map((r) => r.url), [IMG], "只有 view1 有圖 → 一張卡一張參考圖");
  assert.deepEqual(first.updatedCards, []);

  // 第二輪：view2/3/4 的圖到齊（同一批節點 id，referenceNodeIds 也已在節點上）
  const fourViews = templateNodes("character_sheet", {
    view1: { content: IMG, input: "霍辞渊" },
    view2: { content: IMG2 },
    view3: { content: IMG3 },
    view4: { content: IMG4 },
  }).map(landThroughCanvasWhitelists);
  const second = emittedCardsForNodes(fourViews, first.cards);
  assert.deepEqual(second.cards, [], "卡已存在（決定性 id）→ 不重複建");
  assert.equal(second.updatedCards.length, 1, "參考圖集合變了 → 一張卡就地更新");
  const updated = second.updatedCards[0];
  assert.equal(updated.id, first.cards[0].id, "更新的就是同一張卡（同決定性 id）");
  assert.deepEqual(updated.references.map((r) => r.url), [IMG, IMG2, IMG3, IMG4]);
  assert.equal(updated.createdAt, first.cards[0].createdAt, "createdAt 沿用既有卡（不重造建立時間）");
  assert.deepEqual(normalizeCharacterCard(updated), updated, "更新後的卡仍逐欄過得了唯一收口");

  // 第三輪：把更新套用回既有卡 → cards 與 updatedCards 皆空
  const third = emittedCardsForNodes(fourViews, [updated]);
  assert.deepEqual(third.cards, []);
  assert.deepEqual(third.updatedCards, [], "冪等：同一批節點第二次跑不再更新");
});

test("聚合更新不動人的決策：既有卡 rejected，兄弟圖到齊後更新的卡仍帶 rejected", () => {
  const nodes = templateNodes("character_sheet", {
    view1: { content: IMG, input: "霍辞渊" },
    view2: { content: IMG2 },
  });
  const existing = normalizeCharacterCard({
    id: entityCardIdForNode("character_sheet-view1-2"),
    name: "霍辞渊",
    kind: "character",
    references: [{ url: IMG, role: "character", name: "霍辞渊" }],
    approval: { status: "rejected", reason: "換臉" },
  });
  assert.ok(existing);
  const result = emittedCardsForNodes(nodes, [existing!]);
  assert.equal(result.updatedCards.length, 1);
  assert.deepEqual(result.updatedCards[0].references.map((r) => r.url), [IMG, IMG2], "參考圖照收");
  assert.deepEqual(result.updatedCards[0].approval, { status: "rejected", reason: "換臉" }, "重算不得把人的駁回決策洗回 pending");
});

test("真引擎：參考圖 post-pass 不污染模板模組層（連跑兩次不串味、defaults 不被寫入）", () => {
  const template = WORKFLOW_TEMPLATES.find((t) => t.id === "character_sheet")!;
  const view1Spec = template.nodes.find((n) => n.role === "view1")!;
  const declared = view1Spec.defaults?.emitsEntity as Record<string, unknown>;
  // 前置：模板模組層只有作者宣告的三鍵（referenceNodeIds 由引擎解析後填入節點 metadata，不落回宣告）
  assert.deepEqual(Object.keys(declared).sort(), ["kind", "nameFrom", "referenceRoles"]);

  const run = () => expandTemplate(template.id, template, { view1: { content: IMG, input: "霍辞渊" } });
  const firstView1 = run().nodes.find((n) => n.role === "view1")!;
  const firstEntity = firstView1.metadata.emitsEntity as Record<string, unknown>;
  assert.equal((firstEntity.referenceNodeIds as string[]).length, 3, "第一次展開解出 3 個兄弟節點 id");
  assert.notEqual(firstEntity, declared, "節點上的 emitsEntity 必須是複製後的新物件（不得與模板模組層同參考）");

  const secondView1 = run().nodes.find((n) => n.role === "view1")!;
  const secondEntity = secondView1.metadata.emitsEntity as Record<string, unknown>;
  assert.notEqual(secondEntity, firstEntity, "兩次展開各得自己的物件");
  assert.deepEqual(secondEntity.referenceNodeIds, firstEntity.referenceNodeIds, "兩次解出的 id 決定性相同（同模板同索引）");
  assert.deepEqual(Object.keys(secondEntity).sort(), ["kind", "nameFrom", "referenceNodeIds", "referenceRoles"], "第二次不得殘留第一次的多餘鍵");
  assert.equal(declared.referenceNodeIds, undefined, "模板模組層的 defaults.emitsEntity 全程不得被寫入 referenceNodeIds");
  assert.deepEqual(Object.keys(declared).sort(), ["kind", "nameFrom", "referenceRoles"], "模板模組層宣告逐鍵原樣");
});

test("真引擎：referenceRoles 寫錯（role 不存在/部分命中）→ 不炸、不假裝解析過", () => {
  const build = (referenceRoles: string[]) => {
    const template = {
      id: "bogus_tpl",
      nodes: [
        { role: "view1", kind: "image" as const, title: "正面", defaults: { emitsEntity: { kind: "character", nameFrom: "input", referenceRoles } } },
        { role: "view2", kind: "image" as const, title: "側面" },
      ],
      connections: [],
    };
    return expandTemplate("bogus_tpl", template, {});
  };
  // 全部落空 → 不寫該鍵、展開照常完成
  const missAll = build(["nope_role"]);
  const missEntity = missAll.nodes.find((n) => n.role === "view1")!.metadata.emitsEntity as Record<string, unknown>;
  assert.equal(missEntity.referenceNodeIds, undefined, "一個 role 都沒命中 → 不寫 referenceNodeIds");
  assert.deepEqual(missEntity.referenceRoles, ["nope_role"], "宣告原樣保留（不寫空陣列假裝解析過）");
  assert.deepEqual(missAll.nodes.map((n) => n.role), ["view1", "view2"], "整個模板展開不受影響（不炸）");

  // 部分命中 → 只寫命中的那個（保序）
  const partial = build(["nope_role", "view2"]);
  const partialEntity = partial.nodes.find((n) => n.role === "view1")!.metadata.emitsEntity as Record<string, unknown>;
  assert.deepEqual(partialEntity.referenceNodeIds, ["bogus_tpl-view2-1"], "只收真的存在的 role（其餘略過）");

  // 同名 role 多個實例（multiShot 克隆會讓同名 role 有多個）→ **全部納入**（去重、保序）；
  // 作者手寫的 referenceNodeIds 被引擎的重算結果覆寫（宣告鍵由引擎擁有）。
  const dup = expandTemplate(
    "dup_tpl",
    {
      id: "dup_tpl",
      nodes: [
        { role: "owner", kind: "image" as const, title: "正面", defaults: { emitsEntity: { kind: "character", referenceNodeIds: ["ghost"], referenceRoles: ["view", "view"] } } },
        { role: "view", kind: "image" as const, title: "側面" },
        { role: "view", kind: "image" as const, title: "背面" },
      ],
      connections: [],
    },
    {},
  );
  const dupEntity = dup.nodes.find((n) => n.role === "owner")!.metadata.emitsEntity as Record<string, unknown>;
  assert.deepEqual(dupEntity.referenceNodeIds, ["dup_tpl-view-1", "dup_tpl-view-2"], "同名 role 的多個實例全納入、去重、保序");

  // 宣告形狀不合法（非陣列/空陣列）→ 完全不動（不寫鍵、不炸）
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
    assert.equal(entity.referenceNodeIds, undefined, `referenceRoles=${JSON.stringify(bogus)} 不觸發解析`);
  }
});

test("cardFromEntityNode：不傳 allNodes → 與舊版單圖行為逐欄相同；傳了才收兄弟圖", () => {
  const sibling = node({ id: "tpl-view2-3", title: "側面", metadata: { content: IMG2 } });
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
  assert.deepEqual(alone!.references, [{ url: IMG, role: "character", name: "霍辞渊" }], "不傳 allNodes ＝ 只有自己那張圖（舊行為逐位元）");
  assert.deepEqual(Object.keys(alone!).sort(), ["createdAt", "id", "kind", "name", "prompt", "references", "updatedAt"]);

  const collected = cardFromEntityNode(owner, [], [owner, sibling]);
  assert.deepEqual(collected!.references, [
    { url: IMG, role: "character", name: "霍辞渊" },
    { url: IMG2, role: "character", name: "側面" },
  ], "指向不存在的節點（ghost-node）靜默略過；找得到的兄弟收進來");
  assert.deepEqual(normalizeCharacterCard(collected), collected);

  // 舊呼叫形式（第三位放落卡檔位）仍被支援（生產與既有測試都在用）
  const gated = cardFromEntityNode(owner, [], { mode: "collaborate" });
  assert.deepEqual(gated?.approval, { status: "pending" });
  assert.deepEqual(gated?.references, alone!.references, "第三位放 options 時不觸發聚合");
});

// ─────────────────────────────────────────── 音頻交付判定收緊（2026-09-24）

test("音頻交付判定收緊：真音頻 URL 形狀收，圖 URL／無副檔名裸 URL 擋（不建空殼卡）", () => {
  const audioNode = (content: unknown) => node({ id: "tpl-vo-1", title: "配音", metadata: { emitsEntity: { kind: "audio" }, content } });
  // 收：grep 到的真交付 URL 形狀（gateway TTS `.mp3`、music 上傳 store 公網 URL、Lyria inline）
  const accepted = [
    "https://store.tinchak0207.xyz/tts/tts_lx1_ab.mp3",
    "https://store.tinchak0207.xyz/image-data/files/uploads/music-gen-1727000000.mp3",
    "https://store.tinchak0207.xyz/image-data/files/uploads/music-gen-1727000000.flac",
    "https://store.tinchak0207.xyz/image-data/files/uploads/music-gen-1727000000.m4a",
    "https://cdn.example.com/vo.mp3?token=abc#t=1",
    "https://cdn.example.com/vo.MP3",
    "data:audio/mpeg;base64,AAAA",
  ];
  for (const url of accepted) {
    const card = cardFromEntityNode(audioNode(url), []);
    assert.ok(card, `音頻 URL 應被接受：${url}`);
    assert.deepEqual(card!.references, [], "音頻卡不塞圖片參考");
  }
  // 擋：一張 png URL 舊版會被當成合法音頻交付 → 建出空殼卡
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
    assert.equal(cardFromEntityNode(audioNode(url), []), null, `不得當成音頻交付：${url}`);
  }
});

// ─────────────────────────────────────────── nameFallbacks（軟耦合可見化）

test("nameFallbacks：宣告 nameFrom:input 但三鍵都空 → 卡名退回節點標題、卡照樣建出並記一筆", () => {
  const nodes = [
    node({ id: "tpl-view1-2", title: "正面", metadata: { emitsEntity: { kind: "character", nameFrom: "input" }, content: IMG } }),
    node({ id: "tpl-scene-3", title: "場景圖", metadata: { emitsEntity: { kind: "scene", nameFrom: "input" }, content: IMG, sceneName: "客廳" } }),
    node({ id: "tpl-view2-9", title: "側面", metadata: { emitsEntity: { kind: "character", nameFrom: "nodeTitle" }, content: IMG } }),
  ];
  const result = emittedCardsForNodes(nodes, []);
  assert.deepEqual(result.cards.map((c) => c.name), ["正面", "客廳", "側面"], "卡仍建出（退回標題，不靜默丟卡）");
  assert.deepEqual(
    result.nameFallbacks,
    [{ nodeId: "tpl-view1-2", fallbackName: "正面" }],
    "只有真的退回節點標題的節點記一筆（給了 sceneName／走 nodeTitle 的不算）",
  );
});
