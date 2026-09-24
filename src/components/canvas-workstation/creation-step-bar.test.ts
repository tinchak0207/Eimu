// 對話區步驟條（決策 12/13/15）＋兩根線接線測試（2026-09-24，收口片）。
//
// 病灶：步驟條本體與 5 步投影都做完了，但唯一掛載點在畫布面板內、且
// `onOpenReview`/`onRewind` 兩根線都沒接 → 使用者看到一列 inert 進度點，
// `revokeDownstream` 這顆原語一個呼叫端都沒有（能力做了但看不到）。
//
// 本檔釘死的都是**真行為**（不是源碼字串探針）：
//   1. 真 SSR 渲染：5 步標籤與當前步高亮對得上真 `contractStep`；檔位換 readOnly
//      （全自動兩檔零按鈕＝護城河，但進度照樣看得到）。
//   2. 真事件總線：`onOpenReview("asset")` 經**真** `openReviewPanel` 派出的
//      CustomEvent（名稱/detail 逐位元），CanvasEmbed 掛的就是這條監聽。
//   3. 真作廢原語：`onRewind(真 wizardRerunPlan(4))` → `revokeDownstream` 收到**真落點 id**
//      （落點由真 DAG + 真 downstreamInvalidationIds 規則驗過，見 wizard-steps.test.ts），
//      `setProjectMeta` 收到真契約步；解析不到落點時**兩個原語都不准被呼叫**。
import test from "node:test";
import assert from "node:assert/strict";
import * as React from "react";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";

(globalThis as unknown as Record<string, unknown>).React ??= React;

import { CanvasChatWorkstation, ChatCreationStepBar, createStepBarWiring } from "./CanvasChatWorkstation";
import { REVIEW_PANEL_OPEN_EVENT } from "@/components/assets/AssetReviewPanel";
import { wizardRerunPlan, wizardStepMeta } from "@/lib/wizard-steps";
import { CanvasNodeType, type CanvasNode } from "@/lib/canvas/types";
import type { AgentInteractionMode } from "@/lib/agent-chat-client";

const noop = () => {};

/** 步驟條的 SSR 渲染（真 DOM 字串；本站無 jsdom）。 */
function renderBar(over: { contractStep?: number | undefined; mode?: AgentInteractionMode } = {}) {
  return renderToStaticMarkup(
    createElement(ChatCreationStepBar, {
      contractStep: over.contractStep,
      interactionMode: over.mode ?? "collaborate",
      onOpenReview: noop,
      onRewind: noop,
    }),
  );
}

// ─────────────────────────── 1. 真渲染：5 步 × 當前步 × 檔位

test("對話區步驟條渲染 5 步，當前步高亮對得上真 contractStep", () => {
  const html = renderBar({ contractStep: 4 });
  for (const label of ["上传剧本", "拆分剧本", "资产图", "故事板", "视频"]) {
    assert.ok(html.includes(label), `${label} 必須印出`);
  }
  assert.match(html, />故事板<span[^>]*>· 进行中/, "契約 4 ＝ 故事板進行中");
  assert.doesNotMatch(html, />资产图<span[^>]*>· 进行中/, "非當前步不得標成進行中");
  assert.equal((html.match(/· 进行中/g) ?? []).length, 1, "同一個步驟條只有一個當前步");

  const assets = renderBar({ contractStep: 3 });
  assert.match(assets, />资产图<span[^>]*>· 进行中/, "契約 3 → 當前步移到資產圖");
  // 未配置專案（currentStep 未知）：不捏造當前步
  const unknown = renderBar({ contractStep: undefined });
  assert.doesNotMatch(unknown, /· 进行中/, "不知道進度時不捏造當前步");
  for (const label of ["上传剧本", "视频"]) assert.ok(unknown.includes(label), "步驟照樣全印");
});

