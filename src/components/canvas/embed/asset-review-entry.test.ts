// 畫布工具列入口測試（2026-09-24，WS-審查）：入口真的渲染、徽章數字對得上真資料、開合態跟著 state。
// 面板本體的真行為在 `src/components/assets/asset-review-panel.test.ts`；
// CanvasEmbed ↔ 面板的開合接線（setReviewPanel）是宿主 glue，屬探針級（見回報「未盡事項」）。
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

/** 只補 overlays 真的會讀到的欄位（其餘以 no-op 佔位；關閉態的分支不進 JSX）。 */
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

test("工具列入口真的渲染：標籤「审查」在畫布上（不是只存在於源碼）", () => {
  const html = render();
  assert.match(html, /aria-label="资产与分镜审查"/);
  assert.match(html, />审查</);
  assert.equal(/待确认/.test(html), false, "计数为 0 时不显示徽章");
});

test("徽章數字對得上真資料（待批准＋已駁回）", () => {
  assert.match(render({ reviewPendingCount: 3 }), /审查[\s\S]{0,40}待确认 3/);
  const withCards = canvasStub([
    card({ id: "a", approval: { status: "pending" } }),
    card({ id: "b", approval: { status: "rejected", reason: "不对" } }),
  ]);
  // 宿主算的數字是真的卡資料推出來的（面板 export 的 reviewSummary 就是宿主用的同一個純函式）
  assert.match(render({ canvas: withCards, reviewPendingCount: 2 }), /待确认 2/);
});

test("開合態反映在 aria-pressed 上（面板開著＝入口呈按下態）", () => {
  assert.match(render({ reviewPanel: null }), /aria-pressed="false"/);
  assert.match(render({ reviewPanel: "asset" }), /aria-pressed="true"/);
  assert.match(render({ reviewPanel: "shot" }), /aria-pressed="true"/);
});