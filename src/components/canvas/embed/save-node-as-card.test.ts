// 存為卡（P2）五值化 + 變體母卡（variantOf）行為斷言。
//
// 全部為**行為斷言**：直接跑真函式、比對真輸出（原始物件 / 選單項 / 真清洗器），
// 不用源碼字串斷言（源碼掃描只算變更探針，不計入「已驗證」）。
//   - buildNodeCard：五種 kind 的預設名與提示標籤（prop → 道具卡、audio → 音频卡）
//   - variantOf 三態：母卡存在→寫入；母卡不存在→不寫該欄位；kind 非 character→不寫
//   - 選單：存為卡子項由值域驅動（前三個 id 與舊字面值逐字相同）、變體子選單的
//     零母卡 / ≤8 / >8 三態與 onSelect 真呼叫參數
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

// ─────────────────────────────────────────── buildNodeCard：預設名與標籤

test("buildNodeCard：無標題節點 → 五種 kind 的預設名與提示標籤正確（prop/audio 不再誤標风格卡）", () => {
  const oracle: Record<CharacterCardKind, string> = {
    character: "角色卡",
    scene: "场景卡",
    style: "风格卡",
    prop: "道具卡",
    audio: "音频卡",
  };
  for (const kind of CHARACTER_CARD_KIND_VALUES) {
    const built = buildNodeCard(refNode(), kind, undefined, []);
    assert.ok(built, `${kind} 有圖節點必須建出卡`);
    assert.equal(built.card.kind, kind);
    assert.equal(built.card.name, oracle[kind], `${kind} 預設名`);
    assert.equal(built.message, `已存为${oracle[kind]}并锁定：${oracle[kind]}`, `${kind} 提示文案`);
  }
});

test("buildNodeCard：有標題節點 → 卡名用標題、提示標籤仍按 kind 查表", () => {
  const built = buildNodeCard(refNode({ title: "霓虹街景" }), "prop", undefined, []);
  assert.ok(built);
  assert.equal(built.card.name, "霓虹街景");
  assert.equal(built.message, "已存为道具卡并锁定：霓虹街景");
});

test("buildNodeCard：無圖節點 → 回 null（呼叫端原樣早退，零行為漂移）", () => {
  assert.equal(buildNodeCard(refNode({ metadata: { content: "not-a-url" } }), "character", undefined, []), null);
  assert.equal(buildNodeCard(refNode({ metadata: undefined }), "character", undefined, []), null);
});

test("buildNodeCard：既有欄位零漂移（純參考圖卡、role 默認 general、參考圖名回退）", () => {
  const built = buildNodeCard(refNode({ metadata: { content: IMAGE_URL, referenceRole: undefined } }), "scene", undefined, []);
  assert.ok(built);
  assert.equal(built.card.prompt, "");
  assert.deepEqual(built.card.references, [{ url: IMAGE_URL, role: "general", name: "参考图" }]);
  assert.equal(built.card.createdAt, built.card.updatedAt);
  assert.ok(built.card.id.startsWith("card-"));
});

// ─────────────────────────────────────────── variantOf 三態（唯一生產者）

test("variantOf：母卡存在（kind=character）→ 寫入 variantOf 且提示看得出來是變體", () => {
  const mother = existingCard("card-mother", "character", "霍辞渊");
  const built = buildNodeCard(refNode({ title: "霍辞渊-侠客造型" }), "character", { variantOf: mother.id }, [mother, existingCard("card-other", "character", "别人的卡")]);
  assert.ok(built);
  assert.equal(built.card.kind, "character");
  assert.equal(built.card.variantOf, "card-mother");
  assert.equal(built.message, "已存为角色变体卡并锁定：霍辞渊-侠客造型（母卡：霍辞渊）");
});

test("variantOf：母卡不存在 → 不寫入該欄位（鍵不存在，不是 undefined）", () => {
  const built = buildNodeCard(refNode({ title: "孤兒卡" }), "character", { variantOf: "card-ghost" }, [existingCard("card-real", "character")]);
  assert.ok(built);
  assert.equal(Object.prototype.hasOwnProperty.call(built.card, "variantOf"), false);
  assert.equal(built.message, "已存为角色卡并锁定：孤兒卡");
});

test("variantOf：kind 非 character → 不寫入該欄位（即使 id 指向存在的角色卡）", () => {
  const mother = existingCard("card-mother", "character", "霍辞渊");
  for (const kind of ["scene", "style", "prop", "audio"] as CharacterCardKind[]) {
    const built = buildNodeCard(refNode(), kind, { variantOf: mother.id }, [mother]);
    assert.ok(built);
    assert.equal(Object.prototype.hasOwnProperty.call(built.card, "variantOf"), false, `${kind} 不應寫 variantOf`);
  }
});

