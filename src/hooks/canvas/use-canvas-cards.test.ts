// 實體卡落卡域的站點側測試（2026-09-24/25）：
//   1. 卡名**第二來源**（C）：`upstreamTextNameFor` 的上游文本走訪
//   2. 第二來源注入（`withSecondSourceName`）與**真**落卡模組（`emittedCardsForNodes`）合跑
//   3. 漸進聚合的**就地更新**（B）：寫入路徑的冪等/收斂/合併
//
// 禁同源斷言：卡名那條的 oracle 是**真** `emittedCardsForNodes`（跨模組往復），
// 不是自寫的替代品；走訪那條用真連線欄位（fromNodeId→toNodeId）。
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  applyEmittedCardUpdates,
  emittedUpdateCards,
  planEmittedUpdateWrites,
  upstreamTextNameFor,
  withSecondSourceName,
} from "./use-canvas-cards";
import { emittedCardsForNodes, entityCardIdForNode } from "@/lib/agent-output-cards";
import type { AgentOutputNodeRef, EmittedCardsResult } from "@/lib/agent-output-cards";
import type { CharacterCard } from "@/lib/character-cards";

const IMG = "https://cdn.example.com/char.png";
const IMG2 = "https://cdn.example.com/side.png";

type NodeLike = { id: string; metadata?: object | null };
type ConnLike = { fromNodeId: string; toNodeId: string };

/** 空計畫（欄位＝落卡模組 EmittedCardsResult 的真形狀）。 */
function emptyPlan(): EmittedCardsResult {
  return { cards: [], updatedCards: [], lockedIds: [], shotBackfill: [], nameFallbacks: [] };
}

function node(id: string, content?: string, extra: Record<string, unknown> = {}): NodeLike {
  return { id, metadata: { ...(content === undefined ? {} : { content }), ...extra } };
}

function conn(fromNodeId: string, toNodeId: string): ConnLike {
  return { fromNodeId, toNodeId };
}

/** 落的卡：欄位對齊 character-cards 的 CharacterCard（正常化後形狀）。 */
function card(id: string, name: string, references: string[] = [], kind: CharacterCard["kind"] = "character"): CharacterCard {
  return {
    id,
    name,
    kind,
    prompt: "",
    references: references.map((url) => ({ url, role: "character" as const, name })),
    createdAt: "2026-09-24T00:00:00.000Z",
    updatedAt: "2026-09-24T00:00:00.000Z",
  };
}

/** 落卡節點：宣告 emitsEntity + 交付圖（名字三鍵另給）。 */
function entityRef(id: string, title: string, extra: Record<string, unknown> = {}): AgentOutputNodeRef {
  return { id, title, metadata: { emitsEntity: { kind: "character", nameFrom: "input" }, content: IMG, ...extra } };
}

// ─────────────────────────────── 1. upstreamTextNameFor

test("upstreamTextNameFor：直接上游的文本節點 → 第一行非空文字", () => {
  const nodes = [node("text-1", "  霍辞渊  \nDNA 签名…"), node("view-1", IMG)];
  assert.equal(upstreamTextNameFor("view-1", nodes, [conn("text-1", "view-1")]), "霍辞渊");
});

test("upstreamTextNameFor：多層上游，最近有文本的祖先勝（跳過空文本/圖節點）", () => {
  const nodes = [
    node("grand", "祖辈名\n第二行"),
    node("mid-empty"), // 無 content
    node("mid-image", "https://cdn.example.com/mid.png"), // 交付圖不是文本
    node("view-1", IMG),
  ];
  const connections = [conn("grand", "mid-empty"), conn("mid-empty", "view-1"), conn("mid-image", "view-1")];
  assert.equal(upstreamTextNameFor("view-1", nodes, connections), "祖辈名", "同層兩個上游都無文本 → 再往上一層");
  // 同層第一個有文本者勝（連線出現序）
  const withSiblingText = [node("a", "甲"), node("b", "乙"), node("view-1", IMG)];
  assert.equal(upstreamTextNameFor("view-1", withSiblingText, [conn("a", "view-1"), conn("b", "view-1")]), "甲");
  assert.equal(upstreamTextNameFor("view-1", withSiblingText, [conn("b", "view-1"), conn("a", "view-1")]), "乙");
});

