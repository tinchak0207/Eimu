// 实体卡落卡域的站点侧测试（2026-09-24/25）：
//   1. 卡名**第二来源**（C）：`upstreamTextNameFor` 的上游文本走访
//   2. 第二来源注入（`withSecondSourceName`）与**真**落卡模组（`emittedCardsForNodes`）合跑
//   3. 渐进聚合的**就地更新**（B）：写入路径的幂等/收敛/合并
//
// 禁同源断言：卡名那条的 oracle 是**真** `emittedCardsForNodes`（跨模组往复），
// 不是自写的替代品；走访那条用真连线栏位（fromNodeId→toNodeId）。
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

/** 空计画（栏位＝落卡模组 EmittedCardsResult 的真形状）。 */
function emptyPlan(): EmittedCardsResult {
  return { cards: [], updatedCards: [], lockedIds: [], shotBackfill: [], nameFallbacks: [] };
}

function node(id: string, content?: string, extra: Record<string, unknown> = {}): NodeLike {
  return { id, metadata: { ...(content === undefined ? {} : { content }), ...extra } };
}

function conn(fromNodeId: string, toNodeId: string): ConnLike {
  return { fromNodeId, toNodeId };
}

/** 落的卡：栏位对齐 character-cards 的 CharacterCard（正常化后形状）。 */
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

/** 落卡节点：宣告 emitsEntity + 交付图（名字三键另给）。 */
function entityRef(id: string, title: string, extra: Record<string, unknown> = {}): AgentOutputNodeRef {
  return { id, title, metadata: { emitsEntity: { kind: "character", nameFrom: "input" }, content: IMG, ...extra } };
}

// ─────────────────────────────── 1. upstreamTextNameFor

test("upstreamTextNameFor：直接上游的文本节点 → 第一行非空文字", () => {
  const nodes = [node("text-1", "  霍辞渊  \nDNA 签名…"), node("view-1", IMG)];
  assert.equal(upstreamTextNameFor("view-1", nodes, [conn("text-1", "view-1")]), "霍辞渊");
});

test("upstreamTextNameFor：多层上游，最近有文本的祖先胜（跳过空文本/图节点）", () => {
  const nodes = [
    node("grand", "祖辈名\n第二行"),
    node("mid-empty"), // 无 content
    node("mid-image", "https://cdn.example.com/mid.png"), // 交付图不是文本
    node("view-1", IMG),
  ];
  const connections = [conn("grand", "mid-empty"), conn("mid-empty", "view-1"), conn("mid-image", "view-1")];
  assert.equal(upstreamTextNameFor("view-1", nodes, connections), "祖辈名", "同层两个上游都无文本 → 再往上一层");
  // 同层第一个有文本者胜（连线出现序）
  const withSiblingText = [node("a", "甲"), node("b", "乙"), node("view-1", IMG)];
  assert.equal(upstreamTextNameFor("view-1", withSiblingText, [conn("a", "view-1"), conn("b", "view-1")]), "甲");
  assert.equal(upstreamTextNameFor("view-1", withSiblingText, [conn("b", "view-1"), conn("a", "view-1")]), "乙");
});

test("upstreamTextNameFor：文本首行为空 → 往下取第一个非空行", () => {
  const nodes = [node("text-1", "\n\n   \n  雨夜街  \n第二行"), node("view-1", IMG)];
  assert.equal(upstreamTextNameFor("view-1", nodes, [conn("text-1", "view-1")]), "雨夜街");
});

test("upstreamTextNameFor：成环不无限回圈（环上无文本 → undefined）", () => {
  const nodes = [node("a"), node("b"), node("view-1", IMG)];
  const connections = [conn("view-1", "a"), conn("a", "b"), conn("b", "a")]; // b→a→b 环，且 view-1 在环上
  assert.equal(upstreamTextNameFor("view-1", nodes, connections), undefined, "环上没文本 → undefined（且必须终止）");
  // 环 + 环外有文本：仍要走得到
  const withText = [node("a"), node("b"), node("c", "环外名"), node("view-1", IMG)];
  const conns2 = [conn("a", "b"), conn("b", "a"), conn("c", "b"), conn("b", "view-1")];
  assert.equal(upstreamTextNameFor("view-1", withText, conns2), "环外名");
});

