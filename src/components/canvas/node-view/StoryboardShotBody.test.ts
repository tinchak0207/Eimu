// G3 测试：StoryboardShotBody / StoryboardSceneBody 分镜渲染消费端（2026-09-16）。
// 惯例（同 Scene3dPreview.test.ts）：node:test + 行为断言（纯函数直测 / SSR 渲染 /
// 源码形状断言）。tsconfig 排除 *.test.tsx，故测试档用 .ts + createElement（同款）。
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import * as React from "react";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";

// tsconfig jsx=preserve → classic runtime，SSR 渲染前补全局 React 桩（Scene3dPreview 同款）。
(globalThis as unknown as Record<string, unknown>).React ??= React;

function read(relPath: string) {
  return readFileSync(join(process.cwd(), relPath), "utf8");
}

import {
  SHOT_FIELD_GROUPS,
  SHOT_FIELD_LABEL,
  StoryboardSceneBody,
  StoryboardShotBody,
  shotAudioBindOutcome,
  shotAudioClearOutcome,
  storyboardFilledCount,
  storyboardShotRows,
} from "./StoryboardShotBody";
import { STORYBOARD_SHOT_FIELDS, type StoryboardScriptShot } from "@/lib/storyboard-contract";
import { toNodeMetadata } from "@/lib/canvas/layout";
import type { CanvasNode, CanvasNodeMetadata } from "@/lib/canvas/types";

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

// ─────────────────────────────────────────── 契约钉

test("分组切分：四组并集恰为 21 栏全清单（新增栏位忘归组 → 本测红，不静默消失）", () => {
  const grouped = SHOT_FIELD_GROUPS.flatMap((g) => g.fields);
  const expected = STORYBOARD_SHOT_FIELDS.filter((f) => f !== "shotNumber");
  assert.deepEqual([...grouped].sort(), [...expected].sort());
  // 无重复归组（同一栏出现在两组 = 卡面重复渲染）
  assert.equal(new Set(grouped).size, grouped.length);
  // 每栏都有中文标签，且无空标签
  for (const f of STORYBOARD_SHOT_FIELDS) assert.ok(SHOT_FIELD_LABEL[f]?.length > 0, `缺标签: ${f}`);
});

test("分组数 = 4（画面/台词·音效/时空/摄影），摄影组含 9 栏", () => {
  assert.equal(SHOT_FIELD_GROUPS.length, 4);
  const camera = SHOT_FIELD_GROUPS.find((g) => g.key === "camera");
  assert.ok(camera);
  assert.equal(camera.fields.length, 9);
});

// ─────────────────────────────────────────── 纯函数