test("upstreamTextNameFor：文本首行為空 → 往下取第一個非空行", () => {
  const nodes = [node("text-1", "\n\n   \n  雨夜街  \n第二行"), node("view-1", IMG)];
  assert.equal(upstreamTextNameFor("view-1", nodes, [conn("text-1", "view-1")]), "雨夜街");
});

test("upstreamTextNameFor：成環不無限迴圈（環上無文本 → undefined）", () => {
  const nodes = [node("a"), node("b"), node("view-1", IMG)];
  const connections = [conn("view-1", "a"), conn("a", "b"), conn("b", "a")]; // b→a→b 環，且 view-1 在環上
  assert.equal(upstreamTextNameFor("view-1", nodes, connections), undefined, "環上沒文本 → undefined（且必須終止）");
  // 環 + 環外有文本：仍要走得到
  const withText = [node("a"), node("b"), node("c", "环外名"), node("view-1", IMG)];
  const conns2 = [conn("a", "b"), conn("b", "a"), conn("c", "b"), conn("b", "view-1")];
  assert.equal(upstreamTextNameFor("view-1", withText, conns2), "环外名");
});

test("upstreamTextNameFor：無上游 / 自己 / 壞資料 → undefined（不炸）", () => {
  const nodes = [node("solo", "自己的正文"), node("view-1", IMG)];
  assert.equal(upstreamTextNameFor("view-1", nodes, []), undefined, "沒有連線＝沒有上游");
  assert.equal(upstreamTextNameFor("view-1", nodes, [conn("view-1", "view-1")]), undefined, "自環不選自己");
  assert.equal(upstreamTextNameFor("", nodes, [conn("solo", "")]), undefined, "空 nodeId");
  assert.equal(upstreamTextNameFor("view-1", [], [conn("ghost", "view-1")]), undefined, "上游不在節點清單裡（無 metadata）");
  assert.equal(
    upstreamTextNameFor("view-1", [{ id: "text-1", metadata: null }] as NodeLike[], [conn("text-1", "view-1")]),
    undefined,
    "metadata null",
  );
});

test("upstreamTextNameFor：名字上限 100（與卡名同尺）", () => {
  const nodes = [node("text-1", "名".repeat(200)), node("view-1", IMG)];
  assert.equal(upstreamTextNameFor("view-1", nodes, [conn("text-1", "view-1")])?.length, 100);
});

// ─────────────────────────────── 2. 第二來源注入 + 真落卡模組

test("withSecondSourceName：只認 nameFrom:'input' 且三鍵全空者（其餘回原參考）", () => {
  const resolveName = () => "上游名";
  const needs = entityRef("view-1", "正面");
  const injected = withSecondSourceName(needs, resolveName);
  assert.notEqual(injected, needs, "注入了＝新物件");
  assert.deepEqual(injected.metadata?.input, "上游名");
  assert.deepEqual(needs.metadata, { emitsEntity: { kind: "character", nameFrom: "input" }, content: IMG }, "原參考不被改動");

  assert.equal(withSecondSourceName(needs), needs, "沒有出口＝原參考");
  assert.equal(withSecondSourceName(entityRef("v", "正面", { input: "已有名" }), resolveName).metadata?.input, "已有名", "agent 寫過名字 → 不介入");
  assert.equal(withSecondSourceName(needs, () => "   "), needs, "第二來源空字串 → 不注入");
  assert.equal(withSecondSourceName(needs, () => undefined), needs);
  assert.equal(withSecondSourceName(needs, () => {
    throw new Error("boom");
  }), needs, "第二來源拋錯 → 不影響落卡主線");
  const nodeTitleMode: AgentOutputNodeRef = { id: "v", title: "正面", metadata: { emitsEntity: { kind: "scene", nameFrom: "nodeTitle" }, content: IMG } };
  assert.equal(withSecondSourceName(nodeTitleMode, resolveName), nodeTitleMode, "nameFrom:'nodeTitle' 是作者的明確選擇，不移花接木");
  assert.equal(withSecondSourceName({ id: "v", title: "正面", metadata: { content: IMG } }, resolveName).metadata?.input, undefined, "沒宣告 emitsEntity → 不動");
});

