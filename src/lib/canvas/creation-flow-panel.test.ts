// 作品/劇集面板資料層（G2）+ `set_project_meta` op 載荷清洗（G1）測試（2026-09-16）。
//
// 釘死四件事：
//   1. `normalizeProjectMetaPatch` 逐欄白名單：合法保留 / 非法丟棄 / 超上限截斷。
//   2. `summarizeCreationFlow` 的取值規則（集數、步驟標籤、分鏡計數）。
//   3. 面板 SSR 渲染：空態、集清單、步驟標籤真的印出來（不是只有型別能編譯）。
//   4. 掛接契約（源碼級，倉庫既有模式）：chip + 面板真的掛在 CanvasEmbed / Overlays。
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import * as React from "react";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";

// tsconfig jsx=preserve → classic runtime，SSR 渲染前補全局 React 桩
// （Scene3dPreview.test.ts / agent-chat-ui.test.ts 同款）。
(globalThis as unknown as Record<string, unknown>).React ??= React;

import { canvasProjectMeta, normalizeProjectMetaPatch, toCanvasProject } from "./layout";
import { normalizeProject } from "./project-store";
import { countStoryboardProgress, summarizeCreationFlow, projectTypeLabel } from "./creation-flow-panel";
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

test("normalizeProjectMetaPatch：合法三欄原樣保留（含 script 原文）", () => {
  const patch = normalizeProjectMetaPatch({
    projectType: "series",
    currentStep: 4,
    episodes: [episode({ script: "第一集剧本原文" }), episode({ id: "ep-2", episodeNo: 2, title: "第二集", status: "finished" })],
  });
  assert.equal(patch.projectType, "series");
  assert.equal(patch.currentStep, 4);
  assert.equal(patch.episodes?.length, 2);
  assert.equal(patch.episodes?.[0].script, "第一集剧本原文", "script 是非空字串就該保留（面板只顯示指針，資料不縮水）");
});

test("normalizeProjectMetaPatch：只帶一欄時不冒出其他鍵", () => {
  assert.deepEqual(Object.keys(normalizeProjectMetaPatch({ currentStep: 7 })), ["currentStep"]);
  assert.deepEqual(Object.keys(normalizeProjectMetaPatch({ projectType: "movie" })), ["projectType"]);
  assert.deepEqual(Object.keys(normalizeProjectMetaPatch({ episodes: [episode()] })), ["episodes"]);
});

// ─────────────────────────── 2. patch 清洗：非法丟棄

test("normalizeProjectMetaPatch：非法值省略該鍵（不寫 undefined、不整包作廢）", () => {
  for (const bad of ["anime", 3, null, undefined, ""]) {
    const patch = normalizeProjectMetaPatch({ projectType: bad, currentStep: 3 });
    assert.equal("projectType" in patch, false, `projectType=${String(bad)} 應被省略`);
    assert.equal(patch.currentStep, 3, "同包合法欄位不受影響");
  }
  for (const bad of [0, 8, -1, 2.5, "4", null, Number.NaN]) {
    assert.equal("currentStep" in normalizeProjectMetaPatch({ currentStep: bad }), false, `currentStep=${String(bad)} 應被省略`);
  }
});

test("normalizeProjectMetaPatch：episodes 逐項丟棄 —— AID 審核態/缺 id/集號非正整數都不進 state", () => {
  const patch = normalizeProjectMetaPatch({
    episodes: [
      episode({ id: "" }),
      episode({ title: "" }),
      episode({ episodeNo: 0 }),
      episode({ episodeNo: 1.5 }),
      episode({ status: "reviewing" as unknown as CanvasEpisode["status"] }), // AID 審核態不進本站型別
      { id: "ep-ok", episodeNo: 3, title: "第三集", status: "processing" },
    ],
  });
  assert.equal(patch.episodes?.length, 1, "只有最後一項合法，其餘逐項丟棄而非整包作廢");
  assert.equal(patch.episodes?.[0].id, "ep-ok");
});

