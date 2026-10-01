// 下一步引導渲染測試（2026-09-30）：`deriveNextStep` 真的印在面板上（型別能編譯 ≠ 面板可見）。
//
// 兩層斷言：
//   ① 面板層（CreationFlowPanel）：有 next 時渲染 label ＋ 一顆主按鈕；unknown／none 不渲染。
//   ② 接線層（CanvasEmbedOverlays）：由 nodes 推導 snapshot（真分鏡節點 → 真的缺口數），
//      不是把 label 直接塞進去。
//
// 只做 SSR 靜態渲染（本 repo 無 jsdom）：`onNextAction` 的導向（聚焦輸入框／開審查面）是
// 瀏覽器行為，屬探針級，見回報「未盡事項」。
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

/** 分鏡節點樁（只補真的會被讀到的欄位：storyboardShot 判準 + 媒體鍵一律缺）。 */
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

// ─────────────────────────── ① 面板層

test("面板：有 next 時渲染 label 與主按鈕（canvas-generation → 打开分镜处理）", () => {
  const html = panel({
    nextStep: { id: "shot-image", label: "补齐分镜图（2 个分镜还没有图）", surface: "canvas-generation" },
  });
  assert.match(html, /下一步/);
  assert.match(html, /补齐分镜图（2 个分镜还没有图）/);
  assert.match(html, /打开分镜处理/);
});

test("面板：agent 面渲染 agent 主按鈕文案", () => {
  const html = panel({ nextStep: { id: "episode", label: "建立分集与剧本（这部作品还没有分集）", surface: "agent" } });
  assert.match(html, /交给 AI 助理/);
  assert.match(html, /建立分集与剧本（这部作品还没有分集）/);
});

test("面板：unknown 不渲染（資料不足以判斷 ≠ 給一個假動作）", () => {
  const html = panel({
    nextStep: { id: "unknown", label: "还不确定作品是否已建立——先在 AI 助理里核对", surface: "agent" },
  });
  assert.equal(/下一步/.test(html), false, "unknown 不進面板");
  assert.equal(/还不确定作品是否已建立/.test(html), false);
});

test("面板：終態（surface none / id done）不渲染主動作", () => {
  const html = panel({ nextStep: { id: "done", label: "全流程已完成 · 预览成片", surface: "none" } });
  assert.equal(/下一步/.test(html), false);
  assert.equal(/全流程已完成/.test(html), false);
});

test("面板：缺席 nextStep 時完全不渲染引導區（不改變既有面板）", () => {
  const html = panel();
  assert.equal(/下一步/.test(html), false);
  assert.match(html, /作品 \/ 剧集/, "既有面板本體照舊");
});

// ─────────────────────────── ② 接線層（overlays 由 nodes 推導）

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
      agentAutoApprove: false,
      onToggleAgentAutoApprove: () => {},
      onApproveAgentOps: () => {},
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