test("第二來源合跑真落卡模組：卡名＝上游文本第一行（不是節點標題「正面」）；無第二來源時退回標題", () => {
  const nodes: NodeLike[] = [node("text-1", "霍辞渊\nDNA 签名 8 维"), { id: "view-1", metadata: { emitsEntity: { kind: "character", nameFrom: "input" }, content: IMG } }];
  const connections = [conn("text-1", "view-1")];
  const refs = nodes.map((n) => ({ id: n.id, title: n.id === "view-1" ? "正面" : "角色描述", metadata: n.metadata as Record<string, unknown> }));
  const resolveName = (ref: AgentOutputNodeRef) => upstreamTextNameFor(ref.id, nodes, connections);

  const withSecond = emittedCardsForNodes(refs.map((r) => withSecondSourceName(r, resolveName)), []);
  assert.equal(withSecond.cards.length, 1);
  assert.equal(withSecond.cards[0].name, "霍辞渊", "第二來源真的變成了卡名（跨模組往復，不是自寫替代品）");
  assert.equal(withSecond.cards[0].id, entityCardIdForNode("view-1"));

  const withoutSecond = emittedCardsForNodes(refs, []);
  assert.equal(withoutSecond.cards[0].name, "正面", "沒有第二來源＝退回節點標題（病灶原狀，對照組）");
});

// ─────────────────────────────── 3. 就地更新（B）：冪等、收斂、合併

test("emittedUpdateCards：缺欄/非陣列/髒項 → 空（舊版計畫零行為漂移）", () => {
  assert.deepEqual(emittedUpdateCards(emptyPlan()), []);
  assert.deepEqual(emittedUpdateCards({ ...emptyPlan(), updatedCards: "x" } as unknown as EmittedCardsResult), []);
  assert.deepEqual(
    emittedUpdateCards({ ...emptyPlan(), updatedCards: [null, 7, card("c1", "甲")] } as unknown as EmittedCardsResult).map((c) => c.id),
    ["c1"],
  );
});

test("applyEmittedCardUpdates：成功才回報、失敗不進清單、空清單零 I/O", async () => {
  const saved: string[] = [];
  const calls: string[] = [];
  const deps = {
    saveCard: async (c: CharacterCard) => {
      calls.push(c.id);
      return c.id !== "bad";
    },
    onSaved: (c: CharacterCard) => saved.push(`${c.id}:${c.name}`),
  };
  assert.deepEqual(await applyEmittedCardUpdates([], deps), [], "空＝一次 I/O 都不發");
  assert.deepEqual(calls, [], "空清單真的沒呼叫存檔");
  const ids = await applyEmittedCardUpdates([card("ok", "甲"), card("bad", "乙")], deps);
  assert.deepEqual(ids, ["ok"], "只有落盤成功的進回報");
  assert.deepEqual(saved, ["ok:甲"], "失敗者不碰本地狀態");
  assert.deepEqual(calls, ["ok", "bad"], "每張都試一次（不因前一張失敗而跳過）");
  const threw = await applyEmittedCardUpdates([card("boom", "丙")], {
    saveCard: async () => {
      throw new Error("network");
    },
    onSaved: () => {
      throw new Error("不該被呼叫");
    },
  });
  assert.deepEqual(threw, [], "拋錯＝失敗（不謊報落盤成功）");
});

test("聚合更新＋補名合併成同一筆寫盤（不互相覆蓋）", () => {
  const cardId = entityCardIdForNode("view-1");
  const existing = [card(cardId, "正面", [IMG])];
  const aggregated = card(cardId, "正面", [IMG, IMG2]); // 聚合晚到的第二張圖（名字還是舊的）
  const plan = { ...emptyPlan(), updatedCards: [aggregated] };
  const ref = entityRef("view-1", "正面", { input: "霍辞渊" }); // agent 晚到的真名
  const writes = planEmittedUpdateWrites(plan, [ref], existing, "2026-09-25T00:00:00.000Z");
  assert.equal(writes.length, 1, "同一張卡合成一筆（不是兩筆互相覆蓋）");
  assert.equal(writes[0].name, "霍辞渊", "補名生效");
  assert.equal(writes[0].references.length, 2, "聚合的第二張參考圖同時保住（不因補名寫盤而丟）");
  assert.equal(writes[0].id, cardId, "id 不變＝就地更新");
});

