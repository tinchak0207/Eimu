// 作品/剧集面板资料层（G2）+ `set_project_meta` op 载荷清洗（G1）测试（2026-09-16）。
//
// 钉死五件事：
//   1. `normalizeProjectMetaPatch` 逐栏白名单：合法保留 / 非法丢弃 / 超上限截断。
//   2. `summarizeCreationFlow` 的取值规则（集数、步骤标签、分镜计数）。
//   3. 面板 SSR 渲染：空态、集清单、步骤标签真的印出来（不是只有型别能编译）。
//   4. 挂接契约（源码级，仓库既有模式）：chip + 面板真的挂在 CanvasEmbed / Overlays。
//   5. `deriveNextStep` 由现况推导的下一步（2026-09-30）：每个阶段一步一跳、缺资料回
//      unknown 不补假进度、且**不读任何持久化 onboarding 标记**。
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import * as React from "react";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";

// tsconfig jsx=preserve → classic runtime，SSR 渲染前补全局 React 桩
// （Scene3dPreview.test.ts / agent-chat-ui.test.ts 同款）。
(globalThis as unknown as Record<string, unknown>).React ??= React;

import { canvasProjectMeta, normalizeProjectMetaPatch, toCanvasProject } from "./layout";
import { normalizeProject } from "./project-store";
import {
  countStoryboardProgress,
  deriveNextStep,
  summarizeCreationFlow,
  projectTypeLabel,
  type CreationFlowSnapshot,
  type CreationNextStepId,
  type CreationNextSurface,
} from "./creation-flow-panel";
import { MAX_EPISODES_PER_PROJECT } from "../creation-flow-steps";
import { canvasReducer } from "@/hooks/canvas/canvas-reducer-adapter";
import { CANVAS_INITIAL_STATE, type CanvasReducerState } from "./reducer";
import type { CanvasEpisode, CanvasNode, CanvasNodeType, CanvasViewport } from "./types";
import { CreationFlowPanel } from "@/components/canvas/embed/CreationFlowPanel";

const EMPTY_STATE: CanvasReducerState = { units: [], nodes: [], connections: [] };
const VP: CanvasViewport = { x: 0, y: 0, k: 1 };

function read(relPath: string) {
  return readFileSync(relPath, "utf8");
}

function episode(over: Partial<CanvasEpisode> = {}): CanvasEpisode {
  return {
    id: "ep-1",
    episodeNo: 1,
    title: "第一集",
    status: "draft",
    createdAt: "2026-09-16T00:00:00.000Z",
    updatedAt: "2026-09-16T00:00:00.000Z",
    ...over,
  };
}

function plainNode(id: string): CanvasNode {
  return {
    id,
    type: "text" as CanvasNodeType,
    title: "文本",
    position: { x: 0, y: 0 },
    width: 200,
    height: 120,
  };
}

function shotNode(id: string): CanvasNode {
  return {
    id,
    type: "text" as CanvasNodeType,
    title: "分镜",
    position: { x: 0, y: 0 },
    width: 200,
    height: 120,
    metadata: {
      storyboardShot: {
        shotNumber: id,
        scriptContent: "",
        visualDescription: "",
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
      },
    },
  };
}

// ─────────────────────────── 1. patch 清洗：合法保留

test("normalizeProjectMetaPatch：合法三栏原样保留（含 script 原文）", () => {
  const patch = normalizeProjectMetaPatch({
    projectType: "series",
    currentStep: 4,
    episodes: [episode({ script: "第一集剧本原文" }), episode({ id: "ep-2", episodeNo: 2, title: "第二集", status: "finished" })],
  });
  assert.equal(patch.projectType, "series");
  assert.equal(patch.currentStep, 4);
  assert.equal(patch.episodes?.length, 2);
  assert.equal(patch.episodes?.[0].script, "第一集剧本原文", "script 是非空字串就该保留（面板只显示指针，资料不缩水）");
});

