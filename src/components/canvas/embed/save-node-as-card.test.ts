// 存为卡（P2）五值化 + 变体母卡（variantOf）行为断言。
//
// 全部为**行为断言**：直接跑真函式、比对真输出（原始物件 / 选单项 / 真清洗器），
// 不用源码字串断言（源码扫描只算变更探针，不计入「已验证」）。
//   - buildNodeCard：五种 kind 的预设名与提示标签（prop → 道具卡、audio → 音频卡）
//   - variantOf 三态：母卡存在→写入；母卡不存在→不写该栏位；kind 非 character→不写
//   - 选单：存为卡子项由值域驱动（前三个 id 与旧字面值逐字相同）、变体子选单的
//     零母卡 / ≤8 / >8 三态与 onSelect 真呼叫参数
import { test } from "node:test";
import assert from "node:assert/strict";
import { CanvasNodeType, type CanvasNode } from "@/lib/canvas/types";
import {
  CHARACTER_CARD_KIND_VALUES,
  normalizeCharacterCard,
  type CharacterCard,
  type CharacterCardKind,
} from "@/lib/character-cards";
import { buildNodeCard } from "./use-canvas-interaction";
import { buildCanvasEmbedMenuItems, MAX_VARIANT_MOTHER_CARDS, type CanvasEmbedMenuItemsInput } from "./context-menu-items";
import type { CanvasMenuItem } from "../CanvasContextMenu";

const IMAGE_URL = "https://img.example/ref.png";

function refNode(partial: Partial<CanvasNode> = {}): CanvasNode {
  return {
    id: "n1",
    type: CanvasNodeType.Reference,
    title: "",
    position: { x: 0, y: 0 },
    width: 300,
    height: 260,
    metadata: { content: IMAGE_URL },
    ...partial,
  };
}

function existingCard(id: string, kind: CharacterCardKind, name = id): CharacterCard {
  return {
    id,
    name,
    kind,
    prompt: "",
    references: [],
    createdAt: "2026-09-24T00:00:00.000Z",
    updatedAt: "2026-09-24T00:00:00.000Z",
  };
}

// ─────────────────────────────────────────── buildNodeCard：预设名与标签

test("buildNodeCard：无标题节点 → 五种 kind 的预设名与提示标签正确（prop/audio 不再误标风格卡）", () => {
  const oracle: Record<CharacterCardKind, string> = {
    character: "角色卡",
    scene: "场景卡",
    style: "风格卡",
    prop: "道具卡",
    audio: "音频卡",
  };
  for (const kind of CHARACTER_CARD_KIND_VALUES) {
    const built = buildNodeCard(refNode(), kind, undefined, []);
    assert.ok(built, `${kind} 有图节点必须建出卡`);
    assert.equal(built.card.kind, kind);
    assert.equal(built.card.name, oracle[kind], `${kind} 预设名`);
    assert.equal(built.message, `已存为${oracle[kind]}并锁定：${oracle[kind]}`, `${kind} 提示文案`);
  }
});

test("buildNodeCard：有标题节点 → 卡名用标题、提示标签仍按 kind 查表", () => {
  const built = buildNodeCard(refNode({ title: "霓虹街景" }), "prop", undefined, []);
  assert.ok(built);
  assert.equal(built.card.name, "霓虹街景");
  assert.equal(built.message, "已存为道具卡并锁定：霓虹街景");
});

test("buildNodeCard：无图节点 → 回 null（呼叫端原样早退，零行为漂移）", () => {
  assert.equal(buildNodeCard(refNode({ metadata: { content: "not-a-url" } }), "character", undefined, []), null);
  assert.equal(buildNodeCard(refNode({ metadata: undefined }), "character", undefined, []), null);
});

test("buildNodeCard：既有栏位零漂移（纯参考图卡、role 默认 general、参考图名回退）", () => {
  const built = buildNodeCard(refNode({ metadata: { content: IMAGE_URL, referenceRole: undefined } }), "scene", undefined, []);
  assert.ok(built);
  assert.equal(built.card.prompt, "");
  assert.deepEqual(built.card.references, [{ url: IMAGE_URL, role: "general", name: "参考图" }]);
  assert.equal(built.card.createdAt, built.card.updatedAt);
  assert.ok(built.card.id.startsWith("card-"));
});

// ─────────────────────────────────────────── variantOf 三态（唯一生产者）

