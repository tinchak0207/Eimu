// 下一步引导渲染测试（2026-09-30）：`deriveNextStep` 真的印在面板上（型别能编译 ≠ 面板可见）。
//
// 两层断言：
//   ① 面板层（CreationFlowPanel）：有 next 时渲染 label ＋ 一颗主按钮；unknown／none 不渲染。
//   ② 接线层（CanvasEmbedOverlays）：由 nodes 推导 snapshot（真分镜节点 → 真的缺口数），
//      不是把 label 直接塞进去。
//
// 只做 SSR 静态渲染（本 repo 无 jsdom）：`onNextAction` 的导向（聚焦输入框／开审查面）是
// 浏览器行为，属探针级，见回报「未尽事项」。
import test from "node:test";
import assert from "node:assert/strict";
import * as React from "react";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";

(globalThis as unknown as Record<string, unknown>).React ??= React;

import { CanvasEmbedOverlays, nextActionRoute, requestVoiceover } from "./CanvasEmbedOverlays";
import { CreationFlowPanel } from "./CreationFlowPanel";
import { summarizeCreationFlow } from "@/lib/canvas/creation-flow-panel";
import type { UseCanvasChatReturn } from "@/hooks/use-canvas-chat";
import type { CanvasNode } from "@/lib/canvas/types";

const EMPTY_SUMMARY = summarizeCreationFlow({});

function panel(over: Partial<React.ComponentProps<typeof CreationFlowPanel>> = {}) {
  return renderToStaticMarkup(
    createElement(CreationFlowPanel, {
      summary: EMPTY_SUMMARY,
      onClose: () => {},
      ...over,
    }),
  );
}

/** 分镜节点桩（只补真的会被读到的栏位：storyboardShot 判准 + 媒体键一律缺）。 */
function shotNode(over: Partial<CanvasNode> = {}): CanvasNode {
  return {
    id: "shot-1",
    type: "text",
    title: "第 1 镜",
    position: { x: 0, y: 0 },
    width: 340,
    height: 240,
    metadata: { storyboardShot: { shotNumber: "1" } as unknown as CanvasNode["metadata"]["storyboardShot"] },
    ...over,
  } as CanvasNode;
}

// ─────────────────────────── ① 面板层

test("面板：有 next 时渲染 label 与主按钮（canvas-generation → 打开分镜处理）", () => {
  const html = panel({
    nextStep: { id: "shot-image", label: "补齐分镜图（2 个分镜还没有图）", surface: "canvas-generation" },
  });
  assert.match(html, /下一步/);
  assert.match(html, /补齐分镜图（2 个分镜还没有图）/);
  assert.match(html, /打开分镜处理/);
});

test("面板：agent 面渲染 agent 主按钮文案", () => {
  const html = panel({ nextStep: { id: "episode", label: "建立分集与剧本（这部作品还没有分集）", surface: "agent" } });
  assert.match(html, /交给 AI 助理/);
  assert.match(html, /建立分集与剧本（这部作品还没有分集）/);
});

test("面板：unknown 不渲染（资料不足以判断 ≠ 给一个假动作）", () => {
  const html = panel({
    nextStep: { id: "unknown", label: "还不确定作品是否已建立——先在 AI 助理里核对", surface: "agent" },
  });
  assert.equal(/下一步/.test(html), false, "unknown 不进面板");
  assert.equal(/还不确定作品是否已建立/.test(html), false);
});

test("面板：终态（surface none / id done）不渲染主动作", () => {
  const html = panel({ nextStep: { id: "done", label: "全流程已完成 · 预览成片", surface: "none" } });
  assert.equal(/下一步/.test(html), false);
  assert.equal(/全流程已完成/.test(html), false);
});

test("面板：缺席 nextStep 时完全不渲染引导区（不改变既有面板）", () => {
  const html = panel();
  assert.equal(/下一步/.test(html), false);
  assert.match(html, /作品 \/ 剧集/, "既有面板本体照旧");
});