test("normalizeProjectMetaPatch：只带一栏时不冒出其他键", () => {
  assert.deepEqual(Object.keys(normalizeProjectMetaPatch({ currentStep: 7 })), ["currentStep"]);
  assert.deepEqual(Object.keys(normalizeProjectMetaPatch({ projectType: "movie" })), ["projectType"]);
  assert.deepEqual(Object.keys(normalizeProjectMetaPatch({ episodes: [episode()] })), ["episodes"]);
});

// ─────────────────────────── 2. patch 清洗：非法丢弃

test("normalizeProjectMetaPatch：非法值省略该键（不写 undefined、不整包作废）", () => {
  for (const bad of ["anime", 3, null, undefined, ""]) {
    const patch = normalizeProjectMetaPatch({ projectType: bad, currentStep: 3 });
    assert.equal("projectType" in patch, false, `projectType=${String(bad)} 应被省略`);
    assert.equal(patch.currentStep, 3, "同包合法栏位不受影响");
  }
  for (const bad of [0, 8, -1, 2.5, "4", null, Number.NaN]) {
    assert.equal("currentStep" in normalizeProjectMetaPatch({ currentStep: bad }), false, `currentStep=${String(bad)} 应被省略`);
  }
});

test("normalizeProjectMetaPatch：episodes 逐项丢弃 —— AID 审核态/缺 id/集号非正整数都不进 state", () => {
  const patch = normalizeProjectMetaPatch({
    episodes: [
      episode({ id: "" }),
      episode({ title: "" }),
      episode({ episodeNo: 0 }),
      episode({ episodeNo: 1.5 }),
      episode({ status: "reviewing" as unknown as CanvasEpisode["status"] }), // AID 审核态不进本站型别
      { id: "ep-ok", episodeNo: 3, title: "第三集", status: "processing" },
    ],
  });
  assert.equal(patch.episodes?.length, 1, "只有最后一项合法，其余逐项丢弃而非整包作废");
  assert.equal(patch.episodes?.[0].id, "ep-ok");
});

test("normalizeProjectMetaPatch：episodeNo 去重保留首见（面板集数 ≠ 落盘集数的漂移来源）", () => {
  const patch = normalizeProjectMetaPatch({
    episodes: [episode({ id: "a" }), episode({ id: "b" }), episode({ id: "c", episodeNo: 2 })],
  });
  assert.deepEqual(patch.episodes?.map((e) => e.id), ["a", "c"]);
});

test("normalizeProjectMetaPatch：episodes 空阵列/非阵列 → 省略该栏（不制造空壳已设定）", () => {
  assert.equal("episodes" in normalizeProjectMetaPatch({ episodes: [] }), false);
  assert.equal("episodes" in normalizeProjectMetaPatch({ episodes: "junk" }), false);
  assert.equal("episodes" in normalizeProjectMetaPatch({ episodes: null }), false);
});

test("normalizeProjectMetaPatch：非物件输入（agent 送 null/字串/阵列）回 {}", () => {
  assert.deepEqual(normalizeProjectMetaPatch(null), {});
  assert.deepEqual(normalizeProjectMetaPatch(undefined), {});
  assert.deepEqual(normalizeProjectMetaPatch("junk"), {});
  assert.deepEqual(normalizeProjectMetaPatch([{ currentStep: 1 }]), {}, "阵列不是 patch");
  assert.deepEqual(normalizeProjectMetaPatch({}), {});
});

// ─────────────────────────── 3. patch 清洗：超上限截断

test("normalizeProjectMetaPatch：episodes 超过上限被截断", () => {
  const many = Array.from({ length: MAX_EPISODES_PER_PROJECT + 25 }, (_, i) => episode({ id: `ep-${i + 1}`, episodeNo: i + 1 }));
  const patch = normalizeProjectMetaPatch({ episodes: many });
  assert.equal(patch.episodes?.length, MAX_EPISODES_PER_PROJECT, `上限应为 ${MAX_EPISODES_PER_PROJECT}`);
  assert.equal(patch.episodes?.[0].episodeNo, 1, "截断保留首见序");
  assert.equal(patch.episodes?.at(-1)?.episodeNo, MAX_EPISODES_PER_PROJECT);
});