test("upstreamTextNameFor：无上游 / 自己 / 坏资料 → undefined（不炸）", () => {
  const nodes = [node("solo", "自己的正文"), node("view-1", IMG)];
  assert.equal(upstreamTextNameFor("view-1", nodes, []), undefined, "没有连线＝没有上游");
  assert.equal(upstreamTextNameFor("view-1", nodes, [conn("view-1", "view-1")]), undefined, "自环不选自己");
  assert.equal(upstreamTextNameFor("", nodes, [conn("solo", "")]), undefined, "空 nodeId");
  assert.equal(upstreamTextNameFor("view-1", [], [conn("ghost", "view-1")]), undefined, "上游不在节点清单里（无 metadata）");
  assert.equal(
    upstreamTextNameFor("view-1", [{ id: "text-1", metadata: null }] as NodeLike[], [conn("text-1", "view-1")]),
    undefined,
    "metadata null",
  );
});

test("upstreamTextNameFor：名字上限 100（与卡名同尺）", () => {
  const nodes = [node("text-1", "名".repeat(200)), node("view-1", IMG)];
  assert.equal(upstreamTextNameFor("view-1", nodes, [conn("text-1", "view-1")])?.length, 100);
});

// ─────────────────────────────── 2. 第二来源注入 + 真落卡模组

test("withSecondSourceName：只认 nameFrom:'input' 且三键全空者（其余回原参考）", () => {
  const resolveName = () => "上游名";
  const needs = entityRef("view-1", "正面");
  const injected = withSecondSourceName(needs, resolveName);
  assert.notEqual(injected, needs, "注入了＝新物件");
  assert.deepEqual(injected.metadata?.input, "上游名");
  assert.deepEqual(needs.metadata, { emitsEntity: { kind: "character", nameFrom: "input" }, content: IMG }, "原参考不被改动");

  assert.equal(withSecondSourceName(needs), needs, "没有出口＝原参考");
  assert.equal(withSecondSourceName(entityRef("v", "正面", { input: "已有名" }), resolveName).metadata?.input, "已有名", "agent 写过名字 → 不介入");
  assert.equal(withSecondSourceName(needs, () => "   "), needs, "第二来源空字串 → 不注入");
  assert.equal(withSecondSourceName(needs, () => undefined), needs);
  assert.equal(withSecondSourceName(needs, () => {
    throw new Error("boom");
  }), needs, "第二来源抛错 → 不影响落卡主线");
  const nodeTitleMode: AgentOutputNodeRef = { id: "v", title: "正面", metadata: { emitsEntity: { kind: "scene", nameFrom: "nodeTitle" }, content: IMG } };
  assert.equal(withSecondSourceName(nodeTitleMode, resolveName), nodeTitleMode, "nameFrom:'nodeTitle' 是作者的明确选择，不移花接木");
  assert.equal(withSecondSourceName({ id: "v", title: "正面", metadata: { content: IMG } }, resolveName).metadata?.input, undefined, "没宣告 emitsEntity → 不动");
});

test("第二来源合跑真落卡模组：卡名＝上游文本第一行（不是节点标题「正面」）；无第二来源时退回标题", () => {
  const nodes: NodeLike[] = [node("text-1", "霍辞渊\nDNA 签名 8 维"), { id: "view-1", metadata: { emitsEntity: { kind: "character", nameFrom: "input" }, content: IMG } }];
  const connections = [conn("text-1", "view-1")];
  const refs = nodes.map((n) => ({ id: n.id, title: n.id === "view-1" ? "正面" : "角色描述", metadata: n.metadata as Record<string, unknown> }));
  const resolveName = (ref: AgentOutputNodeRef) => upstreamTextNameFor(ref.id, nodes, connections);

  const withSecond = emittedCardsForNodes(refs.map((r) => withSecondSourceName(r, resolveName)), []);
  assert.equal(withSecond.cards.length, 1);
  assert.equal(withSecond.cards[0].name, "霍辞渊", "第二来源真的变成了卡名（跨模组往复，不是自写替代品）");
  assert.equal(withSecond.cards[0].id, entityCardIdForNode("view-1"));

  const withoutSecond = emittedCardsForNodes(refs, []);
  assert.equal(withoutSecond.cards[0].name, "正面", "没有第二来源＝退回节点标题（病灶原状，对照组）");
});

// ─────────────────────────────── 3. 就地更新（B）：幂等、收敛、合并

test("emittedUpdateCards：缺栏/非阵列/脏项 → 空（旧版计画零行为漂移）", () => {
  assert.deepEqual(emittedUpdateCards(emptyPlan()), []);
  assert.deepEqual(emittedUpdateCards({ ...emptyPlan(), updatedCards: "x" } as unknown as EmittedCardsResult), []);
  assert.deepEqual(
    emittedUpdateCards({ ...emptyPlan(), updatedCards: [null, 7, card("c1", "甲")] } as unknown as EmittedCardsResult).map((c) => c.id),
    ["c1"],
  );
});