test("檔位真的切換可交互性：collaborate 有回跳/審查鈕，preset 與 auto 零按鈕（護城河）", () => {
  const collab = renderBar({ contractStep: 4, mode: "collaborate" });
  assert.match(collab, /aria-label="打开资产图审查面板"/);
  assert.match(collab, /aria-label="打开故事板审查面板"/);
  assert.match(collab, /aria-label="回跳重跑：上传剧本、拆分剧本、资产图、故事板、视频"/);
  assert.match(collab, /协作 · 可点回跳\/审查/);

  for (const mode of ["preset", "auto"] as const) {
    const ro = renderBar({ contractStep: 4, mode });
    assert.doesNotMatch(ro, /<button/, `${mode} 檔不得有任何可點鈕（零新增阻塞）`);
    assert.doesNotMatch(ro, /审查/, `${mode} 檔不開審查入口`);
    assert.match(ro, />故事板<span[^>]*>· 进行中/, `${mode} 檔進度照樣看得到（只讀進度）`);
    assert.match(ro, /全自动 · 只读进度/);
  }
});

// ─────────────────────────── 2. onOpenReview：真事件總線

test("onOpenReview 真的派發 CustomEvent（CanvasEmbed 監聽的就是這條），目標詞彙不經映射表", () => {
  const globals = globalThis as unknown as Record<string, unknown>;
  const savedWindow = globals.window;
  const seen: { type: string; detail: unknown }[] = [];
  globals.window = {
    dispatchEvent: (event: { type: string; detail: unknown }) => {
      seen.push({ type: event.type, detail: event.detail });
      return true;
    },
  };

  try {
    const host = { nodes: [] as CanvasNode[], revokeDownstream: () => [], setProjectMeta: noop };
    const wiring = createStepBarWiring(host); // 不注入 open：走生產用的真 openReviewPanel

    assert.equal(wiring.onOpenReview("asset"), true);
    assert.equal(wiring.onOpenReview("shot"), true);
    assert.deepEqual(seen, [
      { type: REVIEW_PANEL_OPEN_EVENT, detail: { panel: "asset" } },
      { type: REVIEW_PANEL_OPEN_EVENT, detail: { panel: "shot" } },
    ]);
    // 步驟條實際傳的就是該步的 review 值（真參數，不是本地硬編）
    assert.equal(wizardStepMeta(3)?.review, "asset");
    assert.equal(wizardStepMeta(4)?.review, "shot");
  } finally {
    if (savedWindow === undefined) delete globals.window;
    else globals.window = savedWindow;
  }
});

// ─────────────────────────── 3. onRewind：真落點 → 真原語

const scriptNode: CanvasNode = {
  id: "wf-script-0",
  type: CanvasNodeType.Text,
  title: "拆解剧本",
  position: { x: 0, y: 0 },
  width: 300,
  height: 220,
  metadata: { gate: "剧本人工批准" },
};
const storyboardNode: CanvasNode = {
  id: "wf-storyboard-2",
  type: CanvasNodeType.Text,
  title: "锁定分镜",
  position: { x: 600, y: 0 },
  width: 300,
  height: 220,
  metadata: { storyboardShot: { shotNumber: "S03" } as unknown as CanvasNode["metadata"]["storyboardShot"] },
};
const videoNode: CanvasNode = {
  id: "wf-shot_video-4",
  type: CanvasNodeType.Video,
  title: "镜头视频",
  position: { x: 1200, y: 0 },
  width: 300,
  height: 220,
  metadata: { content: "https://cdn.example.com/shot.mp4", status: "success" },
};
const DAG: CanvasNode[] = [scriptNode, storyboardNode, videoNode];

function recordingHost(nodes: readonly CanvasNode[]) {
  const revoked: string[] = [];
  const patches: { currentStep?: number }[] = [];
  return {
    revoked,
    patches,
    host: {
      nodes,
      revokeDownstream: (nodeId: string) => {
        revoked.push(nodeId);
        return [`${nodeId}::downstream`];
      },
      setProjectMeta: (patch: { currentStep?: number }) => {
        patches.push(patch);
      },
    },
  };
}

test("onRewind(故事板) 真的作廢該步落點下游，並把流程退回該契約步", () => {
  const { revoked, patches, host } = recordingHost(DAG);
  const plan = wizardRerunPlan(4);
  assert.ok(plan, "第 4 步必須有回跳計畫");
  const voided = createStepBarWiring(host).onRewind(plan);

  assert.deepEqual(revoked, [storyboardNode.id], "落點＝真分鏡節點（既有 storyboardShot 標記）");
  assert.deepEqual(patches, [{ currentStep: 4 }], "專案步退回真契約步（步驟條讀的就是 currentStep）");
  assert.deepEqual(voided, [`${storyboardNode.id}::downstream`], "回傳被作廢的下游 id（呼叫端據此提示）");
  assert.equal(revoked.includes(scriptNode.id), false, "不得回跳作廢該步之前的劇本節點");
});