test("normalizeProjectMetaPatch：episodeNo 去重保留首見（面板集數 ≠ 落盤集數的漂移來源）", () => {
  const patch = normalizeProjectMetaPatch({
    episodes: [episode({ id: "a" }), episode({ id: "b" }), episode({ id: "c", episodeNo: 2 })],
  });
  assert.deepEqual(patch.episodes?.map((e) => e.id), ["a", "c"]);
});

test("normalizeProjectMetaPatch：episodes 空陣列/非陣列 → 省略該欄（不製造空殼已設定）", () => {
  assert.equal("episodes" in normalizeProjectMetaPatch({ episodes: [] }), false);
  assert.equal("episodes" in normalizeProjectMetaPatch({ episodes: "junk" }), false);
  assert.equal("episodes" in normalizeProjectMetaPatch({ episodes: null }), false);
});

test("normalizeProjectMetaPatch：非物件輸入（agent 送 null/字串/陣列）回 {}", () => {
  assert.deepEqual(normalizeProjectMetaPatch(null), {});
  assert.deepEqual(normalizeProjectMetaPatch(undefined), {});
  assert.deepEqual(normalizeProjectMetaPatch("junk"), {});
  assert.deepEqual(normalizeProjectMetaPatch([{ currentStep: 1 }]), {}, "陣列不是 patch");
  assert.deepEqual(normalizeProjectMetaPatch({}), {});
});

// ─────────────────────────── 3. patch 清洗：超上限截斷

test("normalizeProjectMetaPatch：episodes 超過上限被截斷", () => {
  const many = Array.from({ length: MAX_EPISODES_PER_PROJECT + 25 }, (_, i) => episode({ id: `ep-${i + 1}`, episodeNo: i + 1 }));
  const patch = normalizeProjectMetaPatch({ episodes: many });
  assert.equal(patch.episodes?.length, MAX_EPISODES_PER_PROJECT, `上限應為 ${MAX_EPISODES_PER_PROJECT}`);
  assert.equal(patch.episodes?.[0].episodeNo, 1, "截斷保留首見序");
  assert.equal(patch.episodes?.at(-1)?.episodeNo, MAX_EPISODES_PER_PROJECT);
});

test("上限常數與落盤端同源（單一宣告，兩處不再各寫一個 200）", () => {
  const store = read("src/lib/canvas/project-store.ts");
  assert.match(store, /MAX_EPISODES_PER_PROJECT/, "store 應引用共用常數");
  assert.doesNotMatch(store, /const MAX_EPISODES_PER_PROJECT = 200/, "store 不該再本地宣告第二個 200");
});

// ─────────────────────────── 4. op 執行端分工

test("agent_ops：set_project_meta 不改 reducer state（專案級欄位由 hook 寫入）", () => {
  const next = canvasReducer(CANVAS_INITIAL_STATE, {
    type: "agent_ops",
    ops: [{ type: "set_project_meta", patch: { currentStep: 4, projectType: "series" } }],
  });
  assert.equal(next, CANVAS_INITIAL_STATE, "reducer 只認 nodes/connections，原樣返回同一實例");
});

test("握把契約：hook 的 set_project_meta 分支先過清洗再寫入", () => {
  const hook = read("src/hooks/use-canvas-chat.ts");
  assert.match(hook, /op\.type === "set_project_meta"/, "執行端分支必須存在");
  assert.match(hook, /const patch = normalizeProjectMetaPatch\(op\.patch\)/, "載荷必須先清洗");
  assert.match(hook, /if \(Object\.keys\(patch\)\.length > 0\) setProjectMeta\(patch\)/, "空 patch 不推 state");
});

// ─────────────────────────── 5. 面板資料層