// ─────────────────────────── ② 接线层（overlays 由 nodes 推导）

function canvasStub(over: Partial<UseCanvasChatReturn> = {}): UseCanvasChatReturn {
  const noop = () => {};
  return {
    activeCardIds: [],
    characterCards: [],
    nodes: [],
    episodes: [],
    connections: [],
    savedProjects: [],
    currentStep: undefined,
    projectType: undefined,
    selectNode: noop,
    removeCharacterCard: noop,
    toggleCharacterCard: noop,
    dismissAgentOps: noop,
    flyTo: noop,
    openSavedCanvas: noop,
    ...over,
  } as unknown as UseCanvasChatReturn;
}

function overlays(canvas: UseCanvasChatReturn) {
  return renderToStaticMarkup(
    createElement(CanvasEmbedOverlays, {
      height: "100%",
      expanded: false,
      pendingOps: null,
      cardsOpen: false,
      creationFlowOpen: true,
      onCloseCreationFlow: () => {},
      historyOpen: false,
      onCloseHistory: () => {},
      elementListOpen: false,
      reviewPanel: null,
      reviewPendingCount: 0,
      onToggleReview: () => {},
      canvas,
      viewportSizeRef: { current: { width: 0, height: 0 } },
      setSelectedIds: () => {},
    }),
  );
}

test("接线：节点现况（有作品＋1 集＋1 颗无图分镜）→ 面板印出『补齐分镜图（1 …）』", () => {
  const html = overlays(
    canvasStub({
      projectType: "movie",
      episodes: [{ id: "ep-1", episodeNo: 1, title: "第一集", status: "draft" }] as UseCanvasChatReturn["episodes"],
      nodes: [shotNode()],
    }),
  );
  assert.match(html, /补齐分镜图（1 个分镜还没有图）/);
  assert.match(html, /打开分镜处理/);
});

test("接线：什么都没有 → 推导出『先建立作品』（不是硬写死的 label）", () => {
  const html = overlays(canvasStub());
  assert.match(html, /先建立作品：让 AI 助理设定作品类型/);
  assert.match(html, /交给 AI 助理/);
});

test("接线：分镜有配音（audioAnchorId 非空）不改变『还缺图』的结论，但补图后会前进到配音缺口", () => {
  // 有作品/集，1 颗分镜、有配音但没图 → 缺口仍是图（工序顺序：图 → 影 → 配音）。
  const withAudioOnly = overlays(
    canvasStub({
      projectType: "movie",
      episodes: [{ id: "ep-1", episodeNo: 1, title: "第一集", status: "draft" }] as UseCanvasChatReturn["episodes"],
      nodes: [
        shotNode({
          metadata: {
            storyboardShot: { shotNumber: "1" },
            dialogueAudioId: "asset-audio-1",
          } as unknown as CanvasNode["metadata"],
        }),
      ],
    }),
  );
  assert.match(withAudioOnly, /补齐分镜图（1 个分镜还没有图）/, "配音有无不改变『先补图』");
});

// ─────────────────────────── ③ 补齐配音（`shot-audio`）真的接上生成入口
//
// 分三层：
//   · 路由层：`nextActionRoute` 纯函式（shot-audio 走配音、其余面照旧）。
//   · 请求层：`requestVoiceover` 注入假 fetch —— **干跑只发一次 dryRun:true、
//     未确认前不发 dryRun:false**；币数一律照伺服器回；被拒/非 2xx 不假成功。
//   · 渲染层：干跑结果与确认键真的印在面板上（SSR）。
// 全程假 fetch，零真实付费呼叫。

test("路由：shot-audio 走配音干跑；补图／补影／agent／none 照旧", () => {
  assert.equal(nextActionRoute("canvas-generation", "shot-audio"), "voiceover-quote");
  assert.equal(nextActionRoute("canvas-generation", "shot-image"), "review");
  assert.equal(nextActionRoute("canvas-generation", "shot-video"), "review");
  assert.equal(nextActionRoute("canvas-generation"), "review");
  assert.equal(nextActionRoute("agent", "episode"), "agent");
  assert.equal(nextActionRoute("none", "done"), "none");
});