test("applyEmittedCardUpdates：成功才回报、失败不进清单、空清单零 I/O", async () => {
  const saved: string[] = [];
  const calls: string[] = [];
  const deps = {
    saveCard: async (c: CharacterCard) => {
      calls.push(c.id);
      return c.id !== "bad";
    },
    onSaved: (c: CharacterCard) => saved.push(`${c.id}:${c.name}`),
  };
  assert.deepEqual(await applyEmittedCardUpdates([], deps), [], "空＝一次 I/O 都不发");
  assert.deepEqual(calls, [], "空清单真的没呼叫存档");
  const ids = await applyEmittedCardUpdates([card("ok", "甲"), card("bad", "乙")], deps);
  assert.deepEqual(ids, ["ok"], "只有落盘成功的进回报");
  assert.deepEqual(saved, ["ok:甲"], "失败者不碰本地状态");
  assert.deepEqual(calls, ["ok", "bad"], "每张都试一次（不因前一张失败而跳过）");
  const threw = await applyEmittedCardUpdates([card("boom", "丙")], {
    saveCard: async () => {
      throw new Error("network");
    },
    onSaved: () => {
      throw new Error("不该被呼叫");
    },
  });
  assert.deepEqual(threw, [], "抛错＝失败（不谎报落盘成功）");
});

test("聚合更新＋补名合并成同一笔写盘（不互相覆盖）", () => {
  const cardId = entityCardIdForNode("view-1");
  const existing = [card(cardId, "正面", [IMG])];
  const aggregated = card(cardId, "正面", [IMG, IMG2]); // 聚合晚到的第二张图（名字还是旧的）
  const plan = { ...emptyPlan(), updatedCards: [aggregated] };
  const ref = entityRef("view-1", "正面", { input: "霍辞渊" }); // agent 晚到的真名
  const writes = planEmittedUpdateWrites(plan, [ref], existing, "2026-09-25T00:00:00.000Z");
  assert.equal(writes.length, 1, "同一张卡合成一笔（不是两笔互相覆盖）");
  assert.equal(writes[0].name, "霍辞渊", "补名生效");
  assert.equal(writes[0].references.length, 2, "聚合的第二张参考图同时保住（不因补名写盘而丢）");
  assert.equal(writes[0].id, cardId, "id 不变＝就地更新");
});

test("补名幂等：卡名已是真名 / 人手改过的名字 → 不产生写入（连续两轮收敛）", () => {
  const cardId = entityCardIdForNode("view-1");
  const ref = entityRef("view-1", "正面", { input: "霍辞渊" });
  const plan = emptyPlan();
  const first = planEmittedUpdateWrites(plan, [ref], [card(cardId, "正面")], "t1");
  assert.deepEqual(first.map((c) => c.name), ["霍辞渊"], "标题占位名 → 真名（一笔）");
  // 第二轮：把手写回来的卡当既有 → 计画为空
  assert.deepEqual(planEmittedUpdateWrites(plan, [ref], first, "t2"), [], "下一轮不再有写入");
  assert.deepEqual(
    planEmittedUpdateWrites(plan, [ref], [card(cardId, "我的角色")], "t3"),
    [],
    "人手改过的名字（≠ 节点标题）不被覆盖",
  );
  assert.deepEqual(
    planEmittedUpdateWrites(plan, [entityRef("view-1", "正面")], [card(cardId, "正面")], "t4"),
    [],
    "连真名都没有（agent 没写、第二来源空）→ 不产生写入，维持标题名",
  );
});

test("落卡收敛（真 planner）：第一轮落成 1 卡、第二轮零新建零更新", () => {
  const refs = [entityRef("view-1", "正面", { input: "霍辞渊" })];
  const round1 = emittedCardsForNodes(refs, []);
  assert.equal(round1.cards.length, 1, "第一轮落一张");
  assert.deepEqual(planEmittedUpdateWrites(round1, refs, [], "t"), [], "第一轮没有既存卡 → 零就地更新");
  // 落盘后：卡清单含该卡、节点已被写上 entityCardId 标记（呼叫端的幂等标记）
  const marked = [{ ...refs[0], metadata: { ...refs[0].metadata, entityCardId: round1.cards[0].id } }];
  const round2 = emittedCardsForNodes(marked, round1.cards);
  assert.equal(round2.cards.length, 0, "第二轮零新建");
  assert.deepEqual(
    planEmittedUpdateWrites(round2, marked, round1.cards, "t"),
    [],
    "第二轮零就地更新（连续两轮后不再有写入）",
  );
});

// ── 四视图聚合的**端到端**（真白名单 → 真 planner → 站点写入路径，2026-09-25）──
// 这是本刀唯一能证明「站点接线让聚合活过来」的链路：闸道形状的 metadata 过**真**
// toNodeMetadata(compactMetadataForAgent(...)) → 真 emittedCardsForNodes → 站点写入计画。