test("summarizeCreationFlow：集數/完成數/排序（照 episodeNo 升序）", () => {
  const summary = summarizeCreationFlow({
    projectType: "series",
    currentStep: 4,
    episodes: [episode({ id: "c", episodeNo: 3, title: "三" }), episode({ id: "a", episodeNo: 1, title: "一", status: "finished" })],
  });
  assert.equal(summary.projectTypeLabel, "剧集");
  assert.equal(summary.currentStep?.label, "分镜设计");
  assert.equal(summary.episodeCount, 2);
  assert.equal(summary.finishedCount, 1);
  assert.deepEqual(summary.episodes.map((e) => e.episodeNo), [1, 3], "輸入亂序也照集號升序顯示");
  assert.deepEqual(summary.episodes.map((e) => e.statusLabel), ["已完成", "草稿"]);
});

test("summarizeCreationFlow：未設定時不捏造（無作品類型標籤、無步驟、集數 0）", () => {
  const summary = summarizeCreationFlow({});
  assert.equal(summary.projectTypeLabel, undefined);
  assert.equal(summary.currentStep, undefined);
  assert.equal(summary.episodeCount, 0);
  assert.equal(summary.finishedCount, 0);
  assert.deepEqual(summary.episodes, []);
  assert.equal(projectTypeLabel("anime"), undefined);
  assert.equal(projectTypeLabel(undefined), undefined);
});

test("countStoryboardProgress：只數真實節點，分開報『已落畫布 / 場景計畫』（不合成完成度）", () => {
  const scene: CanvasNode = {
    id: "scene-1",
    type: "group" as CanvasNodeType,
    title: "場景",
    position: { x: 0, y: 0 },
    width: 400,
    height: 300,
    metadata: { storyboardScene: { sceneName: "雨夜屋顶", shotCount: 3 } },
  };
  const progress = countStoryboardProgress([shotNode("s1"), shotNode("s2"), scene, plainNode("plain")]);
  assert.equal(progress.shots, 2);
  assert.equal(progress.plannedShots, 3);
  assert.deepEqual(countStoryboardProgress([]), { shots: 0, plannedShots: 0 });
  // 場景外殼的 shotCount 非正整數/缺欄位 → 不計入計畫鏡數（不捏造分母）
  assert.deepEqual(
    countStoryboardProgress([
      { ...scene, metadata: { storyboardScene: { sceneName: "x", shotCount: 0 } } },
      { ...scene, id: "scene-2", metadata: { storyboardScene: { sceneName: "y" } as unknown as CanvasNode["metadata"]["storyboardScene"] } },
    ]),
    { shots: 0, plannedShots: 0 },
  );
});

// ─────────────────────────── 6. 面板 SSR 渲染

test("面板 SSR：空態誠實文案（不捏造已設定）", () => {
  const html = renderToStaticMarkup(
    createElement(CreationFlowPanel, { summary: summarizeCreationFlow({}), onClose: () => {} }),
  );
  assert.match(html, /作品 \/ 剧集/);
  assert.match(html, /还没有作品配置/);
  assert.doesNotMatch(html, /剧集 · 0 集/, "空態不顯示 0 集清單，避免空殼");
});

test("面板 SSR：劇集數、集號、標題、狀態、當前步驟中文標籤全部印出", () => {
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
  assert.match(html, /第 4 步 · 分镜设计/, "currentStep 必須走 creationStepMeta 取中文標籤");
  assert.match(html, /已完成 1/);
});

test("面板 SSR：分鏡計數段落呈現真實計數（無資料時為 0 鏡，不寫百分比）", () => {
  const html = renderToStaticMarkup(
    createElement(CreationFlowPanel, {
      summary: summarizeCreationFlow({ episodes: [episode()], nodes: [shotNode("s1")] }),
      onClose: () => {},
    }),
  );
  assert.match(html, /已落画布 1 镜/);
  assert.doesNotMatch(html, /完成度|完成进度|%/, "本站無「一鏡完成」建模欄位，不得合成百分比");
});

// ─────────────────────────── 7. 端到端（資料層）：agent op → 落盤 → 讀回仍在