interface RecordedVoiceoverCall {
  url: string;
  body: Record<string, unknown>;
}

/** 假 fetch（记录每次呼叫的 url/body；永不触网）。 */
function fakeVoiceoverFetch(
  responder: (call: RecordedVoiceoverCall) => { ok?: boolean; status?: number; payload?: unknown },
): { impl: typeof fetch; calls: RecordedVoiceoverCall[] } {
  const calls: RecordedVoiceoverCall[] = [];
  const impl = (async (input: unknown, init?: RequestInit) => {
    const call: RecordedVoiceoverCall = {
      url: String(input),
      body: JSON.parse(String(init?.body ?? "{}")) as Record<string, unknown>,
    };
    calls.push(call);
    const result = responder(call);
    return {
      ok: result.ok ?? true,
      status: result.status ?? 200,
      json: async () => result.payload,
    } as unknown as Response;
  }) as unknown as typeof fetch;
  return { impl, calls };
}

test("配音请求：干跑只发一次 dryRun:true，未经确认不发 dryRun:false", async () => {
  const mock = fakeVoiceoverFetch(() => ({
    payload: { ok: true, dryRun: true, lines: [{}, {}, {}], totalChars: 42, estimatedCoins: 7 },
  }));

  const quote = await requestVoiceover({ projectId: "p-1", dryRun: true }, mock.impl);

  assert.deepEqual(quote, { status: "quote", lineCount: 3, totalChars: 42, estimatedCoins: 7 });
  assert.equal(mock.calls.length, 1, "干跑只发一次");
  assert.equal(mock.calls[0].url, "/api/canvas/storyboard-voiceover");
  assert.equal(mock.calls[0].body.projectId, "p-1");
  assert.equal(mock.calls[0].body.dryRun, true);
  assert.equal(
    mock.calls.some((c) => c.body.dryRun === false),
    false,
    "使用者还没按确认键 ⇒ 不得发出任何真跑请求",
  );
});

test("配音请求：确认后才发 dryRun:false，实扣币数用伺服器回的数字（前端不自算）", async () => {
  const mock = fakeVoiceoverFetch((call) =>
    call.body.dryRun === true
      ? { payload: { ok: true, dryRun: true, lines: [{}], totalChars: 10, estimatedCoins: 3 } }
      : { payload: { ok: true, applied: true, lines: [{}], totalChars: 10, costCoins: 4, drift: 1 } },
  );

  await requestVoiceover({ projectId: "p-1", dryRun: true }, mock.impl);
  assert.equal(mock.calls.filter((c) => c.body.dryRun === false).length, 0, "确认前 0 笔真跑");

  const applied = await requestVoiceover({ projectId: "p-1", dryRun: false }, mock.impl);
  assert.deepEqual(
    applied,
    { status: "applied", lineCount: 1, totalChars: 10, costCoins: 4 },
    "costCoins 照伺服器，与报价 3 不同也不改写",
  );
  assert.equal(mock.calls.filter((c) => c.body.dryRun === false).length, 1, "确认后恰好 1 笔真跑");
  assert.equal(mock.calls.length, 2);
});

test("配音请求：被拒（refused）→ 回原因，不假成功", async () => {
  const mock = fakeVoiceoverFetch(() => ({
    payload: {
      ok: false,
      dryRun: true,
      lines: [],
      totalChars: 0,
      estimatedCoins: 0,
      refused: { reason: "这一集还没有旁白文本" },
    },
  }));
  assert.deepEqual(await requestVoiceover({ projectId: "p-1", dryRun: true }, mock.impl), {
    status: "refused",
    reason: "这一集还没有旁白文本",
  });
});