test("上限常数与落盘端同源（单一宣告，两处不再各写一个 200）", () => {
  const store = read("src/lib/canvas/project-store.ts");
  assert.match(store, /MAX_EPISODES_PER_PROJECT/, "store 应引用共用常数");
  assert.doesNotMatch(store, /const MAX_EPISODES_PER_PROJECT = 200/, "store 不该再本地宣告第二个 200");
});

// ─────────────────────────── 4. op 执行端分工

test("agent_ops：set_project_meta 不改 reducer state（专案级栏位由 hook 写入）", () => {
  const next = canvasReducer(CANVAS_INITIAL_STATE, {
    type: "agent_ops",
    ops: [{ type: "set_project_meta", patch: { currentStep: 4, projectType: "series" } }],
  });
  assert.equal(next, CANVAS_INITIAL_STATE, "reducer 只认 nodes/connections，原样返回同一实例");
});

test("握把契约：hook 的 set_project_meta 分支先过清洗再写入", () => {
  // <1000 行重构：set_project_meta 执行分支在 hooks/canvas/canvas-chat-ops.ts。
  const hook = [
    read("src/hooks/use-canvas-chat.ts"),
    read("src/hooks/canvas/canvas-chat-ops.ts"),
  ].join("\n");
  assert.match(hook, /op\.type === "set_project_meta"/, "执行端分支必须存在");
  assert.match(hook, /const patch = normalizeProjectMetaPatch\(op\.patch\)/, "载荷必须先清洗");
  assert.match(hook, /if \(Object\.keys\(patch\)\.length > 0\) setProjectMeta\(patch\)/, "空 patch 不推 state");
});

// ─────────────────────────── 5. 面板资料层

test("summarizeCreationFlow：集数/完成数/排序（照 episodeNo 升序）", () => {
  const summary = summarizeCreationFlow({
    projectType: "series",
    currentStep: 4,
    episodes: [episode({ id: "c", episodeNo: 3, title: "三" }), episode({ id: "a", episodeNo: 1, title: "一", status: "finished" })],
  });
  assert.equal(summary.projectTypeLabel, "剧集");
  assert.equal(summary.currentStep?.label, "分镜设计");
  assert.equal(summary.episodeCount, 2);
  assert.equal(summary.finishedCount, 1);
  assert.deepEqual(summary.episodes.map((e) => e.episodeNo), [1, 3], "输入乱序也照集号升序显示");
  assert.deepEqual(summary.episodes.map((e) => e.statusLabel), ["已完成", "草稿"]);
});

test("summarizeCreationFlow：未设定时不捏造（无作品类型标签、无步骤、集数 0）", () => {
  const summary = summarizeCreationFlow({});
  assert.equal(summary.projectTypeLabel, undefined);
  assert.equal(summary.currentStep, undefined);
  assert.equal(summary.episodeCount, 0);
  assert.equal(summary.finishedCount, 0);
  assert.deepEqual(summary.episodes, []);
  assert.equal(projectTypeLabel("anime"), undefined);
  assert.equal(projectTypeLabel(undefined), undefined);
});

test("countStoryboardProgress：只数真实节点，分开报『已落画布 / 场景计画』（不合成完成度）", () => {
  const scene: CanvasNode = {
    id: "scene-1",
    type: "group" as CanvasNodeType,
    title: "场景",
    position: { x: 0, y: 0 },
    width: 400,
    height: 300,
    metadata: { storyboardScene: { sceneName: "雨夜屋顶", shotCount: 3 } },
  };
  const progress = countStoryboardProgress([shotNode("s1"), shotNode("s2"), scene, plainNode("plain")]);
  assert.equal(progress.shots, 2);
  assert.equal(progress.plannedShots, 3);
  assert.deepEqual(countStoryboardProgress([]), { shots: 0, plannedShots: 0 });
  // 场景外壳的 shotCount 非正整数/缺栏位 → 不计入计画镜数（不捏造分母）
  assert.deepEqual(
    countStoryboardProgress([
      { ...scene, metadata: { storyboardScene: { sceneName: "x", shotCount: 0 } } },
      { ...scene, id: "scene-2", metadata: { storyboardScene: { sceneName: "y" } as unknown as CanvasNode["metadata"]["storyboardScene"] } },
    ]),
    { shots: 0, plannedShots: 0 },
  );
});