test("端到端：referenceNodeIds 活过双白名单 → 真 planner 把兄弟图并进同一张卡 → 站点就地落盘 → 下一轮收敛", async () => {
  const { toNodeMetadata } = await import("@/lib/canvas/layout");
  const { compactMetadataForAgent } = await import("./canvas-chat-types");
  // ① 闸道模板展开后的节点 metadata（view1 带引擎解析出的 referenceNodeIds）
  const rawView1 = {
    emitsEntity: { kind: "character", nameFrom: "input", referenceRoles: ["view2"], referenceNodeIds: ["view-2"] },
    input: "霍辞渊",
    content: IMG,
  };
  // ② 过真传输层：上行压缩 → 还原端清洗（这一对函式就是两个白名单）
  const view1 = toNodeMetadata(compactMetadataForAgent(rawView1 as never)) as Record<string, unknown>;
  assert.deepEqual((view1.emitsEntity as Record<string, unknown>).referenceNodeIds, ["view-2"], "白名单活著（漏了＝下面整条聚合不可能触发）");

  const view1Ref: AgentOutputNodeRef = { id: "view-1", title: "正面", metadata: view1 };
  const view2Ref = (content?: string): AgentOutputNodeRef => ({
    id: "view-2",
    title: "侧面",
    // 四视图只有 view1 带实体宣告（四颗都标会落四张重复卡）→ view2 只是「有交付图的兄弟」
    metadata: { ...(content ? { content } : {}) },
  });

  // ③ 第一轮：只有 view1 的图到了 → 落 1 张卡（自己的图）；站点零就地更新
  const refs1 = [view1Ref, view2Ref()];
  const round1 = emittedCardsForNodes(refs1, []);
  assert.equal(round1.cards.length, 1);
  assert.deepEqual(round1.cards[0].references.map((r) => r.url), [IMG], "兄弟图还没到＝只有自己那张");
  assert.deepEqual(round1.updatedCards, []);
  assert.deepEqual(planEmittedUpdateWrites(round1, refs1, [], "t1"), [], "零写盘");
  // ④ 落盘成功（站点把卡写回伺服器/本地）
  const persisted = [{ ...round1.cards[0] }];

  // ⑤ 第二轮：view2 的图晚到（渐进聚合）→ 计画给出 updatedCards → 站点落盘（id 不变）
  const refs2 = [view1Ref, view2Ref(IMG2)];
  const round2 = emittedCardsForNodes(refs2, persisted);
  assert.deepEqual(round2.cards, [], "不新建第二张卡（同一实体＝同一张卡）");
  assert.deepEqual(round2.updatedCards.map((c) => c.id), [round1.cards[0].id], "就地更新同一张卡");
  assert.deepEqual(round2.updatedCards[0].references.map((r) => r.url), [IMG, IMG2], "兄弟图并进来（顺序＝referenceNodeIds）");
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
  assert.deepEqual(saveCalls, [round1.cards[0].id], "有写入＝值得再触发一轮（签章含参考图数）");
  assert.deepEqual(reportedNeedsANextRound, [round1.cards[0].id]);

  // ⑥ 第三轮：参考图 url 集合已相符 → 计画空 → 站点零 I/O（收敛，真 oracle）
  const round3 = emittedCardsForNodes(refs2, writes);
  assert.deepEqual(round3.updatedCards, [], "第二轮之后计画为空");
  assert.deepEqual(planEmittedUpdateWrites(round3, refs2, writes, "t3"), []);
  let calls = 0;
  await applyEmittedCardUpdates(planEmittedUpdateWrites(round3, refs2, writes, "t3"), {
    saveCard: async () => {
      calls += 1;
      return true;
    },
    onSaved: () => {},
  });
  assert.equal(calls, 0, "连续两轮后不再有写入");
});

test("端到端：渲染图（view2）不带 emitsEntity 也不会自己落卡——只有聚合把它收进来", () => {
  const refs = [
    entityRef("view-1", "正面", { input: "霍辞渊", emitsEntity: { kind: "character", nameFrom: "input", referenceNodeIds: ["view-2"] } }),
    { id: "view-2", title: "侧面", metadata: { content: IMG2 } } as AgentOutputNodeRef,
  ];
  const plan = emittedCardsForNodes(refs, []);
  assert.equal(plan.cards.length, 1, "view2 没宣告 → 不落卡（四视图只标 view1 的设计）");
  assert.deepEqual(plan.cards[0].references.map((r) => r.url), [IMG, IMG2], "但它的图被并进 view1 的卡");
});