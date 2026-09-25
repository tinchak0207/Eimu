// G3 測試：StoryboardShotBody / StoryboardSceneBody 分鏡渲染消費端（2026-09-16）。
// 慣例（同 Scene3dPreview.test.ts）：node:test + 行為斷言（純函數直測 / SSR 渲染 /
// 源碼形狀斷言）。tsconfig 排除 *.test.tsx，故測試檔用 .ts + createElement（同款）。
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import * as React from "react";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";

// tsconfig jsx=preserve → classic runtime，SSR 渲染前補全局 React 桩（Scene3dPreview 同款）。
(globalThis as unknown as Record<string, unknown>).React ??= React;

function read(relPath: string) {
  return readFileSync(join(process.cwd(), relPath), "utf8");
}

import {
  SHOT_FIELD_GROUPS,
  SHOT_FIELD_LABEL,
  StoryboardSceneBody,
  StoryboardShotBody,
  storyboardFilledCount,
  storyboardShotRows,
} from "./StoryboardShotBody";
import { STORYBOARD_SHOT_FIELDS, type StoryboardScriptShot } from "@/lib/storyboard-contract";
import type { CanvasNode } from "@/lib/canvas/types";

const SHOT: StoryboardScriptShot = {
  shotNumber: "007",
  scriptContent: "她推开门，雨声灌进走廊。",
  visualDescription: "中景，女人推门而入，雨水顺着门框流下。",
  dialogue: "[林夏]：「你来了。」",
  actionState: "推门、侧身、抬头",
  narrativeFunction: "引入转折",
  timeOfDay: "深夜",
  eraCoordinate: "现代",
  dateCoordinate: "第三日",
  weather: "暴雨",
  referenceAssets: "场景:[旧公寓走廊] 角色:[林夏]、[陈述] 道具:[黄铜门把]",
  shotSize: "中景",
  cameraAngle: "平视",
  focalLength: "50mm 标准",
  cameraMovement: "跟拍",
  composition: "三分法",
  atmosphere: "压抑",
  colorTone: "冷青",
  lighting: "侧逆光",
  exposureBlur: "浅景深",
  soundEffect: "雨声、门轴声",
};

function shotNode(shot: StoryboardScriptShot | undefined, type = "text"): CanvasNode {
  return {
    id: "sb-1",
    type: type as CanvasNode["type"],
    title: "分镜 007",
    position: { x: 0, y: 0 },
    width: 340,
    height: 240,
    metadata: shot ? { storyboardShot: shot } : {},
  };
}

function sceneNode(scene: { sceneName: string; shotCount: number } | undefined): CanvasNode {
  return {
    id: "grp-1",
    type: "group" as CanvasNode["type"],
    title: "旧公寓走廊",
    position: { x: 0, y: 0 },
    width: 760,
    height: 480,
    metadata: scene ? { storyboardScene: scene } : {},
  };
}

// ─────────────────────────────────────────── 契約釘

test("分組切分：四組並集恰為 21 欄全清單（新增欄位忘歸組 → 本測紅，不靜默消失）", () => {
  const grouped = SHOT_FIELD_GROUPS.flatMap((g) => g.fields);
  const expected = STORYBOARD_SHOT_FIELDS.filter((f) => f !== "shotNumber");
  assert.deepEqual([...grouped].sort(), [...expected].sort());
  // 無重複歸組（同一欄出現在兩組 = 卡面重複渲染）
  assert.equal(new Set(grouped).size, grouped.length);
  // 每欄都有中文標籤，且無空標籤
  for (const f of STORYBOARD_SHOT_FIELDS) assert.ok(SHOT_FIELD_LABEL[f]?.length > 0, `缺標籤: ${f}`);
});

test("分組數 = 4（畫面/台词·音效/时空/摄影），摄影组含 9 欄", () => {
  assert.equal(SHOT_FIELD_GROUPS.length, 4);
  const camera = SHOT_FIELD_GROUPS.find((g) => g.key === "camera");
  assert.ok(camera);
  assert.equal(camera.fields.length, 9);
});

// ─────────────────────────────────────────── 純函數

test("storyboardShotRows：空值欄位不渲染該行（AID 空值 = \"\" 寫「无」是冒充）", () => {
  const groups = storyboardShotRows(SHOT);
  const rows = groups.flatMap((g) => g.rows);
  // 21 欄 - shotNumber（入卡頭徽章，不入列）= 20 行
  assert.equal(rows.length, 20);
  assert.ok(!rows.some((r) => r.field === "shotNumber"));

  const sparse = storyboardShotRows({ ...SHOT, dialogue: "", soundEffect: "", weather: "  " });
  const sparseRows = sparse.flatMap((g) => g.rows);
  assert.equal(sparseRows.length, 17);
  assert.ok(!sparseRows.some((r) => r.field === "dialogue"));
  // 台词·音效整组空 → 整组（含组标题）消失，不留空标题
  assert.ok(!sparse.some((g) => g.key === "voice"));
});

