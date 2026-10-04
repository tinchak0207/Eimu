import test from "node:test";
import assert from "node:assert/strict";
import * as React from "react";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
// tsconfig jsx=preserve → classic runtime，SSR 渲染前补全局 React 桩
// （同站内其他 SSR 测试的既有写法）。
(globalThis as unknown as Record<string, unknown>).React ??= React;
import { NodeBody } from "./NodeBody";
import { downstreamInvalidationIds } from "@/hooks/use-canvas-chat";
import { toNodeMetadata } from "@/lib/canvas/layout";
import { CanvasNodeType, type CanvasNode, type CanvasNodeGateConfirm } from "@/lib/canvas/types";

/**
 * 2026-09-24 协作确认闸的前端侧验收（门禁卡可操作＋裁判凭据收敛＋回跳作废下游）。
 *
 * 验收立场（守门件不是 oracle）：全部走**真输入→真输出**——
 *   * 门禁卡用 react-dom/server 真渲染真节点（SSR DOM 断言，不是源码字串扫描）；
 *   * 凭据用真 SSE 形状的宽松 JSON 喂 `toNodeMetadata`（传输边界真的收敛）；
 *   * 回跳作废用真节点/连线图喂纯函式断言闭包。
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

// ─────────────────────────── 1. 门禁卡：协作档停点 = 可操作（真 SSR DOM）

test("待确认的门禁卡渲染出批准/退回按钮（卡从纯文字变可操作）", () => {
  const html = render(gateNode({ gateConfirm: CONFIRM }));
  assert.match(html, /批准 · 继续/);
  assert.match(html, /退回 · 要改/);
  assert.match(html, /协作模式：这一步等你确认/);
  // 门禁原文照旧在场（不是拿按钮取代验收条件）。
  assert.ok(html.includes(GATE_TEXT));
});

test("没有 gateConfirm 的门禁卡维持纯文字（非协作档/未到停点 = 零新 UI）", () => {
  const html = render(gateNode({}));
  assert.ok(!html.includes("批准 · 继续"));
  assert.ok(!html.includes("退回 · 要改"));
  assert.ok(html.includes(GATE_TEXT));
});

test("已批准的门禁卡是唯读状态行（不再有按钮，不重复裁决）", () => {
  const html = render(gateNode({ gateConfirm: { ...CONFIRM, status: "approved" } }));
  assert.match(html, /已批准 · 系统已从断点续跑/);
  assert.ok(!html.includes("批准 · 继续"));
});

test("已退回的门禁卡提示回对话说明要改哪里（决策 4：不擅自重生成）", () => {
  const html = render(gateNode({ gateConfirm: { ...CONFIRM, status: "rejected" } }));
  assert.match(html, /已退回 · 请在对话里说明要改哪里/);
  assert.ok(!html.includes("退回 · 要改"));
});

// ─────────────────────────── 2. 传输边界：gateConfirm 双向收敛

test("toNodeMetadata 收下完整 gateConfirm（SSE 到得了卡上）", () => {
  const out = toNodeMetadata({ pipelineCard: "gate", gateConfirm: CONFIRM });
  assert.deepEqual(out.gateConfirm, CONFIRM);
});

test("toNodeMetadata 丢弃残形 gateConfirm（缺 request_id/session_id/状态 = 按不下批准，不留半形卡）", () => {
  assert.equal(toNodeMetadata({ gateConfirm: { session_id: "s", status: "pending" } }).gateConfirm, undefined);
  assert.equal(toNodeMetadata({ gateConfirm: { request_id: "r", status: "pending" } }).gateConfirm, undefined);
  assert.equal(toNodeMetadata({ gateConfirm: { request_id: "r", session_id: "s", status: "weird" } }).gateConfirm, undefined);
  assert.equal(toNodeMetadata({ gateConfirm: "pending" }).gateConfirm, undefined);
  assert.equal(toNodeMetadata({ gateConfirm: null }).gateConfirm, undefined);
});

test("未知键仍然不进 metadata（白名单没有被放宽）", () => {
  assert.equal((toNodeMetadata({ gateConfirmX: CONFIRM }) as Record<string, unknown>).gateConfirmX, undefined);
});

// ─────────────────────────── 3. 回跳作废下游（决策 15 的画布侧投影）

const G = (id: string, type: CanvasNodeType) => ({ id, type });

test("downstreamInvalidationIds：沿连线取下游闭包，滤掉 text/prompt/config（纯资料没结果可作废）", () => {
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
  // root 自身不列入（被改的那步由用户自己重跑）。
  assert.deepEqual(downstreamInvalidationIds(nodes, connections, "keyframe"), ["shot"]);
  // 末端节点：没有下游 = 什么都不作废（呼叫端据此不推历史）。
  assert.deepEqual(downstreamInvalidationIds(nodes, connections, "shot"), []);
  // 非 workflow 的旁支不受影响。
  assert.deepEqual(downstreamInvalidationIds(nodes, connections, "unrelated"), []);
});

test("downstreamInvalidationIds：不存在的节点＝零动作（不误删整张画布）", () => {
  const nodes = [G("a", CanvasNodeType.Image), G("b", CanvasNodeType.Image)];
  assert.deepEqual(downstreamInvalidationIds(nodes, [{ fromNodeId: "a", toNodeId: "b" }], "ghost"), []);
});

test("downstreamInvalidationIds：成环不无限回圈（visited 去重）", () => {
  const nodes = [G("a", CanvasNodeType.Image), G("b", CanvasNodeType.Image)];
  const connections = [
    { fromNodeId: "a", toNodeId: "b" },
    { fromNodeId: "b", toNodeId: "a" },
  ];
  assert.deepEqual(downstreamInvalidationIds(nodes, connections, "a"), ["b"]);
});