test("補名冪等：卡名已是真名 / 人手改過的名字 → 不產生寫入（連續兩輪收斂）", () => {
  const cardId = entityCardIdForNode("view-1");
  const ref = entityRef("view-1", "正面", { input: "霍辞渊" });
  const plan = emptyPlan();
  const first = planEmittedUpdateWrites(plan, [ref], [card(cardId, "正面")], "t1");
  assert.deepEqual(first.map((c) => c.name), ["霍辞渊"], "標題佔位名 → 真名（一筆）");
  // 第二輪：把手寫回來的卡當既有 → 計畫為空
  assert.deepEqual(planEmittedUpdateWrites(plan, [ref], first, "t2"), [], "下一輪不再有寫入");
  assert.deepEqual(
    planEmittedUpdateWrites(plan, [ref], [card(cardId, "我的角色")], "t3"),
    [],
    "人手改過的名字（≠ 節點標題）不被覆蓋",
  );
  assert.deepEqual(
    planEmittedUpdateWrites(plan, [entityRef("view-1", "正面")], [card(cardId, "正面")], "t4"),
    [],
    "連真名都沒有（agent 沒寫、第二來源空）→ 不產生寫入，維持標題名",
  );
});

test("落卡收斂（真 planner）：第一輪落成 1 卡、第二輪零新建零更新", () => {
  const refs = [entityRef("view-1", "正面", { input: "霍辞渊" })];
  const round1 = emittedCardsForNodes(refs, []);
  assert.equal(round1.cards.length, 1, "第一輪落一張");
  assert.deepEqual(planEmittedUpdateWrites(round1, refs, [], "t"), [], "第一輪沒有既存卡 → 零就地更新");
  // 落盤後：卡清單含該卡、節點已被寫上 entityCardId 標記（呼叫端的冪等標記）
  const marked = [{ ...refs[0], metadata: { ...refs[0].metadata, entityCardId: round1.cards[0].id } }];
  const round2 = emittedCardsForNodes(marked, round1.cards);
  assert.equal(round2.cards.length, 0, "第二輪零新建");
  assert.deepEqual(
    planEmittedUpdateWrites(round2, marked, round1.cards, "t"),
    [],
    "第二輪零就地更新（連續兩輪後不再有寫入）",
  );
});

// ── 四視圖聚合的**端到端**（真白名單 → 真 planner → 站點寫入路徑，2026-09-25）──
// 這是本刀唯一能證明「站點接線讓聚合活過來」的鏈路：閘道形狀的 metadata 過**真**
// toNodeMetadata(compactMetadataForAgent(...)) → 真 emittedCardsForNodes → 站點寫入計畫。