test("配音请求：非 2xx／缺币数 → error（不当成功）", async () => {
  const unpaid = fakeVoiceoverFetch(() => ({ ok: false, status: 402 }));
  assert.deepEqual(await requestVoiceover({ projectId: "p-1", dryRun: false }, unpaid.impl), {
    status: "error",
    reason: "配音服务返回 402",
  });

  const noCoins = fakeVoiceoverFetch(() => ({ payload: { ok: true, dryRun: true, lines: [{}], totalChars: 5 } }));
  assert.deepEqual(await requestVoiceover({ projectId: "p-1", dryRun: true }, noCoins.impl), {
    status: "error",
    reason: "服务端未回报报价币数",
  });
});

const VOICEOVER_STEP = {
  id: "shot-audio",
  label: "补齐配音（1 个分镜还没有配音）",
  surface: "canvas-generation",
} as const;

test("面板：shot-audio 主动作＝先试算（不扣费），不是『打开分镜处理』", () => {
  const html = panel({ nextStep: VOICEOVER_STEP, voiceover: { status: "idle" } });
  assert.match(html, /补齐配音（1 个分镜还没有配音）/);
  assert.match(html, /补齐配音（先试算费用）/);
  assert.equal(/打开分镜处理/.test(html), false, "配音步不显示分镜处理入口");
});

test("面板：干跑报价显示行数／字数／约币数 ＋ 确认键（币数照伺服器回）", () => {
  const html = panel({
    nextStep: VOICEOVER_STEP,
    voiceover: { status: "quoted", lineCount: 12, totalChars: 340, estimatedCoins: 26 },
  });
  assert.match(html, /共 12 句 · 340 字 · 约 26 币/);
  assert.match(html, /确认生成（约 26 币）/);
});

test("面板：真跑完成显示伺服器实扣币数", () => {
  const html = panel({
    nextStep: VOICEOVER_STEP,
    voiceover: { status: "applied", lineCount: 12, totalChars: 340, costCoins: 31 },
  });
  assert.match(html, /已生成 · 共 12 句 · 340 字 · 花费 31 币/);
  assert.equal(/确认生成/.test(html), false);
});

test("面板：被拒 → 显示原因、无确认键、无成功文案", () => {
  const html = panel({
    nextStep: VOICEOVER_STEP,
    voiceover: { status: "refused", reason: "这一集还没有旁白文本" },
  });
  assert.match(html, /配音未生成：这一集还没有旁白文本/);
  assert.equal(/确认生成/.test(html), false);
  assert.equal(/已生成/.test(html), false);
});

test("面板：其他 id（补图）行为不变——即使夹带配音状态也只印『打开分镜处理』", () => {
  const html = panel({
    nextStep: { id: "shot-image", label: "补齐分镜图（1 个分镜还没有图）", surface: "canvas-generation" },
    voiceover: { status: "quoted", lineCount: 1, totalChars: 1, estimatedCoins: 99 },
  });
  assert.match(html, /打开分镜处理/);
  assert.equal(/确认生成/.test(html), false);
});

/** 一镜：已有图＋影、无配音 → 推导出 `shot-audio`。 */
function voicedShotNode(): CanvasNode {
  return shotNode({
    metadata: {
      storyboardShot: { shotNumber: "1" },
      taskVersions: {
        items: [
          { version: "2026-09-30T00:00:00.000Z", tags: ["main_image", "main_video"], url: "https://example.test/shot-1.png" },
        ],
      },
    } as unknown as CanvasNode["metadata"],
  });
}

test("接线：图影齐但无配音 → overlays 直接印出配音试算键（宿主状态真的传进面板）", () => {
  const html = overlays(
    canvasStub({
      projectType: "movie",
      episodes: [{ id: "ep-1", episodeNo: 1, title: "第一集", status: "draft" }] as UseCanvasChatReturn["episodes"],
      nodes: [voicedShotNode()],
    }),
  );
  assert.match(html, /补齐配音（1 个分镜还没有配音）/);
  assert.match(html, /补齐配音（先试算费用）/);
  assert.equal(/打开分镜处理/.test(html), false);
});