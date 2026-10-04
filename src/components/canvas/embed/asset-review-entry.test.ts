// 画布工具列入口测试（2026-09-24，WS-审查）：入口真的渲染、徽章数字对得上真资料、开合态跟著 state。
// 面板本体的真行为在 `src/components/assets/asset-review-panel.test.ts`；
// CanvasEmbed ↔ 面板的开合接线（setReviewPanel）是宿主 glue，属探针级（见回报「未尽事项」）。
import test from "node:test";
import assert from "node:assert/strict";
import * as React from "react";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";

(globalThis as unknown as Record<string, unknown>).React ??= React;

import { CanvasEmbedOverlays } from "./CanvasEmbedOverlays";
import type { UseCanvasChatReturn } from "@/hooks/use-canvas-chat";
import type { CharacterCard } from "@/lib/character-cards";

function card(over: Partial<CharacterCard> = {}): CharacterCard {
  return {
    id: "card-1",
    name: "霍辞渊",
    kind: "character",
    prompt: "",
    references: [],
    createdAt: "2026-09-24T00:00:00.000Z",
    updatedAt: "2026-09-24T00:00:00.000Z",
    ...over,
  };
}

/** 只补 overlays 真的会读到的栏位（其余以 no-op 占位；关闭态的分支不进 JSX）。 */
function canvasStub(cards: CharacterCard[]): UseCanvasChatReturn {
  const noop = () => {};
  return {
    activeCardIds: [],
    characterCards: cards,
    nodes: [],
    episodes: [],
    savedProjects: [],
    currentStep: undefined,
    projectType: undefined,
    selectNode: noop,
    removeCharacterCard: noop,
    toggleCharacterCard: noop,
    dismissAgentOps: noop,
    flyTo: noop,
    openSavedCanvas: noop,
  } as unknown as UseCanvasChatReturn;
}

function render(over: Partial<React.ComponentProps<typeof CanvasEmbedOverlays>> = {}) {
  return renderToStaticMarkup(
    createElement(CanvasEmbedOverlays, {
      height: "100%",
      expanded: false,
      pendingOps: null,
      cardsOpen: false,
      creationFlowOpen: false,
      onCloseCreationFlow: () => {},
      historyOpen: false,
      onCloseHistory: () => {},
      elementListOpen: false,
      reviewPanel: null,
      reviewPendingCount: 0,
      onToggleReview: () => {},
      canvas: canvasStub([card()]),
      viewportSizeRef: { current: { width: 0, height: 0 } },
      setSelectedIds: () => {},
      ...over,
    }),
  );
}

test("工具列入口真的渲染：标签「审查」在画布上（不是只存在于源码）", () => {
  const html = render();
  assert.match(html, /aria-label="资产与分镜审查"/);
  assert.match(html, />审查</);
  assert.equal(/待确认/.test(html), false, "计数为 0 时不显示徽章");
});

test("徽章数字对得上真资料（待批准＋已驳回）", () => {
  assert.match(render({ reviewPendingCount: 3 }), /审查[\s\S]{0,40}待确认 3/);
  const withCards = canvasStub([
    card({ id: "a", approval: { status: "pending" } }),
    card({ id: "b", approval: { status: "rejected", reason: "不对" } }),
  ]);
  // 宿主算的数字是真的卡资料推出来的（面板 export 的 reviewSummary 就是宿主用的同一个纯函式）
  assert.match(render({ canvas: withCards, reviewPendingCount: 2 }), /待确认 2/);
});

test("开合态反映在 aria-pressed 上（面板开著＝入口呈按下态）", () => {
  assert.match(render({ reviewPanel: null }), /aria-pressed="false"/);
  assert.match(render({ reviewPanel: "asset" }), /aria-pressed="true"/);
  assert.match(render({ reviewPanel: "shot" }), /aria-pressed="true"/);
});