test("接線：節點現況（有作品＋1 集＋1 顆無圖分鏡）→ 面板印出『补齐分镜图（1 …）』", () => {
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

test("接線：什麼都沒有 → 推導出『先建立作品』（不是硬寫死的 label）", () => {
  const html = overlays(canvasStub());
  assert.match(html, /先建立作品：让 AI 助理设定作品类型/);
  assert.match(html, /交给 AI 助理/);
});

test("接線：分鏡有配音（audioAnchorId 非空）不改變『還缺圖』的結論，但補圖後會前進到配音缺口", () => {
  // 有作品/集，1 顆分鏡、有配音但沒圖 → 缺口仍是圖（工序順序：圖 → 影 → 配音）。
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
  assert.match(withAudioOnly, /补齐分镜图（1 个分镜还没有图）/, "配音有無不改變『先補圖』");
});

// ─────────────────────────── ③ 补齐配音（`shot-audio`）真的接上生成入口
//
// 分三層：
//   · 路由層：`nextActionRoute` 純函式（shot-audio 走配音、其餘面照舊）。
//   · 請求層：`requestVoiceover` 注入假 fetch —— **乾跑只發一次 dryRun:true、
//     未確認前不發 dryRun:false**；幣數一律照伺服器回；被拒/非 2xx 不假成功。
//   · 渲染層：乾跑結果與確認鍵真的印在面板上（SSR）。
// 全程假 fetch，零真實付費呼叫。

test("路由：shot-audio 走配音乾跑；補圖／補影／agent／none 照舊", () => {
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

/** 假 fetch（記錄每次呼叫的 url/body；永不觸網）。 */
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

test("配音請求：乾跑只發一次 dryRun:true，未經確認不發 dryRun:false", async () => {
  const mock = fakeVoiceoverFetch(() => ({
    payload: { ok: true, dryRun: true, lines: [{}, {}, {}], totalChars: 42, estimatedCoins: 7 },
  }));

  const quote = await requestVoiceover({ projectId: "p-1", dryRun: true }, mock.impl);

  assert.deepEqual(quote, { status: "quote", lineCount: 3, totalChars: 42, estimatedCoins: 7 });
  assert.equal(mock.calls.length, 1, "乾跑只發一次");
  assert.equal(mock.calls[0].url, "/api/canvas/storyboard-voiceover");
  assert.equal(mock.calls[0].body.projectId, "p-1");
  assert.equal(mock.calls[0].body.dryRun, true);
  assert.equal(
    mock.calls.some((c) => c.body.dryRun === false),
    false,
    "使用者還沒按確認鍵 ⇒ 不得發出任何真跑請求",
  );
});

test("配音請求：確認後才發 dryRun:false，實扣幣數用伺服器回的數字（前端不自算）", async () => {
  const mock = fakeVoiceoverFetch((call) =>
    call.body.dryRun === true
      ? { payload: { ok: true, dryRun: true, lines: [{}], totalChars: 10, estimatedCoins: 3 } }
      : { payload: { ok: true, applied: true, lines: [{}], totalChars: 10, costCoins: 4, drift: 1 } },
  );

  await requestVoiceover({ projectId: "p-1", dryRun: true }, mock.impl);
  assert.equal(mock.calls.filter((c) => c.body.dryRun === false).length, 0, "確認前 0 筆真跑");

  const applied = await requestVoiceover({ projectId: "p-1", dryRun: false }, mock.impl);
  assert.deepEqual(
    applied,
    { status: "applied", lineCount: 1, totalChars: 10, costCoins: 4 },
    "costCoins 照伺服器，與報價 3 不同也不改寫",
  );
  assert.equal(mock.calls.filter((c) => c.body.dryRun === false).length, 1, "確認後恰好 1 筆真跑");
  assert.equal(mock.calls.length, 2);
});

test("配音請求：被拒（refused）→ 回原因，不假成功", async () => {
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

test("配音請求：非 2xx／缺幣數 → error（不當成功）", async () => {
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

test("面板：shot-audio 主動作＝先試算（不扣費），不是『打开分镜处理』", () => {
  const html = panel({ nextStep: VOICEOVER_STEP, voiceover: { status: "idle" } });
  assert.match(html, /补齐配音（1 个分镜还没有配音）/);
  assert.match(html, /补齐配音（先试算费用）/);
  assert.equal(/打开分镜处理/.test(html), false, "配音步不顯示分鏡處理入口");
});

test("面板：乾跑報價顯示行数／字数／約幣數 ＋ 確認鍵（幣數照伺服器回）", () => {
  const html = panel({
    nextStep: VOICEOVER_STEP,
    voiceover: { status: "quoted", lineCount: 12, totalChars: 340, estimatedCoins: 26 },
  });
  assert.match(html, /共 12 句 · 340 字 · 约 26 币/);
  assert.match(html, /确认生成（约 26 币）/);
});

test("面板：真跑完成顯示伺服器實扣幣數", () => {
  const html = panel({
    nextStep: VOICEOVER_STEP,
    voiceover: { status: "applied", lineCount: 12, totalChars: 340, costCoins: 31 },
  });
  assert.match(html, /已生成 · 共 12 句 · 340 字 · 花费 31 币/);
  assert.equal(/确认生成/.test(html), false);
});

test("面板：被拒 → 顯示原因、無確認鍵、無成功文案", () => {
  const html = panel({
    nextStep: VOICEOVER_STEP,
    voiceover: { status: "refused", reason: "这一集还没有旁白文本" },
  });
  assert.match(html, /配音未生成：这一集还没有旁白文本/);
  assert.equal(/确认生成/.test(html), false);
  assert.equal(/已生成/.test(html), false);
});

test("面板：其他 id（補圖）行為不變——即使夾帶配音狀態也只印『打开分镜处理』", () => {
  const html = panel({
    nextStep: { id: "shot-image", label: "补齐分镜图（1 个分镜还没有图）", surface: "canvas-generation" },
    voiceover: { status: "quoted", lineCount: 1, totalChars: 1, estimatedCoins: 99 },
  });
  assert.match(html, /打开分镜处理/);
  assert.equal(/确认生成/.test(html), false);
});

/** 一鏡：已有圖＋影、無配音 → 推導出 `shot-audio`。 */
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

test("接線：圖影齊但無配音 → overlays 直接印出配音試算鍵（宿主狀態真的傳進面板）", () => {
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