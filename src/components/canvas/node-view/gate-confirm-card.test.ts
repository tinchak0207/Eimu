import test from "node:test";
import assert from "node:assert/strict";
import * as React from "react";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
// tsconfig jsx=preserve → classic runtime，SSR 渲染前補全局 React 桩
// （同站內其他 SSR 測試的既有寫法）。
(globalThis as unknown as Record<string, unknown>).React ??= React;
import { NodeBody } from "./NodeBody";
import { downstreamInvalidationIds } from "@/hooks/use-canvas-chat";
import { toNodeMetadata } from "@/lib/canvas/layout";
import { CanvasNodeType, type CanvasNode, type CanvasNodeGateConfirm } from "@/lib/canvas/types";

/**
 * 2026-09-24 協作確認閘的前端側驗收（門禁卡可操作＋裁判憑據收斂＋回跳作廢下游）。
 *
 * 驗收立場（守門件不是 oracle）：全部走**真輸入→真輸出**——
 *   * 門禁卡用 react-dom/server 真渲染真節點（SSR DOM 斷言，不是源碼字串掃描）；
 *   * 憑據用真 SSE 形狀的寬鬆 JSON 餵 `toNodeMetadata`（傳輸邊界真的收斂）；
 *   * 回跳作廢用真節點/連線圖餵純函式斷言閉包。
 */

const GATE_TEXT = "人物批准：主演三视图 + DNA 签名经用户确认后才进分镜";
const CONFIRM: CanvasNodeGateConfirm = {
  request_id: "wfgate_wf_x_cast_card_abc",
  session_id: "ses_collab_1",
  status: "pending",
};

function gateNode(metadata: Record<string, unknown>): CanvasNode {
  return {
    id: "shortdrama_visual-cast_card__gate-9",
    type: CanvasNodeType.Text,
    title: "门禁",
    position: { x: 0, y: 0 },
    width: 300,
    height: 150,
    metadata: { pipelineCard: "gate", content: GATE_TEXT, ...metadata },
  };
}

/** 真 SSR 渲染（NodeBody 的 gate 分支），回 HTML 字串。 */
function render(node: CanvasNode): string {
  return renderToStaticMarkup(
    createElement(NodeBody, {
      node,
      scale: 1,
      onEditPrompt: () => {},
      onScrollAreaPointerDown: () => {},
      onScrollAreaPointerMove: () => {},
      onScrollAreaPointerEnd: () => {},
    }),
  );
}

// ─────────────────────────── 1. 門禁卡：協作檔停點 = 可操作（真 SSR DOM）

test("待確認的門禁卡渲染出批准/退回按鈕（卡從純文字變可操作）", () => {
  const html = render(gateNode({ gateConfirm: CONFIRM }));
  assert.match(html, /批准 · 继续/);
  assert.match(html, /退回 · 要改/);
  assert.match(html, /协作模式：这一步等你确认/);
  // 門禁原文照舊在場（不是拿按鈕取代驗收條件）。
  assert.ok(html.includes(GATE_TEXT));
});

test("沒有 gateConfirm 的門禁卡維持純文字（非協作檔/未到停點 = 零新 UI）", () => {
  const html = render(gateNode({}));
  assert.ok(!html.includes("批准 · 继续"));
  assert.ok(!html.includes("退回 · 要改"));
  assert.ok(html.includes(GATE_TEXT));
});

test("已批准的門禁卡是唯讀狀態行（不再有按鈕，不重複裁決）", () => {
  const html = render(gateNode({ gateConfirm: { ...CONFIRM, status: "approved" } }));
  assert.match(html, /已批准 · 系统已从断点续跑/);
  assert.ok(!html.includes("批准 · 继续"));
});

test("已退回的門禁卡提示回对话说明要改哪里（決策 4：不擅自重生成）", () => {
  const html = render(gateNode({ gateConfirm: { ...CONFIRM, status: "rejected" } }));
  assert.match(html, /已退回 · 请在对话里说明要改哪里/);
  assert.ok(!html.includes("退回 · 要改"));
});