test("variantOf：母卡存在（kind=character）→ 写入 variantOf 且提示看得出来是变体", () => {
  const mother = existingCard("card-mother", "character", "霍辞渊");
  const built = buildNodeCard(refNode({ title: "霍辞渊-侠客造型" }), "character", { variantOf: mother.id }, [mother, existingCard("card-other", "character", "别人的卡")]);
  assert.ok(built);
  assert.equal(built.card.kind, "character");
  assert.equal(built.card.variantOf, "card-mother");
  assert.equal(built.message, "已存为角色变体卡并锁定：霍辞渊-侠客造型（母卡：霍辞渊）");
});

test("variantOf：母卡不存在 → 不写入该栏位（键不存在，不是 undefined）", () => {
  const built = buildNodeCard(refNode({ title: "孤儿卡" }), "character", { variantOf: "card-ghost" }, [existingCard("card-real", "character")]);
  assert.ok(built);
  assert.equal(Object.prototype.hasOwnProperty.call(built.card, "variantOf"), false);
  assert.equal(built.message, "已存为角色卡并锁定：孤儿卡");
});

test("variantOf：kind 非 character → 不写入该栏位（即使 id 指向存在的角色卡）", () => {
  const mother = existingCard("card-mother", "character", "霍辞渊");
  for (const kind of ["scene", "style", "prop", "audio"] as CharacterCardKind[]) {
    const built = buildNodeCard(refNode(), kind, { variantOf: mother.id }, [mother]);
    assert.ok(built);
    assert.equal(Object.prototype.hasOwnProperty.call(built.card, "variantOf"), false, `${kind} 不应写 variantOf`);
  }
});

test("variantOf：空字串 / 纯空白 → 不写入该栏位", () => {
  const mother = existingCard("card-mother", "character");
  for (const raw of ["", "   ", "\t\n"]) {
    const built = buildNodeCard(refNode(), "character", { variantOf: raw }, [mother]);
    assert.ok(built);
    assert.equal(Object.prototype.hasOwnProperty.call(built.card, "variantOf"), false, `variantOf=${JSON.stringify(raw)} 不应写入`);
  }
});

test("variantOf：id 指向的卡 kind 不是 character → 不算母卡、不写入", () => {
  const built = buildNodeCard(refNode(), "character", { variantOf: "card-scene" }, [existingCard("card-scene", "scene")]);
  assert.ok(built);
  assert.equal(Object.prototype.hasOwnProperty.call(built.card, "variantOf"), false);
});

test("variantOf：建出的变体卡过真清洗器后栏位存活（端到端到 store 的形状）", () => {
  const mother = existingCard("card-mother", "character", "霍辞渊");
  const built = buildNodeCard(refNode({ title: "霍辞渊-侠客造型" }), "character", { variantOf: mother.id }, [mother]);
  assert.ok(built);
  const normalized = normalizeCharacterCard(built.card);
  assert.ok(normalized, "建出的卡必须过清洗器");
  assert.equal(normalized?.variantOf, "card-mother");
  assert.equal(normalized?.name, "霍辞渊-侠客造型");
});

// ─────────────────────────────────────────── 右键选单：五值化 + 变体入口

function menuItemsFor(node: CanvasNode, cards: CharacterCard[], onSave: (node: CanvasNode, kind: CharacterCardKind, options?: { variantOf?: string }) => void) {
  const input = {
    menu: { position: { x: 0, y: 0 }, world: { x: 0, y: 0 }, targetNodeId: node.id },
    nodeById: new Map([[node.id, node]]),
    childToParent: new Map<string, string>(),
    visibleNodes: [node],
    upscalingIds: new Set<string>(),
    selectedIdsRef: { current: new Set([node.id]) },
    canvasStateRef: { current: { characterCards: cards } },
    clipboardRef: { current: null },
    viewportSizeRef: { current: { width: 0, height: 0 } },
    saveNodeAsCard: async (target: CanvasNode, kind: CharacterCardKind, options?: { variantOf?: string }) => {
      onSave(target, kind, options);
    },
  } as unknown as CanvasEmbedMenuItemsInput;
  return buildCanvasEmbedMenuItems(input);
}

function itemById(items: (CanvasMenuItem | "separator")[], id: string): CanvasMenuItem | undefined {
  return items.find((item): item is CanvasMenuItem => item !== "separator" && item.id === id);
}