test("onRewind(視頻) 落點＝video 節點；onRewind(劇本) 落點＝gate 步驟頭節點（自身保留）", () => {
  const video = recordingHost(DAG);
  const videoPlan = wizardRerunPlan(5);
  assert.ok(videoPlan);
  createStepBarWiring(video.host).onRewind(videoPlan);
  assert.deepEqual(video.revoked, [videoNode.id]);
  assert.deepEqual(video.patches, [{ currentStep: 5 }]);

  // 劇本步（契約 1/2）：落點＝帶 gate 的步驟頭節點；劇本節點**自身**不在落點裡
  // （回跳改的就是它，作廢的是它的下游）。
  const script = recordingHost([scriptNode]);
  const scriptPlan = wizardRerunPlan(2);
  assert.ok(scriptPlan);
  createStepBarWiring(script.host).onRewind(scriptPlan);
  assert.deepEqual(script.revoked, [scriptNode.id], "落點是劇本節點，作廢的是它的下游");
  assert.deepEqual(script.patches, [{ currentStep: 2 }]);
});

test("解析不到落點＝零動作：兩個原語都不准被呼叫（避免顯示退回而畫布沒動）", () => {
  const bare: CanvasNode[] = [
    { id: "n1", type: CanvasNodeType.Image, title: "空节点", position: { x: 0, y: 0 }, width: 300, height: 220, metadata: {} },
  ];
  const { revoked, patches, host } = recordingHost(bare);
  const plan = wizardRerunPlan(4);
  assert.ok(plan);
  assert.deepEqual(createStepBarWiring(host).onRewind(plan), [], "沒有分鏡實體＝沒東西可作廢");
  assert.deepEqual(revoked, [], "不得憑空挑一個節點作廢");
  assert.deepEqual(patches, [], "不得改專案步（否則步驟條顯示退回、畫布實際沒動）");
});

test("全自動檔回歸：readOnly 下步驟條裡沒有可點鈕＝兩根線不可能被觸發", () => {
  // 這是護城河的守門斷言：auto/preset 一鍵跑完、零新增阻塞、零互動。
  for (const mode of ["preset", "auto"] as const) {
    const html = renderBar({ contractStep: 3, mode });
    assert.equal(html.includes("<button"), false, `${mode}：零按鈕`);
    assert.equal(html.includes("回跳重跑"), false, `${mode}：不回報重跑計畫`);
  }
});
// ─────────────────────────── 4. 真的掛在對話區（宿主整合，非只測子元件）

test("宿主整合：工作站態真的把步驟條掛進對話區（讀 canvasHost.currentStep），非工作站態不掛", () => {
  const hostStub = {
    currentStep: 3,
    nodes: [] as CanvasNode[],
    revokeDownstream: () => [],
    setProjectMeta: noop,
  };
  const renderWorkstation = (inCanvasWorkstation: boolean) =>
    renderToStaticMarkup(
      createElement(CanvasChatWorkstation, {
        inCanvasWorkstation,
        isLoading: false,
        canvasHost: hostStub as never,
        children: () => createElement("div", { "data-test-chat": "1" }, "聊天内容"),
      }),
    );

  const ws = renderWorkstation(true);
  assert.match(ws, /aria-label="创作流程"/, "畫布工作站態＝對話區頂部有步驟條");
  assert.match(ws, />资产图<span[^>]*>· 进行中/, "步驟條讀的是宿主下發的真 contractStep（契約 3）");
  assert.ok(ws.includes("聊天内容"), "對話內容照舊在同一滾動區");

  const home = renderWorkstation(false);
  assert.equal(home.includes('aria-label="创作流程"'), false, "首頁默認面（非工作站態）不掛步驟條（決策 12）");
  assert.ok(home.includes("聊天内容"));
});