test("端到端：referenceNodeIds 活過雙白名單 → 真 planner 把兄弟圖併進同一張卡 → 站點就地落盤 → 下一輪收斂", async () => {
  const { toNodeMetadata } = await import("@/lib/canvas/layout");
  const { compactMetadataForAgent } = await import("./canvas-chat-types");
  // ① 閘道模板展開後的節點 metadata（view1 帶引擎解析出的 referenceNodeIds）
  const rawView1 = {
    emitsEntity: { kind: "character", nameFrom: "input", referenceRoles: ["view2"], referenceNodeIds: ["view-2"] },
    input: "霍辞渊",
    content: IMG,
  };
  // ② 過真傳輸層：上行壓縮 → 還原端清洗（這一對函式就是兩個白名單）
  const view1 = toNodeMetadata(compactMetadataForAgent(rawView1 as never)) as Record<string, unknown>;
  assert.deepEqual((view1.emitsEntity as Record<string, unknown>).referenceNodeIds, ["view-2"], "白名單活著（漏了＝下面整條聚合不可能觸發）");

  const view1Ref: AgentOutputNodeRef = { id: "view-1", title: "正面", metadata: view1 };
  const view2Ref = (content?: string): AgentOutputNodeRef => ({
    id: "view-2",
    title: "侧面",
    // 四視圖只有 view1 帶實體宣告（四顆都標會落四張重複卡）→ view2 只是「有交付圖的兄弟」
    metadata: { ...(content ? { content } : {}) },
  });

  // ③ 第一輪：只有 view1 的圖到了 → 落 1 張卡（自己的圖）；站點零就地更新
  const refs1 = [view1Ref, view2Ref()];
  const round1 = emittedCardsForNodes(refs1, []);
  assert.equal(round1.cards.length, 1);
  assert.deepEqual(round1.cards[0].references.map((r) => r.url), [IMG], "兄弟圖還沒到＝只有自己那張");
  assert.deepEqual(round1.updatedCards, []);
  assert.deepEqual(planEmittedUpdateWrites(round1, refs1, [], "t1"), [], "零寫盤");
  // ④ 落盤成功（站點把卡寫回伺服器/本地）
  const persisted = [{ ...round1.cards[0] }];

  // ⑤ 第二輪：view2 的圖晚到（漸進聚合）→ 計畫給出 updatedCards → 站點落盤（id 不變）
  const refs2 = [view1Ref, view2Ref(IMG2)];
  const round2 = emittedCardsForNodes(refs2, persisted);
  assert.deepEqual(round2.cards, [], "不新建第二張卡（同一實體＝同一張卡）");
  assert.deepEqual(round2.updatedCards.map((c) => c.id), [round1.cards[0].id], "就地更新同一張卡");
  assert.deepEqual(round2.updatedCards[0].references.map((r) => r.url), [IMG, IMG2], "兄弟圖併進來（順序＝referenceNodeIds）");
  const writes = planEmittedUpdateWrites(round2, refs2, persisted, "t2");
  assert.deepEqual(writes.map((c) => c.id), [round1.cards[0].id]);
  const saveCalls: string[] = [];
  const reportedNeedsANextRound = await applyEmittedCardUpdates(writes, {
    saveCard: async (c) => {
      saveCalls.push(c.id);
      return true;
    },
    onSaved: () => {},
  });
  assert.deepEqual(saveCalls, [round1.cards[0].id], "有寫入＝值得再觸發一輪（簽章含參考圖數）");
  assert.deepEqual(reportedNeedsANextRound, [round1.cards[0].id]);

  // ⑥ 第三輪：參考圖 url 集合已相符 → 計畫空 → 站點零 I/O（收斂，真 oracle）
  const round3 = emittedCardsForNodes(refs2, writes);
  assert.deepEqual(round3.updatedCards, [], "第二輪之後計畫為空");
  assert.deepEqual(planEmittedUpdateWrites(round3, refs2, writes, "t3"), []);
  let calls = 0;
  await applyEmittedCardUpdates(planEmittedUpdateWrites(round3, refs2, writes, "t3"), {
    saveCard: async () => {
      calls += 1;
      return true;
    },
    onSaved: () => {},
  });
  assert.equal(calls, 0, "連續兩輪後不再有寫入");
});

test("端到端：渲染圖（view2）不帶 emitsEntity 也不會自己落卡——只有聚合把它收進來", () => {
  const refs = [
    entityRef("view-1", "正面", { input: "霍辞渊", emitsEntity: { kind: "character", nameFrom: "input", referenceNodeIds: ["view-2"] } }),
    { id: "view-2", title: "侧面", metadata: { content: IMG2 } } as AgentOutputNodeRef,
  ];
  const plan = emittedCardsForNodes(refs, []);
  assert.equal(plan.cards.length, 1, "view2 沒宣告 → 不落卡（四視圖只標 view1 的設計）");
  assert.deepEqual(plan.cards[0].references.map((r) => r.url), [IMG, IMG2], "但它的圖被併進 view1 的卡");
});