test("选单：存为卡子项五值化——id/标签由值域驱动，旧三个 id 逐字不变", () => {
  const node = refNode({ id: "n-ref" });
  const saveAsCard = itemById(menuItemsFor(node, [], () => {}), "save-as-card");
  assert.ok(saveAsCard?.children);
  const children = saveAsCard.children!;
  assert.equal(children.length, CHARACTER_CARD_KIND_VALUES.length);
  assert.deepEqual(
    children.map((child) => child.id),
    ["save-card-character", "save-card-scene", "save-card-style", "save-card-prop", "save-card-audio"],
  );
  assert.deepEqual(
    children.map((child) => child.label),
    ["存为角色卡", "存为场景卡", "存为风格卡", "存为道具卡", "存为音频卡"],
  );
  assert.equal(children[4].label, "存为音频卡", "audio 不得再显示成风格卡");
});

test("选单：五个子项的 onSelect 真的把对应 kind 传给 saveNodeAsCard", () => {
  const node = refNode({ id: "n-ref" });
  const calls: { id: string; kind: CharacterCardKind; options?: { variantOf?: string } }[] = [];
  const saveAsCard = itemById(menuItemsFor(node, [], (_n, kind, options) => calls.push({ id: "n-ref", kind, options })), "save-as-card");
  for (const child of saveAsCard!.children!) child.onSelect?.();
  assert.deepEqual(
    calls.map((call) => call.kind),
    ["character", "scene", "style", "prop", "audio"],
  );
  assert.equal(calls.every((call) => call.options === undefined), true, "普通存卡不得带 variantOf");
});

test("选单：有母卡 → 渲染变体子选单，子项 id/标签取自母卡，onSelect 带 variantOf", () => {
  const node = refNode({ id: "n-ref" });
  const mothers = [
    existingCard("card-a", "character", "霍辞渊"),
    existingCard("card-b", "character", "劼后"),
    existingCard("card-c", "scene", "雨夜街道"),
    existingCard("card-d", "audio", "片头曲"),
  ];
  const calls: { kind: CharacterCardKind; options?: { variantOf?: string } }[] = [];
  const items = menuItemsFor(node, mothers, (_n, kind, options) => calls.push({ kind, options }));
  const variant = itemById(items, "save-as-variant");
  assert.ok(variant, "有母卡时必须渲染变体入口");
  assert.equal(variant.label, "存为角色变体卡");
  assert.deepEqual(
    variant.children!.map((child) => child.id),
    ["save-variant-card-a", "save-variant-card-b"],
    "只有 kind=character 的卡可当母卡",
  );
  assert.deepEqual(variant.children!.map((child) => child.label), ["霍辞渊", "劼后"]);
  variant.children![0].onSelect?.();
  assert.deepEqual(calls, [{ kind: "character", options: { variantOf: "card-a" } }]);
});

test("选单：零母卡 → 不渲染变体子选单（不留死路径）", () => {
  const node = refNode({ id: "n-ref" });
  const items = menuItemsFor(node, [existingCard("card-s", "scene"), existingCard("card-au", "audio")], () => {});
  assert.equal(itemById(items, "save-as-variant"), undefined);
});

test("选单：母卡数 == 上限 8 → 渲染；> 8 → 整个子选单不渲染（不静默截断、不造死按钮）", () => {
  const node = refNode({ id: "n-ref" });
  const make = (n: number) => Array.from({ length: n }, (_, i) => existingCard(`card-${i}`, "character", `母卡${i}`));
  const atLimit = itemById(menuItemsFor(node, make(MAX_VARIANT_MOTHER_CARDS), () => {}), "save-as-variant");
  assert.ok(atLimit, "刚好 8 张必须渲染");
  assert.equal(atLimit.children!.length, MAX_VARIANT_MOTHER_CARDS);
  const overLimit = menuItemsFor(node, make(MAX_VARIANT_MOTHER_CARDS + 1), () => {});
  assert.equal(itemById(overLimit, "save-as-variant"), undefined, ">8 张整个不渲染");
  // 存为卡子项不受影响（永远五项）
  assert.equal(itemById(overLimit, "save-as-card")!.children!.length, CHARACTER_CARD_KIND_VALUES.length);
});

test("选单：非 reference 节点（无图）不出现存卡与变体项（零回归）", () => {
  const node: CanvasNode = {
    id: "n-text",
    type: CanvasNodeType.Text,
    title: "文本",
    position: { x: 0, y: 0 },
    width: 340,
    height: 240,
  };
  const items = menuItemsFor(node, [existingCard("card-a", "character")], () => {});
  assert.equal(itemById(items, "save-as-card"), undefined);
  assert.equal(itemById(items, "save-as-variant"), undefined);
});