test("端到端（資料層）：set_project_meta op 載荷 → 清洗 → 落盤 → 讀回同值", () => {
  // 起點刻意用「未經型別保護的原始 JSON」——這才是 SSE 反序列化後的真實形狀。
  const rawOpPayload: unknown = {
    projectType: "series",
    currentStep: 4,
    episodes: [
      { id: "ep-1", episodeNo: 1, title: "雨夜追击", status: "finished", script: "剧本原文" },
      { id: "ep-2", episodeNo: 2, title: "霓虹坠落", status: "reviewing" }, // AID 審核態：該項被丟
    ],
    // 模型順手塞的雜訊欄位：必須被白名單擋掉，不得進 Blob
    junkField: "should be dropped",
  };
  const patch = normalizeProjectMetaPatch(rawOpPayload);
  assert.equal(patch.episodes?.length, 1, "非法項在 op 執行端就被丟棄");

  // 套進 hook state → buildProject 的產物 → store 落盤清洗
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
  assert.ok(stored, "清洗後的 patch 必須能落盤");
  assert.equal("junkField" in stored, false, "雜訊欄位不得進 Blob");

  // 刷新後：openSavedCanvas 走 canvasProjectMeta 取回 → 面板 summarize 顯示
  const meta = canvasProjectMeta(stored);
  const summary = summarizeCreationFlow({ ...meta, nodes: [] });
  assert.equal(summary.projectTypeLabel, "剧集");
  assert.equal(summary.currentStep?.label, "分镜设计");
  assert.equal(summary.episodeCount, 1);
  assert.equal(summary.episodes[0].title, "雨夜追击");
  assert.equal(summary.episodes[0].statusLabel, "已完成");
  assert.equal(summary.episodes[0].hasScript, true);
});

// ─────────────────────────── 8. 掛接契約（源碼級，倉庫既有模式）

test("掛接契約：頂欄 chip 與左側彈層真的掛上（型別能編譯 ≠ 面板可見）", () => {
  const embed = read("src/components/canvas/CanvasEmbed.tsx");
  const overlays = read("src/components/canvas/embed/CanvasEmbedOverlays.tsx");
  // chip：與角色卡/資源庫同層
  assert.match(embed, /aria-label="作品与剧集"/);
  assert.match(embed, /onClick=\{\(\) => setCreationFlowOpen\(\(v\) => !v\)\}/);
  assert.match(embed, /作品\{canvas\.episodes\.length > 0 \? ` · \$\{canvas\.episodes\.length\} 集` : ""\}/);
  // 面板：由 Overlays 掛載，吃 hook 既有四出口，本層零新增 state
  assert.match(overlays, /<CreationFlowPanel/);
  assert.match(overlays, /summarizeCreationFlow\(\{/);
  assert.match(overlays, /projectType: canvas\.projectType/);
  assert.match(overlays, /currentStep: canvas\.currentStep/);
  assert.match(overlays, /episodes: canvas\.episodes/);
  assert.match(overlays, /nodes: canvas\.nodes/);
  // 關閉態不渲染（掛載條件）
  assert.match(overlays, /\{creationFlowOpen && \(/);
});

test("掛接契約：面板不吃新資料源（不碰 metadata 欄位族、不新增 hook 出口）", () => {
  const hookTypes = read("src/hooks/canvas/canvas-chat-types.ts");
  const panel = read("src/components/canvas/embed/CreationFlowPanel.tsx");
  // 三欄出口在刀 1 就存在，本片不新增：值出口三個 + 寫入口一個（唯一）
  // 型別走單一來源 CanvasProjectType（G6，值域來自 AID ProjectTypeEnum）——
  // 此處刻意釘「引用型別名」而非字面值域：硬編 `"movie" | "series"` 正是 G6 消滅的漂移點。
  assert.match(hookTypes, /projectType: CanvasProjectType \| undefined;/);
  assert.match(hookTypes, /currentStep: number \| undefined;/);
  assert.match(hookTypes, /episodes: CanvasEpisode\[\];/);
  assert.equal(hookTypes.match(/setProjectMeta: /g)?.length, 1, "寫入口恆為一個（UI 與 agent 共用同一出口）");
  assert.doesNotMatch(panel, /storyboardShot|storyboardScene/, "面板只吃 summary，不直接讀節點 metadata（那是刀 2/G3 的地盤）");
});
