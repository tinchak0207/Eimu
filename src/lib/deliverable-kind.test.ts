import test from "node:test";
import assert from "node:assert/strict";

import {
  DELIVERABLE_KINDS,
  DELIVERABLE_KIND_IDS,
  assetItemKindOf,
  assetUrlFieldOf,
  deliverableKindLabel,
  deliverableKindOfResult,
  deliverableKindSpec,
  deliverableKindsByDetectPriority,
  filterableDeliverableKinds,
  isDeliverableKind,
} from "./deliverable-kind";
import type { DeliverableKind } from "./deliverable-kind";
import { GENERATION_MODEL_CATALOG } from "./generation-model-catalog/catalog";
import type { MediaKind } from "./generation-model-catalog/types";

// ─────────────────────────────────────────── MediaKind ↔ 注册表对齐

// 编译期守门：MediaKind 现由 DeliverableKind 推导（types.ts `export type MediaKind =
// DeliverableKind`）。若日后有人把 MediaKind 改回手写平行联集、且两者值域分歧，
// 这行赋值会 tsc 失败——本档在 tsc 扫描面内，等于把注解声明变成编译期事实。
const _mediaKindOfDeliverableKind: (kind: DeliverableKind) => MediaKind = (kind) => kind;
void _mediaKindOfDeliverableKind;

test("catalog 每个模型的 kind 都在 DELIVERABLE_KIND_IDS 内（独立 oracle：真 catalog 资料）", () => {
  const models = Object.values(GENERATION_MODEL_CATALOG);
  assert.ok(models.length > 0, "catalog 不得为空");
  for (const model of models) {
    assert.ok(
      isDeliverableKind(model.kind),
      `模型 ${model.id} 的 kind=${model.kind} 不在交付物注册表内`,
    );
  }
});

test("catalog 用到的 kind 集合与注册表 id 集合双向相等（无未承接种类、无孤儿 id）", () => {
  const usedByCatalog = new Set(Object.values(GENERATION_MODEL_CATALOG).map((model) => model.kind));
  // 方向一：catalog 出现的每种 kind 都必须已注册。
  for (const kind of usedByCatalog) {
    assert.ok(DELIVERABLE_KIND_IDS.includes(kind), `catalog 用了未注册的 kind: ${kind}`);
  }
  // 方向二：注册表每个 id 都至少有一个模型在用（无宣告了却没人承接的孤儿 id）。
  for (const id of DELIVERABLE_KIND_IDS) {
    assert.ok(usedByCatalog.has(id), `注册表 id ${id} 没有任何 catalog 模型使用`);
  }
});


// ─────────────────────────────────────────── 种类推断

test("deliverableKindOfResult 三种 URL 各自推出正确 id，顺序 image→video→audio", () => {
  assert.equal(deliverableKindOfResult({ imageUrl: "https://x/a.png" }), "image");
  assert.equal(deliverableKindOfResult({ videoUrl: "https://x/a.mp4" }), "video");
  assert.equal(deliverableKindOfResult({ audioUrl: "https://x/a.mp3" }), "audio");

  // 多栏位同时非空时，按注册表宣告序 image → video → audio 取先者。
  assert.equal(
    deliverableKindOfResult({
      imageUrl: "https://x/a.png",
      videoUrl: "https://x/a.mp4",
      audioUrl: "https://x/a.mp3",
    }),
    "image",
  );
});

test("deliverableKindOfResult 对空 / 缺栏 / 空白字串一律回 null", () => {
  assert.equal(deliverableKindOfResult({}), null);
  assert.equal(deliverableKindOfResult({ imageUrl: null, videoUrl: null, audioUrl: null }), null);
  assert.equal(deliverableKindOfResult({ imageUrl: "" }), null);
  assert.equal(deliverableKindOfResult({ imageUrl: "   " }), null);
  // 非字串（畸形输入）不当成有值。
  assert.equal(deliverableKindOfResult({ videoUrl: 42 as unknown as string }), null);
});

// ─────────────────────────────────────────── 白名单

test("isDeliverableKind 只放行注册表里的种类", () => {
  for (const kind of DELIVERABLE_KINDS) {
    assert.equal(isDeliverableKind(kind.id), true, `${kind.id} 应放行`);
  }
  assert.equal(isDeliverableKind("garbage"), false);
  // workflow 不是交付物：由 history-types 的 NON_DELIVERABLE_ENTRY_KINDS 承接。
  assert.equal(isDeliverableKind("workflow"), false);
  assert.equal(isDeliverableKind(undefined), false);
  assert.equal(isDeliverableKind(null), false);
  assert.equal(isDeliverableKind(7), false);
});

// ─────────────────────────────────────────── 清单同步（防两份清单走钟）

test("DELIVERABLE_KIND_IDS 与 DELIVERABLE_KINDS.map(id) 逐值相等", () => {
  assert.deepEqual([...DELIVERABLE_KIND_IDS], DELIVERABLE_KINDS.map((kind) => kind.id));
});

// ─────────────────────────────────────────── 资产侧映射（三态）

test("assetItemKindOf / assetUrlFieldOf 三态映射正确", () => {
  assert.equal(assetItemKindOf("image"), "image");
  assert.equal(assetUrlFieldOf("image"), "imageUrl");

  assert.equal(assetItemKindOf("video"), "video");
  assert.equal(assetUrlFieldOf("video"), "mediaUrl");

  assert.equal(assetItemKindOf("audio"), "audio");
  assert.equal(assetUrlFieldOf("audio"), "mediaUrl");
});

// ─────────────────────────────────────────── 规格 / 文案