test("variantOf：空字串 / 純空白 → 不寫入該欄位", () => {
  const mother = existingCard("card-mother", "character");
  for (const raw of ["", "   ", "\t\n"]) {
    const built = buildNodeCard(refNode(), "character", { variantOf: raw }, [mother]);
    assert.ok(built);
    assert.equal(Object.prototype.hasOwnProperty.call(built.card, "variantOf"), false, `variantOf=${JSON.stringify(raw)} 不應寫入`);
  }
});

test("variantOf：id 指向的卡 kind 不是 character → 不算母卡、不寫入", () => {
  const built = buildNodeCard(refNode(), "character", { variantOf: "card-scene" }, [existingCard("card-scene", "scene")]);
  assert.ok(built);
  assert.equal(Object.prototype.hasOwnProperty.call(built.card, "variantOf"), false);
});

test("variantOf：建出的變體卡過真清洗器後欄位存活（端到端到 store 的形狀）", () => {
  const mother = existingCard("card-mother", "character", "霍辞渊");
  const built = buildNodeCard(refNode({ title: "霍辞渊-侠客造型" }), "character", { variantOf: mother.id }, [mother]);
  assert.ok(built);
  const normalized = normalizeCharacterCard(built.card);
  assert.ok(normalized, "建出的卡必須過清洗器");
  assert.equal(normalized?.variantOf, "card-mother");
  assert.equal(normalized?.name, "霍辞渊-侠客造型");
});

// ─────────────────────────────────────────── 右鍵選單：五值化 + 變體入口

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

test("選單：存為卡子項五值化——id/標籤由值域驅動，舊三個 id 逐字不變", () => {
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
  assert.equal(children[4].label, "存为音频卡", "audio 不得再顯示成风格卡");
});

test("選單：五個子項的 onSelect 真的把對應 kind 傳給 saveNodeAsCard", () => {
  const node = refNode({ id: "n-ref" });
  const calls: { id: string; kind: CharacterCardKind; options?: { variantOf?: string } }[] = [];
  const saveAsCard = itemById(menuItemsFor(node, [], (_n, kind, options) => calls.push({ id: "n-ref", kind, options })), "save-as-card");
  for (const child of saveAsCard!.children!) child.onSelect?.();
  assert.deepEqual(
    calls.map((call) => call.kind),
    ["character", "scene", "style", "prop", "audio"],
  );
  assert.equal(calls.every((call) => call.options === undefined), true, "普通存卡不得帶 variantOf");
});

test("選單：有母卡 → 渲染變體子選單，子項 id/標籤取自母卡，onSelect 帶 variantOf", () => {
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
  assert.ok(variant, "有母卡時必須渲染變體入口");
  assert.equal(variant.label, "存为角色变体卡");
  assert.deepEqual(
    variant.children!.map((child) => child.id),
    ["save-variant-card-a", "save-variant-card-b"],
    "只有 kind=character 的卡可當母卡",
  );
  assert.deepEqual(variant.children!.map((child) => child.label), ["霍辞渊", "劼后"]);
  variant.children![0].onSelect?.();
  assert.deepEqual(calls, [{ kind: "character", options: { variantOf: "card-a" } }]);
});

test("選單：零母卡 → 不渲染變體子選單（不留死路徑）", () => {
  const node = refNode({ id: "n-ref" });
  const items = menuItemsFor(node, [existingCard("card-s", "scene"), existingCard("card-au", "audio")], () => {});
  assert.equal(itemById(items, "save-as-variant"), undefined);
});

test("選單：母卡數 == 上限 8 → 渲染；> 8 → 整個子選單不渲染（不靜默截斷、不造死按鈕）", () => {
  const node = refNode({ id: "n-ref" });
  const make = (n: number) => Array.from({ length: n }, (_, i) => existingCard(`card-${i}`, "character", `母卡${i}`));
  const atLimit = itemById(menuItemsFor(node, make(MAX_VARIANT_MOTHER_CARDS), () => {}), "save-as-variant");
  assert.ok(atLimit, "剛好 8 張必須渲染");
  assert.equal(atLimit.children!.length, MAX_VARIANT_MOTHER_CARDS);
  const overLimit = menuItemsFor(node, make(MAX_VARIANT_MOTHER_CARDS + 1), () => {});
  assert.equal(itemById(overLimit, "save-as-variant"), undefined, ">8 張整個不渲染");
  // 存為卡子項不受影響（永遠五項）
  assert.equal(itemById(overLimit, "save-as-card")!.children!.length, CHARACTER_CARD_KIND_VALUES.length);
});

test("選單：非 reference 節點（無圖）不出現存卡與變體項（零回歸）", () => {
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