// ─────────────────────────── 6. 面板 SSR 渲染

test("面板 SSR：空态诚实文案（不捏造已设定）", () => {
  const html = renderToStaticMarkup(
    createElement(CreationFlowPanel, { summary: summarizeCreationFlow({}), onClose: () => {} }),
  );
  assert.match(html, /作品 \/ 剧集/);
  assert.match(html, /还没有作品配置/);
  assert.doesNotMatch(html, /剧集 · 0 集/, "空态不显示 0 集清单，避免空壳");
});

test("面板 SSR：剧集数、集号、标题、状态、当前步骤中文标签全部印出", () => {
  const html = renderToStaticMarkup(
    createElement(CreationFlowPanel, {
      summary: summarizeCreationFlow({
        projectType: "series",
        currentStep: 4,
        episodes: [episode({ title: "雨夜追击" }), episode({ id: "ep-2", episodeNo: 2, title: "霓虹坠落", status: "finished" })],
      }),
      onClose: () => {},
    }),
  );
  assert.match(html, /剧集/);
  assert.match(html, /剧集 · 2 集/);
  assert.match(html, /第 1 集/);
  assert.match(html, /第 2 集/);
  assert.match(html, /雨夜追击/);
  assert.match(html, /霓虹坠落/);
  assert.match(html, /第 4 步 · 分镜设计/, "currentStep 必须走 creationStepMeta 取中文标签");
  assert.match(html, /已完成 1/);
});

test("面板 SSR：分镜计数段落呈现真实计数（无资料时为 0 镜，不写百分比）", () => {
  const html = renderToStaticMarkup(
    createElement(CreationFlowPanel, {
      summary: summarizeCreationFlow({ episodes: [episode()], nodes: [shotNode("s1")] }),
      onClose: () => {},
    }),
  );
  assert.match(html, /已落画布 1 镜/);
  assert.doesNotMatch(html, /完成度|完成进度|%/, "本站无「一镜完成」建模栏位，不得合成百分比");
});

// ─────────────────────────── 7. 端到端（资料层）：agent op → 落盘 → 读回仍在

test("端到端（资料层）：set_project_meta op 载荷 → 清洗 → 落盘 → 读回同值", () => {
  // 起点刻意用「未经型别保护的原始 JSON」——这才是 SSE 反序列化后的真实形状。
  const rawOpPayload: unknown = {
    projectType: "series",
    currentStep: 4,
    episodes: [
      { id: "ep-1", episodeNo: 1, title: "雨夜追击", status: "finished", script: "剧本原文" },
      { id: "ep-2", episodeNo: 2, title: "霓虹坠落", status: "reviewing" }, // AID 审核态：该项被丢
    ],
    // 模型顺手塞的杂讯栏位：必须被白名单挡掉，不得进 Blob
    junkField: "should be dropped",
  };
  const patch = normalizeProjectMetaPatch(rawOpPayload);
  assert.equal(patch.episodes?.length, 1, "非法项在 op 执行端就被丢弃");

  // 套进 hook state → buildProject 的产物 → store 落盘清洗
  const stored = normalizeProject(
    toCanvasProject(
      { id: "p1", title: "我的作品" },
      EMPTY_STATE,
      VP,
      "dots",
      undefined,
      undefined,
      patch.projectType,
      patch.currentStep,
      patch.episodes,
    ),
  );
  assert.ok(stored, "清洗后的 patch 必须能落盘");
  assert.equal("junkField" in stored, false, "杂讯栏位不得进 Blob");

  // 刷新后：openSavedCanvas 走 canvasProjectMeta 取回 → 面板 summarize 显示
  const meta = canvasProjectMeta(stored);
  const summary = summarizeCreationFlow({ ...meta, nodes: [] });
  assert.equal(summary.projectTypeLabel, "剧集");
  assert.equal(summary.currentStep?.label, "分镜设计");
  assert.equal(summary.episodeCount, 1);
  assert.equal(summary.episodes[0].title, "雨夜追击");
  assert.equal(summary.episodes[0].statusLabel, "已完成");
  assert.equal(summary.episodes[0].hasScript, true);
});