test("deliverableKindSpec / deliverableKindLabel 回注册表真源值", () => {
  assert.equal(deliverableKindSpec("image").resultField, "imageUrl");
  assert.equal(deliverableKindSpec("video").playable, true);
  assert.equal(deliverableKindSpec("audio").playable, true);
  assert.equal(deliverableKindSpec("image").playable, false);
  // label 是 UI 文案真源（简体）：audio 刻意叫「音乐」，与站内既有口径一致。
  assert.equal(deliverableKindLabel("image"), "图片");
  assert.equal(deliverableKindLabel("video"), "视频");
  assert.equal(deliverableKindLabel("audio"), "音乐");
});

// ─────────────────────────────────────────── 扩充性

test("filterableDeliverableKinds 的长度与内容完全由 DELIVERABLE_KINDS 推导", () => {
  const filterable = filterableDeliverableKinds();
  const expected = DELIVERABLE_KINDS.filter((kind) => kind.filterable);
  assert.equal(filterable.length, expected.length);
  assert.deepEqual(
    filterable.map((kind) => kind.id),
    expected.map((kind) => kind.id),
  );
  // 每一项都确实标记 filterable（不是别处硬写的清单）。
  for (const kind of filterable) {
    assert.equal(kind.filterable, true);
  }
});

test("注册表每一行的 resultField / assetUrlField 都在合法值域内", () => {
  const resultFields = new Set(["imageUrl", "videoUrl", "audioUrl"]);
  const assetUrlFields = new Set(["imageUrl", "mediaUrl"]);
  for (const kind of DELIVERABLE_KINDS) {
    assert.ok(resultFields.has(kind.resultField), `${kind.id} resultField 非法`);
    assert.ok(assetUrlFields.has(kind.assetUrlField), `${kind.id} assetUrlField 非法`);
    assert.equal(typeof kind.label, "string");
    assert.ok(kind.label.length > 0, `${kind.id} 缺 UI 文案`);
  }
});

// ─────────────────────────────────────────── detectPriority（扩充性契约）

test("注册表每个种类都带有限数字 detectPriority（新增种类忘填＝测试咬住，不只编译错）", () => {
  for (const kind of DELIVERABLE_KINDS) {
    assert.equal(typeof kind.detectPriority, "number", `${kind.id} 缺 detectPriority`);
    assert.ok(Number.isFinite(kind.detectPriority), `${kind.id} detectPriority 非有限数字`);
  }
});

test("deliverableKindsByDetectPriority 按 detectPriority 升序（期待值由注册表推导，不写死清单）", () => {
  const actual = [...deliverableKindsByDetectPriority()];
  // 期待值不手写：由注册表 detectPriority 升序、同值按宣告序推导而来。
  const expected = [...DELIVERABLE_KINDS]
    .map((kind, index) => ({ id: kind.id, priority: kind.detectPriority, index }))
    .sort((a, b) => a.priority - b.priority || a.index - b.index)
    .map((item) => item.id);
  assert.deepEqual(actual, expected, "顺序必须完全由 detectPriority 推导");

  // 既有语义逐值：video 先于 audio 先于 image（用 detectPriority 比大小断言，
  // 不写死完整清单——将来新增种类不会误伤本测试）。
  assert.ok(
    deliverableKindSpec("video").detectPriority < deliverableKindSpec("audio").detectPriority,
    "video 必须优于 audio",
  );
  assert.ok(
    deliverableKindSpec("audio").detectPriority < deliverableKindSpec("image").detectPriority,
    "audio 必须优于 image",
  );
  // 排序结果与注册表三行的位置一致：video / audio / image 依次出现。
  assert.ok(actual.indexOf("video") < actual.indexOf("audio"), "video 应排在 audio 前");
  assert.ok(actual.indexOf("audio") < actual.indexOf("image"), "audio 应排在 image 前");
});

test("deliverableKindsByDetectPriority 与注册表 id 集合相等（无遗漏、无捏造）", () => {
  const order = [...deliverableKindsByDetectPriority()];
  assert.equal(order.length, DELIVERABLE_KINDS.length, "序列长度必须等于注册表行数");
  for (const id of DELIVERABLE_KIND_IDS) {
    assert.ok(order.includes(id), `${id} 必须出现在优先序里`);
  }
  assert.deepEqual([...order].sort(), [...DELIVERABLE_KIND_IDS].sort());
});

test("deliverableKindsByDetectPriority 逐值等于 detectPriority 数值本身手工排序（独立 oracle，非重跑实现）", () => {
  // 独立来源：10/20/30 是「值本身」——写死为 oracle 的 detectPriority 承诺值，
  // 不依赖实现的 sort，也不由 DELIVERABLE_KINDS 现算（避免同源断言）。
  const oraclePriorityByKind: Record<string, number> = { image: 30, video: 10, audio: 20 };
  // 先核注册表宣告值 == oracle 值（值本身即资料，而非用实作反推）。
  for (const kind of DELIVERABLE_KINDS) {
    assert.equal(
      kind.detectPriority,
      oraclePriorityByKind[kind.id],
      `${kind.id} detectPriority 与 oracle 承诺值不符`,
    );
  }
  // 把 oracle 的值手工升序排序后映射回种类，与实作输出逐值比对。
  const handSorted = Object.entries(oraclePriorityByKind)
    .sort((a, b) => a[1] - b[1])
    .map(([id]) => id);
  assert.deepEqual([...deliverableKindsByDetectPriority()], handSorted);
  // 独立再钉一次既有语义：10(video) < 20(audio) < 30(image)。
  assert.deepEqual(handSorted, ["video", "audio", "image"]);
});