test("storyboardShotRows：组内顺序 = 契约顺序，组间顺序固定不重排", () => {
  const groups = storyboardShotRows(SHOT);
  assert.deepEqual(
    groups.map((g) => g.key),
    ["picture", "voice", "spacetime", "camera"],
  );
  const camera = groups.find((g) => g.key === "camera")!;
  assert.deepEqual(
    camera.rows.map((r) => r.field),
    ["shotSize", "cameraAngle", "focalLength", "cameraMovement", "composition", "atmosphere", "colorTone", "lighting", "exposureBlur"],
  );
});

test("storyboardFilledCount：數非空欄位（不灌水成百分比）", () => {
  assert.equal(storyboardFilledCount(SHOT), 21);
  assert.equal(storyboardFilledCount({ ...SHOT, dialogue: "", weather: "" }), 19);
});

// ─────────────────────────────────────────── SSR 渲染

test("分镜卡：关键欄位可见（镜号/剧本原文/视觉描述/台词/摄影四欄）", () => {
  const html = renderToStaticMarkup(createElement(StoryboardShotBody, { node: shotNode(SHOT) }));
  assert.match(html, /007/); // shotNumber
  assert.match(html, /她推开门，雨声灌进走廊。/); // scriptContent
  assert.match(html, /中景，女人推门而入/); // visualDescription
  assert.match(html, /你来了。/); // dialogue
  // 摄影四欄（最能体现专业度）
  assert.match(html, /中景/);
  assert.match(html, /平视/);
  assert.match(html, /50mm 标准/);
  assert.match(html, /跟拍/);
  // 分组标题
  for (const label of ["画面", "台词 · 音效", "时空", "摄影"]) assert.match(html, new RegExp(label));
});