// ─────────────────────────── 8. 挂接契约（源码级，仓库既有模式）

test("挂接契约：顶栏 chip 与左侧弹层真的挂上（型别能编译 ≠ 面板可见）", () => {
  // <1000 行重构：CanvasEmbed 的顶栏 chip 渲染已迁入 embed/CanvasEmbedView.tsx。
  const embed = [
    read("src/components/canvas/CanvasEmbed.tsx"),
    read("src/components/canvas/embed/CanvasEmbedView.tsx"),
  ].join("\n");
  const overlays = read("src/components/canvas/embed/CanvasEmbedOverlays.tsx");
  // chip：与角色卡/资源库同层
  assert.match(embed, /aria-label="作品与剧集"/);
  assert.match(embed, /onClick=\{\(\) => setCreationFlowOpen\(\(v\) => !v\)\}/);
  assert.match(embed, /作品\{canvas\.episodes\.length > 0 \? ` · \$\{canvas\.episodes\.length\} 集` : ""\}/);
  // 面板：由 Overlays 挂载，吃 hook 既有四出口，本层零新增 state
  assert.match(overlays, /<CreationFlowPanel/);
  assert.match(overlays, /summarizeCreationFlow\(\{/);
  assert.match(overlays, /projectType: canvas\.projectType/);
  assert.match(overlays, /currentStep: canvas\.currentStep/);
  assert.match(overlays, /episodes: canvas\.episodes/);
  assert.match(overlays, /nodes: canvas\.nodes/);
  // 关闭态不渲染（挂载条件）
  assert.match(overlays, /\{creationFlowOpen && \(/);
});

test("挂接契约：面板不吃新资料源（不碰 metadata 栏位族、不新增 hook 出口）", () => {
  const hookTypes = read("src/hooks/canvas/canvas-chat-types.ts");
  const panel = read("src/components/canvas/embed/CreationFlowPanel.tsx");
  // 三栏出口在刀 1 就存在，本片不新增：值出口三个 + 写入口一个（唯一）
  // 型别走单一来源 CanvasProjectType（G6，值域来自 AID ProjectTypeEnum）——
  // 此处刻意钉「引用型别名」而非字面值域：硬编 `"movie" | "series"` 正是 G6 消灭的漂移点。
  assert.match(hookTypes, /projectType: CanvasProjectType \| undefined;/);
  assert.match(hookTypes, /currentStep: number \| undefined;/);
  assert.match(hookTypes, /episodes: CanvasEpisode\[\];/);
  assert.equal(hookTypes.match(/setProjectMeta: /g)?.length, 1, "写入口恒为一个（UI 与 agent 共用同一出口）");
  assert.doesNotMatch(panel, /storyboardShot|storyboardScene/, "面板只吃 summary，不直接读节点 metadata（那是刀 2/G3 的地盘）");
});

// ─────────────── 9. 下一步引导：由当前现况推导（一步一跳）；不读持久化 onboarding 标记

/** 全齐的现况（各阶段测试从它派生，只改要测的那几格）。 */
function snapshot(over: Partial<CreationFlowSnapshot> = {}): CreationFlowSnapshot {
  return {
    hasProject: true,
    episodes: 1,
    shots: 3,
    shotsWithImage: 3,
    shotsWithVideo: 3,
    shotsWithAudio: 3,
    hasCut: true,
    ...over,
  };
}

test("deriveNextStep：每个阶段各回一条『唯一下一步』（无作品→建作品 … 全齐→终态）", () => {
  const cases: Array<[CreationFlowSnapshot, CreationNextStepId, CreationNextSurface]> = [
    [{ hasProject: false }, "project", "agent"],
    [snapshot({ episodes: 0, shots: 0, shotsWithImage: 0, shotsWithVideo: 0, shotsWithAudio: 0, hasCut: false }), "episode", "agent"],
    [snapshot({ shots: 0, shotsWithImage: 0, shotsWithVideo: 0, shotsWithAudio: 0, hasCut: false }), "storyboard", "agent"],
    [snapshot({ shotsWithImage: 2, shotsWithVideo: 0, shotsWithAudio: 0, hasCut: false }), "shot-image", "canvas-generation"],
    [snapshot({ shotsWithVideo: 1, shotsWithAudio: 0, hasCut: false }), "shot-video", "canvas-generation"],
    [snapshot({ shotsWithAudio: 2, hasCut: false }), "shot-audio", "canvas-generation"],
    [snapshot({ hasCut: false }), "cut", "agent"],
    [snapshot(), "done", "none"],
  ];
  for (const [state, id, surface] of cases) {
    const step = deriveNextStep(state);
    assert.equal(step.id, id, `${JSON.stringify(state)} 应回 ${id}`);
    assert.equal(step.surface, surface, `${id} 的动作面`);
    assert.ok(step.label.length > 0, "必带一句人话");
    assert.doesNotMatch(step.label, /%|完成度|完成进度/, "本站无「一镜完成」建模，不得合成百分比");
  }
});

test("deriveNextStep：一步一跳——前一缺口没补完前绝不跳报后面的步骤，全齐才回终态", () => {
  const allMissing = snapshot({ shotsWithImage: 1, shotsWithVideo: 1, shotsWithAudio: 1, hasCut: false });
  assert.equal(deriveNextStep(allMissing).id, "shot-image", "图/影/配音都缺时先补图（顺序＝对手的 next if 链）");
  assert.equal(deriveNextStep({ ...allMissing, shotsWithImage: 3 }).id, "shot-video");
  assert.equal(deriveNextStep({ ...allMissing, shotsWithImage: 3, shotsWithVideo: 3 }).id, "shot-audio");
  assert.equal(deriveNextStep(snapshot({ hasCut: false })).id, "cut", "素材齐但没成片 → 还不是终态");
  assert.equal(deriveNextStep(snapshot({ episodes: 0 })).id, "episode", "hasCut 不得短路前面缺的工序");
});

test("deriveNextStep：人话带真实缺口数（缺口＝已落画布总数−已有），场景计画数不得混入", () => {
  assert.match(
    deriveNextStep(snapshot({ shots: 5, shotsWithImage: 2, shotsWithVideo: 0, shotsWithAudio: 0, hasCut: false })).label,
    /3 个分镜还没有图/,
  );
  assert.match(deriveNextStep(snapshot({ shots: 4, shotsWithImage: 4, shotsWithVideo: 1, shotsWithAudio: 0, hasCut: false })).label, /3 个分镜还没有视频/);
  assert.match(deriveNextStep(snapshot({ shots: 4, shotsWithImage: 4, shotsWithVideo: 4, shotsWithAudio: 1, hasCut: false })).label, /3 个分镜还没有配音/);
  // 「已落画布 / 场景计画」是两个数字：快照刻意没有 plannedShots 这个输入位，硬塞也不得影响推导。
  const plannedBlob = { ...snapshot({ hasCut: false }), plannedShots: 99 } as CreationFlowSnapshot;
  assert.equal(deriveNextStep(plannedBlob).id, "cut", "多余栏位（场景计画 99）不得当分母、不得改变结论");
});

test("deriveNextStep：缺资料/坏资料回 unknown（不知道 ≠ 没问题），绝不补假进度", () => {
  for (const bad of [
    {}, // 什么都不知道
    { hasProject: true }, // 只知道作品在，工序数字全缺
    snapshot({ episodes: Number.NaN }),
    snapshot({ shots: -1 }),
    snapshot({ shotsWithImage: 1.5 }),
    snapshot({ shotsWithAudio: Number.POSITIVE_INFINITY }),
    snapshot({ shots: 2, shotsWithImage: 3 }), // 带图镜数多过分镜总数＝矛盾
    snapshot({ shots: 2, shotsWithVideo: 5 }),
    snapshot({ hasCut: undefined }),
  ]) {
    const step = deriveNextStep(bad);
    assert.equal(step.id, "unknown", `${JSON.stringify(bad)} 应回 unknown`);
    assert.equal(step.pipelineStep, undefined, "unknown 不落 7 步流水线的任一步");
  }
  // hasProject=false 是「确定的现况」，不是不知道 → 建作品
  assert.equal(deriveNextStep({ hasProject: false }).id, "project");
  // 「计数为 0（确实都没有）」与「不知道（栏位缺席）」是两件事
  assert.equal(
    deriveNextStep({ hasProject: true, episodes: 0, shots: 0, shotsWithImage: 0, shotsWithVideo: 0, shotsWithAudio: 0, hasCut: false }).id,
    "episode",
  );
});

test("deriveNextStep：pipelineStep 只落 7 步里真的对得上的步骤；分镜图不猜", () => {
  assert.equal(deriveNextStep({ hasProject: false }).pipelineStep?.label, "项目配置");
  assert.equal(deriveNextStep(snapshot({ episodes: 0 })).pipelineStep?.label, "剧本创作");
  assert.equal(deriveNextStep(snapshot({ shots: 0, shotsWithImage: 0, shotsWithVideo: 0, shotsWithAudio: 0 })).pipelineStep?.label, "分镜设计");
  assert.equal(
    deriveNextStep(snapshot({ shotsWithImage: 0, shotsWithVideo: 0, shotsWithAudio: 0, hasCut: false })).pipelineStep,
    undefined,
    "「分镜图」在 AID 7 步无独立步（素材准备 3 or 视频生成 5）→ 不猜",
  );
  assert.equal(deriveNextStep(snapshot({ shotsWithVideo: 0, shotsWithAudio: 0, hasCut: false })).pipelineStep?.label, "视频生成");
  assert.equal(deriveNextStep(snapshot({ shotsWithAudio: 0, hasCut: false })).pipelineStep?.label, "音画同步");
  assert.equal(deriveNextStep(snapshot({ hasCut: false })).pipelineStep?.label, "成品预览");
  assert.equal(deriveNextStep(snapshot()).pipelineStep?.label, "成品预览");
});

test("deriveNextStep：不依赖任何持久化 onboarding 标记（不吃『已引导』旗标、不碰储存）", () => {
  const state: CreationFlowSnapshot = snapshot({ shotsWithImage: 1, shotsWithVideo: 0, shotsWithAudio: 0, hasCut: false });
  const a = deriveNextStep(state);
  const b = deriveNextStep(state);
  assert.deepEqual(a, b, "纯函式：同一份现况两次呼叫结果一致（无隐藏状态）");
  // 输入冻结照样算得出来 ⇒ 没有就地改写输入（没有把「已看过」写回 state）
  assert.doesNotThrow(() => deriveNextStep(Object.freeze({ ...state })));
  // 就算有人硬塞一个「已引导/已略过」旗标进来，推导结果也不变 ⇒ 旗标不是输入
  const withFlags = { ...state, onboardingDone: true, setupSeen: true, dismissed: "2026-09-30" } as CreationFlowSnapshot;
  assert.deepEqual(deriveNextStep(withFlags), a, "未知栏位不得影响推导（不读任何持久化旗标）");
  // 输入与输出都不得出现 onboarding/已引导类栏位
  const flagLike = /onboard|seen|dismiss|firstRun|guided|tour|acknowledged/i;
  assert.deepEqual(Object.keys(a).filter((k) => flagLike.test(k)), []);
  assert.deepEqual(Object.keys(state).filter((k) => flagLike.test(k)), []);
  // 模组源码不得接触任何浏览器端持久化（否则「当前资料推导」就会退化成落盘旗标）
  const src = read("src/lib/canvas/creation-flow-panel.ts");
  assert.doesNotMatch(src, /localStorage|sessionStorage|document\.cookie|indexedDB/);
});