// ─────────────────────────── 2. 傳輸邊界：gateConfirm 雙向收斂

test("toNodeMetadata 收下完整 gateConfirm（SSE 到得了卡上）", () => {
  const out = toNodeMetadata({ pipelineCard: "gate", gateConfirm: CONFIRM });
  assert.deepEqual(out.gateConfirm, CONFIRM);
});

test("toNodeMetadata 丟棄殘形 gateConfirm（缺 request_id/session_id/狀態 = 按不下批准，不留半形卡）", () => {
  assert.equal(toNodeMetadata({ gateConfirm: { session_id: "s", status: "pending" } }).gateConfirm, undefined);
  assert.equal(toNodeMetadata({ gateConfirm: { request_id: "r", status: "pending" } }).gateConfirm, undefined);
  assert.equal(toNodeMetadata({ gateConfirm: { request_id: "r", session_id: "s", status: "weird" } }).gateConfirm, undefined);
  assert.equal(toNodeMetadata({ gateConfirm: "pending" }).gateConfirm, undefined);
  assert.equal(toNodeMetadata({ gateConfirm: null }).gateConfirm, undefined);
});

test("未知鍵仍然不進 metadata（白名單沒有被放寬）", () => {
  assert.equal((toNodeMetadata({ gateConfirmX: CONFIRM }) as Record<string, unknown>).gateConfirmX, undefined);
});

// ─────────────────────────── 3. 回跳作廢下游（決策 15 的畫布側投影）

const G = (id: string, type: CanvasNodeType) => ({ id, type });

test("downstreamInvalidationIds：沿連線取下游閉包，濾掉 text/prompt/config（純資料沒結果可作廢）", () => {
  const nodes = [
    G("asset", CanvasNodeType.Image),
    G("note", CanvasNodeType.Text),
    G("storyboard", CanvasNodeType.Text),
    G("keyframe", CanvasNodeType.Image),
    G("shot", CanvasNodeType.Video),
    G("unrelated", CanvasNodeType.Image),
  ];
  const connections = [
    { fromNodeId: "asset", toNodeId: "note" },
    { fromNodeId: "note", toNodeId: "storyboard" },
    { fromNodeId: "storyboard", toNodeId: "keyframe" },
    { fromNodeId: "keyframe", toNodeId: "shot" },
  ];
  assert.deepEqual(downstreamInvalidationIds(nodes, connections, "asset"), ["keyframe", "shot"]);
  // root 自身不列入（被改的那步由用戶自己重跑）。
  assert.deepEqual(downstreamInvalidationIds(nodes, connections, "keyframe"), ["shot"]);
  // 末端節點：沒有下游 = 什麼都不作廢（呼叫端據此不推歷史）。
  assert.deepEqual(downstreamInvalidationIds(nodes, connections, "shot"), []);
  // 非 workflow 的旁支不受影響。
  assert.deepEqual(downstreamInvalidationIds(nodes, connections, "unrelated"), []);
});

test("downstreamInvalidationIds：不存在的節點＝零動作（不誤刪整張畫布）", () => {
  const nodes = [G("a", CanvasNodeType.Image), G("b", CanvasNodeType.Image)];
  assert.deepEqual(downstreamInvalidationIds(nodes, [{ fromNodeId: "a", toNodeId: "b" }], "ghost"), []);
});

test("downstreamInvalidationIds：成環不無限迴圈（visited 去重）", () => {
  const nodes = [G("a", CanvasNodeType.Image), G("b", CanvasNodeType.Image)];
  const connections = [
    { fromNodeId: "a", toNodeId: "b" },
    { fromNodeId: "b", toNodeId: "a" },
  ];
  assert.deepEqual(downstreamInvalidationIds(nodes, connections, "a"), ["b"]);
});