test("分镜卡：referenceAssets 走 parseReferenceAssets 结构化（胶囊分类，不吐原始协议串）", () => {
  const html = renderToStaticMarkup(createElement(StoryboardShotBody, { node: shotNode(SHOT) }));
  assert.match(html, /旧公寓走廊/);
  assert.match(html, /林夏/);
  assert.match(html, /黄铜门把/);
  assert.doesNotMatch(html, /场景:\[/); // 原始协议串不应逐字吐出
});

test("分镜卡：无 storyboardShot 时显空态，不抛错", () => {
  const html = renderToStaticMarkup(createElement(StoryboardShotBody, { node: shotNode(undefined) }));
  assert.match(html, /分镜 · 等待 agent 填充/);
});

test("分镜场景壳：sceneName + 镜数可见；无欄位时回落原 Group 虚线框", () => {
  const html = renderToStaticMarkup(
    createElement(StoryboardSceneBody, { node: sceneNode({ sceneName: "旧公寓走廊", shotCount: 4 }) }),
  );
  assert.match(html, /旧公寓走廊/);
  assert.match(html, /4 镜/);

  const empty = renderToStaticMarkup(createElement(StoryboardSceneBody, { node: sceneNode(undefined) }));
  assert.match(empty, /border-dashed/);
});

test("正文 ≥13px 铁律：欄位值与徽章 ≥13px，12px 只给欄位名，11px 只给标签", () => {
  const html = renderToStaticMarkup(createElement(StoryboardShotBody, { node: shotNode(SHOT) }));
  const count = (px: string) => [...html.matchAll(new RegExp(`text-\\[${px}\\]`, "g"))].length;

  const rows = storyboardShotRows(SHOT).flatMap((g) => g.rows);
  const plainRows = rows.filter((r) => r.field !== "referenceAssets").length;
  // 引用资产：3 段胶囊（场景/角色/道具），共 4 个胶囊名
  const refCapsules = 4;

  // 正文盒（欄位值 + 胶囊名 + 镜号徽章）必须是 13px —— DESIGN.md §4「正文不小于 13px」
  assert.equal(count("13px"), plainRows + refCapsules + 1);
  // 11px 只给标签：eyebrow(1) + 已填徽章(1) + 组标题(4) + 引用分段名(3)
  assert.equal(count("11px"), 1 + 1 + SHOT_FIELD_GROUPS.length + 3);
  // 欄位名 12px（恰好每个非空欄位一个，不得大于正文）
  assert.equal(count("12px"), rows.length);
  // 无 <10px 正文
  assert.equal(count("10px"), 0);
  assert.doesNotMatch(html, /text-\[9px\]|text-ios-caption2/);
});

// ─────────────────────────────────────────── 接线形状（NodeBody 消费端）

test("NodeBody 已接分镜渲染：先於 type 分發的 storyboardShot 早退 + Group 分支 storyboardScene", () => {
  const source = read("src/components/canvas/node-view/NodeBody.tsx");
  assert.match(source, /import \{ StoryboardSceneBody, StoryboardShotBody \} from "\.\/StoryboardShotBody"/);
  // 欄位族早退必須在 switch (node.type) 之前（type 未受契約約束，綁 type 分支會漏渲染）
  const earlyReturn = source.indexOf("if (metadata?.storyboardShot) {");
  const switchAt = source.indexOf("switch (node.type) {");
  assert.ok(earlyReturn > 0 && switchAt > 0 && earlyReturn < switchAt, "storyboardShot 早退不在 switch 之前");
  // 批次封面早退在前（既有批次節點行為零改動）
  assert.ok(source.indexOf("batchPrimaryImageUrl && batchExpanded === false") < earlyReturn);
  // Group 分支有 storyboardScene 優先渲染，且保留原虛線框兜底
  assert.match(source, /if \(metadata\?\.storyboardScene\) \{/);
  assert.match(source, /border-dashed border-black\/10/);
  // 三件套手勢顯式傳入（不引 context）
  assert.match(source, /onScrollAreaPointerDown=\{onScrollAreaPointerDown\}/);
});

test("StoryboardShotBody 走既有 scrollDrag 三件套接手势（canvas-node-scroll，不引 context）", () => {
  const source = read("src/components/canvas/node-view/StoryboardShotBody.tsx");
  assert.match(source, /canvas-node-scroll/);
  assert.match(source, /touch-pan-y/);
  assert.match(source, /overscroll-contain/);
  // 只讀卡：無編輯/生成入口（與 Scene3dCardBody 同姿態）
  assert.doesNotMatch(source, /onEditPrompt|onRetry|run_generation/);
});

test("StoryboardShotBody 不重複定義契約：欄位清單單一真源 = storyboard-contract", () => {
  const source = read("src/components/canvas/node-view/StoryboardShotBody.tsx");
  assert.match(source, /from "@\/lib\/storyboard-contract"/);
  assert.match(source, /STORYBOARD_SHOT_FIELDS/);
  assert.match(source, /parseReferenceAssets/);
  // 禁止硬編 21 個 key 常數（會成為第二真源）
  assert.doesNotMatch(source, /const SHOT_FIELDS = \[/);
});

// ─────────────────────────────────────────── NodeBody 端到端接線（真渲染，非源碼形狀）

test("NodeBody 真渲染：text 型 + storyboardShot → 正文出镜号/剧本原文/摄影欄（非源碼形狀斷言）", async () => {
  const { NodeBody } = await import("./NodeBody");
  const noop = () => {};
  const html = renderToStaticMarkup(
    createElement(NodeBody, {
      node: shotNode(SHOT, "text"),
      scale: 1,
      onEditPrompt: noop,
      onScrollAreaPointerDown: noop,
      onScrollAreaPointerMove: noop,
      onScrollAreaPointerEnd: noop,
    }),
  );
  assert.match(html, /007/);
  assert.match(html, /她推开门，雨声灌进走廊。/);
  assert.match(html, /50mm 标准/);
});

test("NodeBody 真渲染：image 型 + storyboardShot → 仍走分镜正文（type 未受契约约束，绑 type 分支会漏）", async () => {
  const { NodeBody } = await import("./NodeBody");
  const noop = () => {};
  const html = renderToStaticMarkup(
    createElement(NodeBody, {
      node: shotNode(SHOT, "image"),
      scale: 1,
      onEditPrompt: noop,
      onScrollAreaPointerDown: noop,
      onScrollAreaPointerMove: noop,
      onScrollAreaPointerEnd: noop,
    }),
  );
  assert.match(html, /她推开门，雨声灌进走廊。/);
});

test("NodeBody 真渲染：Group + storyboardScene → 场景名+镜数；无该欄位的 Group → 保持原虚线框", async () => {
  const { NodeBody } = await import("./NodeBody");
  const noop = () => {};
  const props = {
    scale: 1,
    onEditPrompt: noop,
    onScrollAreaPointerDown: noop,
    onScrollAreaPointerMove: noop,
    onScrollAreaPointerEnd: noop,
  };
  const withScene = renderToStaticMarkup(
    createElement(NodeBody, { node: sceneNode({ sceneName: "旧公寓走廊", shotCount: 4 }), ...props }),
  );
  assert.match(withScene, /旧公寓走廊/);
  assert.match(withScene, /4 镜/);
  assert.doesNotMatch(withScene, /border-dashed/);

  const plain = renderToStaticMarkup(createElement(NodeBody, { node: sceneNode(undefined), ...props }));
  assert.match(plain, /border-dashed/);
});