test("storyboardShotRows：空值栏位不渲染该行（AID 空值 = \"\" 写「无」是冒充）", () => {
  const groups = storyboardShotRows(SHOT);
  const rows = groups.flatMap((g) => g.rows);
  // 21 栏 - shotNumber（入卡头徽章，不入列）= 20 行
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

test("storyboardFilledCount：数非空栏位（不灌水成百分比）", () => {
  assert.equal(storyboardFilledCount(SHOT), 21);
  assert.equal(storyboardFilledCount({ ...SHOT, dialogue: "", weather: "" }), 19);
});

// ─────────────────────────────────────────── SSR 渲染

test("分镜卡：关键栏位可见（镜号/剧本原文/视觉描述/台词/摄影四栏）", () => {
  const html = renderToStaticMarkup(createElement(StoryboardShotBody, { node: shotNode(SHOT) }));
  assert.match(html, /007/); // shotNumber
  assert.match(html, /她推开门，雨声灌进走廊。/); // scriptContent
  assert.match(html, /中景，女人推门而入/); // visualDescription
  assert.match(html, /你来了。/); // dialogue
  // 摄影四栏（最能体现专业度）
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

test("分镜卡：旁白文本与双音轨状态（有/无）可见；无旁白无音轨时不冒出一排「无」", () => {
  const node = shotNode(SHOT);
  node.metadata = {
    ...node.metadata,
    narration: "旁白：屋檐下的积水映着路灯。",
    dialogueAudioId: "https://cdn.example.com/line-007.mp3",
  } as CanvasNodeMetadata;
  const html = renderToStaticMarkup(createElement(StoryboardShotBody, { node }));
  assert.match(html, /旁白：屋檐下的积水映着路灯。/);
  assert.match(html, /音轨/);
  assert.match(html, /对白轨/);
  assert.match(html, /旁白轨/);
  assert.match(html, /对白轨(?:<!-- -->)? 有/);
  assert.match(html, /旁白轨(?:<!-- -->)? 无/);

  // 基准 SHOT（无旁白无音轨）：不渲染音轨块，也不把「无」冒充成有栏位
  const plain = renderToStaticMarkup(createElement(StoryboardShotBody, { node: shotNode(SHOT) }));
  assert.doesNotMatch(plain, /音轨/);
  assert.doesNotMatch(plain, /旁白/);
});

test("分镜卡：对话/音效皆空但有旁白时，「台词 · 音效」组仍成组（制作物不凭空消失）", () => {
  const node = shotNode({ ...SHOT, dialogue: "", soundEffect: "" });
  node.metadata = { ...node.metadata, narration: "旁白：屋檐下的积水映着路灯。" } as CanvasNodeMetadata;
  const html = renderToStaticMarkup(createElement(StoryboardShotBody, { node }));
  assert.match(html, /台词 · 音效/);
  assert.match(html, /旁白：屋檐下的积水映着路灯。/);
});

test("分镜场景壳：sceneName + 镜数可见；无栏位时回落原 Group 虚线框", () => {
  const html = renderToStaticMarkup(
    createElement(StoryboardSceneBody, { node: sceneNode({ sceneName: "旧公寓走廊", shotCount: 4 }) }),
  );
  assert.match(html, /旧公寓走廊/);
  assert.match(html, /4 镜/);

  const empty = renderToStaticMarkup(createElement(StoryboardSceneBody, { node: sceneNode(undefined) }));
  assert.match(empty, /border-dashed/);
});

test("正文 ≥13px 铁律：栏位值与徽章 ≥13px，12px 只给栏位名，11px 只给标签", () => {
  const html = renderToStaticMarkup(createElement(StoryboardShotBody, { node: shotNode(SHOT) }));
  const count = (px: string) => [...html.matchAll(new RegExp(`text-\\[${px}\\]`, "g"))].length;

  const rows = storyboardShotRows(SHOT).flatMap((g) => g.rows);
  const plainRows = rows.filter((r) => r.field !== "referenceAssets").length;
  // 引用资产：3 段胶囊（场景/角色/道具），共 4 个胶囊名
  const refCapsules = 4;

  // 正文盒（栏位值 + 胶囊名 + 镜号徽章）必须是 13px —— DESIGN.md §4「正文不小于 13px」
  assert.equal(count("13px"), plainRows + refCapsules + 1);
  // 11px 只给标签：eyebrow(1) + 已填徽章(1) + 组标题(4) + 引用分段名(3)
  assert.equal(count("11px"), 1 + 1 + SHOT_FIELD_GROUPS.length + 3);
  // 栏位名 12px（恰好每个非空栏位一个，不得大于正文）
  assert.equal(count("12px"), rows.length);
  // 无 <10px 正文
  assert.equal(count("10px"), 0);
  assert.doesNotMatch(html, /text-\[9px\]|text-ios-caption2/);
});

// ─────────────────────────────────────────── 接线形状（NodeBody 消费端）

test("NodeBody 已接分镜渲染：先于 type 分发的 storyboardShot 早退 + Group 分支 storyboardScene", () => {
  const source = read("src/components/canvas/node-view/NodeBody.tsx");
  assert.match(source, /import \{ StoryboardSceneBody, StoryboardShotBody \} from "\.\/StoryboardShotBody"/);
  // 栏位族早退必须在 switch (node.type) 之前（type 未受契约约束，绑 type 分支会漏渲染）
  const earlyReturn = source.indexOf("if (metadata?.storyboardShot) {");
  const switchAt = source.indexOf("switch (node.type) {");
  assert.ok(earlyReturn > 0 && switchAt > 0 && earlyReturn < switchAt, "storyboardShot 早退不在 switch 之前");
  // 批次封面早退在前（既有批次节点行为零改动）
  assert.ok(source.indexOf("batchPrimaryImageUrl && batchExpanded === false") < earlyReturn);
  // Group 分支有 storyboardScene 优先渲染，且保留原虚线框兜底
  assert.match(source, /if \(metadata\?\.storyboardScene\) \{/);
  assert.match(source, /border-dashed border-black\/10/);
  // 三件套手势显式传入（不引 context）
  assert.match(source, /onScrollAreaPointerDown=\{onScrollAreaPointerDown\}/);
});

test("StoryboardShotBody 走既有 scrollDrag 三件套接手势（canvas-node-scroll，不引 context）", () => {
  const source = read("src/components/canvas/node-view/StoryboardShotBody.tsx");
  assert.match(source, /canvas-node-scroll/);
  assert.match(source, /touch-pan-y/);
  assert.match(source, /overscroll-contain/);
  // 只读卡：无编辑/生成入口（与 Scene3dCardBody 同姿态）
  assert.doesNotMatch(source, /onEditPrompt|onRetry|run_generation/);
});

test("StoryboardShotBody 不重复定义契约：栏位清单单一真源 = storyboard-contract", () => {
  const source = read("src/components/canvas/node-view/StoryboardShotBody.tsx");
  assert.match(source, /from "@\/lib\/storyboard-contract"/);
  assert.match(source, /STORYBOARD_SHOT_FIELDS/);
  assert.match(source, /parseReferenceAssets/);
  // 禁止硬编 21 个 key 常数（会成为第二真源）
  assert.doesNotMatch(source, /const SHOT_FIELDS = \[/);
});

// ─────────────────────────────────────────── NodeBody 端到端接线（真渲染，非源码形状）

test("NodeBody 真渲染：text 型 + storyboardShot → 正文出镜号/剧本原文/摄影栏（非源码形状断言）", async () => {
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

test("NodeBody 真渲染：Group + storyboardScene → 场景名+镜数；无该栏位的 Group → 保持原虚线框", async () => {
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

// ═══════════════════════════════════════════ 音轨绑定／解除（2026-09-30）
//
// 验收立场（守门件不是 oracle）：主体是**行为断言**——喂真 metadata 与真 URL 进
// `shotAudioBindOutcome` / `shotAudioClearOutcome`（＝按钮 onClick 实际呼叫的那两支），
// 断言合并后的 metadata 逐键结果；末尾的源码级断言只算「变更探针」，不计入已验证。

const DIALOGUE_MP3 = "https://cdn.example.com/line-008.mp3";
const NARRATION_WAV = "https://cdn.example.com/vo-008.wav";
const NOOP_PATCH = () => {};

/** 依 UI 的落盘语义合并（patch 直喂宿主 `patchNodeMetadata`）：{{...metadata, ...patch}}。 */
function merged(base: CanvasNodeMetadata | undefined, patch: unknown): CanvasNodeMetadata {
  return { ...(base ?? {}), ...((patch ?? {}) as CanvasNodeMetadata) };
}

/** 宽化袋子读（音轨键在 interface 上，但测试要验「键在不在」，故走袋子）。 */
function bag(metadata: CanvasNodeMetadata | undefined): Record<string, unknown> {
  return (metadata ?? {}) as Record<string, unknown>;
}

test("音轨：绑定对白 → dialogueAudioId 有值且 audioAnchorId 同步（过 bindShotAudioTrack 真路径）", () => {
  const base = { narration: "旁白：屋檐下的积水映着路灯。" } as CanvasNodeMetadata;
  const outcome = shotAudioBindOutcome(base, "dialogue", DIALOGUE_MP3);

  assert.equal(outcome.accepted, true, "合法音频 URL 必须被接受");
  assert.ok(outcome.patch, "接受时必须有 patch 可落盘");

  const after = merged(base, outcome.patch);
  assert.equal(after.dialogueAudioId, DIALOGUE_MP3);
  assert.equal(after.audioAnchorId, DIALOGUE_MP3, "audioAnchorId 必须同步指向对白轨");
  assert.equal(after.narrationAudioId, undefined, "绑定对白不得凭空生出旁白轨");
  assert.equal(after.narration, "旁白：屋檐下的积水映着路灯。", "旁白文本（只读键）不得被覆盖");
  // 纯函数不动输入：原 metadata 不得被写花
  assert.equal(base.dialogueAudioId, undefined);
});

test("音轨：无对白时绑定旁白 → audioAnchorId 指向旁白轨", () => {
  const outcome = shotAudioBindOutcome({}, "narration", NARRATION_WAV);
  assert.equal(outcome.accepted, true);

  const after = merged({}, outcome.patch);
  assert.equal(after.narrationAudioId, NARRATION_WAV);
  assert.equal(after.audioAnchorId, NARRATION_WAV, "只有旁白轨时锚必须落在旁白轨上");
  assert.equal(after.dialogueAudioId, undefined);
});

test("音轨：两轨并存时锚取对白；解除对白后锚回退旁白、键在耐久层消失；全清不留悬空锚", () => {
  const afterDialogue = merged({}, shotAudioBindOutcome({}, "dialogue", DIALOGUE_MP3).patch);
  const both = merged(afterDialogue, shotAudioBindOutcome(afterDialogue, "narration", NARRATION_WAV).patch);
  assert.equal(both.dialogueAudioId, DIALOGUE_MP3);
  assert.equal(both.narrationAudioId, NARRATION_WAV);
  assert.equal(both.audioAnchorId, DIALOGUE_MP3, "锚优先对白轨");

  // 解除对白。宿主写入路径是**合并**语义（reducer `{...before, ...patch}`，合并不删键）：
  // patch 必须以显式 undefined 盖掉旧值，否则「解除了旧值还在」＝按钮骗人。
  const cleared = shotAudioClearOutcome(both, "dialogue");
  assert.equal(cleared.accepted, true);
  const afterClear = merged(both, cleared.patch);
  assert.equal(afterClear.dialogueAudioId, undefined, "解除后该轨不得还有值");
  assert.equal(afterClear.audioAnchorId, NARRATION_WAV, "锚回退到剩下的旁白轨，不留悬空值");
  assert.equal(afterClear.narrationAudioId, NARRATION_WAV, "另一轨一个键都不能动");
  assert.equal(afterClear.narration, undefined, "解除音轨不得碰旁白文本");

  // 耐久层 oracle（独立轮子 `layout.toNodeMetadata` 的 string 清洗器）：重载后键真的不在
  const durable = bag(toNodeMetadata(bag(afterClear)));
  assert.equal("dialogueAudioId" in durable, false, "重载后该键必须真的不在（不是留一个空壳值）");
  assert.equal(durable.audioAnchorId, NARRATION_WAV);

  // 旁白也解除 → 锚必须被显式清掉（否则留一个指向已解除音轨的悬空锚，门禁会误判有音轨）
  const fully = shotAudioClearOutcome(afterClear, "narration");
  assert.equal(fully.accepted, true);
  const afterAll = merged(afterClear, fully.patch);
  assert.equal(afterAll.audioAnchorId, undefined, "两轨皆空后不得留悬空锚");
  const durableAll = bag(toNodeMetadata(bag(afterAll)));
  assert.equal("narrationAudioId" in durableAll, false);
  assert.equal("dialogueAudioId" in durableAll, false);
  assert.equal("audioAnchorId" in durableAll, false, "空壳锚不得落到耐久层");
});

test("音轨：非音频 URL（.png／无扩展名裸 URL／空串）→ 不写入且出明提示（不静默）", () => {
  const cases: [string, string][] = [
    ["图片 URL", "https://cdn.example.com/still-008.png"],
    ["无扩展名裸 URL", "https://cdn.example.com/assets/abc123"],
    ["空字符串", ""],
    ["本地路径", "./audio/line.mp3"],
  ];
  for (const [label, bad] of cases) {
    const outcome = shotAudioBindOutcome({}, "dialogue", bad);
    assert.equal(outcome.accepted, false, `${label} 不该被接受`);
    assert.equal(outcome.patch, undefined, `${label}：未写入时不得给 patch`);
    assert.ok(outcome.message.trim().length > 0, `${label}：必须有明确提示，不许静默`);
    assert.match(outcome.message, /音频/, `${label}：提示要说清是音频地址问题`);
    // UI 的落盘语义：accepted=false 时不会调 onPatchMetadata → metadata 逐键不变
    assert.deepEqual(merged({}, outcome.patch), {});
  }
});

test("音轨：解除一条本来就没绑的轨 → accepted:false（不白推一格 undo 历史）", () => {
  const outcome = shotAudioClearOutcome({ narrationAudioId: NARRATION_WAV } as CanvasNodeMetadata, "dialogue");
  assert.equal(outcome.accepted, false);
  assert.equal(outcome.patch, undefined);
  assert.match(outcome.message, /尚未绑定/);
});

test("音轨入口 SSR：宿主注入写入出口时出「对白/旁白」两轨输入＋绑定按钮；空组也成组（入口不消失）", () => {
  // 台词 · 音效 组全空的分镜：没有入口的话用户无处可绑
  const node = shotNode({ ...SHOT, dialogue: "", soundEffect: "" });
  const html = renderToStaticMarkup(createElement(StoryboardShotBody, { node, onPatchMetadata: NOOP_PATCH }));

  assert.match(html, /台词 · 音效/, "空组也必须成组，否则绑定入口不存在");
  assert.match(html, /对白音轨/);
  assert.match(html, /旁白音轨/);
  assert.match(html, /粘贴音频 URL/);
  assert.match(html, /aria-label="对白音档 URL"/);
  assert.match(html, /aria-label="旁白音档 URL"/);
  assert.match(html, /绑定/);
  assert.match(html, /data-canvas-interactive/, "控件必须让画布手势层放行");
  assert.doesNotMatch(html, /解除/, "未绑定时不出解除按钮");
  // 正文尺寸铁律：控件文字 ≥13px，无 10px 以下
  assert.match(html, /text-\[13px\]/);
  assert.doesNotMatch(html, /text-\[10px\]|text-\[9px\]/);
});

test("音轨入口 SSR：未注入写入出口 → 无绑定入口（卡片维持原唯读，既有渲染零改动）", () => {
  const html = renderToStaticMarkup(createElement(StoryboardShotBody, { node: shotNode(SHOT) }));
  assert.doesNotMatch(html, /粘贴音频 URL/);
  assert.doesNotMatch(html, /绑定/);
});

test("音轨入口 SSR：已绑对白 → 出「已绑定」与「解除」按钮", () => {
  const node = shotNode(SHOT);
  node.metadata = { storyboardShot: SHOT, dialogueAudioId: DIALOGUE_MP3 } as CanvasNodeMetadata;
  const html = renderToStaticMarkup(createElement(StoryboardShotBody, { node, onPatchMetadata: NOOP_PATCH }));
  assert.match(html, /已绑定/);
  assert.match(html, /解除/);
  // 已绑定的轨仍然只有输入入口 + 解除，不新增第二套音轨状态显示（状态仍归 AudioTrackStatus）
  assert.match(html, /对白轨(?:<!-- -->)? 有/);
});

// 变更探针（源码形状，不计入已验证）：判准单源 = storyboard-shots 的纯函数，禁第二套音频判准
test("StoryboardShotBody 音轨入口不重写判准：值一律经 storyboard-shots 纯函数，不自造扩展名白名单", () => {
  const source = read("src/components/canvas/node-view/StoryboardShotBody.tsx");
  assert.match(source, /from "@\/lib\/canvas\/storyboard-shots"/);
  assert.match(source, /bindShotAudioTrack\(/);
  assert.match(source, /clearShotAudioTrack\(/);
  assert.doesNotMatch(source, /AUDIO_URL_EXTENSIONS|AUDIO_EXTENSIONS|AUDIO_EXTS/);
  // 不自己调判准（判定权在纯函数内，本档只做文案与落盘）
  assert.doesNotMatch(source, /usableAudioUrl\(/);
});

// ── 真写入路径：patch 过**真 reducer**（宿主 patchNodeMetadata 的落盘漏斗），不是自己拼对象
test("音轨：patch 过真 reducer 落盘——绑定后有值；解除后状态上值消失（含「只省略键」的反面对照）", async () => {
  const { canvasReducer } = await import("@/hooks/canvas/canvas-reducer-adapter");
  const { clearShotAudioTrack } = await import("@/lib/canvas/storyboard-shots");

  type ReducerState = Parameters<typeof canvasReducer>[0];
  const shot = shotNode(SHOT);
  const patchAction = (patch: unknown) =>
    ({ type: "patch_metadata", nodeId: shot.id, patch }) as unknown as Parameters<typeof canvasReducer>[1];
  const stateAfter = (s: ReducerState, patch: unknown) => {
    const next = canvasReducer(s, patchAction(patch));
    const n = next.nodes.find((x) => x.id === shot.id);
    assert.ok(n, "分镜节点应仍在");
    return bag(n.metadata);
  };
  const initial = { units: [], nodes: [shot], connections: [] } as unknown as ReducerState;
  const nextState = (s: ReducerState, patch: unknown) => canvasReducer(s, patchAction(patch));

  // ① 绑定对白：真落盘
  const boundState = nextState(initial, shotAudioBindOutcome(shot.metadata, "dialogue", DIALOGUE_MP3).patch);
  const bound = stateAfter(boundState, {});
  assert.equal(bound.dialogueAudioId, DIALOGUE_MP3);
  assert.equal(bound.audioAnchorId, DIALOGUE_MP3);

  // ② 反面对照：对**已绑定的状态**直喂纯函式的「省略键」patch → 旧值仍在（合并不删键）
  //    证明「entry 层必须把删掉的键显式写成 undefined」不是多此一举
  const rawPurePatch = clearShotAudioTrack({ dialogueAudioId: DIALOGUE_MP3 } as CanvasNodeMetadata, "dialogue").patch;
  assert.equal("dialogueAudioId" in rawPurePatch, false, "纯函式靠省略键表达删除");
  const stale = stateAfter(boundState, rawPurePatch);
  assert.equal(stale.dialogueAudioId, DIALOGUE_MP3, "只省略键 ⇒ 合并后旧值还在（这就是必须显式 undefined 的原因）");

  // ③ 走 entry 的 patch：对同一已绑定状态解除后，该轨的值真的没了
  const cleared = stateAfter(boundState, shotAudioClearOutcome(boundState.nodes[0].metadata, "dialogue").patch);
  assert.equal(cleared.dialogueAudioId, undefined);
  assert.equal(cleared.audioAnchorId, undefined);
  // 耐久层：重载清洗后键真的不在
  const durable = bag(toNodeMetadata(cleared));
  assert.equal("dialogueAudioId" in durable, false);
  assert.equal("audioAnchorId" in durable, false);
});

// ── 转发断点（W5d 破口）：分镜卡已有出口，但宿主出口必须先经 NodeBody 转接到它。
// 未接线时生产不渲染——本断言即该条链路的真实行为探针（注入→出入口；未注入→不出）。
test("转发：NodeBody 注入 onPatchMetadata → 分镜卡出绑定入口；未注入 → 不出（出口未接＝生产不渲染）", async () => {
  const { NodeBody } = await import("./NodeBody");
  const node = shotNode(SHOT);
  const gestures = {
    onScrollAreaPointerDown: () => {},
    onScrollAreaPointerMove: () => {},
    onScrollAreaPointerEnd: () => {},
  };
  const injectedHtml = renderToStaticMarkup(
    createElement(NodeBody, {
      node,
      scale: 1,
      onEditPrompt: () => {},
      onPatchMetadata: () => {},
      ...gestures,
    }),
  );
  assert.match(injectedHtml, /粘贴音频 URL/, "宿主注入出口时，分镜卡必须渲染绑定入口");
  assert.match(injectedHtml, /对白音轨/);
  assert.match(injectedHtml, /旁白音轨/);

  const bareHtml = renderToStaticMarkup(
    createElement(NodeBody, { node, scale: 1, onEditPrompt: () => {}, ...gestures }),
  );
  assert.doesNotMatch(bareHtml, /粘贴音频 URL/, "未注入出口时不得长出入口（维持原唯读）");
});
